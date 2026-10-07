/** Settings 的默认值与防御性合并。 */

import type { LocaleChoice, Settings, Theme } from '@/shared/types';

/**
 * 注意：**没有** compactMode 与 restoreInOrder —— 既有约定 砍掉了它们
 * （前者全套文档零定义；后者的 false 没有可解释的语义）。
 */
export const DEFAULT_SETTINGS: Settings = {
  closeAfterCapture: true,
  // V1.1：收纳后连活动页一起关，落地页交给入口 T。
  keepActiveTab: false,
  includePinnedTabs: false,
  // V1.2：`openRestoredGroupInNewWindow` 被删 —— "在新窗口还原"变成了组标题行上的按钮。
  // V1.2 真机第六轮：`deleteGroupAfterRestore` 也被删 —— 恢复即消费，想留下就锁定。
  pinnedEntryEnabled: true,
  // 默认**不**重建：用户关掉一个"关不掉的标签页"会是投诉源。
  autoRestorePinnedTab: false,
  keepPinnedTabFirst: true,
  theme: 'system',
  // 默认跟随浏览器 UI 语言。"装完就是我浏览器的那门语言"是预期行为，
  // 显式选一次是例外。
  locale: 'system',
};

const THEMES: readonly Theme[] = ['system', 'light', 'dark'];
const LOCALES: readonly LocaleChoice[] = ['system', 'zh_CN', 'en'];

/** 真正打进 bundle 的两份文案目录（`_locales` 里也只有这两个）。 */
export type ResolvedLocale = 'zh_CN' | 'en';

/**
 * 把"用户的选法 + 浏览器 UI 语言"算成"实际用哪份文案"。
 *
 * 兜底是 `en` 而不是"原样返回浏览器语言"：`_locales` 里只有 en 与 zh_CN，
 * 而 manifest 的 `default_locale` 是 en —— 浏览器是日语/韩语时，扩展名与描述本来就会显示英文，
 * 界面跟着走同一条规则，才不会出现在"名字英文、菜单日文乱码"这种自相矛盾的状态。
 *
 * 中文侧只认 `zh` 前缀：`zh-CN`/`zh-TW`/`zh-Hant` 都落到 zh_CN。
 * 繁体用户看到的是简体 —— 这是"两套文案"这个决定的直接后果，不是这里的 bug；
 * 要支持繁体得先加第三份目录，那是另一件事。
 */
export function resolveLocale(choice: LocaleChoice, uiLanguage: string): ResolvedLocale {
  if (choice !== 'system') return choice;
  return uiLanguage.toLowerCase().startsWith('zh') ? 'zh_CN' : 'en';
}

const BOOLEAN_KEYS = [
  'closeAfterCapture',
  'keepActiveTab',
  'includePinnedTabs',
  'pinnedEntryEnabled',
  'autoRestorePinnedTab',
  'keepPinnedTabFirst',
] as const;

/**
 * 从任意来源（storage 里的旧数据、导入的 JSON）合并出可用的 Settings。
 *
 * 未知键（含被砍掉的 compactMode / restoreInOrder）**静默忽略**而不是报错 ——
 * 按 既有约定 §4 原文写出来的备份仍然必须能导入（既有约定 后果条）。
 *
 * `closeActiveTab`（V1.0 的字段，语义与 `keepActiveTab` 相反）也在这里翻译：
 * 老备份里的 `closeActiveTab: false` == `keepActiveTab: true`。
 * 存储层的 v1→v2 迁移走的是同一套规则，两边共用这一个函数，不分叉。
 */
export function mergeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const source = raw as Record<string, unknown>;
  const merged: Settings = { ...DEFAULT_SETTINGS };

  for (const key of BOOLEAN_KEYS) {
    if (typeof source[key] === 'boolean') merged[key] = source[key];
  }

  // 老字段只在新字段缺席时生效：新字段是显式选择，不能被旧值覆盖。
  if (typeof source.closeActiveTab === 'boolean' && typeof source.keepActiveTab !== 'boolean') {
    merged.keepActiveTab = !source.closeActiveTab;
  }

  if (typeof source.theme === 'string' && THEMES.includes(source.theme as Theme)) {
    merged.theme = source.theme as Theme;
  }
  // 认不出的语言值留在默认上（'system'）：备份可以来自旧版本，也可以被人手改过，
  // 这里兜住才不会让 t() 拿到一个没有目录的语言。
  if (typeof source.locale === 'string' && LOCALES.includes(source.locale as LocaleChoice)) {
    merged.locale = source.locale as LocaleChoice;
  }
  return merged;
}

/** 是否需要在 <html> 上加 .dark（既有约定 的主题派生）。 */
export function resolveIsDark(theme: Theme, systemPrefersDark: boolean): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return systemPrefersDark;
}
