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
import type { RemoteResourceMeta, WebDavCredential } from '@/core/ports/webdav';
import { listRemoteHistory, pruneRemoteHistory, previewRestore, restoreRemoteSnapshot } from '@/core/application/snapshot-history';
import { runSync } from '@/core/application/sync-engine';
import { manifestsDirUrl, parseBaseUrl, snapshotsDirUrl, TRUSTED_LISTING_LIMIT } from '@/core/domain/remote-layout';
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

/**
 * 体量断言的**真值在这里自己算一遍**，不拿实现返回的数去断言实现自己。
 * 假件的 `contentLength` 是 `TextEncoder` 的字节数（不是 `string.length`），
 * 所以这边也按字节数算 —— 载荷里全是中文标题时两者差一个数量级，按字符算会一路骗过测试。
 */
function wireBytesOf(url: string): number {
  const body = remote.files.get(url);
  if (body === undefined) throw new Error(`setup：远端没有 ${url}`);
  return new TextEncoder().encode(body).length;
}

/** 只保留"这次 listRemoteHistory 发出去的请求"：播种那几轮 runSync 的轨迹不该进断言。 */
const since = (from: number) => remote.calls.slice(from);
const countOf = (calls: Array<{ method: string; url: string }>, method: string, url?: string) =>
  calls.filter((call) => call.method === method && (url === undefined || call.url === url)).length;

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

  /**
   * ★ 「问不通」与「没有历史」是两件事（既有约定 之后更需要分开：超时是新添的一档，
   * 而且比 404 常见得多）。
   *
   * 原来这里 `.catch(() => [])` 把断网、超时、401、5xx 全折成空清单，于是我上一轮加的
   * "列举拿满 750 条不可信"也一起报成 `no-manifest` ⇒ 面板会对一个**连不上**的服务器说
   * "服务器上还没有同步历史"。那不是保守，那是多一句谎：用户会以为自己攒的历史没了。
   *
   * 上面那条 409 的用例是这一条的正向对照：同一台假服务器、同一个注入点，
   * 只是状态码不同 ⇒ 一边说"没有"，一边说"不知道"。
   */
  it('PROPFIND 服务器故障（5xx）⇒ unreachable，不说成"还没有历史"', async () => {
    remote = createFakeWebDav({
      expectedCredential: FAKE_CREDENTIAL,
      faults: [{ method: 'PROPFIND', url: MANI, status: 503 }],
    });
    await configure();
    const listed = await listRemoteHistory(deps());
    expect(listed).toEqual({ ok: false, reason: 'unreachable' });
    expect(listed, '故障不许被伪装成正常的空库').not.toEqual({ ok: false, reason: 'no-manifest' });
  });

  /** 401 是凭据问题不是"没有历史"：把它说成后者，用户会去同步一次而不是去改密码。 */
  it('PROPFIND 回 401 ⇒ unreachable（凭据失效不等于远端为空）', async () => {
    remote = createFakeWebDav({
      expectedCredential: FAKE_CREDENTIAL,
      faults: [{ method: 'PROPFIND', url: MANI, status: 401 }],
    });
    await configure();
    expect(await listRemoteHistory(deps())).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('列出每一版的 revision / 字节数，最新在前，且标出 manifest 指向哪一版', async () => {
    await configure();
    await pushVersions(3);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error(`应当成功，实际 ${JSON.stringify(listed)}`);
    expect(listed.entries.map((entry) => entry.revision)).toEqual([3, 2, 1]);
    expect(listed.entries.filter((entry) => entry.isLatest)).toHaveLength(1);
    expect(listed.entries[0]?.isLatest).toBe(true);
    // 体量来自那**一次**目录列举，不是把正文下载下来数长度（下面一组用例钉住请求数）
    expect(listed.totalBytes).toBeGreaterThan(0);
    for (const entry of listed.entries) expect(entry.bytes).toBeTypeOf('number');
  });
});

/**
 * ★ 体量来路：一次 `PROPFIND snapshots/`，不是每条历史一次 `HEAD`。
 *
 * 真机现象（用户 2026-10 的坚果云账号）：13 个快照文件**没有一个 0 字节**（最小 325 B），
 * 而面板十二行里有六行印着 `0 B`。`0 B` 只能是 `bytes === 0`（`SnapshotHistoryPanel.vue`
 * 对 `undefined` 印的是 `—`），而 0 正是 HEAD 那一支会拿到的数：
 * `http-webdav.ts` 的 `head()` 读 `Content-Length`（HEAD 的响应体是空的，
 * 不少主机就在这儿回 0），`parseLength('0')` 又是**合法值**（它只拦非数字与负数）。
 * Depth:1 的 PROPFIND 不一样：`<d:getcontentlength>` 描述的是资源本身，
 * 坚果云对文件回的是真实字节数（见 `test/webdav-real-shape.spec.ts` 那条 2034）。
 *
 * 第二层理由同样是真机：坚果云免费账号限 **600 请求 / 30 分钟**，
 * 十二版历史 = 十二次 HEAD，看一眼远端有多大就吃掉十三格配额。
 */
describe('远端历史的体量来自一次目录列举', () => {
  it('列 3 版只打一次 snapshots/ 的 PROPFIND，一次 HEAD 都不发', async () => {
    await configure();
    await pushVersions(3);
    const before = remote.calls.length;

    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error(`应当成功，实际 ${JSON.stringify(listed)}`);
    const calls = since(before);
    expect(countOf(calls, 'PROPFIND', SNAP), '目录列举应当只有那一次').toBe(1);
    expect(countOf(calls, 'HEAD'), '逐条 HEAD 已经被目录列举取代').toBe(0);

    // 正向对照：零次 HEAD 不是因为压根没收集体量 —— 每一版都拿到了远端文件的真字节数
    for (const entry of listed.entries) {
      expect(entry.bytes, `第 ${entry.revision} 版没从目录列举里拿到体量`).toBe(wireBytesOf(entry.url));
      expect(entry.bytes, '问得出大小就不许是 0').toBeGreaterThan(0);
    }
    expect(listed.totalBytes).toBe(listed.entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0));
    expect(listed.unknownSizes, '全都问得出大小就不该有"未知"那一档').toBe(0);
  });

  /**
   * 假服务器漏给 `getcontentlength` 的形状，来自 `http-webdav.ts` 的 `metaFromResponse`：
   * 它**只在解到那个属性时才写这个键**。这一条钉的是另一半判据：问不出大小必须是"未知"，
   * 不许折成 0 —— 用户那台机器上的 `0 B` 就是这样长出来的。
   */
  it('目录列出了这一版但服务器没给大小 ⇒ bytes 缺席（界面是 —），不是 0', async () => {
    await configure();
    await pushVersions(2);
    const probe = await listRemoteHistory(deps());
    if (!probe.ok) throw new Error('setup');
    const target = probe.entries[0]!;
    expect(target.bytes, '前置：没动手之前这一版确实有大小').toBe(wireBytesOf(target.url));

    // 只把这一版的大小从列举结果里摘掉，其余条目原样
    const original = remote.propfind.bind(remote);
    remote.propfind = async (url: string, credential: WebDavCredential, depth: 0 | 1) => {
      const listing = await original(url, credential, depth);
      return listing.map((meta: RemoteResourceMeta) =>
        meta.url === target.url
          ? { url: meta.url, exists: meta.exists, isDirectory: meta.isDirectory, etag: meta.etag }
          : meta,
      );
    };

    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error(`问不出大小不该让整张历史失败，实际 ${JSON.stringify(listed)}`);
    const row = listed.entries.find((entry) => entry.snapshotId === target.snapshotId)!;
    expect('bytes' in row, '大小问不出时要缺席，让界面印 —').toBe(false);
    expect(row.bytes).not.toBe(0);

    // 正向对照：同一次列举里另一版仍然拿到真字节数 ⇒ 那一格的缺席来自"没给大小"，不是断言写空
    const other = listed.entries.find((entry) => entry.snapshotId !== target.snapshotId)!;
    expect(other.bytes).toBe(wireBytesOf(other.url));

    // 总数是**下限**：不知道的那一版不进账，而且必须被如实标出来（不许报成精确值）
    expect(listed.totalBytes).toBe(other.bytes);
    expect(listed.unknownSizes, '总数是下限：得说得出有几版没算进去').toBe(1);
  });

  it('snapshots/ 问不通 ⇒ 历史照列、每版都不带大小，总数标明是下限', async () => {
    await configure();
    await pushVersions(2);
    remote.nextFault({ method: 'PROPFIND', url: SNAP, status: 503 });

    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error(`问不出体量不该把整张历史判死，实际 ${JSON.stringify(listed)}`);
    expect(listed.entries).toHaveLength(2);
    for (const entry of listed.entries) expect('bytes' in entry, '问不通时不许猜一个大小').toBe(false);
    expect(listed.totalBytes).toBe(0);
    expect(listed.unknownSizes).toBe(2);

    // 正向对照：故障队列是一次性的，第二次问得到 ⇒ 上面的"全部缺席"来自那条故障而不是实现坏掉
    const again = await listRemoteHistory(deps());
    if (!again.ok) throw new Error('setup');
    for (const entry of again.entries) expect(entry.bytes).toBe(wireBytesOf(entry.url));
    expect(again.unknownSizes).toBe(0);
  });

  it('目录里那一版的名字对不上 manifest 时按文件名归一匹配（有无 .json、大小写都算同一个）', async () => {
    await configure();
    await pushVersions(2);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const target = listed.entries[0]!;
    // 服务器把 href 写成不带扩展名、且大小写不同 —— 坚果云真回过不带 `.json` 的 href
    // （`test/webdav-real-shape.spec.ts` 里那份 207 正文就是），匹配只看名字只会漏配。
    const shuffled = target.url.replace(/\.json$/, '').toUpperCase().replace('HTTPS://', 'https://');
    const original = remote.propfind.bind(remote);
    remote.propfind = async (url: string, credential: WebDavCredential, depth: 0 | 1) => {
      const listing = await original(url, credential, depth);
      return listing.map((meta: RemoteResourceMeta) => (meta.url === target.url ? { ...meta, url: shuffled } : meta));
    };

    const matched = await listRemoteHistory(deps());
    if (!matched.ok) throw new Error(`应当成功，实际 ${JSON.stringify(matched)}`);
    const row = matched.entries.find((entry) => entry.snapshotId === target.snapshotId)!;
    expect(row.bytes, `认不出 ${shuffled} 就是那一版的大小`).toBe(wireBytesOf(target.url));
    expect(matched.unknownSizes).toBe(0);
    // 正向对照：另一版走的是规规矩矩的 href，同样拿到大小
    const other = matched.entries.find((entry) => entry.snapshotId !== target.snapshotId)!;
    expect(other.bytes).toBe(wireBytesOf(other.url));
  });
});

/**
 * ★ 每一版是**什么时候、由哪台设备**推上去的。
 *
 * 两个字段本来就在载荷里（`ManifestEntry.createdAt` / `.deviceId`，manifest 的 `devices` 表
 * 带着名字），所以这一条的另一半判据是"不多打一次请求"：以前面板只印 revision 和大小，
 * 用户想挑"回到上周那一版"只能靠版本号猜。
 */
describe('远端历史带着时间与设备', () => {
  it('deviceName 来自 manifest 的设备表，且不为此多读任何一个快照正文', async () => {
    await storage.setDeviceName('办公室那台 Edge');
    await configure();
    await pushVersions(3);
    const before = remote.calls.length;

    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error(`应当成功，实际 ${JSON.stringify(listed)}`);
    for (const entry of listed.entries) {
      expect(entry.deviceName, `第 ${entry.revision} 版没带上设备名`).toBe('办公室那台 Edge');
      expect(entry.createdAt, '时间戳是载荷里本来就带的，不该缺席').toBeTypeOf('number');
    }
    // 正向对照 + 边界：snapshots/ 那一侧只发生过一次目录列举，一个快照正文都没下载
    const calls = since(before);
    expect(countOf(calls, 'PROPFIND', SNAP)).toBe(1);
    expect(calls.filter((call) => call.url.startsWith(`${SNAP}/`) && call.method !== 'PROPFIND')).toEqual([]);
  });

  it('老 manifest 没有设备表 ⇒ deviceName 缺席，由界面回退 UUID 前缀（这里不编名字）', async () => {
    await storage.setDeviceName('办公室那台 Edge');
    await configure();
    await pushVersions(2);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    expect(listed.entries[0]?.deviceName, '前置：正常路径确实解析得出名字').toBe('办公室那台 Edge');

    // 伪造成"没有 devices 这一项"的那一版（老载荷的形状），条目本身换成一个陌生的 id
    const UNKNOWN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const highest = listed.entries[0]!;
    const forged: SyncManifest = {
      format: 'shitab-manifest',
      version: 1,
      latestRevision: highest.revision,
      latestSnapshotId: highest.snapshotId,
      updatedAt: AT + 9000,
      deviceIds: [UNKNOWN],
      history: listed.entries.map((entry) => ({
        snapshotId: entry.snapshotId,
        revision: entry.revision,
        deviceId: UNKNOWN,
        createdAt: entry.createdAt,
        stateChecksum: entry.stateChecksum,
      })),
    };
    for (const url of manifestUrls()) remote.files.delete(url);
    remote.files.set(`${MANI}/revision-99.json`, JSON.stringify(forged));

    const read = await listRemoteHistory(deps());
    if (!read.ok) throw new Error(`应当成功，实际 ${JSON.stringify(read)}`);
    for (const entry of read.entries) {
      expect('deviceName' in entry, '解析不到名字时要缺席，不拿 UUID 冒充一个名字').toBe(false);
      expect(entry.deviceId).toBe(UNKNOWN);
    }
    // 正向对照：缺席的只有名字，大小走的是另一条来路，仍然在
    for (const entry of read.entries) expect(entry.bytes).toBe(wireBytesOf(entry.url));
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
    // 返回的不只是"成功了"：那四个数是给确认文案用的，这里顺手钉住它们算得对
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.counts).toEqual({ broughtSessions: 1, removedSessions: 2, askedBack: 0, removedCategories: 0, removedTrashRows: 0 });

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

// ---------------------------------------------------------------------------
// ★ 真机报回来的（2026-10-08 用户两张截图）：执行完「清理远端历史」，
// 屏幕上先说「✓ 已删除 4 个快照，保留 30 个」，紧接着那句总数仍然是
// 「服务器上有 **34** 个快照 · 至少共 544.1 KiB —— 其中 **4** 个服务器没报大小」。
//
// 文件确实删掉了（那 4 版之所以"没报大小"，正是因为列举里已经没有它们），
// 但**清单没跟着变短** —— 因为列表读的是 manifest 的 `history` 数组，
// 而 `pruneRemoteHistory` 只删快照文件，从不回头改那份账。
// 于是"清理"在界面上等于没发生，而那 4 行还挂着「恢复这一版」——点下去必然失败。
//
// 判据取的是**读侧那一条**（列表以"服务器上到底有这份文件吗"为准），不是让清理去重写 manifest：
// 前者顺带治好了另一种来路 —— 用户直接在坚果云网页里删文件，我们的账本同样会指着空气。
// ---------------------------------------------------------------------------

describe('清单以"文件还在不在"为准（真机：清理完个数不变）', () => {
  it('清理之后再看清单 ⇒ 只剩保留的那几版，被删的不再挂「恢复」', async () => {
    await configure();
    await pushVersions(3);
    const before = await listRemoteHistory(deps());
    if (!before.ok) throw new Error('setup');
    expect(before.entries).toHaveLength(3);

    const pruned = await pruneRemoteHistory(deps(), { keep: 1, confirmed: true });
    expect(pruned.ok).toBe(true);
    if (!pruned.ok) return;
    expect(pruned.deleted).toBe(2);

    const after = await listRemoteHistory(deps());
    if (!after.ok) throw new Error(`清理之后清单读不出来了：${after.reason}`);
    expect(after.entries, '删掉的版本还在清单上挂着 ⇒ 那一行的「恢复这一版」点下去必然失败').toHaveLength(1);
    expect(after.entries[0]?.isLatest, '留下的必须是入口那一版').toBe(true);
    // 那句总数也跟着诚实了：文件都在 ⇒ 不该再有"没报大小"的下限口径
    expect(after.unknownSizes, '被删的那几版才是"没报大小"的来源').toBe(0);
  });

  /**
   * 同一句判据的**第二条来路**：用户不经我们的清理，直接在坚果云网页里删文件。
   * 少了这一条，"以文件为准"就只是给清理打的补丁，而不是这条判据本身。
   */
  it('文件被外部删掉（我们这边没动过账）⇒ 清单同样不列它', async () => {
    await configure();
    await pushVersions(3);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const doomed = listed.entries.find((entry) => !entry.isLatest)!;
    remote.files.delete(doomed.url);

    const after = await listRemoteHistory(deps());
    if (!after.ok) throw new Error('setup');
    expect(after.entries.map((entry) => entry.snapshotId), '账上还指着那份已被删掉的文件').not.toContain(doomed.snapshotId);
    expect(after.entries).toHaveLength(2);
  });

  /**
   * ★ 反向护栏（与上面两条对称）：**问不出来的列举不许当证据**。
   * 把"这一版不在清单里"当成"这一版不存在"，前提是我们真的看见了整个目录。
   * 列举失败 / 只回目录自己 / 拿满 750 条被截断 —— 这三种情况下按老口径列全（体量报"不知道"），
   * 否则一次服务器抽风就把用户的整份历史"删没了"。
   */
  it('列举问不通 ⇒ 一条都不许从清单上消失（"不知道"不是"没有"）', async () => {
    await configure();
    await pushVersions(3);
    const original = remote.propfind.bind(remote);
    remote.propfind = async () => {
      throw new Error('模拟服务器 5xx');
    };

    const failed = await listRemoteHistory(deps());
    remote.propfind = original;
    if (!failed.ok) throw new Error(`列举失败应当只丢体量、不丢条目：${failed.reason}`);
    expect(failed.entries, '列举没看见 ⇒ 不许据此删条目').toHaveLength(3);
    expect(failed.unknownSizes).toBe(3);
  });

  it('列举只回目录自己（一个文件条目都没有）⇒ 同样不据此删条目', async () => {
    await configure();
    await pushVersions(3);
    const original = remote.propfind.bind(remote);
    remote.propfind = async (url: string, credential: WebDavCredential, depth: 0 | 1) => {
      const listing = await original(url, credential, depth);
      return url.startsWith(SNAP) ? listing.filter((meta) => meta.isDirectory) : listing;
    };

    const empty = await listRemoteHistory(deps());
    remote.propfind = original;
    if (!empty.ok) throw new Error('setup');
    expect(empty.entries, '一份文件都没列出来 = 这次列举不可信，不是"目录是空的"').toHaveLength(3);
  });
});

/** 上面那一族的第三条与第四条：把"不能当证据"的第三种来路也钉住。 */
describe('清单以"文件还在不在"为准（续：第三种不能当证据的来路）', () => {
  it('列举被截断到 750 条 ⇒ 不许据此判定"某版没了"', async () => {
    await configure();
    await pushVersions(3);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const doomed = listed.entries.find((entry) => !entry.isLatest)!;
    remote.files.delete(doomed.url);

    const original = remote.propfind.bind(remote);
    remote.propfind = async (url: string, credential: WebDavCredential, depth: 0 | 1) => {
      const real = await original(url, credential, depth);
      if (!url.startsWith(SNAP)) return real;
      // 拿满 `TRUSTED_LISTING_LIMIT` 条：后面可能还有一页，我们**看不见** ≠ **不存在**
      const filler = Array.from({ length: TRUSTED_LISTING_LIMIT - real.length }, (_, index) => ({
        url: `${url}/filler-${index}.json`,
        exists: true,
        isDirectory: false,
      }));
      return [...real, ...filler];
    };

    const after = await listRemoteHistory(deps());
    remote.propfind = original;
    if (!after.ok) throw new Error('setup');
    expect(after.entries, '半份清单不许当"被删了"的证据').toHaveLength(3);
  });

  /**
   * 清理自己也要能被这句判据保护：账上那几条指向空气的条目**不该再被 DELETE 一次**。
   * 少了读侧这一格，第二次清理会把 404 当成失败抛给用户 —— 而用户看到的正是"我删不掉它"。
   */
  it('清理过一次之后再按同样的保留数清理 ⇒ nothing-to-prune，不再对已删的文件发 DELETE', async () => {
    await configure();
    await pushVersions(3);
    const first = await pruneRemoteHistory(deps(), { keep: 1, confirmed: true });
    expect(first.ok).toBe(true);

    const deletesBefore = remote.calls.filter((call) => call.method === 'DELETE').length;
    const second = await pruneRemoteHistory(deps(), { keep: 1, confirmed: true });
    expect(second).toEqual({ ok: false, reason: 'nothing-to-prune' });
    expect(remote.calls.filter((call) => call.method === 'DELETE')).toHaveLength(deletesBefore);
  });
});

// ---------------------------------------------------------------------------
// ★ 「恢复到这一版」= **替换**。
//
// 真机报的形状：恢复第 15 版 ⇒ 工作台 35 → 16 → **又自己弹回 35**。
// 探针复现出的机制不是抖动：原来 `restoreFromSnapshot` 只把快照原文落盘，
// 而下一轮同步走实体级 LWW（比 `updatedAt`），那一版每条都比现在旧 ⇒ 全部输 ⇒
// 合并结果 == 远端最新那版 ⇒ 出口是 `no-changes`，**什么都没推上去**。
// 这一族用例钉的就是"恢复之后再同步，还在不在"这一条 —— 它以前**一条都没有**。
// ---------------------------------------------------------------------------

describe('恢复到这一版 = 替换', () => {
  /**
   * 从 `from` 起造 `count` 条会话并同步出去。
   *
   * `from` 不是装饰：第一版写成"每次从 0 数 N 条"，于是第二次 seed 是把同一批 id
   * **覆盖**了一遍，屏幕上 35 条其实是 19 条 —— 那条用例红成 `expected 19 to be 35`
   * 才把它照出来。
   */
  async function seedAndPush(from: number, count: number, at: number): Promise<number> {
    for (let index = from; index < from + count; index += 1) {
      await storage.putGroup(
        groupFixture(`会话 s${index}`, [savedTabFixture(`s${index}`, `s${index}-t0`, 0)], {
          id: `s${index}`,
          sortOrder: index,
          updatedAt: at,
        }),
      );
    }
    const outcome = await runSync(deps(), at);
    if (outcome.status !== 'idle') throw new Error(`setup：这一轮没推出去（${outcome.status}）`);
    return outcome.pushed?.revision ?? -1;
  }

  it('恢复较旧那一版，再走一轮同步 ⇒ 本机仍然是那一版的条数，并且真的推上去一版新的', async () => {
    await configure();
    await seedAndPush(0, 16, AT);
    await seedAndPush(16, 19, AT + 5000); // 现在 35 条
    expect((await storage.listGroupIndex()).length).toBe(35);

    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const oldest = listed.entries[listed.entries.length - 1]!;

    const restored = await restoreRemoteSnapshot(deps(), oldest.snapshotId, AT + 9000);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.counts.removedSessions, '现在多出来的 19 条要报得出来').toBe(19);
    expect(restored.counts.broughtSessions).toBe(16);
    expect((await storage.listGroupIndex()).length).toBe(16);

    const next = await runSync(deps(), AT + 10_000);
    expect((await storage.listGroupIndex()).length, '恢复之后又被 LWW 冲回 35 条 = 这个按钮等于没做事').toBe(16);
    expect(next.status).toBe('idle');
    expect(next.pushed?.revision, '恢复必须推出一版新的（前进），不是 no-changes').toBeDefined();

    // 对面下一轮拿到的也必须是 16 条
    const after = await listRemoteHistory(deps());
    if (!after.ok) throw new Error('setup');
    const newest = after.entries.find((entry) => entry.isLatest)!;
    const fetched = await restoreRemoteSnapshot(deps(), newest.snapshotId, AT + 20_000);
    expect(fetched.ok, '最新那一版应当读得回来（也证明它真的写进远端了）').toBe(true);
    expect((await storage.listGroupIndex()).length).toBe(16);
  }, 30_000);

  /**
   * 正向对照：恢复**为什么**这次没被冲掉 —— 因为带回来的每条 `updatedAt` 被抬到恢复那一刻。
   * 少了这一条，上面那条绿可能是靠别的东西蒙过去的。
   */
  it('带回来的每条会话，updatedAt 被抬到恢复那一刻', async () => {
    await configure();
    await seedAndPush(0, 3, AT);
    await seedAndPush(3, 2, AT + 5000);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const oldest = listed.entries[listed.entries.length - 1]!;

    await restoreRemoteSnapshot(deps(), oldest.snapshotId, AT + 9000);
    const groups = await storage.listAllGroups();
    expect(groups.map((group) => group.updatedAt), '没抬时间戳 ⇒ 下一轮 LWW 判它输').toEqual(
      groups.map(() => AT + 9000),
    );
  });

  /**
   * ★ 这一条才是"必须抬 `updatedAt`"的真正证据。
   *
   * 上面那条"恢复之后再同步还在不在"即使不抬时间戳也能过 —— 因为那份夹具里
   * 两边同一条会话的 `updatedAt` **相等**，而 `pickNewer` 的规则是平手取本地。
   * 真机上不是这样：新那一版往往是**改过**了某条会话（改标题、移动标签），
   * 它的 `updatedAt` 严格大于旧版 ⇒ 不抬时间戳，恢复完下一轮又被改动那版盖回去。
   * 这条用例就是去测那一格（变异验证：把 `updatedAt: at` 删掉，只有它红）。
   */
  it('那一版之后被**改过**的会话：恢复要把改动也换回去（抬时间戳的那一格）', async () => {
    await configure();
    await seedAndPush(0, 3, AT);
    // 第 2 版：不改条数，只把 s0 的标题改掉 —— 上一份夹具漏的就是这一形
    await storage.putGroup(
      groupFixture('会话 s0 改过了', [savedTabFixture('s0', 's0-t0', 0)], { id: 's0', sortOrder: 0, updatedAt: AT + 5000 }),
    );
    const outcome = await runSync(deps(), AT + 5000);
    if (outcome.status !== 'idle') throw new Error('setup：第 2 版没推出去');
    expect((await storage.listAllGroups()).find((group) => group.id === 's0')?.title).toContain('改过了');

    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const oldest = listed.entries[listed.entries.length - 1]!;
    await restoreRemoteSnapshot(deps(), oldest.snapshotId, AT + 9000);
    await runSync(deps(), AT + 10_000);

    const restoredGroup = (await storage.listAllGroups()).find((group) => group.id === 's0');
    expect(restoredGroup?.title, '改动没被换回去 ⇒ 恢复只换了条数、没换内容').toBe('会话 s0');
    expect(restoredGroup?.updatedAt, '带回来的那条要把 updatedAt 抬到恢复那一刻，否则下一轮 LWW 判它输').toBe(AT + 9000);
  });

  /** 换掉的那些**不进回收站**（撤销路径是"再恢复到最新那一版"，理由写在 既有约定）。 */
  it('被换掉的 19 条不留尸体：不进回收站、但留墓碑', async () => {
    await configure();
    await seedAndPush(0, 16, AT);
    await seedAndPush(16, 19, AT + 5000);
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const oldest = listed.entries[listed.entries.length - 1]!;

    await restoreRemoteSnapshot(deps(), oldest.snapshotId, AT + 9000);
    await runSync(deps(), AT + 10_000);

    expect(await storage.listTrash()).toHaveLength(0);
    const tombstoned = await storage.listTombstones();
    expect(tombstoned.filter((marker) => marker.entityType === 'group').map((marker) => marker.entityId)).toEqual(
      expect.arrayContaining(['s16', 's20', 's34']),
    );
    expect(tombstoned.every((marker) => marker.deletedAt === AT + 9000), '恢复造成的删除要署在恢复那一刻').toBe(true);
  });

  /**
   * ★ 那一版之后**已被删除并同步出去**的那些：协议里没有"撤销删除"这件东西，
   * 抬到"现在"之后正好落进 既有约定 的 delete-vs-edit ⇒ 交回用户裁决。
   * 这不是回归，是既签机制在做事；确认文案要提前把条数报出来（`askedBack`）。
   */
  it('那一版之后被删掉的会话：恢复完先进冲突列表，选「保留会话」才回来', async () => {
    await configure();
    await seedAndPush(0, 4, AT); // 第 1 版：s0..s3
    const { softDeleteGroup } = await import('@/core/application/delete-model');
    await softDeleteGroup({ storage }, { groupId: 's2', reason: 'user-delete', at: AT + 4000 });
    await runSync(deps(), AT + 5000); // 第 2 版：3 条 + s2 的墓碑
    expect((await storage.listGroupIndex()).map((entry) => entry.id)).not.toContain('s2');

    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const oldest = listed.entries[listed.entries.length - 1]!;
    const preview = await restoreRemoteSnapshot(deps(), oldest.snapshotId, AT + 9000);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.counts.askedBack, 's2 是那一版之后被删的 ⇒ 应当预告"会问你一句"').toBe(1);

    const outcome = await runSync(deps(), AT + 10_000);
    expect(outcome.status, '删了又改 ⇒ 停下来问，不自动判').toBe('conflict');
    const pending = (await storage.getSyncMeta()).pendingConflicts ?? [];
    expect(pending.map((conflict) => conflict.groupId)).toContain('s2');
  }, 30_000);
});

/**
 * ★ 撤销一次恢复，不该撞出一排冲突（既有约定，真机 2026-10-08 第二张截图）。
 *
 * 他的操作是"恢复到第 15 版，然后觉得不对，再恢复到第 35 版"。
 * 第一次恢复由**我们自己**给那 19 条写了 `reverted` 墓碑；第二次恢复把它们换回来之后，
 * 那些墓碑就逐条命中 既有约定 的"删了又改"⇒ 屏幕上 19 张卡片等他裁决。
 * 那是拿旧动作否决新动作，而且他点的明明是"把这些内容换回来"。
 */
describe('恢复到旧版再恢复回来', () => {
  async function seed(from: number, count: number, at: number): Promise<void> {
    for (let index = from; index < from + count; index += 1) {
      await storage.putGroup(
        groupFixture(`会话 s${index}`, [savedTabFixture(`s${index}`, `s${index}-t0`, 0)], { id: `s${index}`, sortOrder: index, updatedAt: at }),
      );
    }
    const outcome = await runSync(deps(), at);
    if (outcome.status !== 'idle') throw new Error(`setup：这一轮没推出去（${outcome.status}）`);
  }

  it('恢复到旧版 → 同步 → 再恢复到新版 → 同步 ⇒ 不停在 conflict，本机就是那一版', async () => {
    await configure();
    await seed(0, 3, AT);
    await seed(3, 2, AT + 5000); // 第 2 版：5 条
    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const oldest = listed.entries[listed.entries.length - 1]!;
    const newest = listed.entries.find((entry) => entry.isLatest)!;

    await restoreRemoteSnapshot(deps(), oldest.snapshotId, AT + 9000);
    expect((await runSync(deps(), AT + 10_000)).status).toBe('idle');
    expect((await storage.listGroupIndex()).length).toBe(3);

    // 预告也不许多报：那两条墓碑是**上一次恢复自己写的**，这一格不问
    const second = await previewRestore(deps(), newest.snapshotId);
    expect(second.ok, 'setup：预览读得回来').toBe(true);
    if (second.ok) expect(second.counts.askedBack, '自己造的墓碑不该预告"会问你一句"').toBe(0);

    await restoreRemoteSnapshot(deps(), newest.snapshotId, AT + 20_000);
    const back = await runSync(deps(), AT + 21_000);
    const meta = await storage.getSyncMeta();
    expect((meta.pendingConflicts ?? []).map((conflict) => conflict.groupId), '恢复自己造的墓碑不该回头拦这次恢复').toEqual([]);
    expect(back.status, '停在 conflict = 他要逐条点 19 次').toBe('idle');
    expect((await storage.listGroupIndex()).length, '本机应当就是那 5 条').toBe(5);
    // 正向对照：真的推上去了一版（不是又被 LWW 冲掉的 no-changes）
    expect(back.pushed?.revision, '撤销恢复也要留下一版，否则远端仍停在旧的那版').toBeDefined();
    const after = await listRemoteHistory(deps());
    if (!after.ok) throw new Error('setup');
    const latest = after.entries.find((entry) => entry.isLatest)!;
    expect(latest.revision).toBe(back.pushed?.revision);
  }, 30_000);

  /**
   * 对称的那一侧（不许过火）：**用户自己删的**仍然要问。
   * 既有约定 立 delete-vs-edit 的理由是"自动判错就是一次静默丢数据"，
   * 那条理由对 `user-delete` / `consumed` 一字未改。
   */
  it('墓碑来历是用户删除时，恢复回来照旧进冲突列表', async () => {
    await configure();
    await seed(0, 4, AT);
    const { softDeleteGroup } = await import('@/core/application/delete-model');
    await softDeleteGroup({ storage }, { groupId: 's2', reason: 'user-delete', at: AT + 4000 });
    await runSync(deps(), AT + 5000);

    const listed = await listRemoteHistory(deps());
    if (!listed.ok) throw new Error('setup');
    const oldest = listed.entries[listed.entries.length - 1]!;
    await restoreRemoteSnapshot(deps(), oldest.snapshotId, AT + 9000);
    const outcome = await runSync(deps(), AT + 10_000);
    expect(outcome.status).toBe('conflict');
    const pending = (await storage.getSyncMeta()).pendingConflicts ?? [];
    expect(pending.map((conflict) => conflict.groupId)).toEqual(['s2']);
    expect(pending[0]?.deleteReason).toBe('user-delete');
    // 标题在落账时抄一份：停在冲突那一轮引擎不写本机，
    // 面板去 `getGroup` 是拿不到的 —— 拿不到就只会印裸 UUID。
    expect(pending[0]?.groupTitle).toBe('会话 s2');
  }, 30_000);
});
