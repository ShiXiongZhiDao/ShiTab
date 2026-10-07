/**
 * 远端两份载荷的盖章与验货（既有约定，WebDAV-SYNC.md §6）。
 *
 * 与 `durable-state.ts` 同一套思路，但**判据不同**：本机的槽坏了可以退回另一槽，
 * 远端的快照坏了只能跳过它、去找上一版（§19「远端历史文件损坏 ⇒ 跳过坏版本」）。
 * 所以这里的验货必须对**来路不明的 JSON** 成立，而不是只对我们自己刚写出去的对象成立。
 */

import type { ManifestEntry, StoredState, SyncManifest, SyncSnapshot } from '@/shared/types';
import { MANIFEST_FORMAT, SNAPSHOT_FORMAT } from '@/shared/constants';
import { canonicalJson, sha256Hex } from '@/core/domain/checksum';

/** `state` 的身份。与 `StateEnvelope.checksum` 同一个算法、同一份输入，所以两边算出来必须相等。 */
export async function stateChecksumOf(state: StoredState): Promise<string> {
  return sha256Hex(canonicalJson(state));
}

export interface SnapshotBuild {
  snapshotId: string;
  deviceId: string;
  revision: number;
  baseSnapshotId?: string;
  createdAt: number;
}

/** 造一份要上传的快照。`stateChecksum` 在这里算，别处不再算第二遍。 */
export async function buildSyncSnapshot(
  state: StoredState,
  build: SnapshotBuild,
): Promise<SyncSnapshot> {
  const snapshot: SyncSnapshot = {
    format: SNAPSHOT_FORMAT,
    version: 1,
    snapshotId: build.snapshotId,
    deviceId: build.deviceId,
    revision: build.revision,
    createdAt: build.createdAt,
    stateChecksum: await stateChecksumOf(state),
    state,
  };
  if (build.baseSnapshotId !== undefined) snapshot.baseSnapshotId = build.baseSnapshotId;
  return snapshot;
}

export type RemoteInvalid =
  | 'not-object'
  | 'format'
  | 'version'
  | 'shape'
  | 'checksum';

export type SnapshotVerification =
  | { ok: true; snapshot: SyncSnapshot }
  | { ok: false; reason: RemoteInvalid };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 验一份从远端读回来的快照。
 *
 * 注意 `stateChecksum` 对不上时**整份快照作废**，不是"内容照用、只是不认账"：
 * 远端文件可能被别的工具改过、可能是上一次上传写了一半、也可能用户把两个目录合并了。
 * 每一种情况下"看起来能用"的数据比"这一版读不到"危险得多。
 */
export async function verifySyncSnapshot(raw: unknown): Promise<SnapshotVerification> {
  if (!isRecord(raw)) return { ok: false, reason: 'not-object' };
  if (raw.format !== SNAPSHOT_FORMAT) return { ok: false, reason: 'format' };
  if (raw.version !== 1) return { ok: false, reason: 'version' };

  if (!nonEmptyString(raw.snapshotId)) return { ok: false, reason: 'shape' };
  if (!nonEmptyString(raw.deviceId)) return { ok: false, reason: 'shape' };
  if (!finiteNumber(raw.revision)) return { ok: false, reason: 'shape' };
  if (!finiteNumber(raw.createdAt)) return { ok: false, reason: 'shape' };
  if (!nonEmptyString(raw.stateChecksum)) return { ok: false, reason: 'shape' };
  if (!isRecord(raw.state)) return { ok: false, reason: 'shape' };

  const state = raw.state as Record<string, unknown>;
  if (!Array.isArray(state.groups) || !Array.isArray(state.categories) || !Array.isArray(state.tombstones)) {
    return { ok: false, reason: 'shape' };
  }
  // 回收站：**缺席是合法的**，那是老版本推上去的快照，不能因此整份作废；
  // 但有就必须是数组，否则后面的 `trashOf()` 会在合并里炸成 TypeError。
  if (state.trash !== undefined && !Array.isArray(state.trash)) {
    return { ok: false, reason: 'shape' };
  }

  const candidate = raw as unknown as SyncSnapshot;
  if (candidate.stateChecksum !== (await stateChecksumOf(candidate.state))) {
    return { ok: false, reason: 'checksum' };
  }
  return { ok: true, snapshot: candidate };
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

export interface ManifestBuild {
  latestRevision: number;
  latestSnapshotId: string;
  updatedAt: number;
  deviceIds: string[];
  history: ManifestEntry[];
}

export function buildManifest(build: ManifestBuild): SyncManifest {
  return {
    format: MANIFEST_FORMAT,
    version: 1,
    latestRevision: build.latestRevision,
    latestSnapshotId: build.latestSnapshotId,
    updatedAt: build.updatedAt,
    deviceIds: [...build.deviceIds].sort(),
    // 最新的排前面：读侧只关心头几条，这样"取最近 N 版"是 slice(0,N) 而不是排序。
    history: [...build.history].sort((a, b) => b.revision - a.revision),
  };
}

export type ManifestVerification =
  | { ok: true; manifest: SyncManifest }
  | { ok: false; reason: RemoteInvalid };

/**
 * manifest 的验货**不查 checksum** —— 它没有 checksum 字段，而且它本来就不是真相：
 * §5 规则 5 定的就是"manifest 丢了可以扫快照目录重建"。
 * 所以这里只保证"读进来至少是个 manifest，不会让引擎去解一个 undefined"。
 * 真正的最新在哪一版，由快照自己的 revision + checksum 说了算。
 */
export function verifyManifest(raw: unknown): ManifestVerification {
  if (!isRecord(raw)) return { ok: false, reason: 'not-object' };
  if (raw.format !== MANIFEST_FORMAT) return { ok: false, reason: 'format' };
  if (raw.version !== 1) return { ok: false, reason: 'version' };
  if (!finiteNumber(raw.latestRevision)) return { ok: false, reason: 'shape' };
  if (!nonEmptyString(raw.latestSnapshotId)) return { ok: false, reason: 'shape' };
  if (!finiteNumber(raw.updatedAt)) return { ok: false, reason: 'shape' };
  if (!Array.isArray(raw.deviceIds)) return { ok: false, reason: 'shape' };
  if (!Array.isArray(raw.history)) return { ok: false, reason: 'shape' };
  return { ok: true, manifest: raw as unknown as SyncManifest };
}

/**
 * 从目录里扫出来的一堆 manifest 里挑最高 revision 的那一个。
 * 目录里可能有用户自己的文件，认不出的一律跳过而不是报错 ——
 * 这是用户的目录，不是我们的数据库。
 */
export function newestManifest(manifests: readonly unknown[]): SyncManifest | undefined {
  let best: SyncManifest | undefined;
  for (const raw of manifests) {
    const verified = verifyManifest(raw);
    if (!verified.ok) continue;
    if (!best || verified.manifest.latestRevision > best.latestRevision) best = verified.manifest;
  }
  return best;
}
