/**
 * 入口标签页管理器（V1.1 设计包 A 的 PinnedTabManager）。
 *
 * 一句话职责：**每个普通窗口最多一个入口页，它在固定区最左侧，且永不进收纳**。
 *
 * ## 校正时机是"收敛版"
 * 只在 `onInstalled` / `onStartup` / `windows.onCreated` / **收纳后** / 页面自己挂载时
 * 这五个点做 ensure。用户取消固定、把 T 拖到第二位、拖去别的窗口 —— 这些**不**订阅，
 * 等下一次 ensure 一起修正。
 *
 * 理由：`tabs.onUpdated` / `onMoved` 是窗口里最密集的事件流，每次都在 service worker
 * 里回查 + `tabs.move` 会（1）跟用户正在做的拖拽打架，（2）把"每次收纳都把它拽回最左"
 * 这种已被点名质疑的行为变成常态。代价：AC-07/AC-08 的"立刻弹回"变成"下次 ensure 时弹回"。
 *
 * ## 为什么用窗口级锁而不是全局锁
 * ensure 里"查 -> 建 -> 去重"不是原子的，同一窗口的两次并发 ensure 会建出两个 T
 * （AC-05/AC-11 的红线）。不同窗口之间没有共享状态，没必要互相排队。
 */

import type { BrowserTabsPort } from '@/core/ports/browser-tabs';
import type { BrowserEventsPort, TabRemovedInfo } from '@/core/ports/browser-events';
import type { EntryTabPort } from '@/core/ports/entry-tab';
import type { StoragePort } from '@/core/ports/storage';
import type { BrowserTab } from '@/shared/types';
import {
  ENTRY_PAGE_QUERY,
  MOVE_RETRY_DELAY_MS,
  MOVE_RETRY_LIMIT,
} from '@/shared/constants';
import { isEntryTabUrl } from '@/core/domain/tab';
import { sleep } from '@/shared/utils';

/** T 被关闭后重建的 debounce：设计包 A §14 建议 150~300ms，取中间值。 */
export const ENTRY_REBUILD_DEBOUNCE_MS = 220 as const;

export interface PinnedEntryTabDeps {
  tabs: BrowserTabsPort;
  events: BrowserEventsPort;
  storage: StoragePort;
}

export interface PinnedEntryTabController extends EntryTabPort {
  ensureAllWindows(): Promise<void>;
  start(): void;
  stop(): void;
}

/** tabs.move 撞上"用户正在拖标签"时的可重试错误（设计包 A §12）。 */
export function isDraggingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cannot be edited right now/i.test(message);
}

export function createPinnedEntryTab(deps: PinnedEntryTabDeps): PinnedEntryTabController {
  const locks = new Map<number, Promise<unknown>>();
  const rebuildTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let unsubscribe: (() => void) | undefined;

  function entryUrl(): string {
    return `${deps.tabs.entryPageUrl()}?${ENTRY_PAGE_QUERY}`;
  }

  /** 同一窗口的 ensure 串行；不同窗口互不影响。 */
  function withWindowLock<T>(windowId: number, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(windowId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // 锁链本身不带异常：一次失败不能卡死这个窗口后续所有 ensure
    locks.set(
      windowId,
      next.catch(() => undefined),
    );
    return next;
  }

  async function moveToFirstWithRetry(tabId: number): Promise<void> {
    for (let attempt = 0; attempt <= MOVE_RETRY_LIMIT; attempt += 1) {
      try {
        await deps.tabs.move(tabId, 0);
        return;
      } catch (error) {
        if (!isDraggingError(error) || attempt === MOVE_RETRY_LIMIT) throw error;
        await sleep(MOVE_RETRY_DELAY_MS);
      }
    }
  }

  /**
   * 真正的 ensure。**必须在锁内调用**。
   *
   * 返回窗口里是否确实存在一个入口页 —— 收纳用例靠它决定"敢不敢关掉最后一条 tab"。
   */
  async function ensure(windowId: number, focus: boolean): Promise<boolean> {
    const settings = await deps.storage.getSettings();
    if (!settings.pinnedEntryEnabled) return false;

    const candidates = (await deps.tabs.queryWindowTabs(windowId)).filter((tab) =>
      isEntryTabUrl(tab.url),
    );

    if (candidates.length === 0) {
      await deps.tabs.create({
        url: entryUrl(),
        windowId,
        index: 0,
        active: focus,
        pinned: true,
      });
      return true;
    }

    const primary = candidates[0] as BrowserTab;
    // 重新钉住：用户在页面上按 Ctrl/⌘+Shift+E 之类操作把 T 取消固定后，下次 ensure 修正。
    if (!primary.pinned) await deps.tabs.update(primary.id, { pinned: true });
    if (settings.keepPinnedTabFirst && primary.index !== 0) {
      try {
        await moveToFirstWithRetry(primary.id);
      } catch (error) {
        // 位置不对不影响"有落脚页"这件事，收纳不能因为一次 move 失败就关不掉标签
        console.warn('[shitab] 入口页没能回到最左', error);
      }
    }

    const duplicates = candidates.slice(1).map((tab) => tab.id).filter((id) => id !== primary.id);
    if (duplicates.length > 0) await deps.tabs.remove(duplicates);

    if (focus) await deps.tabs.update(primary.id, { active: true });
    return true;
  }

  function clearRebuildTimer(windowId: number): void {
    const timer = rebuildTimers.get(windowId);
    if (timer !== undefined) clearTimeout(timer);
    rebuildTimers.delete(windowId);
  }

  function scheduleRebuild(windowId: number): void {
    clearRebuildTimer(windowId);
    rebuildTimers.set(
      windowId,
      setTimeout(() => {
        rebuildTimers.delete(windowId);
        void ensureForWindow(windowId).catch((error: unknown) => {
          console.error('[shitab] 重建入口页失败', error);
        });
      }, ENTRY_REBUILD_DEBOUNCE_MS),
    );
  }

  async function handleTabRemoved(info: TabRemovedInfo): Promise<void> {
    if (info.isWindowClosing) {
      clearRebuildTimer(info.windowId);
      return;
    }
    const settings = await deps.storage.getSettings();
    if (settings.autoRestorePinnedTab && settings.pinnedEntryEnabled) {
      scheduleRebuild(info.windowId);
    }
  }

  async function ensureForWindow(windowId: number, opts?: { focus?: boolean }): Promise<boolean> {
    if (windowId < 0) return false; // windows.onCreated 拿不到 id 时不能凭空造
    return withWindowLock(windowId, () => ensure(windowId, opts?.focus === true));
  }

  async function ensureAllWindows(): Promise<void> {
    const windows = await deps.tabs.listNormalWindows();
    for (const window of windows) {
      await ensureForWindow(window.id).catch((error: unknown) => {
        // 一个窗口失败不影响其它窗口：入口页是尽力而为的便利，不是事务
        console.error('[shitab] 补齐入口页失败，窗口', window.id, error);
      });
    }
  }

  return {
    ensureForWindow,
    ensureAllWindows,

    start(): void {
      if (unsubscribe) return;
      unsubscribe = deps.events.subscribe({
        // 处理器一律**返回 promise**：测试要能 await 到状态稳定，
        // 而 `void f()` 会把 rejection 变成无人认领的 unhandled rejection。
        onInstalled: () => ensureAllWindows(),
        onStartup: () => ensureAllWindows(),
        onWindowCreated: (windowId) =>
          ensureForWindow(windowId).then(
            () => undefined,
            (error: unknown) => console.error('[shitab] 新窗口补建入口页失败', error),
          ),
        onWindowRemoved: (windowId) => {
          clearRebuildTimer(windowId);
          locks.delete(windowId);
        },
        // 只在"用户显式关掉 T"且开关打开时重建；isWindowClosing 会抑制整个窗口关闭时的风暴
        onTabRemoved: (info) => handleTabRemoved(info),
      });
    },

    stop(): void {
      unsubscribe?.();
      unsubscribe = undefined;
      for (const windowId of [...rebuildTimers.keys()]) clearRebuildTimer(windowId);
      locks.clear();
    },
  };
}
