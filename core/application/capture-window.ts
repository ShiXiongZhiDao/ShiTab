/**
 * 收纳当前窗口（V1.1 设计包 §3.1 / §6 / §21）。
 *
 * ## 顺序是硬约束，四条不可交换
 *
 * ```text
 * query → filter → snapshot → persist(unknown) → 落脚页 → remove → persist(真实关闭结果)
 * ```
 *
 * 1. **先持久化，后关闭**（ARCHITECTURE §7 / AC-04）：持久化抛错时一条 tab 都不会被关，
 *    异常原样冒到调用方，UI 报"收纳失败，原标签未关闭"。
 * 2. **落脚页在关闭之前**：Chrome 关掉窗口里最后一条 tab 会**连窗口一起关**（官方文档
 *    "Closing the last tab of a window closes the window too"），那样入口 T 也跟着没了，
 *    用户点一下图标的结果是"窗口消失"。所以先确保 T 存在（或退一步开一个空新标签页），
 *    再开始关。拿不到落脚页就退回"保留活动页"。
 * 3. 持久化跑两遍：第一遍 closeState 全是 'unknown'（就算下一步崩了，用户的东西也在），
 *    第二遍按真实关闭结果改写（AC-11：部分关闭失败时快照仍完整）。
 *
 * ## 范围
 * - 入口页自己**永不收纳、永不关闭**（AC-06，见 domain/tab.isEntryTabUrl）。
 * - 用户钉住的 tab 默认不收，`includePinnedTabs` 打开后一起收（V1.1 §5）。
 * - 浏览器内部页**照样收**（既有约定 判 V1.1 §4.2 的"排除"不采纳）：标 restorable=false，
 *   恢复时计 skipped，关不掉的计 failed。
 */

import type { BrowserTabsPort } from '@/core/ports/browser-tabs';
import type { EntryTabPort } from '@/core/ports/entry-tab';
import type { StoragePort } from '@/core/ports/storage';
import type {
  CaptureFailure,
  CaptureResult,
  CloseState,
  GroupIndexEntry,
  SavedTab,
  TabGroup,
} from '@/shared/types';
import { createGroup } from '@/core/domain/group';
import { isCapturableTab, isRestorableUrl, isEntryTabUrl, toSavedTab } from '@/core/domain/tab';
import type { BrowserTab } from '@/shared/types';
import { newId, now } from '@/shared/utils';

export interface CaptureDeps {
  tabs: BrowserTabsPort;
  storage: StoragePort;
  /** 入口页控制器。收纳前必须先把落脚页安排好，见文件头第 2 条。 */
  entry: EntryTabPort;
}

export type { CaptureFailure };

/**
 * 一条被收纳的 tab：持久化记录 + 它对应的**活浏览器 tab id**。
 *
 * SavedTab.id 是 UUID、BrowserTab.id 是数字，两者不是一回事。必须显式带着这个配对，
 * 否则第二遍写 closeState 时只能靠 URL 反查 —— 而同一窗口里两条相同 URL 的 tab
 * 会被反查到同一个 id，把关闭结果张冠李戴。
 */
interface Stashed {
  saved: SavedTab;
  browserTabId: number;
  wasActive: boolean;
}

/**
 * 收纳的串行锁（V1.1 §22 / AC-12）。
 *
 * service worker 可能在上一轮还没关完 tab 时收到第二次图标点击，两次 query 会拿到
 * 同一批 tab、生成两个会话。这里用**尝试获取**语义：拿不到就立刻返回 in-progress，
 * 不是排队 —— 排队会让用户的第二次点击在几百毫秒后突然又关掉一个窗口，那更糟。
 */
export function createStashLock() {
  let running = false;
  return {
    tryAcquire(): boolean {
      if (running) return false;
      running = true;
      return true;
    },
    release(): void {
      running = false;
    },
    /** 单测与调试用：当前是否被占用。 */
    get busy(): boolean {
      return running;
    },
  };
}

export type StashLock = ReturnType<typeof createStashLock>;

export async function captureWindow(
  deps: CaptureDeps,
  input: { windowId: number; title?: string; at?: number },
): Promise<{ ok: true; result: CaptureResult } | CaptureFailure> {
  const at = input.at ?? now();
  const operationId = newId();

  const settings = await deps.storage.getSettings();
  const policy = { includePinnedTabs: settings.includePinnedTabs };
  const windowTabs = await deps.tabs.queryWindowTabs(input.windowId);
  const capturable = windowTabs.filter((tab) => isCapturableTab(tab, policy));
  const pinnedSkipped = countPinnedSkipped(windowTabs, policy.includePinnedTabs);

  if (capturable.length === 0) {
    return { ok: false, reason: 'no-stashable-tabs', pinnedSkipped };
  }

  const index = await deps.storage.listGroupIndex();
  const group = createGroup({
    // 默认**没有**标题：界面上按占位符显示"未命名标签组"，点一下就能输入。
    // 存空串而不是存中文默认名，是为了不让这条数据被收纳时的浏览器语言钉死。
    // 时间戳由标题行右侧的 `clockStamp(createdAt)` 负责，不再塞进名字里重复一遍。
    title: input.title?.trim() || '',
    createdAt: at,
    sortOrder: nextSortOrder(index),
    sourceWindowId: input.windowId,
  });

  const stash = (closeState: CloseState): Stashed[] =>
    capturable.map((tab, i) => ({
      browserTabId: tab.id,
      wasActive: tab.active,
      saved: toSavedTab({ tab, groupId: group.id, sortOrder: i, createdAt: at, closeState }),
    }));

  // 快照**只构建一次**。第二遍只改 closeState。
  //
  // 不能在这里重新从活 tab 推导一遍：BrowserTab 对象在关闭过程中会被平台/适配器改写
  // （index 会因为前面的 tab 被关掉而整体前移），第二遍再读一次就会把 originalIndex
  // 记成"关掉前面几条之后剩下的位置"。AC-03 要的是收纳那一刻的事实，必须冻结。
  const entries = stash('unknown');

  // ---- 第一遍持久化：先落盘，关闭结果未知 ---------------------------------
  await deps.storage.putGroup({ ...group, tabs: entries.map((entry) => entry.saved) });

  // ---- 落脚页：关掉任何东西之前先确保窗口里还剩一个能看的东西 --------------
  const hasLanding = await ensureLanding(deps, input.windowId);

  // ---- 关闭 ---------------------------------------------------------------
  const willClose = selectableToClose(capturable, {
    closeAfterCapture: settings.closeAfterCapture,
    keepActiveTab: settings.keepActiveTab,
    // 没有落脚页时绝不能把活动页也关掉：那会连窗口一起关（见文件头第 2 条）
    hasLanding,
  });
  const closing = new Set(willClose.map((tab) => tab.id));

  const removal = await deps.tabs.remove([...closing]);
  const failedIds = new Set(removal.failed.map((failure) => failure.tabId));

  // ---- 第二遍持久化：写真实关闭结果 ---------------------------------------
  const withState = entries.map((entry): Stashed => {
    if (!closing.has(entry.browserTabId)) {
      return { ...entry, saved: { ...entry.saved, closeState: 'kept' } };
    }
    const state: CloseState = failedIds.has(entry.browserTabId) ? 'failed' : 'closed';
    return { ...entry, saved: { ...entry.saved, closeState: state } };
  });

  const finalGroup: TabGroup = { ...group, tabs: withState.map((entry) => entry.saved), updatedAt: at };
  await deps.storage.putGroup(finalGroup);

  const count = (state: CloseState) => withState.filter((entry) => entry.saved.closeState === state).length;
  const closedEntries = withState.filter((entry) => entry.saved.closeState === 'closed');

  const result: CaptureResult = {
    operationId,
    groupId: group.id,
    groupTitle: group.title,
    saved: withState.length,
    closed: count('closed'),
    kept: count('kept'),
    failed: count('failed'),
    pinnedSkipped,
    nonRestorableSaved: withState.filter((entry) => !isRestorableUrl(entry.saved.url)).length,
    savedTabs: finalGroup.tabs,
    closableTabIds: closedEntries.map((entry) => entry.browserTabId),
    activeTabUrl: capturable.find((tab) => tab.active)?.url,
    hasLanding,
  };

  return { ok: true, result };
}

/**
 * 入口页被排除在外，所以"因为固定而未收纳"的计数不能把它算进去 ——
 * 否则用户没开 includePinnedTabs 时，每个窗口都会凭空多出一条"1 个固定标签页未被打扰"。
 */
function countPinnedSkipped(tabs: BrowserTab[], includePinnedTabs: boolean): number {
  if (includePinnedTabs) return 0;
  return tabs.filter((tab) => tab.pinned && !isEntryTabUrl(tab.url)).length;
}

/** 哪些 tab 该关。三个条件按优先级叠在一起，纯函数便于单测。 */
export function selectableToClose(
  tabs: BrowserTab[],
  flags: { closeAfterCapture: boolean; keepActiveTab: boolean; hasLanding: boolean },
): BrowserTab[] {
  if (!flags.closeAfterCapture) return [];
  const keepActive = flags.keepActiveTab || !flags.hasLanding;
  return keepActive ? tabs.filter((tab) => !tab.active) : tabs;
}

/**
 * 保证窗口里有一个不会被关闭的落脚点。
 *
 * 首选入口 T 页；它被设置关掉、创建失败、或抛异常时，退一步开一个空新标签页 ——
 * 两种情况下都要让调用方知道结果，因为这决定"敢不敢关活动页"。
 */
async function ensureLanding(deps: CaptureDeps, windowId: number): Promise<boolean> {
  try {
    if (await deps.entry.ensureForWindow(windowId, { focus: true })) return true;
  } catch (error) {
    console.warn('[shitab] 入口页不可用，退回新标签页落脚', error);
  }
  try {
    await deps.tabs.create({ url: 'about:blank', windowId, active: true });
    return true;
  } catch (error) {
    console.error('[shitab] 连落脚页都创建不出来，本次不关活动页', error);
    return false;
  }
}

/** 新组排在最末。 */
export function nextSortOrder(index: GroupIndexEntry[]): number {
  if (index.length === 0) return 0;
  return Math.max(...index.map((entry) => entry.sortOrder)) + 1;
}

/**
 * 收纳**不再生成自动标题**（既有约定，取代 既有约定）：见下面 `createGroup` 那行的注释。
 * 原来这里有个 `deriveTitle()` 拼 `2026-10-04 01:42 · 8 个标签`，删掉了。
 */
