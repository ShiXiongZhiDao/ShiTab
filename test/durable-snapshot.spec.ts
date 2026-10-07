// @vitest-environment node

// 双槽快照 + gzip + SHA-256 这条链子在真机上由 background service worker 执行，
// 所以这里刻意跑在 node 环境：`CompressionStream`/`crypto.subtle`/`btoa` 这些"看起来像
// 浏览器 API"的东西到底在 SW 里存不存在，用 node 当替身最接近（node 没有 DOM，也只有
// worker 那一档全局）。既有约定 之后这条不再是可选项。
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import type { StoragePort } from '@/core/ports/storage';
import {
  captureDurableSnapshot,
  readValidEnvelope,
  recoverDurableState,
  readStoredState,
} from '@/core/application/durable-snapshot';
import { emptyState, inactiveSlot, pickValidSlot, sealState, verifyEnvelope } from '@/core/domain/durable-state';
import { softDeleteGroup } from '@/core/application/delete-model';
import { groupFixture, savedTabFixture } from './fixtures';
import { STORAGE_KEYS } from '@/shared/constants';
import type { SlotName, StateEnvelope, StoredState } from '@/shared/types';
import type { SnapshotOutcome } from '@/core/application/durable-snapshot';
import { gzipToBase64 } from '@/core/domain/gzip';

function depsOf(storage: StoragePort) {
  return { storage };
}

type SnapshotSuccess = Extract<SnapshotOutcome, { ok: true }>;

/**
 * 快照的返回是判别联合，直接 `.slot` 会带进一条"失败也算通过"的歧义。
 * 这里让失败**带着原因炸掉测试**，而不是让断言去猜 union。
 */
function mustSucceed(outcome: SnapshotOutcome): SnapshotSuccess {
  if (!outcome.ok) throw new Error(`快照失败：${outcome.reason}（revision ${outcome.revision}）`);
  return outcome;
}

/** 往主存储里放两组共 5 条记录。走 putGroup，所以 index 与 group 键同时成立。 */
async function seed(storage: StoragePort): Promise<void> {
  const first = groupFixture(
    '阅读',
    [savedTabFixture('seed-a', 'seed-a-t0', 0), savedTabFixture('seed-a', 'seed-a-t1', 1)],
    { id: 'seed-a', sortOrder: 2 },
  );
  const second = groupFixture(
    '工作',
    [
      savedTabFixture('seed-b', 'seed-b-t0', 0),
      savedTabFixture('seed-b', 'seed-b-t1', 1),
      savedTabFixture('seed-b', 'seed-b-t2', 2),
    ],
    { id: 'seed-b', sortOrder: 1 },
  );
  await storage.putGroup(first);
  await storage.putGroup(second);
}

const rawSlot = async (slot: SlotName): Promise<string | null> => {
  const key = slot === 'a' ? STORAGE_KEYS.snapshotSlotA : STORAGE_KEYS.snapshotSlotB;
  const value = (await browser.storage.local.get(key)) as Record<string, unknown>;
  const stored = value[key];
  return typeof stored === 'string' ? stored : null;
};

const writeRawSlot = async (slot: SlotName, value: string): Promise<void> => {
  const key = slot === 'a' ? STORAGE_KEYS.snapshotSlotA : STORAGE_KEYS.snapshotSlotB;
  await browser.storage.local.set({ [key]: value });
};

it('环境自查：这里没有 DOM，和 service worker 一样', () => {
  // 文件顶上的 `@vitest-environment node` 被人删掉时不会有任何别的症状 ——
  // 本文件照样全绿，只是失去了"快照链不许依赖 DOM"这道闸。
  expect('document' in globalThis).toBe(false);
  expect('DOMParser' in globalThis).toBe(false);
});

describe('耐久快照：checksum 与验证', () => {
  it('同一份内容盖两次章得到同一个 checksum（这是远端去重的前提）', async () => {
    const payload = emptyState();
    const one = await sealState(payload, 1, 1000);
    const two = await sealState(payload, 2, 9000);
    expect(one.checksum).toBe(two.checksum);
    expect(one.revision).toBe(1);
    expect(two.revision).toBe(2);
  });

  it('内容改一个字符，checksum 就变（损坏检测不能被"差不多"糊过去）', async () => {
    const base = await sealState(emptyState(), 1, 1000);
    const changed: StoredState = { ...emptyState(), categories: [{ id: 'c1', name: '阅读', sortOrder: 1, createdAt: 1, updatedAt: 1 }] };
    const other = await sealState(changed, 1, 1000);
    expect(base.checksum).not.toBe(other.checksum);
  });

  it('没写过（null）与空串都判成 empty', async () => {
    for (const stored of [null, undefined, '']) {
      const result = await verifyEnvelope(stored);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('empty');
    }
  });

  it('解不开 base64/gzip 判成 unzip', async () => {
    const result = await verifyEnvelope('not-gzip-base64!!!');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unzip');
  });

  it('格式标记不对判成 format（隔壁仓库的快照不能被本仓库当成有效）', async () => {
    const forged = await gzipToBase64(JSON.stringify({ format: 'otherproduct-state', schemaVersion: 1, revision: 1, savedAt: 1, payload: emptyState(), checksum: 'x'.repeat(64) }));
    const result = await verifyEnvelope(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('format');
  });

  it('形状残缺判成 shape，不是抛 TypeError', async () => {
    const missing = await gzipToBase64(JSON.stringify({ format: 'shitab-state', schemaVersion: 1, revision: 1, savedAt: 1, payload: { groups: [] }, checksum: 'z' }));
    const result = await verifyEnvelope(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('shape');
  });

  it('内容自洽但 checksum 对不上 ⇒ 判成 checksum（§4「损坏数据永远不能成为同步源」的落点）', async () => {
    const envelope = await sealState(emptyState(), 7, 1000);
    const tampered = { ...envelope, payload: { ...envelope.payload, categories: [{ id: 'x', name: '塞进来的', sortOrder: 1, createdAt: 1, updatedAt: 1 }] } };
    const result = await verifyEnvelope(await gzipToBase64(JSON.stringify(tampered)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('checksum');
  });

  it('两槽都有效时取 revision 高的；同 revision 时内容必相同所以任取安全', () => {
    const mk = (revision: number) => ({ ok: true as const, envelope: { revision } as StateEnvelope });
    const picked = pickValidSlot([
      { slot: 'a' as const, result: mk(3) },
      { slot: 'b' as const, result: mk(9) },
    ]);
    expect(picked?.slot).toBe('b');
    expect(picked?.envelope.revision).toBe(9);

    const withOneBroken = pickValidSlot([
      { slot: 'a' as const, result: mk(9) },
      { slot: 'b' as const, result: { ok: false as const, reason: 'unzip' as const } },
    ]);
    expect(withOneBroken?.slot).toBe('a');
    expect(pickValidSlot([])).toBeUndefined();
  });

  it('inactiveSlot 就是"与指针相反"，指针只有一个值被翻动', () => {
    expect(inactiveSlot('a')).toBe('b');
    expect(inactiveSlot('b')).toBe('a');
  });
});

describe('耐久快照：写入顺序与启动恢复', () => {
  let storage: StoragePort;

  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
    storage = createStoragePort();
    await storage.heal();
  });

  it('第一次拍快照写进 b 槽（指针默认 a，所以新版本先进 inactive），翻指针后 a 槽仍是空的', async () => {
    await seed(storage);
    const outcome = await captureDurableSnapshot(depsOf(storage), 2000);

    expect(mustSucceed(outcome).revision).toBe(1);
    expect(outcome.ok).toBe(true);
    expect(mustSucceed(outcome).slot).toBe('b');
    expect(await storage.getSnapshotPointer()).toBe('b');
    expect(await rawSlot('a')).toBeNull();
    expect(await rawSlot('b')).not.toBeNull();
  });

  it('连拍两次：第二次落在另一槽，两槽都留着可读（这就是崩溃窗口里有上一版可退的原因）', async () => {
    await seed(storage);
    const first = await captureDurableSnapshot(depsOf(storage), 2000);
    expect(mustSucceed(first).slot).toBe('b');
    const second = await captureDurableSnapshot(depsOf(storage), 3000);
    expect(mustSucceed(second).slot).toBe('a');
    expect(mustSucceed(second).revision).toBe(2);
    expect(await rawSlot('a')).not.toBeNull();
    expect(await rawSlot('b')).not.toBeNull();
  });

  /**
   * §19「上传中浏览器崩溃 ⇒ 旧 snapshot 仍在」的第一种崩溃点：
   * 写完 inactive 槽、还没翻指针。
   *
   * 这里我一开始把期望写反了（以为"指针没翻就该回旧版"），跑出来才红：
   * §3.2 的恢复规则是"取**最高 revision 的有效版本**"，不是"取指针那一槽"。
   * 半截写之所以危险是因为它**无效**，而一个完整的新版本没有任何理由被丢弃 ——
   * 指针只在两槽都有效**且内容不同**时才需要参与，而那种情况不会发生在单写者串行队列上。
   * 旧快照仍然在另一槽里可读，这一条没变。
   */
  it('崩溃在"写完 inactive、指针未翻"：恢复取最高 revision 的有效版，旧版仍在另一槽可读', async () => {
    await seed(storage);
    const old = await captureDurableSnapshot(depsOf(storage), 2000);
    expect(mustSucceed(old).slot).toBe('b');

    // 崩溃点：写完了 a 槽，但进程在 commitSnapshotPointer 之前就没了
    const awaitTarget = createStoragePort();
    const pointer = await awaitTarget.getSnapshotPointer();
    expect(pointer).toBe('b');
    const payload = await readStoredState(depsOf(awaitTarget));
    const envelope = await sealState({ ...payload, categories: [{ id: 'c1', name: '崩溃前刚加的分类', sortOrder: 1, createdAt: 3000, updatedAt: 3000 }] }, 2, 3000);
    await awaitTarget.writeSnapshotSlot('a', await gzipToBase64(JSON.stringify(envelope)));
    // ← 没有 commitSnapshotPointer，这就是崩溃

    const recovered = await recoverDurableState(depsOf(awaitTarget));
    expect(recovered.slot).toBe('a');
    expect(recovered.envelope?.revision).toBe(2);
    // 旧那一版没被销毁：它还在 b 槽里，且仍然有效
    expect(recovered.details.find((detail) => detail.slot === 'b')?.ok).toBe(true);
    const stale = await verifyEnvelope(await awaitTarget.readSnapshotSlot('b'));
    expect(stale.ok).toBe(true);
    if (stale.ok) expect(stale.envelope.revision).toBe(1);
  });

  /**
   * §19「上传中浏览器崩溃 ⇒ 旧 snapshot 仍在」的第二种崩溃点：写到一半就断，
   * inactive 槽里留下半截东西。这是双槽真正防的那件事。
   */
  it('崩溃在"写 inactive 写到一半"：那一槽被判无效，恢复退回上一版', async () => {
    await seed(storage);
    await captureDurableSnapshot(depsOf(storage), 2000); // b 槽，revision 1

    const target = createStoragePort();
    await target.writeSnapshotSlot('a', 'H4sIAAAAAAAA'); // gzip 头，正文没有 —— 半截写的样子

    const recovered = await recoverDurableState(depsOf(target));
    expect(recovered.slot).toBe('b');
    expect(recovered.envelope?.revision).toBe(1);
    expect(recovered.details.find((detail) => detail.slot === 'a')?.ok).toBe(false);
  });

  /**
   * §19「本地 slot 损坏 ⇒ 恢复另一个有效 slot」，以及 §19「checksum 失败 ⇒ 禁止上传」。
   * 这里用"往当前有效槽里灌一坨解不开的东西"来代表物理损坏。
   */
  it('当前有效槽被写坏：恢复退回另一槽，并如实报出坏槽的原因', async () => {
    await seed(storage);
    await captureDurableSnapshot(depsOf(storage), 2000); // → b 槽，revision 1
    const good = await captureDurableSnapshot(depsOf(storage), 3000); // → a 槽，revision 2
    expect(mustSucceed(good).slot).toBe('a');

    await writeRawSlot('a', 'GGdTjVlZGl0ZWQtc2xvdA=='); // 能 base64 解码但不是我们的 gzip 载荷

    const recovered = await recoverDurableState(depsOf(storage));
    expect(recovered.envelope?.revision).toBe(1);
    expect(recovered.slot).toBe('b');
    const broken = recovered.details.find((detail) => detail.slot === 'a');
    expect(broken?.ok).toBe(false);
    expect(['unzip', 'not-json', 'shape', 'checksum']).toContain(broken?.reason);
  });

  it('两槽都坏 ⇒ envelope 是 null，不是空状态（"没有快照"与"快照是空的"是两件事）', async () => {
    await seed(storage);
    await captureDurableSnapshot(depsOf(storage), 2000);
    await writeRawSlot('a', 'junk');
    await writeRawSlot('b', 'junk');

    const recovered = await recoverDurableState(depsOf(storage));
    expect(recovered.envelope).toBeNull();
    expect(recovered.slot).toBeNull();
    expect(recovered.details.every((detail) => !detail.ok)).toBe(true);
  });

  it('从没拍过快照时 recover 也是 null，readValidEnvelope 不返回空状态冒充有效数据', async () => {
    const envelope = await readValidEnvelope(depsOf(storage));
    expect(envelope).toBeNull();
  });

  it('快照内容真的等于主存储：删掉一组再拍，组数跟着变小，恢复出来能对上', async () => {
    await seed(storage);
    const before = await captureDurableSnapshot(depsOf(storage), 2000);
    expect(mustSucceed(before).envelope.payload.groups).toHaveLength(2);

    await storage.removeGroup('seed-a');
    const after = await captureDurableSnapshot(depsOf(storage), 3000);
    const groups = mustSucceed(after).envelope.payload.groups;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe('工作');

    const recovered = await readValidEnvelope(depsOf(storage));
    expect(recovered?.payload.groups.map((group) => group.id)).toEqual(['seed-b']);
    // 正向对照：fixture 改 id 时把 tab.groupId 一起改了，所以快照里的归属关系是真的自洽
    // （只断言"组数变少了"抓不到"tab 说自己属于另一个组"这种假形状）。
    for (const group of recovered?.payload.groups ?? []) {
      for (const tab of group.tabs) expect(tab.groupId).toBe(group.id);
    }
  });

  it('readStoredState 把 tombstones 一起带上（删除要能传播，靠的就是这一项）', async () => {
    await storage.setTombstones([
      { id: 't1', entityType: 'group', entityId: 'seed-a', deletedAt: 1500, deletedByDeviceId: 'dev-1', reason: 'user-delete' },
    ]);
    const state = await readStoredState(depsOf(storage));
    expect(state.tombstones).toHaveLength(1);
    expect(state.groups).toHaveLength(0);
  });

  /**
   * 回收站也在载荷里。这里盯的是两件容易漏的事：
   * **缺席时这个键也要写出来**（空数组），以及"写出去 = 读回来"。
   * 少了前一条，"回收站是空的"与"这台机器还没升级"在两台设备上算出两个 checksum，
   * 每轮同步都会多一个内容一模一样的远端快照。
   */
  it('readStoredState 把回收站一起带上，没有条目时也是空数组而不是缺键', async () => {
    const empty = await readStoredState(depsOf(storage));
    expect('trash' in empty).toBe(true);
    expect(empty.trash).toEqual([]);

    await storage.putGroup(groupFixture('会话 seed-c', [savedTabFixture('seed-c', 'seed-c-t0', 0)], { id: 'seed-c' }));
    await softDeleteGroup({ storage }, { groupId: 'seed-c', reason: 'user-delete', at: 1500 });

    const state = await readStoredState(depsOf(storage));
    expect(state.trash?.map((entry) => entry.group.id)).toEqual(['seed-c']);
    expect(state.groups).toHaveLength(0);
  });

  /**
   * 既有约定 的实现前提第 3 条：新键不能撞上 `groupKeyPrefix` 的前缀扫描，
   * 否则某次迁移之后 `heal()` 会把快照当成一个会话，"自愈反而制造脏数据"。
   */
  it('拍过快照之后再 heal，一次自愈动作都不产生', async () => {
    await seed(storage);
    await captureDurableSnapshot(depsOf(storage), 2000);
    await captureDurableSnapshot(depsOf(storage), 3000);
    await storage.setTombstones([]);

    const fresh = createStoragePort();
    const report = await fresh.heal();
    expect(report.droppedFromIndex).toBe(0);
    expect(report.rebuiltIntoIndex).toBe(0);
    expect(report.groupCount).toBe(2);
  });

  it('配额写失败时不翻指针：当前有效快照仍然是旧的那一版', async () => {
    await seed(storage);
    const old = await captureDurableSnapshot(depsOf(storage), 2000);
    expect(mustSucceed(old).slot).toBe('b');

    const boom = createStoragePort();
    const original = boom.writeSnapshotSlot.bind(boom);
    boom.writeSnapshotSlot = (slot: SlotName, value: string) => {
      if (slot === 'a') return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
      return original(slot, value);
    };

    const failed = await captureDurableSnapshot(depsOf(boom), 3000);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.reason).toBe('write-failed');
    expect(await boom.getSnapshotPointer()).toBe('b');
    const recovered = await readValidEnvelope(depsOf(boom));
    expect(recovered?.revision).toBe(1);
  });

  it('回读验不过时也不翻指针，并报 readback-invalid', async () => {
    await seed(storage);
    const first = await captureDurableSnapshot(depsOf(storage), 2000);
    expect(mustSucceed(first).slot).toBe('b');

    const liar = createStoragePort();
    const original = liar.writeSnapshotSlot.bind(liar);
    liar.writeSnapshotSlot = async (slot: SlotName, value: string) => {
      // 落盘时悄悄改**开头**两个 base64 字符：gzip 魔数被打断，promise 成功、盘上是坏货。
      // 改头不改尾是有意的 —— 尾部的几个字符可能落在补位上，改了也可能照样解得开，
      // 那这条用例就会"偶然通过"，测不到它想测的东西。
      await original(slot, `AA${value.slice(2)}`);
    };

    const failed = await captureDurableSnapshot(depsOf(liar), 3000);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.reason).toBe('readback-invalid');
    expect(await liar.getSnapshotPointer()).toBe('b');
  });
});

describe('回收站与墓碑的存取（既有约定 的存储面）', () => {
  let storage: StoragePort;

  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
    storage = createStoragePort();
    await storage.heal();
  });

  it('墓碑按 deletedAt 升序返回：合并时要按时间判先后', async () => {
    await storage.setTombstones([
      { id: 't2', entityType: 'group', entityId: 'b', deletedAt: 300, deletedByDeviceId: 'd', reason: 'consumed' },
      { id: 't1', entityType: 'group', entityId: 'a', deletedAt: 100, deletedByDeviceId: 'd', reason: 'user-delete' },
    ]);
    const list = await storage.listTombstones();
    expect(list.map((item) => item.deletedAt)).toEqual([100, 300]);
  });

  it('回收站按删除时间降序，且同一会话重复放入只留最后一条', async () => {
    await storage.putTrash({ group: groupFixture('早', []), deletedAt: 100, expiresAt: 900, reason: 'user-delete' });
    await storage.putTrash({ group: groupFixture('晚', []), deletedAt: 200, expiresAt: 900, reason: 'user-delete' });
    await storage.putTrash({
      group: { ...groupFixture('晚（改写）', []), id: 'dup' },
      deletedAt: 300,
      expiresAt: 900,
      reason: 'consumed',
    });
    const list = await storage.listTrash();
    expect(list.map((item) => item.deletedAt)).toEqual([300, 200, 100]);

    await storage.putTrash({ group: { ...list[1]!.group, title: '覆盖我' }, deletedAt: 200, expiresAt: 900, reason: 'user-delete' });
    const after = await storage.listTrash();
    expect(after.find((item) => item.deletedAt === 200)?.group.title).toBe('覆盖我');
  });

  it('removeTrash 摘掉指定会话，摘不存在的-id 是无声成功', async () => {
    const group = groupFixture('要没了', []);
    await storage.putTrash({ group, deletedAt: 100, expiresAt: 900, reason: 'user-delete' });
    await storage.removeTrash(group.id);
    expect(await storage.listTrash()).toHaveLength(0);
    await expect(storage.removeTrash('nope')).resolves.toBeUndefined();
  });

  it('回收站不参与分键自愈：heal 之后它一条不少（它不是 index 的成员）', async () => {
    await seed(storage);
    await storage.putTrash({ group: groupFixture('留着', []), deletedAt: 100, expiresAt: 900, reason: 'user-delete' });
    const fresh = createStoragePort();
    await fresh.heal();
    expect(await fresh.listTrash()).toHaveLength(1);
    expect(await fresh.listGroupIndex()).toHaveLength(2);
  });
});
