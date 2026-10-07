/**
 * BrowserTabsPort 的实现。
 *
 * **只有一个文件**，不像 既有约定 §2 那样分
 * chrome-edge-tabs.ts / firefox-tabs.ts 两份 —— 因为 WXT 的 `browser` 对象本身就是
 * webextension-polyfill 形态的统一层，Chrome/Edge/Firefox 的差异（回调 vs Promise、
 * `windows` 与 `side_panel`/`sidebar_action` 的入口）已经在这里被抹平了。
 * 再套两份 adapter 文件只会是把同一个 API 换个名字抄两遍，而不是真的抽象。
 * 真正的差异留在 manifest 层（由 wxt.config.ts 与 entrypoint 自动处理）。
 */

import type { BrowserTabsPort, TabRemovalOutcome } from '@/core/ports/browser-tabs';
import type { BrowserTab, BrowserWindow } from '@/shared/types';
import { ENTRY_PAGE_PATH } from '@/shared/constants';

interface RawTab {
  id?: number;
  windowId?: number;
  index?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  active?: boolean;
  pinned?: boolean;
}

interface RawWindow {
  id?: number;
  focused?: boolean;
  /** 'normal' | 'popup' | 'devtools' | 'app' —— 只有 normal 是用户说"窗口"时指的东西 */
  type?: string;
}

function toBrowserTab(raw: RawTab): BrowserTab | undefined {
  // 没有 id 就无法操作它；没有 windowId 就无法归位。这两个缺一个就跳过，不猜。
  if (raw.id === undefined || raw.windowId === undefined) return undefined;
  const tab: BrowserTab = {
    id: raw.id,
    windowId: raw.windowId,
    url: raw.url ?? '',
    title: raw.title ?? '',
    active: raw.active === true,
    pinned: raw.pinned === true,
    index: raw.index ?? 0,
  };
  if (raw.favIconUrl) tab.favIconUrl = raw.favIconUrl;
  return tab;
}

function requireWindowId(raw: RawWindow | undefined, what: string): number {
  if (raw?.id === undefined) throw new Error(`无法解析${what}`);
  return raw.id;
}

export function createBrowserTabsPort(): BrowserTabsPort {
  return {
    async queryWindowTabs(windowId) {
      const raw = (await browser.tabs.query({ windowId })) as RawTab[];
      return raw.map(toBrowserTab).filter((tab): tab is BrowserTab => tab !== undefined);
    },

    async getCurrentWindow() {
      const raw = (await browser.windows.getCurrent()) as RawWindow;
      return { id: requireWindowId(raw, '当前窗口'), focused: raw.focused === true };
    },

    /**
     * 官方写法（Chrome windows 文档）：不传 windowTypes 时默认过滤是 `['normal','popup']`，
     * 所以取回全部再按 type 排除 popup —— 传已废弃的 `panel`/`app` 类型值才是被文档警告的用法。
     */
    async listNormalWindows() {
      const raw = (await browser.windows.getAll()) as RawWindow[];
      return raw
        .filter((window) => window.id !== undefined && (window.type ?? 'normal') === 'normal')
        .map((window) => ({ id: window.id as number, focused: window.focused === true }));
    },

    async create({ url, windowId, index, active, pinned }) {
      const created = (await browser.tabs.create({
        url,
        windowId,
        ...(index === undefined ? {} : { index }),
        active,
        // 入口 T 页靠这个字段被钉住。少传它的后果是"看起来一切正常、T 却是个普通宽标签页"，
        // 而手写的那份假 port 会照单收下这个字段 —— 所以这条由 adapter 测试钉住。
        ...(pinned === undefined ? {} : { pinned }),
      })) as RawTab;
      if (created.id === undefined) throw new Error('tabs.create 未返回 tab id');
      return { tabId: created.id, url: created.url ?? url };
    },

    async update(tabId, input) {
      const raw = (await browser.tabs.update(tabId, input)) as RawTab;
      const tab = toBrowserTab(raw);
      if (!tab) throw new Error(`tabs.update 返回了无法使用的 tab: ${tabId}`);
      return tab;
    },

    /**
     * index 用 -1 之类的相对位置不在这里支持：入口页只需要"最左侧"这一种。
     * 用户正在拖标签时平台会 reject，port **不**偷偷重试（见 port 注释）。
     */
    async move(tabId, index) {
      await browser.tabs.move(tabId, { index });
    },

    entryPageUrl() {
      return browser.runtime.getURL(ENTRY_PAGE_PATH);
    },

    /**
     * 逐个关，不用一次传数组。
     *
     * 平台在**任一** id 无效时会 reject 整个 `tabs.remove(ids)` 调用，那样拿不到
     * "关掉了 18 条、1 条没关掉"的计数，而 既有约定 §7 要求
     * "关闭失败不得删除已保存记录"。allSettled 让每条独立成败。
     */
    async remove(tabIds) {
      const settled = await Promise.allSettled(tabIds.map((id) => browser.tabs.remove(id)));
      const outcome: TabRemovalOutcome = { closed: [], failed: [] };
      settled.forEach((result, index) => {
        const tabId = tabIds[index];
        if (tabId === undefined) return;
        if (result.status === 'fulfilled') {
          outcome.closed.push(tabId);
        } else {
          outcome.failed.push({ tabId, error: errorMessage(result.reason) });
        }
      });
      return outcome;
    },

    async createWindow({ focused, incognito }) {
      const raw = (await browser.windows.create({
        focused,
        // 只在显式要求无痕时才带这个键：不带时是"没意见"，带了就是"必须无痕"，
        // 平台在扩展未被允许于无痕运行时会让这次调用失败（既有约定 要求如实报错）。
        ...(incognito === undefined ? {} : { incognito }),
      })) as RawWindow;
      return { id: requireWindowId(raw, '新建窗口'), focused: raw.focused === true };
    },

    async existingUrls(windowId) {
      const tabs = await this.queryWindowTabs(windowId);
      return new Set(tabs.map((tab) => tab.url).filter(Boolean));
    },
  };
}

export function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return JSON.stringify(reason) ?? '未知错误';
}
