/**
 * 恢复（既有约定 §3.2）。
 *
 * 三条定案（第 2 轮待决第 3、4 条 + V1.1 既有约定 / V1.2 既有约定）：
 * - **目标窗口**：由调用方每次显式选的 `mode` 决定 —— 'current' 用传进来的 windowId，
 *   'newWindow' 与 'incognito' 各新建一个窗口（**没有**设置项参与，也不在 use case 里
 *   猜"当前窗口"）。图标点击时 windowId 来自 `action.onClicked` 的 `tab.windowId`，
 *   工作台页面时是它自己所在的窗口。
 * - **激活哪个**：批量创建全部用 active:false，避免创建过程中焦点反复跳；
 *   收尾时激活 `wasActive` 的那一条，没有则激活本批第一条恢复成功的。
 * - **恢复后是否删组**：只在 restored > 0 时删，否则一条都没开出来还把数据删了。
 */

import type { BrowserTabsPort } from '@/core/ports/browser-tabs';
import type { StoragePort } from '@/core/ports/storage';
import type {
  RestoreMode,
  RestoreResult,
  RestoreTabResult,
  SavedTab,
  TabGroup,
} from '@/shared/types';
import { RESTORE_CONCURRENCY } from '@/shared/constants';
import { mapWithConcurrency } from '@/core/application/concurrency';
import { isRecoverableRecord } from '@/core/domain/tab';
import { deleteTab } from '@/core/application/group-commands';
import { mergeIntoTrash, softDeleteGroup } from '@/core/application/delete-model';
import { newId, now } from '@/shared/utils';

export interface RestoreDeps {
  tabs: BrowserTabsPort;
  storage: StoragePort;
}

export interface RestoreTarget {
  /** mode='current' 时的目标窗口；其它模式下是"用户所在窗口"，仅用于兜底 */
  windowId: number;
  /** 缺省 'current'（既有约定：还原去哪是每次显式选的，不再由设置项决定） */
  mode?: RestoreMode;
}

const emptyResult = (operationId: string, windowId: number, mode: RestoreMode): RestoreResult => ({
  operationId,
  windowId,
  mode,
  restored: 0,
  skipped: 0,
  failed: 0,
  failedUrls: [],
  skippedUrls: [],
});

/**
 * 列表顺序：用户在拖拽里排出来的 sortOrder 优先，`originalIndex` 作次级键。
 *
 * 为什么需要次级键：新建分组的 sortOrder 就是 0..n-1，与 originalIndex 一致；
 * 但**跨组移动**与**导入**会把 sortOrder 重排成稠密序列，这时 originalIndex 保留
 * "当时在窗口里的相对位置"，让没被用户动过的条目仍然按原窗口顺序恢复。
 */
function orderedTabs(group: TabGroup): SavedTab[] {
  return [...group.tabs].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.originalIndex - b.originalIndex,
  );
}

/** 撤销用的顺序：**原窗口**的位置，不是用户在我们列表里拖出来的顺序。 */
function tabsAsTheyWere(group: TabGroup): SavedTab[] {
  return [...group.tabs].sort(
    (a, b) => a.originalIndex - b.originalIndex || a.sortOrder - b.sortOrder,
  );
}

/**
 * 还原去哪。`incognito` 失败时**让它抛**，不降级成普通窗口 ——
 * 用户点"在无痕窗口还原"要的就是那条隐私边界，悄悄换成普通窗口比报错更糟。
 */
async function resolveWindow(deps: RestoreDeps, target: RestoreTarget): Promise<number> {
  const mode = target.mode ?? 'current';
  if (mode === 'current') return target.windowId;
  const created = await deps.tabs.createWindow({
    focused: true,
    ...(mode === 'incognito' ? { incognito: true } : {}),
  });
  return created.id;
}

/** 恢复整组。跳过（不是失败）：restorable=false，以及目标窗口已有同 URL。 */
export async function restoreGroup(
  deps: RestoreDeps,
  input: RestoreTarget & { groupId: string },
): Promise<RestoreResult> {
  const operationId = newId();
  const mode = input.mode ?? 'current';
  const group = await deps.storage.getGroup(input.groupId);
  if (!group) return emptyResult(operationId, input.windowId, mode);

  const windowId = await resolveWindow(deps, input);
  const existing = await deps.tabs.existingUrls(windowId);
  const ordered = orderedTabs(group);

  const skippedUrls: string[] = [];
  const openable: SavedTab[] = [];
  for (const tab of ordered) {
    if (!isRecoverableRecord(tab)) {
      skippedUrls.push(tab.url);
      continue;
    }
    if (existing.has(tab.url)) {
      // 既有约定：按 URL 对目标窗口去重
      skippedUrls.push(tab.url);
      continue;
    }
    existing.add(tab.url); // 同组内的重复 URL 也只会开一条
    openable.push(tab);
  }

  const created = await mapWithConcurrency(openable, RESTORE_CONCURRENCY, (tab) =>
    deps.tabs.create({ url: tab.url, windowId, active: false }),
  );

  const failedUrls: string[] = [];
  const createdIds: { tabId: number; wasActive: boolean }[] = [];
  created.forEach((outcome, index) => {
    const tab = openable[index];
    if (!tab) return;
    if (outcome.status === 'fulfilled') {
      createdIds.push({ tabId: outcome.value.tabId, wasActive: tab.wasActive });
    } else {
      failedUrls.push(tab.url);
    }
  });

  // 收尾只激活一个：优先原活动 tab，否则本批第一条
  const toActivate = createdIds.find((entry) => entry.wasActive) ?? createdIds[0];
  if (toActivate) {
    await deps.tabs.update(toActivate.tabId, { active: true }).catch(() => undefined);
  }

  // **恢复即消费**：点过一次恢复的会话不该继续躺在列表里等着被点第二次。
  // 原来这要靠设置项 `deleteGroupAfterRestore` 打开，而默认是关的 —— 于是默认行为是
  // "恢复完留下一条已经变成活 tab 的记录"，正是 既有约定 当年批评的二次偏差。
  // 两条例外，一条都不能省：
  //   - 一条都没开出来 => 不删（不能因为一次失败的点击把用户的数据弄丢）
  //   - 会话被锁定 => 不删（锁的语义就是"这批我还要留着"，既有约定）
  if (createdIds.length > 0 && !group.locked) {
    // 消费是一次**删除**，所以它也要留墓碑：另一台设备下一次同步必须知道
    // 这个会话被消费过了，否则它会把同一批 URL 再开一遍。
    // 它也**进回收站**：恢复完手滑把窗口关掉，那批 URL 就只剩回收站里这一份了。
    // 不会因此开出重复标签页 —— 上面的 `existing.has(tab.url)` 已经按 URL 对目标窗口去过重。
    await softDeleteGroup(deps, { groupId: group.id, reason: 'consumed', at: now() });
  } else {
    await deps.storage.touchUpdatedAt(now());
  }

  return {
    operationId,
    windowId,
    mode,
    restored: createdIds.length,
    skipped: skippedUrls.length,
    failed: failedUrls.length,
    failedUrls,
    skippedUrls,
  };
}

/** 恢复单条。不走去重：用户点的是"就开这一条"。 */
export async function restoreTab(
  deps: RestoreDeps,
  input: RestoreTarget & { groupId: string; tabId: string },
): Promise<RestoreTabResult> {
  const operationId = newId();
  const group = await deps.storage.getGroup(input.groupId);
  const tab = group?.tabs.find((candidate) => candidate.id === input.tabId);
  if (!group || !tab) {
    return { operationId, ok: false, reason: 'not-restorable', error: '分组里找不到这条记录' };
  }
  if (!isRecoverableRecord(tab)) {
    return { operationId, ok: false, reason: 'not-restorable' };
  }

  const windowId = await resolveWindow(deps, input);
  try {
    await deps.tabs.create({ url: tab.url, windowId, active: true });
  } catch (error) {
    return {
      operationId,
      ok: false,
      reason: 'create-failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // 单条恢复消费的是**这一条记录**（会话本身留着）。锁定的会话不动记录：
  // 用户既然锁了，就是要能反复从这里取。删不掉也不该让恢复本身失败，所以吞掉异常。
  if (!group.locked) {
    try {
      await deleteTab({ storage: deps.storage }, { groupId: group.id, tabId: tab.id });
      /**
       * 摘掉的那一条记录进回收站（既有约定，用户指令「单个标签恢复还原也要移到回收站」）。
       * 顺序不能反：先删再存 —— 反过来如果删除失败、回收站里却多了一条，
       * 那条 URL 就同时活在会话里和回收站里，还原它会往会话里塞一条重复记录。
       * 会话本身还在列表里，所以这里只并一条记录进去（`mergeIntoTrash` 会并到同一行）。
       */
      await mergeIntoTrash({ storage: deps.storage }, { group, tabs: [tab], reason: 'consumed', at: now() });
    } catch {
      // 记录没摘掉就等于这次单条恢复没消费成功，回收站也不动 —— 保持"要么两处都对，要么都不动"
    }
  } else {
    await deps.storage.touchUpdatedAt(now());
  }
  return { operationId, ok: true };
}

/**
 * 撤销一次收纳（既有约定 + V1.1 §29，既有约定 定案）：
 * 按**原窗口位置**重开本次真的被关掉的那些 tab，然后删掉会话。
 *
 * kept / failed 的不重开 —— 它们从来没离开过窗口（或没成功离开），重开会变成重复项。
 *
 * 为什么删会话：撤销的产品语义是"这次收纳没发生"。留着它，用户误点一次图标就要
 * 手动清理一条他已经不需要的记录；而 §29 担心的"重开失败又没记录"由结果里的
 * `failedUrls` 显式列出兜住（既有约定 的原有结论）。
 */
export async function undoCapture(
  deps: RestoreDeps,
  input: RestoreTarget & { groupId: string },
): Promise<RestoreResult> {
  const operationId = newId();
  const group = await deps.storage.getGroup(input.groupId);
  if (!group) return emptyResult(operationId, input.windowId, 'current');

  const ordered = tabsAsTheyWere(group);
  const reopen = ordered.filter((tab) => tab.closeState === 'closed');
  const notReopened = ordered.length - reopen.length;

  const existing = await deps.tabs.existingUrls(input.windowId);
  // 判据与另外两处同一个（`isRecoverableRecord`，既有约定）：撤销也是"把记录开回来"，
  // 这里只看 URL 的话，一条标着 restorable:false 的记录会在撤销时被尝试打开。
  const targets = reopen.filter((tab) => !existing.has(tab.url) && isRecoverableRecord(tab));
  const dropped = reopen.length - targets.length;

  const created = await mapWithConcurrency(targets, RESTORE_CONCURRENCY, (tab) =>
    deps.tabs.create({ url: tab.url, windowId: input.windowId, active: false }),
  );

  const createdIds: { tabId: number; wasActive: boolean }[] = [];
  const failedUrls: string[] = [];
  created.forEach((outcome, index) => {
    const tab = targets[index];
    if (!tab) return;
    if (outcome.status === 'fulfilled') {
      createdIds.push({ tabId: outcome.value.tabId, wasActive: tab.wasActive });
    } else {
      failedUrls.push(tab.url);
    }
  });

  // 撤销完成后，把焦点还给用户原来那一页
  const toActivate = createdIds.find((entry) => entry.wasActive) ?? createdIds[0];
  if (toActivate) await deps.tabs.update(toActivate.tabId, { active: true }).catch(() => undefined);

  // 既有约定：即使部分重开失败也删分组 —— 已经有一部分条目变成活着的 tab 了，
  // 留着分组会造成"记录里有、窗口里也有"的二次偏差。失败的在结果里显式列出。
  await softDeleteGroup(deps, { groupId: group.id, reason: 'undone', at: now() });

  return {
    operationId,
    // 撤销永远回到收纳发生的那个窗口：它要复原的是那次操作，不是"用户现在在看哪"
    windowId: input.windowId,
    mode: 'current',
    restored: createdIds.length,
    skipped: notReopened + dropped,
    failed: failedUrls.length,
    failedUrls,
    skippedUrls: [],
  };
}
