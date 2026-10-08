/**
 * 回收站里**单条记录**的状态。
 *
 * 一句话说清这一层为什么存在：`mergeTrash` 的记录级判据是**并集**（两台设备各往同一行里
 * 新增不同记录时一条都不能丢），而并集天生表达不了"移除" —— 于是"我把这条处理掉了"这个
 * 事实必须单独带一份可传播的凭证，否则远端那一版（**往往就是本机自己上一轮推上去的那一版**）
 * 会把它并回来。用户看到的说法是"彻底删除的单条标签，删完立马又回来了"。
 *
 * 三条不是顺手定的判据：
 *
 * 1. **barrier 比的是"这一条这一次进回收站的时刻"（`arrivedAt`），不是整行的 `deletedAt`。**
 *    少了 `arrivedAt` 这一格，任何 barrier 都会把"同一条记录后来又被删进来一次"永久压住 ——
 *    那是静默丢一条可恢复记录，比它要修的那个"会复活"更糟。所以 `arrivedAt` 不是日志字段，
 *    是判据的另一个操作数。
 * 2. **barrier 不是永久删除标记。** 只在 `barrier.at >= arrivedAt` 时压制，更晚的入站穿透它。
 *    （这与整行那条 `'trash'` 标记的判据同形 —— 同形是有意的：两条规则一旦语义分叉，
 *    下一次改动只会有一条被想起。）
 * 3. **比较必须是确定性总序。** 平手时（同一毫秒两台设备各写一条）由 `deviceId`、
 *    再 `action` 的字典序钉死，两边必须算出**同一个** winner。
 *
 * ⚠ 为什么这里**没有**逻辑时钟 / HLC / 版本向量（本仓库现在也确实没有那样的基础设施）：
 * 整套跨设备合并的既有判据都是墙上钟 LWW（`updatedAt`，既有约定），并且那里把
 * "两台机器时钟有偏移"明确记成**已知局限**（正因为如此 delete-vs-edit 才不自动判）。
 * 只把 barrier 这一层换成逻辑钟，会让同一次合并的前后两步用两套时间语义互相打脸：
 * 记录层说"这一版更新"、barrier 层说"这条更早"。要上 HLC 就该整包一起上，那是另一份 既有约定。
 * 这里的取舍是：把确定性总序做严（第 3 条），把墙上钟偏差的残余风险如实记在同一条已知局限里。
 */

import type { DeleteReason, TrashEntry, TrashRecordBarrier, TrashRecordState } from '@/shared/types';

/** 一行里多种来历并存时，取"最像用户删除"的那个当行的主标记。 */
const REASON_PRIORITY: Record<DeleteReason, number> = {
  'user-delete': 0,
  consumed: 1,
  undone: 2,
  // 「恢复到某一版」换掉的记录：最不像用户自己的删除，所以排最后。
  reverted: 3,
};

/**
 * 一组来历里最该露出来的那一个。判据只有这一份（原来在 `merge.ts`，既有约定 之后
 * 记录级的语义都收在这个模块里，省得两处各写一张优先级表）。
 *
 * 为什么是"最像用户删除"：`user-delete` 意味着"这行是用户自己删的、他想捞回来"，
 * 那个解释下界面不会做任何多余的事；反过来把一条用户删的记录说成「已恢复」是**当面撒谎**。
 *
 * **取列表里的最小值，不预设起点**：这里曾经把初始值写成 `'user-delete'`，
 * 后果是"全是恢复记录的一行"也被判成用户删除 ⇒ 「已恢复」胶囊不亮（回收站里出现他没删过的
 * 东西却不肯说明来历，正是 既有约定 立这条时要防的那件事）。
 * 空列表返回 `'user-delete'` 是一条**走不到的**保底：既有约定 之后"零可见记录的行"真的会出现
 * （替 barrier 记账的壳行），所以那两种调用方现在都自己先判空，别依赖这条保底。
 */
export function dominantReason(reasons: DeleteReason[]): DeleteReason {
  const [first, ...rest] = reasons;
  if (first === undefined) return 'user-delete';
  return rest.reduce(
    (best, current) => (REASON_PRIORITY[current] < REASON_PRIORITY[best] ? current : best),
    first,
  );
}

/**
 * 读时兜底（老行、以及对面那台还没升级的产物写出来的行都只有 `recordReasons`）。
 *
 * 缺 `arrivedAt` 时退化成**整行的 `deletedAt`** —— 那一定不晚于任何后来才写的 barrier，
 * 所以兜底方向是"压不住"而不是"错杀"：宁可贵一次"回来"，不能静默丢一条记录。
 * 这个方向不是巧合，是整份设计的底线（"宁可多留一条，不能少一条"）。
 */
export function recordsOf(entry: TrashEntry): Record<string, TrashRecordState> {
  if (entry.records) return entry.records;
  const legacy = entry.recordReasons ?? {};
  return Object.fromEntries(
    entry.group.tabs.map((tab) => [
      tab.id,
      { reason: legacy[tab.id] ?? entry.reason, arrivedAt: entry.deletedAt },
    ]),
  );
}

export function recordReason(entry: TrashEntry, tabId: string): DeleteReason {
  return recordsOf(entry)[tabId]?.reason ?? entry.reason;
}

/**
 * barrier 的确定性总序：`at → deviceId → action`。
 *
 * 第三个键位看着多余（同一设备同一毫秒对同一条记录写两种动作，现实里近乎不可能），
 * 但它撑的是**可交换性**：少了它，平手时"保留谁"就取决于遍历顺序，
 * 而 `merge(A,B)` 与 `merge(B,A)` 就会给出不同的 ledger —— 那正是这台机器每轮多推一个快照的成因。
 */
export function compareBarriers(a: TrashRecordBarrier, b: TrashRecordBarrier): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  return a.action === b.action ? 0 : a.action < b.action ? -1 : 1;
}

/** 两条 barrier 取"更新"的那一条；缺省的那条直接返回另一条。 */
export function latestBarrier(
  a?: TrashRecordBarrier,
  b?: TrashRecordBarrier,
): TrashRecordBarrier | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareBarriers(a, b) >= 0 ? a : b;
}

/**
 * 这一条记录要不要被压住。
 *
 * `>=` 而不是 `>`：与整行那条规则（`marker.deletedAt >= deletedAt`）同形；
 * 而"同一毫秒里先入站再被处理掉"恰恰是最该压住的一种真实序（用户连点两下）。
 */
export function barrierSuppresses(state: TrashRecordState | undefined): boolean {
  if (!state?.barrier) return false;
  return state.barrier.at >= state.arrivedAt;
}

/** 两个来源的同一 id 状态合并（跨行、跨设备都走这一条）。 */
export function mergeRecordStates(a: TrashRecordState, b: TrashRecordState): TrashRecordState {
  return {
    reason: dominantReason([a.reason, b.reason]),
    // 较晚的那一次入站：更早的那一份已经被处理掉了，比对判据没有意义
    arrivedAt: Math.max(a.arrivedAt, b.arrivedAt),
    barrier: latestBarrier(a.barrier, b.barrier),
  };
}

/** 合并整张 ledger。两侧都是部分映射，缺的 id 直接补位。 */
export function mergeRecordLedgers(
  a: Record<string, TrashRecordState>,
  b: Record<string, TrashRecordState>,
): Record<string, TrashRecordState> {
  const merged: Record<string, TrashRecordState> = { ...a };
  for (const [tabId, state] of Object.entries(b)) {
    merged[tabId] = merged[tabId] ? mergeRecordStates(merged[tabId]!, state) : state;
  }
  return merged;
}

/** 新入站的一条记录（`arrivedAt` 一律盖成这一次的时刻 —— 它要能穿透自己身上的旧 barrier）。 */
export function arrivedState(reason: DeleteReason, at: number): TrashRecordState {
  return { reason, arrivedAt: at };
}

/** 把一条记录标记为"已被用户处理掉"，并把 ledger 留在行上（记录可以消失，事实不能消失）。 */
export function withBarrier(
  state: TrashRecordState,
  barrier: TrashRecordBarrier,
): TrashRecordState {
  return { ...state, barrier: latestBarrier(state.barrier, barrier) };
}

/** ledger 按 id 排序后再序列化用；`canonicalJson` 已经会排对象键，这里只保证数组侧稳定。 */
export function ledgerIds(ledger: Record<string, TrashRecordState>): string[] {
  return Object.keys(ledger).sort();
}
