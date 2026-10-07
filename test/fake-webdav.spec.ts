/**
 * `infrastructure/testing/fake-webdav.ts` 的自证。
 *
 * 这个文件的意义不是"假件能用"，而是**假件没有说谎**：同步引擎以后要靠它证明
 * "上传到一半断掉""412 条件失败""远端历史快照不可变"这三件事。假件如果偷偷宽容了任何一条，
 * 那三条测试就会永远绿着，而真实服务器上它们是会炸的。
 *
 * 因此这里的断言刻意偏"仓储视角"：凡是判"对不对"，都去读 `files` / `calls` / `faults`，
 * 而不是只看 port 的返回值 —— 返回值是接口保证，落库才是引擎真正改动过的东西。
 */

import { describe, expect, it } from 'vitest';
import { createFakeWebDav, FAKE_CREDENTIAL } from '@/infrastructure/testing/fake-webdav';
import { WebDavError, type WebDavErrorKind } from '@/core/ports/webdav';

const COLLECTION = 'https://dav.test/dav/shitab/';
const SNAP_A = `${COLLECTION}snap-a.json`;
const SNAP_B = `${COLLECTION}snap-b.json`;
const MANIFEST = `${COLLECTION}manifest.json`;

async function expectFailure(run: Promise<unknown>, kind: WebDavErrorKind, status: number): Promise<WebDavError> {
  let reason: unknown;
  try {
    await run;
  } catch (caught) {
    reason = caught;
  }
  if (!(reason instanceof WebDavError)) throw new Error(`期望 WebDavError(${kind})，实际拿到 ${String(reason)}`);
  expect(reason.kind).toBe(kind);
  expect(reason.status).toBe(status);
  return reason;
}

describe('round-trip：假件当得起"可替换的双"', () => {
  it('ensureCollection 之后 put/get 是同一份文本，且真的落在 files 里', async () => {
    const fake = createFakeWebDav();
    await fake.ensureCollection(COLLECTION, FAKE_CREDENTIAL);
    await fake.put(SNAP_A, '{"revision":7}', FAKE_CREDENTIAL);

    expect(fake.files.get(SNAP_A)).toBe('{"revision":7}');
    await expect(fake.get(SNAP_A, FAKE_CREDENTIAL)).resolves.toBe('{"revision":7}');
  });

  it('put 回的 etag 与 head/metaOf 给的是同一个串：条件写下一轮就靠它', async () => {
    const fake = createFakeWebDav();
    await fake.ensureCollection(COLLECTION, FAKE_CREDENTIAL);
    const { etag } = await fake.put(SNAP_A, 'a', FAKE_CREDENTIAL);
    const head = await fake.head(SNAP_A, FAKE_CREDENTIAL);
    expect(etag).toBeDefined();
    expect(head.etag).toBe(etag);
    expect(fake.metaOf(SNAP_A).etag).toBe(etag);
    expect(head).toMatchObject({ url: SNAP_A, exists: true, isDirectory: false, contentLength: 1 });
  });

  it('If-Match 用对了 etag 才放行，用错了得到 precondition-failed', async () => {
    const fake = createFakeWebDav();
    await fake.ensureCollection(COLLECTION, FAKE_CREDENTIAL);
    const { etag } = await fake.put(MANIFEST, 'v1', FAKE_CREDENTIAL);
    fake.immutable = false; // manifest 本来就是要重写的资源：关掉的是不可变纪律，不是条件写

    await expectFailure(fake.put(MANIFEST, 'v2', FAKE_CREDENTIAL, { ifMatch: '"不存在的etag"' }), 'precondition-failed', 412);
    await expect(fake.put(MANIFEST, 'v2', FAKE_CREDENTIAL, { ifMatch: etag })).resolves.toBeDefined();
    expect(fake.files.get(MANIFEST)).toBe('v2');
  });

  it('If-None-Match: * 撞上一个已有路径就是 412 —— 不可变快照"只写一次"靠这个', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'already' } });
    await expectFailure(fake.put(SNAP_A, 'another', FAKE_CREDENTIAL, { ifNoneMatch: '*' }), 'precondition-failed', 412);
    // 没写进去才是重点：412 之后仓储必须一个字节都没变
    expect(fake.files.get(SNAP_A)).toBe('already');
  });

  it('propfind depth 0 只回自己，depth 1 只多一层直接子项', async () => {
    const fake = createFakeWebDav({
      files: { [SNAP_A]: 'a', [SNAP_B]: 'b', [`${COLLECTION}sub/deep.json`]: 'd' },
      collections: [COLLECTION, `${COLLECTION}sub/`],
    });

    const shallow = await fake.propfind(COLLECTION, FAKE_CREDENTIAL, 0);
    expect(shallow.map((meta) => meta.url)).toEqual([COLLECTION]);
    expect(shallow[0]).toMatchObject({ exists: true, isDirectory: true });

    const deep = await fake.propfind(COLLECTION, FAKE_CREDENTIAL, 1);
    // 真服务器的条目顺序不是合同（自家目录在前、孩子按 inode 序都有可能），
    // 所以假件给一个**排过序**的稳定顺序：不然测试会在无关改动上随机失败。
    expect(deep.map((meta) => meta.url)).toEqual([
      COLLECTION,
      SNAP_A,
      SNAP_B,
      `${COLLECTION}sub/`,
    ]);
    // 孙层不能出现在 Depth:1 里：出现了就等于在递归列举，几千个快照时一次同步变成一次全盘扫描
    expect(deep.map((meta) => meta.url)).not.toContain(`${COLLECTION}sub/deep.json`);
    expect(deep.find((meta) => meta.url === `${COLLECTION}sub/`)).toMatchObject({ isDirectory: true });
    expect(deep.find((meta) => meta.url === SNAP_A)).toMatchObject({ isDirectory: false, contentLength: 1 });
  });

  it('head 对不存在的路径给 exists:false 而不是抛错：这是答案，不是故障', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION] });
    await expect(fake.head(`${COLLECTION}missing.json`, FAKE_CREDENTIAL)).resolves.toEqual({
      url: `${COLLECTION}missing.json`,
      exists: false,
      isDirectory: false,
    });
  });

  it('get 对不存在的资源抛 not-found（404 在取载荷时确实是失败）', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION] });
    await expectFailure(fake.get(SNAP_A, FAKE_CREDENTIAL), 'not-found', 404);
  });
});

describe('远端历史快照不可变（§5 规则 3/4）', () => {
  it('默认 immutable=true：覆盖一个内容不同的已有路径得到 precondition-failed', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'original' } });
    const error = await expectFailure(fake.put(SNAP_A, 'rewritten', FAKE_CREDENTIAL), 'precondition-failed', 412);
    expect(error.method).toBe('PUT');
    expect(fake.files.get(SNAP_A)).toBe('original');
  });

  it('同内容重写是幂等的：不换 etag、不动 lastModified，否则"内容没变就别新建快照"永远测不出来', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'same' } });
    const before = await fake.head(SNAP_A, FAKE_CREDENTIAL);
    const again = await fake.put(SNAP_A, 'same', FAKE_CREDENTIAL);
    const after = await fake.head(SNAP_A, FAKE_CREDENTIAL);

    expect(again.etag).toBe(before.etag);
    expect(after.etag).toBe(before.etag);
    expect(after.lastModified).toBe(before.lastModified);
  });

  it('关掉开关才能重写：这条规则只能被显式绕过，所以开关必须是显式的', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'original' } });
    fake.immutable = false;
    await expect(fake.put(SNAP_A, 'rewritten', FAKE_CREDENTIAL)).resolves.toBeDefined();
    expect(fake.files.get(SNAP_A)).toBe('rewritten');
    expect(fake.metaOf(SNAP_A).lastModified).toBeGreaterThan(1_700_000_000_000);
  });

  it('后写的资源 lastModified 一定更大（虚拟时钟，不受跑表与 CI 机器影响）', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION] });
    await fake.put(SNAP_A, 'a', FAKE_CREDENTIAL);
    await fake.put(SNAP_B, 'b', FAKE_CREDENTIAL);
    const first = await fake.head(SNAP_A, FAKE_CREDENTIAL);
    const second = await fake.head(SNAP_B, FAKE_CREDENTIAL);
    expect(second.lastModified!).toBeGreaterThan(first.lastModified!);
  });
});

describe('故障注入：场景要能表达，也要能被证明只发作一次', () => {
  it('按路径注入的 503 命中一次就消失：第二次必须成功，否则测不出重试收敛', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'body' } });
    fake.faults.set(SNAP_A, 503);
    await expectFailure(fake.get(SNAP_A, FAKE_CREDENTIAL), 'server', 503);
    expect(fake.faults.size).toBe(0);
    await expect(fake.get(SNAP_A, FAKE_CREDENTIAL)).resolves.toBe('body');
  });

  it('有序队列能表达"传到第 2 个快照时断掉"：断掉那一次不改动仓储，重试就过去了', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION] });
    fake.nextFault({ method: 'PUT', url: SNAP_B, status: 503 });

    await fake.put(SNAP_A, 'a', FAKE_CREDENTIAL);
    await expectFailure(fake.put(SNAP_B, 'b', FAKE_CREDENTIAL), 'server', 503);
    expect([...fake.files.keys()]).toEqual([SNAP_A]);
    expect(fake.nextFaults).toHaveLength(0);

    await fake.put(SNAP_B, 'b', FAKE_CREDENTIAL);
    expect([...fake.files.keys()]).toEqual([SNAP_A, SNAP_B]);
  });

  it('不带过滤的队列项就是"第 k 次调用坏"：依次命中，第 3 次恢复正常', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'body' } });
    fake.nextFault(503);
    fake.nextFault(412);
    await expectFailure(fake.get(SNAP_A, FAKE_CREDENTIAL), 'server', 503);
    await expectFailure(fake.get(SNAP_A, FAKE_CREDENTIAL), 'precondition-failed', 412);
    await expect(fake.get(SNAP_A, FAKE_CREDENTIAL)).resolves.toBe('body');
    expect(fake.nextFaults).toHaveLength(0);
  });

  it('带 method 过滤的队列项会跳过不匹配的调用：队列说的是"第 k 次 PUT 坏"，不是"第 k 次任何请求坏"', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'body' }, collections: [COLLECTION] });
    fake.nextFault({ method: 'MOVE', status: 412 });
    // GET 不消耗队列：否则一次读就把故障"用掉了"，MOVE 那条永远测不到
    await expect(fake.get(SNAP_A, FAKE_CREDENTIAL)).resolves.toBe('body');
    expect(fake.nextFaults).toHaveLength(1);
  });

  it('注入的状态码走的还是 port 那张分类表：401/403/412/409 各自得到自己的 kind', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'body' } });
    for (const [status, kind] of [
      [401, 'credentials'],
      [403, 'forbidden'],
      [409, 'parent-conflict'],
      [412, 'precondition-failed'],
      [405, 'unsupported-method'],
      [503, 'server'],
      [400, 'bad-response'],
    ] as const) {
      fake.faults.set(SNAP_A, status);
      await expectFailure(fake.get(SNAP_A, FAKE_CREDENTIAL), kind, status);
    }
  });

  it('凭据检查先于故障：没登录在真服务器上根本走不到业务逻辑，故障也就不该被消耗', async () => {
    const fake = createFakeWebDav({
      files: { [SNAP_A]: 'body' },
      expectedCredential: { username: 'u', password: 'p' },
    });
    fake.faults.set(SNAP_A, 503);
    await expectFailure(fake.get(SNAP_A, { username: 'u', password: 'wrong' }), 'credentials', 401);
    expect(fake.faults.get(SNAP_A)).toBe(503);
    await expectFailure(fake.get(SNAP_A, { username: 'u', password: 'p' }), 'server', 503);
  });

  it('配了 expectedCredential 时用户名也要对上（只测密码会漏掉填反了的用户名）', async () => {
    const fake = createFakeWebDav({
      collections: [COLLECTION],
      expectedCredential: { username: 'u', password: 'p' },
    });
    await expectFailure(fake.head(COLLECTION, { username: 'other', password: 'p' }), 'credentials', 401);
    await expect(fake.head(COLLECTION, { username: 'u', password: 'p' })).resolves.toMatchObject({ exists: true });
  });
});

describe('假件比真服务器更严的那一处：忘了 ensureCollection', () => {
  it('父集合不存在时 PUT 得到 parent-conflict（409），而不是静默凭空建目录', async () => {
    const fake = createFakeWebDav();
    await expectFailure(fake.put(SNAP_A, 'a', FAKE_CREDENTIAL), 'parent-conflict', 409);
    expect(fake.files.has(SNAP_A)).toBe(false);
  });

  it('ensureCollection 对已存在的集合是 no-op 成功：这条路径的语义是"确保有"', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION] });
    await expect(fake.ensureCollection(COLLECTION, FAKE_CREDENTIAL)).resolves.toBeUndefined();
    // 逐级都打了 MKCOL，与真服务器的请求次数一致（calls 是"服务器看到的动词"）
    expect(fake.calls.map((call) => call.method)).toEqual(['MKCOL', 'MKCOL']);
    await expect(fake.put(SNAP_A, 'a', FAKE_CREDENTIAL)).resolves.toBeDefined();
  });

  it('只读前缀下的写得到 forbidden：403 的分支也得能被测到', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION], readOnlyPrefixes: [COLLECTION] });
    await expectFailure(fake.put(SNAP_A, 'a', FAKE_CREDENTIAL), 'forbidden', 403);
    // 读不受影响：只读的是写权限，不是整个目录
    await expect(fake.head(COLLECTION, FAKE_CREDENTIAL)).resolves.toMatchObject({ exists: true });
  });
});

describe('move 的条件语义', () => {
  it('Overwrite:false 撞上已有目标 ⇒ precondition-failed，且源还在', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'a', [SNAP_B]: 'b' } });
    await expectFailure(fake.move(SNAP_A, SNAP_B, false, FAKE_CREDENTIAL), 'precondition-failed', 412);
    expect(fake.files.get(SNAP_A)).toBe('a');
    expect(fake.files.get(SNAP_B)).toBe('b');
  });

  it('Overwrite:true 才换内容，源消失、目标带上新 etag', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'a', [SNAP_B]: 'b' } });
    await fake.move(SNAP_A, SNAP_B, true, FAKE_CREDENTIAL);
    expect(fake.files.has(SNAP_A)).toBe(false);
    expect(fake.files.get(SNAP_B)).toBe('a');
    expect((await fake.head(SNAP_B, FAKE_CREDENTIAL)).etag).toBeDefined();
  });

  it('源不存在 ⇒ not-found；目标父集合不存在 ⇒ parent-conflict', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION] });
    await expectFailure(fake.move(`${COLLECTION}ghost.json`, SNAP_A, false, FAKE_CREDENTIAL), 'not-found', 404);

    const other = createFakeWebDav({ files: { [SNAP_A]: 'a' } });
    await expectFailure(
      other.move(SNAP_A, 'https://dav.test/nowhere/x.json', false, FAKE_CREDENTIAL),
      'parent-conflict',
      409,
    );
  });

  it('移走的是远端历史快照这件事不会发生：port 只在 manifest 上用 MOVE，而快照永远不 MOVE 不 DELETE', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'a' } });
    await fake.move(SNAP_A, MANIFEST, false, FAKE_CREDENTIAL);
    expect(fake.calls.map((call) => call.method)).toEqual(['MOVE']);
    // 不可变性只约束 PUT：MOVE 换路径不改变内容，真服务器也不会把它判成覆盖历史
    expect(fake.files.get(MANIFEST)).toBe('a');
  });
});

describe('调用轨迹', () => {
  it('按发生顺序记录，且记的是真服务器看到的动词', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION] });
    await fake.testConnection(COLLECTION, FAKE_CREDENTIAL);
    await fake.put(SNAP_A, 'a', FAKE_CREDENTIAL);
    await fake.get(SNAP_A, FAKE_CREDENTIAL);
    await fake.head(SNAP_B, FAKE_CREDENTIAL);
    await fake.propfind(COLLECTION, FAKE_CREDENTIAL, 1);
    await fake.move(SNAP_A, MANIFEST, false, FAKE_CREDENTIAL);

    expect(fake.calls).toEqual([
      // testConnection 在内层是 PROPFIND，不是某个自造动词
      { method: 'PROPFIND', url: COLLECTION },
      { method: 'PUT', url: SNAP_A },
      { method: 'GET', url: SNAP_A },
      { method: 'HEAD', url: SNAP_B },
      { method: 'PROPFIND', url: COLLECTION },
      { method: 'MOVE', url: SNAP_A },
    ]);
  });

  it('testConnection 一个字节都不写：files 与 dirs 在调用前后完全一致', async () => {
    const fake = createFakeWebDav({ files: { [SNAP_A]: 'a' } });
    const filesBefore = [...fake.files];
    const dirsBefore = [...fake.dirs];
    await fake.testConnection(COLLECTION, FAKE_CREDENTIAL);
    expect([...fake.files]).toEqual(filesBefore);
    expect([...fake.dirs]).toEqual(dirsBefore);
    expect(fake.calls.every((call) => call.method === 'PROPFIND')).toBe(true);
  });

  it('testConnection 看不见的路径抛 not-found：填错 baseUrl 要当场发现，而不是"连上了但同步没动静"', async () => {
    const fake = createFakeWebDav({ collections: [COLLECTION] });
    await expectFailure(fake.testConnection('https://dav.test/dav/typo/', FAKE_CREDENTIAL), 'not-found', 404);
  });
});
