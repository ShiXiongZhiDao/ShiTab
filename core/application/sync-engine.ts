/**
 * 同步引擎（既有约定 / 既有约定，WebDAV-SYNC.md §7 与 §8）。
 *
 * 它是这一层唯一被允许写远端的东西，顺序固定成五步，任何一步失败都不许走到下一步：
 *
 * ```text
 * 读配置与凭据 → 校验本地状态 → 读远端（manifest 丢了就重建）
 *   → 安全闸（blocked / suspicious 就在这里停下）→ 推快照 → 写 manifest
 * ```
 *
 * 三条不能省的不变量：
 * 1. **损坏的本地状态永远不能成为同步源**（§4）。所以第 2 步在任何网络动作之前。
 * 2. **异常大量删除不自动同步**（§8）。所以第 4 步要拿远端的条数当参照系 ——
 *    没有参照系就无从判断"0 条"是用户删光了还是数据丢了。
 * 3. **任何一次同步都不能同时摧毁本地和远端最后一个有效版本**（§20）。
 *    所以远端只 PUT 新文件、永不覆盖或删除旧快照，而本地写入全部走 `applyMergedState`
 *    这一处，失败就整批不做。
 */

import type { StoragePort } from '@/core/ports/storage';
import type { WebDavPort, WebDavAdminPort, WebDavCredential, WebDavErrorKind } from '@/core/ports/webdav';
import { WebDavError } from '@/core/ports/webdav';
import type { ManifestEntry, StoredConflict, StoredState, SyncEventKind, SyncManifest, SyncPointer, SyncSnapshot, SyncStatus, SyncTriggerReason, Tombstone } from '@/shared/types';
import { claimIsLive, decideSync, SYNC_CLAIM_TTL_MS, type SyncSkipCause } from '@/core/domain/sync-scheduler';
import { manifestUrl, parseBaseUrl, pointerUrl, snapshotIdFor, snapshotUrl, snapshotsDirUrl, manifestsDirUrl, revisionFromUrl, snapshotIdFromUrl, listingIsTrusted, TRUSTED_LISTING_LIMIT } from '@/core/domain/remote-layout';
import { buildPointer, buildSyncSnapshot, buildManifest, decodeWire, encodeWire, stateChecksumOf, verifyManifest, verifyPointer, verifySyncSnapshot } from '@/core/domain/sync-data';
import { mergeDeviceTables, nameOfDevice } from '@/core/domain/device-profile';
import { assessSyncSafety, type SuspiciousCounts, type SuspiciousRule } from '@/core/domain/safety';
import { mergeStates, type DeleteVsEditConflict } from '@/core/domain/merge';
import { captureDurableSnapshot, readStoredState } from '@/core/application/durable-snapshot';
import { planRestore, type RestorePlanCounts } from '@/core/domain/restore-as-revert';
import { softDeleteGroup } from '@/core/application/delete-model';
import { now } from '@/shared/utils';
import { REMOTE_HISTORY_LIMIT, REMOTE_RETENTION_MAX_DELETES } from '@/shared/constants';

export interface SyncDeps {
  storage: StoragePort;
  webdav: WebDavPort;
  /**
   * 只有**显式注入**了管理接口的调用方才做保留删除。
   *
   * 既有约定 把 `remove` 关在 `WebDavAdminPort` 里，是为了让"普通同步顺手删远端历史"
   * 在类型层面写不出来 —— 这条今天仍然成立：不传 `admin` 的 `SyncDeps`（面板那条线、
   * 以及全部只递 `{storage, webdav}` 的用例）连一行删除代码都执行不到。
   * 传了的那一条线做的是**写死在常量里的保留策略**（`REMOTE_HISTORY_LIMIT`），
   * 不是"同步想删谁就删谁"：只删账本自己滚出窗口的那些，且删失败的条目留在账本里等下一轮。
   */
  admin?: WebDavAdminPort;
}

export type SyncSkip =
  | 'disabled'
  | 'no-credential'
  | 'backoff'
  | 'bad-base-url'
  | 'not-yet'
  | 'no-changes';

export interface SyncOutcome {
  status: SyncStatus;
  skip?: SyncSkip;
  /** 本地状态被判定不可信 ⇒ 禁止同步（§9 规则 C/D）。这条没有"用户确认"分支。 */
  blocked?: { reason: string };
  /**
   * 异常变化（§9 规则 A/B）。挂起等用户决定，远端一个字节都没动。
   *
   * `counts` 是给界面看的，不是判据的一部分：那句提示原来只说"比服务器少得多"，用户没法
   * 判断这是误报还是真删了（2026-10-06 真机反馈）。条数是他唯一能自己核对的东西 ——
   * 回收站里有没有那 25 条，看一眼就知道。两条轴都要给：`sessions` 少了但 `records` 没少，
   * 和两条一起塌，是两件不同的事。
   */
  suspicious?: { rules: SuspiciousRule[]; counts: SuspiciousCounts };
  pushed?: { snapshotId: string; revision: number };
  pulled?: { revision: number; conflicts: DeleteVsEditConflict[] };
  /** manifest 不在或坏了，靠扫快照目录重建了一次（§5 规则 5）。 */
  manifestRebuilt?: boolean;
  error?: { kind: WebDavErrorKind | 'unknown'; message: string };
}

/**
 * 退避：指数增长，上限 30 分钟。
 *
 * ⚠ 这句话原来是"没有 alarms 权限，所以下一次尝试由「任何事件唤醒」来触发" —— 既有约定
 * 之后它不成立了（清单里已经有 `alarms`）。**判据那一半没变**：退避仍然不是"到点自己醒"，
 * 而是下一次节拍（alarm / 心跳 / 本机变更 / 启动 / 手动）来问时`dueForSync` 说"还没到"。
 * 上限 30 分钟与 alarm 的 5 分钟周期合起来才是完整承诺：最长 30 分钟 + 一次节拍。
 */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

export function backoffDelayMs(failures: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** Math.min(failures, 12);
  return Math.min(raw, BACKOFF_MAX_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 本地状态能不能当同步源（§9 规则 D 的落地）。
 *
 * 查的是形状而不是内容对不对：内容对错由 checksum 在远端读侧管，这里要防的是
 * "存储里躺着一坨解析不出来的东西"。之所以必须单独查 —— `heal()` 修的是
 * index 与 group 键的**一致性**，它不保证每一条记录自己成形，
 * 一条 `tabs: undefined` 的组能通过 heal 却会在推上去之后让别的设备炸。
 */
export function inspectLocalState(state: StoredState): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(state.groups)) return { ok: false, reason: 'groups-not-array' };
  if (!Array.isArray(state.categories)) return { ok: false, reason: 'categories-not-array' };
  if (!Array.isArray(state.tombstones)) return { ok: false, reason: 'tombstones-not-array' };

  for (const group of state.groups) {
    if (!isRecord(group)) return { ok: false, reason: 'group-not-object' };
    if (typeof group.id !== 'string' || !group.id) return { ok: false, reason: 'group-id-missing' };
    if (!Array.isArray(group.tabs)) return { ok: false, reason: `group:${group.id}.tabs-not-array` };
    for (const tab of group.tabs) {
      if (!isRecord(tab)) return { ok: false, reason: `group:${group.id}.tab-not-object` };
      if (typeof tab.url !== 'string') return { ok: false, reason: `group:${group.id}.tab-url-missing` };
    }
  }

  // 回收站现在也是同步源的一部分，所以它要过**同样一条**闸门：
  // 回收站里的条目带的是整组快照，形状烂掉一样会在推上去之后让别的设备炸。
  // 可选键：缺席 = 老状态，直接放过。
  if (state.trash !== undefined) {
    if (!Array.isArray(state.trash)) return { ok: false, reason: 'trash-not-array' };
    for (const entry of state.trash) {
      if (!isRecord(entry)) return { ok: false, reason: 'trash-entry-not-object' };
      const group = entry.group;
      if (!isRecord(group)) return { ok: false, reason: 'trash-entry-group-missing' };
      if (typeof group.id !== 'string' || !group.id) return { ok: false, reason: 'trash-group-id-missing' };
      if (!Array.isArray(group.tabs)) return { ok: false, reason: `trash:${group.id}.tabs-not-array` };
    }
  }
  return { ok: true };
}

interface RemoteView {
  snapshot?: SyncSnapshot;
  manifest?: SyncManifest;
  rebuilt: boolean;
  /**
   * 远端**看得见**的最高 revision —— 包括那些"manifest 在、快照读不出来"的情况。
   *
   * 为什么不直接用 `snapshot.revision`：revision 是用来生成下一个文件名的。
   * 只按可读快照算的话，快照一旦损坏就退化成 0，下一次推会算出 `revision-1`，
   * 而那个名字已经被占着 ⇒ 条件写 412，同步从此永久卡死。
   */
  observedRevision: number;
}

/**
 * 读远端。manifest 是加速用的，不是真相（§5 规则 5）—— 它读不到、验不过，
 * 就退回"扫快照目录逐个验"的重建路径。
 *
 * ⚠ 重建要把候选快照逐个下载验 checksum，代价随历史长度线性增长。
 * 这条路径只在 manifest 真的没了时走，所以默认保留历史（Q4）在这里是有成本的，
 * 我把它写进 既有约定 而不是假装免费。
 */
/**
 * 读指针文件：**一个 GET，不列目录**。
 *
 * 读不到 / 验不过 ⇒ `undefined`，调用方退回扫目录那条老路。两种来路都要能走：
 * 远端在指针出现之前就有内容（开发期真机已经同步过若干轮），以及指针那一次写恰好崩了。
 * ⚠ 不许把"读不到"当成"远端是空的" —— 那正是"对面的删除永远拉不下来"那一类假象。
 *
 * 导出是因为 `snapshot-history.ts` 也要回答"最新是哪一版"。两处必须用同一份函数：
 * 只改一处，历史面板与引擎对"最新"的理解就会分叉，表现为"面板列出的最新版比同步
 * 实际用的那一版新（或旧）"，而用户只能靠猜。
 */
export async function readPointer(
  deps: { webdav: WebDavPort },
  base: URL,
  credential: WebDavCredential,
): Promise<SyncPointer | undefined> {
  const text = await deps.webdav.get(pointerUrl(base).href, credential).catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const verified = verifyPointer(await decodeWire(text));
    return verified.ok ? verified.pointer : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按 revision 取那一版 manifest。取不到 = manifest 坏了或还没写，调用方退回扫目录。
 * 与 `readPointer` 一起导出：历史面板要的"那一版到底有哪些条目"必须由同一条读取路径拿到。
 */
export async function fetchManifest(
  deps: { webdav: WebDavPort },
  base: URL,
  revision: number,
  credential: WebDavCredential,
): Promise<SyncManifest | undefined> {
  const text = await deps.webdav.get(manifestUrl(base, revision).href, credential).catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const verified = verifyManifest(await decodeWire(text));
    return verified.ok ? verified.manifest : undefined;
  } catch {
    return undefined;
  }
}

async function readRemoteView(deps: SyncDeps, base: URL, credential: WebDavCredential): Promise<RemoteView> {
  /**
   * ★ 第一步读指针。命中就完全不碰目录列举 —— 省掉一次 PROPFIND，
   * 而且从此与"目录里攒了多少文件"再无关系（那正是 750 条那一档的来源）。
   */
  const pointer = await readPointer(deps, base, credential);
  if (pointer) {
    const manifest = await fetchManifest(deps, base, pointer.revision, credential);
    const snapshot = await fetchSnapshot(deps, base, manifest?.latestSnapshotId ?? pointer.snapshotId, credential);
    if (snapshot) {
      return {
        snapshot,
        ...(manifest ? { manifest } : {}),
        rebuilt: false,
        // 指针与快照自己都说自己是哪一版，取高的那个：与下面 `observedRevision` 同一条理由，
        // revision 是用来生成下一个文件名的，低了就撞名。
        observedRevision: Math.max(pointer.revision, snapshot.revision),
      };
    }
    // 指针指的快照读不出来 ⇒ 落进下面的扫目录重建。不能就地当"远端没有东西"。
  }

  const manifestUrlList = await deps.webdav.propfind(manifestsDirUrl(base).href, credential, 1).catch(() => []);
  if (!listingIsTrusted(manifestUrlList)) {
    throw new WebDavError(
      'bad-response',
      'PROPFIND',
      manifestsDirUrl(base).href,
      207,
      `manifests/ 一次列举就拿满了 ${TRUSTED_LISTING_LIMIT} 条，无法确定哪一版才是最新的；`
      + '指针文件读不到，所以这一轮拒绝猜测（远端历史需要在设置页手动清理，或等指针恢复）',
    );
  }
  const candidates = manifestUrlList
    .filter((entry) => entry.exists && revisionFromUrl(entry.url) !== null)
    .sort((a, b) => (revisionFromUrl(b.url) ?? 0) - (revisionFromUrl(a.url) ?? 0));

  let observedRevision = 0;
  for (const candidate of candidates) {
    const number = revisionFromUrl(candidate.url) ?? 0;
    observedRevision = Math.max(observedRevision, number);
    const text = await deps.webdav.get(candidate.url, credential).catch(() => undefined);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = await decodeWire(text);
    } catch {
      continue; // 半截的 manifest：跳过，去试下一个更旧的，而不是同步失败
    }
    const verified = verifyManifest(parsed);
    if (!verified.ok) continue;
    const snapshot = await fetchSnapshot(deps, base, verified.manifest.latestSnapshotId, credential);
    // manifest 在、它指的快照却读不出来 ⇒ 不落进下面的 return，继续往下找；
    // 但这一格的 observedRevision 已经记下了，所以下一次推送不会去抢一个已被占用的文件名。
    if (!snapshot) continue;
    return { manifest: verified.manifest, snapshot, rebuilt: false, observedRevision };
  }

  // 重建路径。**必须 catch**：第一次同步时远端连目录都还没有，propfind 回 404 ——
  // 那是"空库"这个正常状态，不是故障。少了这一层，全新用户的第一次同步会当场抛出去。
  const listing = await deps.webdav.propfind(snapshotsDirUrl(base).href, credential, 1).catch(() => []);
  if (!listingIsTrusted(listing)) {
    throw new WebDavError(
      'bad-response',
      'PROPFIND',
      snapshotsDirUrl(base).href,
      207,
      `snapshots/ 一次列举就拿满了 ${TRUSTED_LISTING_LIMIT} 条，重建路径无法确定哪一版是最新的，这一轮拒绝猜测`,
    );
  }
  const ids = listing
    .filter((entry) => entry.exists && snapshotIdFromUrl(entry.url) !== null)
    .map((entry) => snapshotIdFromUrl(entry.url) as string);

  let best: SyncSnapshot | undefined;
  for (const id of ids) {
    const snapshot = await fetchSnapshot(deps, base, id, credential);
    if (!snapshot) continue;
    if (!best || snapshot.revision > best.revision) best = snapshot;
  }
  if (!best) return { rebuilt: true, observedRevision };
  return {
    snapshot: best,
    manifest: toManifest(best),
    rebuilt: true,
    observedRevision: Math.max(observedRevision, best.revision),
  };
}

/**
 * 只读 manifest，不碰快照（既有约定 的省流量判据用）。
 *
 * 为什么不复用 `readRemoteView`：后者读完 manifest **总要 GET 那一版快照**（它要 checksum
 * 才能判断"两边内容一样"），而这里要省掉的正是那次下载 —— 压缩后 0.2–0.4 MiB，
 * 后台 alarm 每 5 分钟一次就是每天 288 次。
 *
 * 读不到 / 验不过 ⇒ `undefined`，调用方**退回完整路径**。方向很重要：
 * 把"读不到"当成"没变化"，就是对面的删除永远拉不下来的第二种"同步了个寂寞"。
 */
async function readLatestManifestPointer(
  deps: SyncDeps,
  base: URL,
  credential: WebDavCredential,
): Promise<{ snapshotId: string; revision: number } | undefined> {
  /** ★ 一个 GET 就够：省流量那条判据原来要一次 PROPFIND + 一次 manifest 下载。 */
  const pointer = await readPointer(deps, base, credential);
  if (pointer) return { snapshotId: pointer.snapshotId, revision: pointer.revision };

  const list = await deps.webdav.propfind(manifestsDirUrl(base).href, credential, 1).catch(() => []);
  if (!listingIsTrusted(list)) return undefined; // 判不出最新是哪一版 ⇒ 退回完整路径，绝不猜
  const candidates = list
    .filter((entry) => entry.exists && revisionFromUrl(entry.url) !== null)
    .sort((a, b) => (revisionFromUrl(b.url) ?? 0) - (revisionFromUrl(a.url) ?? 0));

  for (const candidate of candidates) {
    const text = await deps.webdav.get(candidate.url, credential).catch(() => undefined);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = await decodeWire(text);
    } catch {
      continue;
    }
    const verified = verifyManifest(parsed);
    if (!verified.ok) continue;
    return { snapshotId: verified.manifest.latestSnapshotId, revision: verified.manifest.latestRevision };
  }
  return undefined;
}

async function fetchSnapshot(deps: SyncDeps, base: URL, snapshotId: string, credential: WebDavCredential): Promise<SyncSnapshot | undefined> {
  const text = await deps.webdav.get(snapshotUrl(base, snapshotId).href, credential).catch(() => undefined);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = await decodeWire(text);
  } catch {
    return undefined;
  }
  const verified = await verifySyncSnapshot(parsed);
  // §19「远端历史文件损坏 ⇒ 跳过坏版本」：坏的那一版不参与，也不报错把整次同步干掉
  return verified.ok ? verified.snapshot : undefined;
}

function toManifest(snapshot: SyncSnapshot): SyncManifest {
  return buildManifest({
    latestRevision: snapshot.revision,
    latestSnapshotId: snapshot.snapshotId,
    updatedAt: snapshot.createdAt,
    deviceIds: [snapshot.deviceId],
    history: [{
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      deviceId: snapshot.deviceId,
      createdAt: snapshot.createdAt,
      stateChecksum: snapshot.stateChecksum,
    }],
    /**
     * 重建路径也要给出设备表，否则"manifest 丢了扫目录重建"这一走
     * 就把对面那台设备的名字弄没了 —— 冲突面板当场退回显示 UUID 前 8 位，
     * 而这正是这次要修的那个现象。来源只能是快照自己带的这三个数。
     *
     * ⚠ 老快照没有 `deviceName` ⇒ **不写这个键**，不编一个名字：
     * 名字是用户起的，引擎没有权利用"另一台设备"这种话来冒充他看见过。
     */
    ...(snapshot.deviceName === undefined
      ? {}
      : { devices: [{ id: snapshot.deviceId, name: snapshot.deviceName, updatedAt: snapshot.createdAt }] }),
  });
}

/**
 * 把合并结果落到本地存储。
 *
 * 只在合并成功之后调用一次：中途失败会留下半套状态，所以上面的 `mergeStates` 是纯函数、
 * 下面这一段不做任何"边读边改"的事。
 * 删除走 `storage.removeGroup`（物理删）而不是 `softDeleteGroup` —— 墓碑已经在合并结果里，
 * 再补一条会把同一次删除署名成"这台机器刚刚删的"，而实际不是。
 */
async function applyMergedState(deps: SyncDeps, merged: StoredState): Promise<void> {
  const currentIds = new Set((await deps.storage.listAllGroups()).map((group) => group.id));
  const nextIds = new Set(merged.groups.map((group) => group.id));
  for (const group of merged.groups) await deps.storage.putGroup(group);
  for (const id of currentIds) {
    if (!nextIds.has(id)) await deps.storage.removeGroup(id);
  }
  await deps.storage.setCategories(merged.categories);
  await deps.storage.setTombstones(merged.tombstones);
  // 回收站整体覆写：合并结果已经是"两侧并集减去被处理掉的"（`merge.ts` 的 `mergeTrash`），
  // 逐条 putTrash 反而会把本机那份没进结果的旧行留在盘上。
  await deps.storage.setTrash(merged.trash ?? []);
}

/**
 * 删除方那台设备的友好名。纯函数：只读传进来的那两个来路，不查存储、不碰网络。
 *
 * 两个来路按可靠性排：
 * 1. **manifest 的设备表** —— 那是所有参与设备各自写进来的名字（`mergeDeviceTables` 合并过），
 *    一台设备可能推过多版，它的名字因此比"这一版快照恰好带的"更全。
 * 2. **远端那一版自带的 `deviceName`** —— 只在这版确实是它写的（`deviceId` 对得上）时才作数。
 *
 * 解析不到就返回 `undefined`，**不编一个名字**：名字是用户自己起的，
 * 引擎拿"另一台设备"这种话去冒充它，比 UI 回退显示 UUID 前 8 位更坏 —— 前者看起来像真知道，
 * 后者一眼就看得出是机器身份。回退那一支在 `components/ConflictPanel.vue`。
 *
 * 只在这里写一份：`pendingConflicts` 那一段按冲突逐条调它，第二条来路的判据（`deviceId` 相等）
 * 一旦在两处分别落地，就会出现"同一台设备在同一个面板里有两种说法"。
 */
function resolveDeviceName(deviceId: string, remote: RemoteView): string | undefined {
  const fromTable = nameOfDevice(remote.manifest?.devices, deviceId);
  if (fromTable) return fromTable;
  const snapshot = remote.snapshot;
  if (snapshot && snapshot.deviceId === deviceId && snapshot.deviceName) return snapshot.deviceName;
  return undefined;
}

/**
 * 一次完整同步。它**不抛**：所有失败都编进返回值，
 * 因为调用方是 background 的节拍与 UI 按钮，两处都不该因为网络抖动炸掉。
 *
 * ⚠ **生产代码不要直接调它** —— 走 `requestSync(deps, reason)`。
 * 这里是"怎么同步"的引擎，`requestSync` 才是"要不要同步"的唯一入口；五类节拍各自
 * 决定跑不跑就会长出五套判据。`test/search-and-backup.spec.ts` 有一条守卫盯着生产目录
 * 的调用点。`trigger` 只进账本与显示，不进任何判据。
 */
export async function runSync(
  deps: SyncDeps,
  at: number = now(),
  trigger: SyncTriggerReason = 'manual',
): Promise<SyncOutcome> {
  const storage = deps.storage;

  /**
   * 同步事件日志的唯一写入口。
   *
   * 三条口径，都是被这条线自己的历史逼出来的：
   * - **只记状态变化类出口**。`no-changes`（查了没变化）与 `backoff`（退避中）一条都不写：
   *   页面开着时心跳 60 秒一轮、空闲也照样跑"查了没变化"，全记的话环 100 在 ≈100 分钟里
   *   被填满、真事件被挤出去。"引擎活着"的证据由状态行的"上次同步"承担，不归日志。
   * - **一次 `runSync` 一条主事件**，kind 由最终出口定，合并信息进 summary。
   * - **不进任何判据**：下面每一个分支都是"先把这一轮的结论算完，再把它记下来"，
   *   反过来（读日志来决定要不要推）就是第二个真相。写失败也永不影响这一轮
   *   （`appendSyncEvent` 自己 catch，见 `infrastructure/storage/wxt-storage.ts`）。
   *
   * `at` 用这一轮的时刻而不是 `Date.now()`：日志与账本必须说同一个时间，
   * 否则排查时"日志里那次失败"对不上账本里的 `lastError.at`，这两份证据就互相作废。
   */
  const logEvent = (kind: SyncEventKind, success: boolean, summary?: string): Promise<unknown> =>
    storage.appendSyncEvent({ kind, success, trigger, summary }, at);

  const config = await storage.getWebDavConfig();
  if (!config.enabled) {
    await storage.setSyncMeta({ ...(await storage.getSyncMeta()), status: 'disabled' });
    // 不记：同步没开着，这不是引擎的事件。
    return { status: 'disabled', skip: 'disabled' };
  }

  const parsed = parseBaseUrl(config.baseUrl);
  if (!parsed.ok) {
    await logEvent('error', false, 'err:bad-url');
    return { status: 'error', skip: 'bad-base-url', error: { kind: 'unknown', message: `WebDAV 地址无效：${parsed.reason}` } };
  }
  const base = parsed.url;

  const stored = await storage.getSyncCredential();
  if (!stored) {
    await logEvent('error', false, 'err:no-credential');
    return { status: 'error', skip: 'no-credential', error: { kind: 'credentials', message: '没有保存的密码' } };
  }
  const credential: WebDavCredential = { username: config.username, password: stored.password };

  const meta = await storage.getSyncMeta();
  if (meta.nextAttemptAt !== undefined && at < meta.nextAttemptAt) {
    // ★ 空转出口，**一条都不写**（既有约定 对方案 §6.1 映射表的那处修正）。
    return { status: meta.status === 'idle' ? 'pending' : meta.status, skip: 'backoff' };
  }

  /**
   * 塌陷闸的一次性授权，**读完即消费**。
   *
   * 放在退避之后是刻意的：退避中的这一轮根本走不到闸前，在这里之前消费就等于把用户
   * 那一次点击白白吃掉。
   *
   * 直接改本地这份 `meta` 对象，不只是改存储：下面每一处 `setSyncMeta({ ...meta, ... })`
   * 摊的都是它，只清存储不清这个对象，本轮任何一次写入都会把它原样带回去。
   */
  const suspiciousAck = meta.suspiciousAckChecksum;
  if (suspiciousAck !== undefined) {
    meta.suspiciousAckChecksum = undefined;
    await storage.setSyncMeta(meta);
  }

  /**
   * 失败收场**唯一一份**：加连续失败数、设退避、落 lastError，本地数据一条都不改（§19）。
   * 读远端与推送两处共用 —— 原来这个形状只在推送那一段有，
   * 于是 既有约定 新加的"读远端也会失败"那一条只能另抄一份，而另抄的那份迟早分叉。
   */
  const failOver = async (error: unknown) => {
    const kind = error instanceof WebDavError ? error.kind : ('unknown' as const);
    const message = error instanceof Error ? error.message : String(error);
    const failures = meta.consecutiveFailures + 1;
    // 记在写账本**之前**：设置页的日志区是订阅 `watchSyncMeta` 刷新的，
    // 反过来写就会出现"面板被这一轮唤起了、列表里却没有这一轮"的那一拍。
    await logEvent('error', false, `err:${kind}`);
    await storage.setSyncMeta({
      ...meta,
      status: 'error',
      consecutiveFailures: failures,
      nextAttemptAt: at + backoffDelayMs(failures),
      lastError: { kind, message, at },
      dirtySinceAt: meta.dirtySinceAt ?? at,
    });
    return {
      status: 'error' as const,
      error: { kind, message },
    };
  };

  const local = await readStoredState(deps);
  const inspected = inspectLocalState(local);
  if (!inspected.ok) {
    // 规则 C/D：禁止同步，且**不改动本地任何东西**。这里没有可确认的东西 ——
    // 让用户点"保留本地"等于把一坨解析不了的数据当真本。
    //
    // 事件走 `error` + `err:invalid-local:<原因>`，**不新立第六个 kind**：
    // 它对用户的含义就是"这一轮失败了"，区别只在原因。
    await logEvent('error', false, `err:invalid-local:${inspected.reason}`);
    await storage.setSyncMeta({ ...meta, status: 'error', lastError: { kind: 'invalid-local-state', message: inspected.reason, at } });
    return { status: 'error', blocked: { reason: inspected.reason } };
  }

  const localChecksum = await stateChecksumOf(local);

  /**
   * 既有约定：远端那一版本机见过、且本地一个字节没改 ⇒ 不再下载整份快照。
   *
   * 三个条件**缺一不可**：`lastSeenSnapshotId` 有值说明上一次真的读到并验过那一版；
   * `lastPushedChecksum === localChecksum` 说明本地内容就是那一版；不脏说明之后没动过。
   * 少任一条都必须退回完整路径。manifest 读失败也退回（`pointer === undefined`）。
   */
  if (
    meta.lastSeenSnapshotId !== undefined
    && meta.lastPushedChecksum === localChecksum
    && meta.dirtySinceAt === undefined
  ) {
    const pointer = await readLatestManifestPointer(deps, base, credential);
    if (pointer && pointer.snapshotId === meta.lastSeenSnapshotId) {
      await storage.setSyncMeta({
        ...meta,
        status: 'idle',
        lastSyncAt: at,
        remoteRevision: pointer.revision,
        consecutiveFailures: 0,
        nextAttemptAt: undefined,
        lastError: undefined,
        lastTrigger: trigger,
      });
      // ★ 空转出口，**一条都不写**。这一支是"指针说还是那一版、本机也没改"，
      // 后台 alarm 与页面心跳绝大多数轮都走在这里。
      return { status: 'idle', skip: 'no-changes' };
    }
  }

  /**
   * ★ 读远端这一步的失败**必须走同一条收场**，不能裸抛。
   *
   * 既有约定 给 `readRemoteView` 添了一条会主动抛的判据：一次列举拿满 750 条 ⇒ 拒绝猜
   * "最新是哪一版"（猜错会算出一个已被占用的 revision 文件名，把别人那一版的指针盖掉）。
   * 这里原来没有 catch：那一抛会穿过 `runSync` 交给 background，于是连续失败数不加、
   * 退避不设、`lastError` 不落 —— 用户看到的正是这套设计最不该出现的一幕：
   * 「点了没反应，也没说为什么」。
   */
  let remote: RemoteView;
  try {
    remote = await readRemoteView(deps, base, credential);
  } catch (error) {
    return await failOver(error);
  }
  const remoteState = remote.snapshot?.state;

  const deviceId = await storage.getDeviceId();
  let remoteMerged: StoredState | undefined;
  let conflicts: DeleteVsEditConflict[] = [];
  let pulledRevision: number | undefined;
  /**
   * 这一轮从远端**收下了多少条**会话（`mergeStates` 的 `applied.keptFromRemote`）。
   *
   * 单独留一个数是因为事件日志要带它（既有约定 的 `merged:<n>`），而 `merged` 对象在这个
   * `if` 块结束就没了。它是"发生了什么"，不是"还剩多少" —— 与 `applied` 其余几个数同一个口径。
   */
  let mergedFromRemote: number | undefined;

  if (remote.snapshot && remote.snapshot.stateChecksum !== localChecksum) {
    // 两边内容不同 ⇒ 先合并再推。直接推会把远端那一版的改动盖掉（§10「不静默覆盖」）。
    const merged = mergeStates({ local, remote: remote.snapshot.state });
    conflicts = merged.conflicts;
    await applyMergedState(deps, merged.state);
    remoteMerged = merged.state;
    mergedFromRemote = merged.applied.keptFromRemote;
    pulledRevision = remote.snapshot.revision;
    if (conflicts.length > 0) {
      // 有实体级撞车就**不推**：合并结果里还带着没定案的东西，推上去等于替用户做了决定。
      // 冲突必须落盘再返回：跑这次同步的是 background，看冲突的是某个页面上的对话框。
      // 只放在返回值里，用户一切页面冲突就没人知道了，而同步会一直静默停在 conflict。
      await logEvent('conflict', false, `conflicts:${conflicts.length}`);
      await storage.setSyncMeta({
        ...meta,
        status: 'conflict',
        remoteRevision: remote.snapshot.revision,
        // 这一版确实读到过 ⇒ 下一轮的"跳过下载"认这个文件名
        lastSeenSnapshotId: remote.snapshot.snapshotId,
        lastTrigger: trigger,
        pendingConflicts: conflicts.map((conflict) => {
          // 名字在**落账那一刻**解析：对话框读的是账，它不会再去看远端 manifest，
          // 所以"这一版远端里能不能认出那台设备"只有现在答得出来。
          const deletedByName = resolveDeviceName(conflict.deletedByDeviceId, remote);
          return {
            groupId: conflict.groupId,
            // 标题在落账时抄一份：见 `StoredConflict.groupTitle`（面板那侧不再依赖本机有没有这条）
            groupTitle: conflict.group.title,
            deletedAt: conflict.deletedAt,
            editedAt: conflict.editedAt,
            deletedByDeviceId: conflict.deletedByDeviceId,
            deleteReason: conflict.deleteReason,
            // 解析不到就**不写这个键**（不是空串、不是"另一台设备"），见 `resolveDeviceName` 那条
            ...(deletedByName === undefined ? {} : { deletedByName }),
          };
        }),
      });
      return { status: 'conflict', pulled: { revision: remote.snapshot.revision, conflicts }, manifestRebuilt: remote.rebuilt };
    }
  }

  const remoteRevision = Math.max(remote.snapshot?.revision ?? 0, remote.observedRevision);
  // `outgoing` 不等于 `local`：上面如果做过合并，要推的是**合并后**的那一版。
  // 这里曾经直接复用 `local`，后果是"合并算完了、本地也落库了，推上去的却还是合并前的旧账"
  // —— 于是另一台设备永远收不到这次合并，下一轮又从头撞一次。
  const outgoing = remoteMerged ?? local;
  const outgoingChecksum = outgoing === local ? localChecksum : await stateChecksumOf(outgoing);

  if (remote.snapshot?.stateChecksum === outgoingChecksum) {
    /**
     * 这一支里面其实藏着**两种完全不同的轮次**，日志只记其中一种：
     * - `mergedFromRemote === undefined` ⇒ 没合并过，本机内容与远端**本来就一致** ⇒ 空转，一条不写。
     * - 有值 ⇒ 上面那段合并真的把远端的改动落到本机了，只是结果恰好与远端同形（所以没东西可推）。
     *   本机**已经变了**，这不是空转 ⇒ 记一条 `pull`。
     *
     * 区分靠 `mergedFromRemote` 这个既有事实，不新加判据、也不改这一轮的结论。
     */
    if (mergedFromRemote !== undefined) {
      await logEvent('pull', true, `merged:${mergedFromRemote}`);
    }
    await storage.setSyncMeta({
      ...meta,
      status: 'idle',
      dirtySinceAt: undefined,
      consecutiveFailures: 0,
      nextAttemptAt: undefined,
      lastSyncAt: at,
      remoteRevision,
      lastPushedChecksum: outgoingChecksum,
      lastPushedRevision: Math.max(meta.lastPushedRevision, remoteRevision),
      lastSeenSnapshotId: remote.snapshot?.snapshotId ?? meta.lastSeenSnapshotId,
      lastTrigger: trigger,
      // 两边内容已经一致 ⇒ 没有任何停在闸前的那一版了
      suspiciousOutgoingChecksum: undefined,
    });
    return { status: 'idle', skip: 'no-changes', manifestRebuilt: remote.rebuilt };
  }

  /**
   * ★ 塌陷闸只管**推**这个方向（2026-10-06 真机反馈改到这里）。
   *
   * 它原来在 `readRemoteView` 之后、合并之前，一停就 early return —— 于是把**拉取**也一起拦了。
   * 后果正是用户看到的：Chrome 导入大库推上去之后，Edge 点同步只得到
   * 「本机的标签组比服务器少得多，所以什么都没上传」，云端那份数据**永远拉不下来**，
   * 而且这台机器没有任何出口（全仓搜 `skipSafety` / `confirmSuspicious` 零命中）。
   *
   * 为什么拦拉是错的：合并语义是**并集 + 实体级 LWW**，本机少不会让云端少；
   * "本机比云端少得多"恰恰是一台新设备该有的样子。规则 A/B 的原文防的是
   * "一次本地塌陷被当成正常删除推上云端，两份数据同时没" —— 那是推的方向。
   *
   * 判据的对象也顺势变准：比的是**即将推上去的那一版**（`outgoing`，合并后），
   * 不是合并前的本机原始状态。所以"本机删了 25 条"那一档仍然会停（墓碑让合并结果也只剩 0 条），
   * 而"本机 2 条、云端 30 条"这一档已经在上一步把 30 条落到本地了。
   */
  const verdict = assessSyncSafety({ local: outgoing, localValid: true, remote: remoteState });
  if (!verdict.ok && verdict.kind === 'blocked') {
    // 到这一步不该出现（上面 `inspectLocalState` 已经过了），留着是因为它过了类型这一关：
    // 真出现就是"合并算出一个本地读不出来的形状"，那是引擎自己的错，不许当成可疑等用户确认。
    await logEvent('error', false, `err:invalid-local:${verdict.reason}`);
    await storage.setSyncMeta({ ...meta, status: 'error', lastError: { kind: 'invalid-local-state', message: verdict.reason, at } });
    return { status: 'error', blocked: { reason: verdict.reason } };
  }
  /**
   * ★ 出口：用户核对过数字并明确放行了**这一版内容**，就照推。
   *
   * 这一格补的是 `safety.ts` 那个判别联合注释里承诺了却一直没有的东西（"挂起，等用户在 UI 上
   * 选恢复云端 / 保留本地 / 查看差异"）。既有约定 把闸挪到合并之后只救回了**拉**的方向；
   * 推的方向在此之前是死的 —— 远端 25 组、本机带墓碑删光，规则 A 每轮都成立、永远推不出去，
   * 而用户唯一的出路是撤回删除或清空远端历史（后者正是这道闸要防的事）。
   *
   * 只放行 `suspicious`，**不放行 `blocked`**：规则 C/D 是"本地状态本身不可信"，
   * 那一份数据连自己有多少条都答不准，没有任何可供用户确认的东西（上面那条注释已经写了）。
   * 授权按 `outgoingChecksum` 认，所以内容一变就对不上号、闸会重新报数。
   */
  const acknowledged = suspiciousAck !== undefined && suspiciousAck === outgoingChecksum;
  if (!verdict.ok && !acknowledged) {
    await logEvent('suspicious', false, 'suspicious');
    await storage.setSyncMeta({
      ...meta,
      status: 'suspicious_change',
      lastTrigger: trigger,
      // 记下"用户如果要点确认，他授权的是哪一版"：点按钮的是另一个进程，只能靠账本对话。
      suspiciousOutgoingChecksum: outgoingChecksum,
    });
    return {
      status: 'suspicious_change',
      suspicious: { rules: verdict.rules, counts: verdict.counts },
      ...(pulledRevision === undefined ? {} : { pulled: { revision: pulledRevision, conflicts } }),
    };
  }

  // 先把这一版落成耐久快照再推：推的东西在本地没有可恢复的副本，是 §20 明令防的事
  const captured = await captureDurableSnapshot(deps, at);
  if (!captured.ok) {
    // 这一支没走 `failOver`：连续失败数与退避都不该由"本机盘写不进去"来累加，
    // 但它是实打实的失败出口，所以日志照记（判别值用自己的名字，不冒充 WebDAV 的 kind）。
    await logEvent('error', false, 'err:durable-snapshot');
    await storage.setSyncMeta({ ...meta, status: 'error', lastError: { kind: 'unknown', message: captured.reason, at } });
    return { status: 'error', error: { kind: 'unknown', message: `本地快照写入失败：${captured.reason}` } };
  }

  const revision = remoteRevision + 1;
  // 内容寻址：同内容 → 同文件名。见 remote-layout.ts 的 `snapshotIdFor` 那段——
  // 随机 id 在"快照写成功、manifest 写失败"之后会把同一份内容反复存进不可变历史。
  const snapshotId = snapshotIdFor(outgoingChecksum);
  const snapshot = await buildSyncSnapshot(outgoing, {
    snapshotId,
    deviceId,
    revision,
    createdAt: at,
    ...(remote.snapshot ? { baseSnapshotId: remote.snapshot.snapshotId } : {}),
  });
  /**
   * ★ 把**本机设备名**押在这份快照上带出去（既有约定 的"发货端"）。
   *
   * 读侧早就有了（冲突面板拿 `deletedByName`、`nameOfDevice` 解 manifest 设备表），
   * 但推送一直只写 `deviceId` —— 于是名字从来没有上线过，对面能解析的名字只能来自
   * "从快照重建 manifest"那一条少数路径。类型写了、函数写了、调用点为 0：那是死字段加假接通。
   * 它不参与 `stateChecksum`（那个只盖 `state`），所以加这一格不破内容寻址去重。
   */
  snapshot.deviceName = (await storage.getDeviceProfile()).name;

  try {
    await deps.webdav.ensureCollection(snapshotsDirUrl(base).href, credential);
    await deps.webdav.ensureCollection(manifestsDirUrl(base).href, credential);
    try {
      // If-None-Match: * —— 撞上了就是"这一份内容已经在远端了"
      await deps.webdav.put(snapshotUrl(base, snapshotId).href, await encodeWire(snapshot), credential, { ifNoneMatch: '*' });
    } catch (error) {
      /**
       * 快照那一步的 412 是**成功**，不是失败：文件名由内容决定，所以 412 的意思
       * 精确地就是"这一份已经在了"。这时继续写 manifest（revision 是新的，必须落）。
       *
       * 但只吞这一种：401/403/5xx/network 都要冒泡，否则"根本没上传成功"会被
       * 记成"已经同步好了"，而那是这套设计里最坏的一类假象。
       */
      const alreadyThere = error instanceof WebDavError && error.kind === 'precondition-failed';
      if (!alreadyThere) throw error;
    }

    const ledger = [
      { snapshotId, revision, deviceId, createdAt: at, stateChecksum: snapshot.stateChecksum },
      ...(remote.manifest?.history ?? []),
    ];
    /**
     * 没注入 admin 的调用方**连账本都不裁**。
     *
     * 只裁不删是唯一一种会**制造隐形垃圾**的组合：文件还在网盘上、账本已经忘了它，
     * 于是界面看不见、手动清理也扫不到，谁都不再记得。要么裁 + 删一起做，要么两件都不做。
     * 生产两条路径（background 的五类节拍、面板那颗「立即同步」）都注入了 admin，
     * 所以这一支实际只服务于"测试里只递 `{storage, webdav}`"的那种调用方。
     */
    const canPrune = deps.admin !== undefined;
    const kept = canPrune ? ledger.slice(0, REMOTE_HISTORY_LIMIT) : ledger;
    /**
     * 滚出窗口、可以安全删掉的那几版。两格必须排除，都是"删掉自己正在用的东西"的形状：
     * - **文件名是内容寻址的**：同一个 `state` 在不同 revision 上会留两条账、指向**同一个文件**
     *   （改一改又改回来就是这一形）。旧的滚出窗口时删它，等于把还活着的那一版删了。
     * - 这一轮刚推上去的那一版（`snapshotId` 一定在 `kept` 里，所以第一条已经盖住）。
     */
    const rolledOff = canPrune ? pickRolledOff(ledger, REMOTE_HISTORY_LIMIT) : [];
    /**
     * 删不掉的（网络抖、403、配额）要**留在账本里**，下一轮再试一次 ——
     * 否则就落回上面那条"只裁不删"的隐形垃圾里。代价是账本这一刻会比窗口多几条，
     * 下一轮删成就自己收回去。
     */
    const stillThere = await pruneRolledOff(deps, base, credential, rolledOff, REMOTE_RETENTION_MAX_DELETES);
    const history = [...kept, ...stillThere];
    const deviceIds = [...new Set([...(remote.manifest?.deviceIds ?? []), deviceId])].sort();
    const manifest = buildManifest({
      latestRevision: revision,
      latestSnapshotId: snapshotId,
      updatedAt: at,
      deviceIds,
      history,
      /**
       * ★ 设备表：对面那一版留下的条目 + 本机这一条，`mergeDeviceTables` 合并
       * （既有约定 的"发货端"第二半）。这一步之前 `mergeDeviceTables` 是**被 import 但
       * 没有任何调用点**的函数 —— 名字合并在两端各自算不出同一张表，冲突面板就只能回退到 UUID 前缀。
       * 结果按 id 排序 ⇒ A 算与 B 算逐字节一致，与 `merge.ts` 同一条可交换性要求。
       */
      devices: mergeDeviceTables(remote.manifest?.devices ?? [], [
        { id: deviceId, name: snapshot.deviceName ?? deviceId, updatedAt: at },
      ]),
    });
    /**
     * manifest 按 revision 命名、不可变，所以它和快照一样用 `If-None-Match: *`
     * （既有约定，**修订** 既有约定 §"还没闭合的"第 5 条那一句"不是 bug 而是被接受的设计"）。
     *
     * 原来这一笔什么条件头都不带：两台设备同时读到账本、同时算出 `revision-N`，
     * 后写的直接把先写那一版的 manifest 盖掉。§5 当时接受的是"多推了一版"，
     * 真相比那糟一点 —— 输的那一版从指针里消失，要等它自己再推一次才回来。
     *
     * 撞了（412）只有两种可能，读一眼那一版是谁写的就分得开：
     * - **是我们自己写的**：上一轮 manifest 落成了、指针那一步崩了 ⇒ 只补指针。
     *   这一支让"指针写失败"是**可自愈**的，而不是从此每轮都撞一次。
     * - **是别人写的**：这一版号被抢了 ⇒ 本轮就此收手报错。下一轮重新读远端，
     *   按 N+1 算（`remoteRevision` 来自 `Math.max(快照.revision, observedRevision)`），
     *   退避与 60 秒节拍自然会把它送到。
     *
     * ⚠ 这里**不在本轮内 bump 重试**，比我原先说的"重试上限 2 次"更简单，而且不是偷懒：
     * 快照文件里写着它自己的 `revision`，换号就得重写快照文件 —— 而 `snapshotId` 是按
     * `state` 的 checksum 算的、不含 revision，于是同一个文件名上会出现两份不同内容，
     * 正好撞上不可变那一条。把重试推给下一轮（重新读、重新算、重新构造），一次就都不矛盾。
     */
    try {
      await deps.webdav.put(manifestUrl(base, revision).href, await encodeWire(manifest), credential, { ifNoneMatch: '*' });
    } catch (error) {
      if (!(error instanceof WebDavError) || error.kind !== 'precondition-failed') throw error;
      const held = await fetchManifest(deps, base, revision, credential);
      if (!held || held.latestSnapshotId !== snapshotId) throw error;
      // 那一版就是我们自己的 ⇒ 这一笔已经成了，只差指针没跟上。继续往下补指针。
    }

    /**
     * 指针**最后**写：在它成功之前别的设备读到的还是旧的那一版，
     * 于是它们撞上同一个 revision 号时，上面那一支会把我们这一版认出来，而不是盖掉它。
     */
    await deps.webdav.put(pointerUrl(base).href, await encodeWire(buildPointer({
      revision,
      snapshotId,
      updatedAt: at,
    })), credential);
  } catch (error) {
    // 本地数据一条都不改。§19「WebDAV 401 只报错，不改本地数据」由 `failOver` 的返回值决定。
    return await failOver(error);
  }

  /**
   * 推送成功的摘要：主判别值 `R<revision>`，这一轮真合并过就把条数并进**同一条**
   * summary（`R12 · merged:3`）。kind 由最终出口定 —— 合并过也仍是 `push`，不是第二条事件。
   */
  await logEvent(
    'push',
    true,
    mergedFromRemote === undefined ? `R${revision}` : `R${revision} · merged:${mergedFromRemote}`,
  );

  await storage.setSyncMeta({
    ...meta,
    status: conflicts.length > 0 ? 'conflict' : 'idle',
    lastPushedRevision: revision,
    lastPushedChecksum: snapshot.stateChecksum,
    lastSyncAt: at,
    dirtySinceAt: undefined,
    consecutiveFailures: 0,
    nextAttemptAt: undefined,
    remoteRevision: revision,
    lastError: undefined,
    // 推上去的这一版就是远端最新 ⇒ 下一轮"远端没变就别下载"认它
    lastSeenSnapshotId: snapshotId,
    lastTrigger: trigger,
    // 推成功后清冲突账：走到这里说明这一版没有任何没定案的东西被推上去
    pendingConflicts: undefined,
    // 这一版已经上云 ⇒ 塌陷闸那两格（停在闸前的是哪一版 / 用户的放行）都作废
    suspiciousOutgoingChecksum: undefined,
    suspiciousAckChecksum: undefined,
  });

  return {
    status: 'idle',
    pushed: { snapshotId, revision },
    ...(pulledRevision === undefined ? {} : { pulled: { revision: pulledRevision, conflicts } }),
    ...(remote.rebuilt ? { manifestRebuilt: true } : {}),
  };
}

/**
 * **同步的唯一入口**：五类 trigger 全都只能走这里，不许直接调 `runSync`。
 *
 * 三步，顺序固定：
 * 1. 读配置与账本，交给 `decideSync`（disabled / in-flight / awaiting-user / not-due）；
 * 2. 判"该跑"才跑，并且**先同步占住本进程的标记，再落跨进程的认领**；
 * 3. 把"没跑成的原因"如实带回，UI 要用它说一句人话。
 *
 * ⚠ 占标记必须在任何 `await` 之前：留了 await 就留了一扇窗，两次 `requestSync`
 * 都会在对方占上之前读到"没人做"，于是双双放行（这条我是先写用例、看着它红才发现的）。
 */
export type SyncAttempt =
  | { ran: true; outcome: SyncOutcome }
  | { ran: false; cause: SyncSkipCause; reason: SyncTriggerReason };

/** 本进程的 in-flight。跨进程那一份是账本里的 `syncClaimedAt`。 */
let inFlight = false;

export async function requestSync(
  deps: SyncDeps,
  reason: SyncTriggerReason,
  at: number = now(),
): Promise<SyncAttempt> {
  const config = await deps.storage.getWebDavConfig();
  const meta = await deps.storage.getSyncMeta();
  const decision = decideSync({ reason, meta, at, enabled: config.enabled, inFlight });
  if (decision.action === 'skip') return { ran: false, cause: decision.cause, reason };

  inFlight = true;
  await deps.storage.setSyncMeta({ ...meta, syncClaimedAt: at });
  try {
    return { ran: true, outcome: await runSync(deps, at, reason) };
  } finally {
    inFlight = false;
    // 解锁要重读：这一轮里账本已经被 runSync 改过好几遍了。
    // 只清"自己那次认领"（时刻相同），别的进程后来占上的锁不该由我还。
    const latest = await deps.storage.getSyncMeta().catch(() => undefined);
    if (latest && latest.syncClaimedAt === at) {
      await deps.storage.setSyncMeta({ ...latest, syncClaimedAt: undefined }).catch(() => undefined);
    }
  }
}

/** 锁还有多久过期，给测试与排查用（判据本身走 `claimIsLive`）。 */
export const SYNC_LOCK_TTL_MS = SYNC_CLAIM_TTL_MS;
export { claimIsLive };

/**
 * 用户对一条 delete-vs-edit 冲突的裁决（既有约定 决定 4）。
 *
 * 两个选择都只动本地，**不碰远端**：确认删除走的是墓碑那条路，下一轮同步自然把它带过去；
 * 而"保留会话"就是把已经落回本地的东西留着。在这里直接去远端删文件是 §5 规则 3 明令禁止的事。
 *
 * 裁完必须把这条从账上摘掉，否则对话框会一直挂着、同步永远停在 conflict。
 */
export async function resolveConflict(
  deps: SyncDeps,
  conflict: StoredConflict,
  choice: 'keep' | 'delete',
  at: number = now(),
): Promise<void> {
  const meta = await deps.storage.getSyncMeta();

  if (choice === 'delete') {
    // 复用软删除那一条路：墓碑署名与"要不要进回收站"的判据都和别处一致，
    // 不在这里另写一份，否则同一个删除会有两套语义。
    await softDeleteGroup(deps, { groupId: conflict.groupId, reason: conflict.deleteReason, at });
  }

  const remaining = (meta.pendingConflicts ?? []).filter((item) => item.groupId !== conflict.groupId);
  await deps.storage.setSyncMeta({
    ...meta,
    pendingConflicts: remaining.length > 0 ? remaining : undefined,
    // 还有没裁的就留在 conflict；裁完了转 pending，等下一次同步把结果推出去
    status: remaining.length > 0 ? 'conflict' : 'pending',
    dirtySinceAt: meta.dirtySinceAt ?? at,
  });
}

/**
 * 用户在设置页点了「我核对过了，这一版照推」（既有约定，塌陷闸的出口）。
 *
 * 与 `resolveConflict` 同一形状：只写账本、把状态转成 `pending`，推送交给下一轮 `requestSync`
 * （既有约定：这里不许直接调 `runSync`，否则就成了绕过判据的后门）。
 *
 * 两处与 `resolveConflict` 刻意的不同：
 * 1. **不碰 `dirtySinceAt`**。裁决冲突是一次真实的本地改动（它可能软删一个会话），
 *    而确认塌陷不是 —— 本地一个字节都没变，变的只是"这一版准不准上云"。
 *    跟着写 `?? at` 会白白吃一次 3 秒去抖，用户点完立刻看到"本轮未发起"，
 *    而这颗按钮的全部意义就是解开一个死结。
 * 2. 授权按 `suspiciousOutgoingChecksum` 认，即"用户看过那四个数字的那一版内容"。
 *
 * 返回 `false` = 账本里没有可确认的那一版（例如页面开着的时候一轮新同步已经改写了状态）。
 * UI 要据此说一句真话，不能假装点成功了。
 */
export async function acknowledgeSuspiciousChange(deps: SyncDeps): Promise<boolean> {
  const meta = await deps.storage.getSyncMeta();
  const target = meta.suspiciousOutgoingChecksum;
  if (target === undefined) return false;
  await deps.storage.setSyncMeta({
    ...meta,
    suspiciousAckChecksum: target,
    status: 'pending',
  });
  return true;
}

/**
 * 账本滚出保留窗口、且**可以安全删掉**的那几版。
 *
 * 排除条件是这条判据的全部难点所在：快照文件名是**内容寻址**的，所以同一个 `snapshotId`
 * 可以在账本上出现两次（改一改又改回来 ⇒ revision 不同、`state` 相同 ⇒ 同一个文件）。
 * 旧的那条滚出窗口时把它对应的文件删掉，等于把窗口里还活着的那一版删了 ——
 * 表现是"我明明列出来的那一版，点恢复说文件不存在"。
 *
 * 单独成函数是为了能用小窗口测：常量是 100，为一格排除条件推 105 版再改内容回来，
 * 那条用例既慢又难读。真实窗口由 `sync-engine.spec.ts` 的集成用例钉一次。
 */
export function pickRolledOff(ledger: ManifestEntry[], limit: number): ManifestEntry[] {
  const keptIds = new Set(ledger.slice(0, limit).map((entry) => entry.snapshotId));
  return ledger.slice(limit).filter((entry) => !keptIds.has(entry.snapshotId));
}

/**
 * 把滚出保留窗口的那几版从网盘上删掉，返回**没删掉**的那些。
 *
 * 每一版删两个文件：快照本体 + 那一版的 `manifests/revision-N.json`。
 * 后者也要删，否则 `manifests/` 会一直长 —— 坚果云单次列举只回 750 条，
 * 指针文件哪天丢了、要扫目录重建"最新是哪一版"时，一个撑爆的目录会让那次重建直接不可信。
 *
 * ⚠ 只在**推送已经成功之后**调用，而且只删账本自己交出去的那些：
 * 反过来（按目录列举做差集去删）会删掉另一台设备刚推上去、manifest 还没落成的那一版 ——
 * 那是静默丢数据，比留几个孤儿文件坏得多。
 *
 * 删除失败一律不冒泡：这一轮的同步已经成了，数据是安全的，
 * 保留策略晚一轮再试就够了。没删掉的由调用方留在账本里。
 *
 * 单独导出是为了能用**小窗口**测：真实的上限是 20，而要让一条滚出窗口得先攒够 100 版，
 * 那种用例（`sync-engine.spec.ts` 里的存量那一笔）钉的是"真常量下确实只发 40 个 DELETE"，
 * 钉不动"上限之内谁留下、谁交回账本"这一格 —— 那需要一份能逐字控制的名单。
 */
export async function pruneRolledOff(
  deps: SyncDeps,
  base: URL,
  credential: WebDavCredential,
  rolledOff: ManifestEntry[],
  maxDeletes: number,
): Promise<ManifestEntry[]> {
  if (deps.admin === undefined || rolledOff.length === 0) return rolledOff;
  /**
   * 一轮最多删 `maxDeletes` 条，**删掉的是最旧的那几条**（`rolledOff` 是账本尾部、
   * 账本新在前，所以最旧的在数组末尾 ⇒ `slice(length - maxDeletes)` 取到的就是最旧的一批）。
   * 靠近窗口的那几条留到下一轮 —— 它们本来就是"最晚变成垃圾"的，先还这一头没人看得出来。
   *
   * 交回调用方的那一份保持**从新到旧**：先是没有轮到的（`deferred`，天然在 doomed 之前），
   * 再是这一批里没删成的。账本靠位置切窗口（`kept = ledger.slice(0, limit)`），
   * 所以这个顺序不能乱 —— 一旦乱成"新的排在后面"，下一轮被裁掉的会是**较新的那一版**。
   */
  const doomed = rolledOff.slice(Math.max(0, rolledOff.length - maxDeletes));
  const deferred = rolledOff.slice(0, Math.max(0, rolledOff.length - maxDeletes));
  const survivors: ManifestEntry[] = [...deferred];
  for (const entry of doomed) {
    try {
      await deps.admin.remove(snapshotUrl(base, entry.snapshotId).href, credential);
      await deps.admin.remove(manifestUrl(base, entry.revision).href, credential);
    } catch {
      survivors.push(entry);
    }
  }
  return survivors;
}

/** 供 background 用：本地数据变了就先只标脏，不做任何网络动作。 */
export async function markDirty(deps: SyncDeps, at: number = now()): Promise<void> {
  const config = await deps.storage.getWebDavConfig();
  if (!config.enabled) return;
  const meta = await deps.storage.getSyncMeta();
  await deps.storage.setSyncMeta({ ...meta, status: 'pending', dirtySinceAt: meta.dirtySinceAt ?? at });
}

/**
 * 用户从历史快照里挑一版恢复（§19「恢复历史版本 ⇒ 新建本地 revision，不删除旧 snapshot」）。
 *
 * 它是一次**本地写入**然后正常同步出去，不是"把远端那个文件指回最新"。
 * 差别很重要：后者会让中间那几百个快照变成孤儿，而用户想撤回恢复前的状态时就没处可撤了。
 *
 * ★ 落盘的是 `planRestore` 算出来的那一版**加了两件事**的样子：
 * 带回来的每条把 `updatedAt` 抬到 `at`、现在多出来的每条留下墓碑。
 * 直接把快照的 `state` 写下去是不够的 —— 那是这个按钮原来"闪一下又被冲回 35 条"的原因：
 * 下一轮实体级 LWW 一看那一版每条都比现在旧，就把远端那版原样并回来了。
 * 返回的四个数给界面，恢复完之后如实说一句"带回来几条、换掉几条"。
 */
export async function restoreFromSnapshot(
  deps: SyncDeps,
  snapshot: SyncSnapshot,
  at: number = now(),
): Promise<RestorePlanCounts> {
  const current = await readStoredState(deps);
  const deviceId = await deps.storage.getDeviceId();
  const plan = planRestore({ current, restored: snapshot.state, deviceId, at });
  await applyMergedState(deps, plan.state);
  await captureDurableSnapshot(deps, at);
  await markDirty(deps, at);
  return plan.counts;
}

export type { Tombstone };
