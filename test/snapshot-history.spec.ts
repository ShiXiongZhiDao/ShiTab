// 与 sync-engine / durable-snapshot 同一道理：这条链在真机上由 background
// service worker 执行，那儿没有 DOM。node 环境是最接近的替身 —— jsdom 比生产宽容，
// propfind 那个 `DOMParser` 的坑就是靠"假环境有、真环境没有"躲过整条测试套的。
// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import type { StoragePort } from '@/core/ports/storage';
import { createFakeWebDav, FAKE_CREDENTIAL } from '@/infrastructure/testing/fake-webdav';
import type { FakeWebDavPort } from '@/infrastructure/testing/fake-webdav';
import { listRemoteHistory, pruneRemoteHistory, restoreRemoteSnapshot } from '@/core/application/snapshot-history';
import { runSync } from '@/core/application/sync-engine';
import { manifestsDirUrl, parseBaseUrl, snapshotsDirUrl } from '@/core/domain/remote-layout';
import { groupFixture, savedTabFixture } from './fixtures';
import type { SyncManifest } from '@/shared/types';

const AT = 1_700_000_000_000;
const BASE = 'https://host/dav';

/**
 * 两个目录的 URL **一律从拼接函数取**，不在这里手写 `<base>/ShiTab/...`。
 * 上一版是手写的：远端布局改成 `<base>/ShiXiongZhiDao/ShiTab/` 之后，这两个常量立刻指到
 * 一个不存在的前缀，于是下面那些以 `before` 为基准的断言（"清理后一条没少"、"只剩最新那版"）
 * 会变成**空对空** —— 全绿但什么都没测。
 * 这次算运气好：第 118 行那条正向断言（`snapshotUrls()` 长度 = 3）先红了，才没让它静默过去。
 * 教训落成规则：**布局只在拼接函数里有一份**，测试要用就调它，别抄字面串。
 */
const PARSED = parseBaseUrl(BASE);
if (!PARSED.ok) throw new Error(`setup：${BASE} 应当是合法地址`);
const SNAP = snapshotsDirUrl(PARSED.url).href;
const MANI = manifestsDirUrl(PARSED.url).href;

let storage: StoragePort;
let remote: FakeWebDavPort;

function deps() {
  return { storage, webdav: remote, admin: remote };
}

async function configure() {
  await storage.setWebDavConfig({
    enabled: true,
    baseUrl: BASE,
    username: FAKE_CREDENTIAL.username,
    allowInsecureHttp: false,
  });
  await storage.setSyncCredential(FAKE_CREDENTIAL.password);
}

/** 推 N 版，每版比上一版多一条会话 ⇒ 内容真的在变，去重不会把后面的都吞掉。 */
async function pushVersions(count: number) {
  for (let version = 0; version < count; version += 1) {
    await storage.putGroup(
      groupFixture(`会话 v${version}`, [savedTabFixture(`v${version}`, `v${version}-t0`, 0)], {
        id: `v${version}`,
        sortOrder: version,
        updatedAt: AT + version * 1000,
      }),
    );
    await runSync(deps(), AT + version * 1000);
  }
}

const snapshotUrls = () => [...remote.files.keys()].filter((url) => url.startsWith(`${SNAP}/`));
const manifestUrls = () => [...remote.files.keys()].filter((url) => url.startsWith(`${MANI}/`));

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  storage = createStoragePort();
  await storage.heal();
  remote = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
});

it('环境自查：这里没有 DOM，和 service worker 一样', () => {
  // 上面的 docblock 被人删掉时不会有任何别的症状 —— 本文件照样全绿，只是失去这道闸。
  expect('document' in globalThis).toBe(false);
  expect('DOMParser' in globalThis).toBe(false);
});

describe('远端历史的查看', () => {
  it('没开同步就什么都看不到（reason=disabled），不是一次失败', async () => {
    await storage.setWebDavConfig({ enabled: false, baseUrl: BASE, username: 'u', allowInsecureHttp: false });
    expect(await listRemoteHistory(deps())).toEqual({ ok: false, reason: 'disabled' });
  });

  it('远端还没有 manifest ⇒ no-manifest，而不是空列表', async () => {
    await configure();
    expect(await listRemoteHistory(deps())).toEqual({ ok: false, reason: 'no-manifest' });
  });

  /**
   * 真坚果云 2026-10-04 实测：目录还没建出来时它对 PROPFIND 回的是 **409 `AncestorsNotFound`**
   * （"父不在"就直接说父不在），不是大家约定的 404。这一格钉的是措辞层级：
   * 用户点「读取远端历史」时该看到"远端还没有可恢复的历史"，而不是一个错误态 ——
   * 空库是正常状态，不是故障。上面那条 404 形状的用例盖不到这一种状态码。
   */
  it('服务器对还没建的目录回 409（坚果云的 AncestorsNotFound）⇒ 仍是 no-manifest，不是抛', async () => {
    remote = createFakeWebDav({
      expectedCredential: FAKE_CREDENTIAL,
      faults: [{ method: 'PROPFIND', url: MANI, status: 409 }],
    });
    await configure();
    expect(await listRemoteHistory(deps())).toEqual({ ok: false, reason: 'no-manifest' });
  });

  it('列出每一版的 revision / 字节数，最新在前，且标出 manifest 指向哪一版', async () => {
    await configure();
    await pushVersions(3);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error(`应当成功，实际 ${JSON.stringify(listed)}`);
    expect(listed.entries.map((entry) => entry.revision)).toEqual([3, 2, 1]);
    expect(listed.entries.filter((entry) => entry.isLatest)).toHaveLength(1);
    expect(listed.entries[0]?.isLatest).toBe(true);
    // 体量来自 HEAD，不是把正文下载下来数长度
    expect(listed.totalBytes).toBeGreaterThan(0);
    for (const entry of listed.entries) expect(entry.bytes).toBeTypeOf('number');
  });
});

describe('从远端历史恢复', () => {
  it('恢复到旧的一版 ⇒ 本机变成那一版的内容，并等下一轮同步推成新的一版', async () => {
    await configure();
    await pushVersions(3);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const oldest = listed.entries[listed.entries.length - 1]!;

    const result = await restoreRemoteSnapshot({ storage, webdav: remote }, oldest.snapshotId, AT + 50_000);
    expect(result).toEqual({ ok: true });

    expect((await storage.listGroupIndex()).map((entry) => entry.id)).toEqual(['v0']);
    // 恢复不是把 manifest 指针往回挪：远端的旧快照文件一个都没少
    expect(snapshotUrls()).toHaveLength(3);
    const meta = await storage.getSyncMeta();
    expect(meta.status).toBe('pending');
  });

  /**
   * 远端文件被别的工具改过一个字节就拒绝恢复，本机保持原样。
   * "大体对得上就当真"在这种路径上是危险的：恢复出一份自相矛盾的状态，
   * 而用户以为回到了某一天。
   */
  it('那一版内容被改坏 ⇒ 拒绝恢复，本机一条不少', async () => {
    await configure();
    await pushVersions(2);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const target = listed.entries[1]!;
    // 只改正文里的一个字节 ⇒ checksum 与内容不再一致；测的是"改坏了要拒绝"，不是"版本号写错要拒绝"
    const tampered = remote.files.get(target.url)!.replace('"revision"', '"revisionx"');
    remote.files.set(target.url, tampered);

    const before = (await storage.listGroupIndex()).length;
    expect(await restoreRemoteSnapshot({ storage, webdav: remote }, target.snapshotId)).toEqual({ ok: false, reason: 'corrupt' });
    expect((await storage.listGroupIndex()).length).toBe(before);
  });

  it('恢复一个不存在的版本 ⇒ not-found，本机不动', async () => {
    await configure();
    await pushVersions(1);
    const before = (await storage.listGroupIndex()).length;
    expect(await restoreRemoteSnapshot({ storage, webdav: remote }, '00000000000000000000000000000000')).toEqual({ ok: false, reason: 'not-found' });
    expect((await storage.listGroupIndex()).length).toBe(before);
  });
});

describe('清理远端历史（§18 的三条前置）', () => {
  it('没有明确确认 ⇒ not-confirmed，一个远端文件都不删', async () => {
    await configure();
    await pushVersions(3);
    const before = snapshotUrls().length;
    expect(await pruneRemoteHistory(deps(), { keep: 1, confirmed: false })).toEqual({ ok: false, reason: 'not-confirmed' });
    expect(snapshotUrls()).toHaveLength(before);
  });

  /**
   * §18 的前置流程图：**先创建当前可恢复快照，再确认清理**。
   * 这里让耐久快照写不进去，删除就必须整批不发生 ——
   * 否则"删掉了旧版"和"当前版只活在待翻的指针里"是同一件事。
   */
  it('本地耐久快照写失败 ⇒ 拒绝清理，远端一个文件都没少', async () => {
    await configure();
    await pushVersions(3);
    const before = snapshotUrls().length;
    const beforeCalls = remote.calls.filter((call) => call.method === 'DELETE').length;

    storage.writeSnapshotSlot = () => Promise.reject(new Error('模拟配额写不进去'));

    const result = await pruneRemoteHistory(deps(), { keep: 1, confirmed: true });
    expect(result).toEqual({ ok: false, reason: 'durable-snapshot-failed' });
    expect(snapshotUrls()).toHaveLength(before);
    expect(remote.calls.filter((call) => call.method === 'DELETE')).toHaveLength(beforeCalls);
  });

  it('keep=1 ⇒ 只留最新那一版，其余删掉并回报省下的字节', async () => {
    await configure();
    await pushVersions(3);
    const before = snapshotUrls().length;
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const latest = listed.entries.find((entry) => entry.isLatest)!;

    const result = await pruneRemoteHistory(deps(), { keep: 1, confirmed: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deleted).toBe(before - 1);
    expect(snapshotUrls()).toHaveLength(1);
    expect(snapshotUrls()[0]).toBe(latest.url);
    // manifest 自己不删：它是远端的入口，删了就所有设备都要走重建路径
    expect(manifestUrls().length).toBeGreaterThan(0);
  });

  /**
   * 硬保护要能在"入口那一版恰好不是 revision 最大的那一版"时仍然成立 ——
   * 那正是手滑会把入口删掉的形状（某台设备时钟快了几秒，或 manifest 写歪了一次）。
   */
  it('manifest 指向较旧那一版时，清理仍不碰它', async () => {
    await configure();
    await pushVersions(3);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const highest = listed.entries[0]!; // revision 最大
    const oldest = listed.entries[listed.entries.length - 1]!; // revision 最小，被伪造成"入口"

    const forged: SyncManifest = {
      format: 'shitab-manifest',
      version: 1,
      latestRevision: highest.revision,
      latestSnapshotId: oldest.snapshotId,
      updatedAt: AT + 9000,
      deviceIds: ['dev'],
      history: listed.entries.map((entry) => ({
        snapshotId: entry.snapshotId,
        revision: entry.revision,
        deviceId: 'dev',
        createdAt: entry.createdAt,
        stateChecksum: entry.stateChecksum,
      })),
    };
    for (const url of manifestUrls()) remote.files.delete(url);
    remote.files.set(`${MANI}/revision-99.json`, JSON.stringify(forged));

    const result = await pruneRemoteHistory(deps(), { keep: 1, confirmed: true }, AT + 9000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const left = snapshotUrls();
    // 入口那一版活着（它按 revision 排在 keep 之外，靠的正是这条硬保护）
    expect(left).toContain(oldest.url);
    // revision 最大的那版按"留最新 1 个"留下；中间那版被删
    expect(left).toContain(highest.url);
    expect(result.deleted).toBe(1);
  });

  it('本来就没什么可删 ⇒ nothing-to-prune，不是一次失败也不是空操作假装成功', async () => {
    await configure();
    await pushVersions(1);
    expect(await pruneRemoteHistory(deps(), { keep: 5, confirmed: true })).toEqual({ ok: false, reason: 'nothing-to-prune' });
    expect(snapshotUrls()).toHaveLength(1);
  });

  it('keep<=0 被夹成 1：入口那一版不许因为参数写错被删光', async () => {
    await configure();
    await pushVersions(3);
    const result = await pruneRemoteHistory(deps(), { keep: 0, confirmed: true });
    expect(result.ok).toBe(true);
    expect(snapshotUrls().length).toBeGreaterThanOrEqual(1);
  });
});
