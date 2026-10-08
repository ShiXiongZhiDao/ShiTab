/**
 * ContextMenusPort 的实现。
 *
 * 三件事只在这一处做，因为它们是**平台形状**而不是业务判据：
 *
 * 1. **`&` 转义。** 菜单标题里的 `&` 是助记键前缀，要显示一个字面 `&` 得写 `&&`
 *    （MDN `menus.create` 原文：`In effect, "&&" is used to display a single ampersand.`）。
 *    我们现在的 12 条文案里没有 `&`，这一步是防以后加 —— 所以转义放在**出口这一处**，
 *    不散进文案，也不散进调用方。
 * 2. **错误只有一个通道。** `contextMenus.create` 不返回 promise（本机类型：
 *    `function create(createProperties, callback?): number | string`），失败只在
 *    `runtime.lastError` 里露头，而 SW 里没人看日志就等于没发生。所以每个 create 都带回调、
 *    都把 lastError 打进 console.error —— 顶层 6 格那道上限时，这是唯一的现场证据。
 * 3. **`removeAll` 用 promise 形。** Chrome 123+ 起它可返回 promise（本机类型同一文件里两条重载都在），
 *    我们的注册顺序依赖它先完成，所以不能走回调形。
 */

import type { ContextMenusPort, MenuClickInfo, MenuCreateItem } from '@/core/ports/context-menus';
import type { MenuItemId } from '@/core/application/capture-scopes';

/** 标题交给平台前的最后一道处理。只在这一处，见文件头第 1 条。 */
export function escapeMenuTitle(title: string): string {
  return title.replaceAll('&', '&&');
}

/** 平台回调里的 `menuItemId` 是 `number | string`，我们只发过字符串 id。 */
function asItemId(raw: number | string): MenuItemId {
  return String(raw) as MenuItemId;
}

export function createContextMenusPort(): ContextMenusPort {
  return {
    create(item: MenuCreateItem): Promise<void> {
      return new Promise((resolve) => {
        try {
          browser.contextMenus.create(
            { id: item.id, title: escapeMenuTitle(item.title), contexts: [...item.contexts] },
            () => {
              const lastError = browser.runtime.lastError;
              if (lastError) {
                console.error('[shitab] 菜单项注册失败', item.id, lastError.message);
              }
              resolve();
            },
          );
        } catch (error) {
          // 平台在 API 不存在时（老 Firefox / 未声明权限）是同步抛，不是回调报错
          console.error('[shitab] 菜单注册异常', item.id, error);
          resolve();
        }
      });
    },

    async removeAll(): Promise<void> {
      try {
        await browser.contextMenus.removeAll();
      } catch (error) {
        console.error('[shitab] 清空菜单失败', error);
      }
    },

    onClicked(handler: (info: MenuClickInfo) => void | Promise<void>): () => void {
      const listener = (info: { menuItemId: number | string }, tab?: { id?: number; windowId?: number }): void => {
        const result = handler({
          menuItemId: asItemId(info.menuItemId),
          tabId: tab?.id,
          windowId: tab?.windowId,
        });
        // 处理器是 async：异常必须落日志，否则这一次点击就是"点了没反应"
        if (result instanceof Promise) {
          result.catch((error: unknown) => console.error('[shitab] 菜单点击处理失败', error));
        }
      };
      browser.contextMenus.onClicked.addListener(listener);
      return () => browser.contextMenus.onClicked.removeListener(listener);
    },
  };
}
