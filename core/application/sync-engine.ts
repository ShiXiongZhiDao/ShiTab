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
import type { WebDavPort, WebDavCredential, WebDavErrorKind } from '@/core/ports/webdav';
import { WebDavError } from '@/core/ports/webdav';
import type { StoredConflict, StoredState, SyncManifest, SyncSnapshot, SyncStatus, SyncTriggerReason, Tombstone } from '@/shared/types';
import { claimIsLive, decideSync, SYNC_CLAIM_TTL_MS, type SyncSkipCause } from '@/core/domain/sync-scheduler';
import { manifestUrl, parseBaseUrl, snapshotIdFor, snapshotUrl, snapshotsDirUrl, manifestsDirUrl, revisionFromUrl, snapshotIdFromUrl } from '@/core/domain/remote-layout';
import { buildSyncSnapshot, buildManifest, stateChecksumOf, verifyManifest, verifySyncSnapshot } from '@/core/domain/sync-data';
import { assessSyncSafety, type SuspiciousCounts, type SuspiciousRule } from '@/core/domain/safety';
import { mergeStates, type DeleteVsEditConflict } from '@/core/domain/merge';
import { captureDurableSnapshot, readStoredState } from '@/core/application/durable-snapshot';
import { softDeleteGroup } from '@/core/application/delete-model';
import { now } from '@/shared/utils';

export interface SyncDeps {
  storage: StoragePort;
  webdav: WebDavPort;
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
async function readRemoteView(deps: SyncDeps, base: URL, credential: WebDavCredential): Promise<RemoteView> {
  const manifestUrlList = await deps.webdav.propfind(manifestsDirUrl(base).href, credential, 1).catch(() => []);
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
      parsed = JSON.parse(text);
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
  const list = await deps.webdav.propfind(manifestsDirUrl(base).href, credential, 1).catch(() => []);
  const candidates = list
    .filter((entry) => entry.exists && revisionFromUrl(entry.url) !== null)
    .sort((a, b) => (revisionFromUrl(b.url) ?? 0) - (revisionFromUrl(a.url) ?? 0));

  for (const candidate of candidates) {
    const text = await deps.webdav.get(candidate.url, credential).catch(() => undefined);
    if (text === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
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
    parsed = JSON.parse(text);
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
  const config = await storage.getWebDavConfig();
  if (!config.enabled) {
    await storage.setSyncMeta({ ...(await storage.getSyncMeta()), status: 'disabled' });
    return { status: 'disabled', skip: 'disabled' };
  }

  const parsed = parseBaseUrl(config.baseUrl);
  if (!parsed.ok) {
    return { status: 'error', skip: 'bad-base-url', error: { kind: 'unknown', message: `WebDAV 地址无效：${parsed.reason}` } };
  }
  const base = parsed.url;

  const stored = await storage.getSyncCredential();
  if (!stored) {
    return { status: 'error', skip: 'no-credential', error: { kind: 'credentials', message: '没有保存的密码' } };
  }
  const credential: WebDavCredential = { username: config.username, password: stored.password };

  const meta = await storage.getSyncMeta();
  if (meta.nextAttemptAt !== undefined && at < meta.nextAttemptAt) {
    return { status: meta.status === 'idle' ? 'pending' : meta.status, skip: 'backoff' };
  }

  const local = await readStoredState(deps);
  const inspected = inspectLocalState(local);
  if (!inspected.ok) {
    // 规则 C/D：禁止同步，且**不改动本地任何东西**。这里没有可确认的东西 ——
    // 让用户点"保留本地"等于把一坨解析不了的数据当真本。
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
      return { status: 'idle', skip: 'no-changes' };
    }
  }

  const remote = await readRemoteView(deps, base, credential);
  const remoteState = remote.snapshot?.state;

  const deviceId = await storage.getDeviceId();
  let remoteMerged: StoredState | undefined;
  let conflicts: DeleteVsEditConflict[] = [];
  let pulledRevision: number | undefined;

  if (remote.snapshot && remote.snapshot.stateChecksum !== localChecksum) {
    // 两边内容不同 ⇒ 先合并再推。直接推会把远端那一版的改动盖掉（§10「不静默覆盖」）。
    const merged = mergeStates({ local, remote: remote.snapshot.state });
    conflicts = merged.conflicts;
    await applyMergedState(deps, merged.state);
    remoteMerged = merged.state;
    pulledRevision = remote.snapshot.revision;
    if (conflicts.length > 0) {
      // 有实体级撞车就**不推**：合并结果里还带着没定案的东西，推上去等于替用户做了决定。
      // 冲突必须落盘再返回：跑这次同步的是 background，看冲突的是某个页面上的对话框。
      // 只放在返回值里，用户一切页面冲突就没人知道了，而同步会一直静默停在 conflict。
      await storage.setSyncMeta({
        ...meta,
        status: 'conflict',
        remoteRevision: remote.snapshot.revision,
        // 这一版确实读到过 ⇒ 下一轮的"跳过下载"认这个文件名
        lastSeenSnapshotId: remote.snapshot.snapshotId,
        lastTrigger: trigger,
        pendingConflicts: conflicts.map((conflict) => ({
          groupId: conflict.groupId,
          deletedAt: conflict.deletedAt,
          editedAt: conflict.editedAt,
          deletedByDeviceId: conflict.deletedByDeviceId,
          deleteReason: conflict.deleteReason,
        })),
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
    await storage.setSyncMeta({ ...meta, status: 'error', lastError: { kind: 'invalid-local-state', message: verdict.reason, at } });
    return { status: 'error', blocked: { reason: verdict.reason } };
  }
  if (!verdict.ok) {
    await storage.setSyncMeta({ ...meta, status: 'suspicious_change', lastTrigger: trigger });
    return {
      status: 'suspicious_change',
      suspicious: { rules: verdict.rules, counts: verdict.counts },
      ...(pulledRevision === undefined ? {} : { pulled: { revision: pulledRevision, conflicts } }),
    };
  }

  // 先把这一版落成耐久快照再推：推的东西在本地没有可恢复的副本，是 §20 明令防的事
  const captured = await captureDurableSnapshot(deps, at);
  if (!captured.ok) {
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

  try {
    await deps.webdav.ensureCollection(snapshotsDirUrl(base).href, credential);
    await deps.webdav.ensureCollection(manifestsDirUrl(base).href, credential);
    try {
      // If-None-Match: * —— 撞上了就是"这一份内容已经在远端了"
      await deps.webdav.put(snapshotUrl(base, snapshotId).href, JSON.stringify(snapshot), credential, { ifNoneMatch: '*' });
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

    const history = [
      { snapshotId, revision, deviceId, createdAt: at, stateChecksum: snapshot.stateChecksum },
      ...(remote.manifest?.history ?? []),
    ].slice(0, 200);
    const deviceIds = [...new Set([...(remote.manifest?.deviceIds ?? []), deviceId])].sort();
    const manifest = buildManifest({
      latestRevision: revision,
      latestSnapshotId: snapshotId,
      updatedAt: at,
      deviceIds,
      history,
    });
    await deps.webdav.put(manifestUrl(base, revision).href, JSON.stringify(manifest), credential);
  } catch (error) {
    const kind = error instanceof WebDavError ? error.kind : 'unknown';
    const message = error instanceof Error ? error.message : String(error);
    const failures = meta.consecutiveFailures + 1;
    await storage.setSyncMeta({
      ...meta,
      status: 'error',
      consecutiveFailures: failures,
      nextAttemptAt: at + backoffDelayMs(failures),
      lastError: { kind, message, at },
      dirtySinceAt: meta.dirtySinceAt ?? at,
    });
    // 本地数据一条都不改。§19「WebDAV 401 只报错，不改本地数据」是这一行的返回值决定的。
    return { status: 'error', error: { kind, message } };
  }

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
 */
export async function restoreFromSnapshot(deps: SyncDeps, snapshot: SyncSnapshot, at: number = now()): Promise<void> {
  await applyMergedState(deps, snapshot.state);
  await captureDurableSnapshot(deps, at);
  await markDirty(deps, at);
}

export type { Tombstone };
