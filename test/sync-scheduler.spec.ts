/**
 * 调度判据。纯函数层：五道闸各一条，加上"下一次是几点"。
 *
 * 这一层的价值就在于它不需要假服务器、不需要存储、不需要时间旅行 ——
 * 判据错了这里就红，而不是等真机上"同步了个寂寞"才发现。
 */

import { describe, expect, it } from 'vitest';
import { decideSync, nextCheckAt } from '@/core/domain/sync-scheduler';
import { PULL_INTERVAL_MS, SYNC_DEBOUNCE_MS } from '@/core/domain/sync-wake';
import type { SyncMeta } from '@/shared/types';

const AT = 1_700_000_000_000;

function meta(overrides: Partial<SyncMeta> = {}): SyncMeta {
  return { status: 'idle', lastPushedRevision: 0, consecutiveFailures: 0, lastSyncAt: AT - 999_999, ...overrides };
}

function decide(overrides: Partial<Parameters<typeof decideSync>[0]> = {}) {
  return decideSync({
    reason: 'alarm',
    meta: meta(),
    at: AT,
    enabled: true,
    inFlight: false,
    ...overrides,
  });
}

describe('decideSync 的五道闸', () => {
  it('什么都不挡时判"该跑"，cause 是 due', () => {
    expect(decide()).toEqual({ action: 'sync', reason: 'alarm', cause: 'due' });
  });

  it('同步关着 ⇒ 第一个原因就是 disabled，不看后面任何一条', () => {
    // 脏了、也在飞、也有冲突 —— 都无所谓，关了就是关了
    expect(decide({
      enabled: false,
      inFlight: true,
      meta: meta({ dirtySinceAt: AT, pendingConflicts: [{ groupId: 'g', groupTitle: '会话 g', deletedAt: 1, editedAt: 2, deletedByDeviceId: 'd', deleteReason: 'user-delete' }] }),
    })).toMatchObject({ action: 'skip', cause: 'disabled' });
  });

  it('已经有一轮在飞 ⇒ in-flight，且这一条排在"待用户裁决"之前', () => {
    expect(decide({ inFlight: true })).toMatchObject({ action: 'skip', cause: 'in-flight' });
  });

  /**
   * 冲突对话框挂着的时候不重跑。
   *
   * ⚠ 这一条**只管冲突、不管 `suspicious_change`**，是查过代码才定的：冲突有等用户点的
   * 那块区域（`pendingConflicts` 非空 ⇒ 工作台顶部就是），重跑会把同一份冲突算第二遍、
   * 把用户刚做的裁决盖回去；而"可疑变化"今天**没有任何裁决 UI**（只是设置页一句提示），
   * 拿它当闸等于把账号冻住且无处解冻 —— 那是"更安全"的假象。
   */
  it('待裁决冲突 ⇒ awaiting-user；只有 suspicious_change 状态时不拦', () => {
    const waiting = meta({
      status: 'conflict',
      pendingConflicts: [{ groupId: 'g', groupTitle: '会话 g', deletedAt: 1, editedAt: 2, deletedByDeviceId: 'd', deleteReason: 'user-delete' }],
    });
    expect(decide({ meta: waiting })).toMatchObject({ action: 'skip', cause: 'awaiting-user' });

    // 空数组 = 已经裁完，不该继续拦（这条是防"清账"漏了以后同步永久卡死）
    expect(decide({ meta: meta({ status: 'conflict', pendingConflicts: [] }) })).toMatchObject({ action: 'sync' });

    expect(decide({ meta: meta({ status: 'suspicious_change' }) })).toMatchObject({ action: 'sync' });
  });

  it('刚检查过（不脏、拉取间隔未到）⇒ not-due，manual 也不例外', () => {
    const justChecked = meta({ lastSyncAt: AT - 1_000 });
    expect(decide({ meta: justChecked, reason: 'manual' })).toMatchObject({ action: 'skip', cause: 'not-due' });
    // 正向对照：到点了 manual 就该跑
    expect(decide({ meta: meta({ lastSyncAt: AT - PULL_INTERVAL_MS }), reason: 'manual' })).toMatchObject({ action: 'sync' });
  });

  it('退避没到点 ⇒ not-due（判据里退避在最前，这一层不另立第二套）', () => {
    expect(decide({ meta: meta({ nextAttemptAt: AT + 60_000 }) })).toMatchObject({ action: 'skip', cause: 'not-due' });
  });

  it('脏了但还在去抖窗口内 ⇒ not-due；窗口过了 ⇒ due', () => {
    expect(decide({ meta: meta({ dirtySinceAt: AT - 100 }) })).toMatchObject({ action: 'skip', cause: 'not-due' });
    expect(decide({ meta: meta({ dirtySinceAt: AT - SYNC_DEBOUNCE_MS }) })).toMatchObject({ action: 'sync' });
  });
});

describe('nextCheckAt：给"立即同步被拒了"那句人话用', () => {
  /** 三条候选各当一次"最早"，这样"取 min"这件事是被测出来的、不是看着像。 */
  it('取三条候选里最早的那一条', () => {
    // 脏的先到：dirtySinceAt - 1s + 去抖 3s = AT + 2s，早于退避的 AT + 5s
    expect(nextCheckAt(meta({ dirtySinceAt: AT - 1_000, nextAttemptAt: AT + 5_000 }), AT)).toBe(AT + 2_000);
    // 退避先到：退避 AT + 1s 早于脏的 AT + 3s
    expect(nextCheckAt(meta({ dirtySinceAt: AT, nextAttemptAt: AT + 1_000 }), AT)).toBe(AT + 1_000);
    // 只有拉取间隔：刚检查过 10 秒 ⇒ 下一次在 AT + 50s
    expect(nextCheckAt(meta({ lastSyncAt: AT - 10_000 }), AT)).toBe(AT - 10_000 + PULL_INTERVAL_MS);
  });

  it('一条都不在未来 ⇒ 返回 at（"现在就该跑"），不返回 undefined 让调用方再分支一次', () => {
    // meta() 默认的 lastSyncAt 是 999_999 毫秒前 ⇒ 拉取候选早已过去，不进列表
    expect(nextCheckAt(meta(), AT)).toBe(AT);
    expect(nextCheckAt(meta({ lastSyncAt: undefined }), AT)).toBe(AT);
  });

  /** 这一格是 UI 那句话的根据：被拒时必须能说出"下一次约几点"，否则按钮长得像坏了。 */
  it('被 manual 拒掉的那一轮也能算出下一次（拉取间隔）', () => {
    const justChecked = meta({ lastSyncAt: AT - 10_000 });
    expect(decide({ meta: justChecked, reason: 'manual' })).toMatchObject({ action: 'skip', cause: 'not-due' });
    expect(nextCheckAt(justChecked, AT)).toBe(AT - 10_000 + PULL_INTERVAL_MS);
  });
});
