// 同步引擎在真机上跑在 **background service worker**，那儿没有 DOM。
// 这个文件切到 node 环境，就是把这条事实钉进测试套：将来谁在引擎或其依赖里用了
// document / DOMParser / URL.createObjectURL 之类的东西，这里会直接红，而不是等用户
// 在 Edge 里点"立即同步"才发现。propfind 那个 bug 正是这么漏掉的——
// 因为 jsdom 提供 DOMParser，而 service worker 不提供，假环境比生产宽容。
// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import type { StoragePort } from '@/core/ports/storage';
import { createFakeWebDav, FAKE_CREDENTIAL } from '@/infrastructure/testing/fake-webdav';
import type { FakeWebDavPort } from '@/infrastructure/testing/fake-webdav';
import {
  acknowledgeSuspiciousChange,
  backoffDelayMs,
  inspectLocalState,
  markDirty,
  requestSync,
  fetchManifest,
  resolveConflict,
  runSync,
  pickRolledOff,
  pruneRolledOff,
  SYNC_LOCK_TTL_MS,
} from '@/core/application/sync-engine';
import { dueForSync, SYNC_DEBOUNCE_MS } from '@/core/domain/sync-wake';
import type { SyncDeps } from '@/core/application/sync-engine';
import { groupFixture, remoteManifest, remoteSnapshot, savedTabFixture } from './fixtures';
import {
  mergeIntoTrash,
  purgeFromTrash,
  purgeTrashTab,
  recordReason,
  restoreFromTrash,
  restoreTrashTab,
  softDeleteGroup,
} from '@/core/application/delete-model';
import { manifestUrl, manifestsDirUrl, parseBaseUrl, pointerUrl, remoteRootUrl, snapshotUrl, snapshotsDirUrl, POINTER_FILE, TRUSTED_LISTING_LIMIT } from '@/core/domain/remote-layout';
import type { DevicePointer, ManifestEntry, StoredState, TrashEntry } from '@/shared/types';
import { TRASH_RETENTION_MS } from '@/shared/constants';
import { WIRE_ENCODING, stateChecksumOf } from '@/core/domain/sync-data';
import { readStoredState } from '@/core/application/durable-snapshot';
import { mergeDeviceTables } from '@/core/domain/device-profile';

const AT = 1_700_000_000_000;
const BASE = 'https://host/dav';

/**
 * "另一台设备写过的文件"要放在哪，一律**从拼接函数取**，不在测试里手写 `<base>/ShiTab/...`。
 * 手写的那份在布局改成 `<base>/ShiXiongZhiDao/ShiTab/` 之后立刻指到别处：
 * 引擎读的是新位置，假件里的"对方数据"留在旧位置，于是 7 条用例一起红
 * （`expected 'idle' to be 'conflict'` 这种奇怪现象 —— 红得算幸运，
 *  要是断言方向反过来就会静默全绿）。布局只许有一份，测试要用就调它。
 */
const REMOTE_BASE = parseBaseUrl(BASE);
if (!REMOTE_BASE.ok) throw new Error('setup：BASE 应当是合法地址');
/** 另一台设备的那一份快照落在哪。 */
const otherSnapshotUrl = (snapshotId: string): string => snapshotUrl(REMOTE_BASE.url, snapshotId).href;
/** 另一台设备写的那一版 manifest 落在哪。 */
const otherManifestUrl = (revision: number): string => manifestUrl(REMOTE_BASE.url, revision).href;

/**
 * ★ 摆上"另一台设备推了一版"的**第三笔写**：指针。
 *
 * 只摆快照 + manifest 在过去就等于"对面推了一版"，加了指针之后**不再等于** ——
 * 因为真设备推送的顺序是 快照 → revision manifest → 指针，指针才是"最新是哪一版"的答案。
 * 少了这一笔，本机第一步读指针会读到自己那一版，摆在后面的 revision 2 就**隐形**了，
 * 症状是 `outcome.pulled` 直接是 undefined（合并分支根本没进），看起来像引擎坏了，
 * 而实际上是夹具不再表达它想表达的场景。
 *
 * `updatedAt` 不参与任何判据（`verifyPointer` 只要求它是个有限数），所以这里给常量。
 */
const plantOtherPointer = (otherId: string): void => {
  remote.files.set(
    pointerUrl(REMOTE_BASE.url).href,
    JSON.stringify({ format: 'shitab-pointer', version: 1, revision: 2, snapshotId: otherId, updatedAt: AT }),
  );
};

let storage: StoragePort;
let remote: FakeWebDavPort;

function deps(): SyncDeps {
  return { storage, webdav: remote };
}

async function configure(overrides: Partial<Parameters<StoragePort['setWebDavConfig']>[0]> = {}) {
  await storage.setWebDavConfig({
    enabled: true,
    baseUrl: BASE,
    username: FAKE_CREDENTIAL.username,
    allowInsecureHttp: false,
    ...overrides,
  });
  await storage.setSyncCredential(FAKE_CREDENTIAL.password);
}

async function seedSessions(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = `s${index}`;
    await storage.putGroup(
      groupFixture(`会话 ${id}`, [savedTabFixture(id, `${id}-t0`, 0)], { id, sortOrder: index, updatedAt: AT }),
    );
  }
}

const snapshotFiles = (): string[] => [...remote.files.keys()].filter((url) => url.includes('/snapshots/'));
/**
 * 不可变的那一串 revision manifest，**不含指针文件**。
 *
 * 原来这里写的是 `includes('/manifests/')`，指针文件一出现就把每一处"远端攒了几版历史"
 * 的计数全顶歪。分成两个函数而不是把计数各加 1：这些用例问的从来都是
 * "历史里多了几版"，指针是另一件事，它该有自己的断言（`pointerFiles`）。
 */
const manifestFiles = (): string[] => [...remote.files.keys()].filter((url) => url.includes('/manifests/revision-'));
/** 指针文件（每轮推送都会覆盖它，是这套布局里唯一可变的一份）。 */
const pointerFiles = (): string[] => [...remote.files.keys()].filter((url) => url.includes(`/manifests/${POINTER_FILE}`));

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  storage = createStoragePort();
  await storage.heal();
  remote = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
});

it('环境自查：这里没有 DOM，和 service worker 一样', () => {
  // 上面那句 `@vitest-environment node` 被人删掉时，本文件不会有任何别的症状 ——
  // 它照样全绿，只是失去了"引擎不许用 DOM"这道闸。所以把环境本身断言出来。
  expect('document' in globalThis).toBe(false);
  expect('DOMParser' in globalThis).toBe(false);
});

describe('同步引擎：停下来比推上去重要', () => {
  it('没开同步 ⇒ disabled，一个请求都不发', async () => {
    await storage.setWebDavConfig({ enabled: false, baseUrl: BASE, username: 'u', allowInsecureHttp: false });
    const outcome = await runSync(deps(), AT);
    expect(outcome.status).toBe('disabled');
    expect(remote.calls).toEqual([]);
  });

  it('没存密码 ⇒ no-credential，也不发请求（配置在，凭据不在，是两件事）', async () => {
    await storage.setWebDavConfig({ enabled: true, baseUrl: BASE, username: 'u', allowInsecureHttp: false });
    const outcome = await runSync(deps(), AT);
    expect(outcome.skip).toBe('no-credential');
    expect(remote.calls).toEqual([]);
  });

  it('地址填坏了 ⇒ bad-base-url，不去连一个不存在的服务器', async () => {
    await configure();
    await storage.setWebDavConfig({ enabled: true, baseUrl: 'not a url', username: 'u', allowInsecureHttp: false });
    const outcome = await runSync(deps(), AT);
    expect(outcome.skip).toBe('bad-base-url');
    expect(outcome.error?.message).toContain('WebDAV 地址无效');
    expect(remote.calls).toEqual([]);
  });

  /**
   * §9 规则 C/D。这里直接喂畸形状态给判据本身：
   * 想靠"把存储写坏"来触发，得先骗过 heal()，那测到的是 heal 而不是这道闸。
   */
  it('inspectLocalState 拦下四种解析不了的形状', () => {
    const ok: StoredState = { groups: [], categories: [], tombstones: [] };
    expect(inspectLocalState(ok).ok).toBe(true);

    expect(inspectLocalState({ ...ok, groups: undefined as never }).ok).toBe(false);
    const noTabs = { ...ok, groups: [{ id: 'g1', title: 'x' }] } as never;
    expect(inspectLocalState(noTabs)).toEqual({ ok: false, reason: 'group:g1.tabs-not-array' });
    const noId = { ...ok, groups: [{ id: '', tabs: [] }] } as never;
    expect(inspectLocalState(noId).ok).toBe(false);
    const badTab = { ...ok, groups: [{ id: 'g1', tabs: [{ url: 42 }] }] } as never;
    expect(inspectLocalState(badTab)).toEqual({ ok: false, reason: 'group:g1.tab-url-missing' });
  });

  /**
   * 整套设计立项的那一句话（§8）：本地被清空不能把云端也清空。
   *
   * ★ 2026-10-06 这条被**拆成两条**，因为原写法把两件不同的事混在一个期望里：
   * 它用 `storage.removeGroup()` 直接删（不写墓碑），于是"本机少 25 条"既不是用户意图、
   * 也不会真的危害云端 —— 并集合并会把云端那 25 条原样拉回本机，`outgoing` 与云端内容相同，
   * 引擎连快照都不写。这种情形报"可疑"是**误报**，而且它当时正是 Edge 拿不到数据的根因
   * （闸在合并之前，一停就连拉都不拉）。
   * 所以：真塌陷 = 带墓碑的大规模删除（下面第二条），它仍然必须停。
   */
  it('本机被清空但**没有墓碑**（存储坏了那一类）⇒ 把云端拉回本机，远端一个字节都不多', async () => {
    await configure();
    await seedSessions(25);
    const first = await runSync(deps(), AT);
    expect(first.status).toBe('idle');
    const pushedCount = snapshotFiles().length;
    expect(pushedCount).toBe(1);

    for (const id of Array.from({ length: 25 }, (_, index) => `s${index}`)) {
      await storage.removeGroup(id);
    }

    const second = await runSync(deps(), AT + 1000);
    expect(second.status, '没有删除意图的"本机少"不是塌陷，不该拦').toBe('idle');
    expect((await storage.listGroupIndex()).length, '云端那 25 条要回到本机').toBe(25);

    // ★ 标题说的"远端一个字节都不多"现在是**真**的。
    //   这一条原来断言的是 `pushedCount + 1`，注释把那一版归给
    //   "`trash` 键缺失 vs 空数组在 canonicalJson 下是两个 checksum"，
    //   实际来路是**数组顺序**：合并结果里会话的先后与读回来的存储先后不同，
    //   内容寻址就认不出"这是同一份内容"，于是每次拉取都往不可变历史里多落一版。
    //   顺序判据收敛成一份（`core/domain/state-order.ts`）之后，这一版不再产生 ——
    //   同一条根因在两台设备上放大成"9 分钟互推 10 个版本"。
    const files = snapshotFiles();
    expect(files, '拉回来的那一版与云端内容相同 ⇒ 不该再多写一份不可变快照').toHaveLength(pushedCount);
    const newest = await remoteSnapshot(remote.files, files[files.length - 1] as string);
    expect(newest.state.groups, '云端那 25 条一条都不能少').toHaveLength(25);
  });

  /** 真塌陷：用户（或一次误操作）带着墓碑删掉了 25 条 —— 这一版推上去云端就空了，必须停。 */
  it('本机带墓碑删掉 25 条 ⇒ suspicious_change，且远端没有被写任何东西', async () => {
    await configure();
    await seedSessions(25);
    await runSync(deps(), AT);
    const pushedCount = snapshotFiles().length;

    for (const id of Array.from({ length: 25 }, (_, index) => `s${index}`)) {
      await softDeleteGroup({ storage }, { groupId: id, reason: 'user-delete', at: AT + 900 });
    }

    const second = await runSync(deps(), AT + 1000);
    expect(second.status).toBe('suspicious_change');
    expect(second.suspicious?.rules.map((rule) => rule.rule)).toContain('A');
    // ★ 提示要把**两条轴**的数字交给用户（真机反馈：只说"少得多"没法判断是误报还是真删了）。
    //   比的是即将上传的那一版 vs 远端那一版，不是合并前的本机原始状态。
    expect(second.suspicious?.counts).toEqual({
      outgoing: { sessions: 0, records: 0 },
      remote: { sessions: 25, records: 25 },
    });
    expect(snapshotFiles()).toHaveLength(pushedCount);
    expect(await storage.listGroupIndex(), '本机的删除意图照常可用：这道闸只拦同步，不拦用户（§7.3）').toHaveLength(0);
  });

  /**
   * ★ 塌陷闸的**出口**（本轮补，既有约定）。
   *
   * `safety.ts` 那个判别联合的注释一直写着"挂起，等用户在 UI 上选恢复云端 / 保留本地 / 查看差异"，
   * 而这三个动作全仓一个都没有 —— `sync-engine.ts` 里那句「全仓搜 `skipSafety` / `confirmSuspicious`
   * 零命中」就是它自己的供状，`sync-scheduler.ts` 也明写「`suspicious_change` 没有对应的裁决 UI」。
   * 既有约定 把闸挪到合并之后只救回了**拉**的方向；推的方向仍然是死的：
   * 远端 25 组、本机带墓碑删光 ⇒ 规则 A 每轮都成立、永远推不出去，
   * 用户唯一的出路是撤回删除，或者清空远端历史（那正是这道闸要防的事）。
   *
   * 补的是三个里唯一真缺的那一个：「我核对过了，这一版照推」。
   * "恢复云端"＝已有的 SnapshotHistoryPanel 恢复某一版；"查看差异"＝回收站本来就能看。
   *
   * ⚠ 授权**按内容 checksum 认**，不是一个布尔开关：这道闸是整套设计立项的理由
   * （`safety.ts` 开头那三行），给它挂一个与内容无关的旁路等于把闸拆了。
   */
  it('用户确认过之后 ⇒ 那一版照推，远端真的收到了', async () => {
    await configure();
    await seedSessions(25);
    await runSync(deps(), AT);
    const pushedCount = snapshotFiles().length;

    for (const id of Array.from({ length: 25 }, (_, index) => `s${index}`)) {
      await softDeleteGroup({ storage }, { groupId: id, reason: 'user-delete', at: AT + 900 });
    }
    const stopped = await runSync(deps(), AT + 1000);
    expect(stopped.status).toBe('suspicious_change');
    expect(snapshotFiles(), '停下来时远端一个字节都不许多').toHaveLength(pushedCount);

    expect(await acknowledgeSuspiciousChange(deps()), '闸停下时账本里要有可确认的那一版').toBe(true);

    const pushed = await runSync(deps(), AT + 3000);
    expect(pushed.status, '确认过的那一版要真的推出去').toBe('idle');
    const files = snapshotFiles();
    expect(files).toHaveLength(pushedCount + 1);
    const newest = await remoteSnapshot(remote.files, files[files.length - 1] as string);
    expect(newest.state.groups, '用户确认的正是"云端也变成 0 组"这件事').toHaveLength(0);
  });

  it('确认是**一次性**的：推成功即失效，下一次塌陷照样停', async () => {
    await configure();
    await seedSessions(25);
    await runSync(deps(), AT);

    for (const id of Array.from({ length: 25 }, (_, index) => `s${index}`)) {
      await softDeleteGroup({ storage }, { groupId: id, reason: 'user-delete', at: AT + 900 });
    }
    expect((await runSync(deps(), AT + 1000)).status).toBe('suspicious_change');
    await acknowledgeSuspiciousChange(deps());
    expect((await runSync(deps(), AT + 3000)).status).toBe('idle');
    expect((await storage.getSyncMeta()).suspiciousAckChecksum, '授权用完即清，不许变成常驻开关').toBeUndefined();

    // 第二次塌陷换一批 id，避开第一次留下的墓碑
    for (let index = 0; index < 25; index += 1) {
      const id = `n${index}`;
      await storage.putGroup(
        groupFixture(`会话 ${id}`, [savedTabFixture(id, `${id}-t0`, 0)], { id, sortOrder: index, updatedAt: AT + 4000 }),
      );
    }
    expect((await runSync(deps(), AT + 5000)).status, '0 → 25 不是塌陷，要照常推上去').toBe('idle');

    for (let index = 0; index < 25; index += 1) {
      await softDeleteGroup({ storage }, { groupId: `n${index}`, reason: 'user-delete', at: AT + 6000 });
    }
    expect((await runSync(deps(), AT + 7000)).status, '上一次的授权不许顺延到这一次').toBe('suspicious_change');
  });

  /**
   * 这一条单独钉「读完即消费」那半边。
   *
   * 上面那条一次性用例证明不了它：授权同时也会被**推送成功**那一次 `setSyncMeta` 清掉，
   * 所以"用完就没了"这个观察有两个可能的来源。这里让推送在 manifest 那一步失败 ——
   * 成功路径的清理根本走不到，能清掉授权的只剩消费那一步。
   * （快照那一步已经成功了，远端因此多一个没有指针指向的孤儿快照，与本条断言无关。）
   */
  it('授权被读过一次就没了：那一次推送失败也不留给下一轮', async () => {
    await configure();
    await seedSessions(25);
    await runSync(deps(), AT);

    for (const id of Array.from({ length: 25 }, (_, index) => `s${index}`)) {
      await softDeleteGroup({ storage }, { groupId: id, reason: 'user-delete', at: AT + 900 });
    }
    expect((await runSync(deps(), AT + 1000)).status).toBe('suspicious_change');
    await acknowledgeSuspiciousChange(deps());
    expect((await storage.getSyncMeta()).suspiciousAckChecksum, '点击当时授权要在账本里').toBeDefined();

    remote.nextFault({ status: 503, method: 'PUT', url: otherManifestUrl(2) });
    const failed = await runSync(deps(), AT + 2000);
    expect(failed.status, '闸放行了，失败发生在后面的网络上').toBe('error');
    expect((await storage.getSyncMeta()).suspiciousAckChecksum, '读过就清，与这一轮成没成无关').toBeUndefined();
  });

  /**
   * 这一条是"按 checksum 认"与"布尔开关"的分水岭：布尔开关在这里会**放行一版用户从没看过数字的内容**。
   * 用户点了确认、但下一轮跑起来之前本地又动了一次 ⇒ 授权必须失效、闸必须重新报数。
   */
  it('确认只对用户看过的那一版有效：确认之后本地又变了 ⇒ 闸照拦', async () => {
    await configure();
    await seedSessions(25);
    await runSync(deps(), AT);
    const pushedCount = snapshotFiles().length;

    for (const id of Array.from({ length: 25 }, (_, index) => `s${index}`)) {
      await softDeleteGroup({ storage }, { groupId: id, reason: 'user-delete', at: AT + 900 });
    }
    expect((await runSync(deps(), AT + 1000)).status).toBe('suspicious_change');

    await storage.putGroup(
      groupFixture('会话 new', [savedTabFixture('new', 'new-t0', 0)], { id: 'new', sortOrder: 99, updatedAt: AT + 1500 }),
    );
    expect(await acknowledgeSuspiciousChange(deps())).toBe(true);

    const again = await runSync(deps(), AT + 3000);
    expect(again.status, '内容变了 ⇒ 那份授权对不上号').toBe('suspicious_change');
    expect(snapshotFiles(), '远端仍然一个字节都不许多').toHaveLength(pushedCount);
  });

  it('没有可确认的那一版 ⇒ acknowledge 返回 false，账本一个字段都不动', async () => {
    await configure();
    await seedSessions(3);
    await runSync(deps(), AT);
    const before = await storage.getSyncMeta();

    expect(await acknowledgeSuspiciousChange(deps())).toBe(false);
    expect(await storage.getSyncMeta()).toEqual(before);
  });

  /**
   * 塌陷闸的"别天天问"那一侧（既有约定 决定 3）。
   *
   * ⚠ 这一条原来用 `removeGroup` 删 5 条，那是**硬删、不留墓碑**：
   * 合并会把那 5 条从云端原样拉回来 ⇒ 本机与远端内容相同 ⇒ 根本没有东西可推。
   * 它当时能绿，靠的正是 既有约定 修掉的那个 bug（合并结果的数组顺序与读回来的不同，
   * 于是"内容相同"被判成"我有一版新的"，推上去一个内容与远端等价的 revision 2）。
   * 顺序收敛成一份之后那一次推送不再发生，于是这里改成**带墓碑**的删除：
   * 闸要被判的是"真会推出去的那一版"，不是"顺序碰巧不一样的一版"。
   */
  it('100→95 这种小改动不拦：天天问就等于没问', async () => {
    await configure();
    await seedSessions(100);
    await runSync(deps(), AT);
    for (const id of ['s0', 's1', 's2', 's3', 's4']) {
      await softDeleteGroup({ storage }, { groupId: id, reason: 'user-delete', at: AT + 900 });
    }
    const outcome = await runSync(deps(), AT + 1000);
    expect(outcome.status).toBe('idle');
    expect(outcome.pushed?.revision, '少了 5% 不该停下来问，但这一轮确实要推出去').toBe(2);
    expect(snapshotFiles(), '一次推送 = 一份不可变快照，不多写').toHaveLength(2);
  });

  /**
   * 内容寻址存在的理由（既有约定 决定 3）。这条钉的是那一次具体的故障：
   * 快照 PUT 成功、manifest PUT 崩了 ⇒ 下一轮**不许**再生成一个新文件名把同一份内容再存一遍。
   * 用随机 UUID 时这一条会红：不可变历史里会出现两份内容相同的快照，而 §18 永不删。
   */
  it('快照写成功但 manifest 写失败 ⇒ 下一轮复用同一个文件名，不重复存内容', async () => {
    await configure();
    await seedSessions(2);
    await runSync(deps(), AT); // revision 1，内容 A

    // 制造第二次改动，并让 manifest 那一步单独失败
    await storage.putGroup(
      groupFixture('会话 m', [savedTabFixture('m', 'm-t0', 0)], { id: 'm', sortOrder: 6, updatedAt: AT + 5000 }),
    );
    const manifestUrlAfter = otherManifestUrl(2);
    remote.nextFault({ status: 503, method: 'PUT', url: manifestUrlAfter });
    const failed = await runSync(deps(), AT + 5000);
    expect(failed.status).toBe('error');
    const afterFailedPush = snapshotFiles().length;
    expect(afterFailedPush).toBe(2); // A 与 B 各一份，B 的快照确实上去了

    // 重试要推到退避窗口之外：上一轮的 503 把 nextAttemptAt 设成了 at+5s，
    // 在 AT+9000 时会被判成 backoff，测的就不是去重而是退避了。
    const retried = await runSync(deps(), AT + 20_000);
    expect(retried.status).toBe('idle');
    expect(snapshotFiles()).toHaveLength(afterFailedPush);
    expect(manifestFiles()).toHaveLength(2);
  });
});

describe('同步引擎：推与去重', () => {
  it('全新服务器第一次同步就成功（目录还不存在时 propfind 回 404 是"空库"，不是故障）', async () => {
    await configure();
    await seedSessions(2);
    const outcome = await runSync(deps(), AT);
    expect(outcome.status).toBe('idle');
    expect(outcome.pushed?.revision).toBe(1);
    expect(snapshotFiles()).toHaveLength(1);
    expect(manifestFiles()).toHaveLength(1);
  });

  /**
   * Q4 的 checksum 去重。这条是整个远端体量账的落点：
   * 不走去重，"打开看一眼再关掉"也会往远端堆一个不可变快照。
   */
  it('内容没变时再同步一次 ⇒ no-changes，远端文件数一个都不多', async () => {
    await configure();
    await seedSessions(3);
    await runSync(deps(), AT);
    const after = { snapshots: snapshotFiles().length, manifests: manifestFiles().length };

    const second = await runSync(deps(), AT + 60_000);
    expect(second.status).toBe('idle');
    expect(second.skip).toBe('no-changes');
    expect(snapshotFiles()).toHaveLength(after.snapshots);
    expect(manifestFiles()).toHaveLength(after.manifests);
  });

  it('本地新增一条 ⇒ 推 revision 2，而旧快照仍然在（不可变历史）', async () => {
    await configure();
    await seedSessions(1);
    await runSync(deps(), AT);
    const firstSnapshot = snapshotFiles()[0];

    await storage.putGroup(
      groupFixture('会话 x', [savedTabFixture('x', 'x-t0', 0)], { id: 'x', sortOrder: 9, updatedAt: AT + 5000 }),
    );
    const second = await runSync(deps(), AT + 5000);
    expect(second.pushed?.revision).toBe(2);
    expect(snapshotFiles()).toHaveLength(2);
    expect(snapshotFiles()).toContain(firstSnapshot);
    // 旧那个文件的字节还是原样：推新版不许顺手改旧版
    expect(remote.files.get(firstSnapshot as string)).toContain('"revision":1');
  });

  /**
   * ★ 这一条原来钉的是**反方向**：标题写的是"推上去的载荷是压缩前的 JSON 原文"。
   * 那不是有人手滑 —— 那确实是当时的事实（`sync-engine.ts` PUT 的就是
   * `JSON.stringify(snapshot)`），而三处注释已经在按"压缩后 0.2–0.4 MiB"记账。
   * 既有约定 给线上加了编码，所以这条跟着改成新合同，而不是留着当"编码没变"的假证据。
   *
   * 这一档载荷很小（两个会话），**故意不套信封**：base64 固定加 33%，而几百字节的
   * JSON 压不出对应的收益 —— 多数用户就处在这一档。大载荷那一档见下一条。
   */
  it('小载荷推上去就是原文 JSON（不套信封），且带 baseSnapshotId 指向上一版', async () => {
    await configure();
    await seedSessions(1);
    await runSync(deps(), AT);
    await storage.putGroup(
      groupFixture('会话 y', [savedTabFixture('y', 'y-t0', 0)], { id: 'y', sortOrder: 8, updatedAt: AT + 5000 }),
    );
    await runSync(deps(), AT + 5000);

    const newest = snapshotFiles().find((url) => url !== snapshotFiles()[0]);
    const stored = remote.files.get(newest as string) as string;
    // 文件本身是一份合法 JSON 载荷，而不是外面又套了一层壳
    expect(JSON.parse(stored)).toHaveProperty('format', 'shitab-snapshot');
    expect(JSON.parse(stored)).not.toHaveProperty('encoding');

    const payload = await remoteSnapshot(remote.files, newest as string);
    expect(payload.state.groups).toHaveLength(2);
    expect(payload.baseSnapshotId).toBeTruthy();
    expect(payload.format).toBe('shitab-snapshot');
  });

  /**
   * 大载荷那一档：这一层要消掉的正是"每推一次、每拉一次都是整份原文"。
   * 既有约定 当年否掉逐实体布局时引的 4.9% 压缩比，算的就是这条线上该有的账。
   */
  it('越过阈值的大载荷 ⇒ 远端那份文件是 gzip+base64 的信封，且确实小得多', async () => {
    await configure();
    await seedSessions(200);
    await runSync(deps(), AT);

    const files = snapshotFiles();
    expect(files).toHaveLength(1);
    const stored = remote.files.get(files[0] as string) as string;

    // 信封外面仍然是合法 JSON：`Content-Type: application/json` 不说谎，
    // 主机侧的类型嗅探与"打开远端文件看一眼"都还成立。
    expect(JSON.parse(stored)).toHaveProperty('encoding', WIRE_ENCODING);

    const snapshot = await remoteSnapshot(remote.files, files[0] as string);
    expect(snapshot.state.groups).toHaveLength(200);
    // 差分证明"进了产物"：拿同一条载荷自己摊成原文比一次，不靠记忆里的压缩比
    expect(stored.length).toBeLessThan(JSON.stringify(snapshot).length);
    // 内容寻址的文件名不许因为换编码而变：文件名只由 `state` 的 checksum 决定
    expect(files[0]).toContain(snapshot.snapshotId);
  });
});

/**
 * ★ 指针落地之后新长出来的三条判据（既有约定 / S4+S5）。
 *
 * 这三条都不是"顺手补的"：是指针把"最新是哪一版"从**列目录**改成**读一份可变文件**之后，
 * 才第一次存在的失败形状。少钉任何一条，改动的安全部分就等于没测。
 */
describe('指针时代的并发与截断', () => {
  /** 摆一版"另一个设备已经推了 revision 2，但它指针那一笔没落上"的现场。 */
  async function plantStaleOtherRevision(ourSnapshotId: string, mode: 'other' | 'mine'): Promise<string> {
    const otherId = mode === 'other' ? 'other-snap' : ourSnapshotId;
    const otherState: StoredState = {
      groups: mode === 'other' ? [groupFixture('对面加的', [savedTabFixture('w', 'w-t0', 0)], { id: 'w', updatedAt: AT + 2000 })] : [],
      categories: [],
      tombstones: [],
    };
    remote.files.set(otherSnapshotUrl(otherId), JSON.stringify({
      format: 'shitab-snapshot', version: 1, snapshotId: otherId, deviceId: 'device-other',
      revision: 2, createdAt: AT + 2000, stateChecksum: await checksumOfState(otherState), state: otherState,
    }));
    remote.files.set(otherManifestUrl(2), JSON.stringify({
      format: 'shitab-manifest', version: 1, latestRevision: 2, latestSnapshotId: otherId,
      updatedAt: AT + 2000, deviceIds: ['device-other'], history: [],
    }));
    return otherId;
  }

  it('两台设备算出同一个 revision ⇒ 后写的**不静默盖掉**先写的那一版', async () => {
    await configure();
    await seedSessions(1);
    const first = await runSync(deps(), AT);
    const ours = first.pushed;
    if (!ours) throw new Error('setup：第一次同步应当真的推上去');
    await plantStaleOtherRevision(ours.snapshotId, 'other');
    const heldBefore = remote.files.get(otherManifestUrl(2));

    await storage.putGroup(
      groupFixture('会话 c', [savedTabFixture('c', 'c-t0', 0)], { id: 'c', sortOrder: 5, updatedAt: AT + 3000 }),
    );
    const outcome = await runSync(deps(), AT + 3000);

    // 本机也算出 revision 2 —— 那一格已经被对面占了
    expect(outcome.status).toBe('error');
    expect(outcome.error?.kind).toBe('precondition-failed');
    expect(remote.files.get(otherManifestUrl(2)), '对面那一版必须逐字节还在').toBe(heldBefore);
    // 失败要落进已有的退避，而不是裸抛给 background
    const meta = await storage.getSyncMeta();
    expect(meta.consecutiveFailures).toBe(1);
    expect(meta.nextAttemptAt, '下一轮要等退避，不许立刻再抢一次号').toBeGreaterThan(AT + 3000);
    expect(meta.lastError?.kind).toBe('precondition-failed');
  });

  it('撞上的是**自己上一轮那一版**（指针那笔崩了）⇒ 补上指针就算成，不用重推', async () => {
    await configure();
    await seedSessions(1);
    const first = await runSync(deps(), AT);
    const ours = first.pushed;
    if (!ours) throw new Error('setup：第一次同步应当真的推上去');
    await plantStaleOtherRevision(ours.snapshotId, 'mine');

    await storage.putGroup(
      groupFixture('会话 d', [savedTabFixture('d', 'd-t0', 0)], { id: 'd', sortOrder: 6, updatedAt: AT + 3000 }),
    );
    const outcome = await runSync(deps(), AT + 3000);

    expect(outcome.status, '那一版就是我们的，只差指针没跟上 ⇒ 补齐即可').toBe('idle');
    expect(pointerFiles(), '指针要落上远端，别的设备才看得见这一版').toHaveLength(1);
    const pointer = JSON.parse(remote.files.get(pointerUrl(REMOTE_BASE.url).href) as string);
    expect(pointer.revision).toBe(outcome.pushed?.revision);
    expect(pointer.snapshotId).toBe(outcome.pushed?.snapshotId);
  });

  /**
   * 拿满单次列举上限 ⇒ **拒绝猜**。
   * 这一条同时钉两件事：它不许被当成"远端是空的"（那会把对面的删除吞掉），
   * 也不许裸抛出 `runSync`（那会变成"点了没反应，也没说为什么"）。
   */
  it('列举拿满 750 条 ⇒ 报错不猜最新是哪一版，且落进退避', async () => {
    await configure();
    await seedSessions(1);
    await runSync(deps(), AT);
    // 抹掉指针 ⇒ 退回扫目录；再把 manifests/ 填到上限
    remote.files.delete(pointerUrl(REMOTE_BASE.url).href);
    for (let revision = 3; revision <= TRUSTED_LISTING_LIMIT; revision += 1) {
      remote.files.set(otherManifestUrl(revision), JSON.stringify({
        format: 'shitab-manifest', version: 1, latestRevision: revision, latestSnapshotId: 'whatever',
        updatedAt: AT, deviceIds: ['device-other'], history: [],
      }));
    }
    const listed = manifestFiles().length;
    expect(listed, '夹具没摆满，这条用例就是空转').toBeGreaterThanOrEqual(TRUSTED_LISTING_LIMIT - 1);

    await storage.putGroup(
      groupFixture('会话 e', [savedTabFixture('e', 'e-t0', 0)], { id: 'e', sortOrder: 7, updatedAt: AT + 3000 }),
    );
    const outcome = await runSync(deps(), AT + 3000);

    expect(outcome.status, '宁可报错，不许从半份清单里挑一个"最大的"当最新').toBe('error');
    expect(outcome.error?.message).toContain(String(TRUSTED_LISTING_LIMIT));
    expect(snapshotFiles(), '远端一个字节都不许多').toHaveLength(1);
    expect((await storage.getSyncMeta()).consecutiveFailures).toBe(1);
  }, 30_000);
});

  /**
   * ★ 真机报回来的故障（2026-10-08，用户截图）：「同步日志」被
   * `↓ 拉取 · 开着的师兄收纳页面 · 并入 0` 每 60 秒一条灌满，环 100 在两个半小时内到顶，
   * 真正的两次推送差点被挤出去。
   *
   * 这一条钉的是它的前提：**本机一个字节没动的一轮，不该重写本地、也不该记任何事件。**
   * 分类本身没错（`sync-engine.ts:636-643`：只有真的合并过才记 `pull`）——
   * 所以日志是在**如实报告**一件不该发生的事：每轮都判定"本机 ≠ 远端"、走进合并、
   * 调 `applyMergedState` 把整份本机状态重写一遍，然后结果又恰好与远端同形、没事可推。
   *
   * 三个断言各钉一环，红在哪一环就定位到哪一层：
   * - 第 1 环（推完立刻量）：推上去的那一版与读回来的本机状态 checksum 不等
   *   ⇒ `applyMergedState` 不往返（写了但读回来不是同一份）⇒ 既有约定 那条省流量快路径
   *   要求的 `lastPushedChecksum === localChecksum` 永远不成立，于是每轮都退回完整路径。
   * - 第 2、3 环：故障本身（重写本地 + 记事件）。
   */
  it('本机没动的第二轮 ⇒ 不重写本地、不记事件（真机：日志被「拉取 并入 0」灌满）', async () => {
    await configure();
    await seedSessions(2);
    const first = await runSync(deps(), AT);
    expect(first.status).toBe('idle');
    const pushedChecksum = (await storage.getSyncMeta()).lastPushedChecksum;
    expect(pushedChecksum, '前置：第一轮确实推上去了一版').toBeDefined();

    // 第 1 环：推完立刻量 —— 落库的那份读回来必须就是刚推上去的那一版
    expect(
      await stateChecksumOf(await readStoredState(deps())),
      '推上去的 checksum 与读回来的本机 checksum 不等 ⇒ applyMergedState 不往返 ⇒ 每轮都会误判"本机变了"',
    ).toBe(pushedChecksum);

    const eventsBefore = (await storage.listSyncEvents()).length;
    const snapshotsBefore = snapshotFiles().length;

    const second = await runSync(deps(), AT + 60_000);
    expect(second.status).toBe('idle');
    expect(second.skip, '这一轮必须是空转，不是"拉取"').toBe('no-changes');

    // 第 2 环：空转不写日志（既有约定 的"空转出口不落盘"）
    expect(
      (await storage.listSyncEvents()).length,
      '空转那一轮记了一条事件 ⇒ 环 100 会被 60 秒一次的心跳灌满',
    ).toBe(eventsBefore);
    // 第 3 环：远端一个字节都不许多
    expect(snapshotFiles()).toHaveLength(snapshotsBefore);
  });

describe('同步引擎：远端坏了要能继续，而不是把同步卡死', () => {
  /**
   * §5 规则 5 + §19「manifest 更新失败 ⇒ snapshot 可重新发现」。
   * ★ 既有约定 之后要把 manifest **和指针**一起抹掉才是"账本没了"：
   * 指针还活着的话引擎根本不需要扫目录（那是下面那条用例钉的另一半）。
   */
  it('manifest 与指针都不见了 ⇒ 扫快照目录重建，同步照样完成', async () => {
    await configure();
    await seedSessions(2);
    await runSync(deps(), AT);
    for (const url of manifestFiles()) remote.files.delete(url);
    remote.files.delete(pointerUrl(REMOTE_BASE.url).href);
    expect(manifestFiles()).toHaveLength(0);
    expect(pointerFiles(), '指针是这一半场景里最后一份活着的账').toHaveLength(0);

    await storage.putGroup(
      groupFixture('会话 z', [savedTabFixture('z', 'z-t0', 0)], { id: 'z', sortOrder: 7, updatedAt: AT + 9000 }),
    );
    const outcome = await runSync(deps(), AT + 9000);
    expect(outcome.status).toBe('idle');
    expect(outcome.manifestRebuilt).toBe(true);
    // 重建出来的最新是 revision 1，所以这一次推的是 2 —— 编号没有因为丢 manifest 而倒退
    expect(outcome.pushed?.revision).toBe(2);
  });

  /**
   * 对称的另一半：指针在、revision manifest 没了。
   *
   * 既有约定 之后这才是**更常见**的那种坏法（指针是最后写的一笔，它活着说明前面都成了）。
   * 单独钉的理由：上面那条走的是扫目录，这条走的是"一个 GET 就定位到"，
   * 两条判据不同、省的开销也不同；把它并进上面一条，两边会退化成同一个断言形状，
   * 于是"指针到底救回了多少"这一整块就没有用例看着了。
   */
  it('指针还在、manifest 没了 ⇒ 直接定位到那一版快照，不扫目录也不报重建', async () => {
    await configure();
    await seedSessions(2);
    await runSync(deps(), AT);
    for (const url of manifestFiles()) remote.files.delete(url);
    expect(manifestFiles()).toHaveLength(0);
    expect(pointerFiles()).toHaveLength(1);

    await storage.putGroup(
      groupFixture('会话 z', [savedTabFixture('z', 'z-t0', 0)], { id: 'z', sortOrder: 7, updatedAt: AT + 9000 }),
    );
    const outcome = await runSync(deps(), AT + 9000);
    expect(outcome.status).toBe('idle');
    expect(outcome.manifestRebuilt, '指针已经回答了"最新是哪一版"，不该再扫一遍目录').toBeFalsy();
    expect(outcome.pushed?.revision, '编号不能因为丢 manifest 而倒退').toBe(2);

    // 正向对照：它确实拿到了对面那一版的内容，所以是"2 条原有 + 1 条新"三条都在，
    // 而不是"没读到远端、把自己这一版原样推上去"。
    const files = snapshotFiles();
    const newest = await remoteSnapshot(remote.files, files[files.length - 1] as string);
    expect(newest.state.groups).toHaveLength(3);
  });

  /** §19「远端历史文件损坏 ⇒ 跳过坏版本」。 */
  it('远端那份快照被改坏了 ⇒ 跳过它，同步不被卡死', async () => {
    await configure();
    await seedSessions(1);
    await runSync(deps(), AT);
    const url = snapshotFiles()[0] as string;
    remote.files.set(url, '{"format":"shitab-snapshot","version":1,"stateChecksum":"lies","state":{}}');

    const outcome = await runSync(deps(), AT + 5000);
    expect(outcome.status).toBe('idle');
    expect(outcome.error).toBeUndefined();
  });

  /**
   * §19「WebDAV 401 ⇒ 只报错，不改本地数据」。
   * 这条的价值在于它同时钉了后半句：失败时本地一条会话都不能少。
   */
  it('上传被 401 拒绝 ⇒ status error、退避计时、本地数据一条不少', async () => {
    await configure();
    await seedSessions(4);
    remote.nextFault({ status: 401, method: 'PUT' });

    const outcome = await runSync(deps(), AT);
    expect(outcome.status).toBe('error');
    expect(outcome.error?.kind).toBe('credentials');
    expect(await storage.listGroupIndex()).toHaveLength(4);
    const meta = await storage.getSyncMeta();
    expect(meta.consecutiveFailures).toBe(1);
    expect(meta.nextAttemptAt).toBe(AT + backoffDelayMs(1));
  });

  it('退避期内不再尝试（否则一次服务器抖动会变成对它的持续轰炸）', async () => {
    await configure();
    await seedSessions(1);
    remote.nextFault({ status: 503, method: 'PUT' });
    await runSync(deps(), AT);

    const before = snapshotFiles().length;
    const again = await runSync(deps(), AT + 1000);
    expect(again.skip).toBe('backoff');
    expect(snapshotFiles()).toHaveLength(before);
  });

  it('backoffDelayMs 指数增长并封顶在 30 分钟，且不溢出', () => {
    expect(backoffDelayMs(0)).toBe(5_000);
    expect(backoffDelayMs(1)).toBe(10_000);
    expect(backoffDelayMs(3)).toBe(40_000);
    expect(backoffDelayMs(30)).toBe(30 * 60 * 1000);
    expect(Number.isFinite(backoffDelayMs(200))).toBe(true);
  });
});

/**
 * 真坚果云 2026-10-04 实测的两条形状，这里各钉一次：
 * 1. 目录还不存在时它对 PROPFIND 回 **409 `AncestorsNotFound`**（父没了就说父没了，
 *    不是大家约定的 404）。这条如果不认成"空库"，全新用户的第一次同步会当场失败 ——
 *    而他看到的现象和真正的 bug（propfind 抛异常）一模一样，最难区分。
 * 2. 写进去的路径必须就是设置页那一行显示的落点：拼接函数只有一份，
 *    界面与引擎各算各的迟早算出两个库。
 */
describe('远端布局与真坚果云的 409', () => {
  it('PROPFIND 回 409（祖先不存在）⇒ 当空库处理，第一次同步照样完成', async () => {
    const parsed = parseBaseUrl(BASE);
    if (!parsed.ok) throw new Error('setup');
    remote = createFakeWebDav({
      expectedCredential: FAKE_CREDENTIAL,
      faults: [
        { method: 'PROPFIND', url: manifestsDirUrl(parsed.url).href, status: 409 },
        { method: 'PROPFIND', url: snapshotsDirUrl(parsed.url).href, status: 409 },
      ],
    });
    await configure();
    await seedSessions(1);

    const outcome = await runSync(deps(), AT);
    expect(outcome.error).toBeUndefined();
    expect(outcome.status).toBe('idle');
    expect(outcome.pushed?.revision).toBe(1);
    // 正向对照：少了这两行，"409 被当空库"写成"409 被当同步失败、什么也没推"也能半绿——
    // status 那几条断言在 early-return 的形状下未必红，所以必须钉住"文件真的落下去了"。
    expect(snapshotFiles()).toHaveLength(1);
    expect(manifestFiles()).toHaveLength(1);
  });

  it('引擎写进去的位置 = 面板显示的那条落点（拼接不许有第二份）', async () => {
    await configure();
    await seedSessions(1);
    await runSync(deps(), AT);

    const parsed = parseBaseUrl(BASE);
    if (!parsed.ok) throw new Error('setup');
    const root = remoteRootUrl(parsed.url).href;
    const written = [...snapshotFiles(), ...manifestFiles()];
    expect(written.length).toBeGreaterThan(0);
    for (const url of written) expect(url.startsWith(root)).toBe(true);
    expect(root).toBe('https://host/dav/ShiXiongZhiDao/ShiTab/');
  });

  it('地址里已经写了归属目录 ⇒ 引擎写的还是同一条路径，不出现双拼库', async () => {
    await storage.setWebDavConfig({
      enabled: true,
      baseUrl: 'https://host/dav/ShiXiongZhiDao',
      username: FAKE_CREDENTIAL.username,
      allowInsecureHttp: false,
    });
    await storage.setSyncCredential(FAKE_CREDENTIAL.password);
    await seedSessions(1);
    await runSync(deps(), AT);

    const written = [...snapshotFiles(), ...manifestFiles()];
    expect(written.length).toBe(2);
    for (const url of written) {
      expect(url).not.toContain('ShiXiongZhiDao/ShiXiongZhiDao');
      expect(url.startsWith('https://host/dav/ShiXiongZhiDao/ShiTab/')).toBe(true);
    }
  });
});

describe('同步引擎：两台设备', () => {
  /**
   * 摆上"另一台设备基于本机那一版加了一条会话，然后推了一版"。
   *
   * 三份文件按真实推送顺序摆：快照 → revision manifest → **指针**。
   * 少摆指针就不等价于"对面推了一版"—— 本机第一步读指针会读到自己那一版，
   * 摆在后面的 revision 2 直接隐形。
   *
   * `otherState` 故意**没有 `trash` 键**（远端那台的老形状），
   * 这样"键缺失 vs 空数组"这一对差异留在输入里，合并往返那条用例才测得到它。
   *
   * 返回本机第一轮推上去的那份快照地址：调用方要从"合并之后新写的那一版"里读结果，
   * 而对面那一版与本机的旧版**都可能是** `snapshotFiles()[0]`（顺序跟着 Set 的插入先后变）。
   * 实测就是这里先炸的：helper 里取的第 0 份是对面那份，本机旧版没被排除掉，
   * 于是"推上去的那一版有三条会话"读到两条 —— 红得像个功能 bug，其实是取错了文件。
   */
  async function plantOtherDevicePush(): Promise<{ otherId: string; myFirstSnapshotUrl: string }> {
    const mineUrl = snapshotFiles()[0] as string;
    const otherId = 'other-snapshot';
    const otherState = {
      groups: [
        ...(await remoteSnapshot(remote.files, mineUrl)).state.groups,
        groupFixture('别的设备加的', [savedTabFixture('w', 'w-t0', 0)], { id: 'w', sortOrder: 99, updatedAt: AT + 3000 }),
      ],
      categories: [],
      tombstones: [],
    };
    remote.files.set(
      otherSnapshotUrl(otherId),
      JSON.stringify({
        format: 'shitab-snapshot',
        version: 1,
        snapshotId: otherId,
        deviceId: 'device-other',
        revision: 2,
        createdAt: AT + 3000,
        stateChecksum: await checksumOfState(otherState),
        state: otherState,
      }),
    );
    plantOtherPointer(otherId);
    remote.files.set(
      otherManifestUrl(2),
      JSON.stringify({
        format: 'shitab-manifest',
        version: 1,
        latestRevision: 2,
        latestSnapshotId: otherId,
        updatedAt: AT + 3000,
        deviceIds: ['device-other'],
        history: [],
      }),
    );
    return { otherId, myFirstSnapshotUrl: mineUrl };
  }

  /**
   * §10「多设备冲突不静默覆盖」。做法是先合并再推：
   * 远端有一条本机没有的会话时，本机既不丢自己的，也不丢远端的。
   */
  it('远端多出一条会话 ⇒ 两边都留下，并把合并结果推回去（不是只推本机旧账）', async () => {
    await configure();
    await seedSessions(2);
    await runSync(deps(), AT);

    const { otherId, myFirstSnapshotUrl: mineUrl } = await plantOtherDevicePush();

    const outcome = await runSync(deps(), AT + 4000);
    expect(outcome.status).toBe('idle');
    expect(outcome.pulled?.revision).toBe(2);
    // 合并落回本地：两条原有 + 一条外来
    expect((await storage.listGroupIndex()).map((entry) => entry.id).sort()).toEqual(['s0', 's1', 'w']);
    // 关键：推上去的那一版是**合并后**的，三条都在
    const pushedUrl = snapshotFiles().find((url) => !url.endsWith(`${otherId}.json`) && url !== mineUrl);
    const pushed = await remoteSnapshot(remote.files, pushedUrl as string);
    expect(pushed.state.groups).toHaveLength(3);
    expect(pushed.revision).toBe(3);
  });

  /**
   * ★ 真机报回来的故障（2026-10-08 用户截图）：`推送 本机的改动 版本 22→31`，
   * 9 分钟 10 个版本、中间还跳号（26→28→30 = 另一台也在推）。
   * 每一轮都往坚果云落一个**不可变**快照，所以这不是日志难看，是在烧请求配额。
   *
   * 上面那条"本机没动的第二轮"绿了 ⇒ **没进合并**的一轮会空转。
   * 这条把唯一还没测过的那一支补上：**进过合并、并且真的推上去**的那一轮之后，
   * 下一轮必须同样空转。它的判据是引擎自己那条快路径
   * （`sync-engine.ts` 的 `remote.stateChecksum === outgoingChecksum`，既有约定），
   * 而 `outgoingChecksum` 来自内存里的那份、下一轮的 `localChecksum` 来自
   * `readStoredState` 读回来的那份 —— 两者一旦不等，每台都会永远认为自己有新东西要推。
   *
   * 三个断言各钉一环，红在哪一环就定位到哪一层：
   * - 第 1 环 `skip === undefined`：前置，这一轮确实推了（否则后面两条是空对空）。
   * - 第 2 环 checksum 往返：`applyMergedState` 写的 ≠ 推上去的那一版。
   * - 第 3 环 空转 + 远端不许多出快照：故障本身。
   */
  it('进过合并的那一轮之后，下一轮必须空转（真机：两台 9 分钟互推 10 个版本）', async () => {
    await configure();
    await seedSessions(2);
    await runSync(deps(), AT);
    await plantOtherDevicePush();

    const mergedRound = await runSync(deps(), AT + 4000);
    expect(mergedRound.status).toBe('idle');
    const pushedChecksum = (await storage.getSyncMeta()).lastPushedChecksum;
    expect(pushedChecksum, '前置：这一轮确实合并并推送了一版').toBeDefined();

    expect(
      await stateChecksumOf(await readStoredState(deps())),
      '合并落库的那份读回来与推上去的 checksum 不等 ⇒ 下一轮必然再推一次 ⇒ 两台互相驱动',
    ).toBe(pushedChecksum);

    const snapshotsBefore = snapshotFiles().length;
    const eventsBefore = (await storage.listSyncEvents()).length;
    const nextRound = await runSync(deps(), AT + 5000);
    expect(nextRound.skip, '这一轮必须是空转，不是"又推了一版"').toBe('no-changes');
    expect(snapshotFiles(), '远端每多一个快照就多一份不可变文件 + 一次 PUT').toHaveLength(snapshotsBefore);
    expect((await storage.listSyncEvents()).length, '空转不许记事件').toBe(eventsBefore);
  });

  /**
   * delete-vs-edit 撞车时**不推**：合并结果里还带着没定案的东西，
   * 推上去等于引擎替用户做了"这次删除算不算"的决定。
   */
  it('一边删了会话、另一边在删之后改了它 ⇒ conflict，且不写远端', async () => {
    await configure();
    await seedSessions(3);
    await runSync(deps(), AT);

    const mineUrl = snapshotFiles()[0] as string;
    const remoteState = {
      groups: [],
      categories: [],
      tombstones: [
        {
          id: 't1',
          entityType: 'group' as const,
          entityId: 's1',
          deletedAt: AT + 1000,
          deletedByDeviceId: 'device-other',
          reason: 'user-delete' as const,
        },
      ],
    };
    const otherId = 'other-2';
    remote.files.set(
      otherSnapshotUrl(otherId),
      JSON.stringify({
        format: 'shitab-snapshot',
        version: 1,
        snapshotId: otherId,
        deviceId: 'device-other',
        revision: 2,
        createdAt: AT + 1000,
        stateChecksum: await checksumOfState(remoteState),
        state: remoteState,
      }),
    );
    plantOtherPointer(otherId);
    remote.files.set(
      otherManifestUrl(2),
      JSON.stringify({
        format: 'shitab-manifest',
        version: 1,
        latestRevision: 2,
        latestSnapshotId: otherId,
        updatedAt: AT + 1000,
        deviceIds: ['device-other'],
        history: [],
      }),
    );

    // 本机在对方删除之后又改了 s1
    const s1 = await storage.getGroup('s1');
    if (!s1) throw new Error('setup');
    await storage.putGroup({ ...s1, title: '本机在删之后改了它', updatedAt: AT + 2000 });

    // 基线要取在**播种之后**、这次同步之前：上面手动插进去的那份 other-2.json 也在
    // /snapshots/ 里，把它算进 before 之前先的那个数会让"引擎有没有新写快照"这条判据
    // 把我自己塞的文件当成一次推送 —— 报红的是断言，不是引擎。
    const before = snapshotFiles().length;

    const outcome = await runSync(deps(), AT + 3000);
    expect(outcome.status).toBe('conflict');
    expect(outcome.pulled?.conflicts.map((conflict) => conflict.groupId)).toEqual(['s1']);
    expect(outcome.pushed).toBeUndefined();
    expect(snapshotFiles()).toHaveLength(before);
    void mineUrl;
  });
});

/**
 * 冲突必须**落盘**，否则跑到冲突的是 background、要选的是某个页面：
 * 用户一切换页面冲突就没人知道了，而同步会一直静默停在 conflict。
 */
describe('冲突裁决的账', () => {
  it('引擎停在 conflict 时把冲突写进 sync_meta，供页面上的对话框读', async () => {
    const outcome = await reachConflict();
    expect(outcome.status).toBe('conflict');
    const meta = await storage.getSyncMeta();
    expect(meta.pendingConflicts?.map((item) => item.groupId)).toEqual(['s1']);
    expect(meta.pendingConflicts?.[0]?.deleteReason).toBe('user-delete');
  });

  it('选"确认删除" ⇒ 会话消失、墓碑署名与对方一致、账上不再挂冲突', async () => {
    await reachConflict();
    const meta = await storage.getSyncMeta();
    const conflict = meta.pendingConflicts?.[0];
    if (!conflict) throw new Error('setup');

    await resolveConflict(deps(), conflict, 'delete', AT + 9000);

    expect(await storage.getGroup('s1')).toBeUndefined();
    const tombs = await storage.listTombstones();
    expect(tombs.filter((tomb) => tomb.entityId === 's1').map((tomb) => tomb.reason)).toEqual(['user-delete']);
    const after = await storage.getSyncMeta();
    expect(after.pendingConflicts).toBeUndefined();
    expect(after.status).toBe('pending');
  });

  it('选"保留会话" ⇒ 东西留着、冲突从账上摘掉、等下一轮同步把它推出去', async () => {
    await reachConflict();
    const conflict = (await storage.getSyncMeta()).pendingConflicts?.[0];
    if (!conflict) throw new Error('setup');

    await resolveConflict(deps(), conflict, 'keep', AT + 9000);

    expect(await storage.getGroup('s1')).toBeDefined();
    const after = await storage.getSyncMeta();
    expect(after.pendingConflicts).toBeUndefined();
    expect(after.status).toBe('pending');
    // 裁决只动本地，不碰远端（§5 规则 3：这里绝不许去 DELETE 云端文件）
    expect(snapshotFiles()).toHaveLength(2);
  });

  it('还有第二条没裁时留在 conflict，不假装已经清空', async () => {
    await reachConflict();
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({
      ...meta,
      pendingConflicts: [
        ...(meta.pendingConflicts ?? []),
        { groupId: 's2', groupTitle: '会话 s2', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: 'device-other', deleteReason: 'consumed' },
      ],
    });
    const first = (await storage.getSyncMeta()).pendingConflicts?.[0] as NonNullable<Awaited<ReturnType<StoragePort['getSyncMeta']>>['pendingConflicts']>[number];

    await resolveConflict(deps(), first, 'keep', AT + 9000);

    const after = await storage.getSyncMeta();
    expect(after.pendingConflicts?.map((item) => item.groupId)).toEqual(['s2']);
    expect(after.status).toBe('conflict');
  });
});

/**
 * 冲突账上"那一台叫什么"。
 *
 * 两个方向都要钉，因为这一个可选字段的全部价值就在"要么给真名字、要么什么都不给"：
 * 1. manifest 的设备表认得出那台设备 ⇒ 账上带的是**它自己起的名字**；
 *    表里没有、但那份快照的 `deviceId` 对得上 ⇒ 用快照自带的 `deviceName`（第二个来路）。
 * 2. 两处都解析不到 ⇒ 这个键**缺席**。在这里编一个"另一台设备"冒充用户起的名字，
 *    是比 UUID 前 8 位更坏的那种坏：用户会以为那真是对面给他起的。
 *
 * 每条否定都配正向对照（`deletedByDeviceId` 仍然在、名字确实是那串而不是别的），
 * 否则"引擎压根没写这一格"也能绿。
 */
describe('冲突账解析删除方的设备名', () => {
  const firstConflict = async (): Promise<NonNullable<Awaited<ReturnType<StoragePort['getSyncMeta']>>['pendingConflicts']>[number]> => {
    const conflict = (await storage.getSyncMeta()).pendingConflicts?.[0];
    if (!conflict) throw new Error('setup：这一轮没落在冲突上');
    return conflict;
  };

  it('manifest 设备表里有那一台 ⇒ pendingConflicts 带上它的名字', async () => {
    const outcome = await reachConflict({
      devices: [{ id: 'device-other', name: '办公室那台 Edge', updatedAt: AT + 1000 }],
    });
    expect(outcome.status, '前置：这一轮确实停在 delete-vs-edit').toBe('conflict');

    const conflict = await firstConflict();
    expect(conflict.deletedByName).toBe('办公室那台 Edge');
    // 正向对照：署名那格仍然是 id —— 名字是加上去的，不是把 id 替换掉
    expect(conflict.deletedByDeviceId).toBe('device-other');
  });

  it('设备表里没有，但那份快照自己带着名字且 deviceId 对得上 ⇒ 用快照那一份', async () => {
    const outcome = await reachConflict({ deviceName: '书房那台 Firefox' });
    expect(outcome.status).toBe('conflict');

    const conflict = await firstConflict();
    expect(conflict.deletedByName).toBe('书房那台 Firefox');
    expect(conflict.deletedByDeviceId).toBe('device-other');
  });

  it('两处都没有名字 ⇒ 这个键缺席（不编一个），id 仍在账上', async () => {
    const outcome = await reachConflict();
    expect(outcome.status).toBe('conflict');

    const conflict = await firstConflict();
    expect('deletedByName' in conflict, '解析不到却写了一个键 ⇒ UI 就永远走不到回退那一支').toBe(false);
    // 正向对照：同一台设备在上一条里拿得到名字，所以这一条的缺席是"没名字"而不是"没解析"
    expect(conflict.deletedByDeviceId).toBe('device-other');
  });
});

/**
 * 既有约定 的**发货端**：本机这一侧把名字送出去的那两处接线。
 *
 * 读侧（`nameOfDevice` / 冲突面板的 `deletedByName` / `resolveDeviceName` 的两个来路）早就有
 * 用例钉着，而写侧此前一条都没有 —— 于是"接上了"与"字段还是死的"在测试里长得一模一样。
 * 这三条各自盯一个失败形状：
 * 1. 快照没带 `deviceName` ⇒ 对面那台的名字只能从"扫快照重建 manifest"那条少数路径里捞。
 * 2. manifest 的 `devices` 只写本机那一条 ⇒ 每推一版就把对面从设备表里擦掉，
 *    对面下一次同步读到的 `remote.manifest.devices` 就成了空表，名字从此再也合不拢。
 * 3. `mergeDeviceTables` 不可交换 ⇒ 两台设备各算一张表，每一轮同步都多出一版"内容其实一样"
 *    的远端载荷（与 `merge.ts` 的可交换性是同一个要求）。
 */
describe('推送侧的设备名（既有约定 的发货端）', () => {
  const MY_NAME = '书房那台 Chrome';
  const MY_ID = async (): Promise<string> => (await storage.getDeviceProfile()).id;

  it('推上去的那一版快照带着本机设备的名字', async () => {
    await configure();
    await storage.setDeviceName(MY_NAME);
    await seedSessions(1);

    await runSync(deps(), AT);

    const pushed = await remoteSnapshot(remote.files, snapshotFiles()[0] as string);
    expect(pushed.deviceName, '推送侧没押上名字 ⇒ 对面那台设备的冲突面板只能显示 UUID 前缀').toBe(MY_NAME);
    // 正向对照：名字是**加**上去的一格，身份那一格仍然是 id，不是被名字顶掉
    expect(pushed.deviceId).toBe(await MY_ID());
    expect(pushed.deviceId).not.toBe(MY_NAME);
  });

  /**
   * 两台设备**各推一次**之后的那张表才是重点：第 2 版是对面写的（这里按裸 JSON 摆，
   * `decodeWire` 容得下没有信封的原文），第 3 版是本机在读过它之后写的。
   * 本机写的那一版必须同时留着两条、各自带自己的名字 —— 只写自己那一条就是覆盖别人。
   */
  it('两台设备各推一次 ⇒ manifest 的 devices 是并集，每条带各自的 name', async () => {
    await configure();
    await storage.setDeviceName(MY_NAME);
    await seedSessions(1);
    await runSync(deps(), AT);

    const myId = await MY_ID();
    const otherId = 'other-device-naming';
    const otherState: StoredState = {
      groups: [
        ...(await remoteSnapshot(remote.files, snapshotFiles()[0] as string)).state.groups,
        groupFixture('对面加的一条', [savedTabFixture('o', 'o-t0', 0)], { id: 'o', sortOrder: 5, updatedAt: AT + 3000 }),
      ],
      categories: [],
      tombstones: [],
      trash: [],
    };
    remote.files.set(
      otherSnapshotUrl(otherId),
      JSON.stringify({
        format: 'shitab-snapshot',
        version: 1,
        snapshotId: otherId,
        deviceId: 'device-other',
        revision: 2,
        createdAt: AT + 3000,
        stateChecksum: await checksumOfState(otherState),
        state: otherState,
        deviceName: '办公室那台 Edge',
      }),
    );
    plantOtherPointer(otherId);
    remote.files.set(
      otherManifestUrl(2),
      JSON.stringify({
        format: 'shitab-manifest',
        version: 1,
        latestRevision: 2,
        latestSnapshotId: otherId,
        updatedAt: AT + 3000,
        deviceIds: ['device-other'],
        history: [],
        devices: [{ id: 'device-other', name: '办公室那台 Edge', updatedAt: AT + 3000 }],
      }),
    );

    const outcome = await runSync(deps(), AT + 4000);
    expect(outcome.pushed?.revision, '前置：这一轮推的是合并后的第 3 版').toBe(3);

    const manifest = await remoteManifest(remote.files, otherManifestUrl(3));
    const devices = manifest.devices ?? [];
    // ★ 并集而不是"本机这一条"：对面的那条不能被这一轮擦掉
    expect(devices.map((device) => device.id)).toEqual([myId, 'device-other'].sort());
    expect(devices.find((device) => device.id === 'device-other')?.name).toBe('办公室那台 Edge');
    expect(devices.find((device) => device.id === myId)?.name).toBe(MY_NAME);
    // 正向对照：对面那一条的 updatedAt 仍然是**它自己**写的那一版，没有被本轮的时刻改写
    expect(devices.find((device) => device.id === 'device-other')?.updatedAt).toBe(AT + 3000);
    expect(devices.find((device) => device.id === myId)?.updatedAt).toBe(AT + 4000);
  });

  /**
   * 纯函数那一半：`mergeDeviceTables` 此前没有任何用例（全仓搜调用点只有引擎与注释）。
   * 可交换性是**逐字节**的要求 —— manifest 是写进远端给别人读的，两张表就是两版空推送。
   */
  it('mergeDeviceTables 可交换且确定：A 并 B 与 B 并 A 逐字节一致', () => {
    const a: DevicePointer[] = [{ id: 'device-a', name: '旧的那台', updatedAt: 10 }];
    const b: DevicePointer[] = [
      { id: 'device-b', name: '办公室那台 Edge', updatedAt: 30 },
      { id: 'device-a', name: '改名之后的那台', updatedAt: 20 },
    ];

    expect(JSON.stringify(mergeDeviceTables(a, b))).toBe(JSON.stringify(mergeDeviceTables(b, a)));
    // 正向对照：合并不是"各留各的"，也不是只剩一条 —— 同一 id 取 updatedAt 大的那条，
    // 结果按 id 排序（上面那句逐字节一致靠的就是这两条）。
    expect(mergeDeviceTables(a, b)).toEqual([
      { id: 'device-a', name: '改名之后的那台', updatedAt: 20 },
      { id: 'device-b', name: '办公室那台 Edge', updatedAt: 30 },
    ]);
    // 平手（毫秒级并发真会撞）取 name 字典序小者 —— 否则两边各留各的，逐字节一致就没了
    const tie = [
      mergeDeviceTables([{ id: 'x', name: 'zz', updatedAt: 5 }], [{ id: 'x', name: 'ab', updatedAt: 5 }]),
      mergeDeviceTables([{ id: 'x', name: 'ab', updatedAt: 5 }], [{ id: 'x', name: 'zz', updatedAt: 5 }]),
    ];
    expect(JSON.stringify(tie[0])).toBe(JSON.stringify(tie[1]));
    expect(tie[0]?.[0]?.name).toBe('ab');
  });
});

async function checksumOfState(state: StoredState): Promise<string> {
  const { stateChecksumOf } = await import('@/core/domain/sync-data');
  return stateChecksumOf(state);
}

/**
 * 把引擎逼到 delete-vs-edit 冲突那一站：远端删了 s1，本机在删除之后又改了它。
 * 返回停在 conflict 的那次结果，同时 sync_meta 里已经挂着这笔账。
 *
 * `otherDevice` 那一格是 既有约定 要的：对面那台设备**叫什么**有两个来路
 * （manifest 的 `devices` 表 / 快照自己带的 `deviceName`），两个方向都要摆得出来，
 * 所以它是参数而不是写死的夹具。都不给 ⇒ 两处都没有名字，那正是"解析不到就留空"那一格。
 */
async function reachConflict(
  otherDevice: {
    devices?: Array<{ id: string; name: string; updatedAt: number }>;
    deviceName?: string;
  } = {},
) {
  await configure();
  await seedSessions(3);
  await runSync(deps(), AT);

  const remoteState: StoredState = {
    groups: [],
    categories: [],
    tombstones: [
      {
        id: 't1',
        entityType: 'group' as const,
        entityId: 's1',
        deletedAt: AT + 1000,
        deletedByDeviceId: 'device-other',
        reason: 'user-delete' as const,
      },
    ],
  };
  const otherId = 'conflict-snapshot';
  remote.files.set(
    otherSnapshotUrl(otherId),
    JSON.stringify({
      format: 'shitab-snapshot',
      version: 1,
      snapshotId: otherId,
      deviceId: 'device-other',
      revision: 2,
      createdAt: AT + 1000,
      stateChecksum: await checksumOfState(remoteState),
      state: remoteState,
      ...(otherDevice.deviceName === undefined ? {} : { deviceName: otherDevice.deviceName }),
    }),
  );
  plantOtherPointer(otherId);
  remote.files.set(
    otherManifestUrl(2),
    JSON.stringify({
      format: 'shitab-manifest',
      version: 1,
      latestRevision: 2,
      latestSnapshotId: otherId,
      updatedAt: AT + 1000,
      deviceIds: ['device-other'],
      history: [],
      ...(otherDevice.devices === undefined ? {} : { devices: otherDevice.devices }),
    }),
  );

  const s1 = await storage.getGroup('s1');
  if (!s1) throw new Error('setup');
  await storage.putGroup({ ...s1, title: '本机在删之后改了它', updatedAt: AT + 2000 });

  return runSync(deps(), AT + 3000);
}

/**
 * 回收站跟着同步。
 *
 * 判据全部取"用户看得见的那件事"：另一台设备删掉的会话在这台的回收站里要看得见、能还原；
 * 这台处理掉的那一行不要再从对面并回来。合成快照的写法照上面 `reachConflict` 那套 ——
 * 远端文件的位置一律从拼接函数取，不在测试里手写路径。
 */
describe('回收站跟着同步', () => {
  /** 最新那一版快照：文件名按 checksum 排，所以按 revision 找，不按数组下标。 */
  async function newestSnapshot(): Promise<{ revision: number; state: StoredState }> {
    const parsed = await Promise.all(snapshotFiles().map((url) => remoteSnapshot(remote.files, url)));
    const newest = parsed.sort((a, b) => b.revision - a.revision)[0];
    if (!newest) throw new Error('远端一份快照都没有');
    return newest;
  }

  it('软删一个会话 ⇒ 推上去的那一版载荷里带着那一行', async () => {
    await configure();
    await seedSessions(1);
    await softDeleteGroup({ storage }, { groupId: 's0', reason: 'user-delete', at: AT });

    await runSync(deps(), AT + 1000);

    const pushed = await newestSnapshot();
    expect(pushed.state.groups).toHaveLength(0);
    // 会话没了、行还在：另一台设备拿到的正是"可以还原的那一份"
    expect(pushed.state.trash?.map((entry) => entry.group.id)).toEqual(['s0']);
    expect(pushed.state.trash?.[0]?.group.tabs).toHaveLength(1);
  });

  /**
   * 这台机器换到"第二台设备"的做法是清空本机存储重开一次同步 ——
   * 那比手搓一份远端快照更接近真实路径：读、验货、合并、落库这一整条都得走一遍。
   */
  it('另一台设备删掉的会话 ⇒ 本机同步后回收站里看得见，记录一条不少', async () => {
    await configure();
    await storage.putGroup(
      groupFixture('会话 q', [savedTabFixture('q', 'q-t0', 0), savedTabFixture('q', 'q-t1', 1)], { id: 'q', updatedAt: AT }),
    );
    await softDeleteGroup({ storage }, { groupId: 'q', reason: 'user-delete', at: AT });
    await runSync(deps(), AT + 1000);

    await fakeBrowser.storage.local.clear();
    storage = createStoragePort();
    await storage.heal();
    await configure();
    const outcome = await runSync(deps(), AT + 5000);

    expect(outcome.status).toBe('idle');
    const rows = await storage.listTrash();
    expect(rows.map((entry) => entry.group.id)).toEqual(['q']);
    expect(rows[0]?.group.tabs.map((tab) => tab.id)).toEqual(['q-t0', 'q-t1']);
    // 行里的寿命字段跟着载荷走，所以两台机器算出的是同一个到期时刻
    expect(rows[0]?.expiresAt).toBe(AT + TRASH_RETENTION_MS);
    expect(await storage.getGroup('q')).toBeUndefined();
  });

  it('本机把那一行彻底删掉 ⇒ 同步之后它不会从对面并回来', async () => {
    await configure();
    await seedSessions(1);
    await softDeleteGroup({ storage }, { groupId: 's0', reason: 'user-delete', at: AT });
    await runSync(deps(), AT + 1000);
    // 远端那一版此刻仍带着这一行（另一台设备还没收到"它被处理掉了"）
    expect((await newestSnapshot()).state.trash).toHaveLength(1);

    await purgeFromTrash({ storage }, { groupId: 's0', at: AT + 2000 });
    await runSync(deps(), AT + 3000);

    expect(await storage.listTrash()).toHaveLength(0);
    const pushed = await newestSnapshot();
    expect(pushed.state.trash).toEqual([]);
    expect(pushed.revision).toBeGreaterThan(1);
    // 两种墓碑都要在：`group` 说"这个会话是删掉的"，`trash` 说"这一行被处理过了"
    expect(pushed.state.tombstones.map((tomb) => tomb.entityType).sort()).toEqual(['group', 'trash']);
  });

  /**
   * 这条**不是**新功能的要求，是把一条既有取舍在本轮改动之后如实照下来：
   * 还原整行会抬高会话的 `updatedAt`，而远端那一版还留着删除时的组墓碑 ⇒
   * 按 既有约定 的"删了又改"交回用户，同步停在 conflict、一个字节都不推。
   *
   * 停在 conflict 是可接受的（用户选"保留"就往下走），**不可接受的是那一行回来**，
   * 所以下面钉的是后两件事。
   */
  it('还原整行之后同步 ⇒ 停在 delete-vs-edit，但那一行不会并回来', async () => {
    await configure();
    await seedSessions(1);
    await softDeleteGroup({ storage }, { groupId: 's0', reason: 'user-delete', at: AT });
    await runSync(deps(), AT + 1000);

    const restored = await restoreFromTrash({ storage }, { groupId: 's0', at: AT + 2000 });
    expect(restored?.tabs).toHaveLength(1);

    const outcome = await runSync(deps(), AT + 3000);
    expect(outcome.status).toBe('conflict');
    expect(outcome.pulled?.conflicts.map((conflict) => conflict.groupId)).toEqual(['s0']);
    // 会话在、回收站空：处理标记已经生效，而停在 conflict 时引擎不推
    expect(await storage.getGroup('s0')).toBeDefined();
    expect(await storage.listTrash()).toHaveLength(0);
    expect(snapshotFiles()).toHaveLength(1);
    expect((await storage.getSyncMeta()).pendingConflicts?.map((item) => item.groupId)).toEqual(['s0']);
  });

  /**
   * ★ 用户 2026-10-05 的投诉逐字复现：「Chrome 的回收站彻底删除标签或者标签组，
   * Edge 的回收站没有同步」。Chrome 与 Edge 是两台设备，删除发生在 A，B 那天什么都没做。
   *
   * 这里刻意**不**直接调 `runSync`，而是照 background 的真实走法：唤醒 ⇒ 问 `dueForSync`
   * ⇒ 只有它说该跑才跑。所以这条测的是"谁来触发拉取"，不是"合并算得对不对"
   * （后者由上面那几条覆盖，它们当时全部是绿的 —— 这正是这条漏网的原因）。
   */
  it('对面删了一个会话并推上去，本机什么都没动 ⇒ 一次唤醒后本机回收站里有那一行', async () => {
    // 设备 A：删掉 s0 并推
    await configure();
    await seedSessions(1);
    await softDeleteGroup({ storage }, { groupId: 's0', reason: 'user-delete', at: AT });
    await runSync(deps(), AT);
    expect(snapshotFiles()).toHaveLength(1);

    // 设备 B：自己有数据、上一次同步是 10 分钟前，之后一次都没动过（所以本地不脏）
    await fakeBrowser.storage.local.clear();
    storage = createStoragePort();
    await storage.heal();
    await storage.putGroup(
      groupFixture('本机自己的会话', [savedTabFixture('b1', 'b1-t0', 0)], { id: 'b1', updatedAt: AT - 90_000 }),
    );
    await configure();
    await storage.setSyncMeta({
      status: 'idle',
      lastPushedRevision: 0,
      consecutiveFailures: 0,
      lastSyncAt: AT - 60_000,
    });

    const meta = await storage.getSyncMeta();
    expect(meta.dirtySinceAt).toBeUndefined();

    // background 的唤醒补刀就这一句判据
    if (dueForSync(meta, AT)) await runSync(deps(), AT);

    expect((await storage.listTrash()).map((entry) => entry.group.id)).toEqual(['s0']);
    // 自己的会话不能被对面的那一版抹掉
    expect(await storage.getGroup('b1')).toBeDefined();
  });

  it('回收站里躺着一坨解析不出来的东西 ⇒ 禁止同步，和本机主存储同一条闸门', async () => {
    const good = { groups: [], categories: [], tombstones: [], trash: [] };
    expect(inspectLocalState(good)).toEqual({ ok: true });

    expect(inspectLocalState({ ...good, trash: 'nope' as never })).toMatchObject({
      ok: false,
      reason: 'trash-not-array',
    });
    expect(inspectLocalState({ ...good, trash: [{} as never] })).toMatchObject({
      ok: false,
      reason: 'trash-entry-group-missing',
    });
    expect(
      inspectLocalState({
        ...good,
        trash: [{ group: { id: 'g9', tabs: 'nope' }, deletedAt: 1, expiresAt: 2, reason: 'user-delete' } as never],
      }),
    ).toMatchObject({ ok: false, reason: 'trash:g9.tabs-not-array' });
  });
});

// ---------------------------------------------------------------------------
// 同步的**唯一入口**。
//
// 这一组测的不是"同步得对不对"（那归上面几组），而是"这一轮到底该不该跑、
// 不该跑的时候有没有真的一个请求都不发"。所以每条的断言都落在 `remote.calls` 上：
// 只看返回值或 `SyncMeta.status` 的话，"skip 了但其实还是飞了一发"这种实现也能全绿。
//
// ⚠ 与 background 那组的分工：那里验"谁敲门、敲门之后走没走到这里"，
//   这里验"走到这里之后判据怎么判"。两边都写同一条断言是浪费，两边都漏就是这次的 bug。
// ---------------------------------------------------------------------------

describe('同步的唯一入口：五类节拍都过同一道判据', () => {
  /** 打到某一类资源的请求数 —— "没跑"的唯一硬证据。 */
  const callsTo = (method: string, part: string): number =>
    remote.calls.filter((call) => call.method === method && call.url.includes(part)).length;

  /** 摆成"该拉了"：把上一次检查时刻与退避都清掉，只留判据本身。 */
  async function makeDue(): Promise<void> {
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({
      ...meta,
      lastSyncAt: undefined,
      nextAttemptAt: undefined,
      dirtySinceAt: undefined,
    });
  }

  it('配置没开 ⇒ 不跑，且一个请求都不发（skip 发生在进引擎之前）', async () => {
    await configure({ enabled: false });
    await storage.setSyncMeta({ status: 'idle', lastPushedRevision: 0, consecutiveFailures: 0 });

    const attempt = await requestSync(deps(), 'heartbeat', AT);

    expect(attempt).toEqual({ ran: false, cause: 'disabled', reason: 'heartbeat' });
    expect(remote.calls).toEqual([]);
    /**
     * 账本历史**保持原样**。这条记的是行为变更：以前"关着也飞一轮"会由 `runSync` 开头
     * 顺手把 status 写成 `disabled`，而 既有约定 之后 skip 在进引擎之前，那句顺手写没了。
     * "关掉同步之后该显示什么"于是改由两处负责：background 的配置 watcher 落账 +
     * SyncPanel 按开关判状态（各有一条用例钉着）。
     */
    expect((await storage.getSyncMeta()).status).toBe('idle');
  });

  it('去抖窗口内又醒一次 ⇒ not-due，不发请求（连续收纳不能被变成连续敲门）', async () => {
    await configure();
    await seedSessions(1);
    await storage.setSyncMeta({
      status: 'pending',
      lastPushedRevision: 0,
      consecutiveFailures: 0,
      dirtySinceAt: AT,
    });

    const early = await requestSync(deps(), 'local-change', AT + 1_000);
    expect(early.ran).toBe(false);
    if (!early.ran) expect(early.cause).toBe('not-due');
    expect(remote.calls).toEqual([]);

    // 正向对照：窗口一过（3 秒）同一个 trigger 就该真的跑
    const later = await requestSync(deps(), 'local-change', AT + SYNC_DEBOUNCE_MS);
    expect(later.ran).toBe(true);
    expect(remote.calls.length).toBeGreaterThan(0);
  });

  it('有冲突等人裁决 ⇒ awaiting-user，自动节拍一轮都不跑', async () => {
    await configure();
    await storage.setSyncMeta({
      status: 'conflict',
      lastPushedRevision: 0,
      consecutiveFailures: 0,
      pendingConflicts: [
        { groupId: 'g1', groupTitle: '会话 g1', deletedAt: 1, editedAt: 2, deletedByDeviceId: 'dev-2', deleteReason: 'user-delete' },
      ],
    });

    const attempt = await requestSync(deps(), 'alarm', AT);

    expect(attempt.ran).toBe(false);
    if (!attempt.ran) expect(attempt.cause).toBe('awaiting-user');
    expect(remote.calls).toEqual([]);
  });

  it('另一处已经认领且没过期 ⇒ in-flight；过期 ⇒ 放行（防"进程被杀、锁没人解"）', async () => {
    await configure();
    await makeDue();
    await storage.setSyncMeta({ ...(await storage.getSyncMeta()), syncClaimedAt: AT });

    const blocked = await requestSync(deps(), 'heartbeat', AT + 10_000);
    expect(blocked.ran).toBe(false);
    if (!blocked.ran) expect(blocked.cause).toBe('in-flight');
    expect(remote.calls).toEqual([]);

    // TTL（60 秒）之后必须自己放行：平台把 worker 杀了、没人还锁，
    // 不放行的话这台机器**永远**不再同步 —— 那是最难发现的一种卡死。
    const expired = await requestSync(deps(), 'heartbeat', AT + SYNC_LOCK_TTL_MS + 1);
    expect(expired.ran).toBe(true);
    expect(remote.calls.length).toBeGreaterThan(0);
  });

  it('同一拍里两次唤醒只跑一轮（本进程那把锁不许留窗口）', async () => {
    await configure();
    await makeDue();

    const [first, second] = await Promise.all([
      requestSync(deps(), 'heartbeat', AT),
      requestSync(deps(), 'alarm', AT),
    ]);

    const ran = [first, second].filter((attempt) => attempt.ran).length;
    expect(ran, '两次唤醒都起飞 ⇒ 占标记之前那扇窗还在').toBe(1);
    const skipped = first.ran ? second : first;
    expect(!skipped.ran ? skipped.cause : 'ran').toBe('in-flight');
  });

  it('跑完把锁还了：下一次唤醒不再被自己挡住', async () => {
    await configure();
    await makeDue();

    const first = await requestSync(deps(), 'heartbeat', AT);
    expect(first.ran).toBe(true);
    expect((await storage.getSyncMeta()).syncClaimedAt, '锁没还 ⇒ 这一台机器从此不再同步').toBeUndefined();

    await makeDue();
    const second = await requestSync(deps(), 'heartbeat', AT + 1);
    expect(second.ran).toBe(true);
  });

  it('见过远端那一版、本地一个字节没改 ⇒ 只看 manifest，不下载整份快照', async () => {
    await configure();
    await seedSessions(2);
    const pushed = await requestSync(deps(), 'manual', AT);
    expect(pushed.ran).toBe(true);
    const meta = await storage.getSyncMeta();
    expect(meta.lastSeenSnapshotId, '推上去之后该记住自己见过哪一版').toBeDefined();
    const before = remote.calls.length;

    await makeDue();
    const again = await requestSync(deps(), 'heartbeat', AT + 120_000);

    expect(again.ran).toBe(true);
    if (again.ran) expect(again.outcome).toEqual({ status: 'idle', skip: 'no-changes' });
    expect(
      callsTo('GET', '/snapshots/'),
      '内容没变还下载整份快照 ⇒ 10k 标签那一档省掉的流量又花回去了',
    ).toBe(0);
    // 但"对面有没有推新东西"一定要问过，否则省流量就变成"同步了个寂寞"（既有约定 那条真机投诉）。
    expect(remote.calls.length).toBeGreaterThan(before);
    /**
     * ★ 既有约定 之后这一问走的是**指针**：一条 GET、几百字节，连原来那次 PROPFIND 都省了。
     * 原来这一行钉的是"发过 PROPFIND" —— 那钉的是手段不是不变量，所以指针一落地它就红了。
     * 现在两条一起钉：指针确实读过（正向对照），目录确实**没**再列（这一轮的收益本身）。
     * 只钉前一条的话，"退回扫目录也照样绿"，那笔流量就悄悄花回去了。
     */
    const since = remote.calls.slice(before);
    expect(
      since.some((call) => call.method === 'GET' && call.url.includes(`/manifests/${POINTER_FILE}`)),
      '省流量那一档要读指针，否则不知道对面推没推',
    ).toBe(true);
    expect(
      since.some((call) => call.method === 'PROPFIND'),
      '读过指针就不必再列目录：多出来的那次 PROPFIND 是这一轮要省掉的',
    ).toBe(false);
    // trigger 落账：界面那句"上一次运行由谁叫醒"读的就是这一格
    expect((await storage.getSyncMeta()).lastTrigger).toBe('heartbeat');
  });

  it('本地又脏了 ⇒ 即使见过那一版也要走完整路径（合并要靠那一整份快照）', async () => {
    await configure();
    await seedSessions(2);
    await requestSync(deps(), 'manual', AT);
    const seen = await storage.getSyncMeta();
    expect(seen.lastSeenSnapshotId).toBeDefined();

    await seedSessions(3); // 多一条会话 = 内容变了
    await storage.setSyncMeta({ ...seen, dirtySinceAt: AT + 10_000 });
    const before = callsTo('GET', '/snapshots/');

    const attempt = await requestSync(deps(), 'local-change', AT + 10_000 + SYNC_DEBOUNCE_MS);

    expect(attempt.ran).toBe(true);
    expect(callsTo('GET', '/snapshots/'), '脏了还不重新读远端 ⇒ 合并是拿旧账算的').toBeGreaterThan(before);
  });
});

/**
 * 记录级 barrier—— 回收站里"这一条被我处理掉了"这个事实要能跨设备传播。
 *
 * 立项的是一条真机反馈：**整行删得掉、单条删不掉，删完下一轮同步自己就回来了**。
 * 根因不在对面那台设备，也不在 UI：`mergeTrash` 记录级取并集，而记录级的动作
 * （逐条彻底删除 / 逐条还原）**什么事实都不留** ⇒ 远端那一版里它还在 ——
 * 而那"远端那一版"往往就是本机自己上一轮推上去的。诊断探针（单设备、三条差分）当时红在
 * P2/P3 上，判据落地成下面这 T1–T8 之后探针就删掉了 —— 这里不是第二套测试系统，是它的位置。
 *
 * ⚠ 这一组里 T1/T2 在实现之前就该红；T3/T4/T7/T8 是**护栏**（现在就该绿，
 * 修完必须仍然绿）。它们钉的是"别为了修复活把并集语义弄丢"——那正是当初否决标记路线的理由。
 */
describe('记录级 barrier：处理掉的事实要能传播', () => {
  const GID = 'g-barrier';
  const at = (offset: number): number => AT + offset;

  const rowOf = async (groupId = GID): Promise<TrashEntry | undefined> =>
    (await storage.listTrash()).find((entry) => entry.group.id === groupId);
  const rowTabs = async (): Promise<string[]> => (await rowOf())?.group.tabs.map((tab) => tab.id) ?? [];

  /** 一行两条记录的会话，软删进回收站。 */
  async function seedTwoRecords(): Promise<void> {
    await storage.putGroup(
      groupFixture('会话 两条', [savedTabFixture(GID, `${GID}-t0`, 0), savedTabFixture(GID, `${GID}-t1`, 1)], {
        id: GID,
        updatedAt: AT,
      }),
    );
    await softDeleteGroup({ storage }, { groupId: GID, reason: 'user-delete', at: AT });
  }

  /** 换到"第二台设备"：清空本机存储重开一次同步（沿用本文件既有做法）。 */
  async function asNewDevice(): Promise<void> {
    await fakeBrowser.storage.local.clear();
    storage = createStoragePort();
    await storage.heal();
    await configure();
  }

  it('T1 彻底删除单条 → 同步 → 它不回来（用户报的那条）', async () => {
    await configure();
    await seedTwoRecords();
    await runSync(deps(), at(1_000));
    expect(await rowTabs()).toEqual([`${GID}-t0`, `${GID}-t1`]);

    await purgeTrashTab({ storage }, { groupId: GID, tabId: `${GID}-t1`, at: at(2_000) });
    expect(await rowTabs(), '本机就没删掉，那是另一回事').toEqual([`${GID}-t0`]);

    await runSync(deps(), at(9_000));

    expect(await rowTabs(), '远端那一版是**我自己**推上去的，不能拿它把自己删掉的复活').toEqual([`${GID}-t0`]);
  });

  it('T2 从回收站还原单条 → 同步 → 会话里有它、回收站里没有（不双份）', async () => {
    await configure();
    await seedTwoRecords();
    await runSync(deps(), at(1_000));

    await restoreTrashTab({ storage }, { groupId: GID, tabId: `${GID}-t1`, at: at(2_000) });
    expect((await storage.getGroup(GID))?.tabs.map((tab) => tab.id)).toEqual([`${GID}-t1`]);

    await runSync(deps(), at(9_000));

    expect(await rowTabs(), '同一条既在会话里、又躺回回收站').toEqual([`${GID}-t0`]);
    expect((await storage.getGroup(GID))?.tabs.map((tab) => tab.id)).toEqual([`${GID}-t1`]);
  });

  /** Case C：barrier 不是"永久删除标记"，更晚的入站必须能穿透它。 */
  it('T3 处理掉之后同一条重新进回收站 → 同步 → 它在（穿透旧 barrier）', async () => {
    await configure();
    await seedTwoRecords();
    await runSync(deps(), at(1_000));
    await purgeTrashTab({ storage }, { groupId: GID, tabId: `${GID}-t1`, at: at(2_000) });
    await runSync(deps(), at(3_000));
    expect(await rowTabs()).toEqual([`${GID}-t0`]);

    // 用户又把它删进回收站一次（同 id、更晚的时刻）
    const held = await rowOf();
    const record = savedTabFixture(GID, `${GID}-t1`, 1);
    await mergeIntoTrash(
      { storage },
      { group: held!.group, tabs: [record], reason: 'user-delete', at: at(5_000) },
    );
    expect(await rowTabs()).toEqual([`${GID}-t0`, `${GID}-t1`]);

    await runSync(deps(), at(6_000));

    expect(await rowTabs(), '旧 barrier 把新的一次入站也压住了 = 静默丢一条可恢复记录').toEqual([
      `${GID}-t0`,
      `${GID}-t1`,
    ]);
  });

  /** Case D：不能因为这次修复丢掉对面在同一行里新增的记录（当初否决标记路线的理由）。 */
  it('T4 对面在同一行里新增了我没见过的一条 → 合并两边各留各的', async () => {
    await configure();
    await seedTwoRecords();
    await runSync(deps(), at(1_000));

    await asNewDevice();
    await runSync(deps(), at(2_000));
    // 这台设备手上多了一条 r2（比如它自己又删进来一条）
    const row = await rowOf();
    await storage.putTrash({
      ...row!,
      group: { ...row!.group, tabs: [...row!.group.tabs, savedTabFixture(GID, `${GID}-t2`, 2)] },
    });
    await runSync(deps(), at(3_000));

    // 回到第一台：它已经彻底删掉了 t1
    await asNewDevice();
    await runSync(deps(), at(4_000));
    await purgeTrashTab({ storage }, { groupId: GID, tabId: `${GID}-t1`, at: at(5_000) });
    await runSync(deps(), at(6_000));

    // 再换回对面那台同步：t1 被 barrier 压住，而 t2 一条不少
    await asNewDevice();
    await runSync(deps(), at(7_000));

    expect(await rowTabs(), '并集语义被修丢了：对面新增的那一条或本机剩下的那一条不见了').toEqual([
      `${GID}-t0`,
      `${GID}-t2`,
    ]);
  });

  /**
   * 逐条**还原**到空。这条和"逐条彻底删除到空"不是一回事，而且它才是漏的那个：
   * 彻底删除到空时 `purgeTrashTab` 会写整行的 `'trash'` 标记（既有约定 定的"这一行被处理掉了"），
   * 整行本来就压得住；还原到空**刻意不写**那个标记（还原不是删除，写标记等于让对面把整行再删一遍），
   * 于是那一行会整条并回来 —— 而它里面的记录已经在会话里了。修法是留一条"零可见记录"的壳行替屏障记账。
   */
  it('T5 逐条还原到空之后，那一行不会整条复活（壳行替屏障记账）', async () => {
    await configure();
    await seedTwoRecords();
    await runSync(deps(), at(1_000));

    await restoreTrashTab({ storage }, { groupId: GID, tabId: `${GID}-t0`, at: at(2_000) });
    await restoreTrashTab({ storage }, { groupId: GID, tabId: `${GID}-t1`, at: at(2_500) });
    expect((await rowOf())?.group.tabs ?? [], '还原到空时可见记录该清零').toHaveLength(0);
    expect((await storage.getGroup(GID))?.tabs.map((tab) => tab.id).sort()).toEqual([
      `${GID}-t0`,
      `${GID}-t1`,
    ]);

    await runSync(deps(), at(9_000));

    const row = await rowOf();
    expect(row?.group.tabs ?? [], '整行被并回来了（屏障随行一起消失了）').toHaveLength(0);
    expect(
      (await storage.getGroup(GID))?.tabs.map((tab) => tab.id).sort(),
      '两条都在会话里、同时又回到回收站',
    ).toEqual([`${GID}-t0`, `${GID}-t1`]);
  });

  it('T6 老数据（只有 recordReasons、没有 records）读时兜底：一条不丢、也不误压', async () => {
    await configure();
    await seedTwoRecords();
    const legacy = (await rowOf())!;
    // 手工退回"上一个版本写出来的形状"
    delete (legacy as { records?: unknown }).records;
    legacy.recordReasons = { [`${GID}-t0`]: 'user-delete', [`${GID}-t1`]: 'user-delete' };
    await storage.putTrash(legacy);
    await runSync(deps(), at(1_000));

    const row = await rowOf();
    expect(row?.group.tabs.map((tab) => tab.id), '老形状的行被 barrier 逻辑吃掉了').toHaveLength(2);
    expect(recordReason(row!, `${GID}-t1`)).toBe('user-delete');
  });

  it('T7 连跑三轮：barrier 不膨胀、不产生新快照（幂等）', async () => {
    await configure();
    await seedTwoRecords();
    await runSync(deps(), at(1_000));
    await purgeTrashTab({ storage }, { groupId: GID, tabId: `${GID}-t1`, at: at(2_000) });
    await runSync(deps(), at(3_000));

    const afterFirst = snapshotFiles().length;
    const ledger = Object.keys((await rowOf())?.records ?? {}).length;

    await runSync(deps(), at(4_000));
    await runSync(deps(), at(5_000));

    expect(snapshotFiles(), '重复同步在不可变历史里堆了新版本').toHaveLength(afterFirst);
    expect(Object.keys((await rowOf())?.records ?? {}), 'ledger 每轮长一条').toHaveLength(ledger);
    expect(await rowTabs()).toEqual([`${GID}-t0`]);
  });

  /** 走 `requestSync` 而不是 `runSync`：文档第十六节点名要覆盖这条链。 */
  it('T8 自动节拍走完整链：本机删除 → 标脏 → requestSync → 对面自动同步 → 不复活', async () => {
    await configure();
    await seedTwoRecords();
    await requestSync(deps(), 'local-change', at(1_000));

    await asNewDevice();
    await requestSync(deps(), 'alarm', at(2_000));
    expect(await rowTabs()).toEqual([`${GID}-t0`, `${GID}-t1`]);

    // 回到第一台删掉一条，再让第二台自动拉一次
    await asNewDevice();
    await requestSync(deps(), 'heartbeat', at(3_000));
    await purgeTrashTab({ storage }, { groupId: GID, tabId: `${GID}-t1`, at: at(4_000) });
    /**
     * 必须显式标脏。既有约定 之后 manual 也过判据，而在这套引擎用例里"改了数据"这件事
     * 只有 background 的 watcher 会登记 —— 直接调 `requestSync` 的话，它会因为
     * "距上次同步不到 60 秒"被判 `not-due`，凭证留在本机没推出去，
     * 下一条断言就红成"合并写错了"。（我第一次读这条红就被它骗过一次，判据找错了方向。）
     */
    await markDirty(deps(), at(4_000));
    const pushed = await requestSync(deps(), 'local-change', at(7_000));
    expect(pushed.ran, '这一轮根本没跑，凭证还留在本机').toBe(true);

    await asNewDevice();
    await requestSync(deps(), 'alarm', at(9_000));

    expect(await rowTabs(), '真机那台不动的设备仍会把它拉回来').toEqual([`${GID}-t0`]);
  });
});

/**
 * 真机反馈（Edge，2026-10-06）：Chrome 导入大库并同步上去之后，在 Edge 点同步，
 * 得到「检测到异常变化：本机的标签组比服务器少得多，所以什么都没上传」——
 * **Edge 那台拿不到云端的数据**。
 *
 * 这条判据要防的是"把一次本地塌陷推上云端、把云端也删掉"（既有约定 整套设计立项的理由），
 * 它针对的方向是**推**。而合并语义是并集：本机少并不会让云端少，
 * 恰恰是"该把云端拉下来"的那一档。所以停在闸前 = 把安全的方向也一起拦了。
 */
describe('安全闸不许拦住"把云端拉下来"这个方向', () => {
  it('本机 2 条、云端 30 条 ⇒ 云端那 30 条要落到本机（而不是停在 suspicious 什么都不做）', async () => {
    // 设备 A：把 30 条推上云端
    await configure();
    await seedSessions(30);
    await runSync(deps(), AT);
    expect(snapshotFiles().length, '前置：云端确实已经有快照了').toBeGreaterThan(0);

    // 设备 B：一台几乎空的新机器（对应 Edge 截图里那句"最后同步 从未"）
    await fakeBrowser.storage.local.clear();
    storage = createStoragePort();
    await storage.heal();
    await configure();
    await seedSessions(2);

    const outcome = await runSync(deps(), AT + 5_000);

    expect(outcome.status, '本机比云端少得多 ⇒ 今天会停在 suspicious_change，什么都不拉').not.toBe('suspicious_change');
    expect((await storage.listGroupIndex()).length, '云端那 30 条要合并进本机').toBe(30);
  });
});

/**
 * 同步事件日志的接线。
 *
 * 这一节真正值钱的是**两条否定**：`no-changes` 与 `backoff` 一条都不写。
 * 页面开着时心跳 60 秒一轮、空闲也跑"查了没变化"，全记的话环 100 在 ≈100 分钟里被填满，
 * 真事件被挤出去 —— 那是把这份日志的价值反过来弄没。每条否定都配了正向对照
 * （同一套夹具里换一种结果，事件确实多了一条），否则"端口压根没写成功"也能绿。
 */
describe('同步事件日志：一次 runSync 一条主事件', () => {
  const events = () => storage.listSyncEvents();

  it('推送成功 ⇒ 一条 push、success true、summary 是 R<revision>、trigger 是叫醒它的那个', async () => {
    await configure();
    await seedSessions(1);
    await runSync(deps(), AT, 'alarm');

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'push',
      success: true,
      trigger: 'alarm',
      summary: 'R1',
      at: AT,
    });
    expect(rows[0]?.id).toBeTruthy();
  });

  /**
   * 合并过就并进**同一条** summary（`R3 · merged:1`），而不是另记一条 merge：
   * kind 由最终出口定，一次同步记两条就是噪声（方案 §6.1 与 既有约定 同一条口径）。
   */
  it('合并之后推送 ⇒ 每轮一条，第二条把合并条数并进 summary', async () => {
    await configure();
    await seedSessions(2);
    await runSync(deps(), AT);
    expect(await events()).toHaveLength(1);

    const mineUrl = snapshotFiles()[0] as string;
    const otherId = 'other-log';
    const otherState: StoredState = {
      groups: [
        ...(await remoteSnapshot(remote.files, mineUrl)).state.groups,
        groupFixture('别的设备加的', [savedTabFixture('w', 'w-t0', 0)], { id: 'w', sortOrder: 99, updatedAt: AT + 3000 }),
      ],
      categories: [],
      tombstones: [],
      trash: [],
    };
    remote.files.set(
      otherSnapshotUrl(otherId),
      JSON.stringify({
        format: 'shitab-snapshot',
        version: 1,
        snapshotId: otherId,
        deviceId: 'device-other',
        revision: 2,
        createdAt: AT + 3000,
        stateChecksum: await checksumOfState(otherState),
        state: otherState,
      }),
    );
    plantOtherPointer(otherId);

    const outcome = await runSync(deps(), AT + 4000, 'heartbeat');
    expect(outcome.pushed?.revision, '前置：这一轮推的是合并后的第 3 版').toBe(3);

    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'push',
      success: true,
      trigger: 'heartbeat',
      summary: 'R3 · merged:1',
    });
  });

  /**
   * 拉到了东西、合并结果恰好与云端同形 ⇒ 没有可推的，但本机**已经变了** ⇒ 记一条 pull。
   * 这一条是"空转不写"的对照面：同样是 `skip: 'no-changes'` 那个出口，合过并与没合过是两件事。
   *
   * ⚠ 夹具是手摆的一份远端快照，而不是"第二台设备清空本机再同步一次"：后者推上去的
   *   那一版里 `trash` 是空数组，而老快照可能压根没这个键 —— 两个 checksum 不同（文件里
   *   第 196 行记过的已知毛病），于是那一轮走的是**推送**而不是拉取，测不到这条出口。
   */
  it('本机收下了云端的一版（没有推送）⇒ 一条 pull、summary merged:<n>', async () => {
    await configure();
    const otherState: StoredState = {
      groups: [groupFixture('云端的一条', [savedTabFixture('c', 'c-t0', 0)], { id: 'c', updatedAt: AT + 1000 })],
      categories: [],
      tombstones: [],
      trash: [],
    };
    const otherId = 'pull-only';
    remote.files.set(
      otherSnapshotUrl(otherId),
      JSON.stringify({
        format: 'shitab-snapshot',
        version: 1,
        snapshotId: otherId,
        deviceId: 'device-other',
        revision: 2,
        createdAt: AT + 1000,
        stateChecksum: await checksumOfState(otherState),
        state: otherState,
      }),
    );
    plantOtherPointer(otherId);

    const outcome = await runSync(deps(), AT + 5000, 'startup');
    expect(outcome.skip, '前置：这一轮确实没推任何东西').toBe('no-changes');
    expect(outcome.pushed).toBeUndefined();

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'pull', success: true, trigger: 'startup', summary: 'merged:1' });
    // 正向对照：会话真的回到本机了，否则这条 pull 记的是一次没发生的拉取
    expect((await storage.listGroupIndex()).map((entry) => entry.id)).toEqual(['c']);
  });

  it('停在冲突 ⇒ 一条 conflict、success false、summary conflicts:<n>', async () => {
    const outcome = await reachConflict();
    expect(outcome.status).toBe('conflict');

    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('push');
    expect(rows[1]).toMatchObject({ kind: 'conflict', success: false, summary: 'conflicts:1' });
  });

  it('停在塌陷闸 ⇒ 一条 suspicious、summary suspicious', async () => {
    await configure();
    await seedSessions(25);
    await runSync(deps(), AT);
    for (const id of Array.from({ length: 25 }, (_, index) => `s${index}`)) {
      await softDeleteGroup({ storage }, { groupId: id, reason: 'user-delete', at: AT + 900 });
    }

    const outcome = await runSync(deps(), AT + 1000);
    expect(outcome.status).toBe('suspicious_change');
    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'suspicious', success: false, summary: 'suspicious' });
  });

  it('上传被 503 拒 ⇒ 一条 error、summary err:server（判别值，不是译文）', async () => {
    await configure();
    await seedSessions(1);
    remote.nextFault({ status: 503, method: 'PUT' });

    const outcome = await runSync(deps(), AT);
    expect(outcome.status).toBe('error');
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'error', success: false, summary: 'err:server' });
  });

  it('地址坏了与没密码各记一条 error：err:bad-url 与 err:no-credential', async () => {
    await storage.setWebDavConfig({ enabled: true, baseUrl: 'not a url', username: 'u', allowInsecureHttp: false });
    expect((await runSync(deps(), AT)).skip).toBe('bad-base-url');
    await storage.setWebDavConfig({ enabled: true, baseUrl: BASE, username: 'u', allowInsecureHttp: false });
    expect((await runSync(deps(), AT + 1000)).skip).toBe('no-credential');

    const rows = await events();
    expect(rows.map((event) => event.summary)).toEqual(['err:bad-url', 'err:no-credential']);
    expect(rows.every((event) => event.kind === 'error' && event.success === false)).toBe(true);
  });

  /**
   * 本地状态损坏走 error + `err:invalid-local:<原因>`，**不立第六个 kind**。
   * 这里直接喂一份"形状解析不了"的读取结果给引擎：靠写坏存储来触发，测到的是 heal 不是这道闸。
   */
  it('本地状态坏了 ⇒ error + err:invalid-local:<原因>', async () => {
    await configure();
    const broken = {
      ...storage,
      listAllGroups: async () => [{ id: 'g1', title: '没有 tabs 的一条' }] as never,
    } as unknown as StoragePort;

    const outcome = await runSync({ storage: broken, webdav: remote }, AT);
    expect(outcome.blocked?.reason).toBe('group:g1.tabs-not-array');
    expect(remote.calls, '规则 C/D：一个请求都不该发').toEqual([]);

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'error', success: false, summary: 'err:invalid-local:group:g1.tabs-not-array' });
  });

  /** ★ 第一条否定：查了没变化 ⇒ **一条都不写**。 */
  it('no-changes 那一轮一条都不写，而同一套夹具里真变了的那一轮写', async () => {
    await configure();
    await seedSessions(1);
    await runSync(deps(), AT);
    expect(await events()).toHaveLength(1);

    // 什么都没改，再来一轮：走的是"指针说还是那一版"那条早退
    const idle = await runSync(deps(), AT + 60_000, 'heartbeat');
    expect(idle.skip, '前置：这一轮确实空转').toBe('no-changes');
    expect(await events(), '空转不许往环里塞东西').toHaveLength(1);

    // 正向对照：写日志那条线还是活的 —— 本机真变了一次就多一条
    await storage.putGroup(
      groupFixture('会话 z', [savedTabFixture('z', 'z-t0', 0)], { id: 'z', sortOrder: 9, updatedAt: AT + 70_000 }),
    );
    await runSync(deps(), AT + 80_000, 'local-change');
    const rows = await events();
    expect(rows).toHaveLength(2);
    /**
     * `merged:0` 留着不是啰嗦：这一轮**确实跑了合并**，只是从对面收下 0 条（本机是超集）。
     * 把 0 藏起来的话，"合过并但没拿东西"与"压根没合过"在日志里就长得一样了 —— 前者是有事实的。
     */
    expect(rows[1]).toMatchObject({ kind: 'push', summary: 'R2 · merged:0' });
  });

  /** ★ 第二条否定：退避中一条都不写。 */
  it('backoff 那一轮一条都不写，而退避过了的那一轮写', async () => {
    await configure();
    await seedSessions(1);
    remote.nextFault({ status: 503, method: 'PUT' });
    await runSync(deps(), AT);
    expect(await events()).toHaveLength(1);

    const waiting = await runSync(deps(), AT + 1000);
    expect(waiting.skip, '前置：这一轮还在退避窗口里').toBe('backoff');
    expect(await events(), '退避中的每一拍都不该记账').toHaveLength(1);

    // 正向对照：退避窗口过了之后同一套夹具照样记一条
    await runSync(deps(), AT + 60_000);
    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.kind).toBe('push');
  });

  /** 同步没开着，不是引擎的事件 —— 但开着之后同一套夹具要真的记。 */
  it('disabled 一条都不写', async () => {
    await storage.setWebDavConfig({ enabled: false, baseUrl: BASE, username: 'u', allowInsecureHttp: false });
    expect((await runSync(deps(), AT)).skip).toBe('disabled');
    expect(await events()).toHaveLength(0);

    await configure();
    await seedSessions(1);
    await runSync(deps(), AT + 1000);
    expect(await events()).toHaveLength(1);
  });

  /**
   * 日志只记录、不进判据：环里预先塞满一坨"看起来像失败"的记录，同步该成的照样成 ——
   * 引擎读都不读它。
   */
  it('事件不进任何判据：预先塞满 100 条也不改变这一轮的结论', async () => {
    await configure();
    for (let index = 0; index < 100; index += 1) {
      await storage.appendSyncEvent({ kind: 'error', success: false, summary: 'err:network' }, AT + index);
    }
    expect(await events()).toHaveLength(100);

    await seedSessions(1);
    const outcome = await runSync(deps(), AT + 200);
    expect(outcome.status).toBe('idle');
    expect(outcome.pushed?.revision).toBe(1);
    const rows = await events();
    expect(rows).toHaveLength(100);
    expect(rows[99]).toMatchObject({ kind: 'push', summary: 'R1' });
  });
});

// ---------------------------------------------------------------------------
// ★ 远端保留窗口：最近 100 版，超出的**直接删**。
//
// 这一格改的是 既有约定 §18 原来那句「默认永不自动删」。那条防的是"普通同步顺手删历史"，
// 现在仍然成立 —— 删除能力只在 `WebDavAdminPort` 上，而同步引擎**不注入 admin 就连账本都不裁**
// （只裁不删会制造界面看不见、手动清理也扫不到的隐形垃圾，是唯一一种两边不讨好的组合）。
// ---------------------------------------------------------------------------

describe('保留窗口：账本与文件一起收', () => {
  /** 推 N 版，每版内容都比上一版多一条会话 ⇒ 每版都是新文件，去重吞不掉。 */
  async function pushRounds(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      const id = `r${index}`;
      await storage.putGroup(
        groupFixture(`会话 ${id}`, [savedTabFixture(id, `${id}-t0`, 0)], { id, sortOrder: index, updatedAt: AT + index * 1000 }),
      );
      const outcome = await runSync({ storage, webdav: remote, admin: remote }, AT + index * 1000);
      if (outcome.status !== 'idle') throw new Error(`setup：第 ${index} 轮没推出去（${outcome.status}）`);
    }
  }

  it('推 105 版 ⇒ 账本 100 条，快照与 revision manifest 都只剩 100 个文件', async () => {
    await configure();
    await pushRounds(105);

    const newest = manifestFiles().length;
    expect(snapshotFiles(), '窗口之外的那 5 版文件必须被删掉').toHaveLength(100);
    expect(newest, 'manifest 也要跟着删：`manifests/` 撑过 750 条会让指针丢失后的重建不可信').toBe(100);
    expect(pointerFiles()).toHaveLength(1);

    const held = await fetchManifest(deps(), REMOTE_BASE.url, 105, FAKE_CREDENTIAL);
    expect(held?.history).toHaveLength(100);
    expect(held?.history.map((entry) => entry.revision)).toEqual(
      Array.from({ length: 100 }, (_, index) => 105 - index),
    );
    // 正向对照：被删的是最旧那 5 版，最新那一版（指针指向的）还在
    expect(snapshotFiles()).toContain(snapshotUrl(REMOTE_BASE.url, held?.latestSnapshotId ?? '').href);
  }, 120_000);

  /**
   * 不注入 admin 的调用方：**连账本都不裁**。
   *
   * 这条要越过窗口才测得到（3 轮时裁与不裁看不出差别），所以这里真推 101 轮。
   * 只裁不删是唯一一种会制造隐形垃圾的组合：文件还在盘上、账本已经忘了它，
   * 于是界面看不见、手动清理也扫不到，从此再没人记得。
   */
  it('没有 admin ⇒ 一次删除都不发，账本也不裁（不制造隐形垃圾）', async () => {
    await configure();
    for (let index = 0; index < 101; index += 1) {
      const id = `q${index}`;
      await storage.putGroup(
        groupFixture(`会话 ${id}`, [savedTabFixture(id, `${id}-t0`, 0)], { id, sortOrder: index, updatedAt: AT + index * 1000 }),
      );
      await runSync(deps(), AT + index * 1000);
    }

    expect(remote.calls.filter((call) => call.method === 'DELETE'), '这条线一次删除都不该发').toHaveLength(0);
    expect(snapshotFiles(), '文件全在').toHaveLength(101);
    const held = await fetchManifest(deps(), REMOTE_BASE.url, 101, FAKE_CREDENTIAL);
    expect(held?.history, '账本不许先于删除收窄').toHaveLength(101);
  }, 120_000);

  /**
   * 删失败（配额、5xx、403）不能把那一版变成隐形垃圾：留在账本里，下一轮再试。
   * 这一刻账本会比窗口宽一条 —— 那是**有意的**，下一轮删成就自己收回去。
   */
  it('删除失败的那一条留在账本里，下一轮删成 ⇒ 不留隐形文件', async () => {
    await configure();
    await pushRounds(101);
    // 第 102 版：让这一轮的 DELETE 全部失败
    await storage.putGroup(
      groupFixture('会话 r101', [savedTabFixture('r101', 'r101-t0', 0)], { id: 'r101', sortOrder: 101, updatedAt: AT + 101_000 }),
    );
    remote.nextFault({ status: 503, method: 'DELETE' });
    const failed = await runSync({ storage, webdav: remote, admin: remote }, AT + 101_000);
    expect(failed.status, '删不掉不能把这次同步弄成失败：推送已经成了，数据是安全的').toBe('idle');

    const held = await fetchManifest(deps(), REMOTE_BASE.url, 102, FAKE_CREDENTIAL);
    expect(held?.history, '账本比窗口多一条：那条文件还在盘上').toHaveLength(101);
    expect(snapshotFiles()).toHaveLength(101);

    // 下一轮：没有故障了，该删成就删成
    await storage.putGroup(
      groupFixture('会话 r102', [savedTabFixture('r102', 'r102-t0', 0)], { id: 'r102', sortOrder: 102, updatedAt: AT + 102_000 }),
    );
    await runSync({ storage, webdav: remote, admin: remote }, AT + 102_000);
    expect(snapshotFiles(), '上一轮欠的那一条这一轮补删').toHaveLength(100);
    const after = await fetchManifest(deps(), REMOTE_BASE.url, 103, FAKE_CREDENTIAL);
    expect(after?.history).toHaveLength(100);
  }, 120_000);

  /**
   * ★ 每轮删除的上限（`REMOTE_RETENTION_MAX_DELETES`）。
   *
   * 保留策略是**推送顺手做**的，所以一次裁太狠就是当场把配额吃掉：坚果云免费档 600 请求 / 30 分钟，
   * 而删除排在推送之后 —— 配额见底的后果是下一轮节拍整轮失败。攒过 100 版的存量远端
   * （改动之前那版扩展推出来的，或者用户换新基数重来过的那种）第一次推送会一次滚出几十条，
   * 这一格就是给它上的保险。
   *
   * 上限 20 只有在窗口 100 之外才有意义，所以这一条必须用真常量、真推过去：
   * 前 121 轮**不带 admin**（既不裁也不删），就是把"改动之前的远端"摆出来。
   */
  it('存量 121 版 ⇒ 第一次带 admin 的推送只删最旧的 20 条，剩下的几轮自己收回去', async () => {
    await configure();
    await pushRoundsWithoutAdmin(121);
    expect(snapshotFiles(), 'setup：不带 admin 的那 121 轮一个文件都没少').toHaveLength(121);

    const before = deleteCalls().length;
    await storage.putGroup(
      groupFixture('会话 b121', [savedTabFixture('b121', 'b121-t0', 0)], { id: 'b121', sortOrder: 121, updatedAt: AT + 121_000 }),
    );
    await runSync({ storage, webdav: remote, admin: remote }, AT + 121_000);

    // 22 条滚出窗口，上限 20 ⇒ 40 个 DELETE 而不是 44（每版两笔：快照 + 那一版的 revision manifest）
    const deleted = deleteCalls().slice(before);
    expect(deleted).toHaveLength(40);
    const held = await fetchManifest(deps(), REMOTE_BASE.url, 122, FAKE_CREDENTIAL);
    expect(held?.history.map((entry) => entry.revision)).toEqual([
      // 窗口内那 100 条（122 → 23）+ 欠下的两条，整条账本仍然**从新到旧**
      ...Array.from({ length: 100 }, (_, index) => 122 - index),
      22,
      21,
    ]);
    expect(snapshotFiles()).toHaveLength(102);
    // 正向对照：账本变宽不是因为"窗口外一条都没删"—— 真删了 20 个文件，且删的是最旧那 20 版
    expect(deleted.filter((call) => call.url.includes('/snapshots/'))).toHaveLength(20);
    expect(manifestFiles()).toHaveLength(102);

    // 下一轮：欠的两条补删，再加这一轮自己滚出的一条 ⇒ 6 个 DELETE，账本收回 100
    const beforeSecond = deleteCalls().length;
    await storage.putGroup(
      groupFixture('会话 b122', [savedTabFixture('b122', 'b122-t0', 0)], { id: 'b122', sortOrder: 122, updatedAt: AT + 122_000 }),
    );
    await runSync({ storage, webdav: remote, admin: remote }, AT + 122_000);
    expect(deleteCalls().slice(beforeSecond)).toHaveLength(6);
    const drained = await fetchManifest(deps(), REMOTE_BASE.url, 123, FAKE_CREDENTIAL);
    expect(drained?.history.map((entry) => entry.revision)).toEqual(
      Array.from({ length: 100 }, (_, index) => 123 - index),
    );
    expect(snapshotFiles(), '溢出是自己收回来的，不会长期比窗口宽').toHaveLength(100);
  }, 180_000);
});

/** 推 N 轮而**不注入 admin**：这一支就是"改动之前那版扩展"留下来的远端。 */
async function pushRoundsWithoutAdmin(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = `b${index}`;
    await storage.putGroup(
      groupFixture(`会话 ${id}`, [savedTabFixture(id, `${id}-t0`, 0)], { id, sortOrder: index, updatedAt: AT + index * 1000 }),
    );
    const outcome = await runSync(deps(), AT + index * 1000);
    if (outcome.status !== 'idle') throw new Error(`setup：不带 admin 的第 ${index} 轮没推出去（${outcome.status}）`);
  }
}

const deleteCalls = (): Array<{ method: string; url: string }> =>
  remote.calls.filter((call) => call.method === 'DELETE');

/** `pickRolledOff` 的三条判据用小窗口测：常量是 100，为一格排除条件推 105 版既慢又难读。 */
describe('pickRolledOff：窗口外 + 没人指着的文件才删', () => {
  const entry = (revision: number, snapshotId: string): ManifestEntry => ({
    snapshotId,
    revision,
    deviceId: 'dev',
    createdAt: AT + revision,
    stateChecksum: `${snapshotId}checksum`,
  });

  it('窗口内的不选、窗口外的选', () => {
    const ledger = [entry(4, 'dddd'), entry(3, 'cccc'), entry(2, 'bbbb'), entry(1, 'aaaa')];
    expect(pickRolledOff(ledger, 2).map((item) => item.revision)).toEqual([2, 1]);
  });

  /**
   * ★ 内容寻址那一格：同一个 `state` 在两个 revision 上留两条账，指的是**同一个文件**。
   * 旧那条滚出窗口时不许删 —— 否则窗口里还活着的那一版会被连根拔掉，
   * 表现是"列出来的那一版点恢复说文件不存在"。
   */
  it('同一个 snapshotId 在窗口内还有一条 ⇒ 不选', () => {
    const ledger = [entry(4, 'same'), entry(3, 'other'), entry(2, 'same'), entry(1, 'oldest')];
    const picked = pickRolledOff(ledger, 2).map((item) => item.revision);
    expect(picked, 'revision 2 与窗口内的 revision 4 是同一个文件').not.toContain(2);
    // 正向对照：不是"窗口外的一律不选"造成的假绿
    expect(picked).toContain(1);
  });
});

/**
 * 上限**之内**的取舍用小名单测：`20` 这个数字只有在窗口 100 之外才现得出形，
 * 上面那条存量用例钉的是真常量下"一次 40 个 DELETE"，它钉不动"这一批里谁留下、谁交回账本"。
 * 两个方向各钉一次，合起来才是这一格（同一批判据有两种进入方式，见 既有约定 的验证那节）。
 */
describe('pruneRolledOff：一轮最多删几条、谁交回账本', () => {
  const idOf = (revision: number): string => `snap${revision}`;
  const entryOf = (revision: number): ManifestEntry => ({
    snapshotId: idOf(revision),
    revision,
    deviceId: 'dev',
    createdAt: AT + revision,
    stateChecksum: `${idOf(revision)}checksum`,
  });
  /** 5 版滚出保留窗口：账本新在前 ⇒ revision 5 最新、1 最旧。 */
  const ROLLED_OFF = [5, 4, 3, 2, 1].map(entryOf);
  const snapshotUrlOf = (revision: number): string => snapshotUrl(REMOTE_BASE.url, idOf(revision)).href;
  const manifestOf = (revision: number): string => manifestUrl(REMOTE_BASE.url, revision).href;

  /**
   * 两个文件都得摆上：`remove` 对"本来就没有的文件"是**幂等成功**，
   * 空着手测会把"一次都没删"读成"全删干净了" —— 那种断言恒绿。
   */
  function plantBacklog(): void {
    for (const item of ROLLED_OFF) {
      remote.files.set(snapshotUrlOf(item.revision), '{"state":"旧的一版"}');
      remote.files.set(manifestOf(item.revision), '{"format":"shitab-manifest","version":1}');
    }
  }

  const run = (maxDeletes: number): Promise<ManifestEntry[]> =>
    pruneRolledOff({ storage, webdav: remote, admin: remote }, REMOTE_BASE.url, FAKE_CREDENTIAL, ROLLED_OFF, maxDeletes);
  /** 比的是**哪几条**文件没了，不是这一批内部谁先发出去（那不重要）。 */
  const removed = (): number[] =>
    ROLLED_OFF.map((item) => item.revision)
      .filter((revision) => !remote.files.has(snapshotUrlOf(revision)))
      .sort((a, b) => a - b);

  it('上限 2 ⇒ 只动最旧的两条，靠近窗口那三条一个字节都不碰', async () => {
    plantBacklog();
    const survivors = await run(2);

    // 方向也在这里：取成"最新两条"的话这一行会拿到 [4, 5]
    expect(removed()).toEqual([1, 2]);
    expect(remote.files.has(snapshotUrlOf(3)), '没轮到的那条必须还在盘上').toBe(true);
    expect(survivors.map((item) => item.revision)).toEqual([5, 4, 3]);
  });

  /**
   * ★ 交回的名单要**从新到旧**：账本是靠位置切窗口的（`kept = ledger.slice(0, limit)`），
   * 顺序一乱，下一轮被裁掉的那 100 条里就会混进较新的、而最旧的反而留下。
   */
  it('删失败的那一条排在延后那几条后面，它的 revision manifest 也不许删', async () => {
    plantBacklog();
    remote.nextFault({ status: 500, method: 'DELETE', url: snapshotUrlOf(1) });
    const survivors = await run(2);

    expect(removed()).toEqual([2]);
    expect(survivors.map((item) => item.revision)).toEqual([5, 4, 3, 1]);
    expect(remote.files.has(manifestOf(1)), '快照没删成就别动那一版的 manifest：账本还指着这一版').toBe(true);
    // 正向对照：同一批里另一条两笔都删成了 ⇒ 上面那条不是"整批都没发出去"
    expect(remote.files.has(manifestOf(2))).toBe(false);
  });

  it('上限比名单还宽 ⇒ 全删完、交回空名单（欠条是延后造成的，不是这一格）', async () => {
    plantBacklog();
    expect(await run(20)).toEqual([]);
    expect(removed()).toEqual([1, 2, 3, 4, 5]);
    expect(manifestFiles(), '每一版都是快照 + manifest 两笔一起删').toHaveLength(0);
  });
});
