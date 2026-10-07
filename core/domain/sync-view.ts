/**
 * 同步状态的展示派生。
 *
 * 只有一份。用户拍的是"工作台与设置页**两处**都显示"（Q6b），而两处各算一次
 * "现在算什么状态"迟早给出两个答案 —— 那比只有一处更糟，因为用户会以为其中一处坏了。
 * 所以两个 surface 都从这里取，账本（`SyncMeta`）是唯一输入。
 *
 * 刻意**不新增持久状态值**（Q12a）：`checking` 就是已有的 `syncing`，
 * "刚同步成功"由 `idle + lastSyncAt` 推出来，"在退避"由 `nextAttemptAt` 推出来。
 * 持久状态是账本，展示词不是；把展示词塞进账本，下一次就要回答"success 和 idle 有什么区别"
 * 这种没有答案的问题（还要连带补 ×2 语言的文案与语气表）。
 */

import type { MessageKey } from '@/shared/i18n';
import type { SyncMeta } from '@/shared/types';

export interface SyncView {
  /**
   * 要不要在工作台上显形。
   *
   * 正常态不占位（Q11c）："一切正常"不需要一行高度来宣告自己，
   * 而列表那一行的空间是用户真正要看的。异常态必须显形 ——
   * 否则"同步坏了"这件事只有主动去翻设置页的人才知道，那正是这套产品最不该有的形状。
   *
   * ⚠ 这里**没有** `backingOff` 那一格。我一开始写了，然后发现没有任何消费者：
   * 退避中的那句文案与"同步失败"是同一句（`sync_status_error`），界面不需要再分一个色，
   * 而"下一次约几点"那一行属于设置页的 `sync_next_check`（由 `useSync.nextCheckAt()` 供）。
   * 留一个没人读的布尔就是第二个真相 —— 它会在下一次改判据时被当成"已经处理过了"的依据。
   */
  abnormal: boolean;
  /** 异常时给用户看的那一句（复用已有的 `sync_status_*`，不新造文案）。 */
  messageKey: MessageKey | null;
}

export function deriveSyncView(meta: SyncMeta | null, at: number): SyncView {
  if (!meta) return { abnormal: false, messageKey: null };

  const pending = (meta.pendingConflicts?.length ?? 0) > 0;
  const backingOff = meta.nextAttemptAt !== undefined && meta.nextAttemptAt > at;

  if (pending) return { abnormal: true, messageKey: 'sync_status_conflict' };
  if (meta.status === 'suspicious_change') {
    return { abnormal: true, messageKey: 'sync_status_suspicious' };
  }
  if (meta.status === 'error') return { abnormal: true, messageKey: 'sync_status_error' };
  // 退避中算异常：用户该知道"现在不会自动重试"，哪怕原因还是那一句失败。
  if (backingOff) return { abnormal: true, messageKey: 'sync_status_error' };
  return { abnormal: false, messageKey: null };
}
