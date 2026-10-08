/**
 * 分类（category）的不变量与派生。这里不碰 storage、不碰浏览器 API。
 *
 * 形状是**多对一**：一个会话至多属于一个分类，`TabGroup.categoryId` 缺失就是"未分类"。
 * 没做 `categoryIds[]` 是因为 V1 没有任何"同一批 tab 同时属于两个分类"的场景，
 * 而多对多要额外维护一张归属表，左栏计数、拖拽改归属、导入导出都会跟着变复杂。
 */

import type { Category, CategoryFilter, GroupIndexEntry } from '@/shared/types';
import { MAX_CATEGORY_NAME_LENGTH, MIN_CATEGORY_NAME_LENGTH } from '@/shared/constants';
import { newId } from '@/shared/utils';

/**
 * 名字清洗：去首尾空白、限长。**不做**"空名自动补一个"——
 * 空名在建类时会被 isCategoryNameAcceptable 拒掉，不是合法输入。
 */
export function normalizeCategoryName(raw: string): string {
  return raw.trim().slice(0, MAX_CATEGORY_NAME_LENGTH);
}

export function isCategoryNameAcceptable(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed.length >= MIN_CATEGORY_NAME_LENGTH && trimmed.length <= MAX_CATEGORY_NAME_LENGTH
  );
}

export function createCategory(input: { name: string; sortOrder: number; at: number }): Category {
  return {
    id: newId(),
    name: normalizeCategoryName(input.name),
    sortOrder: input.sortOrder,
    createdAt: input.at,
    updatedAt: input.at,
  };
}

export function touchCategory(category: Category, at: number): Category {
  return { ...category, updatedAt: at };
}

/**
 * 左栏顺序：sortOrder 优先，createdAt 兜底（两组意外同序时列表不该在刷新时自己跳动），
 * 最后 `id`。第三级同样是 2026-10-08 为**摘要**补的：分类的数组顺序进 `stateChecksum`
 * ，前两级全相等时若退回落盘先后，两台机器会把同一堆内容算成两份状态。
 */
export function compareCategories(a: Category, b: Category): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 新分类排到末尾。空列表时是 0。 */
export function nextCategorySortOrder(categories: Category[]): number {
  if (categories.length === 0) return 0;
  return Math.max(...categories.map((category) => category.sortOrder)) + 1;
}

/** 把 0..n-1 稠密重写（拖拽排序后调用，与 既有约定 第 5 条对组的处理一致）。 */
export function renumberCategories(categories: Category[]): Category[] {
  return [...categories].sort(compareCategories).map((category, index) => ({
    ...category,
    sortOrder: index,
  }));
}

/**
 * 拖拽落点 -> `reorderCategories` 要的 `toIndex`。
 *
 * 两个坐标系必须换算，差一格就是"每次移动都偏一位"：
 * - `slot` 是**指针算出来的插入缝**：n 行有 n+1 个缝，被拖的那一行也算在内（0..n）。
 * - `toIndex` 是 `moved()` 要的**抽走之后的插入位**：n 行只有 0..n-1，被拖的那条已经不在里面。
 *
 * 缝在自身之下时（slot > from），抽走会让目标位置左移一格，所以要 -1；之上不用调。
 * 落在自己上边或下边那条缝（slot === from 或 from + 1）都是"没动"，返回 -1，
 * 调用方据此**跳过写入** —— 一次没改变任何顺序的拖拽不该重写整张分类表、
 * 也不该 bump updatedAt 让别的窗口跟着刷新。
 */
export function categoryDropIndex(from: number, slot: number): number {
  if (slot === from || slot === from + 1) return -1;
  return slot > from ? slot - 1 : slot;
}

/** 返回排好序的**新数组**（左栏渲染用）。 */
export function sortedCategories(categories: Category[]): Category[] {
  return [...categories].sort(compareCategories);
}

export function matchesFilter(entry: GroupIndexEntry, filter: CategoryFilter): boolean {
  if (filter.kind === 'all') return true;
  if (filter.kind === 'uncategorized') return entry.categoryId === undefined;
  return entry.categoryId === filter.id;
}

/** 每个分类里有多少个会话；未分类单独给一个数（左栏那两行系统项要用）。 */
export function countByCategory(entries: GroupIndexEntry[]): {
  perCategory: Map<string, number>;
  uncategorized: number;
} {
  const perCategory = new Map<string, number>();
  let uncategorized = 0;
  for (const entry of entries) {
    if (entry.categoryId === undefined) {
      uncategorized += 1;
      continue;
    }
    perCategory.set(entry.categoryId, (perCategory.get(entry.categoryId) ?? 0) + 1);
  }
  return { perCategory, uncategorized };
}

/**
 * 删分类时的连带处理：分类没了，里面的会话**退回未分类**而不是跟着被删。
 *
 * 这是收纳工具的信任底线 —— 用户删的是一个文件夹标签，不是里面装着的东西。
 */
export function orphanGroupsFromDeletedCategory(
  entries: GroupIndexEntry[],
  categoryId: string,
): GroupIndexEntry[] {
  return entries.map((entry) =>
    entry.categoryId === categoryId ? { ...entry, categoryId: undefined } : entry,
  );
}

/** 分类被删掉后，会话上的悬空引用同样按未分类处理（自愈与读时都会用到）。 */
export function isDanglingCategory(categoryId: string | undefined, categories: Category[]): boolean {
  return categoryId !== undefined && !categories.some((category) => category.id === categoryId);
}
