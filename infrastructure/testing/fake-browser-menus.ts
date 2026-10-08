/**
 * ContextMenusPort 的测试实现。
 *
 * 为什么不用 fakeBrowser 的事件：`@webext-core/fake-browser` 根本没有 `contextMenus` 这个
 * 命名空间（没实现即抛），而这一层要断言的恰恰是**注册了什么**——
 * 六项、各自的上下文、标题是哪门语言、`removeAll` 有没有在 `create` 之前。
 * 所以这里给的是一个**可观测的登记表 + 手动发射器**，与 `fake-browser-events.ts` 同一手法。
 */

import type { ContextMenusPort, MenuClickInfo, MenuCreateItem } from '@/core/ports/context-menus';
import type { MenuItemId } from '@/core/application/capture-scopes';

export interface FakeContextMenusPort extends ContextMenusPort {
  /** 当前这一轮注册着的项（`removeAll` 会清空它，所以它反映的是"用户现在右键能看见什么"）。 */
  readonly items: readonly MenuCreateItem[];
  /** `removeAll` 被调了几次。语言重建那条用例靠它判断"真的重建过"，而不是只改了标题。 */
  readonly removals: number;
  /** 模拟一次点击。`tab` 不给就是平台没带回标签页的那种情况。 */
  click(menuItemId: MenuItemId, tab?: { id: number; windowId: number }): Promise<void>;
}

export function createFakeContextMenusPort(): FakeContextMenusPort {
  let items: MenuCreateItem[] = [];
  let removals = 0;
  let handler: ((info: MenuClickInfo) => void | Promise<void>) | undefined;

  return {
    get items(): readonly MenuCreateItem[] {
      return items;
    },

    get removals(): number {
      return removals;
    },

    async create(item: MenuCreateItem): Promise<void> {
      // 平台不允许同 id 两项；这里跟着抛，免得测试里出现"注册了两次没人知道"
      if (items.some((existing) => existing.id === item.id)) {
        throw new Error(`重复的菜单项 id：${item.id}`);
      }
      items.push(item);
    },

    async removeAll(): Promise<void> {
      removals += 1;
      items = [];
    },

    onClicked(next: (info: MenuClickInfo) => void | Promise<void>): () => void {
      handler = next;
      return () => {
        handler = undefined;
      };
    },

    async click(menuItemId, tab) {
      if (!handler) throw new Error('background 还没订阅 contextMenus.onClicked');
      await handler({ menuItemId, tabId: tab?.id, windowId: tab?.windowId });
    },
  };
}
