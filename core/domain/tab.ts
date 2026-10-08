/**
 * SavedTab 的领域判断：一条浏览器 tab 该不该被收纳、存下来之后能不能恢复。
 *
 * 两个谓词**互不等价**，别合并：
 * - isCapturableTab  —— 这条 tab 是否属于"今天要收走的东西"（决定存不存，也决定关不关）
 * - isRestorableUrl  —— 这个 URL 能否被 tabs.create 打开（决定存了之后能不能开回来）
 *
 * 既有约定 之后前者**读了**后者一眼（不可恢复的页面不进会话），但这仍然是两个判据：
 * 后者还要单独回答"存储里那条**老记录**能不能被开出来"，而那些记录不是这个过滤器造出来的。
 * 把它们合并成一个函数，表现就是"读侧对新数据成立、对老数据一概不认"。
 */

import type { BrowserTab, CloseState, SavedTab } from '@/shared/types';
import { ENTRY_PAGE_PATH } from '@/shared/constants';
import { domainOf, newId } from '@/shared/utils';

/**
 * 不可恢复的 URL 前缀黑名单。
 *
 * 这是**产品判断**，不是平台事实的完整映射 —— 见 既有约定 的待重开项。
 * 判据是"扩展调用 tabs.create 打开它会不会被平台拒绝"。
 *
 * ⚠ 既有约定 之后这张表的**分量变了**：它以前只决定"存下来之后能不能点"，
 * 现在还决定"这条 tab 进不进会话、要不要被关掉"。所以表里错杀一项的代价，
 * 从"少一个恢复按钮"变成了"那次收纳里根本没有这条记录"。改这张表要按这个代价来审。
 */
const NON_RESTORABLE_PREFIXES: readonly string[] = [
  'chrome://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'chrome-extension://',
  'moz-extension://',
  'extension://',
  'data:',
  'blob:',
  'javascript:',
];

/** Web Store 页面禁止被扩展打开（平台限制），按 host 单列。 */
const NON_RESTORABLE_HOSTS: readonly string[] = ['chrome.google.com', 'chromewebstore.google.com'];

/**
 * 一条**已保存的记录**到底能不能被开出来 —— 判据只在这一处。
 *
 * 收它之前是四份：`restore-group.ts` 里两处写着 `!isRestorableUrl(tab.url) || !tab.restorable`
 * （整组恢复的跳过、单条恢复的被拒），`undoCapture` 那处**只看 URL 不看布尔**，
 * 加上回收站的入站过滤。前两处与这里等价，第三处在现网数据上也等价（收纳与导入都把
 * `restorable` 算成 `isRestorableUrl(url)` 的同源值），但"等价"要靠人每次去核对 ——
 * 而两份不一样时的表现是：回收站里躺了一条其实开不出来的记录，点还原只得到一句"无法恢复"，
 * 或者反过来，一条能开出来的记录被当成垃圾滤掉。
 */
export function isRecoverableRecord(tab: { url?: string; restorable?: boolean }): boolean {
  return tab.restorable === true && isRestorableUrl(tab.url);
}

/**
 * 这个 URL 能否重新打开？
 *
 * 空串 / 解析失败一律判 false。
 * ⚠ 这句注释原来写的是"判'不可恢复'的代价只是 UI 上少一个恢复按钮" —— 既有约定 之后
 * 那个代价变成了"这条 tab 整条不进会话"（`isCapturableTab` 读它），所以两个方向的代价
 * 现在**不再一边倒**：判错"不可恢复"会丢一条记录，判错"可恢复"会得到一条点了没反应的记录。
 * 仍然保留 fail-closed（认不出来就当不可恢复）的理由是：一条 URL 都读不出来的记录
 * 本来就开不出来，把它留在会话里只是把失败从"收纳时"推到"点击时"。
 */
export function isRestorableUrl(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower === 'about:blank') return false;
  if (NON_RESTORABLE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  try {
    // file:// 的 hostname 是空串，不能因为"没有 host"就判不可恢复（既有约定 第 6 点）。
    const host = new URL(url).hostname.toLowerCase();
    if (NON_RESTORABLE_HOSTS.includes(host)) return false;
    return true;
  } catch {
    return false;
  }
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
  if (!isRestorableUrl(tab.url)) return false;
  return true;
}

export interface ToSavedTabInput {
  tab: BrowserTab;
  groupId: string;
  sortOrder: number;
  createdAt: number;
  /** 按设置保留未关闭时为 kept；关闭成功为 closed；关闭失败为 failed */
  closeState: CloseState;
}

/** 活的浏览器 tab -> 持久化记录。字段映射只在这一处。 */
export function toSavedTab({
  tab,
  groupId,
  sortOrder,
  createdAt,
  closeState,
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
    // 新收纳恒为 true（不可恢复的页面已经被 `isCapturableTab` 挡在门外）。
    // 仍然现算而不是写死 `true`：这个布尔与 `isRestorableUrl` 同源是 `isRecoverableRecord`
    // 那条判据的前提，写死就等于承认"这两处的值可以各长各的"。
    restorable: isRestorableUrl(tab.url),
  };
  const favicon = tab.favIconUrl;
  if (favicon) saved.faviconUrl = favicon;
  const domain = domainOf(tab.url);
  if (domain) saved.domain = domain;
  return saved;
}
