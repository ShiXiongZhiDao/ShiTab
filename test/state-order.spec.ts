// 状态摘要对**数组顺序**敏感（`canonicalJson` 只管键序），所以"同一堆内容必须算出同一个摘要"
// 这件事全靠 `core/domain/state-order.ts` 那几条全序。这里逐条钉每一级比较键 ——
// 判据是四级串起来的，只测"整体能排好"的话，去掉任何一级 tiebreak 都照样绿
// （2026-10-08 实测：把会话/分类/标签/墓碑的 `id` 兜底四级**全部删掉**，当时的 124 条用例一条都不红）。
// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Category, SavedTab, StoredState, TabGroup, Tombstone, TrashEntry } from '@/shared/types';
import { canonicalizeState, compareTabOrder, sortedGroups, sortedTombstones, sortedTrash } from '@/core/domain/state-order';
import { stateChecksumOf } from '@/core/domain/sync-data';
import { groupFixture, savedTabFixture } from './fixtures';

const AT = 1_700_000_000_000;

function state(groups: TabGroup[], extra: Partial<StoredState> = {}): StoredState {
  return { groups, categories: [], tombstones: [], trash: [], ...extra };
}

/**
 * 不经 `createGroup` 的会话字面量。
 *
 * `groupFixture` 走的是收纳路径（`createGroup` 里 `renumberTabs` 把标签重写成 0..n-1、
 * 并且**总是新建数组**），所以"标签原样返回同一个引用"这类断言只能拿字面量测 ——
 * 否则测的是那个重写，不是被测函数。
 */
function literalGroup(id: string, tabs: SavedTab[], overrides: Partial<TabGroup> = {}): TabGroup {
  return {
    id,
    title: `会话 ${id}`,
    createdAt: AT,
    updatedAt: AT,
    isPinned: false,
    locked: false,
    sortOrder: 0,
    tabs,
    ...overrides,
  };
}

/** 同 pinned、同 sortOrder、同 createdAt，只有 id 不同 —— 这一堆把前三级全部喂成平手。 */
function tiedGroup(id: string): TabGroup {
  return groupFixture(`会话 ${id}`, [savedTabFixture(id, `${id}-t0`, 0)], { id, sortOrder: 7, createdAt: AT, updatedAt: AT });
}

/**
 * ★ 这一条是根因的正面对撞：两台机器上"同一堆内容"以不同先后落盘，
 * 规范形之后必须算出**同一个** checksum。
 * 顺序判据坏掉时红的就是它（真机那 10 个版本每两个之间差的就只有顺序）。
 */
describe('规范形 ⇒ 摘要与来路顺序无关', () => {
  it('会话顺序不同、内容相同 ⇒ checksum 相同', async () => {
    const a = [tiedGroup('aa'), tiedGroup('bb'), tiedGroup('cc')];
    const b = [tiedGroup('cc'), tiedGroup('aa'), tiedGroup('bb')];

    expect(await stateChecksumOf(canonicalizeState(state(a)))).toBe(await stateChecksumOf(canonicalizeState(state(b))));
    // 正向对照：不规范化时这两个**确实**是两个摘要（否则上面那条是空对空）
    expect(await stateChecksumOf(state(a))).not.toBe(await stateChecksumOf(state(b)));
  });

  it('canonicalizeState 是幂等的（已经规范形 ⇒ 逐字节不动）', () => {
    const once = canonicalizeState(state([tiedGroup('b'), tiedGroup('a')]));
    const twice = canonicalizeState(once);

    expect(canonicalJsonOf(twice)).toBe(canonicalJsonOf(once));
  });

  it('canonicalizeState 不改入参（合并结果还要拿来数 applied）', () => {
    const groups = [tiedGroup('b'), tiedGroup('a')];
    const input = state(groups);
    const before = canonicalJsonOf(input);

    canonicalizeState(input);

    expect(canonicalJsonOf(input), '入参被就地排了 ⇒ 调用方拿到的"合并前"已经是合并后的顺序').toBe(before);
    expect(input.groups.map((group) => group.id), '入参数组被动过').toEqual(['b', 'a']);
  });
});

function canonicalJsonOf(value: unknown): string {
  // 这里要的是"逐字节相同"，所以直接用 JSON.stringify 而不是 canonicalJson：
  // canonicalJson 会排键序，那样就看不见数组顺序的差异了 —— 而数组顺序正是被测对象。
  return JSON.stringify(value);
}

describe('会话那一级：四级比较键，每级各一条"只有它为假"的用例', () => {
  it('第一级 isPinned 生效（sortOrder 更大但没置顶的那一条要在后面）', () => {
    const pinned = groupFixture('置顶', [savedTabFixture('p', 'p-t0', 0)], { id: 'p', isPinned: true, sortOrder: 1, createdAt: AT });
    const higher = groupFixture('没置顶但序号大', [savedTabFixture('h', 'h-t0', 0)], { id: 'h', isPinned: false, sortOrder: 9, createdAt: AT });

    expect(sortedGroups([higher, pinned]).map((group) => group.id)).toEqual(['p', 'h']);
  });

  it('第二级 sortOrder 降序生效（既有约定：最新在前）', () => {
    const low = groupFixture('小', [savedTabFixture('l', 'l-t0', 0)], { id: 'l', sortOrder: 1, createdAt: AT });
    const high = groupFixture('大', [savedTabFixture('m', 'm-t0', 0)], { id: 'm', sortOrder: 9, createdAt: AT });

    expect(sortedGroups([low, high]).map((group) => group.id)).toEqual(['m', 'l']);
  });

  it('第三级 createdAt 降序生效（同 sortOrder 时新的在前）', () => {
    const older = groupFixture('旧', [savedTabFixture('o', 'o-t0', 0)], { id: 'o', sortOrder: 5, createdAt: AT });
    const newer = groupFixture('新', [savedTabFixture('n', 'n-t0', 0)], { id: 'n', sortOrder: 5, createdAt: AT + 1 });

    expect(sortedGroups([older, newer]).map((group) => group.id)).toEqual(['n', 'o']);
  });

  /** 前三级全平手 = 一次收纳里批量建了多个会话。这一级不在，顺序就退回"谁先落盘谁在前"。 */
  it('第四级 id 生效：前三级全相等时，两种输入顺序排出来是同一个', () => {
    const first = [tiedGroup('zz'), tiedGroup('aa')];
    const second = [tiedGroup('aa'), tiedGroup('zz')];

    expect(sortedGroups(first).map((group) => group.id)).toEqual(['aa', 'zz']);
    expect(sortedGroups(second).map((group) => group.id), '同一堆内容换先后就换个结果 ⇒ 摘要跟着变').toEqual(['aa', 'zz']);
  });

  /**
   * 这两条**不走 `groupFixture`**：它内部是 `createGroup`，而 `createGroup` 会
   * `renumberTabs(...)` 把标签的 `sortOrder` 重写成 0..n-1（收纳路径要的就是这个）。
   * 于是这里喂进去的 3/3/1 会先被抹平，测的就不是排序而是那个重写。
   * 跨设备并回来的一版走的不是收纳路径，标签顺序本来就可能不是稠密的 —— 那才是这里要钉的形状。
   */
  it('会话内的标签按 sortOrder 升序，平手时按 id', () => {
    const tab = (id: string, sortOrder: number): SavedTab => ({ ...savedTabFixture('g', id, 0), id, sortOrder });
    const group = literalGroup('g', [tab('g-b', 3), tab('g-a', 3), tab('g-c', 1)]);

    expect(sortedGroups([group])[0]?.tabs.map((item) => item.id)).toEqual(['g-c', 'g-a', 'g-b']);
  });

  /**
   * `sortedTabs` 对**不是数组**的 `tabs` 原样返回，不补 `[]`。
   * 补平就等于把一份解析不出来的状态洗成"干净的改动"，而那一轮本该停在 `invalid-local`
   * （`test/sync-engine.spec.ts` 的「本地状态坏了」那条）。
   */
  it('标签缺失时不补空数组（坏形状归 invalid-local 管，不归排序管）', () => {
    const broken = { ...tiedGroup('g'), tabs: undefined } as unknown as TabGroup;
    const [out] = sortedGroups([broken]);

    expect(out?.tabs, '排序这一层顺手补平 ⇒ 塌陷闸与 invalid-local 都看不见这份坏了的状态').toBeUndefined();
  });

  it('已经就位时不换数组引用（一次同步要过 900 个会话，无条件重建数组是白付的钱）', () => {
    const ordered = [savedTabFixture('g', 'g-t0', 0), savedTabFixture('g', 'g-t1', 1)];
    const group = literalGroup('g', ordered);

    expect(sortedGroups([group])[0]?.tabs).toBe(ordered);
  });
});

describe('另外三个列表：各自的 tiebreak', () => {
  it('分类：sortOrder → createdAt → id', () => {
    const tied = (id: string, sortOrder: number, createdAt: number): Category => ({
      id,
      name: `分类 ${id}`,
      sortOrder,
      createdAt,
      updatedAt: createdAt,
    });

    const forward = canonicalizeState(state([], { categories: [tied('c', 2, AT), tied('a', 2, AT)] })).categories;
    const reversed = canonicalizeState(state([], { categories: [tied('a', 2, AT), tied('c', 2, AT)] })).categories;

    expect(forward?.map((category) => category.id)).toEqual(['a', 'c']);
    expect(reversed?.map((category) => category.id), '同 sortOrder 同 createdAt 时按输入先后排 ⇒ 两台机器各算各的').toEqual(['a', 'c']);
    // 正向对照：sortOrder 这一级照旧生效（id 是"字母序在前"，不该盖过 sortOrder）
    expect(canonicalizeState(state([], { categories: [tied('a', 1, AT), tied('c', 2, AT)] })).categories?.map((c) => c.id)).toEqual(['a', 'c']);
    expect(canonicalizeState(state([], { categories: [tied('z', 1, AT), tied('a', 1, AT + 1)] })).categories?.map((c) => c.id)).toEqual(['z', 'a']);
  });

  it('墓碑：deletedAt → entityId → id', () => {
    const marker = (id: string, entityId: string, deletedAt: number): Tombstone => ({
      id,
      entityType: 'group',
      entityId,
      deletedAt,
      deletedByDeviceId: 'device-other',
      reason: 'user-delete',
    });

    const left = sortedTombstones([marker('m-b', 'same-entity', AT), marker('m-a', 'same-entity', AT)]);
    const right = sortedTombstones([marker('m-a', 'same-entity', AT), marker('m-b', 'same-entity', AT)]);

    expect(left.map((t) => t.id)).toEqual(['m-a', 'm-b']);
    expect(right.map((t) => t.id), '同一次批量删除会拿到同一个 deletedAt 与同一个 entityId 吗？会：tiebreak 不能只有一级').toEqual(['m-a', 'm-b']);
    // 同一时刻删两个不同实体 ⇒ entityId 先说话
    expect(sortedTombstones([marker('m-z', 'entity-b', AT), marker('m-a', 'entity-a', AT)]).map((t) => t.entityId)).toEqual(['entity-a', 'entity-b']);
    // 正向对照：deletedAt 这一级照旧生效
    expect(sortedTombstones([marker('m-a', 'e1', AT), marker('m-b', 'e1', AT + 1)]).map((t) => t.id)).toEqual(['m-a', 'm-b']);
  });

  it('回收站：deletedAt 降序，同一天删掉的按 group.id', () => {
    const entry = (groupId: string, deletedAt: number): TrashEntry => ({
      group: groupFixture(`会话 ${groupId}`, [savedTabFixture(groupId, `${groupId}-t0`, 0)], { id: groupId, createdAt: AT, updatedAt: deletedAt }),
      deletedAt,
      expiresAt: deletedAt + 7 * 86_400_000,
      reason: 'user-delete',
    });

    const tied = sortedTrash([entry('g-z', AT), entry('g-a', AT)]);
    expect(tied.map((item) => item.group.id)).toEqual(['g-a', 'g-z']);
    // 正向对照：更晚删的在前
    expect(sortedTrash([entry('g-a', AT), entry('g-z', AT + 1)]).map((item) => item.group.id)).toEqual(['g-z', 'g-a']);
  });
});

describe('compareTabOrder：两个键各一条', () => {
  it('sortOrder 不同时它说话（id 是"字母序在前"的那个要排在后面）', () => {
    const later = { ...savedTabFixture('g', 'g-b', 2) } as SavedTab;
    const earlier = { ...savedTabFixture('g', 'g-a', 1) } as SavedTab;

    expect(compareTabOrder(later, earlier)).toBeGreaterThan(0);
  });

  it('sortOrder 相同时 id 说话', () => {
    const b = { ...savedTabFixture('g', 'g-b', 1) } as SavedTab;
    const a = { ...savedTabFixture('g', 'g-a', 1) } as SavedTab;

    expect(compareTabOrder(b, a)).toBeGreaterThan(0);
    expect(compareTabOrder(a, b)).toBeLessThan(0);
    expect(compareTabOrder(a, a)).toBe(0);
  });
});
