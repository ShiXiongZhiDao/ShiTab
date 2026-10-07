import { describe, expect, it } from 'vitest';
import { buildSyncSnapshot, newestManifest, stateChecksumOf, verifyManifest, verifySyncSnapshot } from '@/core/domain/sync-data';
import { MANIFEST_FORMAT, SNAPSHOT_FORMAT } from '@/shared/constants';
import { applyConflictChoice, mergeStates, trashOf } from '@/core/domain/merge';
import { recordReason } from '@/core/domain/trash-record';
import { assessSyncSafety, countsOf, SUSPICIOUS_MIN_PREVIOUS } from '@/core/domain/safety';
import { canonicalJson, checksumOf } from '@/core/domain/checksum';
import { groupFixture, savedTabFixture } from './fixtures';
import type { Category, DeleteReason, StoredState, SyncManifest, SyncSnapshot, TabGroup, Tombstone, TrashEntry } from '@/shared/types';

const ID = '11111111-1111-4111-8111-111111111111';

/**
 * 所有时间都从这一个基准出发加偏移。
 *
 * 不是讲究：合并算法比的是 `updatedAt` 与 `tombstone.deletedAt` 的**大小**，
 * 而我第一版把偏移量（20、30）直接当绝对时间用，于是 `groupFixture` 默认的
 * `createdAt = 1.7e12` 让每一条会话的 `updatedAt` 都远大于任何墓碑，
 * "删除发生在编辑之后 ⇒ 正常删除"那条用例必然是红的 ——
 * 报出来的却是"应当不算冲突却算了"，看着像合并逻辑写反了。
 */
const T0 = 1_700_000_000_000;
const at = (offset: number): number => T0 + offset;

function category(id: string, name: string, updatedAt: number, sortOrder = 1): Category {
  return { id, name, sortOrder, createdAt: T0, updatedAt };
}

function tomb(entityId: string, deletedAt: number, overrides: Partial<Tombstone> = {}): Tombstone {
  return {
    id: `tomb-${entityId}-${deletedAt}`,
    entityType: 'group',
    entityId,
    deletedAt,
    deletedByDeviceId: 'device-other',
    reason: 'user-delete',
    ...overrides,
  };
}

/**
 * 一个会话。第二个参数是 `updatedAt`（合并算法唯一读取的量），
 * 并且**必须**显式给：不给的话它等于 `createdAt`，两条会话就成了平手。
 */
function session(id: string, updatedAt: number, overrides: Partial<TabGroup> = {}): TabGroup {
  return groupFixture(`会话 ${id}`, [savedTabFixture(id, `${id}-t0`, 0)], {
    id,
    sortOrder: updatedAt - T0,
    updatedAt,
    ...overrides,
  });
}

function state(input: Partial<StoredState> = {}): StoredState {
  return {
    groups: input.groups ?? [],
    categories: input.categories ?? [],
    tombstones: input.tombstones ?? [],
    // 不传就连这个键都没有 —— 那是"老版本写的载荷"的形状，读侧必须吃得住
    ...(input.trash !== undefined ? { trash: input.trash } : {}),
  };
}

describe('快照的盖章与验货', () => {
  it('stateChecksum 与信封的 checksum 同源：同一个 state 两边算出来必须相等', async () => {
    const payload = state({ groups: [session('g1', 10)] });
    const snapshot = await buildSyncSnapshot(payload, { snapshotId: ID, deviceId: 'd1', revision: 1, createdAt: 5 });
    expect(snapshot.stateChecksum).toBe(await checksumOf(payload));
    expect(snapshot.stateChecksum).toBe(await stateChecksumOf(payload));
  });

  it('盖出来的快照能验通，且 format/version 是我们要的那两个值', async () => {
    const payload = state({ categories: [category('c1', '阅读', 3)] });
    const snapshot = await buildSyncSnapshot(payload, { snapshotId: ID, deviceId: 'd1', revision: 7, createdAt: 5 });
    const verified = await verifySyncSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.snapshot.revision).toBe(7);
    expect(snapshot.format).toBe(SNAPSHOT_FORMAT);
    expect(snapshot.version).toBe(1);
  });

  it('baseSnapshotId 缺省时这个键根本不存在（不是 undefined 冒充一个字段）', async () => {
    const snapshot = await buildSyncSnapshot(state(), { snapshotId: ID, deviceId: 'd1', revision: 1, createdAt: 1 });
    expect('baseSnapshotId' in snapshot).toBe(false);
    const withBase = await buildSyncSnapshot(state(), { snapshotId: ID, deviceId: 'd1', revision: 2, baseSnapshotId: ID, createdAt: 1 });
    expect(withBase.baseSnapshotId).toBe(ID);
  });

  for (const [reason, raw] of [
    ['not-object', 'a string'],
    ['format', { format: 'other-product-snapshot', version: 1 }],
    ['version', { format: SNAPSHOT_FORMAT, version: 2 }],
  ] as const) {
    it(`坏载荷判成 ${reason}，而不是"大部分字段对得上就当真"`, async () => {
      const verified = await verifySyncSnapshot(raw);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.reason).toBe(reason);
    });
  }

  it('字段残缺判成 shape，而不是抛 TypeError', async () => {
    for (const raw of [
      { format: SNAPSHOT_FORMAT, version: 1 },
      { format: SNAPSHOT_FORMAT, version: 1, snapshotId: ID, deviceId: 'd', revision: 1, createdAt: 1, stateChecksum: 'x', state: { groups: [] } },
    ]) {
      const verified = await verifySyncSnapshot(raw);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.reason).toBe('shape');
    }
  });

  /**
   * §19「远端历史文件损坏 ⇒ 跳过坏版本」的判据本身：
   * 内容被改过一个字节，整份快照作废，而不是"照用但记一笔不认账"。
   */
  it('内容被改过一个字节 ⇒ checksum，整份作废', async () => {
    const snapshot = await buildSyncSnapshot(state({ groups: [session('g1', 10)] }), {
      snapshotId: ID,
      deviceId: 'd1',
      revision: 1,
      createdAt: 1,
    });
    const forged = JSON.parse(canonicalJson(snapshot)) as SyncSnapshot & { state: StoredState };
    forged.state.groups[0]!.title = '被人改过的标题';
    const verified = await verifySyncSnapshot(forged);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('checksum');
  });

  it('manifest 不查 checksum：它本来就不是真相，验货只保证读进来不是垃圾', () => {
    const manifest = { format: MANIFEST_FORMAT, version: 1, latestRevision: 3, latestSnapshotId: ID, updatedAt: 9, deviceIds: ['d1'], history: [] };
    expect(verifyManifest(manifest).ok).toBe(true);
    expect(verifyManifest({ ...manifest, format: 'x' })).toEqual({ ok: false, reason: 'format' });
    expect(verifyManifest(null)).toEqual({ ok: false, reason: 'not-object' });
  });

  it('newestManifest 取最高 revision，并跳过目录里认不出的东西', () => {
    const mk = (latestRevision: number): SyncManifest => ({
      format: MANIFEST_FORMAT,
      version: 1,
      latestRevision,
      latestSnapshotId: ID,
      updatedAt: 1,
      deviceIds: [],
      history: [],
    });
    const best = newestManifest([mk(3), 'not-a-manifest', null, mk(11), { nonsense: true }, mk(7)]);
    expect(best?.latestRevision).toBe(11);
    expect(newestManifest([])).toBeUndefined();
    expect(newestManifest([{ format: 'x' }])).toBeUndefined();
  });
});

describe('合并：实体级 last-writer-wins（Q8）', () => {
  it('两边都有同一条会话 ⇒ 取 updatedAt 新的那一版', () => {
    const result = mergeStates({
      local: state({ groups: [session('g1', at(10), { title: '本地标题' })] }),
      remote: state({ groups: [session('g1', at(20), { title: '远端标题' })] }),
    });
    expect(result.state.groups).toHaveLength(1);
    expect(result.state.groups[0]?.title).toBe('远端标题');
    expect(result.conflicts).toHaveLength(0);
    expect(result.applied.keptFromRemote).toBe(1);
  });

  it('平手取本地，而且每次结果一样（来回抖的列表比一次错误的合并更难解释）', () => {
    const local = state({ groups: [session('g1', at(10), { title: '本地' })] });
    const remote = state({ groups: [session('g1', at(10), { title: '远端' })] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(mergeStates({ local, remote }).state.groups[0]?.title).toBe('本地');
    }
  });

  it('两边各自新增不同的会话 ⇒ 都留下（这才是"不静默覆盖"的实际含义）', () => {
    const result = mergeStates({
      local: state({ groups: [session('a', at(5))] }),
      remote: state({ groups: [session('b', at(6))] }),
    });
    expect(result.state.groups.map((group) => group.id).sort()).toEqual(['a', 'b']);
  });

  it('一边删了、另一边在删除之后又改了 ⇒ 冲突，会话先保留', () => {
    const result = mergeStates({
      local: state({ groups: [session('g1', at(30))] }),
      remote: state({ tombstones: [tomb('g1', at(20))] }),
    });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      kind: 'delete-vs-edit',
      groupId: 'g1',
      deletedAt: at(20),
      editedAt: at(30),
      deletedByDeviceId: 'device-other',
    });
    expect(result.state.groups.map((group) => group.id)).toEqual(['g1']);
    expect(result.applied.unresolvedConflicts).toBe(1);
  });

  it('删除发生在编辑之后 ⇒ 正常删除，不算冲突', () => {
    const result = mergeStates({
      local: state({ groups: [session('g1', at(10))] }),
      remote: state({ tombstones: [tomb('g1', at(20))] }),
    });
    expect(result.conflicts).toHaveLength(0);
    expect(result.state.groups).toHaveLength(0);
    expect(result.applied.droppedByTombstone).toBe(1);
  });

  /**
   * 这条钉的是"我明明还原了，换台电脑又没了"：
   * 一条指向**仍然存在的会话**的墓碑必须在合并后被丢掉，否则下一轮同步又把它删一遍。
   */
  it('存活的会话不留墓碑：合并结果里的墓碑集合与保留下来的会话互斥', () => {
    const result = mergeStates({
      local: state({ groups: [session('g1', at(30))] }),
      remote: state({ tombstones: [tomb('g1', at(20))] }),
    });
    expect(result.state.tombstones.map((tombstone) => tombstone.entityId)).toEqual([]);
  });

  it('被删掉的会话仍然留着墓碑（删除信号要继续传播）', () => {
    const result = mergeStates({
      local: state({ groups: [session('g1', at(10))] }),
      remote: state({ tombstones: [tomb('g1', at(20))] }),
    });
    expect(result.state.tombstones.map((tombstone) => tombstone.entityId)).toEqual(['g1']);
  });

  it('同一实体的多条墓碑取最晚那条', () => {
    const result = mergeStates({
      local: state({ tombstones: [tomb('gone', at(100))] }),
      remote: state({ tombstones: [tomb('gone', at(50)), tomb('gone', at(300))] }),
    });
    expect(result.state.tombstones).toHaveLength(1);
    expect(result.state.tombstones[0]?.deletedAt).toBe(at(300));
  });

  it('分类按名字对齐、id 重映射（既有约定：名字是唯一跨设备还能对上的东西）', () => {
    const result = mergeStates({
      local: state({ categories: [category('c-local', '工作', at(10))], groups: [session('g1', at(5), { categoryId: 'c-local' })] }),
      remote: state({ categories: [category('c-remote', '工作', at(20))], groups: [session('g2', at(6), { categoryId: 'c-remote' })] }),
    });
    expect(result.state.categories).toHaveLength(1);
    expect(result.state.categories[0]?.id).toBe('c-remote');
    expect(result.state.groups.map((group) => group.categoryId).sort()).toEqual(['c-remote', 'c-remote']);
    expect(result.applied.categoriesRenamedMerged).toBe(1);
  });

  it('名字比较忽略大小写与首尾空白（"Work" 与 "work " 是同一个人写的同一个分类）', () => {
    const result = mergeStates({
      local: state({ categories: [category('c1', 'Work', at(10))] }),
      remote: state({ categories: [category('c2', '  work  ', at(20))] }),
    });
    expect(result.state.categories).toHaveLength(1);
  });

  it('指向不存在分类的引用清成未分类，不显示成"某个看不见的分类里有一批会话"', () => {
    const result = mergeStates({
      local: state({ groups: [session('g1', at(5), { categoryId: 'deleted-category' })] }),
      remote: state({ categories: [category('c1', '阅读', at(1))] }),
    });
    expect(result.state.groups[0]?.categoryId).toBeUndefined();
  });

  it('合并结果按 sortOrder 降序（列表是最新在前，既有约定）', () => {
    const result = mergeStates({
      local: state({ groups: [session('a', at(1)), session('b', at(9))] }),
      remote: state({ groups: [session('c', at(5))] }),
    });
    expect(result.state.groups.map((group) => group.id)).toEqual(['b', 'c', 'a']);
  });

  it('用户裁决"这次删除是真的"：会话拿走、墓碑放回去', () => {
    const merged = mergeStates({
      local: state({ groups: [session('g1', at(30))] }),
      remote: state({ tombstones: [tomb('g1', at(20), { reason: 'consumed' })] }),
    });
    const conflict = merged.conflicts[0];
    if (!conflict) throw new Error('应当有冲突');

    const deleted = applyConflictChoice(merged.state, conflict, 'delete');
    expect(deleted.groups).toHaveLength(0);
    expect(deleted.tombstones.map((tombstone) => [tombstone.entityId, tombstone.reason])).toEqual([['g1', 'consumed']]);

    // 'keep' 必须是原样返回 —— 它就是默认值，UI 上"先不动手"要走这条
    expect(applyConflictChoice(merged.state, conflict, 'keep')).toBe(merged.state);
  });
});

describe('异常变化检测（§9 的 A/B/C/D 四条）', () => {
  const many = (count: number, perSession = 1): StoredState =>
    state({ groups: Array.from({ length: count }, (_, index) => session(`g${index}`, at(index + 1), { tabs: savedTabFixtureArray(`g${index}`, perSession) })) });

  it('规则 C/D：本地状态不可信 ⇒ blocked，不问用户', () => {
    const verdict = assessSyncSafety({ local: state(), localValid: false, localInvalidReason: 'checksum', remote: many(50) });
    expect(verdict).toEqual({ ok: false, kind: 'blocked', reason: 'checksum' });
  });

  it('远端还没有任何有效快照 ⇒ 放行（这就是"第一次上传 0 条不会被拦"的原因）', () => {
    expect(assessSyncSafety({ local: state(), localValid: true })).toEqual({ ok: true });
  });

  it('规则 A：100 → 0 触发，并且 A 与 B 同时报（两条都成立不能只说一条）', () => {
    const verdict = assessSyncSafety({ local: state(), localValid: true, remote: many(100) });
    expect(verdict.ok).toBe(false);
    if (verdict.ok || verdict.kind !== 'suspicious') throw new Error('应当可疑');
    // 会话轴与记录轴各自判一次，所以这里只看会话轴 —— 空库时两条轴同时塌陷是同一件事，
    // 断言"总共只有两条规则"会把这条判据钉成一个假的形状。
    const sessionRules = verdict.rules.filter((rule) => rule.axis === 'sessions').map((rule) => rule.rule);
    expect(sessionRules).toEqual(['A', 'B']);
    expect(verdict.rules[0]).toMatchObject({ axis: 'sessions', previous: 100, current: 0 });
  });

  it('规则 B：100 → 5 触发', () => {
    const verdict = assessSyncSafety({ local: many(5), localValid: true, remote: many(100) });
    expect(verdict.ok).toBe(false);
    if (verdict.ok || verdict.kind !== 'suspicious') throw new Error('应当可疑');
    expect(verdict.rules.map((rule) => rule.rule)).toContain('B');
  });

  it('100 → 80 不触发：那是正常清理，天天问用户就废了', () => {
    expect(assessSyncSafety({ local: many(80), localValid: true, remote: many(100) })).toEqual({ ok: true });
  });

  it('小库清空不触发（阈值以下不参与）：10 → 0 与 20 → 0 都放行', () => {
    for (const size of [1, 10, 20]) {
      expect(assessSyncSafety({ local: state(), localValid: true, remote: many(size) }), `size ${size}`).toEqual({ ok: true });
    }
    // 正向对照：刚过线就必须拦
    expect(assessSyncSafety({ local: state(), localValid: true, remote: many(SUSPICIOUS_MIN_PREVIOUS + 1) }).ok).toBe(false);
  });

  it('记录轴也单独检查：会话数没塌但每条都空了，同样是数据丢失', () => {
    const verdict = assessSyncSafety({
      local: many(30, 0),
      localValid: true,
      remote: many(30, 5),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok || verdict.kind !== 'suspicious') throw new Error('应当可疑');
    expect(verdict.rules.every((rule) => rule.axis === 'records')).toBe(true);
  });

  it('countsOf 两条轴分开数', () => {
    const counts = countsOf(many(3, 4));
    expect(counts).toEqual({ sessions: 3, records: 12 });
  });
});

/**
 * 回收站进同步。
 *
 * 这里每条断言都对应一种"用户会怎么骂"：
 * 收不到另一台的删除 ⇒ "同步了个寂寞"；处理过的行又回来 ⇒ "我明明删了"；
 * 并集吞掉记录 ⇒ 静默丢数据；合并不对称 ⇒ 每轮同步都往远端堆一个等价快照。
 */
function row(
  groupId: string,
  tabIds: string[],
  input: {
    deletedAt?: number;
    expiresAt?: number;
    reason?: DeleteReason;
    recordReasons?: Partial<Record<string, DeleteReason>>;
  } = {},
): TrashEntry {
  const deletedAt = input.deletedAt ?? at(100);
  const tabs = tabIds.map((id, index) => savedTabFixture(groupId, id, index));
  const entry: TrashEntry = {
    group: groupFixture(`会话 ${groupId}`, tabs, { id: groupId, updatedAt: deletedAt }),
    deletedAt,
    expiresAt: input.expiresAt ?? deletedAt + 7 * 86_400_000,
    reason: input.reason ?? 'user-delete',
  };
  if (input.recordReasons !== undefined) entry.recordReasons = input.recordReasons;
  return entry;
}

/** `'trash'` 那一种墓碑：整行被用户处理掉了（还原整行 / 彻底删除整行 / 逐条删到空）。 */
function trashMarker(groupId: string, deletedAt: number): Tombstone {
  return tomb(groupId, deletedAt, { entityType: 'trash', id: `trash-${groupId}-${deletedAt}` });
}

function rowOf(merged: StoredState, groupId: string): TrashEntry | undefined {
  return trashOf(merged).find((entry) => entry.group.id === groupId);
}

function recordIds(entry: TrashEntry | undefined): string[] {
  return (entry?.group.tabs ?? []).map((tab) => tab.id);
}

describe('回收站进同步', () => {
  it('一边删掉的会话 ⇒ 另一边同步后回收站里有那一行，记录一条不少', () => {
    // B 手上这个会话还活着（远端那一版是 A 删完推上去的）
    const local = state({ groups: [session('g1', at(50))] });
    const remote = state({ tombstones: [tomb('g1', at(100))], trash: [row('g1', ['g1-a', 'g1-b'])] });

    const merged = mergeStates({ local, remote }).state;
    expect(merged.groups).toHaveLength(0);
    expect(recordIds(rowOf(merged, 'g1'))).toEqual(['g1-a', 'g1-b']);

    // 正向对照：远端**没有** trash 这个键（老版本写的载荷）。
    // 只测"新键读得动"的话，把 `trashOf` 写成 `state.trash!` 也不会红 —— 这条钉住"缺席 = 空"。
    const legacy = mergeStates({ local, remote: state({ tombstones: [tomb('g1', at(100))] }) }).state;
    expect(trashOf(legacy)).toEqual([]);
  });

  it('两边同一行各有对方没见过的记录 ⇒ 并集；行的寿命跟最新的记录走', () => {
    const merged = mergeStates({
      local: state({ trash: [row('g1', ['g1-a'], { deletedAt: at(100) })] }),
      remote: state({ trash: [row('g1', ['g1-a', 'g1-b'], { deletedAt: at(120) })] }),
    }).state;

    const entry = rowOf(merged, 'g1');
    expect(recordIds(entry)).toEqual(['g1-a', 'g1-b']);
    // deletedAt 取较早（这一行最早是什么时候进的回收站），expiresAt 取较晚（最新的记录起算 7 天）
    expect(entry?.deletedAt).toBe(at(100));
    expect(entry?.expiresAt).toBe(at(120) + 7 * 86_400_000);
  });

  it('整行被处理掉的不再回来，两个方向都一样', () => {
    const withMarker = state({ trash: [row('g1', ['g1-a'], { deletedAt: at(100) })], tombstones: [trashMarker('g1', at(200))] });
    const withRow = state({ trash: [row('g1', ['g1-a'], { deletedAt: at(100) })] });

    expect(trashOf(mergeStates({ local: withMarker, remote: withRow }).state)).toEqual([]);
    expect(trashOf(mergeStates({ local: withRow, remote: withMarker }).state)).toEqual([]);
  });

  /** 标记之后又被删一次的那一行**必须**留着 —— 一旦压住就永不回来是另一种数据消失。 */
  it('标记早于这一行的来历 ⇒ 这一行照旧显示', () => {
    const merged = mergeStates({
      local: state({ tombstones: [trashMarker('g1', at(50))] }),
      remote: state({ trash: [row('g1', ['g1-a'], { deletedAt: at(100) })] }),
    }).state;
    expect(recordIds(rowOf(merged, 'g1'))).toEqual(['g1-a']);
  });

  /**
   * 合并必须**可交换**。A 算 `merge(local=A, remote=B)`、B 算 `merge(local=B, remote=A)`，
   * 回收站那一部分要逐字节相同 —— 不然两台机器各推一版等价快照，
   * 既有约定 的"同内容不重复进历史"当场失效。
   *
   * 只比 `trash` 那一段：会话的 LWW 在平手时刻意"取本地"（`pickNewer`），那是会话层的既有取舍。
   */
  it('可交换：同一对状态换个方向算，回收站部分逐字节相同', () => {
    const a = state({
      trash: [
        row('g1', ['g1-a'], { deletedAt: at(100), reason: 'consumed' }),
        row('g2', ['g2-x', 'g2-y'], { deletedAt: at(300) }),
      ],
    });
    const b = state({
      trash: [
        row('g1', ['g1-a', 'g1-b'], { deletedAt: at(120) }),
        row('g2', ['g2-x'], { deletedAt: at(300) }),
        row('g3', ['g3-only-b'], { deletedAt: at(90) }),
      ],
      tombstones: [trashMarker('g4', at(400))],
    });

    const forward = mergeStates({ local: a, remote: b }).state;
    const backward = mergeStates({ local: b, remote: a }).state;
    expect(canonicalJson(forward.trash)).toBe(canonicalJson(backward.trash));
    // 不是"两边都空所以相同"那种假绿：确实并出了东西
    expect(trashOf(forward).map((entry) => entry.group.id)).toEqual(['g2', 'g1', 'g3']);
    expect(recordIds(rowOf(forward, 'g1'))).toEqual(['g1-a', 'g1-b']);
  });

  /**
   * 记录级的"捞走其中一条 / 逐条彻底删除"**不传播**，这是定的口径不是漏的 bug：
   * 要传播就得记"这条被拿走了"，而那要么吞掉另一边合法新增的同一条记录（静默丢一条可恢复的数据），
   * 要么什么都防不住。详见 `merge.ts` 的 `mergeTrash` 函数头。
   */
  it('一边逐条删掉的那一条，同步后会从另一边的并集里回来（有意的取舍）', () => {
    const merged = mergeStates({
      // A 上这一行只剩 b（a 被逐条彻底删掉了）
      local: state({ trash: [row('g1', ['g1-b'])] }),
      remote: state({ trash: [row('g1', ['g1-a', 'g1-b'])] }),
    }).state;
    expect(recordIds(rowOf(merged, 'g1'))).toEqual(['g1-a', 'g1-b']);
  });

  it('两边都被删空的行不留空壳', () => {
    const merged = mergeStates({
      local: state({ trash: [row('g1', [])] }),
      remote: state({ trash: [row('g1', [])] }),
    }).state;
    expect(trashOf(merged)).toEqual([]);
  });

  it('记录级来历跟着保留，行的主标记按"最像用户删除"算', () => {
    const merged = mergeStates({
      local: state({ trash: [row('g1', ['g1-a'], { reason: 'consumed' })] }),
      remote: state({ trash: [row('g1', ['g1-a', 'g1-b'], { reason: 'consumed' })] }),
    }).state;
    const entry = rowOf(merged, 'g1');
    expect(entry?.reason).toBe('consumed');
    /**
     * 原来这里断的是 `entry?.recordReasons` 这个**落盘形状**。既有约定 之后改写判据的方式：
     * 读侧只许有一条路（`recordReason` 走 `recordsOf`，新形状 `records`、旧形状 `recordReasons`
     * 都兜），所以钉"用户看得见的性质"而不是钉某一份键名 —— 键名换一次就要改一条用例，
     * 而"每条记录各自的来历不能被行的主标记抹平"这条才是判据本身。
     */
    expect(entry ? recordReason(entry, 'g1-a') : undefined).toBe('consumed');
    expect(entry ? recordReason(entry, 'g1-b') : undefined).toBe('consumed');
    expect(Object.keys(entry?.records ?? {}).sort()).toEqual(['g1-a', 'g1-b']);

    const mixed = mergeStates({
      local: state({ trash: [row('g1', ['g1-a'], { reason: 'user-delete' })] }),
      remote: state({ trash: [row('g1', ['g1-a'], { reason: 'consumed' })] }),
    }).state;
    expect(mixed.trash?.[0]?.reason).toBe('user-delete');
  });

  /**
   * 两台机器版本不一致时的那一侧：**旧版本推上去的那一版载荷里没有 `trash` 键**
   * （它的 `readStoredState` 压根不读回收站）。这条断言的是"缺席 = 空"，
   * 而不是"缺席 = 把对面那一行清掉" —— 否则用户只要有一台没重载扩展，回收站就会被抹。
   */
  it('对面那一版没有 trash 键（旧产物）⇒ 本机的行照样留下', () => {
    const mine = state({ trash: [row('g1', ['g1-a', 'g1-b'], { deletedAt: at(100) })] });
    const legacy = state({ tombstones: [tomb('g9', at(50))] });

    const merged = mergeStates({ local: mine, remote: legacy }).state;
    expect(recordIds(rowOf(merged, 'g1'))).toEqual(['g1-a', 'g1-b']);
    // 反向也一样（可交换）
    expect(recordIds(rowOf(mergeStates({ local: legacy, remote: mine }).state, 'g1'))).toEqual(['g1-a', 'g1-b']);
  });

  it('异常检测的两条轴都不数回收站：一次清空回收站不该被当成数据塌陷', () => {
    const live = [session('s1', at(1)), session('s2', at(2)), session('s3', at(3))];
    const bin = Array.from({ length: 300 }, (_, index) => row(`d${index}`, [`d${index}-a`], { deletedAt: at(10) }));

    expect(
      assessSyncSafety({
        local: state({ groups: live, trash: bin }),
        localValid: true,
        remote: state({ groups: live }),
      }),
    ).toEqual({ ok: true });
    expect(countsOf(state({ groups: live, trash: bin }))).toEqual({ sessions: 3, records: 3 });

    // 正向对照：会话真的塌了照样拦 —— 上面那条绿不是"检测坏了"
    const collapsed = assessSyncSafety({
      local: state({ groups: [], trash: bin }),
      localValid: true,
      remote: state({ groups: Array.from({ length: 30 }, (_, index) => session(`s${index}`, at(index + 1))) }),
    });
    expect(collapsed.ok).toBe(false);
  });
});

function savedTabFixtureArray(groupId: string, count: number) {
  return Array.from({ length: count }, (_, index) => savedTabFixture(groupId, `${groupId}-t${index}`, index));
}
