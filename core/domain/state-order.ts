/**
 * `StoredState` 的**规范顺序**。
 *
 * 为什么要有这个文件：`stateChecksumOf` 盖的是 `canonicalJson(state)`，
 * 而 `canonicalJson` 只排**键序**，数组照字面顺序进摘要。
 * 于是"同一堆内容、数组顺序不同"在摘要眼里就是两份不同的状态。
 * 真机的代价（2026-10-08 用户截图）：两台设备 9 分钟互推 10 个版本、中间跳号，
 * 每一轮都往坚果云落一个**不可变**快照并烧一次请求配额；单机时表现为
 * 「同步日志」每 60 秒一条 `↓ 拉取 · 并入 0`，环 100 在两个半小时内到顶。
 *
 * 根因的形状（不是某个字段算错，是**同一个规则有两个实现**）：
 * - `mergeStates` 自己排了一遍会话（`sortOrder` 降序 + `updatedAt` 兜底），
 * - `readStoredState` 那边根本不排（`listAllGroups` 返回索引数组的来路顺序），
 * - 而引擎比的又是"内存里那份合并结果的 checksum" vs "下一轮从存储读回来的 checksum"。
 *   两边永远不等 ⇒ 每台都认为自己有新东西要推。
 *
 * 所以规则只许有一份，且**读的那一侧与合的那一侧必须调同一个函数**：
 * 这里导出四个 `sorted*`，`core/domain/merge.ts` 与
 * `core/application/durable-snapshot.ts` 都走 `canonicalizeState`，
 * `infrastructure/storage/wxt-storage.ts` 的墓碑/回收站排序也从这里取。
 *
 * ⚠ 每条全序都必须**没有 tie**：比较键用完了还相等就必须落到一个唯一键（`id`）。
 * 少一级 tiebreak，排序会退回"谁先写谁在前"，而那正是两台设备最容易不同的东西
 * （`sortedTrash` 的注释里早就写了这条教训，只是当时只用在回收站一处）。
 */

import type { SavedTab, StoredState, TabGroup, Tombstone, TrashEntry } from '@/shared/types';
import { compareGroups } from '@/core/domain/group';
import { sortedCategories } from '@/core/domain/category';

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 会话内标签：`sortOrder` 升序就是恢复顺序本身，`id` 兜底。 */
export function compareTabOrder(a: SavedTab, b: SavedTab): number {
  return a.sortOrder - b.sortOrder || compareString(a.id, b.id);
}

/**
 * 标签列表的规范形。
 *
 * 两处不显眼：
 * - 已经就位时**返回同一个数组引用**，不复制。一次同步要过 900 个会话，
 *   无条件 `[...tabs].sort()` 会把"读全量状态"变成"重建全量状态"。
 * - `tabs` 不是数组时**原样返回**，不替他补一个 `[]`。
 *   形状坏了是 `inspectLocalState` 那一层的判据（坏了就整轮停在 `invalid-local`），
 *   排序这一层如果顺手补平，那台机器就会把一份解析不出来的状态当成"干净的改动"推出去。
 */
function sortedTabs(tabs: SavedTab[]): SavedTab[] {
  if (!Array.isArray(tabs)) return tabs;
  for (let i = 1; i < tabs.length; i += 1) {
    if (compareTabOrder(tabs[i - 1] as SavedTab, tabs[i] as SavedTab) > 0) {
      return [...tabs].sort(compareTabOrder);
    }
  }
  return tabs;
}

/**
 * 墓碑按删除时间升序：合并时"谁更晚"是唯一的判据来源。
 * 同一次批量删除会拿到同一个 `deletedAt`，所以 `entityId` 与 `id` 两档 tiebreak 都在判据里。
 */
export function sortedTombstones(items: Tombstone[]): Tombstone[] {
  return [...items].sort(
    (a, b) => a.deletedAt - b.deletedAt || compareString(a.entityId, b.entityId) || compareString(a.id, b.id),
  );
}

/**
 * 回收站按删除时间降序，与主列表"最新在前"同一条轴。
 *
 * `group.id` 做第二位**不是**为了好看：同一天删掉两个会话会有相同的 `deletedAt`，
 * 而数组顺序进 checksum。没有这条 tiebreak，同一份事实在两台机器上能排出两种顺序，
 * 于是每轮同步都多出一个"内容看起来一样"的远端快照（既有约定 的去重防的就是这个）。
 */
export function sortedTrash(items: TrashEntry[]): TrashEntry[] {
  return [...items].sort((a, b) => b.deletedAt - a.deletedAt || compareString(a.group.id, b.group.id));
}

/**
 * 会话列表的规范形：方向与显示**同一条规则**（`compareGroups`，既有约定 的降序），
 * 每个会话的标签再各排一次。
 *
 * 这里**不另写一份**会话顺序：`compareGroups` 是那条规则唯一的事实来源
 * （它的签名已从 `GroupIndexEntry` 放宽到四列的 `Pick`，就是为了能被这里用）。
 * 再写一份就是这次故障的成因 —— 两处顺序不一致，摘要就永远不等。
 */
export function sortedGroups(groups: TabGroup[]): TabGroup[] {
  return [...groups]
    .sort(compareGroups)
    .map((group) => {
      const tabs = sortedTabs(group.tabs);
      return tabs === group.tabs ? group : { ...group, tabs };
    });
}

/**
 * 把一份状态排成规范形。**不改入参**，返回新的顶层对象与新的数组。
 *
 * 注意这里不做"键缺失 vs 空数组"的归一：那一格由 `readStoredState` 负责
 * （它无条件带上 `trash`），这里的职责只有顺序。
 */
export function canonicalizeState(state: StoredState): StoredState {
  return {
    groups: sortedGroups(state.groups),
    categories: sortedCategories(state.categories),
    tombstones: sortedTombstones(state.tombstones),
    trash: sortedTrash(state.trash ?? []),
  };
}
