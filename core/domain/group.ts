/** 分组的不变量与派生。这里不碰 storage、不碰浏览器 API。 */

import type { GroupIndexEntry, SavedTab, TabGroup } from '@/shared/types';
import { MAX_TAB_GROUP_TITLE_LENGTH, MIN_TAB_GROUP_TITLE_LENGTH } from '@/shared/constants';
import { newId } from '@/shared/utils';

export function createGroup(input: {
  title: string;
  createdAt: number;
  sortOrder: number;
  sourceWindowId?: number;
  categoryId?: string;
  tabs?: SavedTab[];
}): TabGroup {
  const group: TabGroup = {
    id: newId(),
    title: normalizeTitle(input.title),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    isPinned: false,
    locked: false,
    sortOrder: input.sortOrder,
    tabs: [],
  };
  if (input.categoryId !== undefined) group.categoryId = input.categoryId;
  if (input.sourceWindowId !== undefined) group.sourceWindowId = input.sourceWindowId;
  const tabs = input.tabs ?? [];
  return tabs.length ? { ...group, tabs: renumberTabs(tabs, group.id) } : group;
}

/**
 * 标题清洗：去首尾空白、限长。**不做**"空标题自动补一个"——
 * 空标题是合法的（新建分组时就是空的，UI 显示 group_untitled）。
 */
export function normalizeTitle(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.slice(0, MAX_TAB_GROUP_TITLE_LENGTH);
}

export function isTitleAcceptable(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length >= MIN_TAB_GROUP_TITLE_LENGTH && trimmed.length <= MAX_TAB_GROUP_TITLE_LENGTH;
}

/** 任何改动都要过这里，保证 updatedAt 不会被漏掉。 */
export function touch(group: TabGroup, at: number): TabGroup {
  return { ...group, updatedAt: at };
}

export function toIndexEntry(group: TabGroup): GroupIndexEntry {
  const entry: GroupIndexEntry = {
    id: group.id,
    title: group.title,
    isPinned: group.isPinned,
    locked: group.locked === true,
    sortOrder: group.sortOrder,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    tabCount: group.tabs.length,
  };
  if (group.categoryId !== undefined) entry.categoryId = group.categoryId;
  if (group.sourceWindowId !== undefined) entry.sourceWindowId = group.sourceWindowId;
  return entry;
}

/**
 * 列表顺序：置顶优先，然后 **sortOrder 降序**，最后 createdAt 降序兜底。
 *
 * 降序是 既有约定 定的：收纳类工具最该看到的是**刚收进去的那一批**，
 * 而 `nextSortOrder()` 给的永远是 `max + 1`，所以"新会话落在最前"与"降序显示"
 * 是同一条规则的两面 —— 收纳路径不用为方向改任何东西。
 *
 * createdAt 兜底是必要的：两个分组可能因导入或自愈而拿到相同的 sortOrder，
 * 没有第三级比较符的话排序不稳定，用户会看到列表在刷新时自己跳动。
 *
 * ⚠ 方向是**这里**唯一的事实来源。任何"把显示位置翻译成 sortOrder"的地方都必须走
 * `sortOrderAtPosition()`，否则拖拽会弹回原位（升序/降序混用就是这个症状）。
 */
export function compareGroups(a: GroupIndexEntry, b: GroupIndexEntry): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return b.sortOrder - a.sortOrder;
  return b.createdAt - a.createdAt;
}

/**
 * 显示位置 -> sortOrder（降序列表里位置 0 拿最大值）。
 *
 * 单独成一个函数，是因为这个映射**不显然**：`reorderGroups` 若照升序的直觉写
 * `sortOrder: index`，用户拖完一次，列表就整个反过来了。
 */
export function sortOrderAtPosition(length: number, position: number): number {
  return length - 1 - position;
}

/**
 * "排到现有列表末尾"该用的 sortOrder（降序列表里 = 比当前最小值还小）。
 *
 * 空列表给 0。导入的组用它，才不会一导入就把用户自己的最新会话顶下去。
 */
export function tailSortOrder(entries: GroupIndexEntry[]): number {
  if (entries.length === 0) return 0;
  return Math.min(...entries.map((entry) => entry.sortOrder)) - 1;
}

/** 把 sortOrder 重写成稠密的 0..n-1。导入与自愈用。 */
export function renumberTabs(tabs: SavedTab[], groupId: string): SavedTab[] {
  return tabs.map((tab, index) => ({ ...tab, groupId, sortOrder: index }));
}

/**
 * 组内移动一条 tab。to 以"移除之后的坐标系"计算（与 shared/utils.moved 一致）。
 * 返回新的 tabs 数组与 sortOrder 已重写的结果。
 */
export function moveTabWithinGroup(group: TabGroup, fromId: string, to: number, at: number): TabGroup {
  const ordered = [...group.tabs].sort((a, b) => a.sortOrder - b.sortOrder);
  const from = ordered.findIndex((tab) => tab.id === fromId);
  if (from < 0) return group;

  const [picked] = ordered.splice(from, 1);
  if (!picked) return group;
  ordered.splice(Math.max(0, Math.min(ordered.length, to)), 0, picked);

  return touch({ ...group, tabs: renumberTabs(ordered, group.id) }, at);
}

/** 把一条 tab 从源组移到目标组。两边都要 bump updatedAt。 */
export function moveTabBetweenGroups(
  source: TabGroup,
  target: TabGroup,
  tabId: string,
  insertAt: number,
  at: number,
): { source: TabGroup; target: TabGroup; movedTab: SavedTab } | undefined {
  const tab = source.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || source.id === target.id) return undefined;

  const sourceOrdered = source.tabs.filter((candidate) => candidate.id !== tabId);
  const targetOrdered = [...target.tabs].sort((a, b) => a.sortOrder - b.sortOrder);
  targetOrdered.splice(Math.max(0, Math.min(targetOrdered.length, insertAt)), 0, tab);

  return {
    source: touch({ ...source, tabs: renumberTabs(sourceOrdered, source.id) }, at),
    target: touch({ ...target, tabs: renumberTabs(targetOrdered, target.id) }, at),
    movedTab: tab,
  };
}
