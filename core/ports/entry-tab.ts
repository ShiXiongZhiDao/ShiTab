/**
 * 入口标签页（标签栏那个 T）的边界接口。
 *
 * 收纳用例只想知道"这个窗口现在有没有一个能落脚的页面"，
 * 不想知道 pinned/index/去重/重试这些生命周期细节 —— 那些属于 pinned-entry-tab。
 */

export interface EntryTabPort {
  /**
   * 保证该窗口有一个入口页，并按需聚焦它。
   *
   * 返回 **是否真的有落脚页**：false 时调用方必须改变行为
   * （收纳不能把窗口里最后一条 tab 关掉 —— 那会连窗口一起关，
   * 入口页跟着消失，用户"点一下就没了"）。
   */
  ensureForWindow(windowId: number, opts?: { focus?: boolean }): Promise<boolean>;
}
