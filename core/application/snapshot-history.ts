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
import type { WebDavAdminPort, WebDavCredential, WebDavPort } from '@/core/ports/webdav';
import type { ManifestEntry, SyncManifest } from '@/shared/types';
import { manifestsDirUrl, parseBaseUrl, revisionFromUrl, snapshotUrl } from '@/core/domain/remote-layout';
import { verifyManifest, verifySyncSnapshot } from '@/core/domain/sync-data';
import { captureDurableSnapshot } from '@/core/application/durable-snapshot';
import { restoreFromSnapshot } from '@/core/application/sync-engine';

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
  | 'not-confirmed'
  | 'durable-snapshot-failed'
  | 'nothing-to-prune';

export interface RemoteHistoryEntry extends ManifestEntry {
  url: string;
  /** 服务器给的字节数；HEAD 失败或主机不给就是缺失，不猜。 */
  bytes?: number;
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

/** 读远端的当前 manifest。读不到就是 `no-manifest` —— 那不等于"远端是空的"。 */
async function newestRemoteManifest(deps: HistoryDeps, base: URL, credential: WebDavCredential): Promise<SyncManifest | undefined> {
  const listing = await deps.webdav.propfind(manifestsDirUrl(base).href, credential, 1).catch(() => []);
  const candidates = listing
    .filter((entry) => entry.exists && revisionFromUrl(entry.url) !== null)
    .sort((a, b) => (revisionFromUrl(b.url) ?? 0) - (revisionFromUrl(a.url) ?? 0));
  for (const candidate of candidates) {
    const text = await deps.webdav.get(candidate.url, credential).catch(() => undefined);
    if (text === undefined) continue;
    try {
      const verified = verifyManifest(JSON.parse(text));
      if (verified.ok) return verified.manifest;
    } catch {
      continue; // 半截的 manifest：试更旧的那一份
    }
  }
  return undefined;
}

/**
 * 列出远端历史。
 *
 * 体量是一 entry 一次 HEAD 问出来的，不是把正文下载下来数长度 ——
 * 攒到几百个快照时后者会把"看一眼远端有多大"变成几百次全量下载。
 */
export async function listRemoteHistory(deps: HistoryDeps): Promise<
  { ok: true; entries: RemoteHistoryEntry[]; totalBytes: number } | { ok: false; reason: HistoryFailure }
> {
  const config = await deps.storage.getWebDavConfig();
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  const parsed = parseBaseUrl(config.baseUrl);
  if (!parsed.ok) return { ok: false, reason: 'bad-base-url' };
  const credential = await credentialOf(deps.storage);
  if (!credential) return { ok: false, reason: 'no-credential' };

  const manifest = await newestRemoteManifest(deps, parsed.url, credential);
  if (!manifest) return { ok: false, reason: 'no-manifest' };

  const entries: RemoteHistoryEntry[] = [];
  let totalBytes = 0;
  for (const item of manifest.history) {
    const url = snapshotUrl(parsed.url, item.snapshotId).href;
    const meta = await deps.webdav.head(url, credential).catch(() => undefined);
    const bytes = meta?.contentLength;
    if (bytes !== undefined) totalBytes += bytes;
    entries.push({ ...item, url, isLatest: item.snapshotId === manifest.latestSnapshotId, ...(bytes === undefined ? {} : { bytes }) });
  }
  // 最新的排前面：这个列表是给人挑"回到哪一版"的，不是账本
  entries.sort((a, b) => b.revision - a.revision);
  return { ok: true, entries, totalBytes };
}

/**
 * 把远端某一版恢复到本机。
 *
 * 它是一次**本地写入**，然后由正常同步把结果推成新的一版；
 * 不是"把 manifest 指针往回挪" —— 后者会让中间那几百版变成孤儿，
 * 用户想撤回这次恢复时就没处可撤了（§19 最后一行）。
 */
export async function restoreRemoteSnapshot(
  deps: HistoryDeps,
  snapshotId: string,
  at: number = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: HistoryFailure | 'not-found' | 'corrupt' }> {
  const config = await deps.storage.getWebDavConfig();
  if (!config.enabled) return { ok: false, reason: 'disabled' };
  const parsed = parseBaseUrl(config.baseUrl);
  if (!parsed.ok) return { ok: false, reason: 'bad-base-url' };
  const credential = await credentialOf(deps.storage);
  if (!credential) return { ok: false, reason: 'no-credential' };

  const url = snapshotUrl(parsed.url, snapshotId);
  const text = await deps.webdav.get(url.href, credential).catch(() => undefined);
  if (text === undefined) return { ok: false, reason: 'not-found' };
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  const verified = await verifySyncSnapshot(parsedBody);
  // checksum 对不上就拒绝恢复：远端文件可能被别的工具动过，
  // 而"恢复出一坨自相矛盾的数据"比"这一版恢复不了"危险得多
  if (!verified.ok) return { ok: false, reason: 'corrupt' };

  await restoreFromSnapshot(deps, verified.snapshot, at);
  return { ok: true };
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
    freedBytes += entry.bytes ?? 0;
  }
  return { ok: true, deleted: doomed.length, kept: survivors.length, freedBytes };
}
