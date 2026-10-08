/**
 * 「恢复到这一版」= **替换**，不是并入。
 *
 * 起因是真机：他恢复第 15 版，工作台从 35 条掉到 16 条、**又自己弹回 35 条**。
 * 探针复现出的机制不是抖动，是确定行为：
 * `restoreFromSnapshot` 原来只做一次本地写入（把那一版落盘）+ 标脏，
 * 而下一轮同步走的是**实体级 LWW**（既有约定 比 `updatedAt`）——
 * 那一版里每一条的 `updatedAt` 都比现在的旧 ⇒ 每一条都输 ⇒ 合并结果又变回最新那版。
 * 更糟的是那一轮的出口是 `no-changes`：**什么都没推上去**，远端不留任何痕迹。
 * 也就是说这个按钮今天的效果是"闪一下就被冲掉"。
 *
 * 所以恢复必须是一次**前进**（Git 的 revert 语义：不是把指针挪回去，而是新造一版"就是那个样子"），
 * 需要两件事，缺一不可：
 *
 * 1. **抬时间戳**：带回来的每一条把 `updatedAt` 写成"现在"，否则 LWW 判它输。
 * 2. **给多出来的写墓碑**：现在有、那一版没有的那些必须留下"被删了"的证据，
 *    否则对面/下一轮合并会按"另一边根本没见过它"把它原样并回来（`merge.ts` 明写：
 *    墓碑是"删了"与"没见过"的唯一区别）。
 *
 * ⚠ 一处**已知做不到**的边界（不是遗漏，是协议里没有"撤销删除"这件东西）：
 * 那一版里有、而之后被删掉并同步出去的那些会话，远端仍然带着墓碑。
 * 抬到"现在"之后，`updatedAt > deletedAt` 正好落进 既有约定 那一格
 * ——「一边删了、另一边在删之后又改了」⇒ **交回用户裁决**（冲突对话框选「保留会话」就回来）。
 * 这是既签机制在替我们做事，不是 bug；确认文案里把这条数量先报给他（`askedBack`）。
 * 回收站那一行同理，而且那边是**静默**抑制（`mergeTrash` 里 marker 不早于行就丢），
 * 所以那一版之后被处理掉的回收站行可能回不来 —— 记在 既有约定 的代价里，不假装。
 */

import type { StoredState, TabGroup, Tombstone, TrashEntry } from '@/shared/types';
import { newId } from '@/shared/utils';
import { trashOf } from '@/core/domain/merge';

/** 确认文案要用的四个数：让用户在点下去之前就知道会少什么、会问什么。 */
export interface RestorePlanCounts {
  /** 那一版会带回来的会话数。 */
  broughtSessions: number;
  /** 现在多出来、会被删掉的会话数（不进回收站，理由见 `REVERTED_ENTERS_TRASH`）。 */
  removedSessions: number;
  /** 其中"那一版之后已被删除并同步出去"的会话数：恢复完会进冲突列表问他一句。 */
  askedBack: number;
  /** 现在多出来、会被删掉的分类与回收站行数。 */
  removedCategories: number;
  removedTrashRows: number;
}

export interface RestorePlan {
  state: StoredState;
  counts: RestorePlanCounts;
}

/**
 * 恢复时被删掉的会话**不进回收站**。
 *
 * 不是省事：这一格的动作是"本机换成那一版"，往里塞一批回收站行等于同时发明第二个动作，
 * 而且那一版本来的回收站会被这批新行污染（"恢复到第 15 版"的结果里出现 15 版没有的行）。
 * 他真要把那几条捞回来的路径是存在的：**历史不可变，再恢复到最新那一版就行**。
 */
const REVERTED_ENTERS_TRASH = false;

function marker(input: {
  entityType: Tombstone['entityType'];
  entityId: string;
  at: number;
  deviceId: string;
}): Tombstone {
  return {
    id: newId(),
    entityType: input.entityType,
    entityId: input.entityId,
    deletedAt: input.at,
    deletedByDeviceId: input.deviceId,
    reason: 'reverted',
  };
}

function keyOf(entityType: Tombstone['entityType'], entityId: string): string {
  return `${entityType}:${entityId}`;
}

/**
 * 算出"恢复这一版"之后本机该是什么样子。
 *
 * 纯函数：不读存储、不发请求。`current` 由调用方读好传进来 ——
 * 确认文案要在**点下去之前**就把四个数报出来，那时候也得用它。
 */
export function planRestore(input: {
  current: StoredState;
  restored: StoredState;
  deviceId: string;
  at: number;
}): RestorePlan {
  const { current, restored, deviceId, at } = input;

  const groups: TabGroup[] = restored.groups.map((group) => ({ ...group, updatedAt: at }));
  const categories = restored.categories.map((category) => ({ ...category, updatedAt: at }));
  const trash: TrashEntry[] = trashOf(restored);

  const groupIds = new Set(groups.map((group) => group.id));
  const categoryIds = new Set(categories.map((category) => category.id));
  const trashIds = new Set(trash.map((entry) => entry.group.id));

  const tombstones: Tombstone[] = [];
  // 那一版自己的账：只留"这一版里确实没有这个实体"的那些。
  // 留着自相矛盾的一条（实体在、墓碑也在）只会让下一轮凭空多出一个 delete-vs-edit 冲突。
  for (const existing of restored.tombstones) {
    const survives =
      (existing.entityType === 'group' && groupIds.has(existing.entityId)) ||
      (existing.entityType === 'category' && categoryIds.has(existing.entityId)) ||
      (existing.entityType === 'trash' && trashIds.has(existing.entityId));
    if (!survives) tombstones.push(existing);
  }
  for (const group of current.groups) {
    if (!groupIds.has(group.id)) {
      tombstones.push(marker({ entityType: 'group', entityId: group.id, at, deviceId }));
    }
  }
  for (const category of current.categories) {
    if (!categoryIds.has(category.id)) {
      tombstones.push(marker({ entityType: 'category', entityId: category.id, at, deviceId }));
    }
  }
  for (const entry of trashOf(current)) {
    if (!trashIds.has(entry.group.id)) {
      tombstones.push(marker({ entityType: 'trash', entityId: entry.group.id, at, deviceId }));
    }
  }

  // 问他一句的那几条：账上已经有它的墓碑（那一版之后被删掉并同步出去了），
  // 而这一版把它带回来 ⇒ 抬到"现在"之后正好落进 既有约定 的 delete-vs-edit。
  const deletedGroups = new Set(
    [...current.tombstones, ...restored.tombstones]
      .filter((tombstone) => tombstone.entityType === 'group')
      // ★ `reverted` 的那几条不会问他（既有约定：那是上一次恢复自己写的账，不是用户删的），
      // 所以**不许算进预告**。算进去的表现是：屏幕上说"会先问你一句"，按下去什么都没问 ——
      // 一句多报的预告和漏报一样是把界面说的话变成假话。
      .filter((tombstone) => tombstone.reason !== 'reverted')
      .map((tombstone) => tombstone.entityId),
  );
  const askedBack = groups.filter((group) => deletedGroups.has(group.id)).length;

  const keptGroupIds = new Set(current.groups.map((group) => group.id));
  const keptCategoryIds = new Set(current.categories.map((category) => category.id));
  const keptTrashIds = new Set(trashOf(current).map((entry) => entry.group.id));
  const count = (wanted: Set<string>, pool: { has(id: string): boolean }) => [...wanted].filter((id) => !pool.has(id)).length;

  return {
    state: { groups, categories, tombstones, trash },
    counts: {
      broughtSessions: groups.length,
      removedSessions: count(keptGroupIds, groupIds),
      askedBack,
      removedCategories: count(keptCategoryIds, categoryIds),
      removedTrashRows: count(keptTrashIds, trashIds),
    },
  };
}

/** 给界面用：这一种删除会不会把东西送进回收站。判据只有这一份。 */
export function revertedEntersTrash(): boolean {
  return REVERTED_ENTERS_TRASH;
}
