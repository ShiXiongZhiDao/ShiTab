/**
 * 工作台（entrypoints/app）的整页接线测试 —— V1.2 的"左分类 / 右全部会话"布局。
 *
 * 这里只验**接线与形状**：一次挂载就列出所有会话、分类点了真能筛、滚到底真的追加、
 * 按钮点了真的发消息且带上对的 windowId 与 mode、真文案渲染出来了。
 * 布局好不好看在 jsdom 里量不出来（视口是 0×0），那部分归 既有约定。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import Workbench from '@/entrypoints/app/App.vue';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { storagePort } from '@/shared/services';
import { useGroups, RENDER_BATCH } from '@/composables/useGroups';
import { CAPTURE_NOTICE_MESSAGE } from '@/shared/messages';
import { SYNC_PING_MESSAGE } from '@/shared/sync-heartbeat';
import {
  COLLAPSED_TAB_LIMIT,
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_VIEWPORT_RATIO,
  STORAGE_KEYS,
} from '@/shared/constants';
import type { CaptureResult, RestoreResult, SyncMeta, TabGroup } from '@/shared/types';

const AT = 1_700_000_000_000;
const WINDOW_ID = 7;

/** 每张卡的标题。tab 标题按会话 id 区分，才能逐张核对"这张卡展开的是自己的条目"。 */
const TITLE: Record<string, string> = { g1: 'Flutter 开发', g2: '摇茶 App', g3: '第 3 个' };

function group(id: string, title: string, count = 2, over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    title,
    createdAt: AT,
    updatedAt: AT,
    isPinned: false,
    locked: false,
    sortOrder: 0,
    tabs: Array.from({ length: count }, (_, index) => ({
      id: `${id}-t${index}`,
      groupId: id,
      url: `https://example.test/${id}/${index}`,
      title: `页面 ${id}-${index}`,
      createdAt: AT,
      sortOrder: index,
      originalIndex: index,
      originalPinned: false,
      wasActive: index === 0,
      closeState: 'closed' as const,
      restorable: index !== 1,
    })),
    ...over,
  };
}

const captureResult: CaptureResult = {
  operationId: 'op-1',
  groupId: 'g-new',
  groupTitle: '2026-10-04 01:42 · 3 tabs',
  saved: 3,
  closed: 3,
  kept: 0,
  failed: 0,
  pinnedSkipped: 0,
  nonRestorableSaved: 0,
  savedTabs: [],
  closableTabIds: [1, 2, 3],
  activeTabUrl: 'https://example.test/x',
  hasLanding: true,
};

const restoreResult: RestoreResult = {
  operationId: 'op-2',
  windowId: WINDOW_ID,
  mode: 'current',
  restored: 3,
  skipped: 0,
  failed: 0,
  failedUrls: [],
  skippedUrls: [],
};

/** 图标收纳成功后 background 广播的那条通知（键名从实现里取，避免测试与代码各写一份字符串）。 */
const NOTICE = {
  __shitab: CAPTURE_NOTICE_MESSAGE,
  windowId: WINDOW_ID,
  result: captureResult,
};

/**
 * 把 background 发的通知"送进"页面。
 *
 * fakeBrowser 的事件是它自己的 `trigger(...)`，且按平台的 listener 签名要满三个参数
 * （message / sender / sendResponse）—— 只传 message 会编译不过。
 */
async function deliverNotice(notice: Record<string, unknown>): Promise<void> {
  await (
    fakeBrowser.runtime.onMessage as unknown as {
      trigger: (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => Promise<unknown>;
    }
  ).trigger(notice, {}, () => undefined);
}

const sendMessage = vi.fn();

async function seed(...groups: TabGroup[]): Promise<void> {
  const storage = createStoragePort();
  for (const item of groups) await storage.putGroup(item);
}

async function mountWorkbench() {
  const wrapper = mount(Workbench, {
    global: { plugins: [createPinia()] },
    attachTo: document.body,
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

function commandSent(kind: string) {
  return sendMessage.mock.calls
    .map((call) => (call[0] as { command?: { kind: string } }).command)
    .filter(Boolean)
    .find((command) => command?.kind === kind);
}

function commandsOf(kind: string) {
  return sendMessage.mock.calls
    .map((call) => (call[0] as { command?: { kind: string } }).command)
    .filter((command) => command?.kind === kind);
}

function buttonWithText(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((node) => node.text().includes(text));
}

afterEach(() => {
  // 断言失败中途退出的用例走不到 wrapper.unmount()，节点一直挂在 document.body 上，
  // 会干扰下一个用例的 DOM 查询（这一轮踩过一次）。
  document.body.innerHTML = '';
});

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  sendMessage.mockReset();
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(sendMessage as never);
  // UI 解析"本页面所在窗口"要走 windows.getCurrent，fakeBrowser 默认给 undefined
  vi.spyOn(fakeBrowser.windows, 'getCurrent').mockResolvedValue({ id: WINDOW_ID } as never);

  sendMessage.mockImplementation((envelope: { command: { kind: string } }) => {
    const value =
      envelope.command.kind === 'undoCapture' || envelope.command.kind === 'restoreGroup'
        ? restoreResult
        : envelope.command.kind === 'ensureEntryTab'
          ? true
          : { ok: true };
    return Promise.resolve({ ok: true, value });
  });
});

describe('工作台', () => {
  it('没有数据时显示空状态文案', async () => {
    const wrapper = await mountWorkbench();
    expect(wrapper.text()).toContain('Nothing stashed yet');
    wrapper.unmount();
  });

  it('右栏一次列出所有会话，且**每个**会话都展开自己的条目', async () => {
    await seed(group('g1', 'Flutter 开发'), group('g2', '摇茶 App'), group('g3', '第 3 个'));
    const wrapper = await mountWorkbench();

    const cards = wrapper.findAll('[data-group-card]');
    expect(cards).toHaveLength(3);
    // 逐张核对，不写"整页里出现过某条 tab"那种断言：
    // 真机上踩到的正是"三张卡只有一张展开了内容，另外两张永远停在省略号"，
    // 而那种整页级断言一张展开就能过。
    for (const [id, title] of Object.entries(TITLE)) {
      const card = cards.find((node) => node.text().includes(title));
      expect(card, `找不到 ${title} 这张卡`).toBeDefined();
      expect(card?.text()).toContain(`页面 ${id}-0`);
      expect(card?.text()).toContain(`页面 ${id}-1`);
      expect(card?.text()).not.toContain('…');
    }
    wrapper.unmount();
  });

  it('新收纳的会话排在最前（列表是最新在前，既有约定）', async () => {
    await seed(group('g0', '最早', 1, { sortOrder: 0 }), group('g1', '中间', 1, { sortOrder: 1 }), group('g2', '最新', 1, { sortOrder: 2 }));
    const wrapper = await mountWorkbench();

    const titles = wrapper.findAll('[data-group-card]').map((node) => node.text());
    expect(titles[0]).toContain('最新');
    expect(titles[1]).toContain('中间');
    expect(titles[2]).toContain('最早');
    wrapper.unmount();
  });

  it('reload 与区块回源并发时，不会把已加载的条目冲掉（真机省略号那次的根因）', async () => {
    setActivePinia(createPinia());
    await seed(group('g1', 'Flutter 开发'), group('g2', '摇茶 App'), group('g3', '第 3 个'));
    const store = useGroups();
    await store.init();

    // 三个区块同时挂载回源，中间插一次 reload（收纳/跨组移动都会这样）
    await Promise.all([
      store.loadTabs('g1'),
      store.loadTabs('g2'),
      store.loadTabs('g3'),
      store.reload(),
    ]);

    for (const id of ['g1', 'g2', 'g3']) {
      expect(store.tabsOf(id), `${id} 的内容被并发写冲掉了，界面会永远停在省略号`).toBeDefined();
    }
    store.dispose();
  });

  it('会话区块不裁自己的 ⋯ 菜单，且菜单点别处能关掉', async () => {
    await seed(group('g1', 'Flutter 开发', 1));
    const wrapper = await mountWorkbench();

    const card = wrapper.find('[data-group-card]');
    // overflow-hidden 会把下拉切成两行（真机第一轮反馈）
    expect(card.classes()).not.toContain('overflow-hidden');

    const trigger = card.find('button[aria-label="More actions"]');
    expect(trigger.attributes('aria-expanded'), '菜单平时应是关的').toBe('false');
    await trigger.trigger('click');
    expect(card.find('ul[role="menu"]').exists(), '点开后菜单没出现').toBe(true);
    expect(card.find('ul[role="menu"]').classes().join(' ')).toContain('overflow-y-auto');

    // 点页面别处：原生 details 不会自己关，所以这里必须有外部监听。
    // jsdom 没有 PointerEvent 这个构造器，用 Event 发同名事件即可（处理器只读 target）。
    document.body.dispatchEvent(new Event('pointerdown'));
    await flushPromises();
    expect(card.find('ul[role="menu"]').exists(), '点别处之后菜单还挂着').toBe(false);
    wrapper.unmount();
  });

  it('左栏是分类：系统两行常驻，会话上的分类 chip 跟着数据走', async () => {
    const storage = createStoragePort();
    await storage.setCategories([
      { id: 'c1', name: '阅读', sortOrder: 0, createdAt: AT, updatedAt: AT },
    ]);
    await seed(group('g1', 'Flutter 开发', 1, { categoryId: 'c1' }), group('g2', '摇茶 App', 1));
    const wrapper = await mountWorkbench();

    // 「分类」那行字已经让给查找框了：头部现在是「查找 + 新建」
    expect(wrapper.find('aside input[type="search"]').attributes('placeholder')).toBe(
      'Find a category',
    );
    expect(wrapper.text()).toContain('All sessions');
    expect(wrapper.text()).toContain('Uncategorized');
    expect(wrapper.findAll('[data-group-card=""]')[0]?.text()).toContain('阅读');
    wrapper.unmount();
  });

  it('点分类只筛右栏，左栏不动', async () => {
    const storage = createStoragePort();
    await storage.setCategories([
      { id: 'c1', name: '阅读', sortOrder: 0, createdAt: AT, updatedAt: AT },
    ]);
    await seed(group('g1', 'Flutter 开发', 1, { categoryId: 'c1' }), group('g2', '摇茶 App', 1));
    const wrapper = await mountWorkbench();

    await buttonWithText(wrapper, '阅读')?.trigger('click');
    await flushPromises();

    const cards = wrapper.findAll('[data-group-card]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text()).toContain('Flutter 开发');
    // 计数从 2 变 1，说明"筛"发生在渲染层而不是数据层
    expect(wrapper.text()).toContain('1');
    wrapper.unmount();
  });

  it('超过一批只渲染 RENDER_BATCH 个，点"加载更多"才追加', async () => {
    const many = Array.from({ length: RENDER_BATCH + 5 }, (_, index) =>
      group(`g${index}`, `会话 ${index}`, 1),
    );
    await seed(...many);
    const wrapper = await mountWorkbench();

    expect(wrapper.findAll('[data-group-card]')).toHaveLength(RENDER_BATCH);
    expect(wrapper.text()).toContain(`Load 5 more sessions`);

    await buttonWithText(wrapper, 'Load 5 more sessions')?.trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[data-group-card]')).toHaveLength(RENDER_BATCH + 5);
    expect(buttonWithText(wrapper, 'Load 5 more sessions')).toBeUndefined();
    wrapper.unmount();
  });

  it('勾选多个会话后批量条出现，逐个发 restoreGroup', async () => {
    await seed(group('g1', '会话一', 1), group('g2', '会话二', 1));
    const wrapper = await mountWorkbench();

    // 行首框要点自己那颗：既有约定 之后每张卡里还有记录级的框，
    // 拿 `findAll('input[type=checkbox]')[0] / [1]` 会一颗是行首、一颗是它里面那条（一点一撤）。
    await wrapper.find('[data-testid="group-check-g1"]').setValue(true);
    await wrapper.find('[data-testid="group-check-g2"]').setValue(true);
    await flushPromises();

    expect(wrapper.text()).toContain('Restore selected');
    await buttonWithText(wrapper, 'Restore selected')?.trigger('click');
    await flushPromises();

    expect(commandsOf('restoreGroup')).toHaveLength(2);
    expect(commandSent('restoreGroup')).toMatchObject({ windowId: WINDOW_ID, mode: 'current' });
    wrapper.unmount();
  });

  it('多选删除：锁定的跳过并说出来，其余真删', async () => {
    setActivePinia(createPinia());
    await seed(
      group('g1', '会话一', 1),
      group('g2', '锁着的', 1, { locked: true }),
      group('g3', '会话三', 1),
    );
    const store = useGroups();
    await store.init();
    // 既有约定：勾选只剩记录级一份，"整行"由全覆盖派生 ⇒ 全选走 `selectAllVisible`
    await store.selectAllVisible();

    await store.removeChecked();

    const left = (await createStoragePort().listGroupIndex()).map((entry) => entry.id);
    expect(left.sort()).toEqual(['g2']);
    expect(store.checkedCount, '删完该清空勾选').toBe(0);
    expect(store.toast).toMatchObject({
      kind: 'message',
      key: 'bulk_delete_done_skipped',
      subs: { groups: 2, records: 0, skipped: 1 },
    });
    store.dispose();
  });

  it('选择栏里的"删除所选"是两步确认，第一下不删', async () => {
    await seed(group('g1', '会话一', 1), group('g2', '会话二', 1));
    const wrapper = await mountWorkbench();

    const boxes = wrapper.findAll('input[type="checkbox"]');
    await boxes[0]?.setValue(true);
    await flushPromises();

    await buttonWithText(wrapper, 'Delete selected')?.trigger('click');
    expect(await createStoragePort().getGroup('g1'), '第一下就删了').toBeDefined();
    expect(wrapper.text()).toContain('Delete 1 selected sessions');

    await buttonWithText(wrapper, 'Delete')?.trigger('click');
    await flushPromises();
    expect(await createStoragePort().getGroup('g1')).toBeUndefined();
    wrapper.unmount();
  });

  it('页面上没有收纳入口了：唯一入口是工具栏图标', async () => {
    const wrapper = await mountWorkbench();
    expect(buttonWithText(wrapper, 'Stash current window')).toBeUndefined();
    expect(wrapper.text()).not.toContain('Stash current window');
    // 主题与设置也不在顶栏，而在左栏底部
    expect(wrapper.find('aside footer button[aria-label="Settings"]').exists()).toBe(true);
    expect(wrapper.find('aside footer button[aria-label="Toggle theme"]').exists()).toBe(true);
    // 导入/导出只在设置页的数据区，工作台不重复一份
    expect(buttonWithText(wrapper, 'Import')).toBeUndefined();
    expect(buttonWithText(wrapper, 'Export')).toBeUndefined();
    expect(buttonWithText(wrapper, 'New session')).toBeUndefined();
    wrapper.unmount();
  });

  it('图标收纳的通知到达时显示撤销条，点撤销真的发 undoCapture（带本窗口 id）', async () => {
    const wrapper = await mountWorkbench();

    // 页面是"init -> 解析本窗口 id -> 才订阅通知"，所以要轮询到订阅生效为止，
    // 不能假定 mountWorkbench 返回时监听已经挂上。
    await vi.waitFor(async () => {
      await deliverNotice(NOTICE);
      await flushPromises();
      expect(wrapper.text()).toContain('Saved 3 · closed 3 · kept 0');
    });

    const undo = wrapper.findAll('button').find((node) => node.text() === 'Undo');
    expect(undo, '结果条里没有撤销按钮').toBeDefined();
    await undo?.trigger('click');
    await flushPromises();
    expect(commandSent('undoCapture')).toMatchObject({ kind: 'undoCapture', windowId: WINDOW_ID });
    wrapper.unmount();
  });

  it('别的窗口发生的收纳不在本窗口弹撤销条（通知按 windowId 过滤）', async () => {
    const wrapper = await mountWorkbench();
    await vi.waitFor(async () => {
      await flushPromises();
      expect(commandSent('ensureEntryTab'), '页面还没订阅完就先测别的窗口通知').toBeDefined();
    });

    await deliverNotice({ ...NOTICE, windowId: WINDOW_ID + 1 });
    await flushPromises();

    expect(wrapper.text()).not.toContain('Saved 3 · closed 3 · kept 0');
    expect(wrapper.findAll('button').some((node) => node.text() === 'Undo')).toBe(false);
    wrapper.unmount();
  });

  it('一条都没关掉时撤销条不给撤销按钮（没东西可撤）', async () => {
    const wrapper = await mountWorkbench();
    await vi.waitFor(async () => {
      await deliverNotice({ ...NOTICE, result: { ...captureResult, closed: 0, kept: 3 } });
      await flushPromises();
      expect(wrapper.text()).toContain('Saved 3 · closed 0 · kept 3');
    });
    expect(wrapper.findAll('button').some((node) => node.text() === 'Undo')).toBe(false);
    wrapper.unmount();
  });

  it('挂载时补一次入口页自修复（设计包 A §13）', async () => {
    const wrapper = await mountWorkbench();
    expect(commandSent('ensureEntryTab')).toMatchObject({
      kind: 'ensureEntryTab',
      windowId: WINDOW_ID,
    });
    wrapper.unmount();
  });

  it('搜索把右栏收成命中项，并写明搜的是什么', async () => {
    await seed(group('g1', 'Flutter 开发', 2), group('g2', '摇茶 App', 2));
    const wrapper = await mountWorkbench();

    // 限定 main：左栏的分类查找框也是 input[type=search]，DOM 里它排在前面
    await wrapper.find('main input[type="search"]').setValue('Flutter');
    // 防抖 150ms + 异步搜索，轮询而不是拍一个固定的 sleep
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.findAll('[data-group-card]')).toHaveLength(1);
    });

    expect(wrapper.text()).toContain('Flutter 开发');
    expect(wrapper.text()).not.toContain('摇茶 App');
    expect(wrapper.text()).toContain('Results');
    wrapper.unmount();
  });

  it('搜索无命中时给出带关键词的提示，而不是空列表', async () => {
    await seed(group('g1', 'Flutter 开发', 1));
    const wrapper = await mountWorkbench();

    // 同上：必须限定在右栏，否则敲进的是左栏的分类查找框
    await wrapper.find('main input[type="search"]').setValue('不存在的词');
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.text()).toContain('Nothing matches');
    });
    expect(wrapper.text()).toContain('不存在的词');
    wrapper.unmount();
  });

  it('锁定的会话在右栏带 Locked 标记（数据从 index 一路传到行）', async () => {
    await seed(group('g1', '锁着的会话', 1, { locked: true }));
    const wrapper = await mountWorkbench();

    expect(wrapper.findAll('[data-group-card]')[0]?.text()).toContain('Locked');
    wrapper.unmount();
  });

  it('命令失败时把原因原样贴在列表上方（不静默吞掉）', async () => {
    const storage = createStoragePort();
    await storage.setCategories([
      { id: 'c1', name: '工作', sortOrder: 0, createdAt: AT, updatedAt: AT },
    ]);
    const wrapper = await mountWorkbench();

    // 那个 + 里只有 SVG，没有文字，只能按 aria-label 找
    await wrapper.find('button[aria-label="New category"]').trigger('click');
    const input = wrapper.find('input[type="text"]');
    expect(input.exists(), '没出现新建分类的输入框').toBe(true);
    await input.setValue('工作');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect(wrapper.text()).toContain('已经有同名分类');
    wrapper.unmount();
  });

  it('切分类会把分批游标复位，避免"筛完只剩 15 个却按 30 个渲染"', async () => {
    const storage = createStoragePort();
    await storage.setCategories([
      { id: 'c1', name: '阅读', sortOrder: 0, createdAt: AT, updatedAt: AT },
    ]);
    const many = Array.from({ length: 30 }, (_, index) =>
      group(`g${index}`, `会话 ${index}`, 1, {
        categoryId: index % 2 === 0 ? 'c1' : undefined,
      }),
    );
    const inCategory = many.filter((_, index) => index % 2 === 0).length; // 15
    await seed(...many);
    const wrapper = await mountWorkbench();
    const store = useGroups();

    expect(store.visible).toHaveLength(30);
    store.requestMore();
    expect(store.shownCount).toBe(30); // 封顶在可见总数，不无界增长

    await buttonWithText(wrapper, '阅读')?.trigger('click');
    expect(store.shownCount).toBe(RENDER_BATCH);
    expect(wrapper.findAll('[data-group-card]')).toHaveLength(inCategory);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------------
// 侧栏可伸缩宽度
// ---------------------------------------------------------------------------

describe('侧栏宽度', () => {
  /** 拖到哪都按这个窗口量：1200px 宽 => 上限是静态的 420，而不是 40% 那道闸。 */
  function setViewport(width: number): void {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: width,
    });
  }

  const asideWidth = (wrapper: ReturnType<typeof mount>): number | undefined => {
    const style = wrapper.find('aside').attributes('style') ?? '';
    const match = /width:\s*(\d+)px/.exec(style);
    return match ? Number(match[1]) : undefined;
  };

  const divider = (wrapper: ReturnType<typeof mount>) => wrapper.find('[role="separator"]');

  async function rawUi(): Promise<unknown> {
    const dump = (await fakeBrowser.storage.local.get(STORAGE_KEYS.ui)) as Record<string, unknown>;
    return dump[STORAGE_KEYS.ui];
  }

  let previousWidth = 1024;

  beforeEach(() => {
    previousWidth = window.innerWidth;
    setViewport(1200);
  });

  afterEach(() => {
    setViewport(previousWidth);
  });

  it('默认 248px，和可拖之前那个写死的宽度一模一样', async () => {
    const wrapper = await mountWorkbench();
    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_DEFAULT);
    expect(divider(wrapper).attributes('aria-valuenow')).toBe(String(RAIL_WIDTH_DEFAULT));
    wrapper.unmount();
  });

  it('读回来的宽度会被夹进范围：库里写着 99999，界面最多给 420', async () => {
    await createStoragePort().setUiPrefs({ railWidth: 99_999 });
    const wrapper = await mountWorkbench();
    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_MAX);
    wrapper.unmount();
  });

  it('库里是非数字（手改过的）时退回默认值而不是 NaNpx', async () => {
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.ui]: { railWidth: 'wide' } });
    const wrapper = await mountWorkbench();
    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_DEFAULT);
    wrapper.unmount();
  });

  it('窄窗口里上限换成 40%：存着 420、窗口 700px，显示 280', async () => {
    setViewport(700);
    await createStoragePort().setUiPrefs({ railWidth: RAIL_WIDTH_MAX });
    const wrapper = await mountWorkbench();
    expect(asideWidth(wrapper)).toBe(280);
    expect(divider(wrapper).attributes('aria-valuemax')).toBe('280');
    wrapper.unmount();
  });

  /**
   * 这条是"影不影响性能"那个问题的答案本身，所以要钉死：
   * 拖拽过程中 aside 的宽度**一直不变**，动的只是一根 fixed 的幽灵线；
   * 松手那一刻才落宽。少了这条约束，每帧 pointermove 都会把右栏上千个节点重新布局一遍。
   */
  it('拖拽中只画幽灵线，aside 宽度要等松手才变', async () => {
    const wrapper = await mountWorkbench();
    const before = asideWidth(wrapper);

    await divider(wrapper).trigger('pointerdown', { clientX: RAIL_WIDTH_DEFAULT, button: 0 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 360 }));
    await flushPromises();

    const ghost = wrapper.find('.tn-rail-ghost');
    expect(ghost.exists(), '拖拽中没有幽灵线').toBe(true);
    expect(ghost.attributes('style') ?? '').toContain('left: 360px');
    expect(ghost.text()).toBe('360px');
    expect(asideWidth(wrapper), '拖拽中就改了 aside 宽度（会连带重排右栏）').toBe(before);

    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 360 }));
    await flushPromises();

    expect(wrapper.find('.tn-rail-ghost').exists(), '松手之后线还挂着').toBe(false);
    expect(asideWidth(wrapper)).toBe(360);
    expect(await rawUi()).toEqual({ railWidth: 360 });
    wrapper.unmount();
  });

  it('指针跑到屏幕外或窗口左沿：落宽时夹在 [200, 420]', async () => {
    const wrapper = await mountWorkbench();

    await divider(wrapper).trigger('pointerdown', { clientX: 300, button: 0 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 9_999 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 9_999 }));
    await flushPromises();
    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_MAX);

    await divider(wrapper).trigger('pointerdown', { clientX: 400, button: 0 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: -500 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: -500 }));
    await flushPromises();
    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_MIN);
    wrapper.unmount();
  });

  it('原地按下再松手：宽度没变就不写库（一次空拖拽不该惊动其他窗口）', async () => {
    const write = vi.spyOn(storagePort, 'setUiPrefs');
    const wrapper = await mountWorkbench();
    write.mockClear();

    await divider(wrapper).trigger('pointerdown', { clientX: RAIL_WIDTH_DEFAULT, button: 0 });
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: RAIL_WIDTH_DEFAULT }));
    await flushPromises();

    expect(write).not.toHaveBeenCalled();

    // 正向对照：同一个 spy，拖出结果时必须写一次，否则上面那条"没调用"可能只是 spy 没挂上
    await divider(wrapper).trigger('pointerdown', { clientX: 300, button: 0 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 316 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 316 }));
    await flushPromises();

    expect(write, '真拖了也没写库：spy 挂错了地方').toHaveBeenCalledTimes(1);
    expect(await rawUi()).toEqual({ railWidth: 316 });
    wrapper.unmount();
  });

  it('双击分隔条 = 回到默认宽度，并把它存下来', async () => {
    await createStoragePort().setUiPrefs({ railWidth: 400 });
    const wrapper = await mountWorkbench();
    expect(asideWidth(wrapper)).toBe(400);

    await divider(wrapper).trigger('dblclick');
    await flushPromises();

    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_DEFAULT);
    expect(await rawUi()).toEqual({ railWidth: RAIL_WIDTH_DEFAULT });
    wrapper.unmount();
  });

  it('键盘也能调：← → 各 16px，Home 复位', async () => {
    const wrapper = await mountWorkbench();

    await divider(wrapper).trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_DEFAULT + 16);

    await divider(wrapper).trigger('keydown', { key: 'ArrowLeft' });
    await divider(wrapper).trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_DEFAULT - 16);

    await divider(wrapper).trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(asideWidth(wrapper)).toBe(RAIL_WIDTH_DEFAULT);
    wrapper.unmount();
  });

  it('另一个窗口改了宽度，这边跟着变；正在拖的时候不被打断', async () => {
    const wrapper = await mountWorkbench();

    await storagePort.setUiPrefs({ railWidth: 300 });
    await flushPromises();
    await flushPromises();
    expect(asideWidth(wrapper)).toBe(300);

    // 拖拽中：预览线归这只手所有，别的窗口写多少都不改本窗口的布局
    await divider(wrapper).trigger('pointerdown', { clientX: 300, button: 0 });
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 340 }));
    await storagePort.setUiPrefs({ railWidth: 420 });
    await flushPromises();
    await flushPromises();
    expect(wrapper.find('.tn-rail-ghost').attributes('style') ?? '').toContain('left: 340px');
    expect(asideWidth(wrapper), '拖拽中被别的窗口把布局拽走了').toBe(300);

    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 340 }));
    await flushPromises();
    expect(asideWidth(wrapper)).toBe(340);
    wrapper.unmount();
  });

  it('宽度只活在本机：不进备份载荷，也不碰 Settings 那个键', async () => {
    await createStoragePort().setUiPrefs({ railWidth: 320 });
    const snapshot = await createStoragePort().snapshotAll();

    expect(Object.keys(snapshot).sort()).toEqual(['categories', 'groups', 'meta', 'settings']);
    expect(JSON.stringify(snapshot)).not.toContain('railWidth');
    expect((await createStoragePort().getSettings()).theme).toBe('system');
    expect(await rawUi()).toEqual({ railWidth: 320 });
  });

  /**
   * JS 夹取用常量，CSS 那道闸写的是字面量（`vw` 单位没法从 TS 传进 class 名）。
   * 两边漂移的后果很具体：JS 允许 420 而 CSS 只放到 40vw，用户会觉得"拖到 380 就拖不动了"
   * 却没有理由。所以这里按**源码**核对一次，两个数必须同源。
   */
  it('CSS 那道闸与常量同源：max-w 里的两个数就是 RAIL_WIDTH_MAX 与 40%', () => {
    const source = readFileSync(join(process.cwd(), 'entrypoints', 'app', 'App.vue'), 'utf8');
    const match = /max-w-\[min\((\d+)px,\s*(\d+)vw\)\]/.exec(source);
    expect(match, 'App.vue 里找不到 aside 的 max-w 那道闸').not.toBeNull();
    expect(Number(match?.[1])).toBe(RAIL_WIDTH_MAX);
    expect(Number(match?.[2])).toBe(RAIL_WIDTH_VIEWPORT_RATIO * 100);
  });
});

/**
 * 左栏入口 → 右栏内容 的接线（任务 #10）。
 *
 * 这一层以前是空的：回收站面板、冲突面板各自有组件测试，模型层也有判据，
 * 但"点了左栏那一行，右栏真的换了吗"没有任何东西钉着 ——
 * 而它恰好是那种"组件都对、接起来不工作"的 bug 唯一能露出来的地方。
 */
describe('工作台 · 回收站视图的接线', () => {
  beforeEach(async () => {
    // 视图开关是模块级的共享 ref，不清就会跨用例泄漏（上一条留着 true，下一条全红）
    const { showTrash } = await import('@/shared/trash-view');
    showTrash.value = false;
  });

  it('点左栏「回收站」⇒ 右栏换成回收站面板，会话列表整段让位', async () => {
    await seed(group('g1', 'Flutter 开发', 2), group('g2', '摇茶 App', 1));
    const wrapper = await mountWorkbench();

    expect(wrapper.find('[data-testid="trash-view"]').exists()).toBe(false);
    expect(wrapper.find('section.tn-scroll').exists()).toBe(true);

    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="trash-view"]').exists()).toBe(true);
    // 标题行与会话列表都不该留着：留一个只会数错数的表头是噪音
    expect(wrapper.find('section.tn-scroll').exists()).toBe(false);
    wrapper.unmount();
  });

  it('再点一次左栏「回收站」⇒ 回到会话列表（那一行是开关，不是单向门）', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const wrapper = await mountWorkbench();

    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="trash-view"]').exists()).toBe(false);
    expect(wrapper.find('section.tn-scroll').exists()).toBe(true);
    wrapper.unmount();
  });

  /**
   * 开关与筛选是两个正交状态，所以选分类时必须显式把视图交还。
   * 少这一句的表现是"点了分类没反应"—— 筛选器已经变了，右栏还停在回收站。
   */
  it('回收站开着时点分类 ⇒ 视图交还会话列表，且筛选真的生效', async () => {
    const storage = createStoragePort();
    const created = await storage.setCategories([
      { id: 'cat1', name: '阅读', sortOrder: 1, createdAt: AT, updatedAt: AT },
    ]).then(async () => storage.listCategories());
    await seed(group('g1', 'Flutter 开发', 2, { categoryId: created[0]?.id }));
    const wrapper = await mountWorkbench();

    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="trash-view"]').exists()).toBe(true);

    const catRow = wrapper.findAll('li button').find((node) => node.text().includes('阅读'));
    await catRow?.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="trash-view"]').exists()).toBe(false);
    expect(wrapper.find('section.tn-scroll').exists()).toBe(true);
    expect(wrapper.text()).toContain('Flutter 开发');
    wrapper.unmount();
  });
});

describe('工作台 · 冲突面板真的挂在里面', () => {
  it('sync_meta 里有待裁决冲突时，工作台出现裁决入口', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const storage = createStoragePort();
    await storage.putGroup(group('g1', 'Flutter 开发', 2));
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({
      ...meta,
      status: 'conflict',
      pendingConflicts: [
        { groupId: 'g1', groupTitle: '会话 g1', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: 'other-device', deleteReason: 'user-delete' },
      ],
    });

    const wrapper = await mountWorkbench();
    await flushPromises();
    await flushPromises();

    expect(wrapper.find('[data-testid="conflict-section"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="conflict-row"]').exists()).toBe(true);
    // 标题用的是真文案而不是内部标识
    expect(wrapper.text()).toContain('CONFLICTS WAITING FOR YOU');
    expect(wrapper.text()).not.toContain('user-delete');
    wrapper.unmount();
  });

  it('没有冲突时整段不渲染（挂着一段"等你裁决"会让人以为同步坏了）', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const wrapper = await mountWorkbench();
    expect(wrapper.find('[data-testid="conflict-section"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

/**
 * 页面侧的节拍。真机反馈：「在 Edge 删了标签，Chrome 的 ShiTab 页面等了半天
 * 没同步过来，得两边都点一次立即同步」—— 判据会答"该拉了"，但 MV3 的 SW 睡着后没人来问。
 * 这条钉的是"打开工作台这件事本身会去问一次"，与 `test/background.spec.ts` 里
 * "问到之后真的判一次同步"合起来才是完整的一条链路。
 */
describe('打开工作台就敲一次同步心跳', () => {
  function pingsSent(): number {
    return sendMessage.mock.calls.filter(
      (call) => (call[0] as { __shitab?: string }).__shitab === SYNC_PING_MESSAGE,
    ).length;
  }

  it('挂载即敲一次（卸载后不再敲那条在 test/sync-heartbeat.spec.ts 用假时间钉）', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const wrapper = await mountWorkbench();

    expect(pingsSent(), '页面开着却没问过判据 ⇒ 等半天也不会拉').toBe(1);

    wrapper.unmount();
    await flushPromises();
    expect(pingsSent()).toBe(1);
  });
});

/**
 * 同步状态的顶栏 pill（既有约定 的 Q6b：工作台与设置页两处都显示）。
 *
 * 这一组钉的是三件容易各自跑掉的事：
 * 1. **异常必须显形**。同步是 background 跑的，用户看不到设置页就等于不知道坏了；
 * 2. **正常不许占位**（Q11c）：一切正常时顶栏多出一个元素，代价是列表少一行；
 * 3. **订阅真的接上了**：账本是页面挂载之后才被 background 改的，
 *    那时 pill 要当场出现，而不是等用户刷新页面 —— 这条是"只读一次"的实现最容易糊的地方。
 */
describe('工作台顶栏的同步状态', () => {
  const PILL = '[data-testid="workbench-sync-status"]';

  function stubOpenOptions() {
    const open = vi.fn();
    (fakeBrowser.runtime.openOptionsPage as unknown) = open;
    return open;
  }

  async function setMeta(patch: Partial<SyncMeta>): Promise<void> {
    const storage = createStoragePort();
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({ ...meta, ...patch });
    // watchSyncMeta 的回调要跑过一轮存储事件，flushPromises 两次是这个文件里的既有做法
    await flushPromises();
    await flushPromises();
  }

  it('一切正常时顶栏不出现这条（正常态不占位）', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    await setMeta({ status: 'idle', lastSyncAt: AT });
    const wrapper = await mountWorkbench();

    expect(wrapper.find(PILL).exists(), '一切正常也占一行，等于把列表挤掉一行').toBe(false);
    wrapper.unmount();
  });

  it('同步失败时它出现，说的是真文案，点了跳设置页', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const open = stubOpenOptions();
    await setMeta({
      status: 'error',
      lastError: { kind: 'network', message: '503 Service Unavailable', at: AT },
    });
    const wrapper = await mountWorkbench();

    const pill = wrapper.find(PILL);
    expect(pill.exists(), '同步坏了但屏幕上没有任何地方承认 ⇒ 用户只能自己去翻设置页').toBe(true);
    expect(pill.text()).toContain('Sync failed');
    // 内部判别值不许上屏（这条纪律在这轮改动里最容易破：新加的 trigger 名都是英文标识）
    expect(wrapper.text()).not.toContain('network');

    await pill.trigger('click');
    expect(open).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('退避中也显形：现在不会自动重试，用户该知道', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    stubOpenOptions();
    await setMeta({
      status: 'pending',
      nextAttemptAt: Date.now() + 5 * 60_000,
      consecutiveFailures: 3,
    });
    const wrapper = await mountWorkbench();

    expect(wrapper.find(PILL).exists()).toBe(true);
    wrapper.unmount();
  });

  it('可疑变化也显形', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    stubOpenOptions();
    await setMeta({ status: 'suspicious_change' });
    const wrapper = await mountWorkbench();

    expect(wrapper.find(PILL).text()).toContain('Unusual change detected');
    wrapper.unmount();
  });

  it('冲突不在顶栏重复播报：那句话由 ConflictPanel 说（同一屏说两遍像两个问题）', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    stubOpenOptions();
    await setMeta({
      status: 'conflict',
      pendingConflicts: [
        { groupId: 'g1', groupTitle: '会话 g1', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: 'other', deleteReason: 'user-delete' },
      ],
    });
    const wrapper = await mountWorkbench();

    // 正向对照：那块面板确实在这屏里说了这句话，所以顶栏不说是"分工"而不是"漏了"
    expect(wrapper.find('[data-testid="conflict-section"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('CONFLICTS WAITING FOR YOU');
    expect(wrapper.find(PILL).exists(), '同一件事在同一屏说两遍').toBe(false);
    wrapper.unmount();
  });

  it('页面开着的时候账本被 background 改了 ⇒ pill 当场出现，不用刷新', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    stubOpenOptions();
    const wrapper = await mountWorkbench();
    expect(wrapper.find(PILL).exists()).toBe(false);

    await setMeta({ status: 'error', lastError: { kind: 'server_5xx', message: '503', at: AT } });

    expect(
      wrapper.find(PILL).exists(),
      '只读了一次账本 ⇒ 同步坏了这件事要等用户刷新才知道',
    ).toBe(true);
    wrapper.unmount();
  });
});

/**
 * 回收站入口的位置 + 勾选的隔离。
 *
 * 两件都是"看代码看不出来、看界面一眼能看出不对"的事，所以断言落在 DOM 上。
 */
describe('工作台 · 回收站入口的位置与勾选隔离', () => {
  beforeEach(async () => {
    const { showTrash } = await import('@/shared/trash-view');
    showTrash.value = false;
  });

  /** 造一行回收站数据（不经 use case：这里要的是"面板里有东西可勾"这个前提）。 */
  async function seedTrashRow(id = 'g-trash'): Promise<void> {
    const storage = createStoragePort();
    const now = Date.now();
    await storage.putTrash({
      group: group(id, '被删掉的会话', 2),
      deletedAt: now,
      expiresAt: now + 7 * 86_400_000,
      reason: 'user-delete',
    });
  }

  it('入口在左栏底部的 footer 里，且排在主题与设置的**上面**', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const wrapper = await mountWorkbench();

    const buttons = wrapper.findAll('aside footer button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.attributes('data-testid'), '回收站没在主题/设置上面').toBe('rail-trash');
    // 只有一个入口：原来分类列表末尾那一行是**挪走**，不是又加一个（重复入口是明确反对过的形状）
    expect(wrapper.findAll('[data-testid="rail-trash"]')).toHaveLength(1);
    wrapper.unmount();
  });

  it('在回收站勾一行 → 切回会话列表 → 主列表的批量条不出现（两份勾选，不串台）', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    await seedTrashRow();
    const wrapper = await mountWorkbench();

    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="trash-check-g-trash"]').setValue(true);
    expect(wrapper.find('[data-testid="trash-bulk-bar"]').exists()).toBe(true);

    // 改判：原来点面板里那颗「返回标签组列表」离开，那颗按钮删了 ——
    // 出口是左栏那颗开关（`toggleTrashView`），点分类也会交还视图。
    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();

    // 主列表那颗「恢复所选」只在 store.checkedCount > 0 时出现。
    // 两份 selection 如果共用一份，这里就会冒出来 —— 而它点下去是**真删除**活会话。
    expect(wrapper.text(), '回收站的勾选串到了会话列表，那边那颗是"删除所选"').not.toContain('Restore selected');

    // 再进回收站：勾选不该还在（切走再回来要重勾，这是这份隔离的代价，也是它的定义）
    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="trash-bulk-bar"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

/**
 * 左栏底部那一区的形状。
 *
 * 用户的话是"回收站样式让他和分类一样、顶部的横线移到底部"。两件事都是**读起来**的问题，
 * 但都能钉成 DOM 断言：那颗按钮用的是分类行那把 `tn-item`（12px、hover:bg-chip、
 * 选中 bg-brand-soft + 粗体品牌色），而分隔线压在**主题与设置**那一组的上面 ——
 * 线在回收站上面时，它读起来像"这里开始是设置区"，回收站被划到设置那一堆里去了。
 */
describe('工作台 · 左栏底部那一区的形状', () => {
  beforeEach(async () => {
    const { showTrash } = await import('@/shared/trash-view');
    showTrash.value = false;
  });

  it('回收站那一行与分类同形，分隔线在它下面（不在它上面）', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const wrapper = await mountWorkbench();

    const entry = wrapper.find('[data-testid="rail-trash"]');
    expect(entry.classes()).toContain('tn-item');
    expect(entry.classes()).toContain('text-[12px]');
    /**
     * 与分类行**同一把静态样式**：逐个类名点名列出，而不是拿两行的 class 集合对比 ——
     * 后者会把"当前选中态"那三个动态类（text-brand / bg-brand-soft / font-bold）也算进来，
     * 于是断言变成"两行的选中状态必须一样"，那既不是我要钉的事，也永远在随机红。
     */
    for (const shape of ['tn-item', 'w-full', 'items-center', 'gap-2', 'rounded-tight', 'px-2', 'py-1.5', 'text-[12px]', 'text-left']) {
      expect(entry.classes(), `回收站那一行少了分类行的类名 ${shape}`).toContain(shape);
    }

    const groups = wrapper.findAll('aside footer > div');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.classes(), '分隔线还压在回收站上面 ⇒ 它被划进"设置"那一堆').not.toContain('border-t');
    expect(groups[1]!.classes(), '分隔线没压在主题/设置上面').toContain('border-t');
    wrapper.unmount();
  });

  it('选中回收站时那一行用分类的选中态（bg-brand-soft + 粗体），不是按钮态', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const wrapper = await mountWorkbench();

    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();

    const entry = wrapper.find('[data-testid="rail-trash"]');
    expect(entry.classes()).toContain('bg-brand-soft');
    expect(entry.classes()).toContain('font-bold');
    expect(entry.attributes('aria-current')).toBe('true');
    wrapper.unmount();
  });
});

/**
 * 主列表的两种粒度。
 *
 * 他的原话：「所有标签组、分类也支持标签组内多选操作」—— 把回收站那套搬到主列表。
 * 三条要钉住的：① 行首框是"这一行的全选"，不是另一种选择，两个数不重复计；
 * ② 混合选择时整组与逐条**各走各的路径**（整组走 `restoreGroup`/`deleteGroup`，
 * 逐条走 `restoreTab`/`removeTabToTrash`）；③ "全覆盖"按**整表**判 ——
 * 搜索态下右栏只有命中子集，拿子集判会把没命中的记录一起删掉，那是数据损失。
 */
describe('工作台 · 主列表的两种粒度', () => {
  beforeEach(async () => {
    // `showTrash` 是模块级的共享 ref：上面那组用例把它留在 true 的话，
    // 这里挂出来的是回收站面板，`group-check-*` 一颗都找不到（踩过，症状是"空 DOMWrapper"）。
    const { showTrash } = await import('@/shared/trash-view');
    showTrash.value = false;
    // store 是 pinia 单例：不清的话，上一条留在 `checkedRecords` 里的键会算进这一条的计数
    // （第一次撞见时 `selectionCount` 多了 1，排查方向一路偏到"是不是 reload 写坏了"）。
    setActivePinia(createPinia());
  });

  const rowCheck = (wrapper: ReturnType<typeof mount>, id: string) =>
    wrapper.find(`[data-testid="group-check-${id}"]`);
  const recordCheck = (wrapper: ReturnType<typeof mount>, tabId: string) =>
    wrapper.find(`[data-testid="record-check-${tabId}"]`);
  const checked = (node: ReturnType<typeof recordCheck>): boolean =>
    (node.element as HTMLInputElement).checked;
  const summary = (wrapper: ReturnType<typeof mount>): string =>
    wrapper.find('[data-testid="bulk-summary"]').text();
  /** `commandsOf` 只保证 `kind` 这一项存在，取载荷字段要各自收窄一次。 */
  const payloadOf = (kind: string): Record<string, unknown>[] =>
    commandsOf(kind).map((command) => command as unknown as Record<string, unknown>);

  it('行首框点一下 = 这一行全选；再勾别行的一条 ⇒ 两个数各算各的', async () => {
    await seed(group('g1', '会话一', 2), group('g2', '会话二', 2));
    const wrapper = await mountWorkbench();

    await rowCheck(wrapper, 'g1').setValue(true);
    expect(summary(wrapper)).toContain('1 sessions');
    expect(summary(wrapper)).toContain('0 records');
    expect(checked(recordCheck(wrapper, 'g1-t1')), '行内那颗是派生视图').toBe(true);

    await recordCheck(wrapper, 'g2-t0').setValue(true);
    expect(summary(wrapper)).toContain('1 sessions');
    expect(summary(wrapper)).toContain('1 records');
    wrapper.unmount();
  });

  it('混合选择点「恢复所选」⇒ 整组那份发 restoreGroup，落单那条发 restoreTab', async () => {
    await seed(group('g1', '会话一', 2), group('g2', '会话二', 2));
    const wrapper = await mountWorkbench();

    await rowCheck(wrapper, 'g1').setValue(true);
    await recordCheck(wrapper, 'g2-t0').setValue(true);
    await buttonWithText(wrapper, 'Restore selected')?.trigger('click');
    await flushPromises();

    expect(payloadOf('restoreGroup').map((payload) => payload.groupId)).toEqual(['g1']);
    expect(payloadOf('restoreTab').map((payload) => `${payload.groupId}/${payload.tabId}`)).toEqual([
      'g2/g2-t0',
    ]);
    wrapper.unmount();
  });

  it('混合选择点「删除所选」⇒ 整组那份整个进回收站，落单那条只少那一条', async () => {
    const storage = createStoragePort();
    await seed(group('g1', '会话一', 2), group('g2', '会话二', 2));
    const wrapper = await mountWorkbench();

    await rowCheck(wrapper, 'g1').setValue(true);
    await recordCheck(wrapper, 'g2-t0').setValue(true);
    await buttonWithText(wrapper, 'Delete selected')?.trigger('click');
    await flushPromises();
    expect(wrapper.text(), '第一下只该问一句').toContain('Delete 1 selected sessions and 1 records');
    expect(await storage.getGroup('g1'), '第一下就删了').toBeDefined();

    await buttonWithText(wrapper, 'Delete')?.trigger('click');
    await flushPromises();
    await flushPromises();

    expect(await storage.getGroup('g1'), '整组那份该消失').toBeUndefined();
    expect((await storage.getGroup('g2'))?.tabs.map((tab) => tab.id)).toEqual(['g2-t1']);
    const rows = await storage.listTrash();
    expect(rows.map((entry) => entry.group.id).sort()).toEqual(['g1', 'g2']);
    wrapper.unmount();
  });

  /** 锁定的跳过而不是让整批失败（既有约定 那条理由在这里同样成立），记录级也要 catch。 */
  it('锁定：整行勾满锁定的会话、以及锁定会话里的单条，都跳过并说出来，不炸整批', async () => {
    const storage = createStoragePort();
    await seed(
      group('g1', '锁着的', 2, { locked: true }),
      group('g2', '会话二', 2, { locked: true }),
      group('g3', '会话三', 1),
    );
    const store = useGroups();
    await store.init();
    await store.loadTabs('g1');
    await store.loadTabs('g2');
    await store.toggleRow('g1');
    store.toggleRecord('g2', 'g2-t0');
    await store.toggleRow('g3');
    expect(store.checkedCount).toBe(2);
    expect(store.recordCount).toBe(1);

    await store.removeChecked();

    expect(await storage.getGroup('g1'), '锁定的整行没被删').toBeDefined();
    expect((await storage.getGroup('g2'))?.tabs).toHaveLength(2);
    expect(await storage.getGroup('g3'), '没锁的该删掉').toBeUndefined();
    expect(store.toast).toMatchObject({
      kind: 'message',
      key: 'bulk_delete_done_skipped',
      subs: { groups: 1, records: 0, skipped: 2 },
    });
    store.dispose();
  });

  /**
   * 搜索态的那一条判据：界面上只有 2 条命中，也**不等于**整行被勾满。
   *
   * 走 store 而不是走 DOM —— 要钉的是"全覆盖按整表判"这个判据本身，
   * 而"右栏只渲染命中子集"由 `App.vue` 的 `tabsFor` 负责（那边另有用例）。
   */
  it('勾满命中子集不算整组：整表还有没命中的记录时，走的是逐条路径', async () => {
    const storage = createStoragePort();
    await seed(group('g1', '会话一', 3));
    const store = useGroups();
    await store.init();
    await store.loadTabs('g1');

    store.toggleRecord('g1', 'g1-t0');
    store.toggleRecord('g1', 'g1-t1');

    expect(store.checkedCount, '3 条里勾了 2 条不算整组').toBe(0);
    expect(store.recordCount).toBe(2);

    await store.removeChecked();
    expect((await storage.getGroup('g1'))?.tabs.map((tab) => tab.id)).toEqual(['g1-t2']);
    const rows = await storage.listTrash();
    // 勾到的两条里只有 `g1-t0` 进回收站：夹具把 `-t1` 标成不可恢复（既有约定 让它不回收）。
    // 两条判据在同一条用例里各走各的 —— 逐条路径确实逐条在做，没有顺手把整组搬走。
    expect(
      rows.find((entry) => entry.group.id === 'g1')?.group.tabs.map((tab) => tab.id),
    ).toEqual(['g1-t0']);
    store.dispose();
  });

  /**
   * ★ 这条是**又一条没能变红的变异**逼出来的：把 `toggleRow` 的"再点清空"分支去掉，
   * 前面几条用例一条都没红 —— 它们都只点一次行首框。
   * 回收站那颗（`TrashPanel.toggleChecked`）有自己的用例，但那是**另一份实现**，
   * 组件级用例不会替 store 作证。
   */
  it('行首框再点一次 = 清空这一行，别行的那条纹丝不动', async () => {
    const store = useGroups();
    await seed(group('g1', '会话一', 2), group('g2', '会话二', 2));
    await store.init();
    await store.loadTabs('g1');
    await store.loadTabs('g2');

    await store.toggleRow('g1');
    store.toggleRecord('g2', 'g2-t0');
    expect(store.selectionCount).toBe(3);

    await store.toggleRow('g1');
    expect(store.selectionCount, '再点一次该把这一行清空').toBe(1);
    expect(store.isRecordChecked('g2', 'g2-t0'), '别行的勾选被牵连了').toBe(true);
    expect(store.checkedCount).toBe(0);
    expect(store.recordCount).toBe(1);
    store.dispose();
  });

  /**
   * 回收站那边早就有这条（既有约定 之后同步会往本地写），主列表同样要防：
   * 后台刚把这一组处理掉，勾选里还留着它的话，用户按「删除所选」会对着不存在的目标跑一轮，
   * 看到的是"我勾了 5 个怎么只动了 3 个"。
   */
  it('后台同步刚把某一组处理掉 ⇒ 勾选里那些记录跟着被剔掉', async () => {
    const storage = createStoragePort();
    await seed(group('g1', '会话一', 2), group('g2', '会话二', 1));
    const store = useGroups();
    await store.init();
    await store.loadTabs('g1');
    await store.loadTabs('g2');
    await store.toggleRow('g1');
    expect(store.selectionCount).toBe(2);

    await storage.removeGroup('g1');
    await store.reload();

    expect(store.selectionCount, '已经不存在的记录还留在勾选里').toBe(0);
    expect(store.checkedCount).toBe(0);
    // 正向对照：g2 那颗行首框勾上之后不该被上面那次 reload 牵连
    await store.toggleRow('g2');
    await store.reload();
    expect(store.selectionCount).toBe(1);
    store.dispose();
  });

  /** 一个 3 条记录的会话，只有前两条的标题含 `命中词` ⇒ 搜索态下右栏只渲染那 2 颗框。 */
  async function seedSearchableGroup(): Promise<void> {
    const g = group('g1', '会话一', 3);
    g.tabs = g.tabs.map((tab, index) => ({
      ...tab,
      title: index < 2 ? `命中词 ${tab.id}` : '这条没命中',
    }));
    await seed(g);
  }

  async function searchAndCollapse(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.find('main input[type="search"]').setValue('命中词');
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.findAll('[data-testid^="record-check-"]')).toHaveLength(2);
    });
  }

  /**
   * 搜索态走到底（DOM 级）。上面那条 store 级的钉的是判据，这一条钉的是
   * **界面上真的只有 2 颗框时**删下去会怎样 —— M21④ 要看的是这个。
   */
  it('搜索态勾满看得见的 2 条 ⇒ 删下去不牵连没命中的第 3 条', async () => {
    const storage = createStoragePort();
    await seedSearchableGroup();
    const wrapper = await mountWorkbench();
    await searchAndCollapse(wrapper);

    await wrapper.find('[data-testid="record-check-g1-t0"]').setValue(true);
    await wrapper.find('[data-testid="record-check-g1-t1"]').setValue(true);

    expect(summary(wrapper)).toContain('0 sessions');
    expect(summary(wrapper)).toContain('2 records');
    /**
     * 行首框在这里是**勾选态**：既有约定 之后它说的是"你看得见的都勾了"，
     * 而"要不要走整组动作"另算（判据只看整表 ⇒ 汇总仍是 0 个标签组）。
     * 半选留给"看得见的也没勾满"那种情况，不然搜索态里永远点不满。
     */
    const row = wrapper.find('[data-testid="group-check-g1"]').element as HTMLInputElement;
    expect(row.checked).toBe(true);
    expect(row.indeterminate).toBe(false);
    expect(summary(wrapper), '勾满命中项也不算整组 ⇒ 汇总不许出现 1 sessions').toContain('0 sessions');

    await buttonWithText(wrapper, 'Delete selected')?.trigger('click');
    await flushPromises();
    await buttonWithText(wrapper, 'Delete')?.trigger('click');
    await flushPromises();
    await flushPromises();

    expect((await storage.getGroup('g1'))?.tabs.map((tab) => tab.id)).toEqual(['g1-t2']);
    wrapper.unmount();
  });

  /**
   * ★ 搜索态里点**行首框**也只能勾"你看得见的这些"。
   *
   * 让它去勾整表（含没命中的第 3 条）的表现是：屏幕上只有 2 颗框变勾、第 3 颗根本不在视野里，
   * 而「删除所选」从此走**整组**路径 —— 用户看到的是一次搜索里的删除，实际是整个会话没了。
   * 这条是"再跑一遍④"跑出来的：store 级的判据有用例，行首框这条路没有。
   */
  it('搜索态点行首框 = 只勾命中那两条，删下去第 3 条还在', async () => {
    const storage = createStoragePort();
    await seedSearchableGroup();
    const wrapper = await mountWorkbench();
    await searchAndCollapse(wrapper);

    await wrapper.find('[data-testid="group-check-g1"]').setValue(true);

    expect(
      wrapper.findAll('[data-testid^="record-check-"]').filter((node) =>
        (node.element as HTMLInputElement).checked,
      ),
      '看得见的两条都该被勾上',
    ).toHaveLength(2);
    expect(summary(wrapper)).toContain('0 sessions');
    expect(summary(wrapper)).toContain('2 records');

    // 反操作也要走一遍（第三次栽在这上面）：再点一次只放开看得见的这两条。
    await wrapper.find('[data-testid="group-check-g1"]').setValue(false);
    expect(wrapper.findAll('[data-testid^="record-check-"]').filter((node) =>
      (node.element as HTMLInputElement).checked,
    )).toHaveLength(0);
    expect(wrapper.find('[data-testid="bulk-summary"]').exists(), '清空之后批量条该收起').toBe(false);
    await wrapper.find('[data-testid="group-check-g1"]').setValue(true);

    await buttonWithText(wrapper, 'Delete selected')?.trigger('click');
    await flushPromises();
    await buttonWithText(wrapper, 'Delete')?.trigger('click');
    await flushPromises();
    await flushPromises();

    expect((await storage.getGroup('g1'))?.tabs.map((tab) => tab.id), '整个会话被一次搜索里的删除带走了').toEqual([
      'g1-t2',
    ]);
    wrapper.unmount();
  });

  /**
   * ★ 传的是"这一行渲染出的全部"（`ordered`），不是"展开可见的那部分"（`shown`）。
   * 两者差在折叠：一个 35 条的会话默认只列前 30 条，拿 `shown` 判 ⇒ 点行首框只勾 30 条、
   * 「删除所选」退化成逐条删 30 次，剩下 5 条躺在原会话里 —— 用户看到的是"我勾了整组，怎么还剩几条"。
   */
  it('折叠掉一半的长会话：点行首框仍是整组（35 条全勾、走整组路径）', async () => {
    const storage = createStoragePort();
    await seed(group('big', '长会话', COLLAPSED_TAB_LIMIT + 5));
    const wrapper = await mountWorkbench();

    expect(wrapper.findAll('[data-testid^="record-check-"]')).toHaveLength(COLLAPSED_TAB_LIMIT);

    await wrapper.find('[data-testid="group-check-big"]').setValue(true);
    expect(summary(wrapper)).toContain('1 sessions');
    expect(summary(wrapper)).toContain('0 records');

    await buttonWithText(wrapper, 'Delete selected')?.trigger('click');
    await flushPromises();
    await buttonWithText(wrapper, 'Delete')?.trigger('click');
    await flushPromises();
    await flushPromises();

    expect(await storage.getGroup('big'), '整组没被删掉 ⇒ 折叠那 5 条把判据拉回了逐条').toBeUndefined();
    const rows = await storage.listTrash();
    /**
     * 回收站里是 34 条而不是 35：夹具把 `-t1` 标成不可恢复，既有约定 的入站过滤把它挡在回收站外。
     * 顺带钉住两条规则同时成立 —— 走的是**整组**路径（会话整个没了、整行进回收站），
     * 而入站过滤仍然只作用于回收站那一份。
     */
    expect(rows.find((entry) => entry.group.id === 'big')?.group.tabs).toHaveLength(
      COLLAPSED_TAB_LIMIT + 4,
    );
    wrapper.unmount();
  });
});

/**
 * 回收站那一屏必须**自己会滚**（2026-10-06 真机：「回收站标签多了会溢出」）。
 *
 * 会话列表那一屏的 `<section>` 身上挂着 `tn-scroll min-h-0 flex-1 overflow-y-auto`，
 * 所以几百行只在右栏内部滚，外面那层 `h-screen` 的壳不动。回收站那一屏原来只有
 * `flex min-h-0 flex-1 flex-col`，**一个滚动容器都没有** ⇒ 面板把壳撑破：
 * 真浏览器探针实测壳 800 高、回收站内容 2337 高、文档被撑到 2391 ⇒ 整页滚，
 * 左栏和顶栏跟着滑出视野（他截图里左栏最上面那行被切掉就是这个样子）。
 *
 * jsdom 量不出布局（视口 0×0），所以这条断言落在**契约**上：从回收站那一行往上走到 `main`，
 * 必须遇到一个同时带 `overflow-y-auto` 与 `min-h-0` 的祖先。那两个类名少一个都不算：
 * 只有 `overflow-y-auto` 而没有 `min-h-0`，flex 项的最小高度会按内容算，容器照样被撑破。
 * 数字是浏览器探针量的，记在 `既有约定`。
 */
describe('工作台 · 回收站那一屏的滚动容器（真机：标签多了会溢出）', () => {
  /**
   * `showTrash` 是模块级 ref（`shared/trash-view.ts`），**不随 unmount 复位**：
   * 上一条用例留在回收站视图里时，下面那条「会话列表有滚动容器」的对照读到的是回收站那一屏，
   * 会红成一个假的"列表也坏了"。上面 既有约定 那个 describe 也为此在 beforeEach 里复位。
   */
  beforeEach(async () => {
    const { showTrash } = await import('@/shared/trash-view');
    showTrash.value = false;
  });

  it('回收站行的祖先链里有 overflow-y-auto + min-h-0 那一层，不是把整页撑出滚动', async () => {
    const { showTrash } = await import('@/shared/trash-view');
    showTrash.value = false;
    const now = Date.now();
    await createStoragePort().putTrash({
      group: group('g-overflow', '被删掉的会话', 2),
      deletedAt: now,
      expiresAt: now + 7 * 86_400_000,
      reason: 'user-delete',
    });

    const wrapper = await mountWorkbench();
    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();

    const chain: string[] = [];
    for (let el = wrapper.find('[data-testid="trash-row"]').element.parentElement; el && el.tagName !== 'MAIN'; el = el.parentElement) {
      chain.push(String(el.getAttribute('class') ?? ''));
    }
    const scroller = chain.find((cls) => cls.includes('overflow-y-auto') && cls.includes('min-h-0'));
    expect(scroller, `回收站那一屏没有滚动容器，链上是：${JSON.stringify(chain)}`).toBeDefined();
    wrapper.unmount();
  });

  /**
   * 差分对照（否定断言要配正向对照，这条仓库的老规矩）：
   * **会话列表**那一屏一直是有滚动容器的。它要是也红了，说明病在壳上而不是回收站那一屏，
   * 上面那条绿就只是碰巧。
   */
  it('会话列表那一屏同样有滚动容器（对照：这条本来就是绿的）', async () => {
    await seed(group('g1', 'Flutter 开发', 2));
    const wrapper = await mountWorkbench();

    const chain: string[] = [];
    for (let el = wrapper.find('[data-group-card]').element.parentElement; el && el.tagName !== 'MAIN'; el = el.parentElement) {
      chain.push(String(el.getAttribute('class') ?? ''));
    }
    expect(chain.find((cls) => cls.includes('overflow-y-auto') && cls.includes('min-h-0')), JSON.stringify(chain)).toBeDefined();
    wrapper.unmount();
  });
});

/**
 * 两屏共用同一层外壳。
 *
 * 这里钉的是**跨屏**那三件事，组件内部那几条在 `ui-trash-panel.spec.ts`：
 * ① 标题槽一次只有一颗（换屏是换内容，不是再叠一行）；
 * ② 通栏批量条不串台 —— 原来那条是 `<main>` 的直接子元素，所以在回收站里
 *    会话列表那条还挂着（两份勾选各自数着自己的数，屏幕上却是两条栏）；
 *    搬进列表分支之后，换屏就不存在了；
 * ③ 通栏条是同一颗组件产出的（`data-bulk-strip`），不是一边抄一份类名。
 */
describe('工作台 · 两屏共用同一层外壳', () => {
  beforeEach(async () => {
    const { showTrash } = await import('@/shared/trash-view');
    showTrash.value = false;
  });

  async function seedBoth(): Promise<void> {
    await seed(group('g1', 'Flutter 开发', 2));
    const now = Date.now();
    await createStoragePort().putTrash({
      group: group('g-trash', '被删掉的会话', 3),
      deletedAt: now,
      expiresAt: now + 7 * 86_400_000,
      reason: 'user-delete',
    });
  }

  it('标题槽一次只有一颗，换屏换的是内容不是叠一行', async () => {
    await seedBoth();
    const wrapper = await mountWorkbench();

    const listHeading = wrapper.find('[data-testid="view-heading"]');
    expect(listHeading.exists()).toBe(true);
    expect(listHeading.text()).toContain('All sessions');
    expect(wrapper.findAll('[data-testid="view-heading"]')).toHaveLength(1);

    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();

    const headings = wrapper.findAll('[data-testid="view-heading"]');
    expect(headings, '两屏的标题槽同时挂在屏幕上').toHaveLength(1);
    expect(headings[0]!.text()).toContain('Recycle bin');
    wrapper.unmount();
  });

  it('在回收站里不许挂着会话列表那条通栏（两份勾选，一次只显一条栏）', async () => {
    await seedBoth();
    const wrapper = await mountWorkbench();

    // 先在列表那侧勾满一行 ⇒ 列表那条栏出现（正向对照：不然下面的"没有"是空对空）
    await wrapper.find('[data-testid="group-check-g1"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="bulk-summary"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-bulk-strip]')).toHaveLength(1);

    await wrapper.find('[data-testid="rail-trash"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="bulk-summary"]').exists(), '列表那条通栏跟着进了回收站').toBe(false);
    // 回收站这侧还没勾 ⇒ 一条栏都不该有
    expect(wrapper.findAll('[data-bulk-strip]')).toHaveLength(0);

    await wrapper.find('[data-testid="trash-check-g-trash"]').setValue(true);
    await flushPromises();
    const strips = wrapper.findAll('[data-bulk-strip]');
    expect(strips, '回收站那条栏不是同一颗组件产的').toHaveLength(1);
    expect(strips[0]!.text()).toContain('Delete selected permanently');
    wrapper.unmount();
  });
});
