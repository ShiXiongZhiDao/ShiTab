/**
 * 设置页外壳（`entrypoints/options/App.vue`）—— 既有约定 那一版：左侧分区导航 + 一次只看一个分区。
 *
 * 这里验的是**接线**，不是好看不好看：分区点了真的换、hash 真的能深链、开关点了真的落存储、
 * 依赖项真的禁用并说清为什么、三张二维码真的指向仓库里存在的文件。
 * 布局与观感在 jsdom 里量不出来（视口 0×0），那部分归 `既有约定` 的真机清单。
 *
 * 一条写用例时的自律：凡是"有两条路进去"的规则，两条路各一条用例。
 * 依赖禁用既测"关掉父项"也测"打开父项"；导航既测"点按钮"也测"改 hash"。
 * 只测一半的话，另一半坏了没人知道 —— 这条在这页上已经栽过一次（既有约定 那轮）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import OptionsApp from '@/entrypoints/options/App.vue';
import AboutPanel from '@/components/AboutPanel.vue';
import { storagePort } from '@/shared/services';
import { filledRepos, type RepoLink } from '@/shared/repos';
import { TRASH_RETENTION_MS } from '@/shared/constants';

const PANE_IDS = ['general', 'appearance', 'data', 'sync', 'about'] as const;
type PaneId = (typeof PANE_IDS)[number];

/** 版本号的唯一真相。用例拿它和屏幕上渲染出来的那一串比，所以 package.json 改了就跟着对。 */
const PKG_VERSION = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;

const mounted: VueWrapper[] = [];

async function mountApp(hash = ''): Promise<VueWrapper> {
  location.hash = hash;
  const wrapper = mount(OptionsApp, {
    global: { plugins: [createPinia()] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  // 两轮：onMounted 里先是 await theme/locale init，再 await 读设置与 meta
  await flushPromises();
  await flushPromises();
  return wrapper;
}

async function goPane(wrapper: VueWrapper, id: PaneId): Promise<void> {
  await wrapper.find(`[data-testid="nav-${id}"]`).trigger('click');
  await flushPromises();
}

/** 那颗开关现在是不是"按下去什么都不发生"。 */
function switchDisabled(wrapper: VueWrapper, testId: string): boolean {
  const el = wrapper.find(`[data-testid="${testId}"]`).element as HTMLButtonElement;
  return el.disabled === true;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await fakeBrowser.storage.local.clear();
  location.hash = '';
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  location.hash = '';
});

describe('分区导航', () => {
  it('默认落在「常规」；导航五项，当前项只有一个', async () => {
    const wrapper = await mountApp();

    expect(wrapper.findAll('[data-testid^="nav-"]')).toHaveLength(5);
    expect(wrapper.findAll('[aria-current="true"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="nav-general"]').attributes('aria-current')).toBe('true');
    expect(wrapper.text()).toContain('How stashing and the entry tab behave');
    // 别的分区不该同时在屏幕后面（一次一个分区，这是整件事的全部意义）
    expect(wrapper.text()).not.toContain('What this extension is');
    expect(wrapper.find('[data-testid="sync-connect"]').exists()).toBe(false);
  });

  it('点「关于」是换内容而不是加内容', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'about');

    expect(wrapper.text()).toContain('What this extension is');
    expect(wrapper.text()).toContain('WeChat official account');
    expect(wrapper.text()).not.toContain('Close tabs after stashing');
    expect(wrapper.findAll('[aria-current="true"]')).toHaveLength(1);
  });

  it('点「同步」把两块面板挂上来', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'sync');

    expect(wrapper.find('[data-testid="sync-connect"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('WEBDAV SYNC');
    expect(wrapper.text()).toContain('REMOTE HISTORY');
  });

  /**
   * ★ 五个分区**每一个**都要有那个 16px 的分区标题，且标题文字与左栏导航那颗一致。
   *
   * 这条是补格：上一版「同步」分区没有标题，我给的理由是"两块面板自带 eyebrow"。
   * 他两张截图对比出来的结论是 —— 11px 大写 eyebrow 与 16px 粗体标题不是一个层级，
   * 用户读到的是"这一页没标题"。标题当时是各分区手写一遍 markup，所以可以"就是漏写"；
   * 现在收进 `PaneHeader`，这条断言钉的是结构：**新加分区不会忘记带标题**。
   */
  it('五个分区都有分区标题，且与导航那颗同名', async () => {
    const wrapper = await mountApp();
    for (const id of PANE_IDS) {
      await goPane(wrapper, id);
      const titles = wrapper.findAll('[data-testid="pane-title"]');
      expect(titles, `分区 ${id} 的标题数量`).toHaveLength(1);
      expect(titles[0]!.text(), `分区 ${id} 的标题文字`).toBe(
        wrapper.find(`[data-testid="nav-${id}"]`).text(),
      );
    }
  });

  it('点导航会把分区写进 URL hash（能复制链接发给别人）', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'about');
    expect(location.hash).toBe('#about');
  });

  it('带着 #sync 打开 ⇒ 直接落在同步分区', async () => {
    const wrapper = await mountApp('#sync');
    expect(wrapper.find('[data-testid="nav-sync"]').attributes('aria-current')).toBe('true');
    expect(wrapper.find('[data-testid="sync-connect"]').exists()).toBe(true);
  });

  it('hash 被改回去（后退键）⇒ 分区跟着走', async () => {
    const wrapper = await mountApp('#about');
    expect(wrapper.find('[data-testid="nav-about"]').attributes('aria-current')).toBe('true');

    location.hash = '#data';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushPromises();

    expect(wrapper.find('[data-testid="nav-data"]').attributes('aria-current')).toBe('true');
    expect(wrapper.text()).toContain('Last export');
  });

  it('认不出来的 hash 回到「常规」，不会开成一片空白', async () => {
    const wrapper = await mountApp('#totally-not-a-pane');
    expect(wrapper.find('[data-testid="nav-general"]').attributes('aria-current')).toBe('true');
    expect(wrapper.text()).toContain('Close tabs after stashing');
  });
});

describe('收纳那组：依赖关系既看得见也真拦得住', () => {
  it('默认「收纳后关闭网页」开着 ⇒ 子项可用，副标题讲的是它自己做什么', async () => {
    const wrapper = await mountApp();

    expect(switchDisabled(wrapper, 'set-keep-active-tab')).toBe(false);
    expect(wrapper.text()).toContain('Keeps the page you are looking at and closes the rest.');
    expect(wrapper.text()).not.toContain('Turn the option above on first');
  });

  it('关掉父项 ⇒ 子项禁用，副标题换成"为什么现在点不动"', async () => {
    const wrapper = await mountApp();
    await wrapper.find('[data-testid="set-close-after-capture"]').trigger('click');
    await flushPromises();

    expect(switchDisabled(wrapper, 'set-keep-active-tab')).toBe(true);
    expect(wrapper.text()).toContain('Turn the option above on first — this one does nothing without it.');
    expect(await storagePort.getSettings()).toMatchObject({ closeAfterCapture: false });
  });

  it('再点回来 ⇒ 子项恢复可用，那句原因也收走（不能只改一半）', async () => {
    const wrapper = await mountApp();
    const parent = wrapper.find('[data-testid="set-close-after-capture"]');
    await parent.trigger('click');
    await flushPromises();
    await parent.trigger('click');
    await flushPromises();

    expect(switchDisabled(wrapper, 'set-keep-active-tab')).toBe(false);
    expect(wrapper.text()).toContain('Keeps the page you are looking at and closes the rest.');
    expect(await storagePort.getSettings()).toMatchObject({ closeAfterCapture: true });
  });
});

describe('入口 T 那组：一颗父开关管两颗子开关', () => {
  it('关掉入口 T ⇒ 两颗子开关同时禁用', async () => {
    const wrapper = await mountApp();
    await wrapper.find('[data-testid="set-pinned-entry"]').trigger('click');
    await flushPromises();

    expect(switchDisabled(wrapper, 'set-auto-restore-entry')).toBe(true);
    expect(switchDisabled(wrapper, 'set-keep-entry-first')).toBe(true);
    // 收纳那组不受牵连：两组的判据各是各的
    expect(switchDisabled(wrapper, 'set-keep-active-tab')).toBe(false);
  });

  it('默认开着 ⇒ 两颗子开关都可用', async () => {
    const wrapper = await mountApp();
    expect(switchDisabled(wrapper, 'set-auto-restore-entry')).toBe(false);
    expect(wrapper.find('[data-testid="set-keep-entry-first"]').attributes('aria-checked')).toBe('true');
  });
});

describe('开关点了要真的做事', () => {
  it('每颗开关都改到自己那一格，并且能改回去', async () => {
    const wrapper = await mountApp();
    const cases = [
      ['set-close-after-capture', 'closeAfterCapture'],
      ['set-keep-active-tab', 'keepActiveTab'],
      ['set-include-pinned', 'includePinnedTabs'],
      ['set-pinned-entry', 'pinnedEntryEnabled'],
      ['set-auto-restore-entry', 'autoRestorePinnedTab'],
      ['set-keep-entry-first', 'keepPinnedTabFirst'],
    ] as const;

    for (const [testId, field] of cases) {
      const before = (await storagePort.getSettings())[field];
      await wrapper.find(`[data-testid="${testId}"]`).trigger('click');
      await flushPromises();
      expect((await storagePort.getSettings())[field], `${testId} 第一下`).not.toBe(before);
      expect(
        wrapper.find(`[data-testid="${testId}"]`).attributes('aria-checked'),
        `${testId} 的 aria-checked 要跟着翻`,
      ).toBe(String(!before));

      await wrapper.find(`[data-testid="${testId}"]`).trigger('click');
      await flushPromises();
      expect((await storagePort.getSettings())[field], `${testId} 第二下要能取消`).toBe(before);
    }
  });
});

describe('外观', () => {
  it('主题三段：点一颗就生效，当前项只有一个 pressed', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'appearance');

    await wrapper.find('[data-testid="theme-segment"] [data-value="dark"]').trigger('click');
    await flushPromises();

    expect(await storagePort.getSettings()).toMatchObject({ theme: 'dark' });
    expect(wrapper.findAll('[data-testid="theme-segment"] [aria-pressed="true"]')).toHaveLength(1);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('语言切到中文 ⇒ 这一页当场跟着翻（不用刷新）', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'appearance');

    await wrapper.find('[data-testid="language-segment"] [data-value="zh_CN"]').trigger('click');
    await flushPromises();
    await flushPromises();

    expect(await storagePort.getSettings()).toMatchObject({ locale: 'zh_CN' });
    expect(wrapper.find('[data-testid="nav-general"]').text()).toContain('常规');
    expect(wrapper.find('[data-testid="nav-about"]').text()).toContain('关于');
    // 切回英文也要翻得回来，不是单向的
    await wrapper.find('[data-testid="language-segment"] [data-value="en"]').trigger('click');
    await flushPromises();
    await flushPromises();
    expect(wrapper.find('[data-testid="nav-general"]').text()).toContain('General');
  });
});

describe('关于与赞助', () => {
  it('三张码的 src 都指向仓库里真实存在的文件', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'about');

    // src 是 runtime.getURL 的结果（chrome-extension://<id>/qr/…），所以比的是结尾而不是整串
    const files = wrapper.findAll('.qr-pad img').map((img) => img.attributes('src') ?? '');
    expect(files.map((src) => src.replace(/^.*\/qr\//, 'qr/'))).toEqual([
      'qr/wechat-official.png',
      'qr/alipay.png',
      'qr/wechat-pay.png',
    ]);
    for (const src of files) {
      const name = src.slice(src.lastIndexOf('/') + 1);
      expect(existsSync(join(process.cwd(), 'public', 'qr', name)), `文件不存在：public/qr/${name}`).toBe(true);
    }
  });

  it('图读不到时换成占位，并把缺的是哪个文件说出来', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'about');

    const alipay = wrapper.find('[data-testid="qr-img-alipay"]');
    expect(alipay.exists(), '找不到支付宝那张码（testid 或图没了）').toBe(true);
    await alipay.trigger('error');
    await flushPromises();

    const box = wrapper.find('[data-testid="qr-missing-alipay"]');
    expect(box.exists()).toBe(true);
    expect(box.text()).toContain('qr/alipay.png');
    // 另外两张不受牵连
    expect(wrapper.findAll('.qr-pad img')).toHaveLength(2);
  });

  it('每张码都有读屏念得出的名字，横幅那张不会被念成"图片"', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'about');

    const labels = wrapper.findAll('.sr-only').map((n) => n.text());
    expect(labels).toContain('QR code for the 师兄知道 official account');
    expect(labels).toContain('Alipay payment QR code');
    expect(labels).toContain('WeChat Pay QR code');
    // `<img alt="">` + 旁边的 sr-only：两者只能有一个在无障碍树里说话
    for (const img of wrapper.findAll('.qr-pad img')) expect(img.attributes('alt')).toBe('');
  });

  it('回收站那句话的天数从常量算，不是抄一个 7 在文案里', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'data');
    const days = Math.round(TRASH_RETENTION_MS / 86_400_000);
    expect(wrapper.text()).toContain(`stay on this machine for ${days} days`);
  });

  it('版本号是从 manifest 来的，屏幕上那个就是 package.json 里那个', async () => {
    const wrapper = await mountApp();
    expect(wrapper.text()).toContain(`v${PKG_VERSION}`);

    await goPane(wrapper, 'about');
    expect(wrapper.text()).toContain(`v${PKG_VERSION}`);
  });
});

describe('开源仓库链接', () => {
  it('filledRepos 只放行真的填了地址的那条', () => {
    const sample: RepoLink[] = [
      { id: 'github', label: 'GitHub', url: '' },
      { id: 'gitee', label: 'Gitee', url: '   ' },
      { id: 'github', label: 'GitHub', url: 'https://github.test/someone/shitab' },
    ];
    expect(filledRepos(sample).map((r) => r.url)).toEqual(['https://github.test/someone/shitab']);
  });

  /**
   * 2026-10-06 他给了两条地址。我因为 GitHub 那条**实测 404** 把它留空过一轮，
   * 他一句「github 我后面会创建，你要显示出来呀」覆盖了这个判断 —— 于是两条都渲染。
   * 用例钉的是"值与渲染同源"，不钉可达性（那只能真机判，清单 §6b O15；用例里绝不打网络）。
   * 前半句钉配置、后半句钉界面：只测界面的话，"填了几条"与"渲染写坏了"在断言里长得一样。
   */
  it('两条地址都填了 ⇒ 卡出现、两颗按钮、地址摊出来且与 href 同一个值', async () => {
    const filled = filledRepos();
    expect(filled.map((repo) => repo.id)).toEqual(['gitee', 'github']);
    expect(filled.map((repo) => repo.url)).toEqual([
      'https://gitee.com/ShiXiongZhiDao/ShiTab',
      'https://github.com/ShiXiongZhiDao/ShiTab',
    ]);

    const wrapper = await mountApp();
    await goPane(wrapper, 'about');
    const gitee = wrapper.find('[data-testid="repo-gitee"]');
    const github = wrapper.find('[data-testid="repo-github"]');
    expect(gitee.attributes('href')).toBe('https://gitee.com/ShiXiongZhiDao/ShiTab');
    expect(github.exists(), 'GitHub 那颗没渲染出来（他要求显示，即使镜像还没建）').toBe(true);
    expect(github.attributes('href')).toBe('https://github.com/ShiXiongZhiDao/ShiTab');
    for (const link of [gitee, github]) {
      expect(link.attributes('target')).toBe('_blank');
      expect(link.attributes('rel')).toContain('noopener');
    }
    // 主仓在前：Gitee 那颗的 DOM 位置必须在 GitHub 之前
    const pills = wrapper.findAll('[data-testid^="repo-"]');
    expect(pills.map((p) => p.attributes('data-testid'))).toEqual(['repo-gitee', 'repo-github']);
    // 地址摊出来一份（与 href 同一个值），复制得到
    const text = wrapper.text();
    expect(text).toContain('https://gitee.com/ShiXiongZhiDao/ShiTab');
    expect(text).toContain('https://github.com/ShiXiongZhiDao/ShiTab');
    expect(text).toContain('Open source repositories');
    // 其余几张卡不受影响
    expect(text).toContain('WeChat official account');
    expect(text).toContain('Support this project');
  });

  /**
   * ★ 反向那一半：填上地址之后这张卡**真的会亮**。
   * 只测"空列表 ⇒ 不渲染"是不够的 —— 那样"渲染那段写坏了"和"地址一直是空的"
   * 在断言里长得一样。所以 AboutPanel 收一个只为测试存在的 `repos` prop。
   * 用 `.test` 域名（RFC 2606 保留，永远解析不到真仓库）当夹具，避免这条用例本身
   * 看起来像在声明"项目就在这儿"。
   */
  it('填上地址之后仓库卡会出现，链接与打开方式都对', async () => {
    const wrapper = mount(AboutPanel, {
      props: {
        repos: [
          { id: 'github' as const, label: 'GitHub', url: 'https://github.test/me/shitab' },
          { id: 'gitee' as const, label: 'Gitee', url: 'https://gitee.test/me/shitab' },
        ],
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('Open source repositories');
    const gh = wrapper.find('[data-testid="repo-github"]');
    expect(gh.exists(), 'GitHub 那颗链接没渲染出来').toBe(true);
    expect(gh.attributes('href')).toBe('https://github.test/me/shitab');
    expect(gh.attributes('target')).toBe('_blank');
    expect(gh.attributes('rel')).toContain('noopener');
    expect(wrapper.find('[data-testid="repo-gitee"]').text()).toBe('Gitee');
    // 仓库卡是加在权限说明与公众号之间的，别把后面的内容挤掉
    expect(wrapper.text()).toContain('WeChat official account');
  });
});

describe('分区之间不许横向跳', () => {
  /**
   * 「关于」656px 会撑出滚动条、「数据」335px 不会 ⇒ 可用宽度差一整个滚动条
   * （实测本机浏览器 15px：不滚 240、会滚 225），而外层是 `mx-auto` 居中，
   * 于是切分区看着像整页左右抖。修法是 `html { scrollbar-gutter: stable }`（stable 下实测跳 0）。
   *
   * jsdom 没有真实布局，量不出这 15px，所以这条只能钉"规则还在"——
   * 与 既有约定 那条"CSS 那道闸与常量同源"同一手法（读源文件）。
   * 它防的是"哪天有人整理 base 层时把它删了"，不防"这条本来就没用"（那部分归真机清单 O16）。
   */
  /**
   * 交叉淡入淡出的定义收在 `assets/styles/shitab.css` 一处（`.tn-fade-*`），
   * 设置页换分区与工作台换视图**共用它**。
   * 类名前缀必须与两处 `<Transition name="tn-fade">` 对得上 —— 对不上不会报错，
   * 只会静默回到硬切，所以只能扫源码钉。jsdom 的 transitionDuration 恒为 0，
   * 它连"有没有在动"都测不出来，这三条钉的是命名与结构，观感归真机清单 O17 / O18。
   */
  const css = () => readFileSync(join(process.cwd(), 'assets', 'styles', 'shitab.css'), 'utf8');

  it('Transition 的 name 与 CSS 里的类名前缀同源', () => {
    const style = css();
    for (const suffix of ['enter-active', 'leave-active', 'enter-from', 'leave-to']) {
      expect(style, `shitab.css 里缺 .tn-fade-${suffix}`).toContain(`.tn-fade-${suffix}`);
    }
    // 离场那一屏必须撤出文档流，否则两屏是上下排不是叠在一起
    expect(style, '.tn-fade-leave-active 必须 position: absolute，不然不叫交叉').toMatch(
      /\.tn-fade-leave-active\s*\{[^}]*position:\s*absolute/,
    );
    // 晕动症下要完全跳过，而不是"快到看不见"
    expect(style, 'prefers-reduced-motion 下必须 transition: none').toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.tn-fade-enter-active,[\s\S]*?transition:\s*none/,
    );
  });

  it('设置页与工作台都挂同一个 name，且都没用动画结束钩子驱动状态', () => {
    for (const page of ['entrypoints/options/App.vue', 'entrypoints/app/App.vue']) {
      const vue = readFileSync(join(process.cwd(), page), 'utf8');
      expect(vue, `${page} 要用共用的 <Transition name="tn-fade">`).toContain('<Transition name="tn-fade">');
      // ⚠ 只匹配**代码形状**，不匹配裸词 transitionend —— 第一版被自己写在注释里的
      // "没有任何一处挂在 transitionend 上"判红过：扫源码的断言分不清注释与代码。
      expect(vue, `${page} 不该用动画结束钩子驱动状态`).not.toMatch(
        /@after-enter|onAfterEnter|addEventListener\(\s*['"]transitionend/,
      );
    }
  });

  it('工作台的交叉淡只盖住"换视图"那一处，不盖分类筛选', () => {
    const vue = readFileSync(join(process.cwd(), 'entrypoints', 'app', 'App.vue'), 'utf8');
    // 只有 会话列表 ↔ 回收站 这一处 Transition。
    // 切分类/进出搜索是同一个列表重新筛选，加交叉淡会让两份列表在动画期间同时存在
    // （首屏 ~600 行 = 双份 DOM），与 既有约定 的窗口化对着干 ⇒ 刻意不做。
    expect([...vue.matchAll(/<Transition\s+name="tn-fade">/g)], '工作台只能有一处 Transition').toHaveLength(1);
    expect(vue).toContain('v-if="showTrash"');
    expect(vue).toContain('v-else key="list"');
    // 回收站那支与列表那支的各自动作不许被包进对方的 key。
    // ⚠ 既有约定 把 `@close="leaveTrashView"` 删了（那颗「返回」没了，出口是左栏那颗开关），
    //   所以这里不再扫那颗组件的字面标签。切两支的边界用 `key="list"` 那一行本身 ——
    //   上一版写成 `key="trash"[\s\S]*?<GroupRow` 的正则会**跨过分支边界**一路找到列表那支里
    //   的 <GroupRow，把绿的说成红的：扫源码的断言只会比你想的更宽松。
    const trashAt = vue.indexOf('key="trash"');
    const listAt = vue.indexOf('v-else key="list"');
    expect(trashAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(trashAt);
    const trashBranch = vue.slice(trashAt, listAt);
    const listBranch = vue.slice(listAt);
    expect(trashBranch, '回收站那支里不许出现会话列表的卡片').not.toContain('<GroupRow');
    expect(trashBranch).toContain('<TrashPanel />');
    expect(listBranch, '列表那支里不许出现回收站面板').not.toContain('<TrashPanel');
    expect(listBranch).toContain('<GroupRow');
  });

  it('html 上钉着 scrollbar-gutter: stable', () => {
    const css = readFileSync(join(process.cwd(), 'assets', 'styles', 'shitab.css'), 'utf8');
    expect(css, 'html 的滚动条槽必须常驻，否则分区切换会横向跳 15px').toMatch(
      /html\s*\{[^}]*scrollbar-gutter:\s*stable/,
    );
  });

  it('五个分区共用同一颗 <main>，宽度不由内容决定', async () => {
    // flex-1 + min-w-0：分区的宽度只跟容器走。这条钉住"不是我们给关于单独设了宽度"。
    const wrapper = await mountApp();
    const main = wrapper.find('main');
    expect(main.classes()).toContain('flex-1');
    expect(main.classes()).toContain('min-w-0');
    for (const id of PANE_IDS) {
      await goPane(wrapper, id);
      expect(wrapper.findAll('main'), `分区 ${id} 不该另起一个 main`).toHaveLength(1);
    }
  });
});

describe('权限说明不再说谎', () => {
  /** 装机清单是 ['tabs','storage','alarms','contextMenus']（0083 加 alarms、0100 加 contextMenus），
   * 而这段文案曾经写"只申请两项"、又写过"三项"。 */
  const read = (locale: 'en' | 'zh_CN') =>
    JSON.parse(readFileSync(join(process.cwd(), 'public', '_locales', locale, 'messages.json'), 'utf8')) as Record<
      string,
      { message: string }
    >;
  /** 少了这条 key 就带着原因炸，而不是让 `.message` 在 undefined 上撞一个没头没尾的 TypeError。 */
  const bodyOf = (locale: 'en' | 'zh_CN'): string => {
    const entry = read(locale).options_permissions_body;
    if (!entry) throw new Error(`${locale}/messages.json 里没有 options_permissions_body`);
    return entry.message;
  };

  it('en 与 zh_CN 都说四项，并且点名 alarms 与 contextMenus', () => {
    const en = bodyOf('en');
    const zh = bodyOf('zh_CN');

    expect(en).toContain('Four permissions');
    // 每次新增权限后，上一版那个数字必须从文案里**消失** —— 这才是"不说谎"的可执行形状。
    expect(en.toLowerCase()).not.toContain('three permissions');
    expect(en.toLowerCase()).not.toContain('two permissions');
    expect(zh).toContain('四项权限');
    expect(zh).not.toContain('三项权限');
    expect(zh).not.toContain('两项权限');
    for (const body of [en, zh]) {
      for (const permission of ['tabs', 'storage', 'alarms', 'contextMenus']) {
        expect(body).toContain(permission);
      }
    }
  });

  it('文案里的权限清单和 manifest 一字不差', () => {
    const manifest = readFileSync(join(process.cwd(), 'wxt.config.ts'), 'utf8');
    const declared = [...manifest.matchAll(/permissions:\s*\[([^\]]*)\]/g)][0]?.[1] ?? '';
    const names = [...declared.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    expect(names).toEqual(['tabs', 'storage', 'alarms', 'contextMenus']);

    const body = bodyOf('en');
    for (const name of names) expect(body, `权限说明漏了 ${name}`).toContain(name);
  });
});

/**
 * 真机反馈（2026-10-06，Chrome）：**导入成功了，但界面什么提示都没有**。
 *
 * 根因不在这条动作里，在"谁负责播报"：`store.importFile()` 成功时走的是
 * `showToast({ kind: 'import', groups, tabs, categories })`（`composables/useGroups.ts`），
 * 而渲染这个 toast 的 `ResultToast` **只挂在工作台**（`entrypoints/app/App.vue`），
 * 设置页整页没有它 ⇒ 状态被设进 store，屏幕上没有任何东西读它。
 * 同一页上的导出（`export_done`）与复制之类的播报因此一起失效。
 */
describe('设置页的动作也要有播报', () => {
  const BACKUP = JSON.stringify({
    format: 'shitab-backup',
    version: 1,
    exportedAt: 1_700_000_000_000,
    groups: [
      {
        id: 'ui-imported',
        title: '导入进来的会话',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        isPinned: false,
        locked: false,
        sortOrder: 0,
        tabs: [
          {
            id: 'ui-imported-t0',
            groupId: 'ui-imported',
            url: 'https://example.test/page',
            title: '导入的一条',
            createdAt: 1_700_000_000_000,
            sortOrder: 0,
            originalIndex: 0,
            originalPinned: false,
            wasActive: false,
            closeState: 'closed',
            restorable: true,
          },
        ],
      },
    ],
    categories: [],
    settings: {},
  });

  it('在设置页导入一份合法备份 ⇒ 屏幕上出现"导入了几个会话 · 几条"那一句', async () => {
    const wrapper = await mountApp();
    await goPane(wrapper, 'data');

    const input = wrapper.find('input[type="file"]');
    expect(input.exists(), '数据分区里该有那颗文件选择框').toBe(true);
    const file = new File([BACKUP], 'backup.json', { type: 'application/json' }) as File & { text: () => Promise<string> };
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });

    // jsdom 的 Blob/File **没有 `.text()`**（真浏览器有）—— 不补这一刀，用例测到的是
    // "环境缺 API"而不是"结果没地方显示"。补的是环境，不是被测行为。
    file.text = async () => BACKUP;
    await input.trigger('change');
    await flushPromises();
    await flushPromises();

    const index = await (await import('@/infrastructure/storage/wxt-storage')).createStoragePort().listGroupIndex();
    expect(index.map((entry) => entry.id), '前置：数据确实进来了（他报的就是"成功了但看不见"）').toContain('ui-imported');
    expect(document.body.textContent, '导入成功却没有任何可见结果 ⇒ 播报组件没挂在这一页').toContain('Imported 1 sessions');
  });
});
