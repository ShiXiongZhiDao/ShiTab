/**
 * SavedTab 的领域判断：一条浏览器 tab 该不该被收纳、存下来之后能不能恢复。
 *
 * 两个谓词**互不等价**，别合并：
 * - isCapturableTab   —— 这条 tab 是否属于"今天要收走的东西"（决定存不存，也决定关不关）
 * - isRecoverableRecord —— 存储里那条**记录**还能不能被开出来（读侧，含老数据）
 *
 * 前者在 既有约定 之后读了"不可恢复"一眼，在 既有约定 之后读的是**用户可配置的黑名单**
 * （`isBlockedUrl`）；后者读的是 `restorable` 快照 + 与配置无关的硬底（`isHardFloor`）。
 * 两者**不共用同一个入参**：一个要当下的设置，一个只要记录自己的字段 ——
 * 合并成一个函数，表现就是"读侧对新数据成立、对老数据一概不认"。
 */

import type { BrowserTab, CloseState, SavedTab } from '@/shared/types';
import { ENTRY_PAGE_PATH } from '@/shared/constants';
import { domainOf, newId } from '@/shared/utils';
import { isBlockedUrl, isHardFloor } from '@/core/domain/blocked-prefixes';

/**
 * 一条**已保存的记录**到底能不能被开出来 —— 判据只在这一处。
 *
 * 两半都不能少：
 * - `restorable === true` 是**收纳那一刻**按当时的黑名单算出来的**快照**（既有约定 D4：
 *   改设置不影响老记录）；
 * - `!isHardFloor(url)` 是**与配置无关**的那一层硬底（`javascript:` 被平台点名拒绝、
 *   `about:blank` 是我们自己的落脚页）。
 *
 * ⚠ 为什么 URL 那一半只判硬底、不再判整张黑名单：黑名单是**用户可改的**，拿"现在的配置"
 * 去判"那时候存下的记录"就会得出"当时能存、现在点不动"的结论 —— 而那条记录能不能开，
 * 取决于存它的那一刻，不取决于用户后来点了什么。要按现在的配置判，就得动 既有约定 的判据
 * 本身，那是另一件事（既有约定 D4 里记了为什么没做）。
 *
 * 收它之前是四份：`restore-group.ts` 里两处写着 `!isRestorableUrl(tab.url) || !tab.restorable`
 * （整组恢复的跳过、单条恢复的被拒），`undoCapture` 那处**只看 URL 不看布尔**，
 * 加上回收站的入站过滤 —— 既有约定 把它们收成这一处。
 */
export function isRecoverableRecord(tab: { url?: string; restorable?: boolean }): boolean {
  return tab.restorable === true && !isHardFloor(tab.url);
}

/**
 * 这条 tab 是不是 ShiTab 自己的入口页（标签栏那个 T）？
 *
 * **永不收纳、永不关闭**（V1.1 AC-06）。判据是 pathname 精确相等，
 * 既不用整串 URL 比较（浏览器会补斜杠、查询串会被复制粘贴改写），
 * 也不用 `includes('app.html')`（那会把任何同名的普通扩展页面误判进来）。
 */
export function isEntryTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname === ENTRY_PAGE_PATH;
  } catch {
    return false;
  }
}

/** 收纳范围策略。V1.1 §5 把它做成设置项，因此判断必须有入参可传。 */
export interface CapturePolicy {
  /** 用户自己钉住的 tab 要不要一起收走。ShiTab 入口页不受它影响。 */
  includePinnedTabs: boolean;
  /**
   * 收纳黑名单：命中的 URL 前缀**不收也不关**。
   * 硬底（`javascript:` / `about:blank`）不在这张表里 —— 它在 `isBlockedUrl` 里另外判。
   */
  blockedPrefixes: readonly string[];
}

/**
 * 这条 tab 是否纳入收纳？**"该不该进会话"这一格只在这一个函数里**。
 *
 * 排除三样东西：
 * 1. **入口页自己**（AC-06）；
 * 2. 用户钉住的 tab —— 但仅在 `includePinnedTabs` 为 false 时（V1.1 §5 的默认档）；
 * 3. **不能直接恢复的页面** —— `chrome://` / `edge://` / 扩展页 / 新标签页
 *    （既有约定 反转 既有约定 第 1 条，回到 V1.1 §4.2 那个当初被判"不采纳"的口径）。
 *    这类页面**不收、也不关**：不收 = 会话里没有它；不关 = 它留在浏览器里原封不动。
 *    关闭的集合是从这里出来的（`capture-window.ts` 的 `selectableToClose(capturable, …)`），
 *    所以第三条**必须**写在这个函数里而不是别处 —— 只把记录滤掉、把关闭留在集合上，
 *    结果就是"设置页被关掉了，而会话里查不到它"，那是这一整轮要避免的那一种错。
 *
 * 与 既有约定 §2「排除扩展页、浏览器内部页等不可操作页面」现在**一致**了 ——
 * 那句"排除"以前只由关闭环节承担（关不掉的记 `closeState='failed'`，记录照留），
 * 现在保存与关闭两个环节一起排除。既有约定 签的"照样保存"由 既有约定 撤销。
 *
 * ⚠ 这一条只管**新收纳**。老会话、老备份、老同步载荷里仍然有 `restorable: false` 的行，
 * 读侧（恢复、回收站、撤销、badge）一律继续按 `isRecoverableRecord` 容忍它们。
 */
export function isCapturableTab(tab: BrowserTab, policy: CapturePolicy): boolean {
  if (isEntryTabUrl(tab.url)) return false;
  if (tab.pinned && !policy.includePinnedTabs) return false;
  if (isBlockedUrl(tab.url, policy.blockedPrefixes)) return false;
  return true;
}

export interface ToSavedTabInput {
  tab: BrowserTab;
  groupId: string;
  sortOrder: number;
  createdAt: number;
  /** 按设置保留未关闭时为 kept；关闭成功为 closed；关闭失败为 failed */
  closeState: CloseState;
  /** 与 `isCapturableTab` 同一份黑名单 —— 两处必须同源，见下面 `restorable` 那条注释。 */
  blockedPrefixes: readonly string[];
}

/** 活的浏览器 tab -> 持久化记录。字段映射只在这一处。 */
export function toSavedTab({
  tab,
  groupId,
  sortOrder,
  createdAt,
  closeState,
  blockedPrefixes,
}: ToSavedTabInput): SavedTab {
  const saved: SavedTab = {
    id: newId(),
    groupId,
    url: tab.url ?? '',
    title: tab.title || tab.url || '',
    createdAt,
    sortOrder,
    originalIndex: tab.index,
    originalPinned: tab.pinned,
    wasActive: tab.active,
    closeState,
    // 与 `isCapturableTab` 用的是同一个 `isBlockedUrl`、同一份 `blockedPrefixes`，
    // 所以它跟"这次有没有收它"恒等 —— 除非用户后来改了黑名单，那就是快照（既有约定 D4）。
    // 仍然现算而不是写死 `true`：这个布尔与判据同源是 `isRecoverableRecord` 那条判据的
    // 前提，写死就等于承认"这两处的值可以各长各的"。
    restorable: !isBlockedUrl(tab.url, blockedPrefixes),
  };
  const favicon = tab.favIconUrl;
  if (favicon) saved.faviconUrl = favicon;
  const domain = domainOf(tab.url);
  if (domain) saved.domain = domain;
  return saved;
}
