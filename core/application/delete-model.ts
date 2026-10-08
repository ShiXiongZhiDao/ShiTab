/**
 * 删除模型（既有约定，WebDAV-SYNC.md §5 + §8）。
 *
 * 一句话：**开启同步之后，"删除"不再是物理删除**；更进一步，本仓库把软删除做成
 * **常驻**（Q6 的定案）—— 因为同一个删除按钮在同步开关前后语义不同，
 * 是这套设计里最容易让人丢数据的一种形状：用户关掉同步，删除就突然不可逆了。
 *
 * 这几条删除路径各有各的去向，`DeleteReason` 就是用来区分它们的：
 *
 * | 路径 | reason | 进回收站 | 为什么 |
 * |---|---|---|---|
 * | 用户点删除 / 批量删除（整组） | `user-delete` | **进** | 这是"我可能反悔"的那种删除 |
 * | 用户在会话里 × 掉**一条记录** | `user-delete` | **进**，并到那一组那一行 | 同一个"删除"不该因为按在整组还是单条上，不可逆程度就不同 |
 * | 恢复即消费 | `consumed` | **进** | 恢复之后如果那批标签页被误关，列表里、回收站里都没了 —— 既有约定 改的就是这一格 |
 * | 撤销收纳 | `undone` | 不进 | 那条会话本来只活了 10 秒，内容已经原样回到标签页 |
 *
 * **整组那三条路径都要写墓碑**：删除必须能传播，否则另一台设备会把"已经消费掉的会话"
 * 再恢复一次，开出第二批重复标签页 —— 那是同步里最难向用户解释的一类 bug。
 * 记录级的两格（单条删除、单条恢复）**不写组墓碑**：会话本身还在列表里，
 * 留组墓碑等于让另一台设备把整个会话删掉（既有约定 定的，0079 里记录级也不跨设备传播）。
 */

import type { StoragePort } from '@/core/ports/storage';
import type {
  DeleteReason,
  SavedTab,
  TabGroup,
  Tombstone,
  TrashEntry,
  TrashRecordBarrier,
} from '@/shared/types';
import {
  arrivedState,
  dominantReason,
  mergeRecordLedgers,
  recordsOf,
  withBarrier,
} from '@/core/domain/trash-record';
import { TRASH_RETENTION_MS } from '@/shared/constants';
import { isRecoverableRecord } from '@/core/domain/tab';
import { newId } from '@/shared/utils';

export interface DeleteDeps {
  storage: StoragePort;
}

/**
 * 哪几种删除会进回收站。**穷尽 Record 而不是 `===` 判断**：加第四种 `DeleteReason` 时
 * 这里必须当场做一次选择，否则新路径会静默走"不进回收站" —— 那正好是丢数据的那一侧。
 *
 * - `user-delete`：反悔的地方，理所当然。
 * - `consumed`：恢复即消费之后**也进**（既有约定，用户指令）。原来那条"回收站里再躺一份是噪音"
 *   的理由被实测的另一个事实抵消了：`restoreGroup` 本来就按 URL 对目标窗口去重
 *   （`restore-group.ts` 里 `existing.has(tab.url)` 那一支），所以从回收站里再恢复一次
 *   **不会开出重复标签页**，噪音的担忧不成立；而"恢复完手滑关掉窗口 ⇒ 那批 URL 彻底没了"
 *   是真实会发生、且回收站正好能救的。
 * - `undone`：不进。撤销收纳是把那批标签页原样还给浏览器，会话记录本身只活了 10 秒，
 *   用户点名要撤销的就是它。
 */
const TRASH_BY_REASON: Record<DeleteReason, boolean> = {
  'user-delete': true,
  consumed: true,
  undone: false,
  // 既有约定：恢复是「换成那一版」，往里塞一批回收站行等于同时发明第二个动作，
  // 而且会污染那一版本来的回收站。要捞回来的路径是再恢复到最新那一版。
  reverted: false,
};

export function entersTrash(reason: DeleteReason): boolean {
  return TRASH_BY_REASON[reason];
}

/**
 * 软删除一个会话。
 *
 * 顺序是有意的：**先落墓碑与回收站，再删主存储**。反过来做的话，
 * 中途崩溃会留下"会话没了、但没有任何地方记得它被删过"的状态 ——
 * 那在同步里会被另一台设备解释成"这台机器的数据丢了"，进而触发异常变化检测。
 */
export async function softDeleteGroup(
  deps: DeleteDeps,
  input: { groupId: string; reason: DeleteReason; at: number },
): Promise<void> {
  const group = await deps.storage.getGroup(input.groupId);
  if (!group) return;

  await appendTombstone(deps, {
    id: newId(),
    entityType: 'group',
    entityId: group.id,
    deletedAt: input.at,
    deletedByDeviceId: await deps.storage.getDeviceId(),
    reason: input.reason,
  });

  if (entersTrash(input.reason)) {
    await mergeIntoTrash(deps, { group, tabs: group.tabs, reason: input.reason, at: input.at });
  }

  await deps.storage.removeGroup(group.id);
}

/**
 * 记录级的读法/判据只有一份，在 `core/domain/trash-record.ts`。
 * 这里转出来是为了不改动既有调用方（面板的「已恢复」那颗 chip、以及本模块自己的 `shrinkRow`）。
 */
export { recordReason } from '@/core/domain/trash-record';

/**
 * 把若干条记录并进回收站里那一组的那一行。
 *
 * 为什么是"并"而不是"覆盖"：条目现在有两种来源会撞在同一个组上 ——
 * 他先一条条恢复（每条记录单独进来），第三天把整组删掉。如果这里直接 `putTrash` 覆盖，
 * 那几条先前的记录就凭空消失了；反过来如果每个来源各开一行，同一组会在回收站里出现两行，
 * 而"还原"其中一行会把另一行也带回去（它们共用一个 group id）。
 *
 * 过期时间取**较晚**的那个：`expiresAt` 是这一行的寿命，行里最新那条记录进来那一刻起算 7 天，
 * 不能让一条早先的记录把整行提前拖过期。
 *
 * **不可恢复的记录不进回收站**（既有约定，用户指着 `about:blank` 与 `chrome-extension://…` 那两行
 * 说"这样的不要回收"）。过滤收在**这一个函数**里，不在三个调用方各写一遍：
 * 入站路径有三条（整组软删、会话里 × 掉一条、单条恢复被消费），
 * 漏掉任何一条的表现都是"回收站里躺着一个点开来的东西"，而还原它只会得到一句"无法恢复" ——
 * 那比不回收更坏，因为它承诺了一个做不到的救回。
 *
 * ⚠ 过滤**只影响回收站那一份**。会话墓碑照写、删除照常传播（既有约定 的"照样存、标不可恢复"
 * 说的是列表，不是这里）；整组都不可恢复时这里直接返回，那一行不留。
 *
 * ⚠ **既有约定 之后这一格不是死代码**：新收纳确实不再产生 `restorable: false` 的行（它们连会话都不进），
 * 但这里的入参是**存储里那一组**，老会话、导入进来的老备份、对面同步过来的老载荷里都有那种行。
 * 两道判据问的是两个问题（"这条 tab 该不该进会话" vs "这条记录还原得了吗"），
 * 共同的原语只有一个：`core/domain/tab.isRestorableUrl` —— 这一句是逐个打开
 * `isCapturableTab` 与 `isRecoverableRecord` 核对过的，不是"看起来同源"。
 */
export async function mergeIntoTrash(
  deps: DeleteDeps,
  input: { group: TabGroup; tabs: SavedTab[]; reason: DeleteReason; at: number },
): Promise<void> {
  const recoverable = input.tabs.filter(isRecoverableRecord);
  if (recoverable.length === 0) return;

  const existing = (await deps.storage.listTrash()).find((entry) => entry.group.id === input.group.id);
  const expiresAt = input.at + TRASH_RETENTION_MS;
  /**
   * 这一次进来的每一条都记**当下**的入站时刻。
   *
   * 为什么必须是"这一次"而不是留着你上一次那格：同一条记录可以先被彻底删除、
   * 之后又被你删回来（restore → 再 × 掉，或 purge → 对面还原 → 再删）。
   * 如果 `arrivedAt` 跟着旧行走，那一行上的旧 barrier 就会把这次的新入站一起压住 ——
   * 那是静默丢一条可恢复记录，比它要修的"会复活"严重得多。
   */
  const incoming = Object.fromEntries(recoverable.map((tab) => [tab.id, arrivedState(input.reason, input.at)]));

  if (!existing) {
    await deps.storage.putTrash({
      group: { ...input.group, tabs: recoverable },
      deletedAt: input.at,
      expiresAt,
      reason: input.reason,
      records: incoming,
    });
    return;
  }

  const merged = mergeTabRecords(existing.group.tabs, recoverable);
  await deps.storage.putTrash({
    ...existing,
    group: { ...existing.group, tabs: merged },
    // 行的寿命跟着**最新**那条记录走，理由见函数头
    expiresAt: Math.max(existing.expiresAt, expiresAt),
    reason: dominantReason([existing.reason, input.reason]),
    records: mergeRecordLedgers(recordsOf(existing), incoming),
  });
}

/** 按记录 id 去重合并，保留先来者的位置（回收站里已经躺着的不该因为又进来一条就重排）。 */
function mergeTabRecords(held: SavedTab[], incoming: SavedTab[]): SavedTab[] {
  const seen = new Set(held.map((tab) => tab.id));
  return [...held, ...incoming.filter((tab) => !seen.has(tab.id))];
}

/** 墓碑是整块读写的数组。它的量级是"人手几个分类被删掉"，不需要一键一条。 */
async function appendTombstone(deps: DeleteDeps, tombstone: Tombstone): Promise<void> {
  const current = await deps.storage.listTombstones();
  await deps.storage.setTombstones([...current, tombstone]);
}

/**
 * 记下"这一组的回收站条目被用户处理掉了"。
 *
 * 只在**用户动作**导致整行消失时调用：还原整行、彻底删除整行、逐条删到空。
 * 到期清扫**不调**它 —— 那是这台机器的存储回收，不是一次跨设备的删除。
 */
async function markTrashRowRemoved(
  deps: DeleteDeps,
  input: { groupId: string; reason: DeleteReason; at: number },
): Promise<void> {
  await appendTombstone(deps, {
    id: newId(),
    entityType: 'trash',
    entityId: input.groupId,
    deletedAt: input.at,
    deletedByDeviceId: await deps.storage.getDeviceId(),
    reason: input.reason,
  });
}

/**
 * 从一行里拿掉一条记录之后，把这一行写成什么。
 *
 * `reason` 跟着剩下的记录重算：捞走/删掉的可能是那条"恢复掉的"记录，
 * 剩下的全是用户删的，那这行就不该再顶着「已恢复」的标记（既有约定 的那条信任判据）。
 *
 * 只改本机**可见的那一份**：`group.tabs` 是"用户还看得见的那些"，`records` 是"发生过什么"，
 * 两者故意不同宽（既有约定，**取代 既有约定 里"记录级动作不留凭证"那条口径**）。
 *
 * 被拿掉的那一条必须在这里留下 barrier。凭证随记录一起消失的话，远端那一版
 * （往往就是本机自己上一轮推上去的那一版）下一次就把它并回来 —— 用户看到的说法是
 * "删完立马又回来了"。所以 `barrier` 是**必传参数**而不是可选项：
 * 可选参数一定会有调用方忘传，而忘传的表现不是编译错，是"某一类删除还是会复活"。
 */
function shrinkRow(
  entry: TrashEntry,
  remaining: SavedTab[],
  removedTabId: string,
  barrier: TrashRecordBarrier,
): TrashEntry {
  const ledger = { ...recordsOf(entry) };
  ledger[removedTabId] = withBarrier(
    ledger[removedTabId] ?? arrivedState(entry.reason, entry.deletedAt),
    barrier,
  );
  return {
    ...entry,
    group: { ...entry.group, tabs: remaining },
    // 剩下 0 条时不改行的来历：壳行只是替凭证占位，它下一秒就该被 sweep 掉
    reason:
      remaining.length === 0
        ? entry.reason
        : dominantReason(remaining.map((tab) => ledger[tab.id]?.reason ?? entry.reason)),
    records: ledger,
  };
}

/**
 * 从回收站还原一个会话。
 *
 * 关键的一步是**撤销墓碑**：还原不是"再写一次数据"，而是"那次删除没发生过"。
 * 如果留着墓碑，另一台设备下一次同步会把它再删一遍 —— 用户会看到"我明明还原了，
 * 换台电脑又没了"。这是本模块唯一一处容易被漏掉的机制。
 *
 * `sortOrder` 原样放回：用户排过的顺序属于那条会话自己，不该因为进了一次回收站就丢。
 */
export async function restoreFromTrash(
  deps: DeleteDeps,
  input: { groupId: string; at: number },
): Promise<TabGroup | undefined> {
  const trash = await deps.storage.listTrash();
  const entry = trash.find((item) => item.group.id === input.groupId);
  if (!entry) return undefined;

  await revokeGroupTombstone(deps, input.groupId);
  /**
   * 活着的组可能还在（既有约定 之后这是常态：单条恢复只把那一条记录送进回收站，
   * 会话本身留在列表里）。那种情况必须**并回去**而不是 `putGroup(快照)` 覆盖 ——
   * 覆盖会把用户后来改过的标题、分类、拖过的顺序整组抹掉，
   * 而他的意图只是"把回收站里这几条拿回来"。
   */
  const live = await deps.storage.getGroup(input.groupId);
  const restored: TabGroup = live
    ? { ...live, tabs: mergeTabRecords(live.tabs, entry.group.tabs), updatedAt: input.at }
    : { ...entry.group, updatedAt: input.at };
  await deps.storage.putGroup(restored);
  await deps.storage.removeTrash(input.groupId);
  // 整行是**被用户处理掉**的，必须留标记：另一台设备手上那一行否则会在
  // 下一次合并里按并集回流，用户看到的是"我明明还原了，回收站里又躺回来一份"。
  await markTrashRowRemoved(deps, { groupId: input.groupId, reason: entry.reason, at: input.at });
  return restored;
}

/**
 * 只还原回收站那一行里的**一条记录**。
 *
 * 两个方向都要照顾：组还活着 ⇒ 把这条并回去；组已经整组没了 ⇒ 用快照的标题/分类/顺序
 * 重建一个只带这一条的会话。两种情况都**撤销整组墓碑** —— 本地现在确实有这个会话了，
 * 留着墓碑等于让另一台设备下一次同步把它再删一遍，用户看到的是"我明明还原了，换台电脑又没了"。
 *
 * 行里剩下的记录继续躺在回收站，寿命不变（不因为动了一条就重置 7 天）。
 */
export async function restoreTrashTab(
  deps: DeleteDeps,
  input: { groupId: string; tabId: string; at: number },
): Promise<TabGroup | undefined> {
  const trash = await deps.storage.listTrash();
  const entry = trash.find((item) => item.group.id === input.groupId);
  const record = entry?.group.tabs.find((tab) => tab.id === input.tabId);
  if (!entry || !record) return undefined;

  await revokeGroupTombstone(deps, input.groupId);
  const live = await deps.storage.getGroup(input.groupId);
  const restored: TabGroup = live
    ? { ...live, tabs: mergeTabRecords(live.tabs, [record]), updatedAt: input.at }
    : { ...entry.group, tabs: [record], updatedAt: input.at };
  await deps.storage.putGroup(restored);

  const remaining = entry.group.tabs.filter((tab) => tab.id !== input.tabId);
  const barrier: TrashRecordBarrier = {
    action: 'restore',
    at: input.at,
    deviceId: await deps.storage.getDeviceId(),
  };
  /**
   * 还原到空时**不再 `removeTrash`**。
   *
   * 留一条"零可见记录"的壳行，是为了让凭证活到那一行本来的到期时刻：
   * 行整个删掉的话，凭证跟着消失，远端那一版会把这一行连同那几条**已经回到会话里**的记录
   * 一起并回来 —— 用户的说法是"同一条既在列表里、又躺回回收站"。
   *
   * 仍然**不写** `'trash'` 整行标记：还原不是删除，写了等于让另一台设备把那一行再处理一遍，
   * 而且会把那边"我还没见过的记录"一起压掉（既有约定 那条理由现在依然成立，只是它不再需要
   * 靠"什么都不留"来表达 —— 记录级凭证现在能精确表达"只有这几条被我处理掉了"）。
   */
  await deps.storage.putTrash(shrinkRow(entry, remaining, input.tabId, barrier));
  return restored;
}

/**
 * 从回收站那一行里**永久删掉一条记录**，剩下的继续躺到 7 天。
 * 不动**组**墓碑：这一条本来就是"已经发生的一次删除"，撤销它没有意义 ——
 * 撤销只在上面那条"还原"里才需要。
 *
 * 两种"最后一条"的形状故意不同，别在下次"统一一下"时抹平：
 * - 没删空：写**记录级** barrier，对面那台在这一行里新增的记录一条都不受影响；
 * - 删到空：整行没了，写**整行**的 `'trash'` 标记（既有约定 原口径不变）。那一条比 barrier 粗，
 *   会连对面"我还没见过的记录"一起压掉 —— 这是当初就认了的取舍，改它要重新拍。
 */
export async function purgeTrashTab(
  deps: DeleteDeps,
  input: { groupId: string; tabId: string; at: number },
): Promise<void> {
  const trash = await deps.storage.listTrash();
  const entry = trash.find((item) => item.group.id === input.groupId);
  if (!entry) return;

  const remaining = entry.group.tabs.filter((tab) => tab.id !== input.tabId);
  if (remaining.length === 0) {
    await deps.storage.removeTrash(input.groupId);
    await markTrashRowRemoved(deps, { groupId: input.groupId, reason: entry.reason, at: input.at });
    return;
  }
  await deps.storage.putTrash(
    shrinkRow(entry, remaining, input.tabId, {
      action: 'purge',
      at: input.at,
      deviceId: await deps.storage.getDeviceId(),
    }),
  );
}

/** 还原 = "那次删除没发生过"，所以指向这个会话的组墓碑要一起摘掉。 */
async function revokeGroupTombstone(deps: DeleteDeps, groupId: string): Promise<void> {
  await deps.storage.setTombstones(
    (await deps.storage.listTombstones()).filter(
      (tombstone) => !(tombstone.entityType === 'group' && tombstone.entityId === groupId),
    ),
  );
}

/**
 * 永久删除一整行：回收站里那条也没了，**组**墓碑保留（这一次删除是真实的，要传播出去），
 * 同时补一条 `'trash'` 移除标记，让另一台设备手上那一行不再并回来。
 */
export async function purgeFromTrash(
  deps: DeleteDeps,
  input: { groupId: string; at: number },
): Promise<void> {
  const entry = (await deps.storage.listTrash()).find((item) => item.group.id === input.groupId);
  await deps.storage.removeTrash(input.groupId);
  // 行本来就不在时不留标记：`removeTrash` 是幂等的，而"这一行被处理掉了"
  // 只有在它真的存在过时才是事实。留一条压不住任何东西的标记只会污染载荷。
  if (entry) await markTrashRowRemoved(deps, { groupId: input.groupId, reason: entry.reason, at: input.at });
}

/**
 * 到期的回收站条目物理清除。
 *
 * 它只清本地，**不产生新墓碑、也不动远端**：过期清理是这台机器上的存储回收，
 * 不是一次"用户删除"。真正的删除信号早在这次软删除时就以墓碑的形式发出去了。
 * 把它误当成删除来传播，会让"7 天到了"变成一次跨设备的删除风暴。
 *
 * 顺手做一件**只有同步之后才需要**的事：把没用了的 `'trash'` 移除标记删掉。
 * 判据是 `标记时刻 + 保留期 <= at`，它可以证明"这条标记所压制的那一行，在任何一台设备
 * 上都早就过完它的 7 天"（那一行的 `deletedAt <= 标记时刻`，`expiresAt = deletedAt + 保留期`），
 * 所以清掉它不会让任何一行复活。不保底的话这些标记会一辈子堆在载荷里。
 */
export async function sweepExpiredTrash(deps: DeleteDeps, at: number): Promise<number> {
  const trash = await deps.storage.listTrash();
  const expired = trash.filter((entry) => entry.expiresAt <= at);
  for (const entry of expired) {
    await deps.storage.removeTrash(entry.group.id);
  }

  const tombstones = await deps.storage.listTombstones();
  const keep = tombstones.filter(
    (tombstone) =>
      !(tombstone.entityType === 'trash' && tombstone.deletedAt + TRASH_RETENTION_MS <= at),
  );
  if (keep.length !== tombstones.length) await deps.storage.setTombstones(keep);

  return expired.length;
}

/**
 * 墓碑压缩：每个实体只留**最后一条**。
 *
 * 不清的理由只有一个：一个会话可以被反复"删除→还原→删除"，留一串墓碑
 * 会让每次同步都要搬一坨没人再读的历史。判据是"最后那条说了算"，
 * 因为合并只比时间先后，不比删除次数。
 *
 * 分类被删之后，指向它的会话引用会变悬空，而 `heal()` 已经有处理（清成未分类）。
 * 所以分类墓碑可以随会话一起被压掉，不需要额外保底。
 */
export function compactTombstones(tombstones: Tombstone[]): Tombstone[] {
  const last = new Map<string, Tombstone>();
  for (const tombstone of tombstones) {
    const key = `${tombstone.entityType}:${tombstone.entityId}`;
    const held = last.get(key);
    if (!held || held.deletedAt <= tombstone.deletedAt) last.set(key, tombstone);
  }
  return [...last.values()].sort((a, b) => a.deletedAt - b.deletedAt);
}
