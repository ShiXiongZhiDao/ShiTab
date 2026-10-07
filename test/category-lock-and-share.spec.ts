/**
 * V1.2 三件新东西的规则测试：分类、锁定、零权限的"分享"。
 *
 * 分工：
 * - 这份测**用例层与领域层**的规则（谁是写操作、删分类时数据去哪、备份怎么兼容）。
 * - `test/ui-components.spec.ts` 测这些规则在界面上有没有落点。
 * - `test/storage-port.spec.ts` / `test/schema-migration.spec.ts` 测分键布局与迁移。
 *
 * 断言一律钉"数据真变了没"，不钉"函数返回了什么"：分类归属同时存在 index 与 group 键两处，
 * 只改一处的 bug 用返回值是看不出来的。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CategoryNameError,
  CategoryNotFoundError,
  assignGroupToCategory,
  createCategoryCommand,
  deleteCategory,
  renameCategory,
  reorderCategories,
} from '@/core/application/category-commands';
import {
  GroupLockedError,
  deleteGroup,
  deleteTab,
  moveTab,
  renameGroup,
  reorderGroups,
  reorderTab,
  toggleLock,
  togglePin,
} from '@/core/application/group-commands';
import { restoreGroup, restoreTab } from '@/core/application/restore-group';
import {
  buildShareHtml,
  clipboardText,
  clipboardTextOfTab,
  shareFilename,
} from '@/core/application/share';
import {
  buildBackup,
  importBackup,
  serializeBackup,
  validateBackup,
} from '@/core/application/import-export';
import {
  categoryDropIndex,
  countByCategory,
  matchesFilter,
  normalizeCategoryName,
} from '@/core/domain/category';
import { toIndexEntry } from '@/core/domain/group';
import { DEFAULT_SETTINGS } from '@/core/domain/settings';
import { createFakeBrowserTabsPort } from '@/infrastructure/testing/fake-browser-tabs';
import { putEmptyGroup } from './fixtures';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import type { StoragePort } from '@/core/ports/storage';
import type { Category, GroupIndexEntry, SavedTab, TabGroup } from '@/shared/types';

const AT = 1_700_000_000_000;

function tab(groupId: string, id: string, url: string, title: string, over: Partial<SavedTab> = {}): SavedTab {
  return {
    id,
    groupId,
    url,
    title,
    createdAt: AT,
    sortOrder: 0,
    originalIndex: 0,
    originalPinned: false,
    wasActive: false,
    closeState: 'closed',
    restorable: true,
    domain: new URL(url).hostname,
    ...over,
  };
}

function group(id: string, title: string, tabs: SavedTab[] = [], over: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    title,
    createdAt: AT,
    updatedAt: AT,
    isPinned: false,
    locked: false,
    sortOrder: 0,
    tabs,
    ...over,
  };
}

let storage: StoragePort;
const deps = () => ({ storage });

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  storage = createStoragePort();
});

// ---------------------------------------------------------------------------
// 分类
// ---------------------------------------------------------------------------

describe('分类命令', () => {
  it('建类清洗名字，并按 sortOrder 接到末尾', async () => {
    const first = await createCategoryCommand(deps(), { name: '  工作  ' });
    const second = await createCategoryCommand(deps(), { name: '学习' });

    expect(first.name).toBe('工作');
    expect([first.sortOrder, second.sortOrder]).toEqual([0, 1]);
    expect((await storage.listCategories()).map((category) => category.name)).toEqual(['工作', '学习']);
  });

  it('空名与纯空格被拒（不是"自动补一个默认名"）', async () => {
    for (const name of ['', '   ', '\n\t']) {
      await expect(createCategoryCommand(deps(), { name })).rejects.toBeInstanceOf(CategoryNameError);
    }
    expect(await storage.listCategories()).toEqual([]);
  });

  it('重名被拒，大小写不敏感', async () => {
    await createCategoryCommand(deps(), { name: 'Reading' });
    await expect(createCategoryCommand(deps(), { name: 'reading ' })).rejects.toBeInstanceOf(CategoryNameError);
    expect(await storage.listCategories()).toHaveLength(1);
  });

  it('改名生效；改成别人的名字被拒；不存在的分类抛 CategoryNotFoundError', async () => {
    const a = await createCategoryCommand(deps(), { name: 'A' });
    await createCategoryCommand(deps(), { name: 'B' });

    const renamed = await renameCategory(deps(), { categoryId: a.id, name: '  归档  ' });
    expect(renamed.find((category) => category.id === a.id)?.name).toBe('归档');
    expect((await storage.listCategories()).find((category) => category.id === a.id)?.name).toBe('归档');

    await expect(renameCategory(deps(), { categoryId: a.id, name: 'b' })).rejects.toBeInstanceOf(CategoryNameError);
    await expect(renameCategory(deps(), { categoryId: '没有这个类', name: 'C' })).rejects.toBeInstanceOf(
      CategoryNotFoundError,
    );
  });

  it('删分类把里面的会话退回未分类 —— index 与 group 键两处都清', async () => {
    const category = await createCategoryCommand(deps(), { name: '要删的' });
    await storage.putGroup(group('g1', '会话一', [tab('g1', 't1', 'https://a.test/1', 'A')], { categoryId: category.id }));
    await storage.putGroup(group('g2', '会话二', [], { categoryId: category.id }));

    const result = await deleteCategory(deps(), { categoryId: category.id });
    expect(result.released).toBe(2);
    expect(await storage.listCategories()).toEqual([]);

    const index = await storage.listGroupIndex();
    expect(index.map((entry) => entry.categoryId)).toEqual([undefined, undefined]);
    // 第二处：group 键里也不能留。留着的话下一次 putGroup 会把死引用带回 index。
    expect((await storage.getGroup('g1'))?.categoryId).toBeUndefined();
    expect((await storage.getGroup('g2'))?.categoryId).toBeUndefined();
    // 会话本身还在
    expect((await storage.getGroup('g1'))?.title).toBe('会话一');
  });

  it('删不存在的分类抛错，不动数据', async () => {
    await storage.putGroup(group('g1', '会话一'));
    await expect(deleteCategory(deps(), { categoryId: 'nope' })).rejects.toBeInstanceOf(CategoryNotFoundError);
    expect(await storage.listGroupIndex()).toHaveLength(1);
  });

  it('排序重写为稠密 0..n-1', async () => {
    const ids: string[] = [];
    for (const name of ['一', '二', '三']) {
      ids.push((await createCategoryCommand(deps(), { name })).id);
    }
    const moved = await reorderCategories(deps(), { categoryId: ids[2] ?? '', toIndex: 0 });
    expect(moved.map((category) => category.name)).toEqual(['三', '一', '二']);
    expect(moved.map((category) => category.sortOrder)).toEqual([0, 1, 2]);
  });

  /**
   * 拖拽落点 -> toIndex 的换算。
   *
   * 这里必须测**换算 + 真正执行**之后的结果，只测 `categoryDropIndex` 的返回值不够：
   * 坐标系差一格的 bug 表现是"每次拖都偏一位"，函数单看是自洽的、串起来才错。
   * 三行 [一,二,三]，逐一枚举四道缝，每个落点都写出它应该变成的顺序。
   */
  describe('拖拽落点换算（缝号按"被拖的那行也算在内"）', () => {
    const cases: Array<[string, number, number, string[] | null]> = [
      // [说明, 被拖的下标, 落点缝, 期望顺序（null = 不该发生任何写入）]
      ['把「一」拖到它自己上面（缝 0）', 0, 0, null],
      ['把「一」拖到它自己下面（缝 1）', 0, 1, null],
      ['把「一」拖到「二」下面（缝 2）', 0, 2, ['二', '一', '三']],
      ['把「一」拖到最底（缝 3）', 0, 3, ['二', '三', '一']],
      ['把「二」拖到最顶（缝 0）', 1, 0, ['二', '一', '三']],
      ['把「二」拖到它自己的缝里（1）', 1, 1, null],
      ['把「二」拖到它自己下面（缝 2）', 1, 2, null],
      ['把「二」拖到最底（缝 3）', 1, 3, ['一', '三', '二']],
      ['把「三」拖到最顶（缝 0）', 2, 0, ['三', '一', '二']],
      ['把「三」拖到「一」下面（缝 1）', 2, 1, ['一', '三', '二']],
      ['把「三」拖到它自己的缝里（2）', 2, 2, null],
      ['把「三」拖到最底（缝 3）', 2, 3, null],
    ];

    for (const [label, from, slot, expected] of cases) {
      it(label, async () => {
        const ids: string[] = [];
        for (const name of ['一', '二', '三']) {
          ids.push((await createCategoryCommand(deps(), { name })).id);
        }
        const to = categoryDropIndex(from, slot);
        if (expected === null) {
          // -1 是"别写库"的暗号，UI 侧据此跳过 moveCategoryTo（见 components/CategoryRail.vue）
          expect(to).toBe(-1);
          return;
        }
        expect(to).toBeGreaterThanOrEqual(0);
        const moved = await reorderCategories(deps(), { categoryId: ids[from] ?? '', toIndex: to });
        expect(moved.map((category) => category.name)).toEqual(expected);
        expect(moved.map((category) => category.sortOrder)).toEqual([0, 1, 2]);
      });
    }
  });

  it('归类两边都写；重复归到同一个分类是幂等的（不 bump updatedAt）', async () => {
    const category = await createCategoryCommand(deps(), { name: '分类' });
    await storage.putGroup(group('g1', '会话一', [tab('g1', 't1', 'https://a.test/1', 'A')]));
    const before = await storage.getGroup('g1');

    const entry = await assignGroupToCategory(deps(), { groupId: 'g1', categoryId: category.id });
    expect(entry?.categoryId).toBe(category.id);
    expect((await storage.getGroup('g1'))?.categoryId).toBe(category.id);
    const afterFirst = (await storage.getGroup('g1'))?.updatedAt;

    await assignGroupToCategory(deps(), { groupId: 'g1', categoryId: category.id });
    expect((await storage.getGroup('g1'))?.updatedAt).toBe(afterFirst);
    expect(afterFirst).not.toBe(before?.updatedAt);
  });

  it('取消归类 = categoryId 传 undefined，两边都清干净', async () => {
    const category = await createCategoryCommand(deps(), { name: '分类' });
    await storage.putGroup(group('g1', '会话一', [], { categoryId: category.id }));

    await assignGroupToCategory(deps(), { groupId: 'g1', categoryId: undefined });
    expect((await storage.getGroup('g1'))?.categoryId).toBeUndefined();
    expect((await storage.listGroupIndex())[0]?.categoryId).toBeUndefined();
  });

  it('归到不存在的分类抛错，且不留下半截状态', async () => {
    await storage.putGroup(group('g1', '会话一'));
    await expect(
      assignGroupToCategory(deps(), { groupId: 'g1', categoryId: '不存在' }),
    ).rejects.toBeInstanceOf(CategoryNotFoundError);
    expect((await storage.getGroup('g1'))?.categoryId).toBeUndefined();
  });

  it('会话带分类时，index 条目同步带上；默认没锁', async () => {
    const category = await createCategoryCommand(deps(), { name: '分类' });
    const created = await putEmptyGroup(storage, { title: '带分类的会话', categoryId: category.id });
    expect(created.categoryId).toBe(category.id);
    expect(created.locked).toBe(false);
    expect((await storage.listGroupIndex())[0]).toMatchObject({ categoryId: category.id, locked: false });
  });

  it('筛选与计数：未分类单独算', async () => {
    const category = await createCategoryCommand(deps(), { name: '分类' });
    const entries: GroupIndexEntry[] = [
      toIndexEntry(group('a', 'A', [], { categoryId: category.id })),
      toIndexEntry(group('b', 'B')),
      toIndexEntry(group('c', 'C')),
    ];
    expect(entries.filter((entry) => matchesFilter(entry, { kind: 'category', id: category.id })).map((e) => e.id)).toEqual(['a']);
    expect(entries.filter((entry) => matchesFilter(entry, { kind: 'uncategorized' })).map((e) => e.id)).toEqual(['b', 'c']);
    expect(entries.filter((entry) => matchesFilter(entry, { kind: 'all' }))).toHaveLength(3);

    const counts = countByCategory(entries);
    expect(counts.perCategory.get(category.id)).toBe(1);
    expect(counts.uncategorized).toBe(2);
  });

  it('名字长度上限是 60，清洗后不超限', () => {
    expect(normalizeCategoryName('x'.repeat(80))).toHaveLength(60);
  });

  it('自愈：index 里的悬空分类引用按未分类处理', async () => {
    await storage.putGroup(group('g1', '会话一'));
    const entry = (await storage.listGroupIndex())[0];
    await storage.replaceGroupIndex([{ ...entry!, categoryId: '已经不存在的分类' }]);

    const report = await createStoragePort().heal();
    expect(report.clearedDanglingCategoryRefs).toBe(1);
    expect((await storage.listGroupIndex())[0]?.categoryId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 锁定
// ---------------------------------------------------------------------------

describe('锁定 = 写保护', () => {
  async function lockedGroup(id = 'g1'): Promise<TabGroup> {
    const created = group(id, '锁着的会话', [tab(id, `${id}-t0`, 'https://a.test/1', 'A')]);
    await storage.putGroup(created);
    return (await toggleLock(deps(), { groupId: id }))!;
  }

  it('toggleLock 往返，并透传到 index', async () => {
    const locked = await lockedGroup();
    expect(locked.locked).toBe(true);
    expect((await storage.listGroupIndex())[0]?.locked).toBe(true);

    const unlocked = await toggleLock(deps(), { groupId: 'g1' });
    expect(unlocked.locked).toBe(false);
    expect((await storage.listGroupIndex())[0]?.locked).toBe(false);
  });

  it('锁定后删除被拒，数据仍在', async () => {
    await lockedGroup();
    await expect(deleteGroup(deps(), { groupId: 'g1' })).rejects.toBeInstanceOf(GroupLockedError);
    expect(await storage.getGroup('g1')).toBeDefined();
  });

  it('锁定后删单条、组内重排、跨组移动都被拒', async () => {
    await lockedGroup();
    await storage.putGroup(group('g2', '另一个会话'));

    await expect(deleteTab(deps(), { groupId: 'g1', tabId: 'g1-t0' })).rejects.toBeInstanceOf(GroupLockedError);
    await expect(
      reorderTab(deps(), { groupId: 'g1', tabId: 'g1-t0', toIndex: 1 }),
    ).rejects.toBeInstanceOf(GroupLockedError);
    await expect(
      moveTab(deps(), { tabId: 'g1-t0', fromGroupId: 'g1', toGroupId: 'g2', insertAt: 0 }),
    ).rejects.toBeInstanceOf(GroupLockedError);

    expect((await storage.getGroup('g1'))?.tabs).toHaveLength(1);
  });

  it('锁定与否决定目标端：把条目移进锁定的组要拒绝', async () => {
    await storage.putGroup(group('plain', '普通会话', [tab('plain', 'p-t0', 'https://a.test/1', 'A')]));
    await lockedGroup('locked');

    await expect(
      moveTab(deps(), { tabId: 'p-t0', fromGroupId: 'plain', toGroupId: 'locked', insertAt: 0 }),
    ).rejects.toBeInstanceOf(GroupLockedError);
    expect((await storage.getGroup('plain'))?.tabs).toHaveLength(1);
  });

  it('锁定后不能参与拖拽排序，但改名、置顶、取消锁定都不受影响', async () => {
    await storage.putGroup(group('g1', '锁着的会话', [], { locked: true }));
    await storage.putGroup(group('g2', '另一个'));

    await expect(reorderGroups(deps(), { groupId: 'g1', toIndex: 1 })).rejects.toBeInstanceOf(GroupLockedError);

    await renameGroup(deps(), { groupId: 'g1', title: '改了名' });
    await togglePin(deps(), { groupId: 'g1' });
    expect((await storage.getGroup('g1'))?.title).toBe('改了名');
    expect((await storage.getGroup('g1'))?.isPinned).toBe(true);

    await toggleLock(deps(), { groupId: 'g1' });
    await expect(reorderGroups(deps(), { groupId: 'g1', toIndex: 1 })).resolves.toBeDefined();
  });

  it('锁定不挡还原，但锁住的会话恢复后仍在（既有约定 + 既有约定）', async () => {
    await lockedGroup('g1');
    const tabs = createFakeBrowserTabsPort({ windows: [{ id: 1, tabs: [] }] });

    const result = await restoreGroup({ storage, tabs }, { groupId: 'g1', windowId: 1 });
    expect(result.restored).toBe(1);
    // 默认行为已经是"恢复即删"，锁必须挡住这条后台清理路径
    expect(await storage.getGroup('g1')).toBeDefined();
    expect((await storage.getGroup('g1'))?.tabs).toHaveLength(1);
  });

  it('锁定的会话里单条恢复也不消费记录', async () => {
    await lockedGroup('g1');
    const tabs = createFakeBrowserTabsPort({ windows: [{ id: 1, tabs: [] }] });
    const tabId = (await storage.getGroup('g1'))?.tabs[0]?.id ?? '';

    const result = await restoreTab({ storage, tabs }, { groupId: 'g1', tabId, windowId: 1 });
    expect(result.ok).toBe(true);
    expect((await storage.getGroup('g1'))?.tabs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 复制与"导出成网页"
// ---------------------------------------------------------------------------

describe('剪贴板载荷', () => {
  it('格式是「标题换行 URL」，条目之间空一行，按 sortOrder 排', () => {
    const tabs = [
      tab('g', 't2', 'https://b.test/2', '第二页', { sortOrder: 1 }),
      tab('g', 't1', 'https://a.test/1', '第一页', { sortOrder: 0 }),
    ];
    expect(clipboardText(tabs)).toBe(
      '第一页\nhttps://a.test/1\n\n第二页\nhttps://b.test/2',
    );
  });

  it('没有标题的条目用 URL 顶上当标题，不出现空行开头', () => {
    expect(clipboardText([tab('g', 't1', 'https://a.test/1', '   ')])).toBe(
      'https://a.test/1\nhttps://a.test/1',
    );
  });

  it('不可恢复的条目照样列（用户复制的是"我当时开着什么"）', () => {
    const text = clipboardText([
      tab('g', 't1', 'chrome://settings', '设置', { restorable: false }),
    ]);
    expect(text).toContain('chrome://settings');
  });

  it('单条复制只给 URL —— 粘到地址栏就能用', () => {
    expect(clipboardTextOfTab(tab('g', 't1', 'https://a.test/1', '标题'))).toBe('https://a.test/1');
  });
});

describe('自包含 HTML 导出', () => {
  const sample = (): TabGroup =>
    group('g1', '工作 <会话>', [
      tab('g1', 't1', 'https://a.test/1?x=1&y=2', 'A & B', { sortOrder: 0 }),
      tab('g1', 't2', 'https://b.test/2', 'B', { sortOrder: 1 }),
    ]);

  it('标题与 URL 都做了 HTML 转义', () => {
    const html = buildShareHtml(sample(), AT, '师兄收纳');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('href="https://a.test/1?x=1&amp;y=2"');
    expect(html).not.toContain('<h1>工作 <会话>');
  });

  it('不含任何外部资源与脚本（发出去就是发一个文件）', () => {
    const html = buildShareHtml(sample(), AT, '师兄收纳');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).toMatch(/<style>/);
  });

  it('给出条数与每条链接，顺序与界面一致', () => {
    const html = buildShareHtml(sample(), AT, '师兄收纳');
    expect(html).toContain('2 个标签页');
    expect(html.indexOf('https://a.test/1')).toBeLessThan(html.indexOf('https://b.test/2'));
  });

  it('文件名：可排序的时间前缀 + 清洗过的标题，非法字符不进文件名', () => {
    const name = shareFilename('工作/项目: 2026 <Q4>', AT);
    expect(name).toMatch(/^shitab-\d{8}-\d{4}-.+\.html$/);
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('空标题的文件名不留悬空连字符', () => {
    expect(shareFilename('   ', AT)).toMatch(/^shitab-\d{8}-\d{4}\.html$/);
  });

  /** 既有约定 决定 1：导出页上的品牌字与界面同源，由调用方传 brandName 进来。 */
  it('导出页的品牌字来自参数，不在这一层写第二份副本', () => {
    const html = buildShareHtml(sample(), AT, '师兄收纳');
    expect(html).toContain('<footer>由 师兄收纳 导出');
    expect(html).toContain('<title>工作 &lt;会话&gt; · 2 个标签页</title>');
  });

  it('会话没有标题时，导出页的 title 用传进来的品牌兜底', () => {
    const blank = group('g1', '', [tab('g1', 't1', 'https://a.test/1', 'A', { sortOrder: 0 })]);
    expect(buildShareHtml(blank, AT, '师兄收纳')).toContain('<title>师兄收纳 · 1 个标签页</title>');
  });
});

// ---------------------------------------------------------------------------
// 备份兼容
// ---------------------------------------------------------------------------

describe('备份里的分类与锁定', () => {
  it('导出的载荷带 categories，且 locked/categoryId 在组上', () => {
    const category: Category = { id: 'c1', name: '工作', sortOrder: 0, createdAt: AT, updatedAt: AT };
    const groups = [group('g1', '会话', [tab('g1', 't1', 'https://a.test/1', 'A')], { categoryId: 'c1', locked: true })];
    const json = serializeBackup(buildBackup(groups, [category], DEFAULT_SETTINGS, AT));
    const raw = JSON.parse(json) as Record<string, unknown>;

    expect(raw.categories).toEqual([category]);
    const exported = (raw.groups as Record<string, unknown>[])[0];
    expect(exported).toMatchObject({ categoryId: 'c1', locked: true });
  });

  it('V1.1 的老备份（没有 categories、没有 locked）照样通过校验', () => {
    const legacy = {
      format: 'shitab-backup',
      version: 1,
      exportedAt: AT,
      groups: [
        {
          id: 'g1',
          title: '老会话',
          createdAt: AT,
          updatedAt: AT,
          isPinned: false,
          sortOrder: 0,
          tabs: [{ id: 't1', url: 'https://a.test/1', title: 'A', createdAt: AT, sortOrder: 0 }],
        },
      ],
      settings: {},
    };
    const outcome = validateBackup(legacy);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backup.categories).toEqual([]);
    expect(outcome.backup.groups[0]).toMatchObject({ locked: false });
    expect(outcome.backup.groups[0]?.categoryId).toBeUndefined();
  });

  it('指向备份里不存在的分类的引用，在校验时就清掉', () => {
    const outcome = validateBackup({
      format: 'shitab-backup',
      version: 1,
      exportedAt: AT,
      categories: [],
      groups: [
        {
          id: 'g1',
          title: '悬空引用',
          createdAt: AT,
          updatedAt: AT,
          isPinned: false,
          locked: false,
          sortOrder: 0,
          categoryId: '根本没有这个分类',
          tabs: [],
        },
      ],
      settings: {},
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backup.groups[0]?.categoryId).toBeUndefined();
  });

  it('导入按名字合并分类：同名不重建，新名才计数，组的归属映射到本地 id', async () => {
    const mine = await createCategoryCommand(deps(), { name: '工作' });
    const foreign = {
      format: 'shitab-backup' as const,
      version: 1 as const,
      exportedAt: AT,
      categories: [
        { id: 'remote-work', name: '工作', sortOrder: 0, createdAt: AT, updatedAt: AT },
        { id: 'remote-new', name: '侧项目', sortOrder: 1, createdAt: AT, updatedAt: AT },
      ],
      groups: [
        {
          id: 'fg1',
          title: '外来会话',
          createdAt: AT,
          updatedAt: AT,
          isPinned: false,
          locked: true,
          sortOrder: 0,
          categoryId: 'remote-work',
          tabs: [{ id: 'ft1', url: 'https://a.test/1', title: 'A', createdAt: AT, sortOrder: 0 }],
        },
      ],
      settings: {},
    };
    const outcome = validateBackup(foreign);
    if (!outcome.ok) throw new Error('校验不该失败');

    const result = await importBackup(deps(), outcome.backup, AT + 1000);
    expect(result.categoriesImported).toBe(1);
    expect((await storage.listCategories()).map((category) => category.name).sort()).toEqual([
      '侧项目',
      '工作',
    ]);

    const imported = (await storage.listGroupIndex()).find((entry) => entry.title === '外来会话');
    expect(imported?.categoryId).toBe(mine.id); // 归到本地已有的"工作"，不是远程 id
    // 外来数据不能塞进"用户删不掉"的锁里，也不能插队进收藏区
    expect((await storage.getGroup(imported?.id ?? ''))?.locked).toBe(false);
    expect(imported?.isPinned).toBe(false);
  });

  it('往返一致：导出再导入，分类归属跟着走', async () => {
    const category = await createCategoryCommand(deps(), { name: '归档' });
    await storage.putGroup(group('g1', '会话一', [tab('g1', 't1', 'https://a.test/1', 'A')], { categoryId: category.id }));
    const snapshot = await storage.snapshotAll();

    await fakeBrowser.storage.local.clear();
    storage = createStoragePort();
    const parsed = validateBackup(JSON.parse(serializeBackup(buildBackup(snapshot.groups, snapshot.categories, DEFAULT_SETTINGS, AT))));
    if (!parsed.ok) throw new Error('校验不该失败');
    await importBackup(deps(), parsed.backup, AT);

    const [entry] = await storage.listGroupIndex();
    const [importedCategory] = await storage.listCategories();
    expect(importedCategory?.name).toBe('归档');
    expect(entry?.categoryId).toBe(importedCategory?.id);
  });
});
