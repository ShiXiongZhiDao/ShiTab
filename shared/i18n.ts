/**
 * i18n 薄壳（既有约定；应用内切语言见 既有约定）。
 *
 * 两件事收在这一处：
 * 1. **文案来源是自己打的两份目录，不是 `browser.i18n.getMessage`**。
 *    平台那套只按浏览器 UI 语言解析，用户在扩展里选"English"它是不理的 —— 而这次要的正是
 *    应用内可切。代价是 `_locales` 的 JSON 现在既作为静态文件存在（manifest 的
 *    `__MSG_extensionName__` 还要靠它），也被打进 JS（约 31 KB）。
 *    ⚠ **切不动的那部分要如实说**：扩展名、商店描述、工具栏 tooltip 由浏览器按它自己的语言解析，
 *    应用内选了 English 也不会改他在 `edge://extensions` 里看到的名字。
 * 2. **占位符是 `__name__` 具名式**，替换由 `t()` 做，不用 Chrome 的 `$1$` 位置占位符 ——
 *    那要求调用方记住参数顺序，而 zh/en 两份里同一含义的占位符位置并不总是相同。
 *    代价是放弃了 `placeholders` 声明，所以 `test/search-and-backup.spec.ts` 的
 *    "i18n 文案一致性"一节核对三件事：代码用到的 key 都存在于 en、代码传的占位符都出现在
 *    文案里且文案占位符都被传、en 与 zh_CN 的 key 与占位符集合一致。
 *
 * 为什么 `choice` 是一个模块级 `ref`：模板里 `t('...')` 是在渲染函数中执行的，
 * 它读到这个 ref 就登记了依赖 ⇒ 换语言时所有开着的页面**当场重渲染**，不需要刷新。
 * 这不是顺手能拿到的性质：早期版本 `t()` 直接调 `browser.i18n.getMessage`，
 * 换语言要重开页面才生效，而"我选了中文，怎么一半还是英文"是最容易被当成 bug 报回来的形状。
 */

import { computed, ref } from 'vue';
import enMessages from '../public/_locales/en/messages.json';
import zhMessages from '../public/_locales/zh_CN/messages.json';
import { resolveLocale, type ResolvedLocale } from '@/core/domain/settings';
import type { LocaleChoice } from '@/shared/types';

/** 所有合法文案 key。以 en（default_locale）为准 —— 它是兜底语言。 */
export type MessageKey = keyof typeof enMessages;

type Catalog = Record<string, { message: string }>;

const CATALOGS: Record<ResolvedLocale, Catalog> = {
  en: enMessages as Catalog,
  zh_CN: zhMessages as Catalog,
};

/** 用户的选法。`system` 是默认值，也是没读到 Settings 之前的安全值。 */
const choice = ref<LocaleChoice>('system');

/** 浏览器 UI 语言，只在 `choice === 'system'` 时参与决定。 */
const uiLanguage = ref<string>(readUiLanguage());

function readUiLanguage(): string {
  try {
    // WXT 的 `browser` 全局在页面与 service worker 里都在；测试环境是 fakeBrowser，
    // 它的 i18n 是"未实现即抛"，所以整段包在 try 里 —— 抛了就按兜底语言走。
    return browser.i18n.getUILanguage() || 'en';
  } catch {
    return 'en';
  }
}

/** 现在实际用哪份文案。渲染期读它，所以换语言会自动重渲染。 */
export const activeLocale = computed<ResolvedLocale>(() =>
  resolveLocale(choice.value, uiLanguage.value),
);

/** 由 surface 在启动时把 Settings 里的选法同步进来。 */
export function setLocaleChoice(next: LocaleChoice): void {
  choice.value = next;
}

/** 语言包自己不带 `placeholders` 声明，占位符漏没漏只能靠这一层与用例核对。 */
export function t(key: MessageKey, substitutions?: Record<string, string | number>): string {
  const message = CATALOGS[activeLocale.value][key]?.message ?? '';
  if (!message) return key;
  if (!substitutions) return message;
  return Object.entries(substitutions).reduce(
    (text, [name, value]) => text.replaceAll(`__${name}__`, String(value)),
    message,
  );
}

/** 给 `<html lang>` 用：`zh_CN` → `zh-CN`。 */
export function htmlLang(): string {
  return activeLocale.value === 'zh_CN' ? 'zh-CN' : 'en';
}
