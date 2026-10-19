/**
 * 收纳黑名单那一栏的界面用例。
 *
 * 三条纪律（与 `ui-sync-panel.spec.ts` 同一套）：
 * 1. **断言真文案**，不断 i18n key。
 * 2. **每条否定断言都配正向对照**："添加按钮点不动"必须同时钉住"填对了它就点得动"。
 * 3. ★ **回显必须被钉住** —— 它是本轮唯一一条专门为了"不静默失败"而存在的 UI：
 *    `normalizePrefix` 在猜（补 http 还是 https、这是不是个主机名），猜错的那条会永远
 *    命不到任何 URL 而界面显示"已添加"。回显没了，这个组件就只剩一个静默失败。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import BlacklistPanel from '@/components/BlacklistPanel.vue';
import { DEFAULT_BLOCKED_PREFIXES } from '@/core/domain/blocked-prefixes';

function mountPanel(prefixes: string[]) {
  return mount(BlacklistPanel, { props: { prefixes } });
}

/**
 * 这一栏是**受控**的：它只 `emit`，改列表的是外面（`App.vue` 的 `patch()`）。
 * 所以用例里点完要把 emit 出来的那份回灌进 props 再看界面 ——
 * 少了这一步，所有"点了之后界面变成什么样"的断言都是在验一份没变的 props。
 */
async function commit(w: ReturnType<typeof mountPanel>): Promise<string[]> {
  const next = w.emitted('change')?.at(-1)?.[0] as string[];
  await w.setProps({ prefixes: next });
  return next;
}

/**
 * 面板**默认折叠**（2026-10-19，用户要求）：预设列表不进 DOM。
 * 除"默认折叠"那条专用例外，所有交互用例都先展开再点 ——
 * 少了这一步，`w.get('[data-testid="blacklist-draft"]')` 会直接找不到元素。
 */
async function expand(w: ReturnType<typeof mountPanel>): Promise<void> {
  await w.get('[data-testid="blacklist-expand"]').trigger('click');
}

const findEcho = (w: ReturnType<typeof mountPanel>) => w.get('[data-testid="blacklist-echo"]').text();

describe('BlacklistPanel', () => {
  it('默认折叠：预设列表不进 DOM，点展开才出现（点收起又没了）', async () => {
    const w = mountPanel([...DEFAULT_BLOCKED_PREFIXES]);
    // 折叠态连 checkbox 都没有 —— 不是"渲染了藏起来"，Tab 焦点也不该摸到它
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    expect(w.find('[data-testid="blacklist-expand"]').exists()).toBe(true);

    await expand(w);
    expect(w.find('input[type="checkbox"]').exists()).toBe(true);
    expect(w.find('[data-testid="blacklist-collapse"]').exists()).toBe(true);

    await w.get('[data-testid="blacklist-collapse"]').trigger('click');
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    expect(w.find('[data-testid="blacklist-collapse"]').exists()).toBe(false);
  });

  it('默认名单里的项默认勾上，扩展页那几项不勾', async () => {
    const w = mountPanel([...DEFAULT_BLOCKED_PREFIXES]);
    await expand(w);
    const checked = w.findAll('input[type="checkbox"]').map((box) => (box.element as HTMLInputElement).checked);
    // 预设共 12 项：前 9 项（默认名单）勾上，后 3 项（扩展页）不勾
    expect(checked.slice(0, DEFAULT_BLOCKED_PREFIXES.length).every(Boolean)).toBe(true);
    expect(checked.slice(DEFAULT_BLOCKED_PREFIXES.length).some(Boolean)).toBe(false);
  });

  it('取消勾选默认项 ⇒ 出现那句警告（勾回来就没了）', async () => {
    const w = mountPanel([...DEFAULT_BLOCKED_PREFIXES]);
    await expand(w);
    expect(w.find('[data-testid="blacklist-unblock-warning"]').exists()).toBe(false);

    const first = w.get(`[data-testid="blacklist-preset-${DEFAULT_BLOCKED_PREFIXES[0]}"]`);
    await first.setValue(false);
    await commit(w);
    const warning = w.get('[data-testid="blacklist-unblock-warning"]');
    // 文案的重点必须在"从此会被收进会话并关掉"上 —— 2026-10-19 用户实测踩过的坑：
    // 原来只讲"开不回来"，读起来像"不影响收纳"，于是取消勾选之后才发现页面被收走了。
    expect(warning.text()).toContain('will be stashed and closed');

    await first.setValue(true);
    await commit(w);
    expect(w.find('[data-testid="blacklist-unblock-warning"]').exists()).toBe(false);
  });

  it('★ 状态摘要：折叠态就写着"当前 N 项不收纳"（默认全勾时）', () => {
    const w = mountPanel([...DEFAULT_BLOCKED_PREFIXES]);
    // 折叠态（默认）：列表不进 DOM，摘要必须在
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
    expect(w.get('[data-testid="blacklist-summary"]').text()).toBe(
      `${DEFAULT_BLOCKED_PREFIXES.length} prefixes are never stashed.`,
    );
  });

  it('★ 有默认项被取消勾选 ⇒ 摘要直接点名"它会被照收"（折叠态也看得见）', () => {
    const w = mountPanel(DEFAULT_BLOCKED_PREFIXES.filter((prefix) => prefix !== 'chrome://'));
    const summary = w.get('[data-testid="blacklist-summary"]').text();
    expect(summary).toContain('chrome:// will be stashed (and closed)');
    // 正向对照：没被取消的那些不该被点名
    expect(summary).not.toContain('edge://');
  });

  it('摘要里点名的多项按当前语言用逗号隔开', () => {
    const w = mountPanel(
      DEFAULT_BLOCKED_PREFIXES.filter((prefix) => prefix !== 'chrome://' && prefix !== 'edge://'),
    );
    expect(w.get('[data-testid="blacklist-summary"]').text()).toContain(
      'chrome://, edge:// will be stashed',
    );
  });

  it('勾上扩展页 ⇒ 也走同一条 emit（收进来的是归一化后的前缀）', async () => {
    const w = mountPanel([...DEFAULT_BLOCKED_PREFIXES]);
    await expand(w);
    await w.get('[data-testid="blacklist-preset-chrome-extension://"]').setValue(true);
    const emitted = w.emitted('change');
    expect(emitted?.[0]?.[0]).toContain('chrome-extension://');
    expect(emitted?.[0]?.[0]).toHaveLength(DEFAULT_BLOCKED_PREFIXES.length + 1);
  });

  it('★ 回显：填域名要让人看见它补成了什么（猜的那一步不许藏着）', async () => {
    const w = mountPanel([]);
    await expand(w);
    await w.get('[data-testid="blacklist-draft"]').setValue('mail.google.com');
    expect(findEcho(w)).toContain('https://mail.google.com/');

    // 带端口那一格也是在猜，同样要回显
    await w.get('[data-testid="blacklist-draft"]').setValue('localhost:3000');
    expect(findEcho(w)).toContain('https://localhost:3000/');
  });

  it('添加：存进去的是归一化后的那条，不是用户手写的那条', async () => {
    const w = mountPanel([]);
    await expand(w);
    await w.get('[data-testid="blacklist-draft"]').setValue('MAIL.google.com');
    await w.get('[data-testid="blacklist-add"]').trigger('click');
    expect(w.emitted('change')?.[0]?.[0]).toEqual(['https://mail.google.com/']);
    // 加完清空输入框 ⇒ 回显那条也跟着没了
    expect((w.get('[data-testid="blacklist-draft"]').element as HTMLInputElement).value).toBe('');
  });

  it('认不出来 ⇒ 红字提示，且添加按钮不可点（正向对照：填对了就点得动）', async () => {
    const w = mountPanel([]);
    await expand(w);
    await w.get('[data-testid="blacklist-draft"]').setValue('http://a b c/');
    expect(w.find('[data-testid="blacklist-invalid"]').exists()).toBe(true);
    expect(
      (w.get('[data-testid="blacklist-add"]').element as HTMLButtonElement).disabled,
    ).toBe(true);

    await w.get('[data-testid="blacklist-draft"]').setValue('edge://');
    expect(w.find('[data-testid="blacklist-invalid"]').exists()).toBe(false);
    expect(
      (w.get('[data-testid="blacklist-add"]').element as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('重复的那条不许再加一遍', async () => {
    const w = mountPanel(['https://mail.google.com/']);
    await expand(w);
    await w.get('[data-testid="blacklist-draft"]').setValue('mail.google.com');
    expect(w.find('[data-testid="blacklist-duplicate"]').exists()).toBe(true);
    expect(
      (w.get('[data-testid="blacklist-add"]').element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('自己加的那些单独列出并可以移除（预设那几项不给移除按钮）', async () => {
    const w = mountPanel([...DEFAULT_BLOCKED_PREFIXES, 'https://mail.google.com/']);
    await expand(w);
    expect(w.find('[data-testid="blacklist-remove-https://mail.google.com/"]').exists()).toBe(true);
    await w.get('[data-testid="blacklist-remove-https://mail.google.com/"]').trigger('click');
    const next = w.emitted('change')?.[0]?.[0] as string[];
    expect(next).not.toContain('https://mail.google.com/');
    expect(next).toHaveLength(DEFAULT_BLOCKED_PREFIXES.length);
  });
});
