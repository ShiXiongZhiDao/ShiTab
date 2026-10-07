/**
 * 活浏览器 tab 的边界接口（既有约定 §4）。
 * 核心业务只依赖这个接口，UI 永远不直接调 browser.tabs.*。
 */

import type { BrowserTab, BrowserWindow, CreateTabInput, UpdateTabInput } from '@/shared/types';

export interface TabRemovalFailure {
  tabId: number;
  error: string;
}

export interface TabRemovalOutcome {
  closed: number[];
  failed: TabRemovalFailure[];
}

export interface CreatedTab {
  tabId: number;
  url: string;
}

export interface BrowserTabsPort {
  /** 某个窗口里的全部 tab，按浏览器中的实际顺序。 */
  queryWindowTabs(windowId: number): Promise<BrowserTab[]>;

  /**
   * "当前窗口"。
   *
   * 语义**依赖调用方是什么 surface**：扩展页面里 = 它自己所在的窗口；
   * V1.0 的 popup / sidepanel 里两者可能不同。V1.1 之后 UI 只剩一个整页工作台，
   * 所以这里定义明确：**入口页调它拿到的就是自己所在的那个窗口**。
   */
  getCurrentWindow(): Promise<BrowserWindow>;

  /**
   * 所有 normal 窗口的 id。
   *
   * 用于"每个窗口一个入口 T"的启动补齐。**不用** `windows.getAll({windowTypes:['panel'|'app']})`
   * 那类写法：被官方标废弃的是那两个**类型值**，参数本身在 MV3 仍然有效；
   * 不传 windowTypes 时默认过滤是 ['normal','popup']，所以要自己按 type 排除 popup。
   */
  listNormalWindows(): Promise<BrowserWindow[]>;

  create(input: CreateTabInput): Promise<CreatedTab>;
  update(tabId: number, input: UpdateTabInput): Promise<BrowserTab>;

  /**
   * 移动到窗口内指定位置。
   *
   * 用户正在拖标签时平台会 reject（"Tabs cannot be edited right now"），
   * 由调用方决定重试策略 —— port 不偷偷重试，否则测试里看到的时序和真实时序不一致。
   */
  move(tabId: number, index: number): Promise<void>;

  /**
   * 入口页的绝对 URL（`chrome-extension://<id>/app.html`）。
   *
   * `browser.runtime.getURL` 是平台能力，只在 adapter 里出现，domain 层不碰。
   * 无参数：路径是编译期字面量，让 WXT 生成的 `PublicPath` 类型帮忙把关
   * —— 入口页改名忘了同步这里会编译不过，而不是运行时 404。
   */
  entryPageUrl(): string;

  /**
   * 逐个关闭并汇报每条的结果。
   *
   * 不用 browser.tabs.remove(ids[]) 一次传数组：平台在**任一** id 无效时整个调用
   * 就 reject，那样拿不到"关掉了 18 条、1 条没关掉"这种计数，而
   * 既有约定 §7 要求"关闭失败不得删除已保存记录"。
   */
  remove(tabIds: number[]): Promise<TabRemovalOutcome>;

  createWindow(input: { focused?: boolean; incognito?: boolean }): Promise<BrowserWindow>;

  /** 某个窗口里现有的 URL 集合，恢复去重用。 */
  existingUrls(windowId: number): Promise<Set<string>>;
}
