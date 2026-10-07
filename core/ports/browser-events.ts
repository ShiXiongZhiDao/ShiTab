/**
 * 浏览器生命周期事件的边界接口。
 *
 * 单独成一个 port 而不是塞进 BrowserTabsPort：入口 T 的生命周期是**订阅**，
 * 而 BrowserTabsPort 全是**请求-响应**。混在一个接口里，单测就得给每个用例
 * 都实现一套事件发射器，而那些用例根本不在乎事件。
 *
 * 订阅返回退订函数（与 StoragePort 的 watch* 一致），background 停止时能拆干净。
 */

export interface TabRemovedInfo {
  tabId: number;
  windowId: number;
  /**
   * 整个窗口在关，因此这条 tab 才被移除。
   *
   * 必须区分：窗口关闭时补建一个 T 是纯粹的骚扰（平台在 onRemoved 里给了这个标志）。
   */
  isWindowClosing: boolean;
}

export interface LifecycleHandlers {
  /** 扩展安装/更新。 */
  onInstalled?(): void | Promise<void>;
  /** 浏览器启动（上一次会话的窗口已经恢复好）。 */
  onStartup?(): void | Promise<void>;
  onWindowCreated?(windowId: number): void | Promise<void>;
  /** 只用来清理窗口级的锁与计时器，防 Map 无界增长。 */
  onWindowRemoved?(windowId: number): void | Promise<void>;
  onTabRemoved?(info: TabRemovedInfo): void | Promise<void>;
}

export interface BrowserEventsPort {
  subscribe(handlers: LifecycleHandlers): () => void;
}
