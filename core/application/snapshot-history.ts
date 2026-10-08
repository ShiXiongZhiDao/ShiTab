/**
 * 远端历史的查看、恢复与清理（既有约定 决定 4，WebDAV-SYNC.md §18）。
 *
 * 三条前置都写在代码里，因为它们的失败模式都是"用户的数据没了"：
 *
 * 1. **默认永不删**。§18 的原话是"绝不因为普通同步或普通删除自动清理历史"。
 *    所以 `pruneRemoteHistory` 需要一个显式的 `confirmed: true`，而且清理能力
 *    来自 `WebDavAdminPort` —— 同步引擎的类型里根本没有 `remove`，写不出自动清理这段代码。
 * 2. **清理之前先落一份当前可恢复的本地快照**（§18 的前置流程图）。
 *    少了这一步，"删掉旧版本"和"当前这版在本地也只存在于待翻的指针里"就是同一件事。
 * 3. **manifest 指向的那一版永远不删**。它是远端的当前真相，删了之后所有设备都要走重建路径。
 */

import type { StoragePort } from '@/core/ports/storage';
import type { RemoteResourceMeta, WebDavAdminPort, WebDavCredential, WebDavPort } from '@/core/ports/webdav';
import { WebDavError } from '@/core/ports/webdav';
import type { ManifestEntry, SyncManifest, SyncSnapshot } from '@/shared/types';
import {
  manifestsDirUrl,
  parseBaseUrl,
  revisionFromUrl,
  snapshotUrl,
  snapshotsDirUrl,
  listingIsTrusted,
} from '@/core/domain/remote-layout';
import { decodeWire, verifyManifest, verifySyncSnapshot } from '@/core/domain/sync-data';
import { nameOfDevice } from '@/core/domain/device-profile';
import { captureDurableSnapshot, readStoredState } from '@/core/application/durable-snapshot';
import { planRestore, type RestorePlanCounts } from '@/core/domain/restore-as-revert';
import { fetchManifest, readPointer, restoreFromSnapshot } from '@/core/application/sync-engine';

export interface HistoryDeps {
  storage: StoragePort;
  webdav: WebDavPort;
}

export interface PruneDeps extends HistoryDeps {
  /** 故意单列：能从外部传进来的只有拿着管理接口的那一层。 */
  admin: WebDavAdminPort;
}

export type HistoryFailure =
  | 'disabled'
  | 'bad-base-url'
  | 'no-credential'
  | 'no-manifest'
  /**
   * **问不通**这台服务器（网络断了、超时、401、5xx、列举被截断到不可信）。
   * 与 `no-manifest` 是两件不同的事，对用户说的也不同：后者是"还没有可恢复的历史"（正常状态），
   * 前者是"现在不知道" —— 把不知道报成没有，用户会以为自己的历史没了。
   */
  | 'unreachable'
  | 'not-confirmed'
  | 'durable-snapshot-failed'
  | 'nothing-to-prune';

export interface RemoteHistoryEntry extends ManifestEntry {
  url: string;
  /**
   * 服务器给的字节数。来路是**那一次** `snapshots/` 目录列举（见 `sizesFromListing`），
   * 不再是逐条 HEAD。列举问不通、或这一版在清单里没给 `getcontentlength` ⇒ **缺席**，
   * 界面印 `—`。刻意不把"不知道"折成 0：HEAD 那一支就是这么骗过用户的
   * （`Content-Length` 描述的是空的响应体，坚果云类主机如实回 0 ⇒ 屏幕上六行 `0 B`，
   * 而他那 13 个快照文件最小的一个也有 325 B）。
   */
  bytes?: number;
  /**
   * 推送这一版的设备**名**。唯一来路是 manifest 的 `devices` 表 ——
   * 那张表已在"读哪一版是最新的"那一次 GET 里带回来了，所以这一格**不多打一次请求**。
   *
   * 解析不到就是**缺席**，这里不冒充一个名字：名字是用户自己起的
   * （`sync-engine.ts` 的 `resolveDeviceName` 同一口径），回退 `deviceId` 前 8 位那一支在界面。
   */
  deviceName?: string;
  /** manifest 当前指向的那一版。清理时它是硬保护对象。 */
  isLatest: boolean;
}

async function credentialOf(storage: StoragePort): Promise<WebDavCredential | undefined> {
  const config = await storage.getWebDavConfig();
  if (!config.enabled) return undefined;
  const stored = await storage.getSyncCredential();
  if (!stored) return undefined;
  return { username: config.username, password: stored.password };
}

/**
 * 读远端的当前 manifest。返回的是**两件事**，不是一件事：
 * 有 / 没有（`manifest`），以及**这台服务器问不问得通**（`unreachable`）。
 *
 * 原来这里两处都把故障咽成"没有"：`propfind(...).catch(() => [])` 把断网、超时（既有约定
 * 之后超时是新加的一档，而且比 404 更常见）、401、5xx 全折成空清单，而我上一轮加的
 * `!listingIsTrusted` 又直接 `return undefined` ⇒ 半份清单也说成"远端还没有历史"。
 * 对用户那是多一句谎：他会以为自己攒的历史没了，而真因只是这一刻连不上。
 */
async function newestRemoteManifest(
  deps: HistoryDeps,
  base: URL,
  credential: WebDavCredential,
): Promise<{ manifest?: SyncManifest; unreachable: boolean }> {
  /**
   * ★ 先读指针，与同步引擎走**同一份** `readPointer` / `fetchManifest`：
   * 两边对"最新是哪一版"的理解一旦分叉，表现就是"面板列出的最新版比同步实际用的那版新（或旧）"，
   * 而用户只能靠猜。
   */
  const pointer = await readPointer(deps, base, credential);
  if (pointer) {
    const held = await fetchManifest(deps, base, pointer.revision, credential);
    if (held) return { manifest: held, unreachable: false };
    // 指针在、那一版读不出来 ⇒ 退回扫目录再定，由列那一次来回答"是没有还是问不通"
  }

  let listing;
  try {
    listing = await deps.webdav.propfind(manifestsDirUrl(base).href, credential, 1);
  } catch (error) {
    /**
     * 目录还没建 = 真的还没有历史。坚果云对新目录回 409（AncestorsNotFound，有用例钉着），
     * 标准服务器回 404 —— 两种都算"没有"。除此之外一律是**问不通**：网络、超时、401、403、5xx。
     */
    const absent = error instanceof WebDavError
      && (error.kind === 'not-found' || error.kind === 'parent-conflict');
    return { unreachable: !absent };
  }
  // 拿满单次列举上限 ⇒ 半份清单，说"不知道"，不说"没有"
  if (!listingIsTrusted(listing)) return { unreachable: true };

  const candidates = listing
    .filter((entry) => entry.exists && revisionFromUrl(entry.url) !== null)
    .sort((a, b) => (revisionFromUrl(b.url) ?? 0) - (revisionFromUrl(a.url) ?? 0));
  for (const candidate of candidates) {
    const text = await deps.webdav.get(candidate.url, credential).catch(() => undefined);
    if (text === undefined) continue;
    try {
      const verified = verifyManifest(await decodeWire(text));
      if (verified.ok) return { manifest: verified.manifest, unreachable: false };
    } catch {
      continue; // 半截的 manifest：试更旧的那一份
    }
  }
  // 问得通、目录里也确实没有能用的那一版
  return { unreachable: false };
}

/**
 * 列举条目 ↔ manifest 条目之间的匹配键：文件名里那 32 位十六进制（内容寻址的 snapshotId，
 * 既有约定 决定 3）。
 *
 * 为什么**按文件名**而不是整串 URL 比：坚果云回给它的 href 不带扩展名、且大小写与写进去的
 * 那份不完全一致（`test/webdav-real-shape.spec.ts` 里那份真 207 正文就是 `…/snapshots/<32 位>`）。
 * 逐字比 URL 的后果不是报错，是"这一版没报大小" ⇒ 满屏 `—`，比 `0 B` 更难查。
 * 认不出十六进制就退回末段原名（目录里可能有用户自己的文件，那条本来也不该匹配上）。
 */
function snapshotKeyOf(url: string): string {
  let tail = url.replace(/\/+$/, '').split('/').pop() ?? '';
  try {
    tail = decodeURIComponent(tail);
  } catch {
    // 裸 `%` 这类非法编码：原样用，不因此丢掉整条记录（与 `http-webdav.ts` 的 `resolveHref` 同一口径）
  }
  const matched = /([0-9a-f]{32})/i.exec(tail);
  return (matched?.[1] ?? tail).toLowerCase();
}

/**
 * 一次 `PROPFIND snapshots/ (Depth 1)` → `匹配键 → 字节数`。
 *
 * 换掉逐条 `HEAD` 有**两处**理由，缺一条都不该改回去：
 *
 * 1. **正确性**。HEAD 响应的 `Content-Length` 描述的是**那一次响应的正文**，而 HEAD 的正文是空的；
 *    坚果云这类主机如实回 `Content-Length: 0`，`http-webdav.ts` 的 `parseLength('0')` 又把它当
 *    合法值（那个函数只拦非数字与负数，见其第 198–202 行），于是 `bytes = 0` 流到界面上变成 `0 B`。
 *    `PROPFIND` 的 `<d:getcontentlength>` 说的才是**资源本身**的字节数，Depth:1 列子项时填得对。
 * 2. **配额**。坚果云免费账号限 **600 请求 / 30 分钟**：十二版历史 = 十二次 HEAD，
 *    光"看一眼远端有多大"就吃掉十三格；现在是一次列举。
 *
 * 问不出来的那一格**留空**（缺席）：目录自己那条 `getcontentlength` 就是 0（夹具里那三个 0），
 * 而一份快照无论如何带得下 format/version/checksum（真机最小的一份 325 B）——
 * 所以**文件**条目上的 0 只会是"这台主机没报"的另一种写法，不是大小。
 */
function sizesFromListing(listing: RemoteResourceMeta[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const meta of listing) {
    if (!meta.exists || meta.isDirectory) continue;
    const bytes = meta.contentLength;
    if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) continue;
    const key = snapshotKeyOf(meta.url);
    if (key !== '') sizes.set(key, bytes);
  }
  return sizes;
}

/**
 * 这次列举**看见了**哪些快照文件（与 `sizesFromListing` 同一次请求，不多打一次）。
 *
 * 返回 `undefined` = "这次列举不能当证据"，三种情况各有一条用例钉着：
 * - 拿满 750 条（可能被分页截断，后面还有我们没看见的）；
 * - 一个文件条目都没有（真坚果云对还没建好的目录回 200 + 只有目录自己，
 *   把它读成"全被删了"就是拿一次抽风抹掉用户的整份历史）；
 * - 整个请求抛错 —— 那一支在调用方，压根不会走到这里。
 *
 * 注意这里收的是**所有**文件条目，不看 `contentLength`：
 * 大小问不出的文件仍然存在（那正是 `bytes === undefined` 那一格），
 * 只有"缺席"才是"这一版没了"的证据。
 */
function presentFromListing(listing: RemoteResourceMeta[]): Set<string> | undefined {
  if (!listingIsTrusted(listing)) return undefined;
  const present = new Set<string>();
  for (const meta of listing) {
    if (!meta.exists || meta.isDirectory) continue;
    const key = snapshotKeyOf(meta.url);
    if (key !== '') present.add(key);
  }
  return present.size > 0 ? present : undefined;
}

/**
 * 列出远端历史。
 *
 * 体量来自 `snapshots/` 的**那一次**目录列举，不是把正文下载下来数长度，也不是一 entry 一次 HEAD
 * （两条理由都在 `sizesFromListing` 的 docblock 里：一是 `0 B` 那个假数，二是 600 请求 / 30 分钟）。
 */
export async function listRemoteHistory(deps: HistoryDeps): Promise<
  | { ok: true; entries: RemoteHistoryEntry[]; totalBytes: number; unknownSizes: number }
  | { ok: false; reason: HistoryFailure }
> {
  const config = await deps.storage.getWebDavConfig();
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  const parsed = parseBaseUrl(config.baseUrl);
  if (!parsed.ok) return { ok: false, reason: 'bad-base-url' };
  const credential = await credentialOf(deps.storage);
  if (!credential) return { ok: false, reason: 'no-credential' };

  const lookup = await newestRemoteManifest(deps, parsed.url, credential);
  if (lookup.unreachable) return { ok: false, reason: 'unreachable' };
  if (!lookup.manifest) return { ok: false, reason: 'no-manifest' };
  const manifest = lookup.manifest;

  /**
   * ★ 一次 `snapshots/` 列举同时回答**两个**问题：每版多大、以及**这一版还在不在**。
   *
   * 第二个问题是真机报回来的：清理删完文件之后清单仍然列着 34 版，
   * 而那 4 版显示"服务器没报大小"—— 那不是"没报"，是**文件已经没了**，
   * 列举里自然没有它的 `getcontentlength`。清单读的是 manifest 的 `history` 账本，
   * 而账本不回写 ⇒ 那一行还挂着「恢复这一版」，点下去必然失败。
   *
   * 判据放在**读侧**而不是让清理去改账本，有两个理由：
   * 1. 同一句"以服务器为准"顺带治好了另一条来路 —— 用户直接在坚果云网页里删文件，
   *    我们的账本同样会指着空气（清理改不了那种情况）。
   * 2. 账本是不可变历史的一部分；为一个读数去重写它，代价与风险都不对。
   *
   * ⚠ 只有"真的看见了整个目录"才准据此删条目。三种情况一律当**问不出来**（`present` 留 `undefined`）：
   * 列举抛错、拿满 750 条被截断（`listingIsTrusted`）、以及**一个文件条目都没列出来**。
   * 最后那一条不是洁癖：坚果云对还没建好的目录会回一个只有目录自己的 200 ——
   * 把它读成"这些版本都被删了"，就是拿一次服务器抽风把用户的整份历史抹掉。
   */
  let sizes = new Map<string, number>();
  let present: Set<string> | undefined;
  try {
    const listing = await deps.webdav.propfind(snapshotsDirUrl(parsed.url).href, credential, 1);
    sizes = sizesFromListing(listing);
    present = presentFromListing(listing);
  } catch {
    // 问不出大小 ≠ 没有历史：条目已经从 manifest 读到了，大小只是读数。
    // 把这一格折成"整张历史读不了"，用户连"回到哪一版"都挑不了；
    // 而全部缺席会被下面的 `unknownSizes` 如实报出去（界面说"至少共"）。
  }

  const entries: RemoteHistoryEntry[] = [];
  let totalBytes = 0;
  let unknownSizes = 0;
  for (const item of manifest.history) {
    const key = snapshotKeyOf(item.snapshotId);
    if (present && !present.has(key)) continue; // 账上还记着，文件已经不在了
    const url = snapshotUrl(parsed.url, item.snapshotId).href;
    const bytes = sizes.get(key);
    const deviceName = nameOfDevice(manifest.devices, item.deviceId);
    if (bytes === undefined) unknownSizes += 1;
    else totalBytes += bytes;
    entries.push({
      ...item,
      url,
      isLatest: item.snapshotId === manifest.latestSnapshotId,
      ...(bytes === undefined ? {} : { bytes }),
      ...(deviceName === undefined ? {} : { deviceName }),
    });
  }
  // 最新的排前面：这个列表是给人挑"回到哪一版"的，不是账本
  entries.sort((a, b) => b.revision - a.revision);
  return { ok: true, entries, totalBytes, unknownSizes };
}

/**
 * 下载并验真远端某一版快照。恢复与预览**共用这一份**判据（两处各写一遍，
 * 迟早有一处会忘记验 checksum，而"预览说换 19 条、按下去恢复了一坨自相矛盾的数据"就是它的后果）。
 *
 * checksum 对不上就拒绝：远端文件可能被别的工具动过，
 * 而"恢复出一坨坏数据"比"这一版恢复不了"危险得多。
 */
async function loadVerifiedSnapshot(
  deps: HistoryDeps,
  snapshotId: string,
): Promise<{ ok: true; snapshot: SyncSnapshot } | { ok: false; reason: HistoryFailure | 'not-found' | 'corrupt' }> {
  const config = await deps.storage.getWebDavConfig();
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  const parsed = parseBaseUrl(config.baseUrl);
  if (!parsed.ok) return { ok: false, reason: 'bad-base-url' };
  const credential = await credentialOf(deps.storage);
  if (!credential) return { ok: false, reason: 'no-credential' };

  const text = await deps.webdav.get(snapshotUrl(parsed.url, snapshotId).href, credential).catch(() => undefined);
  if (text === undefined) return { ok: false, reason: 'not-found' };
  let parsedBody: unknown;
  try {
    parsedBody = await decodeWire(text);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const verified = await verifySyncSnapshot(parsedBody);
  return verified.ok ? { ok: true, snapshot: verified.snapshot } : { ok: false, reason: 'corrupt' };
}

/**
 * 把远端某一版恢复到本机。
 *
 * 它是一次**本地写入**，然后由正常同步把结果推成新的一版；
 * 不是"把 manifest 指针往回挪" —— 后者会让中间那几百版变成孤儿，
 * 用户想撤回这次恢复时就没处可撤了（§19 最后一行）。
 *
 * ★ 落下去的不是那一版的原文，而是 `planRestore` 加工过的那一版：
 * 抬时间戳 + 给"现在多出来的"补墓碑。少了这两件事，下一轮 LWW 会把它原样冲掉 ——
 * 那正是真机上"35 → 16 → 35、远端什么都没推"的成因。
 */
export async function restoreRemoteSnapshot(
  deps: HistoryDeps,
  snapshotId: string,
  at: number = Date.now(),
): Promise<{ ok: true; counts: RestorePlanCounts } | { ok: false; reason: HistoryFailure | 'not-found' | 'corrupt' }> {
  const loaded = await loadVerifiedSnapshot(deps, snapshotId);
  if (!loaded.ok) return loaded;
  const counts = await restoreFromSnapshot(deps, loaded.snapshot, at);
  return { ok: true, counts };
}

/**
 * 恢复**之前**先把后果算给他看（既有约定 的确认面）。
 *
 * 它做真实的那一次 GET：不下载那一版就没法知道它会带回来几条、换掉几条。
 * 一次点击两个请求（这里一个、确认之后恢复又一个）是可以的 —— 恢复是他主动点的低频动作，
 * 而"预览用缓存、应用用服务器"会带来另一种坏形状：屏幕上说换掉 19 条，
 * 真按下去换掉 22 条。宁可重、不要骗。
 */
export async function previewRestore(
  deps: HistoryDeps,
  snapshotId: string,
): Promise<
  | { ok: true; counts: RestorePlanCounts }
  | { ok: false; reason: HistoryFailure | 'not-found' | 'corrupt' }
> {
  const loaded = await loadVerifiedSnapshot(deps, snapshotId);
  if (!loaded.ok) return loaded;
  const current = await readStoredState(deps);
  const deviceId = await deps.storage.getDeviceId();
  return { ok: true, counts: planRestore({ current, restored: loaded.snapshot.state, deviceId, at: Date.now() }).counts };
}

/**
 * 清理远端历史：只留最新的 `keep` 版。
 *
 * 顺序不可调换：①确认 → ②先落本地耐久快照 → ③再删远端。
 * 任何一步不满足就一个字节都不删。
 */
export async function pruneRemoteHistory(
  deps: PruneDeps,
  input: { keep: number; confirmed: boolean },
  at: number = Date.now(),
): Promise<
  | { ok: true; deleted: number; kept: number; freedBytes: number }
  | { ok: false; reason: HistoryFailure }
> {
  const listed = await listRemoteHistory(deps);
  if (!listed.ok) return listed;
  if (input.confirmed !== true) return { ok: false, reason: 'not-confirmed' };

  const keep = Math.max(1, Math.floor(input.keep));
  const sorted = [...listed.entries].sort((a, b) => b.revision - a.revision);
  // 硬保护：manifest 指向的那一版必须在保留集合里，哪怕它按 revision 排在 keep 之外
  const survivors = sorted.slice(0, keep);
  const latest = sorted.find((entry) => entry.isLatest);
  if (latest && !survivors.some((entry) => entry.snapshotId === latest.snapshotId)) survivors.push(latest);
  const doomed = sorted.filter((entry) => !survivors.some((kept) => kept.snapshotId === entry.snapshotId));
  if (doomed.length === 0) return { ok: false, reason: 'nothing-to-prune' };

  const config = await deps.storage.getWebDavConfig();
  const parsed = parseBaseUrl(config.baseUrl);
  if (!parsed.ok) return { ok: false, reason: 'bad-base-url' };
  const credential = await credentialOf(deps.storage);
  if (!credential) return { ok: false, reason: 'no-credential' };

  // §18 的前置动作：先把当前状态落成一份可恢复的耐久快照，再谈删远端
  const captured = await captureDurableSnapshot(deps, at);
  if (!captured.ok) return { ok: false, reason: 'durable-snapshot-failed' };

  let freedBytes = 0;
  for (const entry of doomed) {
    await deps.admin.remove(entry.url, credential);
    // 同一口径：大小问不出的那一版按 0 记 ⇒ `freedBytes` 是**省下的量的下限**，不是精确值。
    // 界面上清理那一行只报条数（`history_prune_done`），所以今天它没有骗人的出口；
    // 但谁将来把这个数印上去，必须连 `unknownSizes` 一起带出去 —— 单独印出来就是一句"省了多少"的假数。
    freedBytes += entry.bytes ?? 0;
  }
  return { ok: true, deleted: doomed.length, kept: survivors.length, freedBytes };
}
