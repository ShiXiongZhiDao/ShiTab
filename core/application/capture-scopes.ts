/**
 * 收纳范围。
 *
 * ## 这一层只管一件事：给定锚点，哪些 tab 属于这次收纳
 *
 * 纯函数，不碰任何浏览器 API —— 锚点标签和窗口内的 tab 列表都由调用方查好传进来。
 * 这样"左侧到底含不含锚点自己"这种判据能直接钉成用例，而不是埋在事件回调里。
 *
 * ## 顺序：范围解析在 `isCapturableTab` **之前**
 *
 * 范围只改变"送进过滤器的集合"，**不改变过滤器本身**。入口页永不收纳（AC-06）、
 * 固定标签按 `includePinnedTabs`（V1.1 §5）、不可恢复的页面不收也不关——
 * 这三条对六个范围一视同仁，任何范围都不许绕过它们（既有约定 决定 6）。
 * 所以「收纳左侧」遇到 0 号位钉着的入口页时，结果是"不收它"，不是"报错"也不是"收进来"。
 * ⚠ 这三条**都写在 `domain/tab.isCapturableTab` 一处**，范围层不重复判任何一条；
 * 既有约定 之后范围收窄到只剩内部页时，落的是 `no-stashable-tabs` 那条既有出口。
 *
 * ## 为什么只有四个范围，而菜单有六项
 *
 * 「收纳所有窗口」不是一种范围，是**对每个 normal 窗口各跑一次**范围 = `window` 的收纳
 * （既有约定 决定 6 的补充格）：一个会话仍然只来自一个窗口，`sourceWindowId`、
 * 落地页、撤销条这些按窗口成立的判据一条都不必重写。代价如实记着 ——
 * 点一次可能在列表顶部留下 N 个未命名会话。
 */

import type { BrowserTab } from '@/shared/types';
import type { MessageKey } from '@/shared/i18n';

/** 一个窗口内的四种范围。`window` = 整窗，与图标左键同一条路径。 */
export type CaptureScope = 'window' | 'except-current' | 'left' | 'right';

/** 菜单项的 id。判别联合，新增一项忘了路由会编译不过（与 `shared/messages.ts` 的 Command 同法）。 */
export const MENU_ITEM_IDS = [
  'stash-window',
  'stash-except-current',
  'stash-left',
  'stash-right',
  'stash-all-windows',
  'open-workbench',
] as const;

export type MenuItemId = (typeof MENU_ITEM_IDS)[number];

export type MenuAction =
  | { kind: 'capture'; scope: CaptureScope }
  | { kind: 'capture-all-windows' }
  | { kind: 'open-workbench' };

export interface MenuEntry {
  id: MenuItemId;
  /** 标题的文案键。注册时按**当前生效语言**取，切换语言要重建（既有约定 决定 8）。 */
  titleKey: MessageKey;
  action: MenuAction;
}

/**
 * 工具栏图标右键菜单的顶层项上限 —— **6，超出会被静默丢弃**。
 *
 * 一手出处（`chrome.contextMenus` 参考页的 Properties 表）：
 * > `ACTION_MENU_TOP_LEVEL_LIMIT`: 6
 * > The maximum number of top level extension items that can be added to an extension action context menu.
 * > Any items beyond this limit will be ignored.
 *
 * ⚠ 这句**不用联网也能核**：本机 `node_modules/.pnpm/@wxt-dev+browser@0.3.4/…/src/gen/index.d.ts:2063`
 * 里就是 `const ACTION_MENU_TOP_LEVEL_LIMIT: 6;`，同一份文件 `:1968` 有 `ACTION = "action"`。
 * 这里自己写一份字面量而不是 import 那个 const，是因为测试跑在 fake 浏览器上、它没有这个成员。
 *
 * "静默丢弃"是这类限制里最坏的失败形状：网页右键那一侧不受这个数管
 * （多项会被浏览器自动折成以扩展名命名的父菜单），于是第 7 项加进来的那天，
 * 两处菜单悄悄少一格，没有任何报错。所以它钉在这里，由
 * `test/context-menu-scopes.spec.ts` 断言 `MENU_ENTRIES.length <= 6` ——
 * 加第 7 项的人会先撞红，而不是让用户撞缺。
 */
export const ACTION_MENU_TOP_LEVEL_LIMIT = 6;

/**
 * 六个菜单项，顺序即菜单里的顺序。
 *
 * 三项**故意不在这里**（既有约定 决定 3）：「此标签组」「所选标签页」「排除此网站」。
 * 不做的原因**不是做不到** —— `tabs.Tab.groupId` 与 `tabs.query({highlighted})` 都不需要
 * 新权限（被权限 gate 的字段只有 url/pendingUrl/title/favIconUrl 四个）。真正的原因是
 * 6 格已满，加上这两项的语义还没定（组里混着固定入口页怎么算、一个组跨窗口怎么算、
 * 多选了之后锚点是谁）。哪天要加，先回到 既有约定 决定 4 那道闸上做个决定。
 */
export const MENU_ENTRIES: readonly MenuEntry[] = [
  { id: 'open-workbench', titleKey: 'menu_open_workbench', action: { kind: 'open-workbench' } },
  { id: 'stash-window', titleKey: 'menu_stash_window', action: { kind: 'capture', scope: 'window' } },
  {
    id: 'stash-except-current',
    titleKey: 'menu_stash_except_current',
    action: { kind: 'capture', scope: 'except-current' },
  },
  { id: 'stash-left', titleKey: 'menu_stash_left', action: { kind: 'capture', scope: 'left' } },
  { id: 'stash-right', titleKey: 'menu_stash_right', action: { kind: 'capture', scope: 'right' } },
  { id: 'stash-all-windows', titleKey: 'menu_stash_all_windows', action: { kind: 'capture-all-windows' } },
];

/** 菜单项 id → 条目。回调里拿到的只有 id 字符串，所以查不到就是不该发生的事。 */
export function menuEntryOf(id: string): MenuEntry | undefined {
  return MENU_ENTRIES.find((entry) => entry.id === id);
}

/**
 * 锚点之前/之后的判据用 `index`，不用数组下标。
 *
 * 传进来的列表是"窗口内全部 tab 按浏览器中的实际顺序"（`queryWindowTabs` 的契约），
 * 两者通常一致，但**固定标签页**会让它们错开：`keepPinnedTabFirst` 会把入口页挪到 0 号位，
 * 而下标只反映"这份数组里排第几"。以浏览器给的 `index` 为准，用户看到的才是同一个"左边"。
 */
export function selectScopeTabs(
  tabs: readonly BrowserTab[],
  anchorTabId: number,
  scope: CaptureScope,
): BrowserTab[] {
  if (scope === 'window') return [...tabs];

  const anchor = tabs.find((tab) => tab.id === anchorTabId);
  // 锚点不在列表里 = 这次点击针对的标签已经不在了（用户右键的瞬间它被关掉）。
  // 返回空集，让调用方走 `no-stashable-tabs` 那条既有反馈，而不是拿"整窗"兜底 ——
  // 那会把用户没点的东西关掉，是最不该猜的一种情况。
  if (!anchor) return [];

  switch (scope) {
    case 'except-current':
      return tabs.filter((tab) => tab.id !== anchorTabId);
    case 'left':
      return tabs.filter((tab) => tab.index < anchor.index);
    case 'right':
      return tabs.filter((tab) => tab.index > anchor.index);
  }
}
