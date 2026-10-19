/**
 * 收纳黑名单的判据。
 *
 * 这份用例存在的理由：**黑名单从"硬编码常量"变成"用户可配置的输入"** 之后，
 * 输入第一次可能来自用户（也可能来自一份被手改过的备份），所以"归一化"这一格
 * 从此有真实攻击面。判据按 既有约定 最后一节列的变异清单写：
 *
 * - `normalizePrefix` 的每条规则各一条，外加一条**反向**用例钉住
 *   "`https://chrome.google.com`（不带斜杠）不得命中 `https://chrome.google.com.evil.com/`"
 *   —— 那条是 D5 那条"必须以 `://` 或 `/` 结尾"存在的全部理由；
 * - 硬底两项各一条，且都是"**把黑名单清空之后**"的形状 —— 只有清空才证得出
 *   它们不受配置影响；
 * - 默认值一条：默认配置下扩展页**收**、Web Store **不收**（取证结论）。
 *
 * 都是纯函数，不碰浏览器 API。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCKED_PREFIXES,
  PRESET_PREFIXES,
  isBlockedUrl,
  isHardFloor,
  mergeBlockedPrefixes,
  normalizePrefix,
} from '@/core/domain/blocked-prefixes';
import { isCapturableTab, isRecoverableRecord } from '@/core/domain/tab';
import type { BrowserTab } from '@/shared/types';

const tab = (url: string, extra: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 1,
  url,
  title: 't',
  pinned: false,
  active: false,
  index: 0,
  windowId: 1,
  ...extra,
});

describe('normalizePrefix：五条规则各一条', () => {
  it('含 :// 时补结尾斜杠（不补会误伤同前缀的别的域名）', () => {
    expect(normalizePrefix('https://chrome.google.com')).toBe('https://chrome.google.com/');
    expect(normalizePrefix('https://chrome.google.com/')).toBe('https://chrome.google.com/');
    expect(normalizePrefix('chrome://')).toBe('chrome://');
  });

  it('trim + 小写', () => {
    expect(normalizePrefix('  CHROME:// ')).toBe('chrome://');
  });

  it('空 / 纯空白 ⇒ null', () => {
    expect(normalizePrefix('')).toBeNull();
    expect(normalizePrefix('   ')).toBeNull();
  });

  it('形如 host:端口 ⇒ 补 https（这一格在猜，所以调用方必须回显）', () => {
    expect(normalizePrefix('localhost:3000')).toBe('https://localhost:3000/');
  });

  it('裸协议前缀（about:blank / view-source: / data:）原样留着', () => {
    expect(normalizePrefix('view-source:')).toBe('view-source:');
    expect(normalizePrefix('about:blank')).toBe('about:blank');
    expect(normalizePrefix('data:')).toBe('data:');
  });

  it('不含冒号 ⇒ 当域名补 https', () => {
    expect(normalizePrefix('mail.google.com')).toBe('https://mail.google.com/');
  });

  it('说不清的 ⇒ null（不猜，也不静默收下）', () => {
    expect(normalizePrefix('http://a b c/')).toBeNull();
    expect(normalizePrefix('a:b:c')).toBeNull();
  });

  /**
   * ★ 2026-10-19 真机事故的回归用例：**归一化不许依赖浏览器的 URL 解析**。
   *
   * 事实（`_probe/url-parse-probe.mjs`，Chrome 155 实测）：
   * `new URL('chrome://')`、`new URL('chrome-extension://')`、`new URL('moz-extension://')`、
   * `new URL('devtools:')` 在页面上下文里**全都抛 Invalid URL**，而 Node 全都不抛 ——
   * 所以原来那个"拿 new URL 当形状校验"的实现在 CI 里永远绿，真机上却把整条前缀丢掉，
   * 用户看到的是"勾上了 → 刷新后又没勾"。
   *
   * 这里把 `URL` 换成一个"像 Chrome 一样会抛"的版本：旧实现红，现在绿。
   */
  it('★ 不依赖 URL 解析：Chrome 会抛的那几条前缀必须原样留下', () => {
    const RealURL = globalThis.URL;
    const chromeThrows = new Set(['chrome://', 'chrome-extension://', 'moz-extension://', 'devtools:']);
    class ChromeLikeURL extends RealURL {
      constructor(url: string | URL, base?: string | URL) {
        if (chromeThrows.has(String(url))) {
          throw new TypeError("Failed to construct 'URL': Invalid URL");
        }
        super(url, base as string);
      }
    }
    globalThis.URL = ChromeLikeURL as never;
    try {
      expect(normalizePrefix('chrome://')).toBe('chrome://');
      expect(normalizePrefix('chrome-extension://')).toBe('chrome-extension://');
      expect(normalizePrefix('moz-extension://')).toBe('moz-extension://');
      expect(normalizePrefix('devtools:')).toBe('devtools:');
      // 正向对照：真正坏掉的输入仍然要被拒 —— 别为了修这条把校验整个拆了
      expect(normalizePrefix('http://a b c/')).toBeNull();

      // ★ 用户症状本身：存 10 项（9 个默认 + 1 条自定义）→ 读回来还得是 10 项。
      //   旧实现在这里会缩成 9 项（`chrome://` 被丢），刷新后复选框就"自己变回没勾"。
      const ten = [...DEFAULT_BLOCKED_PREFIXES, 'https://mail.google.com/'];
      const readBack = mergeBlockedPrefixes(ten);
      expect(readBack).toHaveLength(10);
      expect(readBack).toContain('chrome://');
    } finally {
      globalThis.URL = RealURL;
    }
  });
});

describe('isBlockedUrl', () => {
  it('★ 反向用例：不带结尾斜杠不得命中同前缀的别的域名（D5 那条规则的唯一理由）', () => {
    // 归一化会把 `https://chrome.google.com` 补成带斜杠的，所以这条走的是"已归一化"的输入。
    const withSlash = ['https://chrome.google.com/'];
    expect(isBlockedUrl('https://chrome.google.com.evil.com/x', withSlash)).toBe(false);
    expect(isBlockedUrl('https://chrome.google.com/webstore/detail/x', withSlash)).toBe(true);
  });

  it('默认配置：扩展页收、Web Store 不收（2026-10-19 取证结论）', () => {
    expect(isBlockedUrl('chrome-extension://abcdef/options.html', DEFAULT_BLOCKED_PREFIXES)).toBe(false);
    expect(isBlockedUrl('extension://abcdef/newtab.html', DEFAULT_BLOCKED_PREFIXES)).toBe(false);
    expect(
      isBlockedUrl('https://chrome.google.com/webstore/devconsole/x/y/z/edit/package', DEFAULT_BLOCKED_PREFIXES),
    ).toBe(true);
    expect(isBlockedUrl('https://chromewebstore.google.com/', DEFAULT_BLOCKED_PREFIXES)).toBe(true);
  });

  it('空黑名单下只剩硬底', () => {
    expect(isBlockedUrl('https://a.test/1', [])).toBe(false);
    expect(isBlockedUrl('chrome://extensions', [])).toBe(false);
    expect(isBlockedUrl('about:blank', [])).toBe(true);
    expect(isBlockedUrl('javascript:void 0', [])).toBe(true);
  });

  it('读不到 URL 一律当命中（它本来也开不回来）', () => {
    expect(isBlockedUrl(undefined, [])).toBe(true);
    expect(isBlockedUrl('', [])).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isBlockedUrl('CHROME://Extensions', DEFAULT_BLOCKED_PREFIXES)).toBe(true);
  });
});

describe('硬底（既有约定 D3）：不看配置', () => {
  it('about:blank —— 它是我们自己的落脚页，不是"打不开"', () => {
    expect(isHardFloor('about:blank')).toBe(true);
    // 不是前缀匹配：about:newtab 不该被硬底挡（它在默认黑名单里走的是 `about:` 那条）
    expect(isHardFloor('about:newtab')).toBe(false);
  });

  it('javascript: —— 取证里唯一被平台点名拒绝的', () => {
    expect(isHardFloor('javascript:alert(1)')).toBe(true);
    expect(isHardFloor('JavaScript:alert(1)')).toBe(true);
  });

  it('普通网页与内部页都不是硬底', () => {
    expect(isHardFloor('https://a.test/1')).toBe(false);
    expect(isHardFloor('chrome://extensions')).toBe(false);
  });
});

describe('mergeBlockedPrefixes：来自 storage / 备份的脏输入', () => {
  it('不是数组 ⇒ 出厂默认', () => {
    expect(mergeBlockedPrefixes(undefined)).toEqual([...DEFAULT_BLOCKED_PREFIXES]);
    expect(mergeBlockedPrefixes('chrome://')).toEqual([...DEFAULT_BLOCKED_PREFIXES]);
  });

  it('丢掉非字符串与认不出来的，去重，保留顺序', () => {
    expect(mergeBlockedPrefixes(['chrome://', 42, null, '  CHROME://  ', 'http://a b/', 'edge://']))
      .toEqual(['chrome://', 'edge://']);
  });

  it('空数组是合法输入（用户愿意收一切），不会被当成"缺失"', () => {
    expect(mergeBlockedPrefixes([])).toEqual([]);
  });

  it('长度封顶 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => `https://x${i}.test/`);
    expect(mergeBlockedPrefixes(many)).toHaveLength(50);
  });
});

describe('isCapturableTab 与读侧在黑名单上不打架', () => {
  it('黑名单命中 ⇒ 不收（且不关，那半由 capture-window 的 removeCalls 那条用例钉）', () => {
    const policy = { includePinnedTabs: false, blockedPrefixes: DEFAULT_BLOCKED_PREFIXES };
    expect(isCapturableTab(tab('chrome://extensions'), policy)).toBe(false);
    expect(isCapturableTab(tab('chrome-extension://abc/options.html'), policy)).toBe(true);
  });

  it('读侧只认硬底 + 布尔快照，不拿"当下的配置"去判老记录（既有约定 D4）', () => {
    // 一条老记录：存它的那一刻 `chrome://` 还被收着（restorable: true）。
    // 用户后来把 chrome:// 加回黑名单 —— 那条记录**仍然**算能开出来。
    expect(isRecoverableRecord({ url: 'chrome://extensions', restorable: true })).toBe(true);
    // 反过来：快照是 false 的，就算现在不挡了也仍是 false（要重新收一次才有可点的记录）
    expect(isRecoverableRecord({ url: 'chrome://extensions', restorable: false })).toBe(false);
    // 硬底不看布尔：javascript: 就算被标成 restorable 也开不出来
    expect(isRecoverableRecord({ url: 'javascript:void 0', restorable: true })).toBe(false);
  });
});

describe('预设名单', () => {
  it('预设包含全部默认项，且都被 normalizePrefix 认得（UI 摆出来的必须自己合法）', () => {
    for (const prefix of PRESET_PREFIXES) {
      expect(normalizePrefix(prefix), prefix).toBe(prefix);
    }
    for (const prefix of DEFAULT_BLOCKED_PREFIXES) {
      expect(PRESET_PREFIXES).toContain(prefix);
    }
  });
});
