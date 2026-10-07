/**
 * 测试用的"造一个空会话"。
 *
 * 生产代码里**没有**新建空会话的入口了（V1.2 真机第二轮按用户要求删掉"新建会话"按钮，
 * 既有约定），所以这个动作只活在测试里。走 domain 的 `createGroup` + `putGroup`，
 * 与收纳路径用的是同一个工厂 —— 假数据不会跟真实形状分叉。
 *
 * `sortOrder` 默认接在现有列表之后（`max + 1`）：列表是最新在前，
 * 所以"后建的排在前面"这件事在测试里也必须成立，否则测不出方向。
 */

import { createGroup } from '@/core/domain/group';
import { isRestorableUrl } from '@/core/domain/tab';
import type { StoragePort } from '@/core/ports/storage';
import type { SavedTab, TabGroup } from '@/shared/types';

export async function putEmptyGroup(
  storage: StoragePort,
  input: {
    title: string;
    sortOrder?: number;
    categoryId?: string;
    at?: number;
    tabs?: SavedTab[];
  },
): Promise<TabGroup> {
  const index = await storage.listGroupIndex();
  const fallbackOrder = index.length === 0 ? 0 : Math.max(...index.map((entry) => entry.sortOrder)) + 1;
  const group = createGroup({
    title: input.title,
    createdAt: input.at ?? Date.now(),
    sortOrder: input.sortOrder ?? fallbackOrder,
    ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
    ...(input.tabs === undefined ? {} : { tabs: input.tabs }),
  });
  await storage.putGroup(group);
  return group;
}

/**
 * 一条 `SavedTab`。字段形状与收纳路径同源（`restorable` 走 `isRestorableUrl`），
 * 所以拿它造出来的数据不会因为"测试自己写了一份"而和生产分叉。
 */
export function savedTabFixture(groupId: string, id: string, sortOrder: number): SavedTab {
  const url = `https://example${sortOrder % 7}.com/path/${groupId}/${id}?q=query-value`;
  return {
    id,
    groupId,
    url,
    title: `页面标题 ${id} with a reasonably long document title here`,
    faviconUrl: `https://example${sortOrder % 7}.com/favicon.ico`,
    domain: `example${sortOrder % 7}.com`,
    createdAt: 1_700_000_000_000 + sortOrder,
    sortOrder,
    originalIndex: sortOrder,
    originalPinned: false,
    wasActive: sortOrder === 0,
    closeState: 'closed',
    restorable: isRestorableUrl(url),
  };
}

/**
 * 一个会话。走 `createGroup`，与收纳路径同一个工厂。
 *
 * 传 `overrides.id` 时会把里面每条 tab 的 `groupId` 一起改写 ——
 * `createGroup` 内部按它自己生成的 id 去 `renumberTabs`，只换外层 id 会造出
 * "tab 说自己属于另一个组"的假形状，而这种形状在真实数据里不存在，
 * 拿它做删除/恢复的用例只会测到一个不存在的 bug。
 */
export function groupFixture(
  title: string,
  tabs: SavedTab[],
  overrides: Partial<TabGroup> = {},
  at = 1_700_000_000_000,
): TabGroup {
  const created = createGroup({ title, createdAt: at, sortOrder: overrides.sortOrder ?? 0, tabs });
  const merged: TabGroup = { ...created, ...overrides };
  if (merged.id !== created.id) {
    merged.tabs = merged.tabs.map((tab) => ({ ...tab, groupId: merged.id }));
  }
  return merged;
}
