/**
 * 浏览器原生右键菜单的边界接口。
 *
 * 单独成一个 port 而不是在 background 里直接调 `browser.contextMenus.*`，理由与
 * `shared/services.ts` 里 webdav/alarm 那两条一样：**自己 new 就测不到**。
 * 这一层的价值恰恰是"注册了哪几项、各挂在哪个上下文、点之后路由到哪个动作"，
 * 而那三件事必须能在用例里被读出来（`test/context-menu-scopes.spec.ts`）。
 *
 * ## 两个必须知道的平台事实
 *
 * 1. `'all'` **包含** `'action'`。官方 ContextType 原文：
 *    > Specifying 'all' is equivalent to the combination of all other contexts except for 'launcher' and 'tab'.
 *    而 `'action'` 是 `Applies to the context menu of the extension's action (its toolbar icon).`
 *    ⇒ 这里显式写 `['page', 'action']` 而不是图省事写 `['all']`：`all` 会把 `selection` / `link` /
 *    `image` / `editable` 也带上，而我们的项跟那些上下文无关，多一处出现就多一处解释不了的位置。
 * 2. 工具栏图标那一侧的顶层项上限是 6，超出**静默丢弃**（见
 *    `core/application/capture-scopes.ts` 里的 `ACTION_MENU_TOP_LEVEL_LIMIT`）。
 *
 * `removeAll` 先于 `create` 是幂等的前提：SW 每次唤醒都会走一遍注册（菜单项**不保证**跨
 * 浏览器重启存活），不先清就会在更新/重载之后堆出重复项。
 */

import type { MenuItemId } from '@/core/application/capture-scopes';

/** 菜单出现的上下文。只用到这两个，`'all'` 故意不用，理由见文件头第 1 条。 */
export type MenuContext = 'page' | 'action';

export interface MenuCreateItem {
  id: MenuItemId;
  title: string;
  /**
   * 非空元组：平台那个字段声明成 `[ContextType, ...ContextType[]]`，
   * 传一个普通数组过去会被判"证明不了至少有一项"（实测 TS2322）。
   * 而"注册了一项但哪个上下文都没有"本来就是我们不要的状态。
   */
  contexts: readonly [MenuContext, ...MenuContext[]];
}

/**
 * 点击回调带回来的定位信息。
 *
 * 只取我们判据用得上的两个 id。**锚点 = 这一次点击所在的那个标签页**（既有约定 决定 5）：
 * 网页右键时它是被右键那页的标签，图标右键时它是该窗口的活动标签 —— 两处都由平台给出，
 * 我们自己不去算"当前标签"，那会造出第二个真相。
 *
 * `tab` 可能缺失：官方签名里它允许为空（例如在某些非文档页上），所以是可选的。
 */
export interface MenuClickInfo {
  menuItemId: MenuItemId;
  tabId?: number;
  windowId?: number;
}

export interface ContextMenusPort {
  create(item: MenuCreateItem): Promise<void>;
  removeAll(): Promise<void>;
  /** 返回退订函数，与 `BrowserEventsPort.subscribe` 同形。 */
  onClicked(handler: (info: MenuClickInfo) => void | Promise<void>): () => void;
}
