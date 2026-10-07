/**
 * 纯数据命令（既有约定：在调用方进程内执行，不开也不关任何 tab）。
 *
 * 每一条都是"读组 -> 用 domain 的不变量改 -> putGroup"，因此可单测、不依赖消息层。
 */

import type { StoragePort } from '@/core/ports/storage';
import type { GroupIndexEntry, TabGroup } from '@/shared/types';
import { compareGroups, isTitleAcceptable, moveTabBetweenGroups, moveTabWithinGroup, normalizeTitle, renumberTabs, sortOrderAtPosition, touch } from '@/core/domain/group';
import { moved, now } from '@/shared/utils';
import { mergeIntoTrash, softDeleteGroup } from '@/core/application/delete-model';

/**
 * 这里**没有** `tabs` —— 这一层是纯数据命令，不开也不关任何 tab。
 * 曾经有个 `addCurrentTabToGroup` 需要它，那条能力连同入口一起在真机第七轮删掉了。
 */
export interface CommandDeps {
  storage: StoragePort;
}

/** 找不到组时统一抛这个，UI 按"记录已不存在"提示并刷新快照。 */
export class GroupNotFoundError extends Error {
  constructor(readonly groupId: string) {
    super(`分组不存在: ${groupId}`);
  }
}

/**
 * 会话被锁定时的一切写操作都抛这个。
 *
 * 锁的语义照 TabClip 的实测行为定：**写保护**，不是"防被收纳"也不是"防被清空"。
 * 被它挡住的是：删除会话、删单条记录、组内重排、跨组移动、组间拖拽排序。
 * 不挡：改名与取消锁定（否则用户会被自己的锁关在外面）。
 */
export class GroupLockedError extends Error {
  constructor(readonly groupId: string) {
    super(`会话已锁定，不能这样修改: ${groupId}`);
  }
}

function assertUnlocked(group: TabGroup): void {
  if (group.locked) throw new GroupLockedError(group.id);
}

async function requireUnlockedGroup(deps: CommandDeps, groupId: string): Promise<TabGroup> {
  const group = await requireGroup(deps, groupId);
  assertUnlocked(group);
  return group;
}

async function requireGroup(deps: CommandDeps, groupId: string): Promise<TabGroup> {
  const group = await deps.storage.getGroup(groupId);
  if (!group) throw new GroupNotFoundError(groupId);
  return group;
}

export async function renameGroup(deps: CommandDeps, input: { groupId: string; title: string }): Promise<TabGroup> {
  const title = normalizeTitle(input.title);
  if (!isTitleAcceptable(title)) throw new Error('分组标题不能为空');
  const group = await requireGroup(deps, input.groupId);
  const next = touch({ ...group, title }, now());
  await deps.storage.putGroup(next);
  return next;
}

/**
 * 用户点删除 = **软删除**。会话进回收站、留一条墓碑，7 天内可还原。
 *
 * 这一改动对同步之前和同步之后同时成立，是刻意的：如果只有开了同步才软删除，
 * 那同一个按钮就有两种不可逆程度，而"我关了同步所以这次删不掉回来"没人会想到。
 * 锁定仍然挡在这里面：`requireUnlockedGroup` 没过就不会走到这一步。
 */
export async function deleteGroup(deps: CommandDeps, input: { groupId: string }): Promise<void> {
  await requireUnlockedGroup(deps, input.groupId);
  await softDeleteGroup(deps, { groupId: input.groupId, reason: 'user-delete', at: now() });
}

export async function deleteTab(deps: CommandDeps, input: { groupId: string; tabId: string }): Promise<TabGroup> {
  const group = await requireUnlockedGroup(deps, input.groupId);
  const tabs = group.tabs.filter((tab) => tab.id !== input.tabId);
  if (tabs.length === group.tabs.length) throw new Error('分组里找不到这条记录');
  const next = touch({ ...group, tabs: renumberTabs(tabs, group.id) }, now());
  await deps.storage.putGroup(next);
  return next;
}

/**
 * 用户从会话里删掉**一条记录**（行上那颗 ×）⇒ 那一条同时进回收站。
 *
 * 指令原文 2026-10-05：「标签组里的标签删除也要进回收站」。粒度史是三步：0063 只做到整组，
 * 0076 把"恢复掉的单条"接进来，这一条补上"用户主动删的单条"。从此"删除"这个动作
 * 不管按在整组还是按在单条上，都有 7 天反悔 —— 而 0063 的立项理由（同一个按钮
 * 在同步开关前后不可逆程度不同 = 最容易丢数据的形状）正好覆盖这一条。
 *
 * **失败时回收站一行都不许写**，这一条有用例钉着（`锁定的会话…回收站一条都不写`、
 * `记录不存在 ⇒ 抛错且不写回收站`）。守住它的是两道前置检查（锁、以及这条记录在不在）
 * **加上**"先摘除、再入站"这个顺序 —— 顺序在这里是第二层防御：`deleteTab` 自己还会再查一次锁，
 * 所以把 `mergeIntoTrash` 挪到前面**现在**测不出红。将来谁把前置检查挪走或改宽，
 * 反过来做的那一版就会留下一条"同时活在会话里和回收站里"的记录，
 * 还原它等于往会话里塞一个重复项（同一条理由见 `restore-group.ts` 的单条恢复那处）。
 * 中间崩溃的代价是"这一条没进回收站"，那是破坏性最小的那种失败。
 *
 * 会话本身仍在列表里，所以这里只并一条记录进去（`mergeIntoTrash` 会并到同一行 ——
 * 同一个会话连着删三条只在回收站占**一行**，见 既有约定 那条判据）。
 * 与记录级的其它动作一样，这一步**不产生组墓碑**（会话还剩记录，留组墓碑等于
 * 让另一台设备把整个会话删掉），也**不指望跨设备传播**（既有约定：记录级不传播）。
 */
export async function removeTabToTrash(
  deps: CommandDeps,
  input: { groupId: string; tabId: string },
): Promise<TabGroup> {
  const group = await requireUnlockedGroup(deps, input.groupId);
  const record = group.tabs.find((tab) => tab.id === input.tabId);
  if (!record) throw new Error('分组里找不到这条记录');

  const next = await deleteTab(deps, input);
  await mergeIntoTrash(deps, { group, tabs: [record], reason: 'user-delete', at: now() });
  return next;
}

export async function togglePin(deps: CommandDeps, input: { groupId: string }): Promise<TabGroup> {
  const group = await requireGroup(deps, input.groupId);
  const next = touch({ ...group, isPinned: !group.isPinned }, now());
  await deps.storage.putGroup(next);
  return next;
}

/**
 * 上锁 / 解锁。**故意不做成 assertUnlocked 的一部分** ——
 * 一个"锁上了就再也解不开"的开关是陷阱，不是保护。
 */
export async function toggleLock(deps: CommandDeps, input: { groupId: string }): Promise<TabGroup> {
  const group = await requireGroup(deps, input.groupId);
  const next = touch({ ...group, locked: !group.locked }, now());
  await deps.storage.putGroup(next);
  return next;
}

/**
 * 组间拖拽（第 2 轮待决第 7 条的定案）。
 *
 * 两条轴分开：`isPinned` 决定落在哪个区，`sortOrder` 决定区内顺序。
 * 因此**不允许把未置顶的组拖进置顶区**（反之亦然）—— 否则视觉上会弹回去，
 * 用户以为是 bug。toIndex 以"移除之后的可见顺序"为坐标系。
 */
export async function reorderGroups(
  deps: CommandDeps,
  input: { groupId: string; toIndex: number },
): Promise<GroupIndexEntry[]> {
  const entries = await deps.storage.listGroupIndex();
  const ordered = [...entries].sort(compareGroups);
  const from = ordered.findIndex((entry) => entry.id === input.groupId);
  if (from === -1) throw new GroupNotFoundError(input.groupId);
  // 锁定包含"不参与拖拽排序"：一个会被随手挪走的锁，挡不住误操作
  if (ordered[from]?.locked) throw new GroupLockedError(input.groupId);

  const dragged = ordered[from];
  const target = ordered[Math.max(0, Math.min(ordered.length - 1, input.toIndex))];
  if (!dragged || !target) return ordered;
  if (dragged.isPinned !== target.isPinned) return ordered; // 跨区，静默拒绝

  const nextOrder = moved(ordered, from, input.toIndex);
  // 降序列表：显示位置要反着翻译成 sortOrder，否则拖完一次整个反过来
  const rewritten = nextOrder.map((entry, index) => ({
    ...entry,
    sortOrder: sortOrderAtPosition(nextOrder.length, index),
  }));
  await deps.storage.replaceGroupIndex(rewritten);
  return [...rewritten].sort(compareGroups);
}

/** 组内 tab 拖拽。 */
export async function reorderTab(
  deps: CommandDeps,
  input: { groupId: string; tabId: string; toIndex: number },
): Promise<TabGroup> {
  const group = await requireUnlockedGroup(deps, input.groupId);
  const next = moveTabWithinGroup(group, input.tabId, input.toIndex, now());
  await deps.storage.putGroup(next);
  return next;
}

/** 跨组移动 tab（既有约定 的空组填充手段之一）。锁定的组两头都不参与。 */
export async function moveTab(
  deps: CommandDeps,
  input: { tabId: string; fromGroupId: string; toGroupId: string; insertAt: number },
): Promise<{ source: TabGroup; target: TabGroup } | undefined> {
  if (input.fromGroupId === input.toGroupId) return undefined;
  const source = await requireUnlockedGroup(deps, input.fromGroupId);
  const target = await requireUnlockedGroup(deps, input.toGroupId);

  const result = moveTabBetweenGroups(source, target, input.tabId, input.insertAt, now());
  if (!result) return undefined;

  await deps.storage.putGroup(result.source);
  await deps.storage.putGroup(result.target);
  return { source: result.source, target: result.target };
}
