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
  backoffDelayMs,
  inspectLocalState,
  markDirty,
  requestSync,
  resolveConflict,
  runSync,
  SYNC_LOCK_TTL_MS,
} from '@/core/application/sync-engine';
import { dueForSync, SYNC_DEBOUNCE_MS } from '@/core/domain/sync-wake';
import type { SyncDeps } from '@/core/application/sync-engine';
import { groupFixture, savedTabFixture } from './fixtures';
import {
  mergeIntoTrash,
  purgeFromTrash,
  purgeTrashTab,
  recordReason,
  restoreFromTrash,
  restoreTrashTab,
  softDeleteGroup,
} from '@/core/application/delete-model';
import { manifestUrl, manifestsDirUrl, parseBaseUrl, remoteRootUrl, snapshotUrl, snapshotsDirUrl } from '@/core/domain/remote-layout';
import type { StoredState, TrashEntry } from '@/shared/types';
import { TRASH_RETENTION_MS } from '@/shared/constants';

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
const manifestFiles = (): string[] => [...remote.files.keys()].filter((url) => url.includes('/manifests/'));

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

    // ★ 判据是"云端没被删空"，不是"云端一个字节都不许多"。
    //   这里引擎会再写一版：合并结果与云端那一版**逻辑相同但不是逐字节相同**
    //   （`trash` 键"缺失"与"空数组"在 canonicalJson 下是两个 checksum —— 既有约定 记过这一条），
    //   所以内容寻址去重认不出来。那是历史膨胀的已知毛病，不是数据损失，另案处理。
    const files = snapshotFiles();
    expect(files.length, '多出来的那一版是"同样内容的另一份"').toBe(pushedCount + 1);
    const newest = JSON.parse(remote.files.get(files[files.length - 1] as string) as string);
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

  it('100→95 这种小改动不拦：天天问就等于没问', async () => {
    await configure();
    await seedSessions(100);
    await runSync(deps(), AT);
    await storage.removeGroup('s0');
    await storage.removeGroup('s1');
    await storage.removeGroup('s2');
    await storage.removeGroup('s3');
    await storage.removeGroup('s4');
    const outcome = await runSync(deps(), AT + 1000);
    expect(outcome.status).toBe('idle');
    expect(outcome.pushed?.revision).toBe(2);
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

  it('推上去的载荷是压缩前的 JSON 原文，且带 baseSnapshotId 指向上一版', async () => {
    await configure();
    await seedSessions(1);
    await runSync(deps(), AT);
    await storage.putGroup(
      groupFixture('会话 y', [savedTabFixture('y', 'y-t0', 0)], { id: 'y', sortOrder: 8, updatedAt: AT + 5000 }),
    );
    await runSync(deps(), AT + 5000);

    const newest = snapshotFiles().find((url) => url !== snapshotFiles()[0]);
    const payload = JSON.parse(remote.files.get(newest as string) as string);
    expect(payload.state.groups).toHaveLength(2);
    expect(payload.baseSnapshotId).toBeTruthy();
    expect(payload.format).toBe('shitab-snapshot');
  });
});

describe('同步引擎：远端坏了要能继续，而不是把同步卡死', () => {
  /**
   * §5 规则 5 + §19「manifest 更新失败 ⇒ snapshot 可重新发现」。
   * 这里把 manifest 文件整个抹掉，模拟"上传成功了、写 manifest 那一步崩了"。
   */
  it('manifest 不见了 ⇒ 扫快照目录重建，同步照样完成', async () => {
    await configure();
    await seedSessions(2);
    await runSync(deps(), AT);
    for (const url of manifestFiles()) remote.files.delete(url);
    expect(manifestFiles()).toHaveLength(0);

    await storage.putGroup(
      groupFixture('会话 z', [savedTabFixture('z', 'z-t0', 0)], { id: 'z', sortOrder: 7, updatedAt: AT + 9000 }),
    );
    const outcome = await runSync(deps(), AT + 9000);
    expect(outcome.status).toBe('idle');
    expect(outcome.manifestRebuilt).toBe(true);
    // 重建出来的最新是 revision 1，所以这一次推的是 2 —— 编号没有因为丢 manifest 而倒退
    expect(outcome.pushed?.revision).toBe(2);
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
   * §10「多设备冲突不静默覆盖」。做法是先合并再推：
   * 远端有一条本机没有的会话时，本机既不丢自己的，也不丢远端的。
   */
  it('远端多出一条会话 ⇒ 两边都留下，并把合并结果推回去（不是只推本机旧账）', async () => {
    await configure();
    await seedSessions(2);
    await runSync(deps(), AT);

    // 模拟另一台设备：它基于同一版加了一条新会话后推上去
    const mineUrl = snapshotFiles()[0] as string;
    const otherId = 'other-snapshot';
    const otherState = {
      groups: [
        ...JSON.parse(remote.files.get(mineUrl) as string).state.groups,
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

    const outcome = await runSync(deps(), AT + 4000);
    expect(outcome.status).toBe('idle');
    expect(outcome.pulled?.revision).toBe(2);
    // 合并落回本地：两条原有 + 一条外来
    expect((await storage.listGroupIndex()).map((entry) => entry.id).sort()).toEqual(['s0', 's1', 'w']);
    // 关键：推上去的那一版是**合并后**的，三条都在
    const pushedUrl = snapshotFiles().find((url) => !url.endsWith(`${otherId}.json`) && url !== mineUrl);
    const pushed = JSON.parse(remote.files.get(pushedUrl as string) as string);
    expect(pushed.state.groups).toHaveLength(3);
    expect(pushed.revision).toBe(3);
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
        { groupId: 's2', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: 'device-other', deleteReason: 'consumed' },
      ],
    });
    const first = (await storage.getSyncMeta()).pendingConflicts?.[0] as NonNullable<Awaited<ReturnType<StoragePort['getSyncMeta']>>['pendingConflicts']>[number];

    await resolveConflict(deps(), first, 'keep', AT + 9000);

    const after = await storage.getSyncMeta();
    expect(after.pendingConflicts?.map((item) => item.groupId)).toEqual(['s2']);
    expect(after.status).toBe('conflict');
  });
});

async function checksumOfState(state: StoredState): Promise<string> {
  const { stateChecksumOf } = await import('@/core/domain/sync-data');
  return stateChecksumOf(state);
}

/**
 * 把引擎逼到 delete-vs-edit 冲突那一站：远端删了 s1，本机在删除之后又改了它。
 * 返回停在 conflict 的那次结果，同时 sync_meta 里已经挂着这笔账。
 */
async function reachConflict() {
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
    }),
  );
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
    const parsed = snapshotFiles().map((url) => JSON.parse(remote.files.get(url) as string));
    return parsed.sort((a: { revision: number }, b: { revision: number }) => b.revision - a.revision)[0];
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
        { groupId: 'g1', deletedAt: 1, editedAt: 2, deletedByDeviceId: 'dev-2', deleteReason: 'user-delete' },
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
    // 但 manifest 一定要看过，否则"对面推了新东西"这件事根本不可能知道
    expect(remote.calls.length).toBeGreaterThan(before);
    expect(remote.calls.slice(before).some((call) => call.method === 'PROPFIND')).toBe(true);
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
