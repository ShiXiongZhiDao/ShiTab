/**
 * 异常变化检测（既有约定，WebDAV-SYNC.md §8 / §9）。
 *
 * 这一条是整套设计立项的理由，不是同步的一个附加功能。它防的是那一句：
 * 「系统崩溃/误删导致同步把云端也删掉」—— 云端是唯一的完整副本时，
 * 一次异常状态被当成"用户的正常删除"推上去，两份数据就同时没了。
 *
 * 三条axes，按 §9 的四条规则：
 * - **规则 C/D（本地状态本身不可信）** ⇒ `blocked`，直接禁止同步，不问用户。
 *   损坏的数据连"它有多少条"都答不准，拿它去比较只会得出一个随机的结论。
 * - **规则 A（全部清空）与 规则 B（大幅减少）** ⇒ `suspicious`，停下并交给 UI。
 *   注意这两条**不阻断本地使用**：用户也许真的把 100 条会话都删了，那是合法的意图，
 *   只是我们不能替他默认确认。
 */

import type { EnvelopeInvalid, StoredState } from '@/shared/types';
import { countRecords, countSessions } from '@/core/domain/durable-state';

/** 规则 A 的下限：旧值要**大于**这个数，一次清空才算"值得拦"。 */
export const SUSPICIOUS_MIN_PREVIOUS = 20;
/** 规则 B 的比例：新值低于旧值的这个比例 ⇒ 可疑。 */
export const SUSPICIOUS_DROP_RATIO = 0.3;
/** 规则 B 的绝对量：掉了多少个以内不看比例（100→70 是正常清理，不该天天问）。 */
export const SUSPICIOUS_MIN_DROP = 20;

/** 被检测的两条轴。两条都要报，因为"还剩 3 个会话但每个会话都空了"也是数据丢了。 */
export interface Counts {
  sessions: number;
  records: number;
}

export function countsOf(state: StoredState): Counts {
  return { sessions: countSessions(state), records: countRecords(state) };
}

/** 哪一条轴触发的。UI 要把这个数显示给用户看（"本地 0 个 / 云端 100 个"）。 */
export interface SuspiciousRule {
  rule: 'A' | 'B';
  axis: keyof Counts;
  previous: number;
  current: number;
}

/**
 * 判据当时比的那两组数，原样交给 UI。
 *
 * `outgoing` 就是入参 `local`：引擎在那里传的是**合并后即将上传的那一版**，
 * 不是合并前的本机原始状态。两条轴都给（`sessions` / `records`），因为"组少了但记录没少"
 * 和"两条一起塌"是两件不同的事，用户要去回收站核对的东西也不一样。
 *
 * 为什么由判据自己带数而不是让 UI 再算一遍：那道闸比的是它手里那两个对象，
 * UI 拿到的必须是**让它停下来的那同一组数**，否则提示可以在说一件没发生过的事。
 */
export interface SuspiciousCounts {
  outgoing: Counts;
  remote: Counts;
}

export type SafetyVerdict =
  | { ok: true }
  /** 本地状态不可信 ⇒ 禁止同步。这条**不需要用户确认**，也没有可确认的东西。 */
  | { ok: false; kind: 'blocked'; reason: EnvelopeInvalid }
  /**
   * 数量塌陷 ⇒ 挂起，等用户核对。
   *
   * ⚠ 这一格原来写的是"等用户在 UI 上选恢复云端 / 保留本地 / 查看差异"，而那三个动作
   * 一个都没有实现过 —— 于是"用户也许真的删了 100 条"那一档没有任何出口，
   * 闸每轮都成立、那一版永远推不出去（既有约定 修的就是这个死结）。
   * 现在实际有的是：设置页一颗「照这一版上传」（＝"保留本地"，一次性、按内容 checksum 认），
   * "恢复云端"由已有的远端历史面板充当，"查看差异"由回收站充当。
   */
  | { ok: false; kind: 'suspicious'; rules: SuspiciousRule[]; counts: SuspiciousCounts };

/**
 * 单条轴上跑 A 与 B。
 *
 * A 与 B 会同时成立（`100 → 0` 既满足"全空"也满足"低于 30%"），
 * 所以返回的是**列表**而不是第一个命中的：UI 上要能说出"两条规则都报了"，
 * 而不是"看起来只有比例问题"。
 */
function rulesForAxis(axis: keyof Counts, previous: number, current: number): SuspiciousRule[] {
  const found: SuspiciousRule[] = [];
  if (previous > SUSPICIOUS_MIN_PREVIOUS && current === 0) {
    found.push({ rule: 'A', axis, previous, current });
  }
  const dropped = previous - current;
  if (current < previous * SUSPICIOUS_DROP_RATIO && dropped > SUSPICIOUS_MIN_DROP) {
    found.push({ rule: 'B', axis, previous, current });
  }
  return found;
}

/**
 * 同步前的总闸。
 *
 * `localValid` 传的是**信封校验的结果**，不是"我读到了东西"：
 * §9 规则 C/D 要防的正是"读到了但那是半截数据"。
 *
 * `remote === undefined` 表示远端还没有任何有效快照（第一次同步）——
 * 这时没有任何参照系，也就无法判断塌陷，直接放行。
 * 这条要写明白，因为它是"为什么第一次上传 0 条不会被拦"的答案。
 */
export function assessSyncSafety(input: {
  local: StoredState;
  localValid: boolean;
  localInvalidReason?: EnvelopeInvalid;
  remote?: StoredState;
}): SafetyVerdict {
  if (!input.localValid) {
    return {
      ok: false,
      kind: 'blocked',
      reason: input.localInvalidReason ?? 'shape',
    };
  }

  if (input.remote === undefined) return { ok: true };

  const previous = countsOf(input.remote);
  const current = countsOf(input.local);
  const rules = [...rulesForAxis('sessions', previous.sessions, current.sessions), ...rulesForAxis('records', previous.records, current.records)];

  if (rules.length > 0) return { ok: false, kind: 'suspicious', rules, counts: { outgoing: current, remote: previous } };
  return { ok: true };
}
