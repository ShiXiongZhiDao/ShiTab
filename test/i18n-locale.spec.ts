/**
 * 应用内切语言。
 *
 * 分三层各钉一次，因为这三层各有各的静默坏法：
 * - `resolveLocale` 是纯函数：兜底方向错了，日语/韩语浏览器的用户会看到一份他看不懂的语言。
 * - `mergeSettings` 是入口：备份可以来自旧版本也可以被人手改，认不出的值漏过去会让
 *   `t()` 去查一个不存在的目录。
 * - **换语言要当场生效**：这一条是"选了 English 但一半还是英文/中文"那个投诉的根因，
 *   只有挂载中的组件能证明（模型层测不到渲染依赖）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_SETTINGS, mergeSettings, resolveLocale } from '@/core/domain/settings';
import { htmlLang, setLocaleChoice, t } from '@/shared/i18n';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { useLocale } from '@/composables/useLocale';

const storage = createStoragePort();

afterEach(() => {
  // 语言是模块级状态，不还原的话下一条用例继承上一条的选择 —— 那种污染的表现是
  // "单独跑绿、全量跑红"。
  setLocaleChoice('system');
});

describe('resolveLocale：把选法与浏览器语言算成实际目录', () => {
  it('跟随浏览器时，zh 前缀一律落到 zh_CN（含 zh-TW / zh-Hant）', () => {
    expect(resolveLocale('system', 'zh-CN')).toBe('zh_CN');
    expect(resolveLocale('system', 'zh-TW')).toBe('zh_CN');
    expect(resolveLocale('system', 'zh-Hant')).toBe('zh_CN');
    expect(resolveLocale('system', 'ZH')).toBe('zh_CN');
  });

  it('跟随浏览器时，非中文一律落到 en —— 与 manifest 的 default_locale 同一个方向', () => {
    // 日语/韩语用户的浏览器里，扩展名与商店描述本来就是英文（浏览器按 default_locale 解析），
    // 界面跟着走同一条规则才不会自相矛盾。
    expect(resolveLocale('system', 'en-US')).toBe('en');
    expect(resolveLocale('system', 'ja')).toBe('en');
    expect(resolveLocale('system', 'ko-KR')).toBe('en');
    expect(resolveLocale('system', '')).toBe('en');
  });

  it('显式选过就压过浏览器：两个方向都要成立', () => {
    expect(resolveLocale('zh_CN', 'en-US')).toBe('zh_CN');
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
  });
});

describe('Settings 里的 locale 值', () => {
  it('默认是 system（装完就是浏览器语言，不需要谁去点一下）', async () => {
    expect(DEFAULT_SETTINGS.locale).toBe('system');
    await fakeBrowser.storage.local.clear();
    expect((await storage.getSettings()).locale).toBe('system');
  });

  it('认不出的值留在默认上，不跟着写进去', () => {
    expect(mergeSettings({ locale: 'fr' }).locale).toBe('system');
    expect(mergeSettings({ locale: 42 }).locale).toBe('system');
    expect(mergeSettings({ locale: null }).locale).toBe('system');
    // 正向对照：合法值必须真的能进来，否则上面三条只是"全都丢"
    expect(mergeSettings({ locale: 'en' }).locale).toBe('en');
    expect(mergeSettings({ locale: 'zh_CN' }).locale).toBe('zh_CN');
  });

  it('写进去再读回来是同一个值（设置页那颗下拉靠的就是这条往返）', async () => {
    await fakeBrowser.storage.local.clear();
    const current = await storage.getSettings();
    await storage.setSettings({ ...current, locale: 'zh_CN' });
    expect((await storage.getSettings()).locale).toBe('zh_CN');
  });
});

describe('t() 跟着语言走', () => {
  it('同一把 key 在两种语言下拿到的是两份人话，而不是 key 名', () => {
    setLocaleChoice('en');
    expect(t('options_language')).toBe('Language');
    setLocaleChoice('zh_CN');
    expect(t('options_language')).toBe('语言');
    // 两边都不许把内部标识原样吐到屏幕上
    for (const locale of ['en', 'zh_CN'] as const) {
      setLocaleChoice(locale);
      expect(t('options_theme')).not.toBe('options_theme');
    }
  });

  it('占位符在两份目录里都替换得动（zh 与 en 的位置不一样，所以用具名占位符）', () => {
    setLocaleChoice('en');
    expect(t('trash_days_left', { days: 3 })).toContain('3');
    setLocaleChoice('zh_CN');
    expect(t('trash_days_left', { days: 3 })).toContain('3');
    // 替换完不许留下占位符本体
    expect(t('trash_days_left', { days: 3 })).not.toContain('__days__');
  });

  it('`<html lang>` 跟着变（读屏按它决定发音，界面中文而 lang=en 是骗人的）', () => {
    setLocaleChoice('zh_CN');
    expect(htmlLang()).toBe('zh-CN');
    setLocaleChoice('en');
    expect(htmlLang()).toBe('en');
  });
});

/**
 * 设置页那三档下拉到 storage 之间的接线。
 *
 * 为什么不挂整个 options 页面：那要把 store/theme/备份文件输入全桩一遍，
 * 而这条判据的全部内容就是"`set()` 写盘 + 立刻作用到 `t()`"这两下。
 * 页面本身的结构由 §5f 的真机清单去核。
 */
describe('useLocale：写盘与生效', () => {
  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
  });

  it('set() 之后：盘上是它、t() 用的是它、<html lang> 也是它', async () => {
    const locale = useLocale();
    await locale.init();
    expect((await storage.getSettings()).locale).toBe('system');

    await locale.set('zh_CN');

    expect((await storage.getSettings()).locale).toBe('zh_CN');
    expect(t('options_theme')).toBe('主题');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(locale.locale.value).toBe('zh_CN');
  });

  it('另一个 surface 改了设置时，这边跟着变（watchSettings 那条路）', async () => {
    const locale = useLocale();
    await locale.init();
    expect(t('options_theme')).toBe('Theme');

    // 模拟"设置页在另一个标签页里被改了"：直接写盘，不走本实例的 set()
    const current = await storage.getSettings();
    await storage.setSettings({ ...current, locale: 'zh_CN' });
    await nextTick();

    expect(t('options_theme')).toBe('主题');
    expect(locale.locale.value).toBe('zh_CN');
  });
});

/**
 * 这一条是"不用刷新"的证明：组件挂载中改语言，文本必须自己变。
 *
 * 做到这点靠的是 `t()` 在渲染函数里读那个模块级 ref —— 登记了依赖。
 * 如果哪天有人把 `t()` 换成"启动时算一次并缓存"，这条会红，
 * 而症状是"切了语言要重开页面"，那种回归很容易被判成"就这样吧"。
 */
describe('切换当场生效，不需要重开页面', () => {
  const Probe = defineComponent({
    setup() {
      return () => h('p', { 'data-testid': 'probe' }, t('options_theme'));
    },
  });

  it('挂载中的组件跟着换语言', async () => {
    setLocaleChoice('en');
    const wrapper = mount(Probe);
    expect(wrapper.find('[data-testid="probe"]').text()).toBe('Theme');

    setLocaleChoice('zh_CN');
    await nextTick();
    expect(wrapper.find('[data-testid="probe"]').text()).toBe('主题');

    setLocaleChoice('en');
    await nextTick();
    expect(wrapper.find('[data-testid="probe"]').text()).toBe('Theme');
  });
});

describe('两份 locale 的键集合一模一样（只加一边 = 另一种语言在屏幕上看到 key 名）', () => {
  const load = (locale: 'en' | 'zh_CN'): Record<string, { message?: string }> =>
    JSON.parse(
      readFileSync(join(process.cwd(), 'public', '_locales', locale, 'messages.json'), 'utf8'),
    ) as Record<string, { message?: string }>;
  const en = load('en');
  const zh = load('zh_CN');

  it('两边都有键，且每条都带着非空的 message（否则下面那条双向比较可以打在空集上）', () => {
    for (const [name, table] of [
      ['en', en],
      ['zh_CN', zh],
    ] as const) {
      const keys = Object.keys(table);
      expect(keys.length, `${name} 的键少得可疑，这条判据就没在测东西`).toBeGreaterThan(100);
      for (const [key, entry] of Object.entries(table)) {
        expect(typeof entry.message === 'string' && (entry.message ?? '').trim().length > 0, `${name} 里 ${key} 没有 message`).toBe(true);
      }
    }
  });

  it('en 有的键 zh_CN 都有，反过来也一样 —— 两个方向各比一次', () => {
    const enKeys = new Set(Object.keys(en));
    const zhKeys = new Set(Object.keys(zh));
    expect([...enKeys].filter((key) => !zhKeys.has(key)), '只在 en 里出现的键').toEqual([]);
    expect([...zhKeys].filter((key) => !enKeys.has(key)), '只在 zh_CN 里出现的键').toEqual([]);
  });
});
