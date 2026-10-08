import { beforeEach, describe, expect, it } from 'vitest';
import { createStoragePort, groupIdsFrom } from '@/infrastructure/storage/wxt-storage';
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  STORAGE_KEYS,
  SYNC_EVENT_LIMIT,
  SYNC_EVENT_SUMMARY_MAX,
} from '@/shared/constants';
import { clampRailWidth, mergeUiPrefs, railWidthCeiling } from '@/core/domain/ui-prefs';
import type { SavedTab, TabGroup, TrashEntry } from '@/shared/types';

function savedTab(groupId: string, id: string, sortOrder: number): SavedTab {
  return {
    id,
    groupId,
    url: `https://example.com/${id}`,
    title: `页面 ${id}`,
    createdAt: 1_700_000_000_000,
    sortOrder,
    originalIndex: sortOrder,
    originalPinned: false,
    wasActive: false,
    closeState: 'closed',
    restorable: true,
  };
}

function group(id: string, tabs: SavedTab[], overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    title: `分组 ${id}`,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    isPinned: false,
    locked: false,
    sortOrder: 0,
    tabs,
    ...overrides,
  };
}

const rawKeys = async (): Promise<string[]> =>
  Object.keys(((await browser.storage.local.get(null)) ?? {}) as Record<string, unknown>).sort();

describe('StoragePort', () => {
  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
  });

  it('写入时确认测试环境的 browser 就是 fakeBrowser（否则下面全部断言都是假的）', async () => {
    const port = createStoragePort();
    await port.putGroup(group('a', [savedTab('a', 't1', 0)]));
    const raw = (await fakeBrowser.storage.local.get(null)) ?? {};
    expect(Object.keys(raw)).toContain(STORAGE_KEYS.group('a'));
    expect(raw[STORAGE_KEYS.group('a')]).toBeDefined();
  });

  it('putGroup 同步 index，removeGroup 连元数据兄弟键一起删', async () => {
    const port = createStoragePort();
    await port.putGroup(group('g1', [savedTab('g1', 't1', 0), savedTab('g1', 't2', 1)]));

    const index = await port.listGroupIndex();
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ id: 'g1', tabCount: 2 });

    // 先制造一个 "$" 元数据兄弟键（真实场景里由迁移产生）
    await fakeBrowser.storage.local.set({ [`${STORAGE_KEYS.group('g1')}$`]: { v: 1 } });
    expect(await rawKeys()).toContain(`${STORAGE_KEYS.group('g1')}$`);

    await port.removeGroup('g1');

    const keys = await rawKeys();
    expect(keys).not.toContain(STORAGE_KEYS.group('g1'));
    expect(keys).not.toContain(`${STORAGE_KEYS.group('g1')}$`); // removeMeta: true 的证据
    expect(await port.listGroupIndex()).toEqual([]);
  });

  it('groupIdsFrom 忽略 "$" 兄弟键', () => {
    expect(
      groupIdsFrom({
        'shitab:group:a': {},
        'shitab:group:a$': { v: 1 },
        'shitab:group:b': {},
        'shitab:meta': {},
      }),
    ).toEqual(['a', 'b']);
  });

  it('heal：index 有但 group 缺 => 剔除', async () => {
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.groupIndex]: [
        { id: 'ghost', title: 'x', isPinned: false, sortOrder: 0, createdAt: 1, updatedAt: 1, tabCount: 3 },
      ],
    });
    const port = createStoragePort();
    const report = await port.heal();

    expect(report.droppedFromIndex).toBe(1);
    expect(await port.listGroupIndex()).toEqual([]);
  });

  it('heal：group 在但 index 缺 => 重建，且不会把 "$" 当成一个组', async () => {
    const g = group('orphan', [savedTab('orphan', 't1', 0)]);
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.group('orphan')]: g,
      [`${STORAGE_KEYS.group('orphan')}$`]: { v: 1 },
      'shitab:group:': { junk: true }, // 病态键：前缀本身也不该被当成组
    });

    const port = createStoragePort();
    const report = await port.heal();

    // 只有 orphan 被重建；带 $ 的元数据键与空后缀键都不进 index
    expect(report.rebuiltIntoIndex).toBe(1);
    const index = await port.listGroupIndex();
    expect(index.map((entry) => entry.id)).toEqual(['orphan']);
    expect(index[0]?.tabCount).toBe(1);
  });

  it('heal：tabCount 与实际内容不符时以 group 为准修正', async () => {
    const g = group('g2', [savedTab('g2', 't1', 0)]);
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.group('g2')]: g,
      [STORAGE_KEYS.groupIndex]: [
        { id: 'g2', title: g.title, isPinned: false, sortOrder: 0, createdAt: 1, updatedAt: 1, tabCount: 99 },
      ],
    });

    const port = createStoragePort();
    const report = await port.heal();
    expect(report.fixedTabCounts).toBe(1);
    expect((await port.listGroupIndex())[0]?.tabCount).toBe(1);
  });

  /**
   * ★ 既有约定 决定 4 换来的那条**不能省**的分支：heal 现在默认复用整块 `raw`，
   * 但值的版本号 (`$` 兄弟键的 `v`) 不是当前 `GROUP_VERSION` 时必须**退回逐键 `getValue()`** ——
   * 只有那条路径会跑 per-key 迁移。少了这一道，"升级后第一次打开工作台"
   * 就会把 v1 形状的会话原样当 v3 写进 index，`originalIndex` / `locked` 静默丢掉。
   */
  it('heal 碰到旧版本形状的会话时回到逐键路径，把迁移跑完并抬 `$` 版本号', async () => {
    const v1Tabs = [
      { id: 't1', groupId: 'old', url: 'https://example.com/t1', title: '页面 t1', createdAt: 1_700_000_000_000, sortOrder: 0, wasActive: false, closeState: 'closed', restorable: true },
      { id: 't2', groupId: 'old', url: 'https://example.com/t2', title: '页面 t2', createdAt: 1_700_000_000_000, sortOrder: 1, wasActive: true, closeState: 'closed', restorable: true },
    ];
    const v1Group = {
      id: 'old',
      title: '老数据',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      isPinned: false,
      sortOrder: 0,
      tabs: v1Tabs,
    };
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.group('old')]: v1Group,
      [`${STORAGE_KEYS.group('old')}$`]: { v: 1 },
      [STORAGE_KEYS.groupIndex]: [
        { id: 'old', title: '老数据', isPinned: false, sortOrder: 0, createdAt: 1, updatedAt: 1, tabCount: 2 },
      ],
    });

    const port = createStoragePort();
    const report = await port.heal();

    expect(report.fixedTabCounts, '条数本来就对得上，不该报修正').toBe(0);
    const raw = (await fakeBrowser.storage.local.get(null)) as Record<string, unknown>;
    const migrated = raw[STORAGE_KEYS.group('old')] as { locked?: boolean; tabs: { originalIndex?: number; originalPinned?: boolean }[] };
    expect(migrated.tabs.map((tab) => tab.originalIndex)).toEqual([0, 1]);
    expect(migrated.tabs.every((tab) => tab.originalPinned === false)).toBe(true);
    expect(migrated.locked).toBe(false);
    expect((raw[`${STORAGE_KEYS.group('old')}$`] as { v: number }).v, '迁移状态要持久，下次不再跑').toBe(3);

    // 第二趟 heal 走的是稳态分支：值已经是当前版本，直接从 raw 取，不再回读键。
    const second = await createStoragePort().heal();
    expect(second).toMatchObject({ droppedFromIndex: 0, rebuiltIntoIndex: 0, fixedTabCounts: 0 });
  });

  /**
   * ★ 这条钉的是决定 4 **改写到的一处行为**（不是等价改写，得写明）：
   * 键在、index 也在、但值不是一个可用对象（半截写入 / 手工塞进去的）时 ——
   * 旧实现会在 `group.tabs.length` 上抛，整条 `heal()` reject，页面初始化跟着失败；
   * 现在按"读不出来就别动那条 index"处理，自愈继续跑完剩下的键。
   */
  it('heal 碰到读不出形状的会话值时不动作、也不 reject（旧实现会整条抛）', async () => {
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.group('junk')]: '一截写坏的字符串',
      [`${STORAGE_KEYS.group('junk')}$`]: { v: 3 },
      [STORAGE_KEYS.groupIndex]: [
        { id: 'junk', title: '坏键', isPinned: false, sortOrder: 0, createdAt: 1, updatedAt: 1, tabCount: 7 },
        { id: 'good', title: '好的', isPinned: false, sortOrder: 1, createdAt: 1, updatedAt: 1, tabCount: 1 },
      ],
      [STORAGE_KEYS.group('good')]: group('good', [savedTab('good', 't1', 0)]),
      [`${STORAGE_KEYS.group('good')}$`]: { v: 3 },
    });

    const port = createStoragePort();
    const report = await port.heal();

    expect(report.fixedTabCounts, '坏那条没被数出来，就不该报成"修好了一条"').toBe(0);
    expect(report.droppedFromIndex).toBe(0);
    expect(report.groupCount, '两条都还在 index 里').toBe(2);
    const index = await port.listGroupIndex();
    expect((index.find((entry) => entry.id === 'junk') ?? { tabCount: -1 }).tabCount, '坏那条原样留着').toBe(7);
    expect(index.find((entry) => entry.id === 'good')?.tabCount).toBe(1);
  });

  it('键在、index 缺、值又读不出来 => 连元数据一起清掉（这条决定 4 一个字没动）', async () => {
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.group('broken')]: '一截写坏的字符串',
      [`${STORAGE_KEYS.group('broken')}$`]: { v: 3 },
    });

    const port = createStoragePort();
    const report = await port.heal();

    expect(report.droppedFromIndex).toBe(1);
    const keys = await rawKeys();
    expect(keys, '孤儿键与它的 $ 兄弟键都要消失').not.toContain(STORAGE_KEYS.group('broken'));
    expect(keys).not.toContain(`${STORAGE_KEYS.group('broken')}$`);
  });

  /**
   * `listAllGroups()` 2026-10-06 改成"一次批量读 + `groupFromRaw`"（和 `heal()` 同一手法）。
   * 语义要逐条钉住 —— 它是同步 / 导入导出 / 耐久快照唯一的整份入口，读错一处就是写坏远端载荷。
   */
  it('listAllGroups：索引为准；旧版本号的会话回源跑迁移；缺键与读不出形状的跳过', async () => {
    const storage = createStoragePort();
    const good = group('ok', [savedTab('ok', 't1', 0), savedTab('ok', 't2', 1)]);
    await storage.putGroup(good);
    const index = await storage.listGroupIndex();

    await fakeBrowser.storage.local.set({
      // 1) 索引里有、键没有 ⇒ 跳过（与旧的 `?? undefined` + filter 同一处置）
      [STORAGE_KEYS.groupIndex]: [
        ...index,
        { id: 'ghost', title: '缺键', isPinned: false, locked: false, sortOrder: 5, createdAt: 1, updatedAt: 1, tabCount: 1 },
        // 2) 半截写入 ⇒ 跳过
        { id: 'junk', title: '坏值', isPinned: false, locked: false, sortOrder: 6, createdAt: 1, updatedAt: 1, tabCount: 1 },
        // 3) 旧版本号 ⇒ 必须回源跑迁移，返回迁移后的形状
        { id: 'old', title: '老数据', isPinned: false, locked: false, sortOrder: 7, createdAt: 1, updatedAt: 1, tabCount: 1 },
      ],
      [STORAGE_KEYS.group('junk')]: '一截写坏的字符串',
      [`${STORAGE_KEYS.group('junk')}$`]: { v: 3 },
      [STORAGE_KEYS.group('old')]: {
        id: 'old',
        title: '老数据',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        isPinned: false,
        sortOrder: 0,
        // v1 形状的 tab：没有 originalIndex / originalPinned
        tabs: [{ id: 'old-t0', groupId: 'old', url: 'https://a.test/0', title: '零', createdAt: 1, sortOrder: 0, wasActive: true, closeState: 'closed', restorable: true }],
      },
      [`${STORAGE_KEYS.group('old')}$`]: { v: 1 },
    });

    const groups = await storage.listAllGroups();
    expect(groups.map((item) => item.id).sort(), 'ghost 与 junk 都不该被当成一个会话').toEqual(['ok', 'old']);
    const migrated = groups.find((item) => item.id === 'old');
    expect(migrated?.locked, '走的是逐键回源，迁移链要跑完（v3 补 locked）').toBe(false);
    expect(migrated?.tabs[0]?.originalIndex, 'v1→v2 的 originalIndex 要补上').toBe(0);
  });

  /**
   * ★ 这条记的是**修正**，不是等价改写：旧实现 `Promise.all(...getValue())` 配 `filter(Boolean)`，
   * 一个非空字符串会被**当成一个会话带进快照**（那是往远端写垃圾的形状）。
   */
  it('listAllGroups 不把读不出形状的键当会话（旧实现会）', async () => {
    const storage = createStoragePort();
    await storage.putGroup(group('real', [savedTab('real', 't1', 0)]));
    const index = await storage.listGroupIndex();
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.groupIndex]: [
        ...index,
        { id: 'junk', title: '坏值', isPinned: false, locked: false, sortOrder: 9, createdAt: 1, updatedAt: 1, tabCount: 1 },
      ],
      [STORAGE_KEYS.group('junk')]: '一截写坏的字符串',
      [`${STORAGE_KEYS.group('junk')}$`]: { v: 3 },
    });

    const ids = (await storage.listAllGroups()).map((item) => item.id);
    expect(ids, '字符串不是会话，不许进快照').toEqual(['real']);
  });

  it('heal 幂等：第二次跑不再报告任何修复', async () => {
    const port = createStoragePort();
    await port.putGroup(group('g3', [savedTab('g3', 't1', 0)]));
    await port.heal();
    const second = await port.heal();
    expect(second).toMatchObject({ droppedFromIndex: 0, rebuiltIntoIndex: 0, fixedTabCounts: 0 });
  });

  it('watchGroups 在本上下文写入后触发（跨 surface 同步的机制前提）', async () => {
    const port = createStoragePort();
    let calls = 0;
    const stop = port.watchGroups(() => {
      calls += 1;
    });

    await port.putGroup(group('g4', [savedTab('g4', 't1', 0)]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();

    expect(calls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 界面偏好：单独一键、读时夹范围、不进备份
// ---------------------------------------------------------------------------

describe('界面偏好', () => {
  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
  });

  it('往返：写进去的宽度读得回来，且落在自己的键上', async () => {
    const port = createStoragePort();
    await port.setUiPrefs({ railWidth: 320 });

    expect((await port.getUiPrefs()).railWidth).toBe(320);
    const raw = (await fakeBrowser.storage.local.get(null)) ?? {};
    expect(Object.keys(raw)).toContain(STORAGE_KEYS.ui);
    expect(raw[STORAGE_KEYS.ui]).toEqual({ railWidth: 320 });
  });

  /**
   * 适配器只能按**静态**区间夹（service worker 里没有 window，读不到视口），
   * 按窗口再夹一道是渲染方的事。这条断言把这个分工钉住：420 以上一律变 420，而不是"原样吐回来"。
   */
  it('库里写着越界值时读出来是夹好的', async () => {
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.ui]: { railWidth: 99_999 } });
    expect((await createStoragePort().getUiPrefs()).railWidth).toBe(RAIL_WIDTH_MAX);

    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.ui]: { railWidth: 1 } });
    expect((await createStoragePort().getUiPrefs()).railWidth).toBe(RAIL_WIDTH_MIN);
  });

  it('键缺失 / 形状不对 / 值不是数字：一律回默认宽度，不返回 undefined 也不返回 NaN', async () => {
    expect((await createStoragePort().getUiPrefs()).railWidth).toBe(RAIL_WIDTH_DEFAULT);

    for (const junk of [null, undefined, 'wide', {}, { railWidth: 'wide' }, { railWidth: NaN }, 42]) {
      await fakeBrowser.storage.local.set({ [STORAGE_KEYS.ui]: junk });
      expect((await createStoragePort().getUiPrefs()).railWidth, `${JSON.stringify(junk)}`).toBe(
        RAIL_WIDTH_DEFAULT,
      );
    }
  });

  it('watchUiPrefs 在本上下文写入后触发（"另一个窗口拖了宽度，这边跟着变"的机制前提）', async () => {
    const port = createStoragePort();
    const seen: number[] = [];
    const stop = port.watchUiPrefs((prefs) => seen.push(prefs.railWidth));

    await port.setUiPrefs({ railWidth: 300 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    await port.setUiPrefs({ railWidth: 340 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(seen).toEqual([300]);
  });

  it('界面偏好不参与 heal，也不被 group 前缀扫描误认成一个组', async () => {
    const port = createStoragePort();
    await port.setUiPrefs({ railWidth: 280 });
    await port.putGroup(group('g9', [savedTab('g9', 't1', 0)]));

    const report = await port.heal();
    expect(report).toMatchObject({ droppedFromIndex: 0, rebuiltIntoIndex: 0, groupCount: 1 });
    expect((await port.getUiPrefs()).railWidth).toBe(280);
  });
});

describe('宽度夹取（纯函数，既有约定 的唯一口径）', () => {
  it('上限取 min(420, 40% 视口)，视口拿不到时退回静态上限', () => {
    expect(railWidthCeiling(1_920)).toBe(RAIL_WIDTH_MAX); // 40% = 768 > 420
    expect(railWidthCeiling(1_000)).toBe(400);
    expect(railWidthCeiling(700)).toBe(280);
    for (const unusable of [0, -1, Number.NaN]) expect(railWidthCeiling(unusable)).toBe(RAIL_WIDTH_MAX);
  });

  /**
   * 窗口窄到 40% 还不到下限时，**下限赢**。
   * 反过来（上限赢）会给出 `max > min` 的倒挂区间，`clamp` 的结果随实现而变，
   * 界面表现为"侧栏挤成一条线、分类名全看不见了"。
   */
  it('极窄窗口里不会给出倒挂区间', () => {
    expect(railWidthCeiling(300)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(420, 300)).toBe(RAIL_WIDTH_MIN);
  });

  it('夹取：区间内原样、越界贴边、小数取整、非数字回默认', () => {
    expect(clampRailWidth(248, 1_200)).toBe(248);
    expect(clampRailWidth(199, 1_200)).toBe(RAIL_WIDTH_MIN);
    expect(clampRailWidth(421, 1_200)).toBe(RAIL_WIDTH_MAX);
    expect(clampRailWidth(300.6, 1_200)).toBe(301);
    for (const junk of ['300', undefined, null, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(clampRailWidth(junk, 1_200)).toBe(RAIL_WIDTH_DEFAULT);
    }
  });

  it('mergeUiPrefs 只认自己知道的键（与 mergeSettings 同一套哲学）', () => {
    expect(mergeUiPrefs({ railWidth: 300, lastFilter: 'c1' })).toEqual({ railWidth: 300 });
    expect(mergeUiPrefs(undefined)).toEqual({ railWidth: RAIL_WIDTH_DEFAULT });
  });
});

// ---------------------------------------------------------------------------
// 回收站的存储面：同步要能整块覆写，顺序必须可交换，面板要收得到变化
// ---------------------------------------------------------------------------

describe('回收站的整块读写与订阅', () => {
  function entry(groupId: string, deletedAt: number): TrashEntry {
    return {
      group: group(groupId, [savedTab(groupId, `${groupId}-t0`, 0)]),
      deletedAt,
      expiresAt: deletedAt + 86_400_000,
      reason: 'user-delete',
    };
  }

  const idsOf = (port: ReturnType<typeof createStoragePort>) => port.listTrash().then((items) => items.map((item) => item.group.id));

  it('setTrash 是整块覆写：本机原来那一行不会留在盘上', async () => {
    const port = createStoragePort();
    await port.putTrash(entry('old', 10));
    await port.setTrash([entry('new', 20)]);
    expect(await idsOf(port)).toEqual(['new']);

    await port.setTrash([]);
    expect(await port.listTrash()).toEqual([]);
  });

  /**
   * 同一删除时刻的两行按 id 定序。这条 tiebreak 看着像洁癖，实际是"别每轮同步都推一个新快照"：
   * 数组顺序进 checksum，两边各按"我这边先写谁"排，算出来就是两个值。
   */
  it('写入顺序不影响存储顺序（顺序进 checksum），而主序仍然是最新在前', async () => {
    const port = createStoragePort();
    await port.setTrash([entry('b', 100), entry('a', 100)]);
    const first = await idsOf(port);
    await port.setTrash([entry('a', 100), entry('b', 100)]);
    expect(await idsOf(port)).toEqual(first);
    expect(first).toEqual(['a', 'b']);

    // 正向对照：加了 tiebreak 不该把"最新在前"这条主轴改掉
    await port.setTrash([entry('z', 300), entry('y', 200)]);
    expect(await idsOf(port)).toEqual(['z', 'y']);
  });

  it('watchTrash 在写入后触发（后台同步落库要让面板重读，不然用户看到的是上次打开时那份）', async () => {
    const port = createStoragePort();
    const seen: number[] = [];
    const stop = port.watchTrash((items) => seen.push(items.length));

    await port.setTrash([entry('w', 100)]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 同步事件日志的存储面：环形 100、空转不落盘由引擎负责，这里只管环与"永不拖累主流程"
// ---------------------------------------------------------------------------

describe('同步事件环形缓冲', () => {
  // 这一节是**顶层** describe，吃不到上面 `describe('StoragePort')` 里那条 beforeEach。
  // 少了它，上一节的残留会让"环 100"那两条断言打在别人的数据上（第一次跑就是这么红的）。
  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
  });

  const push = (
    port: ReturnType<typeof createStoragePort>,
    at: number,
    summary?: string,
  ) => port.appendSyncEvent({ kind: 'push', success: true, summary }, at);

  it('空的时候是空数组，不是 undefined（UI 直接 .reverse() 不能炸）', async () => {
    const port = createStoragePort();
    expect(await port.listSyncEvents()).toEqual([]);
  });

  it('id 与 at 由端口生成；传 at 就用那一次同步的时刻；按 at 升序存', async () => {
    const port = createStoragePort();
    const first = await push(port, 2_000);
    const second = await push(port, 1_000);

    expect(first.id).toBeTruthy();
    expect(first.at).toBe(2_000);
    // 正向对照：两次都真的落盘了，否则"升序"这条判据可以打在空集上
    const stored = await port.listSyncEvents();
    expect(stored.map((event) => event.at)).toEqual([1_000, 2_000]);
    expect(stored.map((event) => event.id)).toEqual([second.id, first.id]);
  });

  /**
   * 传进来的 `at` 与上面那条不同：这里钉的是"**存储里永远是升序**"这条合同本身。
   * UI 反转取最新在上、以及裁剪"只裁最旧"这两件事都只在这个前提成立时才安全，
   * 而它不该依赖调用方（引擎）守规矩。
   */
  it('写入顺序打乱也不影响存储秩序', async () => {
    const port = createStoragePort();
    await port.appendSyncEvent({ kind: 'error', success: false, summary: 'err:network' }, 300);
    await port.appendSyncEvent({ kind: 'pull', success: true, summary: 'merged:1' }, 100);
    await port.appendSyncEvent({ kind: 'push', success: true, summary: 'R2' }, 200);
    expect((await port.listSyncEvents()).map((event) => event.at)).toEqual([100, 200, 300]);
  });

  /** 等值 `at`（同一毫秒里两条）不许被排序打乱 —— 环形裁剪认的就是这个先后。 */
  it('同一个 `at` 的多条保留写入先后', async () => {
    const port = createStoragePort();
    await push(port, 500, 'R1');
    await push(port, 500, 'R2');
    expect((await port.listSyncEvents()).map((event) => event.summary)).toEqual(['R1', 'R2']);
  });

  it('满环之后只留最近 100 条：最旧的那条被挤出去，最新的一条一定在', async () => {
    const port = createStoragePort();
    for (let index = 1; index <= SYNC_EVENT_LIMIT + 5; index += 1) {
      await push(port, 1_000 + index, `R${index}`);
    }
    const stored = await port.listSyncEvents();

    expect(stored).toHaveLength(SYNC_EVENT_LIMIT);
    // 正向对照：最新那条在（否则"裁剪"可能裁反了方向，那才是真正的事故）
    expect(stored[stored.length - 1]?.summary).toBe(`R${SYNC_EVENT_LIMIT + 5}`);
    expect(stored[stored.length - 1]?.at).toBe(1_000 + SYNC_EVENT_LIMIT + 5);
    // 反方向：最旧的那 5 条已经不在了
    expect(stored[0]?.summary).toBe(`R6`);
    expect(stored.some((event) => event.summary === 'R1')).toBe(false);
    expect(stored.map((event) => event.at)).toEqual([...stored.map((event) => event.at)].sort((a, b) => a - b));
  });

  it('summary 截到 80 字符以内，且用 Array.from 不切断多字节', async () => {
    const port = createStoragePort();
    const long = await port.appendSyncEvent({
      kind: 'error',
      success: false,
      summary: `err:invalid-local:${'坏'.repeat(120)}`,
    }, 1_000);
    // 正向对照：短的一个字都没被动过
    const short = await port.appendSyncEvent({ kind: 'push', success: true, summary: 'R12 · merged:3' }, 1_001);

    expect(Array.from(long.summary ?? '')).toHaveLength(SYNC_EVENT_SUMMARY_MAX);
    expect((long.summary ?? '').endsWith('坏')).toBe(true);
    expect(short.summary).toBe('R12 · merged:3');
  });

  it('trigger 与 summary 都是可选的：没传就不该在记录里留下一个 undefined 键', async () => {
    const port = createStoragePort();
    const bare = await port.appendSyncEvent({ kind: 'pull', success: true }, 1_000);
    const full = await port.appendSyncEvent({ kind: 'push', success: true, trigger: 'manual', summary: 'R3' }, 1_001);

    expect(Object.keys(bare).sort()).toEqual(['at', 'id', 'kind', 'success']);
    // 正向对照：给了就必须真的带上，否则"这一轮是谁叫醒的"那一列永远是空的
    expect(full.trigger).toBe('manual');
    expect(full.summary).toBe('R3');
  });

  /**
   * 这一条是这条线的存在理由：**日志写失败永不影响同步主流程**。
   * 存储坏掉的时候 `appendSyncEvent` 返回一条内存记录、不抛 —— 否则一次配额溢出
   * 就会把一次本来能成的同步弄成失败，而日志的价值恰恰是在出问题时还在。
   */
  it('存储写不进去：不抛、照样返回一条记录（且调用方拿到的就是它）', async () => {
    const port = createStoragePort();
    const set = fakeBrowser.storage.local.set;
    (fakeBrowser.storage.local.set as unknown) = async () => {
      throw new Error('quota bytes per bullet exceeded');
    };
    try {
      const record = await port.appendSyncEvent({ kind: 'error', success: false, summary: 'err:network' }, 1_000);
      expect(record.kind).toBe('error');
      expect(record.summary).toBe('err:network');
      expect(record.id).toBeTruthy();
    } finally {
      (fakeBrowser.storage.local.set as unknown) = set;
    }

    // 正向对照：修好之后写读都恢复正常 ⇒ 上面那条不是"整个端口都废了"
    await push(port, 2_000, 'R9');
    expect((await port.listSyncEvents()).map((event) => event.summary)).toContain('R9');
  });

  /**
   * 不进备份这条口径。`snapshotAll()` 是用户下载的那份载荷的**唯一**来源，
   * 它的形状由这四个键钉死；把日志写进去 = 把"这台机器同步过什么"伪造到还原的那台机器上。
   */
  it('事件不进备份载荷', async () => {
    const port = createStoragePort();
    await push(port, 1_000, 'R1');
    const backup = await port.snapshotAll();

    expect(Object.keys(backup).sort()).toEqual(['categories', 'groups', 'meta', 'settings']);
    expect(JSON.stringify(backup)).not.toContain('R1');
    // 正向对照：同一条记录确实在存储里，只是不在备份载荷里
    expect((await port.listSyncEvents()).map((event) => event.summary)).toContain('R1');
  });
});
