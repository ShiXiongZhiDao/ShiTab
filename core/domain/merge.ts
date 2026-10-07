/**
 * 两份状态的合并（既有约定，WebDAV-SYNC.md §10 / §11）。
 *
 * 定的口径是 Q8：**实体级 last-writer-wins，只有"一边删了、另一边在删之后又改了"
 * 这一种情况交回给用户**。不做的两件事也写清楚，别让人以为这里有更聪明：
 *
 * - **没有字段级三方合并**。设备 A 改了标题、B 改了锁定，V1 只会取 `updatedAt` 大的那一版，
 *   另一版的改动就没了。这是 §11 明写的 V1 取舍（"V1.1 再做字段级自动合并"）。
 *   我没偷偷做成字段级，因为字段级合并要引入 base 版本对比，那是另一套复杂度。
 * - **时钟偏移当成不存在**。LWW 的正确性直接依赖两台机器的 `updatedAt` 可比。
 *   跨设备时钟差几秒是常态，所以"删除 vs 编辑"这一类**故意不自动判** ——
 *   自动判错了就是一次静默丢数据，而这整套设计的立项理由就是不要静默丢数据。
 *
 * 分类是唯一的例外，且不是我的发明：既有约定 已经定过
 * 「跨设备的 id 撞车是巧合……**名字是唯一跨设备还能对上的东西**」。
 * 这里直接复用那条规则，不再立第二套。
 */

import { canonicalJson } from '@/core/domain/checksum';
import {
  barrierSuppresses,
  dominantReason,
  mergeRecordLedgers,
  recordsOf,
} from '@/core/domain/trash-record';
import type { Category, SavedTab, StoredState, TabGroup, Tombstone, TrashEntry, TrashRecordState } from '@/shared/types';

/** 回收站载荷的读时兜底（键是可选的，见 `StoredState.trash`）。所有读侧都走这一个函数。 */
export function trashOf(state: StoredState): TrashEntry[] {
  return state.trash ?? [];
}

/** `entityType: 'trash'` 的墓碑 = "这一行被用户处理掉了"（还原整行 / 彻底删除 / 逐条删到空）。 */
function trashMarkers(tombstones: Map<string, Tombstone>): Map<string, Tombstone> {
  const markers = new Map<string, Tombstone>();
  for (const tombstone of tombstones.values()) {
    if (tombstone.entityType === 'trash') markers.set(tombstone.entityId, tombstone);
  }
  return markers;
}

/**
 * 一行的**规范序键**。
 *
 * 存在的唯一理由是"合并必须可交换"：A 算 `merge(local=A, remote=B)`、B 算
 * `merge(local=B, remote=A)`，两边的结果必须逐字节相同，否则两台机器各推一版、
 * 谁都不认谁，每轮同步都产生一个新快照（既有约定 的去重就永远不生效）。
 * 所以凡是"两边都有、要挑一个当基准"的地方，判据都不能是"哪个是本地"，
 * 只能是内容自身的某个全序 —— 这里用 `deletedAt → expiresAt → group.updatedAt → 规范化 JSON`
 * 逐段比较，最后一段是任何硬撑不住的平手时的确定性收尾。
 */
function trashOrderKey(entry: TrashEntry): string {
  return `${entry.deletedAt}|${entry.expiresAt}|${entry.group.updatedAt}|${canonicalJson(entry)}`;
}

function byRecordOrder(a: SavedTab, b: SavedTab): number {
  return (
    a.sortOrder - b.sortOrder ||
    a.originalIndex - b.originalIndex ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * 合并两侧的回收站（既有约定 + 既有约定）。三条规则：
 *
 * 1. **整行被用户处理掉的不再回来**：那一组有 `'trash'` 标记且标记时刻不早于这一行的
 *    `deletedAt` ⇒ 丢掉。防的是"我明明还原了/彻底删了那一行，另一台设备又把它送回回收站"。
 * 2. **记录级仍然是并集**：两边各自新增的记录都留下（这条是 既有约定 的原始取舍，
 *    这次**没有**为了修 bug 而改成整行 LWW —— 那会丢掉对面新增的记录）。
 *    `expiresAt` 取较晚、`deletedAt` 取较早，与本地那条 `mergeIntoTrash` 完全一致。
 * 3. **并完之后才应用 barrier**（既有约定 新加的那一步）：每条记录的 ledger 跨两侧合并
 *    （来历取 dominant、入站时刻取较晚、凭证取最新），然后把"凭证时刻 >= 这一次入站时刻"的
 *    记录从可见集合里滤掉。顺序不能反 —— 先滤再并的话，对面那份没有被压过的同一条
 *    会把凭证刚压住的东西又带回来。
 *
 * 为什么第 3 条要新增一个 `records` ledger 而不是靠 `updatedAt`：`SavedTab` 上那个时刻
 * 是"这条网页记录本身什么时候变的"，跟"它什么时候被丢进回收站"不是一回事，
 * 拿它当判据的话，一台机器上改个标题就能把另一台的凭证绕过去。
 *
 * 过期**不参与**这里：`expiresAt` 跟着载荷走，各机按本地时钟扫掉，不需要"谁通知谁过期"。
 * 凭证的回收也不参与：barrier 挂在行上，行的 `expiresAt` 就是它的 GC，两台机器同一个到期时刻。
 */
function mergeTrash(input: {
  local: StoredState;
  remote: StoredState;
}, tombstones: Map<string, Tombstone>): TrashEntry[] {
  const markers = trashMarkers(tombstones);
  const byGroup = new Map<string, TrashEntry[]>();
  for (const entry of [...trashOf(input.local), ...trashOf(input.remote)]) {
    const held = byGroup.get(entry.group.id);
    if (held) held.push(entry);
    else byGroup.set(entry.group.id, [entry]);
  }

  const merged: TrashEntry[] = [];
  for (const [groupId, entries] of byGroup) {
    // 规范序升序遍历：后面的一路覆盖前面的 ⇒ 结果与"哪一边是本地"无关（见 trashOrderKey）
    const sorted = [...entries].sort((a, b) => (trashOrderKey(a) < trashOrderKey(b) ? -1 : 1));
    const deletedAt = sorted.reduce((min, entry) => Math.min(min, entry.deletedAt), sorted[0]!.deletedAt);

    const marker = markers.get(groupId);
    if (marker && marker.deletedAt >= deletedAt) continue;

    const base = sorted[sorted.length - 1]!;
    const tabs = new Map<string, SavedTab>();
    // ledger 跨两侧合并：凭证不在这里，下面的过滤就没有依据
    let ledger: Record<string, TrashRecordState> = {};
    for (const entry of sorted) {
      ledger = mergeRecordLedgers(ledger, recordsOf(entry));
      for (const tab of entry.group.tabs) {
        // 同一条记录两侧各有一份时，按规范序**后面**那一份覆盖前面 —— 与遍历方向无关，可交换性靠它
        tabs.set(tab.id, tab);
      }
    }

    const kept = [...tabs.values()]
      .filter((tab) => !barrierSuppresses(ledger[tab.id]))
      .sort(byRecordOrder);
    const hasBarrier = Object.values(ledger).some((state) => state.barrier !== undefined);
    // 空壳不进结果：主列表和面板都不该出现一个"0 条的会话"（既有约定 的同一口径）。
    // ⚠ 但**替凭证记账的那一行必须留着**：它对用户不可见（面板按可见记录滤掉），
    // 一起扔掉等于把"这条我处理过了"的凭证清空 ⇒ 远端那一版下一轮又把它并回来。
    if (kept.length === 0 && !hasBarrier) continue;

    const expiresAt = sorted.reduce((max, entry) => Math.max(max, entry.expiresAt), base.expiresAt);
    merged.push({
      group: { ...base.group, tabs: kept },
      deletedAt,
      expiresAt,
      reason:
        kept.length === 0
          ? base.reason
          : dominantReason(kept.map((tab) => ledger[tab.id]?.reason ?? base.reason)),
      records: ledger,
    });
  }

  return merged.sort((a, b) => b.deletedAt - a.deletedAt || (a.group.id < b.group.id ? -1 : 1));
}

/**
 * "一边删了它，另一边在删除之后还改了它"。
 *
 * 合并结果里这条会话**先按保留处理**（见 `applyConflictChoice`），因为
 * 默认值必须是破坏性最小的那个：用户没来得及选的时候，宁可多留一条会话，
 * 不能少一条会话。
 */
export interface DeleteVsEditConflict {
  kind: 'delete-vs-edit';
  groupId: string;
  /** 被保留下来的那一版会话，UI 要能把内容显示出来给用户看差异。 */
  group: TabGroup;
  deletedAt: number;
  editedAt: number;
  /** 谁删的。署名来自墓碑，另一台设备在 UI 上就叫"另一台设备"。 */
  deletedByDeviceId: string;
  deleteReason: Tombstone['reason'];
}

export interface MergeResult {
  state: StoredState;
  conflicts: DeleteVsEditConflict[];
  /** 供日志与 UI 计数：这些数都是"发生了什么"，不是"还剩多少"。 */
  applied: {
    keptFromLocal: number;
    keptFromRemote: number;
    droppedByTombstone: number;
    categoriesRenamedMerged: number;
    unresolvedConflicts: number;
  };
}

function tombstoneKey(entityType: Tombstone['entityType'], entityId: string): string {
  return `${entityType}:${entityId}`;
}

/**
 * 两侧墓碑合成一份，同一实体只留**最晚**那条。
 *
 * 最晚的那条代表"最后一次关于这个实体的决定"。留一串没有意义（`delete-model.ts`
 * 的 `compactTombstones` 同一条理由）。
 */
function newestTombstones(input: { local: StoredState; remote: StoredState }): Map<string, Tombstone> {
  const merged = new Map<string, Tombstone>();
  for (const tombstone of [...input.local.tombstones, ...input.remote.tombstones]) {
    const key = tombstoneKey(tombstone.entityType, tombstone.entityId);
    const held = merged.get(key);
    if (!held || held.deletedAt <= tombstone.deletedAt) merged.set(key, tombstone);
  }
  return merged;
}

/** 规范化后的分类名。大小写与首尾空白不参与比较 —— 与 `importBackup` 用的是同一个键。 */
function categoryKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 分类按**名字**对齐。
 *
 * 返回的是 `源id -> 规范id` 的映射。规范 id 取"同名里 `updatedAt` 更晚的那个分类"的 id：
 * 谁改得晚，谁的名字就是当前用户看到的那个，用它的 id 当身份更贴近本地现状。
 * 这一步是必须的 —— 不做重映射的话，合并完会有两个"工作"分类，
 * 而分类名唯一这个不变量当场就破了。
 */
function mergeCategories(local: Category[], remote: Category[]): {
  categories: Category[];
  idMap: Map<string, string>;
  mergedByName: number;
} {
  const byKey = new Map<string, Category>();
  const idMap = new Map<string, string>();
  let mergedByName = 0;

  const consider = (source: Category) => {
    const key = categoryKey(source.name);
    const held = byKey.get(key);
    if (!held) {
      byKey.set(key, source);
      idMap.set(source.id, source.id);
      return;
    }
    if (held.id === source.id) {
      // 同一份分类从两边来：取更新的字段值，身份不变
      byKey.set(key, held.updatedAt >= source.updatedAt ? held : source);
      idMap.set(source.id, held.id);
      return;
    }
    mergedByName += 1;
    const winner = source.updatedAt > held.updatedAt ? source : held;
    const loser = winner === source ? held : source;
    byKey.set(key, winner);
    idMap.set(loser.id, winner.id);
    idMap.set(source.id, winner.id);
  };

  for (const category of local) consider(category);
  for (const category of remote) consider(category);

  const categories = [...byKey.values()]
    .map((category) => ({ ...category }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
  return { categories, idMap, mergedByName };
}

function pickNewer(local: TabGroup, remote: TabGroup): { winner: TabGroup; fromRemote: boolean } {
  // 平手取本地。必须有确定性的一条：两边都"对"的时候，
  // 一台机器每次同步都换一个答案，用户会看到列表在来回抖。
  if (remote.updatedAt > local.updatedAt) return { winner: remote, fromRemote: true };
  return { winner: local, fromRemote: false };
}

/**
 * 合并两份状态。
 *
 * 纯函数：不读存储、不发请求、不写任何东西。这样 §19 里"A/B 同时编辑 ⇒ conflict"
 * 那条能用一段字面量数据直接测，不需要两台设备。
 */
export function mergeStates(input: { local: StoredState; remote: StoredState }): MergeResult {
  const tombstoneMap = newestTombstones(input);
  const { categories, idMap, mergedByName } = mergeCategories(
    input.local.categories,
    input.remote.categories,
  );

  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const groups = new Map<string, TabGroup>();
  const conflicts: DeleteVsEditConflict[] = [];
  const applied = {
    keptFromLocal: 0,
    keptFromRemote: 0,
    droppedByTombstone: 0,
    categoriesRenamedMerged: mergedByName,
    unresolvedConflicts: 0,
  };

  const remapGroup = (group: TabGroup): TabGroup => {
    if (group.categoryId === undefined) return group;
    const mapped = idMap.get(group.categoryId);
    // 映射不到、或者映射完指向一个已经不在列表里的分类 ⇒ 未分类。
    // 与 `heal()` 的悬空引用处理同一条规则：宁可少一个分类归属，也不能显示成
    // "某个看不见的分类里有一批会话"。
    if (!mapped || !knownCategoryIds.has(mapped)) {
      const { categoryId: _dropped, ...rest } = group;
      return rest;
    }
    return mapped === group.categoryId ? group : { ...group, categoryId: mapped };
  };

  const ids = new Set([...input.local.groups.map((g) => g.id), ...input.remote.groups.map((g) => g.id)]);

  for (const id of ids) {
    const localGroup = input.local.groups.find((group) => group.id === id);
    const remoteGroup = input.remote.groups.find((group) => group.id === id);
    const tombstone = tombstoneMap.get(tombstoneKey('group', id));

    if (localGroup && remoteGroup) {
      const { winner, fromRemote } = pickNewer(localGroup, remoteGroup);
      if (fromRemote) applied.keptFromRemote += 1;
      else applied.keptFromLocal += 1;
      // 两边都还在，但其中一边留了墓碑 ⇒ 那是"删了又改"，必须问用户
      if (tombstone) {
        if (winner.updatedAt > tombstone.deletedAt) {
          conflicts.push({
            kind: 'delete-vs-edit',
            groupId: id,
            group: winner,
            deletedAt: tombstone.deletedAt,
            editedAt: winner.updatedAt,
            deletedByDeviceId: tombstone.deletedByDeviceId,
            deleteReason: tombstone.reason,
          });
          groups.set(id, remapGroup(winner));
          continue;
        }
        applied.droppedByTombstone += 1;
        continue;
      }
      groups.set(id, remapGroup(winner));
      continue;
    }

    const solo = localGroup ?? remoteGroup;
    if (!solo) continue;

    // 只有一边有这条会话，另一边**整个没有这个 id**：这可能是"另一边删了它"，
    // 也可能是"另一边根本没见过它"。墓碑是这两者的唯一区别，所以有墓碑就按删除处理。
    if (tombstone) {
      if (solo.updatedAt > tombstone.deletedAt) {
        conflicts.push({
          kind: 'delete-vs-edit',
          groupId: id,
          group: solo,
          deletedAt: tombstone.deletedAt,
          editedAt: solo.updatedAt,
          deletedByDeviceId: tombstone.deletedByDeviceId,
          deleteReason: tombstone.reason,
        });
        groups.set(id, remapGroup(solo));
        continue;
      }
      applied.droppedByTombstone += 1;
      continue;
    }
    // 没有墓碑、只有单边存在 ⇒ 这是新数据，直接收。
    if (localGroup) applied.keptFromLocal += 1;
    else applied.keptFromRemote += 1;
    groups.set(id, remapGroup(solo));
  }

  const tombstonesKept = tombstoneForSurvivors(tombstoneMap, groups);
  applied.unresolvedConflicts = conflicts.length;

  return {
    state: {
      groups: [...groups.values()].sort((a, b) => b.sortOrder - a.sortOrder || b.updatedAt - a.updatedAt),
      categories,
      tombstones: tombstonesKept,
      // 回收站要排在墓碑之后：它的去留判据来自合并后的墓碑表。
      trash: mergeTrash(input, tombstoneMap),
    },
    conflicts,
    applied,
  };
}

/**
 * 合并之后还该留哪些墓碑：只留"这个实体确实不在结果里"的那些。
 *
 * 一条指向**仍然存在的会话**的墓碑是有害的 —— 它会在下一次同步里把这条会话又删一遍，
 * 用户看到的就是"我明明还原了，换台电脑又没了"。`delete-model.ts` 里
 * `restoreFromTrash` 撤销墓碑是同一条道理，这里是它在合并侧的对应。
 */
function tombstoneForSurvivors(
  tombstones: Map<string, Tombstone>,
  groups: Map<string, TabGroup>,
): Tombstone[] {
  const kept: Tombstone[] = [];
  for (const tombstone of tombstones.values()) {
    if (tombstone.entityType === 'group' && groups.has(tombstone.entityId)) continue;
    kept.push(tombstone);
  }
  return kept.sort((a, b) => a.deletedAt - b.deletedAt);
}

/**
 * 用户对一条 delete-vs-edit 冲突的裁决。
 *
 * `'keep'` 是默认（合并结果本来就是这个样子），所以这里只实现 `'delete'` 那一边：
 * 把会话拿掉、把墓碑放回去。拿掉会话时要连它一起从回收站语义里消失 ——
 * 这是"用户确认这次删除是真的"，不是"用户删了一次"，所以**不新建墓碑**。
 */
export function applyConflictChoice(
  state: StoredState,
  conflict: DeleteVsEditConflict,
  choice: 'keep' | 'delete',
): StoredState {
  if (choice === 'keep') return state;
  return {
    ...state,
    groups: state.groups.filter((group) => group.id !== conflict.groupId),
    tombstones: [
      ...state.tombstones,
      {
        id: `${conflict.groupId}@${conflict.deletedAt}`,
        entityType: 'group' as const,
        entityId: conflict.groupId,
        deletedAt: conflict.deletedAt,
        deletedByDeviceId: conflict.deletedByDeviceId,
        reason: conflict.deleteReason,
      },
    ].sort((a, b) => a.deletedAt - b.deletedAt),
  };
}
