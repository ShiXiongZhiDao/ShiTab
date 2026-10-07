/**
 * 耐久快照的信封：盖章、验货、挑选（既有约定，WebDAV-SYNC.md §3）。
 *
 * 这一层**不碰 storage**，只处理"一串 base64 能不能算一份可信的状态"。
 * 写入顺序（写 inactive → 回读 → 校验 → 翻指针）在 `core/application/durable-snapshot.ts`，
 * 因为只有那边才知道"回读"要经谁。
 */

import type {
  EnvelopeVerification,
  SlotName,
  StateEnvelope,
  StoredState,
} from '@/shared/types';
import { STATE_FORMAT, STATE_SCHEMA_VERSION } from '@/shared/constants';
import { canonicalJson, checksumEquals, sha256Hex } from '@/core/domain/checksum';
import { base64FromGzip } from '@/core/domain/gzip';

/** 空状态。`isPureEmpty` 用它区分"用户真的把会话全删光了"和"存储被清空了"。 */
export function emptyState(): StoredState {
  return { groups: [], categories: [], tombstones: [], trash: [] };
}

/**
 * 盖章：算出覆盖 `payload` 的 checksum，产出信封。
 *
 * checksum **只覆盖 payload**（不含 revision / savedAt）是有意的：
 * "内容一模一样、只是又存了一次"必须能被判成没变，否则每次同步都会往远端堆一个
 * 不可变快照（那正是 既有约定 的去重要防的事）。
 */
export async function sealState(
  payload: StoredState,
  revision: number,
  savedAt: number,
): Promise<StateEnvelope> {
  return {
    format: STATE_FORMAT,
    schemaVersion: STATE_SCHEMA_VERSION,
    revision,
    savedAt,
    payload,
    checksum: await sha256Hex(canonicalJson(payload)),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 形状检查。刻意**很浅**：字段级校验（每条 tab 有没有 url）由 `checksum` 兜着 ——
 * 内容被改过一个字节，checksum 就对不上，这里再逐字段查一遍只会造成两套真相。
 *
 * 浅检查只管一件事：别让后面的 `payload.groups.length` 之类炸出 TypeError，
 * 因为"炸出 TypeError"和"这份数据无效"在日志里是两回事。
 */
function hasEnvelopeShape(candidate: Record<string, unknown>): boolean {
  if (typeof candidate.checksum !== 'string') return false;
  if (typeof candidate.revision !== 'number' || !Number.isFinite(candidate.revision)) return false;
  if (typeof candidate.savedAt !== 'number' || !Number.isFinite(candidate.savedAt)) return false;
  const payload = candidate.payload;
  if (!isPlainObject(payload)) return false;
  const record = payload as Record<string, unknown>;
  // `trash` 是后加的可选键：**缺席是合法的**，那是老版本写下的载荷。
  // 这里只保证"要是有，它得是个数组"，不逼老数据搬家（既有约定 的零迁移口径）。
  if (record.trash !== undefined && !Array.isArray(record.trash)) return false;
  return (
    Array.isArray(record.groups) &&
    Array.isArray(record.categories) &&
    Array.isArray(record.tombstones)
  );
}

/**
 * 验货：解开一串槽里的值，判定它是否可信。
 *
 * 五种"无效"各有各的成因，所以要分开报：
 * - `empty`：这一槽从没写过
 * - `unzip`：gzip 流坏了（写到一半崩溃留下的半截）
 * - `not-json`：解出来不是 JSON（同上，更少见）
 * - `shape` / `format`：是 JSON 但不是我们的信封（串了别仓库的数据、或者版本搞错）
 * - `checksum`：**内容与自述不一致** —— 这条就是 WebDAV-SYNC.md §4 那句
 *   "损坏数据永远不能成为同步源"的落点
 */
export async function verifyEnvelope(stored: unknown): Promise<EnvelopeVerification> {
  if (typeof stored !== 'string' || stored.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  let text: string;
  try {
    text = await base64FromGzip(stored);
  } catch {
    return { ok: false, reason: 'unzip' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }

  if (!isPlainObject(parsed)) return { ok: false, reason: 'shape' };
  if (parsed.format !== STATE_FORMAT) return { ok: false, reason: 'format' };
  if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) return { ok: false, reason: 'format' };
  if (!hasEnvelopeShape(parsed)) return { ok: false, reason: 'shape' };

  const candidate = parsed as unknown as StateEnvelope;
  const recomputed = await sha256Hex(canonicalJson(candidate.payload));
  if (!checksumEquals(candidate.checksum, recomputed)) {
    return { ok: false, reason: 'checksum' };
  }
  return { ok: true, envelope: candidate };
}

/**
 * 两槽都有效时取 revision 高的（WebDAV-SYNC.md §3.2 的启动恢复）。
 *
 * 同 revision 时**任取**是安全的：checksum 已经证明两份内容一模一样，
 * 选哪一槽都不影响数据，只是日志里要知道选的是哪一槽。
 */
export function pickValidSlot(
  entries: ReadonlyArray<{ slot: SlotName; result: EnvelopeVerification }>,
): { slot: SlotName; envelope: StateEnvelope } | undefined {
  let best: { slot: SlotName; envelope: StateEnvelope } | undefined;
  for (const { slot, result } of entries) {
    if (!result.ok) continue;
    if (!best || result.envelope.revision > best.envelope.revision) {
      best = { slot, envelope: result.envelope };
    }
  }
  return best;
}

/** 与当前指针相反的那一槽。写只写它，指针没翻之前它不算数。 */
export function inactiveSlot(pointer: SlotName): SlotName {
  return pointer === 'a' ? 'b' : 'a';
}

/** 载荷里有没有内容。用来区分"用户删光了"与"存储空了"。 */
export function isPureEmpty(payload: StoredState): boolean {
  return payload.groups.length === 0 && payload.categories.length === 0 && payload.tombstones.length === 0;
}

/**
 * 会话条数。异常检测与配额降级都看这一个数。
 *
 * 两条数轴都**只数活的会话**：回收站里的东西是"已经删掉的"，
 * 把它算进去会让"用户删了一大片"在计数上看起来像"没怎么变" —— 那正好把异常检测
 * 要拦的那件事抹平了。反过来把它算成"减少"也不行：一次清空回收站会伪装成数据塌陷。
 */
export function countSessions(payload: StoredState): number {
  return payload.groups.length;
}

/** 记录条数（所有**活会话**里的 tab 总数）。异常检测的第二条轴，同样不含回收站。 */
export function countRecords(payload: StoredState): number {
  return payload.groups.reduce((sum, group) => sum + group.tabs.length, 0);
}
