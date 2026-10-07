import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeBrowser } from 'wxt/testing/fake-browser';

/**
 * WXT 的 fakeBrowser **不实现** i18n：`fakeBrowser.i18n.getMessage` 直接抛
 * "not implemented"。所以任何挂载组件的测试都会当场炸（真实浏览器里未知 key 只返回
 * 空串，shared/i18n.ts 的兜底正是按那个行为写的）。
 *
 * 这里不是给一个假字符串，而是**读真的 en/messages.json** 来实现 getMessage ——
 * 这样组件测试断言的是用户真正看到的文案，断言"渲染出了 empty_title"没有意义，
 * 断言"渲染出了 Nothing stashed yet"才有。
 */
const messages = JSON.parse(
  readFileSync(join(process.cwd(), 'public', '_locales', 'en', 'messages.json'), 'utf8'),
) as Record<string, { message: string }>;

fakeBrowser.i18n.getMessage = ((key: string) => messages[key]?.message ?? '') as never;
fakeBrowser.i18n.getUILanguage = (() => 'en') as never;

/**
 * `fakeBrowser.runtime.getManifest()` 同样是"未实现即抛"（`MockNotImplementedError`），
 * 而设置页与「关于」分区都要读版本号 —— 既有约定 规定版本只有 `package.json` 一个来源。
 *
 * 这里刻意返回**真的那个版本**，而不是随便一个 `"9.9.9"`：
 * 假串只能证明"屏幕上出现了一个版本号形状的东西"，真值才能钉住
 * "屏幕上那个 v1.7.1 就是 package.json 里那个"。写歪一位就红。
 */
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };

fakeBrowser.runtime.getManifest = (() => ({ version: pkg.version })) as never;

// jsdom 没有 matchMedia，useTheme 靠这个判断是否监听系统偏好
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
