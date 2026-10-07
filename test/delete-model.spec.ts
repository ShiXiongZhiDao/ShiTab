import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import type { StoragePort } from '@/core/ports/storage';
import {
  compactTombstones,
  entersTrash,
  mergeIntoTrash,
  purgeFromTrash,
  purgeTrashTab,
  recordReason,
  restoreFromTrash,
  restoreTrashTab,
  softDeleteGroup,
  sweepExpiredTrash,
} from '@/core/application/delete-model';
import { deleteGroup, GroupLockedError, removeTabToTrash, toggleLock } from '@/core/application/group-commands';
import { readStoredState } from '@/core/application/durable-snapshot';
import { restoreGroup, restoreTab, undoCapture } from '@/core/application/restore-group';
import { createFakeBrowserTabsPort } from '@/infrastructure/testing/fake-browser-tabs';
import { groupFixture, savedTabFixture } from './fixtures';
import { TRASH_RETENTION_MS } from '@/shared/constants';
import type { TabGroup, Tombstone } from '@/shared/types';

const AT = 1_700_000_000_000;

let storage: StoragePort;

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  storage = createStoragePort();
  await storage.heal();
});

async function seedGroup(id: string, tabCount = 2, overrides: Partial<TabGroup> = {}): Promise<TabGroup> {
  const group = groupFixture(
    `会话 ${id}`,
    Array.from({ length: tabCount }, (_, index) => savedTabFixture(id, `${id}-t${index}`, index)),
    { id, sortOrder: index2SortOrder(id), ...overrides },
  );
  await storage.putGroup(group);
  return group;
}

/** 让 id 决定顺序，这样"回收站按删除时间降序"以外的因素不会干扰断言。 */
function index2SortOrder(id: string): number {
  return id.charCodeAt(id.length - 1);
}

const tombstonesOf = async (): Promise<Tombstone[]> => storage.listTombstones();

describe('回收站是否进得去（既有约定 的三条删除路径，consumed 由 既有约定 改判）', () => {
  it('判据：user-delete 与 consumed 进，undone 不进', () => {
    expect(entersTrash('user-delete')).toBe(true);
    // 恢复即消费也进回收站：恢复完手滑关掉窗口，那批 URL 只剩这一份了
    expect(entersTrash('consumed')).toBe(true);
    expect(entersTrash('undone')).toBe(false);
  });

  it('用户点删除：会话从列表消失、进回收站、留一条 user-delete 墓碑', async () => {
    await seedGroup('g1');
    await deleteGroup({ storage }, { groupId: 'g1' });

    expect(await storage.getGroup('g1')).toBeUndefined();
    const trash = await storage.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]?.group.id).toBe('g1');
    expect(trash[0]?.reason).toBe('user-delete');
    // 这里不能钉绝对时间：`deleteGroup` 自己取 `now()`（它是真实入口，不是注入点）。
    // 要钉的是**跨度** —— 7 天这条线是产品承诺，与几点删的无关。
    const entry = trash[0];
    expect(entry).toBeDefined();
    expect(entry!.expiresAt - entry!.deletedAt).toBe(TRASH_RETENTION_MS);
    expect(entry!.deletedAt).toBeGreaterThan(0);

    const tombs = await tombstonesOf();
    expect(tombs).toHaveLength(1);
    expect(tombs[0]).toMatchObject({ entityType: 'group', entityId: 'g1', reason: 'user-delete' });
    expect(tombs[0]?.deletedByDeviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * 这条是本模块存在的理由（Q5 的定案）。恢复即消费**必须**留墓碑：
   * 不留的话另一台设备下一次同步会把这个会话再恢复一次，开出第二批重复标签页。
   */
  it('恢复即消费：留 consumed 墓碑，**也进回收站**', async () => {
    await seedGroup('g9', 2);
    const tabs = createFakeBrowserTabsPort({ windows: [{ id: 2, tabs: [] }] });

    const result = await restoreGroup({ tabs, storage }, { groupId: 'g9', windowId: 2 });
    expect(result.restored).toBe(2);

    const tombs = await tombstonesOf();
    expect(tombs).toHaveLength(1);
    expect(tombs[0]).toMatchObject({ entityId: 'g9', reason: 'consumed' });
    const trash = await storage.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ reason: 'consumed' });
    // 整组快照原样留着：还原要能拿回"那 2 条是哪些"，只存 id 等于没存
    expect(trash[0]?.group.tabs).toHaveLength(2);
  });

  /** 会话被锁定时不消费（既有约定 + 既有约定），所以也不该留下任何删除痕迹。 */
  it('锁定的会话恢复之后不消费：没有墓碑、没有回收站条目', async () => {
    await seedGroup('locked1', 2, { locked: true });
    const tabs = createFakeBrowserTabsPort({ windows: [{ id: 2, tabs: [] }] });

    const result = await restoreGroup({ tabs, storage }, { groupId: 'locked1', windowId: 2 });
    expect(result.restored).toBe(2);
    expect(await tombstonesOf()).toHaveLength(0);
    expect(await storage.listTrash()).toHaveLength(0);
    expect(await storage.getGroup('locked1')).toBeDefined();
  });

  it('撤销收纳：留 undone 墓碑，不进回收站（那条会话本来只活了 10 秒）', async () => {
    await seedGroup('u1', 2);
    const tabs = createFakeBrowserTabsPort({ windows: [{ id: 2, tabs: [] }] });

    await undoCapture({ tabs, storage }, { groupId: 'u1', windowId: 2 });

    const tombs = await tombstonesOf();
    expect(tombs).toHaveLength(1);
    expect(tombs[0]).toMatchObject({ entityId: 'u1', reason: 'undone' });
    expect(await storage.listTrash()).toHaveLength(0);
  });

  /**
   * 正向对照（缺了它，上面几条"没有回收站条目"的绿可能只是"根本没写进去"）：
   * 同一套 fixture 走两条会进回收站的路，条目数就得是 2；再走 undone 那条，一条都不许多。
   */
  it('对照组：user-delete 与 consumed 都进回收站，undone 不进', async () => {
    await seedGroup('c1', 2);
    await softDeleteGroup({ storage }, { groupId: 'c1', reason: 'user-delete', at: AT });
    expect(await storage.listTrash()).toHaveLength(1);

    await seedGroup('c2', 2);
    await softDeleteGroup({ storage }, { groupId: 'c2', reason: 'consumed', at: AT });
    expect(await storage.listTrash()).toHaveLength(2);

    await seedGroup('c3', 2);
    await softDeleteGroup({ storage }, { groupId: 'c3', reason: 'undone', at: AT });
    expect(await storage.listTrash()).toHaveLength(2);
  });

  /**
   * 恢复掉的条目从回收站再"还原"回列表时，**墓碑必须一起撤销**（既有约定 那条机制对
   * 两种来源一视同仁）。留着的话另一台设备下一次同步会把它再删一遍，
   * 用户看到的是"我在回收站点过还原，换台电脑它又没了"。
   */
  it('还原一条"恢复掉的"条目：回到列表、条目消失、墓碑被撤销', async () => {
    await seedGroup('k1', 2);
    const tabs = createFakeBrowserTabsPort({ windows: [{ id: 2, tabs: [] }] });
    await restoreGroup({ tabs, storage }, { groupId: 'k1', windowId: 2 });
    expect(await tombstonesOf()).toHaveLength(1);
    expect(await storage.listTrash()).toHaveLength(1);

    await restoreFromTrash({ storage }, { groupId: 'k1', at: AT + 60_000 });

    expect(await storage.getGroup('k1')).toBeDefined();
    expect(await storage.listTrash()).toHaveLength(0);
    // 组墓碑被撤销（否则换台电脑它又被删一遍）；留下的是"这一行被用户处理掉了"的那条标记
    // —— 少了它，另一台设备手上那一行会在下一次合并里并回来。
    expect((await tombstonesOf()).filter((tomb) => tomb.entityType === 'group')).toHaveLength(0);
    expect((await tombstonesOf()).map((tomb) => tomb.entityType)).toEqual(['trash']);
  });
});

describe('回收站的还原、清除与过期', () => {
  it('从回收站还原：数据回来了，而且**墓碑被撤销**（否则换台电脑它又被删一遍）', async () => {
    const original = await seedGroup('r1', 3);
    await softDeleteGroup({ storage }, { groupId: 'r1', reason: 'user-delete', at: AT });
    expect(await tombstonesOf()).toHaveLength(1);

    const restored = await restoreFromTrash({ storage }, { groupId: 'r1', at: AT + 1000 });
    expect(restored?.id).toBe('r1');

    const back = await storage.getGroup('r1');
    expect(back?.tabs).toHaveLength(3);
    expect(back?.title).toBe(original.title);
    expect(back?.updatedAt).toBe(AT + 1000);
    // 'group' 那条撤销，'trash' 那条留下（既有约定 的整行处理标记）
    expect((await tombstonesOf()).map((tomb) => tomb.entityType)).toEqual(['trash']);
    expect(await storage.listTrash()).toHaveLength(0);
  });

  it('还原后主列表与索引都重新认得它（putGroup 会同步 index，回收站不是第二份真相）', async () => {
    await seedGroup('r2', 2);
    await softDeleteGroup({ storage }, { groupId: 'r2', reason: 'user-delete', at: AT });
    expect(await storage.listGroupIndex()).toHaveLength(0);

    await restoreFromTrash({ storage }, { groupId: 'r2', at: AT });
    expect((await storage.listGroupIndex()).map((entry) => entry.id)).toEqual(['r2']);
  });

  it('永久删除：回收站里没了，但组墓碑**保留** —— 这次删除是真的，要传播出去', async () => {
    await seedGroup('p1', 2);
    await softDeleteGroup({ storage }, { groupId: 'p1', reason: 'user-delete', at: AT });
    await purgeFromTrash({ storage }, { groupId: 'p1', at: AT + 60_000 });

    expect(await storage.listTrash()).toHaveLength(0);
    // 两条，而且各司其职：`group` 那条是"这个会话被删了"，
    // `trash` 那条是"这一行被用户处理掉了，别再并回来"。
    expect(await tombstonesOf()).toMatchObject([
      { entityType: 'group', entityId: 'p1', reason: 'user-delete' },
      { entityType: 'trash', entityId: 'p1', deletedAt: AT + 60_000 },
    ]);
  });

  it('过期清理：只清到期的，且不产生新墓碑（7 天到了不是一次跨设备的删除风暴）', async () => {
    await seedGroup('e1', 1);
    await seedGroup('e2', 1);
    await softDeleteGroup({ storage }, { groupId: 'e1', reason: 'user-delete', at: AT });
    await softDeleteGroup({ storage }, { groupId: 'e2', reason: 'user-delete', at: AT + TRASH_RETENTION_MS - 1 });

    const removed = await sweepExpiredTrash({ storage }, AT + TRASH_RETENTION_MS);
    expect(removed).toBe(1);
    const left = await storage.listTrash();
    expect(left.map((entry) => entry.group.id)).toEqual(['e2']);
    // 两条墓碑都在，e1 没有因为过期而多出一条
    expect((await tombstonesOf()).map((tomb) => tomb.entityId).sort()).toEqual(['e1', 'e2']);
  });

  it('还原一个不存在的回收站条目返回 undefined，不抛、也不动墓碑', async () => {
    await seedGroup('keep', 1);
    await softDeleteGroup({ storage }, { groupId: 'keep', reason: 'user-delete', at: AT });
    const before = await tombstonesOf();

    expect(await restoreFromTrash({ storage }, { groupId: 'nope', at: AT })).toBeUndefined();
    expect(await tombstonesOf()).toEqual(before);
    expect(await storage.getGroup('keep')).toBeUndefined();
  });
});

describe('删除被拒绝时不留任何痕迹', () => {
  /**
   * 锁定挡住的是删除本身。这里要钉的是**副作用**：
   * 抛错发生在写墓碑之前，所以不能留下"会话还在、墓碑却说它没了"的矛盾状态 ——
   * 那种状态一同步出去，别的设备会把一条好数据删掉。
   */
  it('锁定会话删除失败：没有墓碑、没有回收站条目、会话还在', async () => {
    await seedGroup('l1', 2, { locked: true });
    await expect(deleteGroup({ storage }, { groupId: 'l1' })).rejects.toBeInstanceOf(GroupLockedError);

    expect(await tombstonesOf()).toHaveLength(0);
    expect(await storage.listTrash()).toHaveLength(0);
    expect(await storage.getGroup('l1')).toBeDefined();
  });

  it('解锁之后同一次删除就成功了（证明上一条不是"删除根本没被尝试"）', async () => {
    await seedGroup('l2', 2, { locked: true });
    await toggleLock({ storage }, { groupId: 'l2' });
    await deleteGroup({ storage }, { groupId: 'l2' });
    expect(await storage.listTrash()).toHaveLength(1);
  });

  it('删一个不存在的会话是无声成功，不写墓碑', async () => {
    await softDeleteGroup({ storage }, { groupId: 'ghost', reason: 'user-delete', at: AT });
    expect(await tombstonesOf()).toHaveLength(0);
    expect(await storage.listTrash()).toHaveLength(0);
  });

  /**
   * 写入顺序本身是契约：**先墓碑、后删主存储**。
   * 反过来做的话，中途崩溃会留下"会话没了、但没有任何地方记得它被删过"，
   * 那在同步里会被别的设备解释成"这台机器数据丢了"。
   */
  it('removeGroup 抛错时墓碑已经落盘：证明写序是先墓碑后删存储', async () => {
    await seedGroup('o1', 2);
    const boom = createStoragePort();
    boom.removeGroup = () => Promise.reject(new Error('模拟落盘失败'));

    await expect(
      softDeleteGroup({ storage: boom }, { groupId: 'o1', reason: 'user-delete', at: AT }),
    ).rejects.toThrow('模拟落盘失败');

    expect((await boom.listTombstones()).map((tomb) => tomb.entityId)).toEqual(['o1']);
    // 会话还在 —— 所以这一状态在同步里会被当作"仍然存在的组"，墓碑只是先记了一笔
    expect(await boom.getGroup('o1')).toBeDefined();
  });
});

describe('墓碑与回收站的排序、压缩与设备身份', () => {
  it('墓碑按 deletedAt 升序；同一实体的多条压缩成最后一条', async () => {
    const list: Tombstone[] = [
      { id: 't3', entityType: 'group', entityId: 'a', deletedAt: 300, deletedByDeviceId: 'd', reason: 'consumed' },
      { id: 't1', entityType: 'group', entityId: 'a', deletedAt: 100, deletedByDeviceId: 'd', reason: 'user-delete' },
      { id: 't2', entityType: 'category', entityId: 'a', deletedAt: 200, deletedByDeviceId: 'd', reason: 'user-delete' },
    ];
    const compacted = compactTombstones(list);
    // entityType 也参与身份：删组与删分类即使撞了同一个 entityId 也不是同一件事
    expect(compacted.map((tomb) => tomb.id)).toEqual(['t2', 't3']);
  });

  it('压缩后顺序仍然是升序（合并要按时间比）', async () => {
    const list: Tombstone[] = [
      { id: 'x', entityType: 'group', entityId: 'b', deletedAt: 900, deletedByDeviceId: 'd', reason: 'undone' },
      { id: 'y', entityType: 'group', entityId: 'a', deletedAt: 100, deletedByDeviceId: 'd', reason: 'undone' },
    ];
    expect(compactTombstones(list).map((tomb) => tomb.deletedAt)).toEqual([100, 900]);
  });

  it('设备身份跨 port 实例稳定：三个 surface 不是三台设备', async () => {
    const first = await storage.getDeviceId();
    const second = await createStoragePort().getDeviceId();
    const third = await createStoragePort().getDeviceId();
    expect(first).toBe(second);
    expect(first).toBe(third);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  it('设备身份不参与快照载荷与备份（它是署名，不是数据）', async () => {
    await seedGroup('d1', 1);
    await softDeleteGroup({ storage }, { groupId: 'd1', reason: 'user-delete', at: AT });
    const snapshot = await storage.snapshotAll();
    expect(snapshot).not.toHaveProperty('device');
    expect(snapshot).not.toHaveProperty('tombstones');
  });
});

/**
 * 记录级的回收站。
 *
 * 三条最容易写错的地方各钉一条：
 * 1. 同一组的多条记录必须**并在同一行**里 —— 各开一行会让"还原其中一行"把另一行的记录
 *    也带回同一个 group id，等于凭空多出一条重复记录。
 * 2. 组还活着时"整行还原"是**并回去**，不是拿快照覆盖 —— 覆盖会把用户后来改的标题、
 *    换的分类、拖过的顺序整组抹掉。
 * 3. 记录级的还原/彻底删除对**墓碑**的处理不一样：还原=那次删除没发生（要撤墓碑），
 *    彻底删除=删除是真的（墓碑留着）。搞混的后果跨设备。
 */
describe('单条恢复进回收站，以及记录级的还原与彻底删除', () => {
  function tabsPort() {
    return createFakeBrowserTabsPort({ windows: [{ id: 2, tabs: [] }] });
  }

  it('单条恢复：那条记录进回收站，会话本身留在列表里', async () => {
    await seedGroup('s1', 3);
    const group = await storage.getGroup('s1');
    const first = group?.tabs[0];
    if (!first) throw new Error('setup');

    const result = await restoreTab({ tabs: tabsPort(), storage }, { groupId: 's1', tabId: first.id, windowId: 2 });
    expect(result.ok).toBe(true);

    const live = await storage.getGroup('s1');
    expect(live?.tabs.map((tab) => tab.id)).not.toContain(first.id);
    expect(live?.tabs).toHaveLength(2);

    const trash = await storage.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]?.group.tabs.map((tab) => tab.id)).toEqual([first.id]);
    expect(recordReason(trash[0]!, first.id)).toBe('consumed');
    // 单条恢复不是一次"整组删除"，所以**不该**有组墓碑：
    // 留了的话另一台设备会把整个会话删掉，而它这里明明还剩两条记录。
    expect(await storage.listTombstones()).toHaveLength(0);
  });

  it('同一组恢复两条 ⇒ 回收站里是一行的两条记录，不是两行', async () => {
    await seedGroup('s2', 3);
    const ids = (await storage.getGroup('s2'))?.tabs.map((tab) => tab.id) ?? [];
    if (ids.length < 2) throw new Error('setup');

    await restoreTab({ tabs: tabsPort(), storage }, { groupId: 's2', tabId: ids[0]!, windowId: 2 });
    await restoreTab({ tabs: tabsPort(), storage }, { groupId: 's2', tabId: ids[1]!, windowId: 2 });

    const trash = await storage.listTrash();
    expect(trash).toHaveLength(1);
    expect(trash[0]?.group.tabs).toHaveLength(2);
    expect((await storage.getGroup('s2'))?.tabs).toHaveLength(1);
  });

  it('先恢复一条、再把整组删掉 ⇒ 并成一行，来历各自留着', async () => {
    await seedGroup('s3', 3);
    const ids = (await storage.getGroup('s3'))?.tabs.map((tab) => tab.id) ?? [];
    await restoreTab({ tabs: tabsPort(), storage }, { groupId: 's3', tabId: ids[0]!, windowId: 2 });
    await softDeleteGroup({ storage }, { groupId: 's3', reason: 'user-delete', at: AT + 5_000 });

    const trash = await storage.listTrash();
    expect(trash).toHaveLength(1);
    const entry = trash[0];
    expect(entry?.group.tabs).toHaveLength(3);
    // 行的主标记取"最像用户删除的那个"，但每条记录自己的来历不能被抹平
    expect(entry?.reason).toBe('user-delete');
    expect(entry ? recordReason(entry, ids[0]!) : undefined).toBe('consumed');
    expect(entry ? recordReason(entry, ids[1]!) : undefined).toBe('user-delete');
  });

  /** 这条钉的是"并回去而不是覆盖"：覆盖会顺手抹掉用户在恢复之后改的东西。 */
  it('组还活着时整行还原：把记录并进现有会话，并保住用户后来改的标题', async () => {
    await seedGroup('s4', 3);
    const ids = (await storage.getGroup('s4'))?.tabs.map((tab) => tab.id) ?? [];
    await restoreTab({ tabs: tabsPort(), storage }, { groupId: 's4', tabId: ids[0]!, windowId: 2 });
    // 用户在剩下的会话上改了标题
    const live = await storage.getGroup('s4');
    if (!live) throw new Error('setup');
    await storage.putGroup({ ...live, title: '我改过的标题' });

    await restoreFromTrash({ storage }, { groupId: 's4', at: AT + 60_000 });

    const back = await storage.getGroup('s4');
    expect(back?.title).toBe('我改过的标题');
    expect(back?.tabs).toHaveLength(3);
    expect(await storage.listTrash()).toHaveLength(0);
  });

  it('新记录并进来时不会被旧记录的到期时间拖过期（取较晚的那个）', async () => {
    await seedGroup('s5', 3);
    const ids = (await storage.getGroup('s5'))?.tabs.map((tab) => tab.id) ?? [];
    // 旧的那条：8 天前就进来了，本来明天才过期
    await restoreTab({ tabs: tabsPort(), storage }, { groupId: 's5', tabId: ids[0]!, windowId: 2 });
    const before = (await storage.listTrash())[0];
    // 现在再来一条（时间上是"刚刚"）
    await storage.putGroup({ ...(await storage.getGroup('s5'))!, tabs: (await storage.getGroup('s5'))!.tabs });
    await softDeleteGroup({ storage }, { groupId: 's5', reason: 'user-delete', at: before!.deletedAt + 8 * 86_400_000 });

    const merged = (await storage.listTrash())[0];
    expect(merged?.expiresAt).toBe(before!.deletedAt + 8 * 86_400_000 + TRASH_RETENTION_MS);
  });

  it('还原一条记录会撤销整组墓碑（本地又有这个会话了）', async () => {
    await seedGroup('s6', 2);
    await softDeleteGroup({ storage }, { groupId: 's6', reason: 'user-delete', at: AT });
    expect(await storage.listTombstones()).toHaveLength(1);
    const first = (await storage.listTrash())[0]?.group.tabs[0];
    if (!first) throw new Error('setup');

    await restoreTrashTab({ storage }, { groupId: 's6', tabId: first.id, at: AT + 1_000 });

    expect(await storage.listTombstones()).toHaveLength(0);
    expect((await storage.getGroup('s6'))?.tabs.map((tab) => tab.id)).toEqual([first.id]);
    // 剩下的那条继续躺在回收站，等它自己的 7 天
    expect((await storage.listTrash())[0]?.group.tabs).toHaveLength(1);
  });

  /** 彻底删除是"这次删除是真的"，墓碑必须留着 —— 撤了的话另一台设备会把它再变回来。 */
  it('彻底删除一条记录不动墓碑', async () => {
    await seedGroup('s7', 2);
    await softDeleteGroup({ storage }, { groupId: 's7', reason: 'user-delete', at: AT });
    const first = (await storage.listTrash())[0]?.group.tabs[0];
    if (!first) throw new Error('setup');

    await purgeTrashTab({ storage }, { groupId: 's7', tabId: first.id, at: AT });

    expect((await storage.listTombstones()).map((tomb) => tomb.entityId)).toEqual(['s7']);
    expect((await storage.listTrash())[0]?.group.tabs).toHaveLength(1);
    expect(await storage.getGroup('s7')).toBeUndefined();
  });

  it('锁定的会话单条恢复既不删记录也不进回收站（锁的语义是"这批我还要留着"）', async () => {
    await seedGroup('s8', 2, { locked: true });
    const first = (await storage.getGroup('s8'))?.tabs[0];
    if (!first) throw new Error('setup');

    await restoreTab({ tabs: tabsPort(), storage }, { groupId: 's8', tabId: first.id, windowId: 2 });

    expect((await storage.getGroup('s8'))?.tabs).toHaveLength(2);
    expect(await storage.listTrash()).toHaveLength(0);
  });
});

/**
 * 用户在会话里 × 掉一条记录也进回收站（既有约定，用户 2026-10-05 的指令
 * 「标签组里的标签删除也要进回收站」）。
 *
 * 这一组里最要紧的是**失败那一侧**：删除没成功时回收站必须一行都不写，否则留下的是一条
 * "同时活在会话里和回收站里"的记录 —— 还原它会往会话里塞一个重复项，
 * 那正是 既有约定 花力气避免的形状。所以这里既断"成功了要进去"，也断"失败了不许进去"。
 * ⚠ 诚实说一句：命令里"先摘除、再入站"那个**顺序本身测不出红** ——
 * 前置检查（锁、记录在不在）先挡住了两种失败，而 `deleteTab` 内部还会再查一次锁。
 * 顺序是第二层防御，别把上面那两条当成它已经被覆盖了。
 */
describe('会话里删单条记录也进回收站', () => {
  it('记录离开会话、进回收站；会话仍在列表里；不产生组墓碑', async () => {
    await seedGroup('rt1', 3);
    const victim = (await storage.getGroup('rt1'))?.tabs[1];
    if (!victim) throw new Error('setup');

    await removeTabToTrash({ storage }, { groupId: 'rt1', tabId: victim.id });

    const left = (await storage.getGroup('rt1'))?.tabs.map((tab) => tab.id) ?? [];
    expect(left).toHaveLength(2);
    expect(left).not.toContain(victim.id);
    expect((await storage.listGroupIndex()).map((entry) => entry.id)).toEqual(['rt1']);

    const rows = await storage.listTrash();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group.id).toBe('rt1');
    expect(rows[0]?.group.tabs.map((tab) => tab.id)).toEqual([victim.id]);
    expect(rows[0]?.reason).toBe('user-delete');
    // 会话还在列表里 ⇒ 留组墓碑等于让另一台设备把整个会话删掉（既有约定 定的那条，这一路沿用）
    expect(await storage.listTombstones()).toHaveLength(0);
  });

  /** 同一个会话连着删三条只在回收站占**一行** —— 各开一行会共用同一个 group.id，还原时会带回重复记录。 */
  it('连着 × 掉两条 ⇒ 回收站只占一行，两条记录并在一起、先来者在前', async () => {
    await seedGroup('rt2', 3);
    const [first, second] = (await storage.getGroup('rt2'))?.tabs ?? [];
    if (!first || !second) throw new Error('setup');

    await removeTabToTrash({ storage }, { groupId: 'rt2', tabId: first.id });
    await removeTabToTrash({ storage }, { groupId: 'rt2', tabId: second.id });

    const rows = await storage.listTrash();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group.tabs.map((tab) => tab.id)).toEqual([first.id, second.id]);
  });

  /** 删除失败的那一条路径**不许**在回收站留东西：这是"先摘除、再入站"这个顺序的全部理由。 */
  it('锁定的会话抛 GroupLockedError，回收站一条都不写', async () => {
    await seedGroup('rt3', 2, { locked: true });
    const victim = (await storage.getGroup('rt3'))?.tabs[0];
    if (!victim) throw new Error('setup');

    await expect(removeTabToTrash({ storage }, { groupId: 'rt3', tabId: victim.id })).rejects.toBeInstanceOf(
      GroupLockedError,
    );

    expect(await storage.listTrash()).toHaveLength(0);
    expect((await storage.getGroup('rt3'))?.tabs).toHaveLength(2);
  });

  /** 找不到那条记录时（另一头已经删过 / 同步刚覆盖过）也不能留半个条目。 */
  it('记录不存在 ⇒ 抛错且不写回收站', async () => {
    await seedGroup('rt4', 1);
    await expect(removeTabToTrash({ storage }, { groupId: 'rt4', tabId: 'nope' })).rejects.toThrow();
    expect(await storage.listTrash()).toHaveLength(0);
    expect((await storage.getGroup('rt4'))?.tabs).toHaveLength(1);
  });

  /** 捞回来是这条路径存在的理由：并回原会话，且**不开出重复记录**。 */
  it('从回收站把这条还原回原会话：并回去、不产生重复', async () => {
    await seedGroup('rt5', 3);
    const victim = (await storage.getGroup('rt5'))?.tabs[0];
    if (!victim) throw new Error('setup');
    await removeTabToTrash({ storage }, { groupId: 'rt5', tabId: victim.id });
    expect((await storage.getGroup('rt5'))?.tabs).toHaveLength(2);

    await restoreTrashTab({ storage }, { groupId: 'rt5', tabId: victim.id, at: AT + 1_000 });

    const back = await storage.getGroup('rt5');
    expect(back?.tabs).toHaveLength(3);
    expect(back?.tabs.map((tab) => tab.id).filter((id) => id === victim.id)).toHaveLength(1);
    /**
     * 既有约定 改判了这里原来那句 `listTrash()).toHaveLength(0)`。
     *
     * 行**不能整个消失** —— 它是凭证的载体：还原到空时如果连行一起删掉，
     * "这一条我已经还原过了"就没人记得，远端那一版（常常是本机自己上一轮推的）
     * 下一轮会把它并回回收站，用户看到的是同一条**既在会话里又躺在回收站**。
     * 所以留一条零可见记录的壳行；界面上看不见它（`TrashPanel` 按可见记录滤），
     * 它到 `expiresAt` 自然消失 —— 那也就是凭证的 GC。
     */
    const shells = await storage.listTrash();
    expect(shells).toHaveLength(1);
    expect(shells[0]?.group.tabs).toHaveLength(0);
    expect(shells[0]?.records?.[victim.id]?.barrier?.action).toBe('restore');
  });

  /** 记录级的"× 掉一条"跟着 既有约定 走：它进的那一行会跨设备走，但"拿走"这件事本身不传播。 */
  it('删出来的那一行进载荷（跨设备能捞回来）', async () => {
    await seedGroup('rt6', 2);
    const victim = (await storage.getGroup('rt6'))?.tabs[0];
    if (!victim) throw new Error('setup');
    await removeTabToTrash({ storage }, { groupId: 'rt6', tabId: victim.id });

    const state = await readStoredState({ storage });
    expect(state.trash?.map((entry) => entry.group.id)).toEqual(['rt6']);
    expect(state.trash?.[0]?.group.tabs.map((tab) => tab.id)).toEqual([victim.id]);
  });
});

/**
 * 不可恢复的记录不进回收站。
 *
 * 用户指着两行「无法直接恢复」（`about:blank` 与 `chrome-extension://…/options`）说：
 * "这样的不要回收"。理由不是嫌难看 —— 回收站唯一的意义是"还原"，
 * 而这两条还原不了：躺在那儿是在**承诺一个做不到的救回**，7 天后消失时还顺手骗他一次
 * ("我是不是错过了一次能救回来的机会")。
 *
 * ⚠ 四条用例都同时钉住另一半：**删除照常传播**。过滤只能影响回收站那一份，
 * 不能变成"这条没什么用，那也就不算删过"。
 */
describe('不可恢复的记录不回收', () => {
  /** 一条可恢复 + 一条不可恢复（about:blank 走的是 `restorable:false` 那条既有判据）。 */
  async function seedMixedGroup(): Promise<void> {
    await storage.putGroup(
      groupFixture(
        '会话 混合',
        [
          savedTabFixture('mix', 'mix-t0', 0),
          { ...savedTabFixture('mix', 'mix-t1', 1), url: 'about:blank', restorable: false },
        ],
        { id: 'mix' },
      ),
    );
  }

  it('混合组整组软删 ⇒ 那一行只收可恢复的那条，墓碑照写、会话照删', async () => {
    await seedMixedGroup();
    await softDeleteGroup({ storage }, { groupId: 'mix', reason: 'user-delete', at: AT });

    const rows = await storage.listTrash();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group.tabs.map((tab) => tab.id)).toEqual(['mix-t0']);
    expect(await storage.getGroup('mix')).toBeUndefined();
    const groupTombstones = (await storage.listTombstones()).filter((item) => item.entityType === 'group');
    expect(groupTombstones.map((item) => item.entityId)).toEqual(['mix']);
  });

  it('整组都不可恢复 ⇒ 一行都不留，但删除仍然算发生过', async () => {
    await storage.putGroup(
      groupFixture(
        '会话 全内部页',
        [
          { ...savedTabFixture('all-internal', 'ai-t0', 0), url: 'about:blank', restorable: false },
          {
            ...savedTabFixture('all-internal', 'ai-t1', 1),
            url: 'chrome-extension://abc/options.html',
            restorable: false,
          },
        ],
        { id: 'all-internal' },
      ),
    );

    await softDeleteGroup({ storage }, { groupId: 'all-internal', reason: 'user-delete', at: AT });

    expect(await storage.listTrash()).toHaveLength(0);
    expect(await storage.getGroup('all-internal'), '会话没删掉 ⇒ 过滤变成了"什么都不做"').toBeUndefined();
    expect((await storage.listTombstones()).map((item) => item.entityId)).toEqual(['all-internal']);
  });

  it('会话里 × 掉一条不可恢复的记录 ⇒ 直接从会话消失，不留回收站行', async () => {
    await seedMixedGroup();
    await removeTabToTrash({ storage }, { groupId: 'mix', tabId: 'mix-t1' });

    expect((await storage.getGroup('mix'))?.tabs.map((tab) => tab.id)).toEqual(['mix-t0']);
    expect(await storage.listTrash(), '回收站里躺了一条开不出来的记录').toHaveLength(0);
  });

  it('单条恢复被消费的那一条若不可恢复，同样不进回收站', async () => {
    await storage.putGroup(
      groupFixture(
        '会话 消费',
        [
          savedTabFixture('cons', 'cons-t0', 0),
          { ...savedTabFixture('cons', 'cons-t1', 1), url: 'about:blank', restorable: false },
        ],
        { id: 'cons' },
      ),
    );
    // 直接走入站函数（单条恢复的下游就是它），避开真 tab 层
    const group = (await storage.getGroup('cons'))!;
    await mergeIntoTrash({ storage }, { group, tabs: [group.tabs[1]!], reason: 'consumed', at: AT });

    expect(await storage.listTrash()).toHaveLength(0);
    await mergeIntoTrash({ storage }, { group, tabs: [group.tabs[0]!], reason: 'consumed', at: AT });
    expect((await storage.listTrash())[0]?.group.tabs.map((tab) => tab.id)).toEqual(['cons-t0']);
  });

  /**
   * ★ 这两条是**变异探针逼出来的**：把 `isRecoverableRecord` 改成只看 URL（丢掉
   * `restorable === true` 那一半），上面四条连同全仓 793 条**全绿** ——
   * 因为既有用例里的不可恢复记录都是 `about:blank` + `restorable:false`，**两半一起为假**，
   * 判据的另一半从来没被单独钉过。
   *
   * 真数据里这两半不会打架（收纳与导入都把 `restorable` 算成 `isRestorableUrl(url)` 的同源值），
   * 但手写/旧版备份会；而 既有约定 把 `undoCapture` 那处原本"只看 URL、不看布尔"的过滤
   * 也并进了同一个函数 —— 并进去的那一半没有用例，等于把三处旧行为绑在一个没被单独钉过的
   * 布尔上。所以这里各钉一条：布尔为假就为假，不管 URL 长什么样。
   */
  it('布尔与 URL 打架时按布尔判：URL 能开出来但 `restorable:false` ⇒ 照样不回收', async () => {
    await storage.putGroup(
      groupFixture(
        '会话 备份里布尔为假',
        [
          { ...savedTabFixture('odd', 'odd-t0', 0), restorable: false },
          savedTabFixture('odd', 'odd-t1', 1),
        ],
        { id: 'odd' },
      ),
    );

    await softDeleteGroup({ storage }, { groupId: 'odd', reason: 'user-delete', at: AT });

    const rows = await storage.listTrash();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group.tabs.map((tab) => tab.id), '回收站里躺了一条标着不可恢复的记录').toEqual(['odd-t1']);
  });

  it('撤销收纳用的是同一个判据：布尔为假的那条不重开（`undoCapture` 也并进来了）', async () => {
    await storage.putGroup(
      groupFixture(
        '会话 撤销混合',
        [
          savedTabFixture('un', 'un-t0', 0),
          { ...savedTabFixture('un', 'un-t1', 1), restorable: false },
        ],
        { id: 'un' },
      ),
    );
    const tabs = createFakeBrowserTabsPort({ windows: [{ id: 2, tabs: [] }] });

    const result = await undoCapture({ tabs, storage }, { groupId: 'un', windowId: 2 });

    expect(result.restored).toBe(1);
    expect(result.skipped).toBe(1);
    expect((tabs.dump()[2] ?? []).map((tab) => tab.url)).toEqual([
      'https://example0.com/path/un/un-t0?q=query-value',
    ]);
  });
});
