/**
 * BrowserTabsPort 的内存实现，只给单测用。
 *
 * 不用 fakeBrowser.tabs：WXT 的 fake-browser 是签名 mock，方法返回 undefined，
 * 拿它跑 captureWindow 只会验证"代码调用了 API"，验证不了顺序 / 失败计数 / 去重
 * 这些真正会错的东西。
 */

import type { BrowserTabsPort, TabRemovalOutcome } from '@/core/ports/browser-tabs';
import type { BrowserTab, BrowserWindow, CreateTabInput } from '@/shared/types';
import { ENTRY_PAGE_PATH } from '@/shared/constants';

export interface FakeTabSpec {
  id: number;
  url: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  favIconUrl?: string;
}

export interface FakeWindowSpec {
  id: number;
  tabs: FakeTabSpec[];
  focused?: boolean;
}

export interface FakeBrowserTabsOptions {
  windows: FakeWindowSpec[];
  /** 这些 tab id 在 remove 时失败，用来测"关闭失败不得删除已保存记录" */
  unremovableTabIds?: number[];
  /** 这些 URL 在 create 时失败，用来测部分恢复失败 */
  unopenableUrls?: string[];
  /** 这些 tab 在 move 时抛"用户正在拖拽"，用来测入口页的有限次重试 */
  draggingTabIds?: number[];
  /**
   * 模拟"扩展没有被允许在无痕模式运行"：`createWindow({incognito:true})` 直接抛。
   * 既有约定 要求这种失败如实冒出来，不降级成普通窗口 —— 没有这个开关就测不到。
   */
  incognitoDisallowed?: boolean;
  lastFocusedWindowId?: number;
}

/** 假扩展 id：入口页 URL 的身份来源，测试里可以直接和它比较。 */
export const FAKE_EXTENSION_ORIGIN = 'chrome-extension://fake-shitab';

export interface CreatedWindow {
  id: number;
  incognito: boolean;
}

export interface FakeBrowserTabsPort extends BrowserTabsPort {
  /** 测试断言用：当前每个窗口里剩下的 tab */
  dump(): Record<number, BrowserTab[]>;
  /** 测试断言用：createWindow 被呼叫的次数与参数（还原模式靠它判定） */
  createdWindows(): CreatedWindow[];
  /**
   * 测试断言用：每次 `remove` 收到的 tab id，按调用顺序一份数组。
   *
   * 为什么不是只看 `dump()`：`dump()` 说"这条 tab 还在"，而"还在"有两种来路 ——
   * 根本没被交给 remove，和被交过去但平台拒了。既有约定 那条判据要的正是前一种
   * （不可恢复的页面**不该被送去关**），拿剩下的列表证不了它。
   */
  removeCalls(): number[][];
}

export function createFakeBrowserTabsPort(
  options: FakeBrowserTabsOptions,
): FakeBrowserTabsPort {
  const windows = new Map<number, BrowserTab[]>();
  const windowOrder: number[] = [];
  let nextTabId = 1000;

  for (const spec of options.windows) {
    const tabs = spec.tabs.map(
      (tab, index): BrowserTab => ({
        id: tab.id,
        windowId: spec.id,
        url: tab.url,
        title: tab.title ?? tab.url,
        active: tab.active === true,
        pinned: tab.pinned === true,
        index,
        ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
      }),
    );
    windows.set(spec.id, tabs);
    windowOrder.push(spec.id);
  }

  const unremovable = new Set(options.unremovableTabIds ?? []);
  const unopenable = new Set(options.unopenableUrls ?? []);
  const dragging = new Set(options.draggingTabIds ?? []);
  const draggingAttempts = new Map<number, number>();
  const incognitoDisallowed = options.incognitoDisallowed === true;
  const created: CreatedWindow[] = [];
  const removeBatches: number[][] = [];
  let focusedWindowId = options.lastFocusedWindowId ?? windowOrder[0] ?? 1;

  function reindex(windowId: number) {
    (windows.get(windowId) ?? []).forEach((tab, index) => {
      tab.index = index;
    });
  }

  const port: FakeBrowserTabsPort = {
    dump() {
      return Object.fromEntries([...windows.entries()].map(([id, tabs]) => [id, [...tabs]]));
    },

    createdWindows() {
      return [...created];
    },

    removeCalls() {
      return removeBatches.map((batch) => [...batch]);
    },

    async queryWindowTabs(windowId) {
      return [...(windows.get(windowId) ?? [])].sort((a, b) => a.index - b.index);
    },

    async getCurrentWindow() {
      return { id: focusedWindowId, focused: true };
    },

    /** 假仓储里的窗口全是普通窗口 —— popup/devtools 窗口不在这个抽象的意义范围内。 */
    async listNormalWindows() {
      return windowOrder.map((id) => ({ id, focused: id === focusedWindowId }));
    },

    entryPageUrl() {
      return `${FAKE_EXTENSION_ORIGIN}${ENTRY_PAGE_PATH}`;
    },
    /**
     * index 0 表示"固定区最左"。
     *
     * `draggingTabIds` 里的 tab 会抛平台那句 "Tabs cannot be edited right now"，
     * 而且**只抛前两次** —— 用来证明重试确实会收敛，而不是把测试卡到重试上限。
     */
    async move(tabId, index) {
      if (dragging.has(tabId)) {
        const attempts = (draggingAttempts.get(tabId) ?? 0) + 1;
        draggingAttempts.set(tabId, attempts);
        if (attempts <= 2) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
      }
      for (const [windowId, tabs] of windows) {
        const at = tabs.findIndex((tab) => tab.id === tabId);
        if (at === -1) continue;
        const [picked] = tabs.splice(at, 1);
        if (!picked) continue;
        const target = index < 0 ? tabs.length : Math.min(index, tabs.length);
        tabs.splice(target, 0, picked);
        reindex(windowId);
        return;
      }
      throw new Error(`No such tab ${tabId}`);
    },

    async create(input: CreateTabInput): Promise<{ tabId: number; url: string }> {
      if (unopenable.has(input.url)) throw new Error(`Cannot create tab for ${input.url}`);
      const list = windows.get(input.windowId);
      if (!list) throw new Error(`No such window ${input.windowId}`);
      const tab: BrowserTab = {
        id: nextTabId++,
        windowId: input.windowId,
        url: input.url,
        title: `新建 ${input.url}`,
        active: input.active,
        pinned: input.pinned === true,
        index: input.index ?? list.length,
      };
      if (tab.index === undefined || tab.index > list.length) tab.index = list.length;
      list.splice(tab.index, 0, tab);
      // 一个窗口里只能有一个 active
      if (tab.active) for (const other of list) if (other !== tab) other.active = false;
      reindex(input.windowId);
      return { tabId: tab.id, url: tab.url };
    },

    async update(tabId, input) {
      for (const tabs of windows.values()) {
        const found = tabs.find((tab) => tab.id === tabId);
        if (!found) continue;
        if (input.url !== undefined) found.url = input.url;
        if (input.pinned !== undefined) found.pinned = input.pinned;
        if (input.active === true) {
          for (const other of tabs) other.active = other.id === tabId;
        }
        return { ...found };
      }
      throw new Error(`No such tab ${tabId}`);
    },

    async remove(tabIds): Promise<TabRemovalOutcome> {
      const outcome: TabRemovalOutcome = { closed: [], failed: [] };
      // 先记下"这一次被要求关哪些"，再动仓储 —— 记的是调用方交来的那份名单，
      // 不是成功关掉的那些。既有约定 那条判据要的正是前者。
      removeBatches.push([...tabIds]);
      for (const id of tabIds) {
        if (unremovable.has(id)) {
          outcome.failed.push({ tabId: id, error: 'Tab cannot be closed' });
          continue;
        }
        for (const [windowId, tabs] of windows) {
          const at = tabs.findIndex((tab) => tab.id === id);
          if (at === -1) continue;
          tabs.splice(at, 1);
          reindex(windowId);
          outcome.closed.push(id);
        }
        if (!outcome.closed.includes(id)) outcome.failed.push({ tabId: id, error: 'No such tab' });
      }
      return outcome;
    },

    async createWindow(input: {
      focused?: boolean;
      incognito?: boolean;
    }): Promise<BrowserWindow> {
      const incognito = input.incognito === true;
      if (incognito && incognitoDisallowed) {
        // 真实平台在这儿的报错（无痕授权没给）
        throw new Error('Cannot create incognito window: extension is not allowed in incognito');
      }
      const id = Math.max(...windowOrder, 0) + 1;
      windows.set(id, []);
      windowOrder.push(id);
      created.push({ id, incognito });
      if (input.focused !== false) focusedWindowId = id;
      return { id, focused: input.focused !== false };
    },

    async existingUrls(windowId) {
      return new Set((windows.get(windowId) ?? []).map((tab) => tab.url).filter(Boolean));
    },
  };

  return port;
}

/** StoragePort 的内存实现：直接复用真实适配器 + fakeBrowser。
 * 真实适配器已在 fakeBrowser 下跑通（test/storage-port.spec.ts），
 * 所以这里不再写第二份内存仓储 —— 两份实现会在细节上分叉。 */
