/**
 * 远端两份载荷的盖章与验货（既有约定，WebDAV-SYNC.md §6）。
 *
 * 与 `durable-state.ts` 同一套思路，但**判据不同**：本机的槽坏了可以退回另一槽，
 * 远端的快照坏了只能跳过它、去找上一版（§19「远端历史文件损坏 ⇒ 跳过坏版本」）。
 * 所以这里的验货必须对**来路不明的 JSON** 成立，而不是只对我们自己刚写出去的对象成立。
 */

import type { DevicePointer, ManifestEntry, StoredState, SyncManifest, SyncPointer, SyncSnapshot } from '@/shared/types';
import { MANIFEST_FORMAT, POINTER_FORMAT, SNAPSHOT_FORMAT } from '@/shared/constants';
import { canonicalJson, sha256Hex } from '@/core/domain/checksum';
import { base64FromGzip, gzipToBase64 } from '@/core/domain/gzip';

/**
 * ★ 远端载荷的线上编码。
 *
 * 为什么这一层现在才出现：它从 既有约定 起就被**当作已有**了 —— 三处注释写着"载荷是
 * gzip+base64 的文本"（`http-webdav.ts` 的 put、`sync-engine.ts` 省流量那段的"压缩后
 * 0.2–0.4 MiB"、`shared/types.ts` 的 `lastSeenSnapshotId`），既有约定 否掉逐实体布局时
 * 引的那句"代价被高估约一个数量级"算的也是这一层的账。但 PUT 出去的一直是
 * `JSON.stringify(...)` 原文：10k 条那一档每推一次、每拉一次都是 **4.13 MiB**
 * （既有约定 第 11 行自己实测的 raw 数），不是 0.20 MiB —— gzip 只落在**本机**耐久双槽上
 * ，从没上过线。
 *
 * 外面套一层 JSON 信封，而不是直接往远端写一坨 base64：文件仍然是一份**合法 JSON**，
 * `Content-Type: application/json` 不说谎，主机侧的类型嗅探和"打开远端文件看一眼"都还成立，
 * 而解码靠 `encoding` 这个字段认，不靠"首字符是不是 `{`"那种字符串把戏。
 *
 * ⚠ 它**不参与** `stateChecksum`：内容寻址去重算的是 `state`，
 * 所以换编码不会让同一份内容算出两个文件名。
 */
export const WIRE_ENCODING = 'gzip+base64';

interface WireEnvelope {
  encoding: typeof WIRE_ENCODING;
  data: string;
}

/**
 * 低于这个体量就**直接写原文**，不套信封。
 *
 * 不是抠细节：gzip 对几百字节的东西几乎没收益，而 base64 固定要加 33%。
 * 一颗只存了三五个会话的载荷压完反而**变大** —— 那正是这个产品的多数用户。
 * 阈值取 32 KiB：到那个体量 gzip 对 JSON 的收益（实测 4.9%–25%）已经远远盖过 base64 的开销。
 *
 * 按 `string.length` 近似字节数，边界上偏保守（可能少压一次），但 32 KiB 上下两种写法都还小，
 * 不值得为它多分配一份 4 MiB 的 Uint8Array 只为量准。
 */
export const WIRE_COMPRESS_MIN_BYTES = 32 * 1024;

/** 载荷 → 要 PUT 上去的那段文本：小载荷写原文，大载荷写 gzip+base64 的 JSON 信封。 */
export async function encodeWire(payload: unknown): Promise<string> {
  const text = JSON.stringify(payload);
  if (text.length < WIRE_COMPRESS_MIN_BYTES) return text;
  const envelope: WireEnvelope = { encoding: WIRE_ENCODING, data: await gzipToBase64(text) };
  return JSON.stringify(envelope);
}

/**
 * 远端文本 → 载荷。
 *
 * 没有信封就当原文是 JSON 直接解。这**不是**"兼容老数据"的兼容层（开发期没有老数据，
 * 见 既有约定 的 Q8 定案），而是让手摆的远端文件、以及别的实现写出来的载荷也能被读进来 ——
 * 验货侧（`verifySyncSnapshot` / `verifyManifest`）本来就只认自己认识的那几个键、
 * 不拒未知键，这里放行同一种宽容。解不开（JSON 坏了、base64 坏了、gzip 流坏了）一律**抛**，
 * 调用方按"这一版读不通，跳过它去找更旧的"处理，不做任何猜测。
 */
export async function decodeWire(text: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed === 'object'
    && parsed !== null
    && (parsed as Partial<WireEnvelope>).encoding === WIRE_ENCODING
    && typeof (parsed as Partial<WireEnvelope>).data === 'string'
  ) {
    return JSON.parse(await base64FromGzip((parsed as WireEnvelope).data));
  }
  return parsed;
}

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
  /** 构建这一版的设备名。缺省就不写这个键 —— 可选键"缺席"与"空串"是两件事。 */
  deviceName?: string;
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
  if (build.deviceName !== undefined) snapshot.deviceName = build.deviceName;
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
  /**
   * 设备名：同上一条的口径 —— **缺席合法**（老载荷根本没有这个键），
   * 有就必须是非空字符串。空串不是"没名字"，是写坏了，留着它只会让对面显示一个空洞。
   */
  if (raw.deviceName !== undefined && !nonEmptyString(raw.deviceName)) {
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
  /** 设备表。已经由 `mergeDeviceTables` 排好序、去过重，这里不再加工。 */
  devices?: DevicePointer[];
}

export function buildManifest(build: ManifestBuild): SyncManifest {
  const manifest: SyncManifest = {
    format: MANIFEST_FORMAT,
    version: 1,
    latestRevision: build.latestRevision,
    latestSnapshotId: build.latestSnapshotId,
    updatedAt: build.updatedAt,
    deviceIds: [...build.deviceIds].sort(),
    // 最新的排前面：读侧只关心头几条，这样"取最近 N 版"是 slice(0,N) 而不是排序。
    history: [...build.history].sort((a, b) => b.revision - a.revision),
  };
  // 缺席合法（老载荷根本没有这个键），所以**没给就不写**这个键，而不是写成 `[]`：
  // "没带设备表"与"设备表是空的"在两份载荷之间应当是同一件事，都读得通。
  if (build.devices !== undefined) manifest.devices = build.devices;
  return manifest;
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
  /**
   * 设备表：**缺席合法**，有就必须每项都是 `{ id: 非空串, name: 非空串, updatedAt: 有限数 }`。
   *
   * 为什么这里要逐条查而不是"读的时候再说"：这张表是冲突面板解析人名的地方，
   * 一条半截的指针（`name` 缺）会让 `nameOfDevice` 返回 `undefined`，
   * 面板于是回退显示 UUID 前 8 位 —— 那是**看起来正常**的坏，比整份 manifest 验不过更难发现。
   * 与 `verifySyncSnapshot` 同一口径：验货对**来路不明的 JSON** 成立，不只对自己刚写出去的对象成立。
   */
  if (raw.devices !== undefined) {
    if (!Array.isArray(raw.devices)) return { ok: false, reason: 'shape' };
    for (const device of raw.devices) {
      if (!isRecord(device)) return { ok: false, reason: 'shape' };
      if (!nonEmptyString(device.id) || !nonEmptyString(device.name) || !finiteNumber(device.updatedAt)) {
        return { ok: false, reason: 'shape' };
      }
    }
  }
  return { ok: true, manifest: raw as unknown as SyncManifest };
}

/**
 * 指针文件：造与验。
 *
 * 验货口径与 `verifyManifest` 一致 —— 指针不是真相，只是"去哪儿找真相"，
 * 读不到或验不过就退回扫目录那条重建路径，不报错、不改本地任何东西。
 */
export function buildPointer(pointer: Omit<SyncPointer, 'format' | 'version'>): SyncPointer {
  return { format: POINTER_FORMAT, version: 1, ...pointer };
}

export type PointerVerification =
  | { ok: true; pointer: SyncPointer }
  | { ok: false; reason: RemoteInvalid };

export function verifyPointer(raw: unknown): PointerVerification {
  if (!isRecord(raw)) return { ok: false, reason: 'not-object' };
  if (raw.format !== POINTER_FORMAT) return { ok: false, reason: 'format' };
  if (raw.version !== 1) return { ok: false, reason: 'version' };
  if (!finiteNumber(raw.revision)) return { ok: false, reason: 'shape' };
  if (!nonEmptyString(raw.snapshotId)) return { ok: false, reason: 'shape' };
  if (!finiteNumber(raw.updatedAt)) return { ok: false, reason: 'shape' };
  return { ok: true, pointer: raw as unknown as SyncPointer };
}

/**
 * 从目录里扫出来的一堆 manifest 里挑最高 revision 的那一个。
 * 目录里可能有用户自己的文件，认不出的一律跳过而不是报错 ——
 * 那是用户的目录，不是我们的数据库。
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
