/**
 * 分类的纯数据命令（既有约定：不开也不关 tab，所以在调用方进程内执行）。
 *
 * 分类只存在一个键里（整读整写），但会话的 `categoryId` 在**两处**：
 * `groups:index` 与各自的 `group:<id>` 键。所以任何会改变归属的命令都要两边一起写，
 * 否则会出现"index 说它在分类 A、group 键说没分类"的偏差 —— 那正是 既有约定 里
 * `tabCount` 需要自愈的同一类问题，只是这里没有自愈兜底：归属是用户显式选的，
 * 猜不出来，所以必须同轮写对。
 */

import type { StoragePort } from '@/core/ports/storage';
import type { Category, GroupIndexEntry } from '@/shared/types';
import {
  createCategory,
  isCategoryNameAcceptable,
  nextCategorySortOrder,
  normalizeCategoryName,
  orphanGroupsFromDeletedCategory,
  renumberCategories,
  touchCategory,
} from '@/core/domain/category';
import { moved, now } from '@/shared/utils';

export interface CategoryDeps {
  storage: StoragePort;
}

/** 分类不存在时统一抛这个，UI 按"分类已不存在"提示并刷新快照。 */
export class CategoryNotFoundError extends Error {
  constructor(readonly categoryId: string) {
    super(`分类不存在: ${categoryId}`);
  }
}

export class CategoryNameError extends Error {
  constructor(readonly reason: 'empty' | 'duplicate') {
    super(reason === 'empty' ? '分类名不能为空' : '已经有同名分类');
  }
}

async function requireCategories(deps: CategoryDeps): Promise<Category[]> {
  return deps.storage.listCategories();
}

export async function createCategoryCommand(
  deps: CategoryDeps,
  input: { name: string },
): Promise<Category> {
  const name = normalizeCategoryName(input.name);
  if (!isCategoryNameAcceptable(name)) throw new CategoryNameError('empty');
  const categories = await requireCategories(deps);
  if (categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
    // TabClip 也不允许重名：两个同名分类在左栏里是没法区分的两行
    throw new CategoryNameError('duplicate');
  }
  const created = createCategory({ name, sortOrder: nextCategorySortOrder(categories), at: now() });
  await deps.storage.setCategories([...categories, created]);
  return created;
}

export async function renameCategory(
  deps: CategoryDeps,
  input: { categoryId: string; name: string },
): Promise<Category[]> {
  const name = normalizeCategoryName(input.name);
  if (!isCategoryNameAcceptable(name)) throw new CategoryNameError('empty');
  const categories = await requireCategories(deps);
  const target = categories.find((category) => category.id === input.categoryId);
  if (!target) throw new CategoryNotFoundError(input.categoryId);
  if (
    categories.some(
      (category) =>
        category.id !== target.id && category.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw new CategoryNameError('duplicate');
  }
  const next = categories.map((category) =>
    category.id === target.id ? touchCategory({ ...category, name }, now()) : category,
  );
  await deps.storage.setCategories(next);
  return next;
}

/**
 * 删分类。里面的会话**退回未分类**，不跟着消失。
 *
 * 三步都要做：分类列表去掉它、index 里那批条目清掉引用、每个受影响 group 键也要清 ——
 * 只改 index 的话，下一次任何 putGroup 会把旧 categoryId 又带回 index。
 */
export async function deleteCategory(
  deps: CategoryDeps,
  input: { categoryId: string },
): Promise<{ released: number }> {
  const categories = await requireCategories(deps);
  if (!categories.some((category) => category.id === input.categoryId)) {
    throw new CategoryNotFoundError(input.categoryId);
  }
  await deps.storage.setCategories(categories.filter((category) => category.id !== input.categoryId));

  const entries = await deps.storage.listGroupIndex();
  const affected = entries.filter((entry) => entry.categoryId === input.categoryId);
  if (affected.length > 0) {
    await deps.storage.replaceGroupIndex(orphanGroupsFromDeletedCategory(entries, input.categoryId));
    for (const entry of affected) {
      const group = await deps.storage.getGroup(entry.id);
      if (!group || group.categoryId !== input.categoryId) continue;
      const { categoryId: _dropped, ...rest } = group;
      await deps.storage.putGroup(rest);
    }
  }
  return { released: affected.length };
}

/**
 * 分类拖拽排序：重写为稠密 0..n-1（与会话排序同一套规矩，既有约定 第 5 条）。
 *
 * 注意这里**不能**再用 `renumberCategories` 收尾：那个函数先按 sortOrder 排一遍再编号，
 * 而刚被 `moved` 挪过位置的数组里，sortOrder 还是旧的 —— 用它等于把用户拖的结果
 * 又按旧顺序排回去了（拖了个寂寞）。数组顺序就是意图，按下标重写即可。
 */
export async function reorderCategories(
  deps: CategoryDeps,
  input: { categoryId: string; toIndex: number },
): Promise<Category[]> {
  const categories = await requireCategories(deps);
  const ordered = renumberCategories(categories);
  const from = ordered.findIndex((category) => category.id === input.categoryId);
  if (from === -1) throw new CategoryNotFoundError(input.categoryId);

  const next = moved(ordered, from, input.toIndex).map((category, index) => ({
    ...category,
    sortOrder: index,
  }));
  await deps.storage.setCategories(next);
  return next;
}

/**
 * 把一个会话放进分类；`categoryId` 传 undefined 就是"取消归类"（回到未分类）。
 *
 * 幂等：已经在目标分类里时直接返回现状，不 bump updatedAt ——
 * 否则每次拖拽都会让"最近保存"的时间戳抖动。
 */
export async function assignGroupToCategory(
  deps: CategoryDeps,
  input: { groupId: string; categoryId?: string },
): Promise<GroupIndexEntry | undefined> {
  const { categoryId } = input;
  if (categoryId !== undefined) {
    const categories = await requireCategories(deps);
    if (!categories.some((category) => category.id === categoryId)) {
      throw new CategoryNotFoundError(categoryId);
    }
  }

  const group = await deps.storage.getGroup(input.groupId);
  if (!group) return undefined;
  const current = group.categoryId;
  if ((current ?? undefined) === (categoryId ?? undefined)) {
    const entries = await deps.storage.listGroupIndex();
    return entries.find((entry) => entry.id === group.id);
  }

  const next: typeof group = { ...group, updatedAt: now() };
  if (categoryId === undefined) delete next.categoryId;
  else next.categoryId = categoryId;
  await deps.storage.putGroup(next);
  const entries = await deps.storage.listGroupIndex();
  return entries.find((entry) => entry.id === group.id);
}
