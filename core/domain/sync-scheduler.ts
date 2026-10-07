/**
 * 同步的调度判据。
 *
 * 一句话：**trigger 只负责"提醒"，这里负责"要不要真跑"。**
 *
 * 为什么要有这一层：到 既有约定 为止，"该不该同步"只有一个问题（本机脏了没有），
 * 而它只有一个问者（存储变更）。现在有五类问者 —— 页面心跳、本机变更、后台 alarm、
 * worker 启动、用户点按钮 —— 如果每个都自己决定跑不跑，就会长出五套判据，
 * 而其中任何一套忘了看退避或忘了看 in-flight，用户看到的都是同一句话：
 * "同步了个寂寞"或者"怎么每秒都在敲服务器"。
 *
 * 所以判据只有这一份，`requestSync` 是唯一执行者，`runSync` 在它下面。
 */

import { dueForSync, PULL_INTERVAL_MS, SYNC_DEBOUNCE_MS } from '@/core/domain/sync-wake';
import type { SyncMeta, SyncTriggerReason } from '@/shared/types';

/**
 * 没跑成的原因。
 *
 * 与 `WebDavErrorKind` 是**两张不同的表**，不要合并：这一张说的是"为什么这一轮没发起"
 * （没有任何网络请求发生过），那一张说的是"发起了但服务器/网络怎么回的"。
 * 混成一套之后，"被退避挡住"会被显示成"连接失败"，那是假话。
 */
export type SyncSkipCause =
  /** WebDAV 没开：连配置都不该读第二次，更不发请求 */
  | 'disabled'
  /** 已经有一个同步在飞：single-flight */
  | 'in-flight'
  /** 有冲突等用户裁决 ⇒ 自动 trigger 不重跑（见 `decideSync` 里那条注释） */
  | 'awaiting-user'
  /** 判据说还没到点（去抖窗口内 / 拉取间隔未到） */
  | 'not-due';

/**
 * 判别联合，不是 `{ action; cause: 'due' | SyncSkipCause }`。
 *
 * 写成后者时，调用方在 `action === 'skip'` 分支里仍然能拿到 `cause: 'due'` 这个值 ——
 * 那个组合根本不存在，但类型允许它，于是 UI 迟早会写出一句"本轮未发起，因为到点了"。
 * TS 在 `sync-engine.ts` 的第一次编译里就把这件事报了回来（我把那条错误留着当证据）。
 */
export type SyncDecision =
  | { action: 'sync'; reason: SyncTriggerReason; cause: 'due' }
  | { action: 'skip'; reason: SyncTriggerReason; cause: SyncSkipCause };

/**
 * 一把同步锁的有效期。
 *
 * 真机实测一轮同步是 2 秒（坚果云，既有约定 那组数），最坏情况（manifest 丢了要扫目录
 * 逐个验）会随历史长度线性增长。60 秒留的是**十几倍余量**，不是精度：
 * 它只防一件事 —— 进程在同步中途被平台杀掉，锁没人解，从此永远不同步。
 * 拿它当"多久之内不会重复同步"用是错的，那个由 `PULL_INTERVAL_MS` 管。
 */
export const SYNC_CLAIM_TTL_MS = 60_000;

/** 存储里的认领标记还算不算数。engine 上锁与判据读锁共用这一条，不留两套真相。 */
export function claimIsLive(meta: Pick<SyncMeta, 'syncClaimedAt'>, at: number): boolean {
  return meta.syncClaimedAt !== undefined && at - meta.syncClaimedAt < SYNC_CLAIM_TTL_MS;
}

export interface SyncDecisionInput {
  reason: SyncTriggerReason;
  meta: SyncMeta;
  at: number;
  /** `WebDavConfig.enabled`。由调用方读好传进来 —— 这层不碰存储。 */
  enabled: boolean;
  /** **本进程**的 in-flight（跨进程那一份看 `meta.syncClaimedAt`）。 */
  inFlight?: boolean;
  debounceMs?: number;
}

/**
 * 五道闸，顺序是刻意的。
 *
 * 1. `disabled` 最先：用户关掉同步就是"别再碰我的服务器"，后面几道都不必问。
 * 2. `in-flight` 第二：并发跑两轮同步会互相盖写 `sync_meta`（各自读了一份旧账本再写回），
 *    那是比"多跑一次"严重得多的事。
 * 3. `awaiting-user` 第三，但**只管冲突不管"可疑变化"** —— 这条是查过代码才敢定的：
 *    冲突有对话框在等（`pendingConflicts` 非空 ⇒ 工作台顶部那块就是等用户点的），
 *    重跑只会把同一份冲突算第二遍、把用户刚做的裁决盖回去。
 *    而 `suspicious_change` **没有对应的裁决 UI**（今天它只是设置页一句提示），
 *    拿它当闸等于把账号冻住且没有任何地方能解冻 —— 那是"更安全"的假象。
 * 4. 退避与到点交给 `dueForSync`（既有约定 那三条：退避 > 脏(去抖) > 拉取间隔）。
 *    注意 `manual` **也走这一道**（用户 2026-10-05 拍的 Q2b）：刚检查过再点就是没到点。
 *    代价是"立即同步"变成一个会被拒的按钮 ⇒ UI 必须同时显示下一次是几点（`nextCheckAt`），
 *    否则它就长得像坏了。
 */
export function decideSync(input: SyncDecisionInput): SyncDecision {
  const { reason, meta, at, enabled } = input;

  if (!enabled) return { action: 'skip', reason, cause: 'disabled' };
  if (input.inFlight === true || claimIsLive(meta, at)) {
    return { action: 'skip', reason, cause: 'in-flight' };
  }
  if ((meta.pendingConflicts?.length ?? 0) > 0) {
    return { action: 'skip', reason, cause: 'awaiting-user' };
  }
  if (!dueForSync(meta, at, input.debounceMs ?? SYNC_DEBOUNCE_MS)) {
    return { action: 'skip', reason, cause: 'not-due' };
  }
  return { action: 'sync', reason, cause: 'due' };
}

/**
 * 下一次自动检查大概是什么时候，给 UI 说一句人话用（`manual` 被拒时的解释）。
 *
 * 三条判据里"最早到点"的那一条就是它。**这是估计不是承诺**：alarm 的触发本身可能被平台
 * 任意延迟（官方原文 "may delay them an arbitrary amount more"），而页面心跳只在页面开着时才有。
 * 所以文案用"约"，且不做秒级跳动 —— 跳动会让人觉得那个时刻一定会发生。
 */
export function nextCheckAt(meta: SyncMeta, at: number): number {
  const candidates: number[] = [];
  if (meta.nextAttemptAt !== undefined && meta.nextAttemptAt > at) candidates.push(meta.nextAttemptAt);
  if (meta.dirtySinceAt !== undefined) {
    const due = meta.dirtySinceAt + SYNC_DEBOUNCE_MS;
    if (due > at) candidates.push(due);
  }
  if (meta.lastSyncAt !== undefined) {
    const pull = meta.lastSyncAt + PULL_INTERVAL_MS;
    if (pull > at) candidates.push(pull);
  }
  // 一条都不在未来 ⇒ 判据现在就说"该跑了"，下一次是"任何一次唤醒"。
  // 返回 at 而不是 undefined：调用方要的是一个能格式化的时刻，不是一个要再分支的可选值。
  return candidates.length > 0 ? Math.min(...candidates) : at;
}
