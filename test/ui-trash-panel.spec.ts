import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import TrashPanel from '@/components/TrashPanel.vue';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { restoreTrashTab, softDeleteGroup } from '@/core/application/delete-model';
import { removeTabToTrash } from '@/core/application/group-commands';
import { groupFixture, savedTabFixture } from './fixtures';
import { COLLAPSED_TAB_LIMIT, TAB_EXPAND_BATCH, TRASH_RETENTION_MS } from '@/shared/constants';
import { clockStamp } from '@/shared/utils';

const DAY = 86_400_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
});

async function seedDeleted(id: string, tabCount: number, deletedAt: number) {
  const storage = createStoragePort();
  await storage.putGroup(
    groupFixture(`会话 ${id}`, Array.from({ length: tabCount }, (_, i) => savedTabFixture(id, `${id}-t${i}`, i)), { id }),
  );
  await softDeleteGroup({ storage }, { groupId: id, reason: 'user-delete', at: deletedAt });
  return storage;
}

/** 某一行的标题区。 */
function header(wrapper: VueWrapper, groupId: string) {
  const row = wrapper
    .findAll('[data-testid="trash-row"]')
    .find((item) => item.find(`[data-testid="trash-restore-${groupId}"]`).exists());
  if (!row) throw new Error(`没有回收站行：${groupId}`);
  return row;
}

/** 某一行里那条记录的整行（TabRow 由这层包着，所以选择器挂在这层）。 */
function record(wrapper: VueWrapper, tabId: string) {
  return wrapper.find(`[data-testid="trash-record-${tabId}"]`);
}

describe('回收站面板', () => {
  it('空的时候说"保留 7 天"，而不是留一块空白让用户以为坏了', async () => {
    const wrapper = mount(TrashPanel);
    await flush();
    // 既有约定：空态换成与会话列表同一块形状（图标 + 粗体标题 + 一句提示），
    // 那句 7 天承诺还在 —— 它是这个面板"为什么存在"的那半句话。
    expect(wrapper.find('[data-testid="view-empty"]').exists(), '空态不是列表那一块居中形状').toBe(true);
    expect(wrapper.text()).toContain('Recycle bin is empty');
    expect(wrapper.text()).toContain('Deleted sessions stay here for 7 days');
    expect(wrapper.find('[data-testid="trash-row"]').exists()).toBe(false);
  });

  /**
   * 外壳契约：这一屏**不再自带一层面板壳**，也不再有「返回」。
   *
   * 三条各钉一件事，少一条就能从另一个方向漂回去：
   * ① 那颗按钮和那句文案都不许出现（出口是左栏那颗开关与点任意分类）；
   * ② 行的祖先链里不许有 `p-5` / `rounded-card` 的容器（那层壳当初就是这么套上的）；
   * ③ 标题槽的计数是**行数（会话数）**，不是记录数 —— 与列表那一屏同一个轴，
   *    否则"看起来一样"但两边数的不是同一件事。
   */
  describe('外壳与出口', () => {
    /** 从行往上走到组件根，收集每一层的 class。 */
    function ancestorClasses(wrapper: ReturnType<typeof mount>): string[] {
      const row = wrapper.find('[data-testid="trash-row"]').element;
      const root = wrapper.element;
      const chain: string[] = [];
      for (let el: HTMLElement | null = row.parentElement; el && el !== root; el = el.parentElement) {
        chain.push(String(el.getAttribute('class') ?? ''));
      }
      return chain;
    }

    it('没有「返回」那颗按钮，屏幕上也没有那句文案', async () => {
      await seedDeleted('back', 2, Date.now());
      const wrapper = mount(TrashPanel);
      await flush();

      expect(wrapper.find('[data-testid="trash-close"]').exists()).toBe(false);
      expect(wrapper.text()).not.toContain('Back to sessions');
      // 正向对照：这一屏确实渲染出来了（空屏上"没有按钮"是空对空）
      expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(1);
    });

    it('行直接摊在滚动区里，中间不许再有一层面板壳', async () => {
      await seedDeleted('shell', 2, Date.now());
      const wrapper = mount(TrashPanel);
      await flush();

      const chain = ancestorClasses(wrapper);
      expect(
        chain.filter((cls) => cls.includes('p-5') || cls.includes('rounded-card')),
        `行和被套了一层壳之前一样：${JSON.stringify(chain)}`,
      ).toEqual([]);
      // 这一屏自己仍然是那个滚动容器（2026-10-06 那条"每屏自己滚"的契约不能因为搬家而丢）
      expect(
        chain.find((cls) => cls.includes('overflow-y-auto') && cls.includes('min-h-0')),
        JSON.stringify(chain),
      ).toBeDefined();
    });

    it('标题槽写的是「回收站」+ 行数，不是记录数', async () => {
      await seedDeleted('a', 3, Date.now());
      await seedDeleted('b', 4, Date.now());
      const wrapper = mount(TrashPanel);
      await flush();

      const heading = wrapper.find('[data-testid="view-heading"]');
      expect(heading.exists(), '这一屏没有用共用的标题槽').toBe(true);
      expect(heading.text()).toContain('Recycle bin');
      // 两行、共 7 条记录 ⇒ 屏幕上那个数必须是 2（列表那一屏数的也是会话）
      expect(heading.text()).toContain('2');
      expect(heading.text(), '数成记录数了：与列表那一屏不是同一个轴').not.toContain('7');
    });
  });

  it('列出软删的会话，条数与剩余天数都是用户看得见的字', async () => {
    await seedDeleted('a', 3, Date.now());
    const wrapper = mount(TrashPanel);
    await flush();

    const rows = wrapper.findAll('[data-testid="trash-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('会话 a');
    expect(rows[0]!.text()).toContain('3 tabs');
    // 刚删的应该显示"还剩 7 天"，不是"还剩 6 天"（向上取整）
    expect(rows[0]!.text()).toContain('7 days left');
  });

  /**
   * 标题长到放不下时，**该被截断的是标题**，不是把「还剩 N 天」与还原/彻底删除挤出卡片。
   *
   * 浏览器探针实测：长标题那一行的 `header` 溢出 29px，整份文档因此比视口宽 8px ⇒
   * 每一行右侧那排动作都落到视口外面（2026-10-06 真机「回收站标签多了会溢出」的横轴那一半）。
   * `tn-ellipsis` 只在盒子被压窄时生效，而 `shrink-0` 正是"别压我"。
   *
   * ⚠ 与 `ui-components.spec.ts` 里 `group-title` 那条**成对**：标题行的排布在
   * `GroupRow` 与 `TrashPanel` 里各写了一份（既有约定 让它们同形），只钉一颗另一颗会漂回去。
   */
  it('标题长到放不下时是标题被截断，右侧控件不许被挤出去', async () => {
    const storage = createStoragePort();
    const longTitle = '一段足够长的会话标题用来把标题行撑到放不下'.repeat(3);
    await storage.putGroup(groupFixture(longTitle, [savedTabFixture('long', 'long-t0', 0)], { id: 'long' }));
    await softDeleteGroup({ storage }, { groupId: 'long', reason: 'user-delete', at: Date.now() });
    const wrapper = mount(TrashPanel);
    await flush();

    const title = wrapper.find('[data-testid="trash-title"]');
    expect(title.text(), '夹具没造出长标题 ⇒ 这条断言会空转').toBe(longTitle);
    expect(title.classes()).toContain('tn-ellipsis');
    expect(title.classes()).toContain('min-w-0');
    expect(title.classes(), 'shrink-0 会让 tn-ellipsis 永远不生效 ⇒ 标题把整行撑破').not.toContain('shrink-0');
    // 正向对照：真正该钉住宽度的是时间戳那一格
    expect(wrapper.find('[data-session-stamp]').classes(), '时间戳丢了 shrink-0').toContain('shrink-0');
  });

  /**
   * 时间戳显示的是**删除时间**，不是会话创建时间（既有约定 与主列表同形之后必须钉住这条）。
   *
   * 夹具的 createdAt 固定是 1_700_000_000_000，与 deletedAt 差得远，
   * 所以这一条断言能区分"抄错了字段"和"抄对了"。
   */
  it('标题行那个时间是"什么时候删的"，不是会话创建时间', async () => {
    const deletedAt = Date.now() - 2 * DAY;
    await seedDeleted('ts', 1, deletedAt);
    const wrapper = mount(TrashPanel);
    await flush();

    const stamp = header(wrapper, 'ts').find('[data-session-stamp]');
    expect(stamp.text()).toBe(clockStamp(deletedAt));
    // 夹具的会话创建时间固定是 1_700_000_000_000，抄错字段就会显示这个
    expect(stamp.text()).not.toBe(clockStamp(1_700_000_000_000));
  });

  /**
   * 还原是这个面板存在的理由。断言走的是**存储事实**而不是"列表少了一行"：
   * 会话回到主列表、回收站里没了、指向会话的墓碑被撤销 —— 墓碑没撤销的话另一台设备会再删一遍。
   * 同时**要留下**那条 `'trash'` 整行处理标记，否则另一台设备手上那一行会并回来。
   */
  it('点还原 ⇒ 回到主列表、离开回收站、组墓碑撤销但留下整行处理标记', async () => {
    const storage = await seedDeleted('b', 2, Date.now());
    const wrapper = mount(TrashPanel);
    await flush();
    expect(await storage.listGroupIndex()).toHaveLength(0);

    await wrapper.find('[data-testid="trash-restore-b"]').trigger('click');
    await flush();

    expect((await storage.listGroupIndex()).map((entry) => entry.id)).toEqual(['b']);
    expect(await storage.listTrash()).toHaveLength(0);
    expect((await storage.listTombstones()).map((tomb) => tomb.entityType)).toEqual(['trash']);
    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(0);
  });

  it('点彻底删除 ⇒ 离开回收站，但会话不回来，组墓碑仍然留着', async () => {
    const storage = await seedDeleted('c', 1, Date.now());
    const wrapper = mount(TrashPanel);
    await flush();

    await wrapper.find('[data-testid="trash-purge-c"]').trigger('click');
    await flush();

    expect(await storage.listTrash()).toHaveLength(0);
    expect(await storage.getGroup('c')).toBeUndefined();
    // 两种墓碑各一条，作用不同：`group` 让另一台设备别再把它当活会话留着，
    // `trash` 让另一台设备的回收站不再把这一行并回来。
    expect((await storage.listTombstones()).map((tomb) => tomb.entityType).sort()).toEqual([
      'group',
      'trash',
    ]);
    expect((await storage.listTombstones()).every((tomb) => tomb.entityId === 'c')).toBe(true);
  });

  /** 到期的行挂载时就被清掉，不该在界面上出现一个"还原"去救一条已经过承诺期的数据。 */
  it('超过 7 天的条目在挂载时就被扫掉，不显示', async () => {
    await seedDeleted('d', 1, Date.now() - TRASH_RETENTION_MS - DAY);
    const wrapper = mount(TrashPanel);
    await flush();

    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(0);
    expect(await createStoragePort().listTrash()).toHaveLength(0);
  });

  it('多行按删除时间倒序（最新删的排最前，与主列表同一条轴）', async () => {
    const now = Date.now();
    await seedDeleted('old', 1, now - 3 * DAY);
    await seedDeleted('new', 1, now - DAY);
    const wrapper = mount(TrashPanel);
    await flush();

    const titles = wrapper.findAll('[data-testid="trash-row"]').map((row) => row.text());
    expect(titles[0]).toContain('new');
    expect(titles[1]).toContain('old');
  });

  /**
   * 既有约定 改判之后：`consumed`（恢复即消费）**也进回收站**，而 `undone`（撤销收纳）不进。
   * 两个方向各一条断言 —— 只测"进来了"的话，把 undone 也放进来照样全绿，
   * 而那正是"回收站里冒出一堆没人见过的条目"的投诉来源。
   */
  it('恢复掉的会话在回收站里并标着 Restored；撤销收纳的那条不进', async () => {
    const storage = createStoragePort();
    await storage.putGroup(groupFixture('被消费的', [savedTabFixture('x', 'x-t0', 0)], { id: 'x' }));
    await softDeleteGroup({ storage }, { groupId: 'x', reason: 'consumed', at: Date.now() });
    await storage.putGroup(groupFixture('被撤销的', [savedTabFixture('y', 'y-t0', 0)], { id: 'y' }));
    await softDeleteGroup({ storage }, { groupId: 'y', reason: 'undone', at: Date.now() });
    await seedDeleted('kept', 1, Date.now());

    const wrapper = mount(TrashPanel);
    await flush();
    const rows = wrapper.findAll('[data-testid="trash-row"]');
    expect(rows).toHaveLength(2);
    const titles = rows.map((row) => row.text());
    expect(titles.some((text) => text.includes('被消费的'))).toBe(true);
    expect(titles.some((text) => text.includes('被撤销的'))).toBe(false);
    // 来源必须当场看得出来：他没删过这条，不标就会变成"谁把它弄进来的"
    expect(wrapper.find('[data-testid="trash-badge-restored"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="trash-badge-restored"]').text()).toBe('Restored');
    expect(wrapper.text()).not.toContain('consumed');
  });

  it('行上的两颗动作是图标按钮，但都带着看得见的文字名（读屏与 hover 都有话可说）', async () => {
    await seedDeleted('k', 1, Date.now());
    const wrapper = mount(TrashPanel);
    await flush();

    const restore = wrapper.find('[data-testid="trash-restore-k"]');
    const purge = wrapper.find('[data-testid="trash-purge-k"]');
    expect(restore.attributes('aria-label')).toBe('Restore');
    expect(purge.attributes('aria-label')).toBe('Delete permanently');
    expect(purge.attributes('title')).toBe('Delete permanently');
  });

  /**
   * 存储里多了一行（同步落库的形状）⇒ 面板不重新挂载也能看见它
   * （既有约定 的 `watchTrash`）。
   *
   * 这条测的是"接通"，不是"函数存在"：组件里只调一次 `storagePort.watchTrash(...)` 而没把
   * 回调接到 `reload()`，或者反过来接了但没订阅，界面上都是同一个症状 ——
   * 用户同步完打开回收站看到的还是上次那份。所以这里从**存储侧**塞一条进去，让面板自己说。
   */
  it('存储里多了一行（同步落库的形状）⇒ 面板不重新挂载也能看见它', async () => {
    const storage = createStoragePort();
    const wrapper = mount(TrashPanel);
    await flush();
    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(0);

    await storage.putGroup(
      groupFixture('另一台设备删的', [savedTabFixture('remote', 'remote-t0', 0)], { id: 'remote' }),
    );
    await softDeleteGroup({ storage }, { groupId: 'remote', reason: 'consumed', at: Date.now() });
    await flush();

    const rows = wrapper.findAll('[data-testid="trash-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('另一台设备删的');
    expect(rows[0]!.text()).toContain('Restored');
    wrapper.unmount();
  });

  /**
   * 用户在会话里 × 掉的那一条**不该**标「已恢复」—— 那是他自己删的。
   * 同一轮里配一条 consumed 的正向对照：只测"不亮"的话，把胶囊整个删掉照样全绿。
   */
  it('自己 × 掉的那一条进回收站时不标「已恢复」；恢复掉的那一条才标', async () => {
    const storage = createStoragePort();
    await storage.putGroup(
      groupFixture('会话 u', [savedTabFixture('u', 'u-t0', 0), savedTabFixture('u', 'u-t1', 1)], { id: 'u' }),
    );
    await removeTabToTrash({ storage }, { groupId: 'u', tabId: 'u-t0' });
    await storage.putGroup(groupFixture('会话 v', [savedTabFixture('v', 'v-t0', 0)], { id: 'v' }));
    await softDeleteGroup({ storage }, { groupId: 'v', reason: 'consumed', at: Date.now() });

    const wrapper = mount(TrashPanel);
    await flush();

    const own = wrapper
      .findAll('[data-testid="trash-row"]')
      .find((row) => row.text().includes('会话 u'));
    expect(own?.text()).toContain('页面标题 u-t0');
    expect(own?.find('[data-testid="trash-badge-restored"]').exists()).toBe(false);

    const restored = wrapper
      .findAll('[data-testid="trash-row"]')
      .find((row) => row.text().includes('会话 v'));
    expect(restored?.find('[data-testid="trash-badge-restored"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

/**
 * 展开的标签列表与逐条处理（既有约定 的粒度 + 既有约定 的形状）。
 *
 * 形状这一层的判据是"和主列表同形"：默认就把记录列出来（不再要点 ▸），
 * 只有超过 COLLAPSED_TAB_LIMIT 条才出现「展开剩余 N 条」，行级操作是 TabRow 那三颗。
 */
describe('回收站的记录列表', () => {
  it('默认就列出每一条记录，一行都是标题 + 域名 + 三颗行级动作', async () => {
    await seedDeleted('e', 3, Date.now());
    const wrapper = mount(TrashPanel);
    await flush();

    const records = wrapper.findAll('[data-tab-row]');
    expect(records).toHaveLength(3);
    const first = records[0]!;
    expect(first.text()).toContain('页面标题 e-t0');
    expect(first.text()).toContain('example0.com');
    expect(first.find('button[aria-label="Copy link"]').exists()).toBe(true);
    // 行级"彻底删除"这颗的文案是回收站自己的（'Delete permanently'），不是主列表的 'Delete'。
    // 还原那颗覆盖不到：en 里 `tab_restore` 与 `trash_action_restore` 是同一个词 'Restore'，
    // 换错 key 界面上看不出差别 —— 这一层只能靠 zh 文案或代码审查，别把这条断言当护栏。
    expect(first.find('button[title="Restore"]').exists()).toBe(true);
    expect(first.find('button[aria-label="Delete permanently"]').exists()).toBe(true);
  });

  it('超过一屏才出现「展开剩余 N 条」，点它列全，再点收起', async () => {
    await seedDeleted('big', COLLAPSED_TAB_LIMIT + 5, Date.now());
    const wrapper = mount(TrashPanel);
    await flush();

    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(COLLAPSED_TAB_LIMIT);
    const more = wrapper.find('[data-testid="trash-expand-big"]');
    expect(more.text()).toBe(`Show 5 more tabs`);

    await more.trigger('click');
    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(COLLAPSED_TAB_LIMIT + 5);
    expect(wrapper.find('[data-testid="trash-expand-big"]').text()).toBe('Collapse');

    await wrapper.find('[data-testid="trash-expand-big"]').trigger('click');
    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(COLLAPSED_TAB_LIMIT);
  });

  /**
   * ★ 同一份判断在仓库里曾经是**两份实现**（主列表 `GroupRow` 与回收站 `TrashPanel` 各一份），
   * 所以 既有约定 采纳 1 的分批要在两处各钉一次 —— 组件级用例不替另一份作证。
   * 算法本身收敛到 `shared/tab-window.ts`，两份都调它，但"这里真的走了分批"只能在这里测。
   */
  it('回收站的行也按批摊开：点一次只多 200 条', async () => {
    const total = COLLAPSED_TAB_LIMIT + TAB_EXPAND_BATCH + 30;
    await seedDeleted('huge', total, Date.now());
    const wrapper = mount(TrashPanel);
    await flush();

    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(COLLAPSED_TAB_LIMIT);
    const more = wrapper.find('[data-testid="trash-expand-huge"]');
    expect(more.text()).toBe(`Show ${TAB_EXPAND_BATCH + 30} more tabs`);

    await more.trigger('click');
    expect(wrapper.findAll('[data-tab-row]'), '一次点到底会挂出 230+30 行').toHaveLength(
      COLLAPSED_TAB_LIMIT + TAB_EXPAND_BATCH,
    );

    await wrapper.find('[data-testid="trash-expand-huge"]').trigger('click');
    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(total);
    expect(wrapper.find('[data-testid="trash-expand-huge"]').text()).toBe('Collapse');
  // 墙上时间预算，与同族那几条 UI 用例同一档：这一条要挂 430+230 行 DOM，
  // 默认 5 秒在机器忙时会被跑赢（2026-10-08 全量里就这么红过一次，单独连跑两遍都绿）。
  }, 20_000);

  it('还原其中一条：那条回到会话、行里剩两条、而且这一行还是展开的', async () => {
    const storage = await seedDeleted('f', COLLAPSED_TAB_LIMIT + 1, Date.now());
    const target = (await storage.listTrash())[0]?.group.tabs[1];
    if (!target) throw new Error('setup：夹具至少有两条记录');

    const wrapper = mount(TrashPanel);
    await flush();
    await wrapper.find('[data-testid="trash-expand-f"]').trigger('click');
    await record(wrapper, target.id).find('button[title="Restore"]').trigger('click');
    await flush();

    const group = await storage.getGroup('f');
    expect(group?.tabs.map((tab) => tab.id)).toContain(target.id);
    expect((await storage.listTrash())[0]?.group.tabs).toHaveLength(COLLAPSED_TAB_LIMIT);
    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(COLLAPSED_TAB_LIMIT);
    // 展开状态必须活过 reload，否则用户每捞一条都要重新点开同一行
    expect(wrapper.find('[data-testid="trash-expand-f"]').text()).toBe('Collapse');
  });

  /** 组已经整组没了，捞一条出来应当重建一个只带它的会话，而不是把整组偷偷带回来。 */
  it('整组都不在了时还原一条：会话重建、只含这一条、标题沿用快照', async () => {
    const storage = await seedDeleted('g', 2, Date.now());
    const first = (await storage.listTrash())[0]?.group.tabs[0];
    if (!first) throw new Error('setup');

    const wrapper = mount(TrashPanel);
    await flush();
    await record(wrapper, first.id).find('button[title="Restore"]').trigger('click');
    await flush();

    const group = await storage.getGroup('g');
    expect(group?.tabs.map((tab) => tab.id)).toEqual([first.id]);
    expect(group?.title).toBe('会话 g');
    expect((await storage.listTrash())[0]?.group.tabs).toHaveLength(1);
  });

  it('逐条彻底删除：删空的那一行整行消失，不留一个 0 条的空壳；墓碑仍然留着', async () => {
    const storage = await seedDeleted('h', 2, Date.now());
    const ids = (await storage.listTrash())[0]?.group.tabs.map((tab) => tab.id) ?? [];
    if (ids.length !== 2) throw new Error('setup');

    const wrapper = mount(TrashPanel);
    await flush();
    await record(wrapper, ids[0]!).find('button[aria-label="Delete permanently"]').trigger('click');
    await flush();
    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-tab-row]')).toHaveLength(1);

    await record(wrapper, ids[1]!).find('button[aria-label="Delete permanently"]').trigger('click');
    await flush();
    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(0);
    expect(await storage.listTrash()).toHaveLength(0);
    // 彻底删除不是一次"撤销删除"，组墓碑必须留着（否则另一台设备上的它会莫名其妙回来），
    // 并且要多一条 `'trash'` 整行标记 —— 少了它，另一台设备手上那一行会并回来。
    const tombstones = await storage.listTombstones();
    expect(tombstones.map((tomb) => tomb.entityType).sort()).toEqual(['group', 'trash']);
    expect(tombstones.every((tomb) => tomb.entityId === 'h')).toBe(true);
  });

  /** 一行里混着两种来历就别标「已恢复」—— 标了等于把用户删的东西说成他自己没删的。 */
  it('混着用户删除与恢复记录的行不标「已恢复」，全是恢复记录的才标', async () => {
    const storage = await seedDeleted('i', 2, Date.now());
    const kept = (await storage.listTrash())[0]?.group.tabs[0];
    if (!kept) throw new Error('setup');
    await storage.putGroup(groupFixture('会话 j', [savedTabFixture('j', 'j-t0', 0)], { id: 'j' }));
    await softDeleteGroup({ storage }, { groupId: 'j', reason: 'consumed', at: Date.now() });

    const wrapper = mount(TrashPanel);
    await flush();

    const rows = wrapper.findAll('[data-testid="trash-row"]');
    expect(rows).toHaveLength(2);
    const mixed = rows.find((row) => row.text().includes('会话 i'));
    const restored = rows.find((row) => row.text().includes('会话 j'));
    expect(mixed?.find('[data-testid="trash-badge-restored"]').exists()).toBe(false);
    expect(restored?.find('[data-testid="trash-badge-restored"]').exists()).toBe(true);
  });

  it('复制一条记录：写进剪贴板的是那条的 URL，行下面给一句「已复制到剪贴板」', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });

    const storage = await seedDeleted('m', 2, Date.now());
    const target = (await storage.listTrash())[0]?.group.tabs[0];
    if (!target) throw new Error('setup');

    const wrapper = mount(TrashPanel);
    await flush();
    await record(wrapper, target.id).find('button[aria-label="Copy link"]').trigger('click');
    await flush();

    expect(writeText).toHaveBeenCalledWith(target.url);
    expect(wrapper.find('[data-testid="trash-message"]').text()).toBe('Link copied');
  });

  /**
   * 既有约定 的界面那一半。
   *
   * 逐条还原到空之后，存储里会留下一条"零可见记录"的壳行 —— 它是凭证的载体：
   * 整行一起删掉的话，"这几条我已经处理过了"就没人记得，远端那一版（常常是本机自己
   * 上一轮推上去的那一版）下一轮会把它们并回回收站。
   * 但用户**不该看见它**：既有约定 早就定过"0 条的空壳一个都不该露出来"。
   *
   * ⚠ 前面那句"面板上原本有 1 行"是这条否定断言的正向对照 —— 不然"面板从来没渲染出行来"
   * 这种坏掉法也能让它绿。
   */
  it('逐条还原到空之后那一行从面板上消失（壳行只替凭证记账）', async () => {
    const storage = await seedDeleted('shell', 2, Date.now());
    const wrapper = mount(TrashPanel);
    await flush();
    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(1);

    const ids = ((await storage.listTrash())[0]?.group.tabs ?? []).map((tab) => tab.id);
    for (const tabId of ids) {
      await restoreTrashTab({ storage }, { groupId: 'shell', tabId, at: Date.now() });
    }
    await flush();

    // 数据层：行还在，可见记录为 0，凭证留着
    const rows = await storage.listTrash();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group.tabs).toHaveLength(0);
    expect(Object.values(rows[0]?.records ?? {}).filter((state) => state.barrier).map((state) => state.barrier?.action)).toEqual([
      'restore',
      'restore',
    ]);
    // 两条都回到会话里了
    expect((await storage.getGroup('shell'))?.tabs).toHaveLength(2);

    // 界面层：这一行不露出来，面板回到"空"的那句话
    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(0);
    expect(wrapper.text()).toContain('Recycle bin is empty');
    wrapper.unmount();
  });

  /**
   * 批量：勾选 → 还原 / 彻底删除，行内记录级多选。
   *
   * 每条都配了正向对照，因为"批量什么都没做"和"批量做对了"在这种面板里太容易同形：
   * 断言一律落在**存储的真实变化**上（会话回没回列表、行少没少、`'trash'` 标记写没写），
   * 不只断 DOM。
   *
   * ⚠ 计数从按钮上的 `(N)` 改成汇总句里的两个数（`已选 N 个标签组 · M 条记录`）——
   * 这是 既有约定 的**改判**，不是把断言改松：整行与记录级是两套粒度，
   * 分开挂就会有一个数被漏看，而用户按的是同一颗按钮。
   */
  describe('批量还原与批量彻底删除', () => {
    /** 整行那几颗勾选框（行内记录级的是 `record-check-*`，两套分开数）。 */
    const rowBoxes = (wrapper: VueWrapper) => wrapper.findAll('[data-testid^="trash-check-"]');
    const recordBoxes = (wrapper: VueWrapper) => wrapper.findAll('[data-testid^="record-check-"]');
    const checkedOf = (boxes: ReturnType<typeof rowBoxes>): number =>
      boxes.filter((box) => (box.element as HTMLInputElement).checked).length;
    const summary = (wrapper: VueWrapper): string =>
      wrapper.find('[data-testid="trash-bulk-summary"]').text();

    async function seedTwoRows() {
      const storage = createStoragePort();
      await seedDeleted('b1', 2, Date.now());
      await seedDeleted('b2', 3, Date.now());
      return storage;
    }

    it('勾两行 ⇒ 批量条出现、汇总句带两个数、全选与取消选择都在', async () => {
      await seedTwoRows();
      const wrapper = mount(TrashPanel);
      await flush();

      expect(wrapper.find('[data-testid="trash-bulk-bar"]').exists()).toBe(false);
      const boxes = rowBoxes(wrapper);
      expect(boxes).toHaveLength(2);
      // 行内每条记录也各有一颗：两行 2+3 条
      expect(recordBoxes(wrapper)).toHaveLength(5);

      await boxes[0]!.setValue(true);
      await boxes[1]!.setValue(true);

      const bar = wrapper.find('[data-testid="trash-bulk-bar"]');
      expect(bar.exists(), '勾了却没批量条 ⇒ 多选等于没接上').toBe(true);
      expect(summary(wrapper)).toContain('2 sessions');
      expect(summary(wrapper)).toContain('0 records');
      expect(checkedOf(boxes)).toBe(2);
      // 列表不能因为批量条出现就消失（v-if 链写错的表现正是"一勾整列没了"）
      expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(2);
      wrapper.unmount();
    });

    it('「全选」把两行都勾上，「取消选择」清空并收起批量条', async () => {
      await seedTwoRows();
      const wrapper = mount(TrashPanel);
      await flush();

      await wrapper.find('[data-testid="trash-check-b1"]').setValue(true);
      await wrapper.find('[data-testid="trash-bulk-all"]').trigger('click');
      expect(checkedOf(rowBoxes(wrapper))).toBe(2);

      await wrapper.find('[data-testid="trash-bulk-clear"]').trigger('click');
      expect(checkedOf(rowBoxes(wrapper))).toBe(0);
      expect(wrapper.find('[data-testid="trash-bulk-bar"]').exists()).toBe(false);
      wrapper.unmount();
    });

    it('「还原所选」⇒ 两个会话都回主列表、两行都消失、各写一条整行标记', async () => {
      const storage = await seedTwoRows();
      const wrapper = mount(TrashPanel);
      await flush();

      for (const id of ['b1', 'b2']) {
        await wrapper.find(`[data-testid="trash-check-${id}"]`).setValue(true);
      }
      await wrapper.find('[data-testid="trash-bulk-restore"]').trigger('click');
      await flush();

      expect(await storage.getGroup('b1'), 'b1 没回到会话列表').toBeDefined();
      expect(await storage.getGroup('b2'), 'b2 没回到会话列表').toBeDefined();
      expect((await storage.listTrash()).filter((entry) => entry.group.tabs.length > 0)).toHaveLength(0);
      // 整行被用户处理掉了 ⇒ 必须留标记，否则对面那一行下一轮又并回来
      const markers = (await storage.listTombstones()).filter((item) => item.entityType === 'trash');
      expect(markers.map((item) => item.entityId).sort()).toEqual(['b1', 'b2']);
      expect(wrapper.find('[data-testid="trash-message"]').text()).toContain('Restored 2 sessions and 0 records');
      // 跑完要清空勾选：留着的话用户接着点会话列表那颗按钮会打到刚被还原的行上
      expect(checkedOf(rowBoxes(wrapper))).toBe(0);
      wrapper.unmount();
    });

    /** 两步确认：第一下只出确认条，一行都不许少。 */
    it('「彻底删除所选」第一下只问一句，第二下才真删', async () => {
      const storage = await seedTwoRows();
      const wrapper = mount(TrashPanel);
      await flush();

      await wrapper.find('[data-testid="trash-check-b1"]').setValue(true);
      await wrapper.find('[data-testid="trash-bulk-purge"]').trigger('click');

      expect(wrapper.find('[data-testid="trash-bulk-confirm"]').text()).toContain(
        'Delete 1 sessions and 0 records permanently',
      );
      expect(await storage.getGroup('b1'), '第一步就删了：确认条还没点就动了数据').toBeUndefined();
      expect((await storage.listTrash()).filter((entry) => entry.group.tabs.length > 0)).toHaveLength(2);

      await wrapper.find('[data-testid="trash-bulk-purge-no"]').trigger('click');
      expect(wrapper.find('[data-testid="trash-bulk-confirm"]').exists()).toBe(false);
      expect((await storage.listTrash()).filter((entry) => entry.group.tabs.length > 0)).toHaveLength(2);
      expect(checkedOf(rowBoxes(wrapper))).toBe(1);

      await wrapper.find('[data-testid="trash-bulk-purge"]').trigger('click');
      await wrapper.find('[data-testid="trash-bulk-purge-yes"]').trigger('click');
      await flush();

      const left = (await storage.listTrash()).filter((entry) => entry.group.tabs.length > 0);
      expect(left.map((entry) => entry.group.id)).toEqual(['b2']);
      expect((await storage.listTombstones()).filter((item) => item.entityType === 'trash').map((i) => i.entityId)).toEqual(['b1']);
      expect(wrapper.find('[data-testid="trash-message"]').text()).toContain('Deleted 1 sessions and 0 records permanently');
      wrapper.unmount();
    });

    /** 壳行（既有约定 那种零可见记录的凭证行）既不该露出，也不该被批量挑中。 */
    it('壳行不进列表、也选不到：全选的数量里没有它', async () => {
      const storage = createStoragePort();
      await seedDeleted('shell', 1, Date.now());
      // 把那唯一一条还原掉 ⇒ 行留下但零可见记录
      const row = (await storage.listTrash())[0]!;
      await restoreTrashTab({ storage }, { groupId: row.group.id, tabId: row.group.tabs[0]!.id, at: Date.now() });

      const wrapper = mount(TrashPanel);
      await flush();
      expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(0);
      expect(wrapper.text()).toContain('Recycle bin is empty');

      // 正向对照：另一行是可见的，全选只能挑中它一个
      await seedDeleted('visible', 2, Date.now());
      await flush();
      await flush();
      await wrapper.find('[data-testid="trash-check-visible"]').setValue(true);
      await wrapper.find('[data-testid="trash-bulk-all"]').trigger('click');
      expect(checkedOf(rowBoxes(wrapper))).toBe(1);
      expect(summary(wrapper)).toContain('1 sessions');
      expect(summary(wrapper)).toContain('0 records');
      wrapper.unmount();
    });
  });
});

/**
 * 行内记录级多选+ 三态层级（**既有约定 修订 0087 的第⑥条**）。
 *
 * 判据从"两套勾选不会同时成立"换成"行首框是这一行的全选 / 半选"。0087 那条互斥在真机上
 * 被他当场读成 bug（「点击标签组选中后，标签组内的标签无法选中」）—— 它不是 bug，但
 * **跨行可以混选、同行不行**这个不对称确实就是坏了的样子。现在要钉的是三件事：
 * ① 行内那颗**永远能点**（不再吞点击）；② 行首框的三态与它派生出的批量目标；
 * ③ 勾满一行 = 按整行处理（写整行标记、不留壳行），没勾满 = 逐条处理（行继续躺）。
 * 计数不重复：一行被算进"标签组"之后，它那些记录不再被算进"记录"。
 */
describe('回收站 · 两种粒度与三态层级（既有约定 + 既有约定）', () => {
  const recordBox = (wrapper: VueWrapper, tabId: string) =>
    wrapper.find(`[data-testid="record-check-${tabId}"]`);
  const rowBox = (wrapper: VueWrapper, groupId: string) =>
    wrapper.find(`[data-testid="trash-check-${groupId}"]`);
  const isChecked = (node: DOMWrapper<Element>): boolean =>
    (node.element as HTMLInputElement).checked;
  const isIndeterminate = (node: DOMWrapper<Element>): boolean =>
    (node.element as HTMLInputElement).indeterminate;
  const summary = (wrapper: VueWrapper): string =>
    wrapper.find('[data-testid="trash-bulk-summary"]').text();

  async function seedTwoRowsWithRecords() {
    const storage = createStoragePort();
    await seedDeleted('r1', 2, Date.now());
    await seedDeleted('r2', 2, Date.now());
    return storage;
  }

  it('勾两条不同行的记录 ⇒ 批量条出现，汇总说"0 个标签组 · 2 条记录"', async () => {
    await seedTwoRowsWithRecords();
    const wrapper = mount(TrashPanel);
    await flush();

    await recordBox(wrapper, 'r1-t0').setValue(true);
    await recordBox(wrapper, 'r2-t0').setValue(true);

    expect(wrapper.find('[data-testid="trash-bulk-bar"]').exists()).toBe(true);
    expect(summary(wrapper)).toContain('0 sessions');
    expect(summary(wrapper)).toContain('2 records');
    // 两行都没被勾满 ⇒ 行首框都是半选，谁也没被牵连
    expect(isIndeterminate(rowBox(wrapper, 'r1'))).toBe(true);
    expect(isIndeterminate(rowBox(wrapper, 'r2'))).toBe(true);
    expect(wrapper.findAll('[data-testid="trash-row"]')).toHaveLength(2);
    wrapper.unmount();
  });

  /** 这条就是用户报的那个"选不了"：上一版在这里吞点击并灰掉行内框。 */
  it('只勾一行里的一条 ⇒ 行首框半选，再点同另一条仍然点得动', async () => {
    await seedTwoRowsWithRecords();
    const wrapper = mount(TrashPanel);
    await flush();

    await recordBox(wrapper, 'r1-t0').setValue(true);
    expect(isIndeterminate(rowBox(wrapper, 'r1'))).toBe(true);
    expect(isChecked(rowBox(wrapper, 'r1'))).toBe(false);

    await recordBox(wrapper, 'r1-t1').setValue(true);
    // 勾满 ⇒ 行首框从半选变成勾选，且不再有"禁用"这种状态
    expect(isIndeterminate(rowBox(wrapper, 'r1'))).toBe(false);
    expect(isChecked(rowBox(wrapper, 'r1'))).toBe(true);
    expect(isChecked(recordBox(wrapper, 'r1-t0'))).toBe(true);
    expect(isChecked(recordBox(wrapper, 'r1-t1'))).toBe(true);

    // 两个数不重复计：这一行算"1 个标签组"，另一行那条才算"1 条记录"
    await recordBox(wrapper, 'r2-t0').setValue(true);
    expect(summary(wrapper)).toContain('1 sessions');
    expect(summary(wrapper)).toContain('1 records');
    wrapper.unmount();
  });

  /**
   * ★ 他报的正是这一下：整行勾上之后去点组里的某一条。上一版在这里**吞掉点击**并把那颗框灰掉，
   * 表现就是「标签组内的标签无法选中」。
   *
   * ⚠ 这条是被变异逼出来的：把 0087 的互斥加回 `toggleRecord`（整行已全选时 return），
   * 前面那几条**一条都没红** —— 它们要么从行内框开始点，要么只点一次行首框，
   * 恰好都绕开了"已全覆盖之后再取消一条"这条路径。
   */
  it('整行已全选时再点某一条 ⇒ 那一条被取消、这一行退回半选（不吞点击、不变灰）', async () => {
    await seedTwoRowsWithRecords();
    const wrapper = mount(TrashPanel);
    await flush();

    await rowBox(wrapper, 'r1').setValue(true);
    expect(isChecked(recordBox(wrapper, 'r1-t0'))).toBe(true);
    expect(isChecked(recordBox(wrapper, 'r1-t1'))).toBe(true);
    expect(summary(wrapper)).toContain('1 sessions');
    expect(isChecked(recordBox(wrapper, 'r1-t1')), '行内那颗不该被禁用').toBe(true);

    await recordBox(wrapper, 'r1-t1').setValue(false);
    expect(isChecked(recordBox(wrapper, 'r1-t1'))).toBe(false);
    expect(isChecked(rowBox(wrapper, 'r1'))).toBe(false);
    expect(isIndeterminate(rowBox(wrapper, 'r1'))).toBe(true);
    // 这一行不再被整行覆盖 ⇒ 剩下那条改算"记录"，两个数仍然不重复计
    expect(summary(wrapper)).toContain('0 sessions');
    expect(summary(wrapper)).toContain('1 records');
    wrapper.unmount();
  });

  it('点行首框 = 这一行全选；再点只清空这一行，别行的勾选不动', async () => {    await seedTwoRowsWithRecords();
    const wrapper = mount(TrashPanel);
    await flush();

    await recordBox(wrapper, 'r2-t0').setValue(true);
    await rowBox(wrapper, 'r1').setValue(true);

    expect(isChecked(recordBox(wrapper, 'r1-t0'))).toBe(true);
    expect(isChecked(recordBox(wrapper, 'r1-t1'))).toBe(true);
    expect(summary(wrapper)).toContain('1 sessions');
    expect(summary(wrapper)).toContain('1 records');

    await rowBox(wrapper, 'r1').setValue(false);
    expect(isChecked(recordBox(wrapper, 'r1-t0'))).toBe(false);
    expect(isChecked(recordBox(wrapper, 'r1-t1'))).toBe(false);
    expect(isChecked(recordBox(wrapper, 'r2-t0')), '清空这一行却把别行的勾选也带走').toBe(true);
    expect(summary(wrapper)).toContain('0 sessions');
    expect(summary(wrapper)).toContain('1 records');
    wrapper.unmount();
  });

  /**
   * 勾满一行按整行处理 —— 这一条是"层级"与"两种独立选择"唯一的实质差别，所以钉在存储上：
   * 整行还原走 `restoreFromTrash`（撤销组墓碑 + 写整行标记、**不留壳行**），
   * 而不是逐条 `restoreTrashTab` 之后剩一条替凭证记账的壳。
   */
  it('勾满一行再点「还原所选」⇒ 走整行路径：会话完整回来、这一行连凭证一起清掉', async () => {
    const storage = await seedTwoRowsWithRecords();
    const wrapper = mount(TrashPanel);
    await flush();

    await rowBox(wrapper, 'r1').setValue(true);
    await wrapper.find('[data-testid="trash-bulk-restore"]').trigger('click');
    await flush();
    await flush();

    expect((await storage.getGroup('r1'))?.tabs.map((tab) => tab.id)).toEqual(['r1-t0', 'r1-t1']);
    expect(
      (await storage.listTrash()).find((entry) => entry.group.id === 'r1'),
      '整行还原之后不该还剩一行',
    ).toBeUndefined();
    const markers = (await storage.listTombstones()).filter((item) => item.entityType === 'trash');
    expect(markers.map((item) => item.entityId)).toEqual(['r1']);
    expect(wrapper.text()).toContain('Restored 1 sessions and 0 records');
    wrapper.unmount();
  });

  it('「还原所选」只把勾到的那两条放回各自会话，行里剩下的继续躺', async () => {
    const storage = await seedTwoRowsWithRecords();
    const wrapper = mount(TrashPanel);
    await flush();

    await recordBox(wrapper, 'r1-t0').setValue(true);
    await recordBox(wrapper, 'r2-t1').setValue(true);
    await wrapper.find('[data-testid="trash-bulk-restore"]').trigger('click');
    await flush();
    await flush();

    expect((await storage.getGroup('r1'))?.tabs.map((tab) => tab.id)).toEqual(['r1-t0']);
    expect((await storage.getGroup('r2'))?.tabs.map((tab) => tab.id)).toEqual(['r2-t1']);
    const rows = await storage.listTrash();
    expect(rows.map((entry) => entry.group.id).sort()).toEqual(['r1', 'r2']);
    expect(rows.find((entry) => entry.group.id === 'r1')?.group.tabs.map((tab) => tab.id)).toEqual(['r1-t1']);
    expect(rows.find((entry) => entry.group.id === 'r2')?.group.tabs.map((tab) => tab.id)).toEqual(['r2-t0']);
    expect(wrapper.text()).toContain('Restored 0 sessions and 2 records');
    wrapper.unmount();
  });

  /**
   * 原来这条取的是**同一行的两条**，而"同一行两条全选"在 既有约定 之后就是整行 ——
   * 所以改成两行各取一条，才还在测"记录级"。这是**改判**，不是把断言改松。
   */
  it('记录级「彻底删除」也是两步，第二下只删勾到的那两条、两行都不消失', async () => {
    const storage = await seedTwoRowsWithRecords();
    const wrapper = mount(TrashPanel);
    await flush();

    await recordBox(wrapper, 'r1-t0').setValue(true);
    await recordBox(wrapper, 'r2-t0').setValue(true);
    await wrapper.find('[data-testid="trash-bulk-purge"]').trigger('click');

    expect(wrapper.find('[data-testid="trash-bulk-confirm"]').text()).toContain('0 sessions and 2 records');
    // 第一下只问，什么都不删
    expect((await storage.listTrash()).find((entry) => entry.group.id === 'r1')?.group.tabs).toHaveLength(2);

    await wrapper.find('[data-testid="trash-bulk-purge-yes"]').trigger('click');
    await flush();
    await flush();

    const rows = await storage.listTrash();
    expect(rows.map((entry) => entry.group.id).sort()).toEqual(['r1', 'r2']);
    expect(rows.find((entry) => entry.group.id === 'r1')?.group.tabs.map((tab) => tab.id)).toEqual(['r1-t1']);
    expect(rows.find((entry) => entry.group.id === 'r2')?.group.tabs.map((tab) => tab.id)).toEqual(['r2-t1']);
    // 没删空 ⇒ 不写整行标记（逐条的凭证记在行里，既有约定）
    expect((await storage.listTombstones()).filter((item) => item.entityType === 'trash')).toHaveLength(0);
    expect(wrapper.text()).toContain('Deleted 0 sessions and 2 records permanently');
    wrapper.unmount();
  });
});
