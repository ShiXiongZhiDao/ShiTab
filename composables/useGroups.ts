/**
 * UI/session 状态的唯一来源。
 *
 * Pinia 只管**视图侧**的东西：快照、筛选、已加载的会话内容、进行中标志、结果 toast。
 * 业务数据的真相在 StoragePort 后面，不在 store 里。
 *
 * V1.2 的形状变化：右栏不再是"选中会话的详情"，而是**所有会话平铺**。
 * 于是这里多了三件事：分类与筛选、按会话惰性加载 tab（`tabsOf` + `loadTabs`）、
 * 分批渲染（`shownCount` + `requestMore`）。没有虚拟列表库 —— 那是 既有约定 的依赖底线。
 */

import { computed, ref, shallowRef, triggerRef } from 'vue';
import { defineStore } from 'pinia';
import {
  deleteGroup,
  moveTab,
  renameGroup,
  removeTabToTrash,
  reorderGroups,
  reorderTab,
  toggleLock,
  togglePin,
} from '@/core/application/group-commands';
import { GroupLockedError } from '@/core/application/group-commands';
import {
  assignGroupToCategory,
  createCategoryCommand,
  deleteCategory,
  renameCategory,
  reorderCategories,
} from '@/core/application/category-commands';
import {
  backupFilename,
  buildBackup,
  downloadBackup,
  downloadFile,
  parseBackupJson,
  serializeBackup,
  importBackup,
} from '@/core/application/import-export';
import { buildShareHtml, clipboardTextOfGroup, clipboardTextOfTab, shareFilename } from '@/core/application/share';
import { matchesFilter } from '@/core/domain/category';
import { copyToClipboard } from '@/shared/clipboard';
import { sendCommand } from '@/shared/messages';
import type { CaptureNotice } from '@/shared/messages';
import { deps, ensureReady, storagePort } from '@/shared/services';
import { UNDO_WINDOW_MS } from '@/shared/constants';
import type {
  CaptureResult,
  Category,
  CategoryFilter,
  GroupIndexEntry,
  RestoreMode,
  RestoreResult,
  SavedTab,
  ValidationError,
} from '@/shared/types';
import { t, type MessageKey } from '@/shared/i18n';
import { newId, now } from '@/shared/utils';

export type Toast =
  | { kind: 'capture'; result: CaptureResult; canUndo: boolean }
  | { kind: 'restore'; result: RestoreResult }
  | { kind: 'import'; groups: number; tabs: number; categories: number }
  | { kind: 'message'; key: MessageKey; subs?: Record<string, string | number>; tone: 'ok' | 'warn' | 'error' }
  | null;

/** 一屏先渲染多少个会话；滚到底再追加这么多（TabClip 用 offset 分页，我们没有后端，切片即可）。 */
export const RENDER_BATCH = 20;

/** 校验错误 -> 文案 key。三类可解释的给专门的提示，其余退到"不是有效 JSON"。 */
function validationToast(error: ValidationError | undefined): {
  key: MessageKey;
  subs?: Record<string, string | number>;
} {
  switch (error?.kind) {
    case 'wrong-format':
      return { key: 'import_wrong_format' };
    case 'unsupported-version':
      return { key: 'import_unsupported_version', subs: { version: String(error.found) } };
    default:
      return { key: 'import_invalid_json' };
  }
}

export const useGroups = defineStore('groups', () => {
  const index = ref<GroupIndexEntry[]>([]);
  const categories = ref<Category[]>([]);
  /**
   * 会话 id -> 已加载的 tab。undefined = 还没加载；空数组 = 这个会话确实是空的。
   *
   * 用 `shallowRef` + **原地增删**，不是 `ref` + 整块替换。真机上踩过一次"只有第一个会话
   * 展开了内容"：`reload()` 与每个区块自己的 `loadTabs()` 是两个并发写者，各自
   * "复制整张 Map → 改 → 赋值回去"，后写的那一份会把先写的条目连根覆盖掉；
   * 而 `loadTabs` 的 `has(id)` 守卫让被覆盖的那条区块**永远不会重试**，界面就停在省略号上。
   * 原地改就没有"谁的副本赢"这回事了。
   */
  const tabsById = shallowRef(new Map<string, SavedTab[]>());
  /** 同一会话的回源去重：并发调用共享同一个 promise（区块重挂载、reload 撞车都靠它收敛）。 */
  const inflight = new Map<string, Promise<void>>();
  const filter = ref<CategoryFilter>({ kind: 'all' });
  /** 右栏当前渲染多少个会话（分批渲染的游标） */
  const shownCount = ref(RENDER_BATCH);
  const loading = ref(true);
  const busy = ref(false);
  const toast = ref<Toast>(null);
  const error = ref<string | null>(null);
  /** 撤销目标会话 id；toast 计时到或用户撤销后清空 */
  const undoTarget = ref<string | null>(null);
  /**
   * 批量勾选（既有约定 把主列表改成和回收站同一套形状，见 既有约定 的层级）。
   *
   * **状态只有一份：`checkedRecords`（键 `groupId::tabId`），行首框是它的派生视图** ——
   * 行首框 = "这一行的全选 / 全不选"，只勾了一半时半选。之前这里是一个 `Set<groupId>`，
   * 组内记录不参与批量，所以他要说「所有标签组、分类也支持标签组内多选操作」。
   *
   * ⚠ "这一行被全部勾上"要按**整份记录表**判（`cachedRecordKeys`），不是按界面上看得见的那几条：
   * 搜索态下右栏是命中子集（`App.vue` 的 `tabsFor`），拿子集算全覆盖会把**没命中的记录**
   * 一起送进整组动作 —— 那是数据损失，不是显示问题。
   */
  const checkedRecords = ref(new Set<string>());
  const recordKey = (groupId: string, tabId: string): string => `${groupId}::${tabId}`;
  const splitRecordKey = (key: string): { groupId: string; tabId: string } => {
    const at = key.lastIndexOf('::');
    return { groupId: key.slice(0, at), tabId: key.slice(at + 2) };
  };

  let subscription: (() => void) | undefined;
  let categorySubscription: (() => void) | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let initialized = false;

  const totalTabs = computed(() => index.value.reduce((sum, entry) => sum + entry.tabCount, 0));
  const isEmpty = computed(() => index.value.length === 0);
  const uncategorizedCount = computed(
    () => index.value.filter((entry) => entry.categoryId === undefined).length,
  );
  /** 当前筛选下要渲染的会话（顺序沿用 storagePort 的 compareGroups：置顶优先） */
  const visible = computed(() => index.value.filter((entry) => matchesFilter(entry, filter.value)));
  const rendered = computed(() => visible.value.slice(0, shownCount.value));
  const hasMore = computed(() => shownCount.value < visible.value.length);
  /** 一个会话的**全部**记录键，只读缓存（渲染与派生用这个：区块挂载即 `loadTabs`，看得见就一定有缓存）。 */
  function cachedRecordKeys(groupId: string): string[] {
    return (tabsById.value.get(groupId) ?? []).map((tab) => recordKey(groupId, tab.id));
  }

  /** 同上，但缓存没到就回源一次（点行首框、全选这种"要动整行"的动作走它）。 */
  async function allRecordKeys(groupId: string): Promise<string[]> {
    if (!tabsById.value.has(groupId)) await loadTabs(groupId);
    return cachedRecordKeys(groupId);
  }

  /**
   * 行首框的三态。
   *
   * `visibleTabIds` = **这一行现在渲染出来的那些记录 id**（`GroupRow` 传它自己的 `ordered`）。
   * 平时它等于整表；搜索态下它是命中子集 —— 那时"勾满了"要说的是"你看得见的都勾了"，
   * 而不是"整组勾了"。⚠ 它**不参与**"整组动作"的判据（`checkedGroupIds` 只看整表），
   * 所以搜索态里无论怎么点行首框，都不会把没命中的记录送进整组删除。
   */
  function rowState(groupId: string, visibleTabIds?: string[]): 'all' | 'some' | 'none' {
    const keys = visibleTabIds
      ? visibleTabIds.map((tabId) => recordKey(groupId, tabId))
      : cachedRecordKeys(groupId);
    const hit = keys.reduce((sum, key) => (checkedRecords.value.has(key) ? sum + 1 : sum), 0);
    if (keys.length > 0 && hit === keys.length) return 'all';
    return hit > 0 ? 'some' : 'none';
  }

  function isRecordChecked(groupId: string, tabId: string): boolean {
    return checkedRecords.value.has(recordKey(groupId, tabId));
  }

  /**
   * 被整行覆盖的会话 ⇒ 批量按**整组**动作处理（`restoreGroup` / `deleteGroup`）。
   *
   * 判据是"这一行的勾选数 == 这一行的记录总数"，走**缓存里那份整表**（`cachedRecordKeys`），
   * 两件事因此成立：① 不看 `index`，所以组件级用例（只挂一个 GroupRow、没 `init()`）也算得对；
   * ② 不看界面上看得见的那几条 —— 搜索态下右栏是命中子集，拿子集判会把没命中的记录
   * 一起送进整组动作，那是数据损失。
   */
  const checkedGroupIds = computed(() => {
    const hits = new Map<string, number>();
    for (const key of checkedRecords.value) {
      const { groupId } = splitRecordKey(key);
      hits.set(groupId, (hits.get(groupId) ?? 0) + 1);
    }
    return [...hits.entries()]
      .filter(([groupId, hit]) => {
        const total = cachedRecordKeys(groupId).length;
        return total > 0 && hit === total;
      })
      .map(([groupId]) => groupId);
  });
  /** 没被整行覆盖的那部分勾选才是"记录级"的 —— 两个数这样分才不会重复计。 */
  const looseRecordKeys = computed(() => {
    const whole = new Set(checkedGroupIds.value);
    return [...checkedRecords.value].filter((key) => !whole.has(splitRecordKey(key).groupId));
  });
  const checkedCount = computed(() => checkedGroupIds.value.length);
  const recordCount = computed(() => looseRecordKeys.value.length);
  /** 批量条出没出现看这个（整组与记录级都算"有勾选"）。 */
  const selectionCount = computed(() => checkedRecords.value.size);

  /** 本页面所在的窗口（工作台是一个标签页，这个值定义明确 —— 既有约定）。 */
  async function windowId(): Promise<number> {
    const { id } = await deps.tabs.getCurrentWindow();
    return id;
  }

  async function reload(): Promise<void> {
    index.value = await storagePort.listGroupIndex();
    categories.value = await storagePort.listCategories();
    // 已加载的会话要跟着刷新内容，否则跨组移动后右栏显示的是旧快照。
    // 注意这里**原地**改：见上面 tabsById 那段注释里被覆盖掉的那次真机 bug。
    const alive = new Set(index.value.map((entry) => entry.id));
    for (const id of [...tabsById.value.keys()]) {
      if (!alive.has(id)) {
        tabsById.value.delete(id);
        continue;
      }
      const group = await storagePort.getGroup(id);
      if (group) tabsById.value.set(id, group.tabs);
      else tabsById.value.delete(id);
    }
    triggerRef(tabsById);
    // 筛选器指向的分类被删掉了 => 退回"所有分类"，不要让右栏空得没有理由
    const current = filter.value;
    if (
      current.kind === 'category' &&
      !categories.value.some((category) => category.id === current.id)
    ) {
      filter.value = { kind: 'all' };
    }
    // 勾选要跟着存储剔掉已经不存在的记录（对面同步删了会话、或这条记录被还原/删除掉了）。
    // 只按**已加载**的会话核 —— 一条记录能被勾上，它所在的区块就一定已经 `loadTabs` 过，
    // 所以"缓存里没有"不等于"该剔"，只有"缓存里有这份表而表里没这条"才该剔。
    const kept = [...checkedRecords.value].filter((key) => {
      const { groupId, tabId } = splitRecordKey(key);
      const tabs = tabsById.value.get(groupId);
      return tabs !== undefined && tabs.some((tab) => tab.id === tabId);
    });
    if (kept.length !== checkedRecords.value.size) checkedRecords.value = new Set(kept);
  }

  /** 右栏的每个会话卡片挂载时调一次；同一会话只回源一次，并发调用共享同一个请求。 */
  function loadTabs(id: string): Promise<void> {
    if (tabsById.value.has(id)) return Promise.resolve();
    const pending = inflight.get(id);
    if (pending) return pending;
    const task = (async () => {
      const group = await storagePort.getGroup(id);
      // 键已经不在了就**不**写缓存：把一条被删掉的会话显示成"空会话"是撒谎。
      // 这种不一致由启动自愈在下一次 init 时抹平。
      if (group) {
        tabsById.value.set(id, group.tabs);
        triggerRef(tabsById);
      }
    })().finally(() => {
      inflight.delete(id);
    });
    inflight.set(id, task);
    return task;
  }

  function tabsOf(id: string): SavedTab[] | undefined {
    return tabsById.value.get(id);
  }

  function setFilter(next: CategoryFilter): void {
    filter.value = next;
    shownCount.value = RENDER_BATCH;
  }

  /** 无限滚动的哨兵可见时调用。到顶了就不要再 +，否则 shownCount 会无界增长。 */
  function requestMore(): void {
    if (shownCount.value >= visible.value.length) return;
    shownCount.value = Math.min(shownCount.value + RENDER_BATCH, visible.value.length);
  }

  /**
   * 行首框 = 这一行的全选 / 全不选。只动这一行的键，别行的勾选纹丝不动。
   * `visibleTabIds` 的含义同 `rowState`（搜索态下它挡住"一次点击把没命中的记录也选走"）。
   */
  async function toggleRow(groupId: string, visibleTabIds?: string[]): Promise<void> {
    const keys = visibleTabIds
      ? visibleTabIds.map((tabId) => recordKey(groupId, tabId))
      : await allRecordKeys(groupId);
    const next = new Set(checkedRecords.value);
    const covered = keys.length > 0 && keys.every((key) => next.has(key));
    if (covered) keys.forEach((key) => next.delete(key));
    else keys.forEach((key) => next.add(key));
    checkedRecords.value = next;
  }

  /** 行内那颗**永远能点**（既有约定 的教训：不要锁住可用的控件，层级由半选那根横杠说）。 */
  function toggleRecord(groupId: string, tabId: string): void {
    const next = new Set(checkedRecords.value);
    const key = recordKey(groupId, tabId);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    checkedRecords.value = next;
  }

  function clearChecked(): void {
    checkedRecords.value = new Set();
  }

  /** 「全选」= 当前筛选下每一行都被整行覆盖（于是记录级那部分归零）。 */
  async function selectAllVisible(): Promise<void> {
    const next = new Set(checkedRecords.value);
    for (const entry of visible.value) {
      for (const key of await allRecordKeys(entry.id)) next.add(key);
    }
    checkedRecords.value = next;
  }

  function showToast(next: Exclude<Toast, null>, ms?: number): void {
    if (toastTimer) clearTimeout(toastTimer);
    toast.value = next;
    toastTimer = setTimeout(() => {
      toast.value = null;
      undoTarget.value = null;
    }, ms ?? 5_000);
  }

  /** 命令失败时的统一呈现：错误原文进红条，用户能看到"为什么没成"。 */
  function fail(cause: unknown, key: MessageKey = 'operation_failed'): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    error.value = message;
    showToast({ kind: 'message', key, tone: 'error' });
  }

  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    busy.value = true;
    error.value = null;
    try {
      return await task();
    } catch (cause) {
      fail(cause);
      return undefined;
    } finally {
      busy.value = false;
    }
  }

  // ---- 长任务：走 background 消息通道--------------------------

  /**
   * 图标收纳完成后，由 background 的通知驱动。
   *
   * 页面上**没有**收纳按钮了：工具栏图标是唯一入口。但撤销条的宿主是这个页面，
   * 所以"刚收纳完"这件事必须自己送上门 —— 参数里的 `windowId` 已经由订阅方核对过是本窗口。
   */
  function noteCapture(notice: CaptureNotice): void {
    undoTarget.value = notice.result.groupId;
    showToast(
      { kind: 'capture', result: notice.result, canUndo: notice.result.closed > 0 },
      UNDO_WINDOW_MS,
    );
    // 新会话要立刻出现在右栏（watchGroups 也会带来这次 reload，这里不指望它赶在用户滚动之前）
    void reload();
  }

  /** mode 缺省 'current'；'incognito' 失败会如实报错，不降级成普通窗口。 */
  async function restoreGroup(groupId: string, mode: RestoreMode = 'current'): Promise<void> {
    await run(async () => {
      const result = await sendCommand(
        { kind: 'restoreGroup', windowId: await windowId(), groupId, mode },
        newId(),
      );
      await reload();
      showToast({ kind: 'restore', result });
    });
  }

  /**
   * 批量还原：被整行覆盖的会话走**整组**还原，其余按记录逐条还原。
   *
   * 两条纪律从回收站那边原样搬过来：**顺序 `await`，一条一条来** ——
   * 整组还原会消费会话并把记录送进回收站，那些都是整块数组的读-改-写，
   * 并发跑就是后写覆盖先写；两份目标按构造互斥（`looseRecordKeys` 剔掉了被整行覆盖的），
   * 所以同一行不会被做两遍。
   */
  async function restoreChecked(): Promise<void> {
    const groups = [...checkedGroupIds.value];
    const records = looseRecordKeys.value.map(splitRecordKey);
    clearChecked();
    for (const id of groups) await restoreGroup(id);
    if (records.length === 0) return;
    await run(async () => {
      const win = await windowId();
      let restored = 0;
      let failed = 0;
      for (const { groupId, tabId } of records) {
        const result = await sendCommand(
          { kind: 'restoreTab', windowId: win, groupId, tabId },
          newId(),
        );
        if (result.ok) restored += 1;
        else failed += 1;
      }
      await reload();
      showToast({
        kind: 'message',
        key: failed > 0 ? 'bulk_records_partial' : 'bulk_records_restored',
        subs: failed > 0 ? { records: restored, failed } : { records: restored },
        tone: failed > 0 ? 'warn' : 'ok',
      });
    });
  }

  async function restoreOneTab(groupId: string, tabId: string): Promise<void> {
    await run(async () => {
      const result = await sendCommand(
        { kind: 'restoreTab', windowId: await windowId(), groupId, tabId },
        newId(),
      );
      if (!result.ok) {
        showToast({ kind: 'message', key: 'tab_not_restorable', tone: 'error' });
        return;
      }
      showToast({ kind: 'message', key: 'tab_restored', tone: 'ok' }, 2_500);
    });
  }

  async function undo(): Promise<void> {
    const groupId = undoTarget.value;
    if (!groupId) return;
    undoTarget.value = null;
    await run(async () => {
      const result = await sendCommand(
        { kind: 'undoCapture', windowId: await windowId(), groupId },
        newId(),
      );
      await reload();
      toast.value = null;
      showToast({ kind: 'restore', result });
    });
  }

  /** 入口页自修复（设计包 A §13）：只发一次，页面自己不去碰 tabs API。 */
  async function ensureEntry(): Promise<void> {
    await sendCommand({ kind: 'ensureEntryTab', windowId: await windowId() }, newId()).catch(
      (cause: unknown) => console.error('[shitab] 入口页自修复失败', cause),
    );
  }

  // ---- 纯数据命令：在调用方进程内执行---------------------------

  async function rename(groupId: string, title: string): Promise<void> {
    await run(async () => {
      await renameGroup(deps, { groupId, title });
      await reload();
    });
  }

  async function remove(groupId: string): Promise<void> {
    await run(async () => {
      await deleteGroup(deps, { groupId });
      if (undoTarget.value === groupId) undoTarget.value = null;
      await reload();
    });
  }

  /**
   * 批量删除勾选的会话（真机第六轮："标签组可以多选删除"）。
   *
   * 锁定的**跳过而不是让整批失败**：一条 GroupLockedError 抛出去，
   * 后面那些没锁的就没删成，而界面上只看到一句"会话已锁定" —— 那是最差的结局。
   * 跳过了几个必须说出来，否则"我勾了 5 个怎么只剩 3 个"无法解释。
   */
  /**
   * 批量删除勾选的内容（真机第六轮："标签组可以多选删除"；既有约定 加上组内记录）。
   *
   * 锁定的**跳过而不是让整批失败**：一条 GroupLockedError 抛出去，
   * 后面那些没锁的就没删成，而界面上只看到一句"会话已锁定" —— 那是最差的结局。
   * 跳过了几个必须说出来，否则"我勾了 5 个怎么只剩 3 个"无法解释。
   * ⚠ 记录级那一条也要 catch：锁定的会话里单条记录删不掉（`removeTabToTrash` 走
   * `requireUnlockedGroup`），不 catch 就是整批在这里断掉 —— 与上面同一条理由。
   * 顺序仍然 `await`：墓碑与回收站那一项都是整块数组的读-改-写。
   */
  async function removeChecked(): Promise<void> {
    const groups = [...checkedGroupIds.value];
    const records = looseRecordKeys.value.map(splitRecordKey);
    let deletedGroups = 0;
    let deletedRecords = 0;
    let skipped = 0;
    await run(async () => {
      for (const id of groups) {
        try {
          await deleteGroup(deps, { groupId: id });
          deletedGroups += 1;
          if (undoTarget.value === id) undoTarget.value = null;
        } catch (cause) {
          if (cause instanceof GroupLockedError) {
            skipped += 1;
            continue;
          }
          throw cause;
        }
      }
      for (const { groupId, tabId } of records) {
        try {
          // 删一条记录也进回收站：命令内部按"先摘除、再入站"的顺序做，这里不给两段各调一次
          await removeTabToTrash(deps, { groupId, tabId });
          deletedRecords += 1;
        } catch (cause) {
          if (cause instanceof GroupLockedError) {
            skipped += 1;
            continue;
          }
          throw cause;
        }
      }
      clearChecked();
      await reload();
      showToast({
        kind: 'message',
        key: skipped > 0 ? 'bulk_delete_done_skipped' : 'bulk_delete_done',
        subs: { groups: deletedGroups, records: deletedRecords, skipped },
        tone: skipped > 0 ? 'warn' : 'ok',
      });
    });
  }

  async function removeTab(groupId: string, tabId: string): Promise<void> {
    await run(async () => {
      // 删一条记录也进回收站：命令内部按"先摘除、再入站"的顺序做，这里不给两段各调一次
      await removeTabToTrash(deps, { groupId, tabId });
      await reload();
    });
  }

  async function pin(groupId: string): Promise<void> {
    await run(async () => {
      await togglePin(deps, { groupId });
      await reload();
    });
  }

  async function lock(groupId: string): Promise<void> {
    await run(async () => {
      await toggleLock(deps, { groupId });
      await reload();
    });
  }

  async function moveGroupTo(groupId: string, toIndex: number): Promise<void> {
    await run(async () => {
      await reorderGroups(deps, { groupId, toIndex });
      await reload();
    });
  }

  async function moveTabWithin(groupId: string, tabId: string, toIndex: number): Promise<void> {
    await run(async () => {
      await reorderTab(deps, { groupId, tabId, toIndex });
      await reload();
    });
  }

  async function moveTabAcross(
    tabId: string,
    fromGroupId: string,
    toGroupId: string,
    insertAt: number,
  ): Promise<void> {
    await run(async () => {
      await moveTab(deps, { tabId, fromGroupId, toGroupId, insertAt });
      await reload();
    });
  }

  async function assign(groupId: string, categoryId?: string): Promise<void> {
    await run(async () => {
      await assignGroupToCategory(deps, { groupId, categoryId });
      await reload();
    });
  }

  // ---- 分类命令 -----------------------------------------------------------

  async function addCategory(name: string): Promise<Category | undefined> {
    return run(async () => {
      const created = await createCategoryCommand(deps, { name });
      await reload();
      return created;
    });
  }

  async function renameCategoryById(categoryId: string, name: string): Promise<void> {
    await run(async () => {
      await renameCategory(deps, { categoryId, name });
      await reload();
    });
  }

  async function removeCategory(categoryId: string): Promise<void> {
    await run(async () => {
      await deleteCategory(deps, { categoryId });
      await reload();
    });
  }

  async function moveCategoryTo(categoryId: string, toIndex: number): Promise<void> {
    await run(async () => {
      await reorderCategories(deps, { categoryId, toIndex });
      await reload();
    });
  }

  // ---- 复制 / 导出（零权限的"分享"，既有约定）------------------------------

  async function copyGroup(groupId: string): Promise<void> {
    await run(async () => {
      const group = await storagePort.getGroup(groupId);
      if (!group) throw new Error('会话不存在');
      await copyToClipboard(clipboardTextOfGroup(group));
      showToast(
        { kind: 'message', key: 'copy_done', subs: { count: group.tabs.length }, tone: 'ok' },
        2_500,
      );
    });
  }

  async function copyOneTab(tab: SavedTab): Promise<void> {
    await run(async () => {
      await copyToClipboard(clipboardTextOfTab(tab));
      showToast({ kind: 'message', key: 'copy_tab_done', tone: 'ok' }, 2_000);
    });
  }

  /** 导出单个会话为自包含 HTML 文件（本地下载，不上传任何东西）。 */
  async function exportGroupHtml(groupId: string): Promise<void> {
    await run(async () => {
      const group = await storagePort.getGroup(groupId);
      if (!group) throw new Error('会话不存在');
      const at = now();
      downloadFile(shareFilename(group.title, at), buildShareHtml(group, at, t('brandName')), 'text/html');
      showToast({ kind: 'message', key: 'export_done', tone: 'ok' });
    });
  }

  // ---- 全量导入 / 导出 -----------------------------------------------------

  async function exportAll(): Promise<void> {
    await run(async () => {
      const snapshot = await storagePort.snapshotAll();
      const at = now();
      downloadBackup(
        backupFilename(at),
        serializeBackup(buildBackup(snapshot.groups, snapshot.categories, snapshot.settings, at)),
      );
      await storagePort.markExported(at);
      showToast({ kind: 'message', key: 'export_done', tone: 'ok' });
    });
  }

  /** fileText 来自 <input type="file">；失败时把校验错误原样贴出来。 */
  async function importFile(text: string): Promise<void> {
    await run(async () => {
      const outcome = parseBackupJson(text);
      if (!outcome.ok) {
        const first = outcome.errors[0];
        error.value = first ? `${first.kind} :: ${'message' in first ? first.message : ''}` : 'import 失败';
        showToast({ kind: 'message', ...validationToast(first), tone: 'error' });
        return;
      }
      const result = await importBackup(deps, outcome.backup);
      await reload();
      showToast({
        kind: 'import',
        groups: result.groupsImported,
        tabs: result.tabsImported,
        categories: result.categoriesImported,
      });
    });
  }

  // ---- 生命周期 -----------------------------------------------------------

  async function init(): Promise<void> {
    if (initialized) return;
    initialized = true;
    await ensureReady();
    subscription = storagePort.watchGroups(() => {
      void reload();
    });
    categorySubscription = storagePort.watchCategories(() => {
      void reload();
    });
    await reload();
    loading.value = false;
  }

  /** surface 卸载时调用；store 是每上下文一个，所以 dispose 要能重新 init。 */
  function dispose(): void {
    subscription?.();
    subscription = undefined;
    categorySubscription?.();
    categorySubscription = undefined;
    inflight.clear();
    if (toastTimer) clearTimeout(toastTimer);
    initialized = false;
  }

  function dismissToast(): void {
    if (toastTimer) clearTimeout(toastTimer);
    toast.value = null;
    undoTarget.value = null;
  }

  return {
    index,
    categories,
    filter,
    shownCount,
    loading,
    busy,
    toast,
    error,
    undoTarget,
    checkedRecords,
    checkedCount,
    recordCount,
    selectionCount,
    totalTabs,
    isEmpty,
    uncategorizedCount,
    visible,
    rendered,
    hasMore,
    init,
    dispose,
    reload,
    loadTabs,
    tabsOf,
    setFilter,
    requestMore,
    rowState,
    isRecordChecked,
    toggleRow,
    toggleRecord,
    selectAllVisible,
    clearChecked,
    windowId,
    dismissToast,
    noteCapture,
    restoreGroup,
    restoreChecked,
    restoreOneTab,
    undo,
    ensureEntry,
    rename,
    remove,
    removeChecked,
    removeTab,
    pin,
    lock,
    moveGroupTo,
    moveTabWithin,
    moveTabAcross,
    assign,
    addCategory,
    renameCategoryById,
    removeCategory,
    moveCategoryTo,
    copyGroup,
    copyOneTab,
    exportGroupHtml,
    exportAll,
    importFile,
  };
});
