import { onScopeDispose, ref } from 'vue';
import { htmlLang, setLocaleChoice } from '@/shared/i18n';
import { storagePort } from '@/shared/services';
import type { LocaleChoice } from '@/shared/types';

/**
 * 界面语言。形状照抄 `useTheme`：真相在 `Settings.locale`（storage），
 * 这里只负责把它投影到 `shared/i18n` 的那个 ref 上，并在别的 surface 改了设置时跟着变。
 *
 * 三个 surface（设置页 / 工作台 / background）各自 init 一次：
 * 少一个就会出现"设置页选了 English，工作台还是中文"，而用户判断不出是哪个没跟上。
 */
export function useLocale() {
  const locale = ref<LocaleChoice>('system');
  let stop: (() => void) | undefined;

  function apply(): void {
    setLocaleChoice(locale.value);
    // `<html lang>` 是给读屏与字体回退用的；切了界面文字却不改 lang，
    // 中文界面会被读屏按英文发音念出来。
    if (typeof document !== 'undefined') document.documentElement.lang = htmlLang();
  }

  async function init(): Promise<void> {
    locale.value = (await storagePort.getSettings()).locale;
    apply();
    stop = storagePort.watchSettings((settings) => {
      locale.value = settings.locale;
      apply();
    });
  }

  async function set(next: LocaleChoice): Promise<void> {
    locale.value = next;
    apply();
    const current = await storagePort.getSettings();
    await storagePort.setSettings({ ...current, locale: next });
  }

  onScopeDispose(() => {
    stop?.();
  });

  /**
   * 返回的是**内部那个 ref**，不是 `ref(localeChoice())` 那样的快照。
   * 写成快照的话 `set()` 之后界面上那根下拉还停在旧值 —— 用户刚选完"中文"，
   * 选择框立刻弹回"跟随浏览器"，看起来像没保存成功（这个 bug 是被用例抓出来的，不是看出来的）。
   */
  return { locale, init, set };
}
