// 唤醒判据（`dueForSync`）只被 `decideSync` 调，而 `decideSync` 只被 `requestSync` 调 ——
// 既有约定 之后这条链上不再有第二个入口（原来那个 `catchUpOnWake` 是假的第二判据，已删）。
// 判据跑在 background service worker 里 —— 那里没有 DOM，整文件切 node 环境，理由见 既有约定。
// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { dueForSync, PULL_INTERVAL_MS, SYNC_DEBOUNCE_MS } from '@/core/domain/sync-wake';
import type { SyncMeta } from '@/shared/types';

const AT = 1_700_000_000_000;

function meta(overrides: Partial<SyncMeta> = {}): SyncMeta {
  return { status: 'pending', lastPushedRevision: 0, consecutiveFailures: 0, ...overrides };
}

/**
 * 这几条判据钉的是"改了但没同步、也没报错"那类最难查的现象。
 * 定时器在 MV3 里活不过 30 秒，所以正确性只能落在这个纯函数上。
 */
describe('唤醒判据 dueForSync', () => {
  /**
   * 这一条**原来写的是**"没有脏标记 ⇒ 什么都不做"，而那条判据就是用户投诉的根
   * （没动过的那台设备永远不会去拉，对面的回收站/删除永远进不来）。
   * 既有约定 把它改成"没脏也要按拉取间隔去拉"，所以这里留下的判据是**间隔未到**那一侧。
   */
  it('没脏、且距上次同步还没到一个拉取间隔 ⇒ 什么都不做（唤醒很频繁时不该每次敲门）', () => {
    expect(dueForSync(meta({ lastSyncAt: AT }), AT + 1_000)).toBe(false);
  });

  it('刚变脏还在去抖窗口内 ⇒ 不推（连续收纳时不该每收一次打一次网络）', () => {
    const dirty = meta({ dirtySinceAt: AT });
    expect(dueForSync(dirty, AT + 100)).toBe(false);
    expect(dueForSync(dirty, AT + SYNC_DEBOUNCE_MS - 1)).toBe(false);
  });

  it('去抖窗口到点 ⇒ 推', () => {
    expect(dueForSync(meta({ dirtySinceAt: AT }), AT + SYNC_DEBOUNCE_MS)).toBe(true);
  });

  /**
   * 窗口只看**第一次**变脏的时刻。看最后一次的话，用户连续收纳 10 次
   * 每次都把计时器重置，结果是永远不推 —— 而那在 UI 上一切正常。
   */
  it('脏了 10 秒 ⇒ 推，即使中间又改过（dirtySinceAt 记录的是第一次）', () => {
    expect(dueForSync(meta({ dirtySinceAt: AT }), AT + 10_000)).toBe(true);
  });

  /**
   * 退避优先于脏。一次 503 之后如果"本地又变了"就能绕过退避，
   * 那服务器抖动一次会被我们每秒敲一遍。
   */
  it('退避没到点 ⇒ 即使已经脏了也不推', () => {
    const dirty = meta({ dirtySinceAt: AT, nextAttemptAt: AT + 60_000 });
    expect(dueForSync(dirty, AT + SYNC_DEBOUNCE_MS)).toBe(false);
    expect(dueForSync(dirty, AT + 60_000)).toBe(true);
  });

  it('退避恰好到点算到点（>=，不是 >）：否则差一毫秒会多等一整个周期', () => {
    expect(dueForSync(meta({ dirtySinceAt: AT, nextAttemptAt: AT + 5000 }), AT + 5000)).toBe(true);
  });

  /**
   * 这里原来有一条 `catchUpOnWake 与 dueForSync 同判据` 的用例，连着那个函数一起删了。
   * 删的理由不是"没用了"这么轻：它的注释宣称"分开是因为判据不同"，而函数体就是
   * `return dueForSync(...)` —— **两套名字、一套判据**，正是 既有约定 要消灭的那种第二真相。
   * 它断言的三件事（干净账本立刻到点 / 刚同步过不到点 / 脏了按去抖）在本文件里各有归宿。
   */

  it('SYNC_DEBOUNCE_MS 落在 §17 给的 2~5 秒区间里', () => {
    expect(SYNC_DEBOUNCE_MS).toBeGreaterThanOrEqual(2_000);
    expect(SYNC_DEBOUNCE_MS).toBeLessThanOrEqual(5_000);
  });
});

/**
 * 用户 2026-10-05 报的现象：「Chrome 的回收站彻底删除标签或者标签组，Edge 的回收站没有同步」。
 * Chrome 与 Edge 是**两台设备**：删除发生在 Chrome，Edge 那天一次都没动过自己的数据。
 *
 * 而 `dueForSync` 第二条判据"没有脏标记就什么都不做"让**没动过的那台永远不去拉** ——
 * 对面推上来的那一版在本地不留任何痕迹，没人把 `dirtySinceAt` 写亮。
 * 回收站只是最显眼的那一项（对面删掉的会话、改过的标题同样看不见）。
 *
 * 判据要加一条：本机不脏、但距上次同步已经过一个拉取间隔 ⇒ 也跑一次。
 * `runSync` 在"两边内容一样"时走 `no-changes`，代价是一次 PROPFIND + 一次 GET，不是一次上传。
 */
describe('不脏也要拉（对面设备的改动不会在本地留痕）', () => {
  it('距上次同步刚好一个拉取间隔 ⇒ 判该同步（改动前这里是 false，就是那条投诉）', () => {
    expect(dueForSync(meta({ lastSyncAt: AT }), AT + PULL_INTERVAL_MS)).toBe(true);
  });

  it('还没到一个拉取间隔 ⇒ 不敲服务器（SW 唤醒可能很频繁，不能每次都打一轮）', () => {
    expect(dueForSync(meta({ lastSyncAt: AT }), AT + PULL_INTERVAL_MS - 1)).toBe(false);
  });

  it('从没同步成功过（`lastSyncAt` 缺席）⇒ 立刻到点：新设备第一次唤醒就该把远端拉下来', () => {
    expect(dueForSync(meta(), AT)).toBe(true);
  });

  it('脏了仍然按去抖窗口走，不因为"拉取间隔早过了"就提前推', () => {
    const dirty = meta({ dirtySinceAt: AT, lastSyncAt: AT - 999_999 });
    expect(dueForSync(dirty, AT + 100)).toBe(false);
    expect(dueForSync(dirty, AT + SYNC_DEBOUNCE_MS)).toBe(true);
  });

  /** 退避排在**两种**判据前面：脏的与拉取的都是。一次 503 之后不该每秒敲一遍。 */
  it('退避没到点 ⇒ 不脏、拉取间隔也早过了，照样不跑', () => {
    const waiting = meta({ lastSyncAt: AT - 999_999, nextAttemptAt: AT + 30_000 });
    expect(dueForSync(waiting, AT)).toBe(false);
    expect(dueForSync(waiting, AT + 30_000)).toBe(true);
  });

  it('PULL_INTERVAL_MS 是"用户能接受的延迟"量级，不是 3 秒那一档', () => {
    expect(PULL_INTERVAL_MS).toBeGreaterThanOrEqual(30_000);
    expect(PULL_INTERVAL_MS).toBeLessThanOrEqual(5 * 60_000);
  });
});
