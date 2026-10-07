/**
 * 三个新组件（GroupRow 右栏会话 / CategoryRail 左栏分类 / TabRow 一条记录）的行为测试。
 *
 * 与 `ui-workbench.spec.ts` 的分工：那份测"整页接线"（主按钮真发消息、消息里带 windowId、
 * 分批渲染真的追加），这份测"每个单元自己的规则"：单复数文案、折叠阈值、锁定改了哪些落点、
 * 分类的增删改排序在界面上有没有入口。
 *
 * 断言一律用**用户真正看到的英文文案**（test/setup.ts 读的是真的 en/messages.json），
 * 不用 key 名 —— 断言渲染出了 'group_tab_count_one' 只能证明代码里写了那个字符串。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import CategoryRail from '@/components/CategoryRail.vue';
import GroupRow from '@/components/GroupRow.vue';
import TabRow from '@/components/TabRow.vue';
import { useGroups } from '@/composables/useGroups';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { storagePort } from '@/shared/services';
import { toIndexEntry } from '@/core/domain/group';
import { CAT_MIME, encode, GROUP_MIME } from '@/shared/dnd';
import { COLLAPSED_TAB_LIMIT, TAB_EXPAND_BATCH } from '@/shared/constants';
import type { GroupIndexEntry, RestoreResult, SavedTab, TabGroup } from '@/shared/types';

const AT = 1_700_000_000_000;

function tab(groupId: string, index: number, over: Partial<SavedTab> = {}): SavedTab {
  return {
    id: `${groupId}-t${index}`,
    groupId,
    url: `https://flutter.dev/page-${index}`,
    title: `Flutter 文档 ${index}`,
    createdAt: AT,
    sortOrder: index,
    originalIndex: index,
    originalPinned: false,
    wasActive: index === 0,
    closeState: 'closed',
    restorable: index !== 1,
    domain: 'flutter.dev',
    ...over,
  };
}

function group(id: string, title: string, count: number, over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    title,
    createdAt: AT,
    updatedAt: AT,
    isPinned: false,
    locked: false,
    sortOrder: 0,
    tabs: Array.from({ length: count }, (_, index) => tab(id, index)),
    ...over,
  };
}

const entryOf = (g: TabGroup): GroupIndexEntry => toIndexEntry(g);

const sendMessage = vi.fn();

function useStore() {
  return useGroups();
}

async function seed(g: TabGroup): Promise<void> {
  await createStoragePort().putGroup(g);
}

/** GroupRow 挂载时会自己回源 tab，所以要先种数据再 mount。 */
async function mountRow(g: TabGroup, props: Record<string, unknown> = {}) {
  await seed(g);
  const wrapper = mount(GroupRow, { props: { entry: entryOf(g), tabs: g.tabs, ...props } });
  await flushPromises();
  return wrapper;
}

function byText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').filter((node) => node.text().includes(text));
}

const iconButton = (wrapper: ReturnType<typeof mount>, label: string) =>
  wrapper.find(`button[aria-label="${label}"]`);

/**
 * 打开 ⋯ 溢出菜单（以前是原生 details，现在是受控开合的按钮 + ul[role=menu]）。
 *
 * 幂等：只在 `aria-expanded=false` 时点。那个按钮是**开关**，测试里连点两次会把菜单又关上。
 */
async function openMenu(wrapper: ReturnType<typeof mount>) {
  const trigger = iconButton(wrapper, 'More actions');
  if (trigger.attributes('aria-expanded') !== 'true') {
    await trigger.trigger('click');
    await flushPromises();
  }
  return wrapper.findAll('ul[role="menu"] li button');
}

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  setActivePinia(createPinia());
  sendMessage.mockReset();
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMessage as never);
  vi.spyOn(fakeBrowser.windows, 'getCurrent').mockResolvedValue({ id: 7 } as never);
  sendMessage.mockResolvedValue({
    ok: true,
    value: {
      operationId: 'op',
      windowId: 7,
      mode: 'current',
      restored: 2,
      skipped: 0,
      failed: 0,
      failedUrls: [],
      skippedUrls: [],
    } satisfies RestoreResult,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GroupRow
// ---------------------------------------------------------------------------

describe('GroupRow', () => {
  it('标题、条数（复数）与五个常驻图标都在', async () => {
    const wrapper = await mountRow(group('g1', 'Flutter 开发', 2));

    expect(wrapper.text()).toContain('Flutter 开发');
    expect(wrapper.text()).toContain('2 tabs');
    for (const label of ['Restore all', 'Restore in a new window', 'Pin to top', 'Lock session', 'Copy all links']) {
      expect(iconButton(wrapper, label).exists(), `缺常驻图标 ${label}`).toBe(true);
    }
  });

  it('一条时用单数文案，不是 "1 tabs"', async () => {
    const wrapper = await mountRow(group('g2', '单页', 1));
    expect(wrapper.text()).toContain('1 tab');
    expect(wrapper.text()).not.toContain('1 tabs');
  });

  /**
   * 标题长到放不下时，**该被截断的是标题**，不是把右边那排控件挤出卡片。
   *
   * 2026-10-06 真机「回收站标签多了会溢出」在浏览器探针里量到的形状：长标题那一行的
   * `header` 溢出 29px，整份文档因此比视口宽 8px ⇒ 每一行右侧的动作都落到视口外面。
   * `tn-ellipsis` 是 nowrap + overflow:hidden + text-overflow:ellipsis，它**只在盒子被压窄时**
   * 才生效；`shrink-0` 说的正是"别压我"，于是那三条一起失效（`min-w-0` 也救不回来 ——
   * 它只是"允许被压到 0"，压不压由 flex-shrink 决定）。
   *
   * ⚠ 这一条与 `ui-trash-panel.spec.ts` 里那条**成对**：标题行的排布在两个组件里各写了一份
   * （既有约定 让它们同形），只钉一颗，另一颗可以随便漂回去。
   */
  it('标题长到放不下时是标题被截断，右侧控件不许被挤出去', async () => {
    const wrapper = await mountRow(group('g-long', '一段足够长的会话标题用来把标题行撑到放不下'.repeat(3), 2));

    const title = wrapper.find('[data-testid="group-title"]');
    expect(title.classes()).toContain('tn-ellipsis');
    expect(title.classes()).toContain('min-w-0');
    expect(title.classes(), 'shrink-0 会让 tn-ellipsis 永远不生效 ⇒ 标题把整行撑破').not.toContain('shrink-0');
    // 正向对照：真正该钉住宽度的是时间戳那一格（它被挤走才是这次的病）
    expect(wrapper.find('[data-session-stamp]').classes(), '时间戳丢了 shrink-0').toContain('shrink-0');
  });

  it('空会话的还原是禁用的，正文写的是"空"而不是"没加载"', async () => {
    const wrapper = await mountRow(group('g3', '空会话', 0));
    expect(iconButton(wrapper, 'Restore all').attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('This session is empty');
  });

  it('tabs 还没到位时不谎报"空会话"', async () => {
    const g = group('g4', '还没加载', 2);
    await seed(g);
    const wrapper = mount(GroupRow, { props: { entry: entryOf(g) } });
    expect(wrapper.text()).not.toContain('This session is empty');
    expect(wrapper.text()).toContain('…');
    wrapper.unmount();
  });

  it('标题为空给占位文案，且占位是"看得见的空"而不是数据里的中文字面量', async () => {
    const wrapper = await mountRow(group('g5', '', 1));
    expect(wrapper.text()).toContain('Untitled session');
    // 数据里存的必须是空串：存中文默认名会把这条数据钉死在收纳时的浏览器语言上
    expect((await createStoragePort().getGroup('g5'))?.title).toBe('');
  });

  it('标题行只有一行：名字 + 带秒的时间戳，没有第二行小字、也没有相对时间', async () => {
    const wrapper = await mountRow(group('g5b', 'Flutter 开发', 1));
    const header = wrapper.find('section > header');

    expect(header.find('p').exists(), '不该再有第二行小字').toBe(false);
    expect(wrapper.text()).not.toMatch(/now|秒前|分钟前|ago/);

    const stamp = header.find('[data-session-stamp]');
    expect(stamp.exists(), '时间戳没渲染').toBe(true);
    // 带秒：会话默认没名字，它是唯一能区分两次连续收纳的东西
    expect(stamp.text()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('点标题直接进入改名，输入框带"Name"占位；回车落盘', async () => {
    const g = group('g5c', '', 1);
    const wrapper = await mountRow(g);

    await byText(wrapper, 'Untitled session')[0]?.trigger('click');
    const input = wrapper.find('input[type="text"]');
    expect(input.exists(), '点标题没进入改名态').toBe(true);
    expect(input.attributes('placeholder')).toBe('Name');

    await input.setValue('待办');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect((await createStoragePort().getGroup('g5c'))?.title).toBe('待办');
  });

  it('常驻两个还原按钮分别发 mode=current 与 mode=newWindow', async () => {
    const wrapper = await mountRow(group('g6', 'Flutter 开发', 2));

    await iconButton(wrapper, 'Restore all').trigger('click');
    await flushPromises();
    expect(sentCommand('restoreGroup')).toMatchObject({ windowId: 7, mode: 'current' });

    await iconButton(wrapper, 'Restore in a new window').trigger('click');
    await flushPromises();
    expect(sentCommand('restoreGroup')).toMatchObject({ windowId: 7, mode: 'newWindow' });
  });

  it('⋯ 里给重命名 / 无痕还原 / 导出网页 / 归类 / 删除（不再有"添加当前标签页"）', async () => {
    const wrapper = await mountRow(group('g7', 'Flutter 开发', 1));
    const items = (await openMenu(wrapper)).map((node) => node.text().trim());
    expect(items.slice(0, 3)).toEqual([
      'Rename',
      'Restore in an incognito window',
      'Export as a web page',
    ]);
    expect(items).not.toContain('Add current tab');
    expect(items).toContain('Delete');
    // 这条会话不属于任何分类 => 没有"解除归类"可给
    expect(items).not.toContain('Remove from category');
  });

  it('删除是行内二次确认，写明会移除几条；确认才真删', async () => {
    const g = group('g8', '要删的会话', 3);
    const wrapper = await mountRow(g);
    await openMenu(wrapper);

    await byText(wrapper, 'Delete').at(-1)?.trigger('click');
    expect(wrapper.text()).toContain('Delete this session?');
    expect(wrapper.text()).toContain('3 saved tabs will be removed');
    expect(await createStoragePort().getGroup('g8')).toBeDefined();

    await wrapper.find('.bg-danger-soft button').trigger('click');
    await flushPromises();
    expect(await createStoragePort().getGroup('g8')).toBeUndefined();
  });

  it('重命名回车提交、Esc 取消', async () => {
    const g = group('g9', '旧名字', 1);
    const wrapper = await mountRow(g);
    await openMenu(wrapper);
    await byText(wrapper, 'Rename')[0]?.trigger('click');

    const input = wrapper.find('input[type="text"]');
    expect(input.exists(), '没出现行内重命名输入框').toBe(true);
    await input.setValue('  新名字  ');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect((await createStoragePort().getGroup('g9'))?.title).toBe('新名字');

    await openMenu(wrapper);
    await byText(wrapper, 'Rename')[0]?.trigger('click');
    const second = wrapper.find('input[type="text"]');
    await second.setValue('不该被保存');
    await second.trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect((await createStoragePort().getGroup('g9'))?.title).toBe('新名字');
  });

  it('锁定：出现 Locked 标记、删除项禁用、不显示确认入口', async () => {
    const wrapper = await mountRow(group('g10', '锁着的会话', 2, { locked: true }));

    expect(wrapper.text()).toContain('Locked');
    expect(iconButton(wrapper, 'Unlock session').exists()).toBe(true);
    await openMenu(wrapper);
    const del = byText(wrapper, 'Delete').at(-1);
    expect(del?.attributes('disabled')).toBeDefined();

    await del?.trigger('click');
    expect(wrapper.text()).not.toContain('Delete this session?');
    expect(await createStoragePort().getGroup('g10')).toBeDefined();
  });

  it('锁定会话的行级 × 消失（TabRow 那一侧），但复制与还原还在', async () => {
    const wrapper = await mountRow(group('g11', '锁着的会话', 2, { locked: true }));
    expect(wrapper.findAll('button[aria-label="Delete"]')).toHaveLength(0);
    expect(iconButton(wrapper, 'Copy all links').attributes('disabled')).toBeUndefined();
  });

  it('超过 30 条只渲染前 30 条，点"展开其余 N 个"才全给', async () => {
    const wrapper = await mountRow(group('g12', '长会话', COLLAPSED_TAB_LIMIT + 5));

    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(COLLAPSED_TAB_LIMIT);
    expect(wrapper.text()).toContain(`Show 5 more tabs`);

    await byText(wrapper, 'Show 5 more tabs')[0]?.trigger('click');
    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(COLLAPSED_TAB_LIMIT + 5);
    expect(wrapper.text()).toContain('Collapse');
  });

  /**
   * ★ 既有约定 采纳 1：一批 200 条，摊到底才收起。
   * 上面那条 35 条的用例覆盖不到这里 —— 它一次就点完了，所以"分批"这件事必须为**超过一批**的那一档单独钉。
   */
  it('超过一批时点一次只多摊 200 条，再点才到底', async () => {
    const total = COLLAPSED_TAB_LIMIT + TAB_EXPAND_BATCH + 50;
    const wrapper = await mountRow(group('g30', '很长的会话', total));

    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(COLLAPSED_TAB_LIMIT);
    expect(wrapper.text()).toContain(`Show ${TAB_EXPAND_BATCH + 50} more tabs`);

    await byText(wrapper, `Show ${TAB_EXPAND_BATCH + 50} more tabs`)[0]?.trigger('click');
    expect(wrapper.findAll('[data-tab-row]'), '一次点到底会挂出 230+50 行，那正是旧形状').toHaveLength(
      COLLAPSED_TAB_LIMIT + TAB_EXPAND_BATCH,
    );
    expect(wrapper.text(), '最后一批不足一批，按钮还在报剩余数').toContain('Show 50 more tabs');

    await byText(wrapper, 'Show 50 more tabs')[0]?.trigger('click');
    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(total);
    expect(wrapper.text()).toContain('Collapse');

    await byText(wrapper, 'Collapse')[0]?.trigger('click');
    expect(wrapper.findAll('[data-tab-row]'), '收回折叠态').toHaveLength(COLLAPSED_TAB_LIMIT);
  });

  /**
   * ★★ 这条是 既有约定 采纳 1 的**判据本身**：分批只许影响渲染（`shown`），
   * 不许影响勾选与"整组动作"的输入（`ordered`）。
   *
   * 写它是因为不写就会有人把 `visibleTabIds` 改成"当前摊开的那些" —— 那时用户点一次行首框
   * 只勾住 230 条，剩下 50 条不在选择里，"删除所选"走的就是记录级而不是整组路径，
   * 表现成「我勾了一整组，删完还剩几条」（既有约定 补格第②格防的正是这件事）。
   */
  it('只摊开一批时点行首框，勾的仍是整表', async () => {
    const store = useStore();
    const total = COLLAPSED_TAB_LIMIT + TAB_EXPAND_BATCH + 50;
    const wrapper = await mountRow(group('g31', '很长的会话', total));

    await byText(wrapper, `Show ${TAB_EXPAND_BATCH + 50} more tabs`)[0]?.trigger('click');
    expect(wrapper.findAll('[data-tab-row]'), '界面上只有 230 行').toHaveLength(COLLAPSED_TAB_LIMIT + TAB_EXPAND_BATCH);

    await wrapper.find('[data-testid="group-check-g31"]').setValue(true);

    expect(store.checkedRecords.size, '勾的是整表 280 条，不是看得见的那 230 条').toBe(total);
    expect(store.checkedCount, '整行被覆盖 ⇒ 算一个标签组').toBe(1);
    expect(store.recordCount, '被整行覆盖的那些不重复算成记录').toBe(0);
    expect(store.checkedRecords.has('g31::g31-t279'), '连没摊出来的最后一条也在选择里').toBe(true);
  });

  /**
   * 既有约定：行首框不再是"另一种选择"，它是**这一行记录的全选** —— 勾选状态只剩一份。
   * 之前这颗写的是 `store.checked: Set<groupId>`，组内记录不参与批量，
   * 所以他要说「所有标签组、分类也支持标签组内多选操作」。
   */
  it('点行首框 ⇒ 这一行的记录全进勾选，行内那颗跟着变勾', async () => {
    const store = useStore();
    const wrapper = await mountRow(group('g13', 'Flutter 开发', 2));

    await wrapper.find('[data-testid="group-check-g13"]').setValue(true);

    expect([...store.checkedRecords].sort()).toEqual(['g13::g13-t0', 'g13::g13-t1']);
    expect(store.checkedCount, '整行覆盖 ⇒ 算一个标签组').toBe(1);
    expect(store.recordCount, '被整行覆盖的那些不再重复算成记录').toBe(0);
    expect(
      (wrapper.find('[data-testid="record-check-g13-t0"]').element as HTMLInputElement).checked,
      '行内那颗是同一份状态的派生',
    ).toBe(true);
  });

  /** 半选那根横杠是"整行还没勾满"唯一的说法；没有它，行首框与行内框就各说各的。 */
  it('只勾一条记录 ⇒ 行首框半选、未勾选，两个数各算各的', async () => {
    const store = useStore();
    const wrapper = await mountRow(group('g14', 'Flutter 开发', 2));

    await wrapper.find('[data-testid="record-check-g14-t0"]').setValue(true);

    const row = wrapper.find('[data-testid="group-check-g14"]').element as HTMLInputElement;
    expect(row.indeterminate, '选了一半却不半选 ⇒ 用户不知道整行还没勾满').toBe(true);
    expect(row.checked).toBe(false);
    expect(store.checkedCount).toBe(0);
    expect(store.recordCount).toBe(1);
    expect(store.selectionCount, '批量条看不看得见靠这个').toBe(1);
  });

  it('复制按钮写剪贴板，载荷是「标题换行 URL」', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });

    const wrapper = await mountRow(group('g14', 'Flutter 开发', 2));
    await iconButton(wrapper, 'Copy all links').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledWith(
      'Flutter 文档 0\nhttps://flutter.dev/page-0\n\nFlutter 文档 1\nhttps://flutter.dev/page-1',
    );
  });

  it('导出为网页：下载文件名是带时间前缀的 .html，不上传任何东西', async () => {
    // jsdom 没有 URL.createObjectURL，直接赋值而不是 spyOn（spy 不存在的方法会报错）
    const created: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      created.push(`${blob.type}`);
      return 'blob:fake';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;

    let download = '';
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        download = this.download;
      });

    try {
      const wrapper = await mountRow(group('g15', 'Flutter 开发', 1));
      await openMenu(wrapper);
      await byText(wrapper, 'Export as a web page')[0]?.trigger('click');
      await flushPromises();

      expect(download).toMatch(/^shitab-\d{8}-\d{4}-.+\.html$/);
      expect(created).toEqual(['text/html']);
    } finally {
      anchorClick.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('⋯ 里的分类列表把当前分类标出来，点另一个就改归属', async () => {
    const store = useStore();
    const category = { id: 'c1', name: '阅读', sortOrder: 0, createdAt: AT, updatedAt: AT };
    await createStoragePort().setCategories([category]);
    await store.reload();

    const g = group('g16', 'Flutter 开发', 1, { categoryId: 'c1' });
    const wrapper = await mountRow(g);
    expect(wrapper.text()).toContain('阅读'); // 分类 chip

    const items = (await openMenu(wrapper)).map((node) => node.text().trim());
    // 当前所属分类在列表里是禁用的（点它没有意义，还会让人以为没生效）
    expect(items).toContain('Remove from category');
    expect(items).toContain('阅读');

    await byText(wrapper, 'Remove from category')[0]?.trigger('click');
    await flushPromises();
    expect((await createStoragePort().getGroup('g16'))?.categoryId).toBeUndefined();
  });

  it('菜单里的分类列表：一个分类都没有时给指引，不给空下拉', async () => {
    const wrapper = await mountRow(group('g16b', 'Flutter 开发', 1));
    const items = (await openMenu(wrapper)).map((node) => node.text().trim());
    expect(items).not.toContain('Remove from category');
    expect(wrapper.find('ul[role="menu"]').text()).toContain('Create a category');
  });

  it('标题行不换行，名称 / 时间戳 / 图标在同一条垂直中心上', async () => {
    const wrapper = await mountRow(group('g18', 'Flutter 开发', 2, { categoryId: undefined }));
    const header = wrapper.find('section > header');

    expect(header.classes()).not.toContain('flex-wrap');
    expect(header.classes()).toContain('items-center');
    // 名称与时间戳在同一个 flex 容器里，而不是分两行
    const titleGroup = header.find('div.flex.min-w-0');
    expect(titleGroup.find('button').exists(), '名称不在标题组里').toBe(true);
    expect(titleGroup.find('[data-session-stamp]').exists(), '时间戳不在标题组里').toBe(true);
    // 图标盒与操作按钮同尺寸，中心才会对齐
    expect(header.find('div.grid.h-6.w-6').exists()).toBe(true);
  });

  it('搜索态下拖拽与还原被关掉（命中的是子集，重排语义不成立）', async () => {
    const wrapper = await mountRow(group('g17', 'Flutter 开发', 2), { searching: true });
    expect(wrapper.attributes('draggable')).not.toBe('true');
    expect(iconButton(wrapper, 'Restore all').attributes('disabled')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CategoryRail
// ---------------------------------------------------------------------------

describe('CategoryRail', () => {
  async function mountRail() {
    const store = useStore();
    await store.init();
    const wrapper = mount(CategoryRail);
    await flushPromises();
    return { store, wrapper };
  }

  function railItems(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAll('button.tn-item').map((node) => node.text().trim());
  }

  it('系统两行永远在：All sessions 与 Uncategorized，各自带计数', async () => {
    const { wrapper } = await mountRail();
    await useStore().addCategory('阅读');
    await seed(group('g1', '会话一', 1));
    await flushPromises();

    const items = railItems(wrapper);
    expect(items.some((text) => text.startsWith('All sessions'))).toBe(true);
    expect(items.some((text) => text.startsWith('Uncategorized'))).toBe(true);
    // 头部不再有「分类」标题字，改成了查找框
    expect(wrapper.find('input[type="search"]').attributes('placeholder')).toBe('Find a category');
  });

  it('点分类 = 设筛选，右栏只剩这个分类的会话', async () => {
    const { store, wrapper } = await mountRail();
    const created = await store.addCategory('阅读');
    await flushPromises();

    const target = wrapper.findAll('li button').find((node) => node.text().includes('阅读'));
    await target?.trigger('click');

    expect(store.filter).toEqual({ kind: 'category', id: created?.id });
    expect(target?.attributes('aria-current')).toBe('true');
  });

  it('＋ 建类：回车提交并自动切进新分类；纯空格不提交', async () => {
    const { store, wrapper } = await mountRail();
    await iconButton(wrapper, 'New category').trigger('click');

    const input = wrapper.find('input[type="text"]');
    await input.setValue('  ');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(store.categories).toHaveLength(0);

    await iconButton(wrapper, 'New category').trigger('click');
    const second = wrapper.find('input[type="text"]');
    await second.setValue('工作');
    await second.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(store.categories.map((category) => category.name)).toEqual(['工作']);
    expect(store.filter).toEqual({ kind: 'category', id: store.categories[0]?.id });
  });

  it('重名建类：不新增，错误原文留给页面顶部显示', async () => {
    const { store, wrapper } = await mountRail();
    await store.addCategory('工作');
    await flushPromises();

    await iconButton(wrapper, 'New category').trigger('click');
    const input = wrapper.find('input[type="text"]');
    await input.setValue('工作');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect(store.categories).toHaveLength(1);
    expect(store.error, '重名没有把失败原因留给 UI').toBeTruthy();
  });

  it('行内改名：✎ 出现输入框，回车写库', async () => {
    const { store, wrapper } = await mountRail();
    await store.addCategory('旧名');
    await flushPromises();

    await wrapper.find('button[aria-label="Rename category"]').trigger('click');
    const input = wrapper.find('input[type="text"]');
    expect(input.exists()).toBe(true);
    await input.setValue('新名');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect((await createStoragePort().listCategories())[0]?.name).toBe('新名');
  });

  it('删分类：条目没了，里面的会话退回未分类而不是跟着消失', async () => {
    const { store, wrapper } = await mountRail();
    const category = await store.addCategory('要删的');
    await seed(group('g1', '会话一', 1, { categoryId: category?.id }));
    await store.reload();
    await flushPromises();

    await wrapper.find('button[aria-label="Delete category"]').trigger('click');
    await flushPromises();

    expect(await createStoragePort().listCategories()).toEqual([]);
    expect((await createStoragePort().getGroup('g1'))?.categoryId).toBeUndefined();
    expect(await createStoragePort().getGroup('g1')).toBeDefined();
  });

  it('查找分类：只筛左栏这些行，右栏不动', async () => {
    const { store, wrapper } = await mountRail();
    await store.addCategory('阅读');
    await store.addCategory('工作');
    await seed(group('g1', '会话一', 1));
    await store.reload();
    await flushPromises();

    const box = wrapper.find('input[type="search"]');
    expect(box.exists(), '左栏没有分类查找框').toBe(true);
    await box.setValue('阅');
    await flushPromises();

    const rows = wrapper.findAll('li');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text()).toContain('阅读');
    // 查找只是找行，不改右栏的筛选
    expect(store.filter).toEqual({ kind: 'all' });

    await box.setValue('不存在的名');
    await flushPromises();
    expect(wrapper.findAll('li')).toHaveLength(0);
    expect(wrapper.text()).toContain('Nothing matches');
  });

  it('改名与删除按钮常驻可见（不靠 hover 才出现），↑↓ 才是 hover 才给', async () => {
    const { store, wrapper } = await mountRail();
    await store.addCategory('阅读');
    await flushPromises();

    for (const label of ['Rename category', 'Delete category']) {
      const button = wrapper.find(`button[aria-label="${label}"]`);
      expect(button.exists(), `找不到 ${label}`).toBe(true);
      expect(button.classes()).not.toContain('tn-cat-order');
    }
    expect(wrapper.find('button[aria-label="Move up"]').classes()).toContain('tn-cat-order');
  });

  it('查找中不给 ↑↓：过滤后的行号不是列表位置，按它移动会跳位', async () => {
    const { store, wrapper } = await mountRail();
    await store.addCategory('阅读');
    await store.addCategory('工作');
    await flushPromises();

    await wrapper.find('input[type="search"]').setValue('阅');
    await flushPromises();
    expect(wrapper.find('button[aria-label="Move up"]').exists(), '查找中还在给排序按钮').toBe(false);
  });

  it('↑↓ 调顺序，两端的按钮各自禁用', async () => {
    const { store, wrapper } = await mountRail();
    await store.addCategory('一');
    await store.addCategory('二');
    await flushPromises();

    const ups = wrapper.findAll('button[aria-label="Move up"]');
    const downs = wrapper.findAll('button[aria-label="Move down"]');
    expect(ups).toHaveLength(2);
    expect(ups[0]?.attributes('disabled')).toBeDefined();
    expect(downs[1]?.attributes('disabled')).toBeDefined();

    await downs[0]?.trigger('click');
    await flushPromises();
    expect((await createStoragePort().listCategories()).map((category) => category.name)).toEqual([
      '二',
      '一',
    ]);
  });

  it('把会话拖到分类上 = 归类；拖到 Uncategorized = 取消归类', async () => {
    const { store, wrapper } = await mountRail();
    const category = await store.addCategory('阅读');
    await seed(group('g1', '会话一', 1));
    await store.reload();
    await flushPromises();

    const drop = { dataTransfer: { getData: (type: string) => (type === GROUP_MIME ? encode({ groupId: 'g1' }) : ''), types: [GROUP_MIME] } };

    const row = wrapper.findAll('li div').find((node) => node.text().includes('阅读'));
    await row?.trigger('drop', drop);
    await flushPromises();
    expect((await createStoragePort().getGroup('g1'))?.categoryId).toBe(category?.id);

    const uncategorized = wrapper.findAll('button').find((node) => node.text().includes('Uncategorized'));
    await uncategorized?.trigger('drop', drop);
    await flushPromises();
    expect((await createStoragePort().getGroup('g1'))?.categoryId).toBeUndefined();
  });

  // ---- 分类拖拽排序-------------------------------------------

  /**
   * 够用的 DataTransfer 替身。按真协议给两件事：
   * `types` 是**活的**（dragstart 里 setData 之后，同一次拖拽的 dragover/drop 才看得见它），
   * `getData` 只在 drop 阶段返回数据 —— 组件里"dragover 只能靠组件内记的 id"这条约束就来自这里。
   */
  function makeTransfer() {
    const data = new Map<string, string>();
    return {
      get types(): string[] {
        return [...data.keys()];
      },
      effectAllowed: 'uninitialized',
      dropEffect: 'none',
      setData(type: string, value: string): void {
        data.set(type, value);
      },
      getData(type: string): string {
        return data.get(type) ?? '';
      },
    };
  }

  /**
   * 给每行一个 28px 的盒子。jsdom 里 `getBoundingClientRect()` 全 0，
   * "指针落在上半区还是下半区"这种判据**量不出任何差别**（全 0 时恒为缝 0），
   * 所以落点必须靠手工几何来测 —— 行 i 占 [i*28, i*28+28)，中线 i*28+14。
   */
  function stubRowGeometry(wrapper: ReturnType<typeof mount>, height = 28): void {
    wrapper.findAll('[data-cat-row]').forEach((node, index) => {
      const top = index * height;
      node.element.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 200,
          width: 200,
          x: 0,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
    });
  }

  async function mountRailWithThree(): Promise<{
    store: ReturnType<typeof useStore>;
    wrapper: ReturnType<typeof mount>;
    ids: string[];
  }> {
    const mounted = await mountRail();
    const ids: string[] = [];
    for (const name of ['一', '二', '三']) {
      const created = await mounted.store.addCategory(name);
      if (created) ids.push(created.id);
    }
    await flushPromises();
    stubRowGeometry(mounted.wrapper);
    return { ...mounted, ids };
  }

  /** 从第 index 行起手拖拽，返回可以直接喂给 dragover / drop 的载荷。 */
  async function dragRow(wrapper: ReturnType<typeof mount>, index: number) {
    const transfer = makeTransfer();
    const rows = wrapper.findAll('[data-cat-row]');
    await rows[index]?.find('div').trigger('dragstart', { dataTransfer: transfer });
    return transfer;
  }

  it('dragstart 把 categoryId 写成 CAT_MIME 载荷（不再是散在模板里的字面量）', async () => {
    const { wrapper, ids } = await mountRailWithThree();
    const transfer = await dragRow(wrapper, 0);
    expect(transfer.types).toEqual([CAT_MIME]);
    expect(transfer.getData(CAT_MIME)).toBe(encode({ categoryId: ids[0] ?? '' }));
    expect(transfer.effectAllowed).toBe('move');
  });

  it('拖到下一行的下半区 = 插到它后面，落库的是新顺序', async () => {    const { wrapper } = await mountRailWithThree();
    const transfer = await dragRow(wrapper, 0);

    // 行 1 的中线是 42，50 落在它下半区 => 缝 2 => 期望 [二,一,三]
    await wrapper.find('ul').trigger('drop', { dataTransfer: transfer, clientY: 50 });
    await flushPromises();

    expect((await createStoragePort().listCategories()).map((category) => category.name)).toEqual([
      '二',
      '一',
      '三',
    ]);
  });

  it('拖到列表底部 = 缝 3，落到最后一位', async () => {
    const { wrapper } = await mountRailWithThree();
    const transfer = await dragRow(wrapper, 0);

    await wrapper.find('ul').trigger('drop', { dataTransfer: transfer, clientY: 999 });
    await flushPromises();

    expect((await createStoragePort().listCategories()).map((category) => category.name)).toEqual([
      '二',
      '三',
      '一',
    ]);
  });

  /**
   * 上半区与下半区是**两道不同的缝**（既有约定 Q3：指针落在这一行的上半还是下半决定插到前面还是后面）。
   *
   * 这批必须成对出现：只测下半区的话，把判据从"过中线"写成"过了行顶"一个用例都不会红
   * —— 我第一次只留下半区的用例时，那条变异就是这么溜过去的（行 i 的下半区在两种判据下算出同一个缝）。
   * 行 i 占 [i*28, i*28+28)，中线 i*28+14。
   */
  it.each([
    ['拖「一」到「二」的上半区 = 缝 1 = 没动', 0, 35, ['一', '二', '三']],
    ['拖「一」到「二」的下半区 = 缝 2', 0, 50, ['二', '一', '三']],
    ['拖「二」到「一」的上半区 = 缝 0', 1, 5, ['二', '一', '三']],
    ['拖「二」到「三」的下半区 = 缝 3', 1, 80, ['一', '三', '二']],
    ['拖「三」到「一」的上半区 = 缝 0', 2, 5, ['三', '一', '二']],
    ['拖「三」到「二」的下半区 = 缝 2 = 没动', 2, 50, ['一', '二', '三']],
  ])('半区判据：%s', async (_label, from, clientY, expected) => {
    const { wrapper } = await mountRailWithThree();
    const transfer = await dragRow(wrapper, from);

    await wrapper.find('ul').trigger('drop', { dataTransfer: transfer, clientY });
    await flushPromises();

    expect((await createStoragePort().listCategories()).map((category) => category.name)).toEqual(expected);
  });

  it('指示线出现在落点缝上，drop 之后消失', async () => {
    const { wrapper } = await mountRailWithThree();
    const transfer = await dragRow(wrapper, 0);

    // 35 落在「二」的上半区 = 缝 1 = 「一」原来的位置：没有移动，就不该有线
    await wrapper.find('ul').trigger('dragover', { dataTransfer: transfer, clientY: 35 });
    expect(wrapper.find('.tn-drop-above, .tn-drop-below').exists(), '拖回原位也画线').toBe(false);

    await wrapper.find('ul').trigger('dragover', { dataTransfer: transfer, clientY: 50 });
    const rows = wrapper.findAll('[data-cat-row]');
    expect(rows[1]?.classes()).toContain('tn-drop-below');
    expect(rows[2]?.classes()).toContain('tn-drop-above');
    expect(rows[0]?.classes()).not.toContain('tn-drop-below');

    await wrapper.find('ul').trigger('drop', { dataTransfer: transfer, clientY: 50 });
    await flushPromises();
    expect(wrapper.find('.tn-drop-below').exists(), 'drop 之后指示线还留着').toBe(false);
  });

  it('会话载荷在 dragover 时不会点亮排序指示线（两种拖放各认各的 MIME）', async () => {
    const { wrapper } = await mountRailWithThree();
    const transfer = makeTransfer();
    transfer.setData(GROUP_MIME, encode({ groupId: 'g1' }));

    await wrapper.find('ul').trigger('dragover', { dataTransfer: transfer, clientY: 50 });
    expect(wrapper.find('.tn-drop-above, .tn-drop-below').exists()).toBe(false);
  });

  it('拖回自己上下的缝里 = 什么都没发生：不写库、不改顺序', async () => {
    const { wrapper } = await mountRailWithThree();
    const write = vi.spyOn(storagePort, 'setCategories');
    const transfer = await dragRow(wrapper, 1);

    // 行 1 的两道自己的缝：20（它上面）与 50（它下面）都该算成"没动"
    for (const clientY of [20, 50]) {
      await wrapper.find('ul').trigger('drop', { dataTransfer: transfer, clientY });
      await flushPromises();
    }

    expect(write).not.toHaveBeenCalled();
    expect((await createStoragePort().listCategories()).map((category) => category.name)).toEqual([
      '一',
      '二',
      '三',
    ]);

    // 正向对照： spy 装在同一处，但一次**真有结果**的拖拽必须写库 ——
    // 否则上面的 not.toHaveBeenCalled 可能只是"spy 挂错了对象"。
    await wrapper.find('ul').trigger('drop', { dataTransfer: await dragRow(wrapper, 0), clientY: 50 });
    await flushPromises();
    expect(write, '真拖了一下也没写库：spy 挂错了地方，前面那条断言是假的').toHaveBeenCalled();
  });

  it('排序落点里没有分类载荷时不写库（外部拖文件进来只是经过）', async () => {
    const { wrapper } = await mountRailWithThree();
    const write = vi.spyOn(storagePort, 'setCategories');
    const foreign = makeTransfer();
    foreign.setData('text/plain', '一段选中的文字');

    await wrapper.find('ul').trigger('drop', { dataTransfer: foreign, clientY: 50 });
    await flushPromises();
    expect(write).not.toHaveBeenCalled();
  });

  it('查找中分类行不可拖；↑↓ 也早就收起来了', async () => {
    const { wrapper } = await mountRailWithThree();
    expect(wrapper.findAll('[data-cat-row] div[draggable="true"]')).toHaveLength(3);

    await wrapper.find('input[type="search"]').setValue('二');
    await flushPromises();

    const rows = wrapper.findAll('[data-cat-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.find('div').attributes('draggable')).not.toBe('true');
  });

  /**
   * 左栏的系统行从两行变三行（加了回收站入口），判据也一起变宽而不是变松：
   * **每一行**都要既拖不起来、也不是排序落点。回收站那一行尤其要管 ——
   * "把某个分类拖进回收站"没有意义，而它只要带 draggable 就会被当成落点候选。
   */
  it('系统两行（All sessions / Uncategorized）既不能被拖起，也不是排序落点；回收站入口已不在分类列表里', async () => {
    const { wrapper } = await mountRailWithThree();
    const systemRows = wrapper.findAll('button.tn-item');
    /**
     * 3 → 2 是 既有约定 的位置变更，不是"少了一行"这种回归：
     * 回收站入口原来混在分类列表末尾，被读成"回收站是一个分类"，
     * 现在挪到左栏底部、主题与设置的**上面**（挂在 `entrypoints/app/App.vue` 的 footer 里，
     * 所以这颗组件里根本不该再出现它 —— 下面那句否定断言钉的就是这件事）。
     */
    expect(systemRows).toHaveLength(2);
    expect(wrapper.find('[data-testid="rail-trash"]').exists()).toBe(false);
    for (const row of systemRows) {
      expect(row.attributes('draggable')).toBeUndefined();
      // 落点属性也只许挂在分类行上：系统行身上不许出现 [data-cat-row]
      expect(row.attributes('data-cat-row')).toBeUndefined();
    }

    // 逐个当落点试一遍：它们都不在 <ul> 里，没有排序语义，应该一声不响
    for (let at = 0; at < systemRows.length; at += 1) {
      const transfer = await dragRow(wrapper, 0);
      await systemRows[at]?.trigger('drop', { dataTransfer: transfer, clientY: 0 });
      await flushPromises();
      expect((await createStoragePort().listCategories()).map((category) => category.name)).toEqual([
        '一',
        '二',
        '三',
      ]);
    }
  });

  it('会话拖放只做归类，不会顺手把分类排个序', async () => {
    const { store, wrapper } = await mountRailWithThree();
    await seed(group('g1', '会话一', 1));
    await store.reload();
    await flushPromises();

    const transfer = makeTransfer();
    transfer.setData(GROUP_MIME, encode({ groupId: 'g1' }));
    const row = wrapper.findAll('[data-cat-row]')[1];
    await row?.find('div').trigger('drop', { dataTransfer: transfer, clientY: 50 });
    await flushPromises();

    const stored = await createStoragePort().listCategories();
    expect(stored.map((category) => category.name)).toEqual(['一', '二', '三']);
    expect((await createStoragePort().getGroup('g1'))?.categoryId).toBe(stored[1]?.id);
  });
});

// ---------------------------------------------------------------------------
// TabRow
// ---------------------------------------------------------------------------

describe('TabRow', () => {
  it('网页条目渲染成真正的 <a href>，右键才是浏览器那套链接菜单（图二）', () => {
    const wrapper = mount(TabRow, { props: { tab: tab('g1', 0) } });
    const link = wrapper.find('a');

    expect(link.exists(), '标题不是 <a>，右键只能拿到页面级菜单').toBe(true);
    expect(link.attributes('href')).toBe('https://flutter.dev/page-0');
    // 内部页做成链接是在承诺一个浏览器不允许的菜单，所以它仍然是 button
  });

  it('内部页不给 <a>；左键两种情况都走我们的恢复', async () => {
    const internal = mount(TabRow, {
      props: { tab: tab('g1', 0, { url: 'chrome://settings', restorable: false }) },
    });
    expect(internal.find('a').exists()).toBe(false);

    const wrapper = mount(TabRow, { props: { tab: tab('g1', 0) } });
    await wrapper.find('a').trigger('click');
    expect(wrapper.emitted('restore')).toHaveLength(1);
  });

  /**
   * 既有约定 决定 7：首屏几百行 = 几百次图片请求，屏外那些不该发 ⇒ `loading="lazy"`。
   *
   * ⚠ 懒加载**不改变失败语义**，这句不能只写在注释里：取不到图照样走 `@error` 退回首字母，
   *   所以下面那条把 `error` 触发出来核的是"仍然看得见字母"。
   */
  it('favicon 走懒加载，且失败时照样退回首字母', async () => {
    const wrapper = mount(TabRow, { props: { tab: tab('g1', 0, { faviconUrl: 'https://flutter.dev/favicon.ico' }) } });
    const img = wrapper.find('img');

    expect(img.exists(), '有 faviconUrl 就该渲染那颗图标').toBe(true);
    expect(img.attributes('loading'), '屏外的图片不许发请求').toBe('lazy');

    await img.trigger('error');
    expect(wrapper.find('img').exists(), '取不到图就退回字母，不能留一个破图洞').toBe(false);
    expect(wrapper.text()).toContain('F');
  });

  it('渲染标题与域名，不把整条 URL 摊在行里', () => {
    const wrapper = mount(TabRow, { props: { tab: tab('g1', 0) } });
    expect(wrapper.text()).toContain('Flutter 文档 0');
    expect(wrapper.text()).toContain('flutter.dev');
    expect(wrapper.text()).not.toContain('https://flutter.dev/page-0');
  });

  it('不可恢复的记录给原因，而不是一个点下去没反应的按钮', () => {
    const wrapper = mount(TabRow, { props: { tab: tab('g1', 1, { restorable: false }) } });
    expect(wrapper.text()).toContain('Cannot be restored');
    expect(wrapper.findAll('button').filter((node) => node.text() === 'Restore')).toHaveLength(0);
  });

  it('点标题与点"Restore"都发 restore；复制发 copy；× 发 remove', async () => {
    const wrapper = mount(TabRow, { props: { tab: tab('g1', 0) } });

    // 第一个 button 就是标题（favicon 那个是 div）
    await wrapper.findAll('button')[0]?.trigger('click');
    expect(wrapper.emitted('restore')).toHaveLength(1);

    await byText(wrapper, 'Restore')[0]?.trigger('click');
    expect(wrapper.emitted('restore')).toHaveLength(2);

    await iconButton(wrapper, 'Copy link').trigger('click');
    expect(wrapper.emitted('copy')).toHaveLength(1);

    await iconButton(wrapper, 'Delete').trigger('click');
    expect(wrapper.emitted('remove')).toHaveLength(1);
  });

  it('锁定行不给 ×', () => {
    const wrapper = mount(TabRow, { props: { tab: tab('g1', 0), locked: true } });
    expect(iconButton(wrapper, 'Delete').exists()).toBe(false);
    expect(iconButton(wrapper, 'Copy link').exists()).toBe(true);
  });

  it('收纳时没关掉的条目标注"Left open"', () => {
    const wrapper = mount(TabRow, { props: { tab: tab('g1', 0, { closeState: 'kept' }) } });
    expect(wrapper.text()).toContain('Left open');
  });

  it('favicon 加载失败退回首字母占位，不留破图', async () => {
    const wrapper = mount(TabRow, {
      props: { tab: tab('g1', 0, { faviconUrl: 'https://flutter.dev/favicon.ico' }) },
    });
    expect(wrapper.find('img').exists()).toBe(true);
    await wrapper.find('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('F');
  });
});

/** 取**最后一次**该 kind 的命令：同一个测试里连点两个按钮时，第一条是上一个动作的。 */
function sentCommand(kind: string) {
  const call = [...sendMessage.mock.calls]
    .reverse()
    .map((entry) => (entry[0] as { command?: { kind: string } }).command)
    .filter(Boolean)
    .find((command) => command?.kind === kind);
  return call as { kind: string; windowId: number; mode?: string };
}
