/**
 * 远端历史面板的界面用例（既有约定：加载态与结果语气）。
 *
 * 这一层以前**完全没有界面用例** —— 模型层（`test/snapshot-history.spec.ts`）有 14 条，
 * 但"点下去有没有反馈"这件事只在模型层测不到。用户真机报的正是这一层：
 * 「读取远端历史」点下去几秒内屏幕一动不动。
 *
 * 端口是注入的（`props.webdav` / `props.admin`），并且用一道闸把请求挂住，
 * 才看得见"进行中"那一瞬 —— 不挂住就只能断言"点完之后"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import SnapshotHistoryPanel from '@/components/SnapshotHistoryPanel.vue';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { createFakeWebDav, FAKE_CREDENTIAL } from '@/infrastructure/testing/fake-webdav';
import type { FakeWebDavPort } from '@/infrastructure/testing/fake-webdav';
import type { StoragePort } from '@/core/ports/storage';
import type { RemoteResourceMeta, WebDavCredential } from '@/core/ports/webdav';
import { runSync } from '@/core/application/sync-engine';
import {
  manifestUrl,
  manifestsDirUrl,
  parseBaseUrl,
  pointerUrl,
  snapshotUrl,
  snapshotsDirUrl,
} from '@/core/domain/remote-layout';
import type { DevicePointer, ManifestEntry, SyncManifest, SyncPointer } from '@/shared/types';
import { groupFixture, savedTabFixture } from './fixtures';

const BASE = 'https://host/dav';
const AT = 1_700_000_000_000;

let storage: StoragePort;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(predicate: () => boolean, label: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`等不到：${label}（${timeoutMs}ms 内）`);
}

/**
 * 把 `propfind` 换成"等一道闸"的版本。**必须在种子数据推完之后才挂**——
 * `runSync` 自己第一步就是 propfind，先挂再推等于把播种也一起卡死（我第一版就是这么写的）。
 */
/**
 * 把端口下一次要发的网络请求挂住，用来观察**请求还在飞**那一瞬间的界面。
 *
 * ★ 它原来叫 `gatePropfind`、只挂 `propfind`。而"读取远端历史"的第一步在 既有约定
 * 之后变成了读指针（一次 `get`），于是这个 gate 谁也没挂住 —— 按钮一瞬间就跑完了，
 * 用例红在 `aria-busy` 不是 true 上。
 *
 * 这一条钉的从来不是"面板发的是哪个动词"，是 既有约定 那句
 * 「网络动作必须有看得见的进行中状态」。所以改的是**挂住哪些动词**（两个都挂），
 * 而不是把断言放宽成"不转圈也算对" —— 后者会把这条不变量连同红字一起删掉。
 */
function gateNetworkCall(port: FakeWebDavPort): () => void {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const method of ['propfind', 'get'] as const) {
    const original = (port[method] as unknown) as (...args: unknown[]) => Promise<unknown>;
    (port[method] as unknown) = async (...args: unknown[]) => {
      await gate;
      return original(...args);
    };
  }
  return () => release();
}

/** 先真推 N 版，让"服务器上有历史"这件事是用例的前提而不是假设。 */
async function pushVersions(port: FakeWebDavPort, count: number): Promise<void> {
  await storage.setWebDavConfig({
    enabled: true,
    baseUrl: BASE,
    username: FAKE_CREDENTIAL.username,
    allowInsecureHttp: false,
    lastTestedAt: AT,
  });
  await storage.setSyncCredential(FAKE_CREDENTIAL.password);
  for (let index = 0; index < count; index += 1) {
    await storage.putGroup(
      groupFixture(`会话 v${index}`, [savedTabFixture(`v${index}`, `v${index}-t0`, 0)], {
        id: `v${index}`,
        sortOrder: index,
        updatedAt: AT + index * 1000,
      }),
    );
    await runSync({ storage, webdav: port }, AT + index * 1000);
  }
}

/**
 * 每条用例结束前等到没有按钮在转圈，再卸载。
 * 面板的异步链不会随用例结束而停下，下一条的 `storage.local.clear()` 就落在它中间 ——
 * 同类串台在同步面板那边已经实测到过（`calls=[]` + "Sync failed"，只在多文件并行时命中）。
 */
const mounted: VueWrapper[] = [];

function mountPanel(port: FakeWebDavPort): VueWrapper {
  const wrapper = mount(SnapshotHistoryPanel, { props: { webdav: port, admin: port } });
  mounted.push(wrapper);
  return wrapper;
}

async function settleAll(): Promise<void> {
  for (const wrapper of mounted.splice(0)) {
    const deadline = Date.now() + 8_000;
    while (wrapper.find('[aria-busy="true"]').exists() && Date.now() < deadline) await flush();
    wrapper.unmount();
  }
}

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  storage = createStoragePort();
  await storage.heal();
});

afterEach(async () => {
  await settleAll();
});

describe('远端历史面板的进行中状态', () => {
  it('点「读取远端历史」⇒ 这颗转圈并换成 Reading…，跑完才停、列表才出来', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 2);
    const release = gateNetworkCall(port);
    const wrapper = mountPanel(port);
    await flush();

    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await flush();

    const button = wrapper.find('[data-testid="history-load"]');
    expect(button.attributes('aria-busy')).toBe('true');
    expect(button.find('[data-testid="action-spinner"]').exists()).toBe(true);
    expect(button.text()).toBe('Reading…');
    expect((button.element as HTMLButtonElement).disabled).toBe(true);

    release();
    await until(
      () => wrapper.find('[data-testid="history-load"]').attributes('aria-busy') === 'false',
      '读取结束、转圈停下',
    );
    const done = wrapper.find('[data-testid="history-load"]');
    expect(done.find('[data-testid="action-spinner"]').exists()).toBe(false);
    expect(done.text()).toBe('Load remote history');
    expect(wrapper.findAll('[data-testid="history-row"]').length).toBeGreaterThan(0);
  }, 20_000);

  /**
   * 这一条钉的是 ActionButton 存在的第二个理由：
   * 这三颗按钮以前**没有任何禁用样式**（`disabled:` 计数是 0），
   * 没勾确认时的「清理远端历史」和能点的按钮长得一模一样。
   */
  it('没勾确认时「清理远端历史」既禁用、又看得出来禁用', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 2);
    const wrapper = mountPanel(port);
    await flush();

    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => wrapper.findAll('[data-testid="history-row"]').length > 0, '列表出来');

    const prune = wrapper.find('[data-testid="history-prune"]');
    expect((prune.element as HTMLButtonElement).disabled).toBe(true);
    expect(prune.classes()).toContain('disabled:opacity-40');
    expect(prune.classes()).toContain('disabled:cursor-not-allowed');

    await wrapper.find('[data-testid="history-confirm"]').setValue(true);
    expect((wrapper.find('[data-testid="history-prune"]').element as HTMLButtonElement).disabled).toBe(false);
  }, 20_000);

  it('恢复只让被点那一行转圈，别的行只禁用', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 2);
    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => wrapper.findAll('[data-testid="history-row"]').length >= 2, '两版历史都列出来');

    // 转圈只有一瞬，而预览与恢复之间还插进来一格确认行（会重排 DOM）——
    // 所以这里把网络挂住再断言，而不是指望一次 `flush()` 恰好抓得到。
    // 选择器也要收窄：`history-restore-` 这个前缀现在同时命中确认行里的两颗按钮。
    const release = gateNetworkCall(port);
    const rowButtons = () => wrapper.findAll('[data-testid^="history-restore-"][data-testid$="-1"], [data-testid^="history-restore-"][data-testid$="-2"]');
    expect(rowButtons().length).toBe(2);
    await rowButtons()[1]!.trigger('click');
    await flush();

    const spinning = rowButtons()[1]!;
    expect(spinning.find('[data-testid="action-spinner"]').exists()).toBe(true);
    expect(spinning.attributes('aria-busy')).toBe('true');
    // 另一行：禁用但不转 —— 两个动作同时在飞也没有意义
    expect(rowButtons()[0]!.find('[data-testid="action-spinner"]').exists()).toBe(false);
    expect((rowButtons()[0]!.element as HTMLButtonElement).disabled).toBe(true);
    release();

    // ★ 第一下只是预览（既有约定 的两下点击）：结果句要等第二下，所以这里补上确认那一下。
    await until(() => wrapper.find('[data-testid="history-restore-confirm"]').exists(), '确认行出来');
    await wrapper.find('[data-testid="history-restore-yes"]').trigger('click');
    await until(
      () => wrapper.find('[data-testid="history-message"]').exists(),
      '恢复之后那行结果落下来',
    );
    const message = wrapper.find('[data-testid="history-message"]');
    expect(message.text()).toContain('✓');
    expect(message.classes()).toContain('text-brand');
    expect(message.attributes('role')).toBe('status');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 每一行的第二行字：这一版是**几点、由哪台设备**推上去的，以及总数那句"至少共"。
//
// 这两件事原来在界面上都没有。时间戳与 deviceId 本来就躺在 `ManifestEntry` 里，
// 名字躺在 manifest 的 `devices` 表里 —— 也就是说**一次请求都不用多发**就能显示，
// 只是没人显示。体量则相反：它原来来自逐条 `HEAD`，而 HEAD 的 `Content-Length`
// 在坚果云那类主机上是"响应体长度"（= 0），于是六行 `0 B` 印在屏幕上，
// 而用户那 13 个快照文件最小的一个也是 325 B。
// ---------------------------------------------------------------------------

const PARSED = parseBaseUrl(BASE);
if (!PARSED.ok) throw new Error(`setup：${BASE} 应当是合法地址`);
/** 收窄在模块顶层做一次：`PARSED.url` 进了函数体就丢掉窄化（TS 不在闭包里保留它）。 */
const BASE_URL: URL = PARSED.url;
const SNAP = snapshotsDirUrl(BASE_URL).href;
const MANI = manifestsDirUrl(BASE_URL).href;

const SNAP_NEWER = '3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c';
const SNAP_OLDER = '00112233445566778899aabbccddeeff';
/** 设备表里有的那一台（名字解析得出）。 */
const NAMED: DevicePointer = {
  id: '11111111-2222-3333-4444-555555555555',
  name: '办公室那台 Edge',
  updatedAt: 1_700_000_222_000,
};
/** 设备表里没有的那一台（只能回退 UUID 前 8 位）。 */
const ANON_ID = 'aabbccdd-4455-6677-8899-001122334455';
const PUSHED_LATER = 1_700_000_222_000;
const PUSHED_EARLIER = 1_699_999_111_000;

/**
 * 手播一台"远端已经有两版历史"的假服务器，绕开 `runSync`。
 *
 * 为什么手播：面板读历史只要 **manifest + 一次目录列举**，从不读快照正文
 * （JOB 1 之后更是如此），所以正文写什么都行；而 `deviceId` / `createdAt` / `devices`
 * 这三样必须能被逐字控制 —— 真推的话每一版都是"本机、此刻、同一个名字"，
 * 那种数据里"名字解析不出来的那一格"根本不存在，回退那一支就永远测不到。
 */
function seedRemoteHistory(devices: DevicePointer[] | undefined): FakeWebDavPort {
  const history: ManifestEntry[] = [
    { snapshotId: SNAP_NEWER, revision: 2, deviceId: NAMED.id, createdAt: PUSHED_LATER, stateChecksum: `${SNAP_NEWER}checksum` },
    { snapshotId: SNAP_OLDER, revision: 1, deviceId: ANON_ID, createdAt: PUSHED_EARLIER, stateChecksum: `${SNAP_OLDER}checksum` },
  ];
  const manifest: SyncManifest = {
    format: 'shitab-manifest',
    version: 1,
    latestRevision: 2,
    latestSnapshotId: SNAP_NEWER,
    updatedAt: PUSHED_LATER,
    deviceIds: [NAMED.id, ANON_ID],
    history,
    // 「没有设备表」与「设备表是空的」对界面是同一件事：都解析不出名字 ⇒ 回退 UUID 前缀。
    // 但载荷里缺席才是真形状（老 manifest 根本没这个键），所以这里两种都播得出来。
    ...(devices === undefined ? {} : { devices }),
  };
  const pointer: SyncPointer = {
    format: 'shitab-pointer',
    version: 1,
    revision: 2,
    snapshotId: SNAP_NEWER,
    updatedAt: PUSHED_LATER,
  };
  return createFakeWebDav({
    expectedCredential: FAKE_CREDENTIAL,
    collections: [SNAP, MANI],
    files: {
      [pointerUrl(BASE_URL).href]: JSON.stringify(pointer),
      [manifestUrl(BASE_URL, 2).href]: JSON.stringify(manifest),
      [snapshotUrl(BASE_URL, SNAP_NEWER).href]: '{"state":"较新的那一版"}',
      [snapshotUrl(BASE_URL, SNAP_OLDER).href]: '{"state":"较旧的那一版，内容更长一点"}',
    },
  });
}

/**
 * 面板读的是 `shared/services` 里那个真 storage 端口，所以"服务器配好了"这件事
 * 必须落在盘上 —— 只把假 WebDAV 递进 props 是不够的：`listRemoteHistory` 第一步就读
 * `getWebDavConfig()`，没开就 return `{ok:false,reason:'disabled'}`，界面只显示一行错误、
 * 列表永远是空的（那种红看起来像"面板坏了"，其实是种子没播全）。
 */
async function configureStorage(): Promise<void> {
  await storage.setWebDavConfig({
    enabled: true,
    baseUrl: BASE,
    username: FAKE_CREDENTIAL.username,
    allowInsecureHttp: false,
    lastTestedAt: AT,
  });
  await storage.setSyncCredential(FAKE_CREDENTIAL.password);
}

/** 点开「读取远端历史」并等到两行都出来。 */
async function loadTwoRows(port: FakeWebDavPort): Promise<VueWrapper> {
  await configureStorage();
  const wrapper = mountPanel(port);
  await flush();
  await wrapper.find('[data-testid="history-load"]').trigger('click');
  await until(() => wrapper.findAll('[data-testid="history-row"]').length === 2, '两版历史都列出来');
  return wrapper;
}

/** 按 revision 取那一行（列表是新→旧，但断言不该靠这个顺序活着）。 */
function rowOf(wrapper: VueWrapper, revision: number) {
  return wrapper.findAll('[data-testid="history-row"]').find((row) => row.text().includes(`revision ${revision}`))!;
}

describe('远端历史每一行的时间与设备', () => {
  it('写着推送时间与设备名，当前徽章还在版本号后面', async () => {
    const wrapper = await loadTwoRows(seedRemoteHistory([NAMED]));
    const newer = rowOf(wrapper, 2);

    expect(newer.text()).toContain('办公室那台 Edge');
    // 真文案：`toLocaleString()`，与「上次同步」那一行同一个格式（SyncPanel.vue:407）
    expect(newer.text()).toContain(new Date(PUSHED_LATER).toLocaleString());
    // 「当前」徽章还在原位：紧跟在版本号后面、在这行字的开头部分
    expect(newer.find('[data-testid="history-current"]').exists()).toBe(true);
    expect(newer.text().indexOf('revision 2')).toBeLessThan(newer.text().indexOf('current'));

    // 反面 + 正向对照：这一行不许露出裸 UUID；而它也不许沾到另一版的时间
    expect(newer.text()).not.toContain('11111111-2222');
    expect(newer.text()).not.toContain(new Date(PUSHED_EARLIER).toLocaleString());
    expect(newer.text()).not.toContain(String(PUSHED_LATER));

    const older = rowOf(wrapper, 1);
    expect(older.text()).toContain(new Date(PUSHED_EARLIER).toLocaleString());
    expect(older.find('[data-testid="history-current"]').exists()).toBe(false);
  }, 20_000);

  /**
   * 解析不到名字时不许在屏幕上留空：回退成 UUID 前 8 位 —— 与冲突面板同一条口径
   * （`components/ConflictPanel.vue:39`），"一眼看得出是机器身份"比编一个名字诚实。
   */
  it('设备表里查不到那一台 ⇒ 显示 id 的前 8 位，不是空、也不是整串 UUID', async () => {
    const wrapper = await loadTwoRows(seedRemoteHistory([NAMED]));
    const anon = rowOf(wrapper, 1);
    expect(anon.text()).toContain('aabbccdd');
    expect(anon.text()).not.toContain(ANON_ID);
    // 正向对照：同一屏上设备表里有的那一台显示的是名字，所以那一格不是把所有名字都印成前缀
    expect(rowOf(wrapper, 2).text()).toContain('办公室那台 Edge');
    expect(rowOf(wrapper, 2).text()).not.toContain('aabbccdd');
  }, 20_000);

  it('老 manifest 压根没有设备表 ⇒ 两行都回退成前缀（历史照列，不因此报错）', async () => {
    const wrapper = await loadTwoRows(seedRemoteHistory(undefined));
    expect(rowOf(wrapper, 2).text()).toContain('11111111');
    expect(rowOf(wrapper, 1).text()).toContain('aabbccdd');
    // 正向对照：设备表在的那一版确实印得出名字（见上面两条），所以这里的回退来自"没有表"
    expect(rowOf(wrapper, 2).text()).not.toContain('办公室那台 Edge');
    expect(wrapper.find('[data-testid="history-message"]').exists(), '这只是信息不全，不是故障').toBe(false);
  }, 20_000);
});

/**
 * ★ 总数那一句在"有些大小问不出来"时必须说成**下限**。
 *
 * 沉默地把不知道的那几版漏掉、然后印一个"共 X"，是一个会被当真的假数：
 * 用户据此判断"清理能省多少空间"，而那个数比真值小。
 */
describe('远端历史总数的诚实口径', () => {
  /** 把某一版从列举结果里的 `contentLength` 摘掉（真主机漏给 `getcontentlength` 就是这个形状）。 */
  function hideSizeOf(port: FakeWebDavPort, url: string): void {
    const original = port.propfind.bind(port);
    port.propfind = async (target: string, credential: WebDavCredential, depth: 0 | 1) => {
      const listing = await original(target, credential, depth);
      return listing.map((meta: RemoteResourceMeta) =>
        meta.url === url ? { url: meta.url, exists: meta.exists, isDirectory: meta.isDirectory } : meta,
      );
    };
  }

  it('有一版没报大小 ⇒ 总数说「至少共」并点出有几版没报，那一行的体量是 —', async () => {
    const port = seedRemoteHistory([NAMED]);
    hideSizeOf(port, snapshotUrl(BASE_URL, SNAP_OLDER).href);
    const wrapper = await loadTwoRows(port);

    const total = wrapper.find('[data-testid="history-total"]').text();
    expect(total).toContain('at least');
    expect(total).toContain('1 of them reported no size');
    // 那一行的体量是「不知道」那个字符，不是 0
    expect(rowOf(wrapper, 1).find('[data-testid="history-size"]').text()).toBe('—');

    // 正向对照：同一份种子、不摘大小时，同一行说的是精确总数，那一行也印得出真实字节数
    const clean = await loadTwoRows(seedRemoteHistory([NAMED]));
    expect(clean.find('[data-testid="history-total"]').text()).not.toContain('at least');
    expect(rowOf(clean, 1).find('[data-testid="history-size"]').text()).toMatch(/^\d+ B$/);
    expect(rowOf(clean, 1).find('[data-testid="history-size"]').text()).not.toBe('—');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// ★ 清单的**长度**与清理那一格的**位置**（2026-10-08 真机：「远端历史也很长」）。
//
// 不可变历史是"永不删"的设计，攒到上百版是常态。这一节钉的三件事各管一半：
// 1. 一次只列最近 20 版，其余靠「显示更早」在**本地**翻页 —— 不许多发一次请求
//    （坚果云免费档 600 请求 / 30 分钟，而这份清单已经一次读完了）。
// 2. 顶上那句总数报的是**全部**条数：翻页把列表变短，但没把远端变短，
//    把"看得见的条数"当成"服务器上的条数"会让人以为不用清理。
// 3. 「清理远端历史」在清单**上面**：它原来在最底部，上百版之后要滚过整份清单才够得着，
//    而它恰恰是唯一那一格能腾出空间的动作。
// ---------------------------------------------------------------------------

/**
 * 手播一台"远端已经有 `count` 版历史"的假服务器。
 *
 * 走 `runSync` 推 25 版当然也行，但那 25 轮里每一轮的内容都是"又多一个会话"，
 * 时间与设备身份全是本机此刻的同一套 —— 这里要的只是**条数**这一维，
 * 而 `listRemoteHistory` 只读 manifest 的 `history` 与一次 `snapshots/` 列举，
 * 从不读快照正文。快照文件照播，是为了让体量问得出数（否则总数那句会拐去"至少共"那一版文案）。
 */
function seedManyVersions(count: number): FakeWebDavPort {
  const history: ManifestEntry[] = Array.from({ length: count }, (_, index) => {
    const revision = index + 1;
    const snapshotId = revision.toString(16).padStart(32, '0');
    return {
      snapshotId,
      revision,
      deviceId: NAMED.id,
      createdAt: PUSHED_EARLIER + revision * 1000,
      stateChecksum: `${snapshotId}checksum`,
    };
  });
  const latest = history[count - 1] as ManifestEntry;
  const manifest: SyncManifest = {
    format: 'shitab-manifest',
    version: 1,
    latestRevision: count,
    latestSnapshotId: latest.snapshotId,
    updatedAt: latest.createdAt,
    deviceIds: [NAMED.id],
    history,
    devices: [NAMED],
  };
  const pointer: SyncPointer = {
    format: 'shitab-pointer',
    version: 1,
    revision: count,
    snapshotId: latest.snapshotId,
    updatedAt: latest.createdAt,
  };
  return createFakeWebDav({
    expectedCredential: FAKE_CREDENTIAL,
    collections: [SNAP, MANI],
    files: {
      [pointerUrl(BASE_URL).href]: JSON.stringify(pointer),
      [manifestUrl(BASE_URL, count).href]: JSON.stringify(manifest),
      ...Object.fromEntries(history.map((item) => [snapshotUrl(BASE_URL, item.snapshotId).href, '{"state":"占位正文"}'])),
    },
  });
}

/** 点开读取并等到第一屏出来。 */
async function loadPaged(port: FakeWebDavPort): Promise<VueWrapper> {
  await configureStorage();
  const wrapper = mountPanel(port);
  await flush();
  await wrapper.find('[data-testid="history-load"]').trigger('click');
  await until(() => wrapper.findAll('[data-testid="history-row"]').length > 0, '第一屏出来');
  return wrapper;
}

const rowsShown = (wrapper: VueWrapper): number => wrapper.findAll('[data-testid="history-row"]').length;

describe('远端历史一屏只列最近 20 版', () => {
  it('25 版时先列 20 版，那颗按钮报的是还剩几条，点一下补齐 ⇒ 补齐之后按钮消失', async () => {
    const wrapper = await loadPaged(seedManyVersions(25));

    expect(rowsShown(wrapper), '一屏的上限就是 20，不是"看起来差不多了"').toBe(20);
    // ★ 正向对照（这条判据的关键一半）：列表变短了，但**顶上那句说的还是全部 25 版**。
    const total = wrapper.find('[data-testid="history-total"]');
    expect(total.text()).toContain('25 snapshots');
    expect(total.text(), '不许把"看得见的条数"报成"服务器上的条数"').not.toContain('20 snapshots');

    const more = wrapper.find('[data-testid="history-show-earlier"]');
    expect(more.exists(), '还有 5 版没列出来时那颗按钮必须在').toBe(true);
    expect(more.text()).toBe('Show 5 earlier snapshots');

    await more.trigger('click');
    await flush();
    expect(rowsShown(wrapper)).toBe(25);
    expect(wrapper.find('[data-testid="history-show-earlier"]').exists(), '翻到底了还挂着按钮就是还有一个动作可做').toBe(false);
    expect(wrapper.find('[data-testid="history-all-shown"]').text()).toContain('All 25 snapshots are listed');
  }, 30_000);

  /**
   * 对称的那一侧：不满一屏时**不许**出现那颗按钮。
   * 只测"多了才出现"的话，实现写成"永远显示"照样绿。
   */
  it('只有 2 版时没有「显示更早」，也没有那句「已全部列出」', async () => {
    const wrapper = await loadPaged(seedRemoteHistory([NAMED]));

    expect(rowsShown(wrapper)).toBe(2);
    expect(wrapper.find('[data-testid="history-show-earlier"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="history-all-shown"]').exists()).toBe(false);
  }, 30_000);

  /**
   * 翻页是本地切片：多点一次「显示更早」一个请求都不许多发。
   * 这条不是洁癖 —— 这一面板立项的理由之一就是别敲服务器，而"翻页"最容易被顺手实现成再读一次。
   */
  it('点「显示更早」不发任何网络请求', async () => {
    const port = seedManyVersions(25);
    const wrapper = await loadPaged(port);
    const callsBefore = port.calls.length;

    await wrapper.find('[data-testid="history-show-earlier"]').trigger('click');
    await flush();

    expect(rowsShown(wrapper)).toBe(25);
    expect(port.calls.length, `翻页前后请求数变了（${callsBefore} ⇒ ${port.calls.length}）`).toBe(callsBefore);
  }, 30_000);

  /** 重新读取要把窗口收回去：上一次翻到第 120 版这个状态在新读回来的清单上不成立。 */
  it('翻到底之后重新读取 ⇒ 又只列 20 版', async () => {
    const port = seedManyVersions(25);
    const wrapper = await loadPaged(port);
    await wrapper.find('[data-testid="history-show-earlier"]').trigger('click');
    await flush();
    expect(rowsShown(wrapper)).toBe(25);

    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => rowsShown(wrapper) === 20, '重新读取之后收回到第一屏');
    expect(rowsShown(wrapper)).toBe(20);
  }, 30_000);
});

describe('「清理远端历史」在清单上面', () => {
  it('清理那一格排在第一行之前，而勾选护栏一条没减', async () => {
    const wrapper = await loadPaged(seedManyVersions(25));
    const html = wrapper.html();

    const pruneAt = html.indexOf('data-testid="history-prune"');
    const rowAt = html.indexOf('data-testid="history-row"');
    expect(pruneAt, '清理那一格没在 DOM 里').toBeGreaterThanOrEqual(0);
    expect(pruneAt, '上百版时它在最底部 = 够不着').toBeLessThan(rowAt);

    // 正向对照：位置换了，但"没勾就不许按"这条判据仍然有效
    expect((wrapper.find('[data-testid="history-prune"]').element as HTMLButtonElement).disabled).toBe(true);
    await wrapper.find('[data-testid="history-confirm"]').setValue(true);
    expect((wrapper.find('[data-testid="history-prune"]').element as HTMLButtonElement).disabled).toBe(false);
  }, 30_000);
});

/**
 * ★ 结果行的**位置**（2026-10-08 真机第二张截图）：清理完之后那句
 * 「✓ 已删除 4 个快照，保留 30 个」掉在整份清单底下，看不见。
 *
 * 这行字是"我刚才那一下成没成"的唯一依据，而清单可以很长 ⇒ 它必须在首屏。
 * 判据钉的是**这一层子元素的先后**（不是像素，jsdom 不排版）：结果行紧跟在动作那一排后面，
 * 清单在它下面。原来它在清单之后 ⇒ 只要列表长，它就必然看不见。
 */
/** 面板**直接子节点**上带 testid 的那几个，按 DOM 顺序。 */
function childTestIds(wrapper: VueWrapper): string[] {
  return Array.from(wrapper.element.children)
    .map((child) => (child as HTMLElement).dataset.testid ?? '')
    .filter((id) => id !== '');
}

describe('结果行在清单上面', () => {
  it('清理完成那一句紧跟在动作那一排后面，清单在它之下', async () => {
    const port = seedManyVersions(25);
    await configureStorage();
    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => rowsShown(wrapper) > 0, '清单出来');

    await wrapper.find('[data-testid="history-keep"]').setValue('1');
    await wrapper.find('[data-testid="history-confirm"]').setValue(true);
    await wrapper.find('[data-testid="history-prune"]').trigger('click');
    await until(() => {
      const line = wrapper.find('[data-testid="history-message"]');
      return line.exists() && line.text().includes('Deleted');
    }, '清理结果那行出来');

    const ids = childTestIds(wrapper);
    expect(ids[0], '第一格还是那颗「读取远端历史」').toBe('history-load');
    expect(ids[1], '结果行必须紧跟在动作那一排后面 —— 它原来在整份清单底下').toBe('history-message');
    expect(ids.indexOf('history-total'), '清单那几格在结果行之下').toBeGreaterThan(1);
    // 正向对照：那句内容本身仍然对（位置换了不许把语气/数字弄坏）
    expect(wrapper.find('[data-testid="history-message"]').text()).toContain('kept 1');
  }, 30_000);

  /** 读取失败那一行也在同一处：失败比成功更需要被看见，而这时清单根本没渲染。 */
  it('读取失败时结果行是清单位置上的唯一反馈，且仍在动作之下', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await configureStorage();
    await storage.setSyncCredential('');
    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => wrapper.find('[data-testid="history-message"]').exists(), '失败那行出来');

    const ids = childTestIds(wrapper);
    expect(ids).toEqual(['history-load', 'history-message']);
    expect(wrapper.findAll('[data-testid="history-row"]'), '没凭据 ⇒ 没有清单，这一行是唯一反馈').toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ★ 「恢复到这一版」= 替换，且**两下点击**。
//
// 真机报的是"恢复之后又自己弹回去"，修法是抬时间戳 + 补墓碑（`core/domain/restore-as-revert.ts`）。
// 但那一改会把"现在多出来的那些"删掉，还会让对面那台跟着变 ——
// 一个按钮一次点击就把这种事做掉是不行的，所以第一下只算给他看。
// 这一族用例钉的就是：**第一下不动本机，第二下才动，而说的话与做的事一致。**
// ---------------------------------------------------------------------------

describe('恢复到这一版 = 两下点击', () => {
  /** 播三版历史（本机最后停在 3 条会话上），返回面板与最旧那一版的 revision。 */
  async function mountWithHistory(): Promise<{ wrapper: VueWrapper; port: FakeWebDavPort }> {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 3);
    await configureStorage();
    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => rowsShown(wrapper) >= 3, '三版历史都列出来');
    return { wrapper, port };
  }

  it('第一下只出确认行：本机一条不少、数字写在脸上', async () => {
    const { wrapper } = await mountWithHistory();
    expect((await storage.listGroupIndex()).length, '前置：本机三条会话').toBe(3);

    await wrapper.find('[data-testid="history-restore-1"]').trigger('click');
    await until(() => wrapper.find('[data-testid="history-restore-confirm"]').exists(), '确认行出来');

    const confirm = wrapper.find('[data-testid="history-restore-confirm"]');
    // 真文案与两个数：那一版 1 条、现在多出 2 条
    expect(confirm.text()).toContain('1 session');
    expect(confirm.text()).toContain('2');
    expect(wrapper.find('[data-testid="history-restore-yes"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="history-restore-no"]').exists()).toBe(true);
    // ★ 这一条是这一族的关键：预览**不许**已经改了本机
    expect((await storage.listGroupIndex()).length, '第一下就把本机换掉 = 那句确认是假的').toBe(3);
    // 也没有多出来的预告（这一版之后没删过东西）
    expect(wrapper.find('[data-testid="history-restore-asked"]').exists()).toBe(false);
  }, 30_000);

  it('第二下才落盘：本机换成那一版，结果那句报实际条数', async () => {
    const { wrapper } = await mountWithHistory();
    await wrapper.find('[data-testid="history-restore-1"]').trigger('click');
    await until(() => wrapper.find('[data-testid="history-restore-confirm"]').exists(), '确认行出来');

    await wrapper.find('[data-testid="history-restore-yes"]').trigger('click');
    await until(() => {
      const line = wrapper.find('[data-testid="history-message"]');
      return line.exists() && line.text().includes('Restored');
    }, '结果那句出来');

    expect((await storage.listGroupIndex()).length, '第二下之后本机应当只剩那一版的一条').toBe(1);
    const line = wrapper.find('[data-testid="history-message"]').text();
    expect(line).toContain('1 session');
    expect(line).toContain('2');
    // 确认行落盘之后要收掉：它说的那件事已经做完了
    expect(wrapper.find('[data-testid="history-restore-confirm"]').exists()).toBe(false);
  }, 30_000);

  it('取消 ⇒ 确认行消失、本机一条不动', async () => {
    const { wrapper } = await mountWithHistory();
    await wrapper.find('[data-testid="history-restore-1"]').trigger('click');
    await until(() => wrapper.find('[data-testid="history-restore-confirm"]').exists(), '确认行出来');

    await wrapper.find('[data-testid="history-restore-no"]').trigger('click');
    await flush();
    expect(wrapper.find('[data-testid="history-restore-confirm"]').exists()).toBe(false);
    expect((await storage.listGroupIndex()).length).toBe(3);
  }, 30_000);

  it('确认行在清单上面（与结果行同一侧，不沉到清单底下）', async () => {
    const { wrapper } = await mountWithHistory();
    await wrapper.find('[data-testid="history-restore-1"]').trigger('click');
    await until(() => wrapper.find('[data-testid="history-restore-confirm"]').exists(), '确认行出来');

    const html = wrapper.html();
    expect(html.indexOf('data-testid="history-restore-confirm"'), '确认行必须排在第一行之前').toBeLessThan(
      html.indexOf('data-testid="history-row"'),
    );
  }, 30_000);

  /**
   * 那一版之后被删掉的那些：协议里没有"撤销删除"，抬到"现在"就落进 既有约定 的
   * delete-vs-edit ⇒ 会先进冲突列表问他一句。这句预告**必须提前说**，
   * 否则他按完确认看到一排冲突，会以为恢复坏了。
   */
  it('有被删过的条目时，确认行多一句预告；没有时不多（两侧各一条）', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 3);
    const { softDeleteGroup } = await import('@/core/application/delete-model');
    await softDeleteGroup({ storage }, { groupId: 'v0', reason: 'user-delete', at: AT + 9000 });
    await runSync({ storage, webdav: port }, AT + 9000); // 第 4 版：少了 v0，账上有墓碑
    await configureStorage();

    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => rowsShown(wrapper) >= 4, '四版历史都列出来');
    await wrapper.find('[data-testid="history-restore-1"]').trigger('click');
    await until(() => wrapper.find('[data-testid="history-restore-confirm"]').exists(), '确认行出来');

    expect(wrapper.find('[data-testid="history-restore-asked"]').text(), 'v0 是那一版之后删的 ⇒ 要预告').toContain('1');

    // 正向对照：同一面板、恢复最新那一版 ⇒ 没有"会问你一句"那句
    const clean = mountPanel(port);
    await flush();
    await clean.find('[data-testid="history-load"]').trigger('click');
    await until(() => rowsShown(clean) >= 4, '对照：清单读回来');
    await clean.find('[data-testid="history-restore-4"]').trigger('click');
    await until(() => clean.find('[data-testid="history-restore-confirm"]').exists(), '对照：确认行出来');
    expect(clean.find('[data-testid="history-restore-asked"]').exists(), '恢复当前那版不该预告冲突').toBe(false);
  }, 30_000);
});

/**
 * ★ 点第一下之后，确认条要**自己滚进视野**（2026-10-08 他问"能不能用弹窗"）。
 *
 * 弹窗能解决的是同一件事：从清单深处点恢复，确认条在清单上方 ⇒ 看起来"点了没反应"，
 * 而那正是 既有约定 立项要防的形状。选内联 + 滚进视野而不是弹窗的理由记在 既有约定 的
 * 确认载体那一格（仓库没有弹窗原语；这一屏已有三处破坏性确认走的是"贴在动作旁边的确认条"）。
 * 所以这一格必须钉住"真的调了 scrollIntoView"，不然"滚过来"只是注释里的一句话。
 */
describe('确认条滚进视野', () => {
  it('点「恢复到这一版」之后调用 scrollIntoView，把确认条带到眼前', async () => {
    // jsdom 不实现这个方法，先补上（真浏览器有），再换成 spy 断言被调用
    const proto = globalThis.HTMLElement.prototype as unknown as { scrollIntoView?: (arg?: unknown) => void };
    const original = proto.scrollIntoView;
    const calls: unknown[] = [];
    proto.scrollIntoView = function scrollIntoView(this: HTMLElement, arg?: unknown) {
      calls.push(arg);
    };
    try {
      // 用真推的 22 版而不是手播的假快照：`previewRestore` 要 GET 那一版并验 checksum，
      // 手播的占位正文过不了验 ⇒ 走的是"坏数据"那支，确认行压根不出现，
      // 那这条用例就会变成"等不到"而不是"测到了滚动"。
      const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
      await pushVersions(port, 22);
      await configureStorage();
      const wrapper = mountPanel(port);
      await flush();
      await wrapper.find('[data-testid="history-load"]').trigger('click');
      await until(() => rowsShown(wrapper) === 20, '一屏 20 版');

      expect(calls, '还没点就不该滚').toHaveLength(0);
      // 点的是这一屏**最后一行**（revision 3）：它离确认条最远，滚不滚得看得见差别最大
      await wrapper.find('[data-testid="history-restore-3"]').trigger('click');
      await until(() => wrapper.find('[data-testid="history-restore-confirm"]').exists(), '确认行出来');

      expect(calls.length, '点第一下之后确认条没被带到视野里 = 看起来像点了没反应').toBeGreaterThanOrEqual(1);
      expect(calls[0]).toMatchObject({ block: 'nearest' });
    } finally {
      proto.scrollIntoView = original;
    }
  }, 30_000);

  /** 确认条与确认那颗要长得像破坏性动作（与 `GroupRow.vue` 删会话那一族同形）。 */
  it('确认条是危险底色，确认那颗是 danger 档', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 22);
    await configureStorage();
    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => rowsShown(wrapper) === 20, '一屏 20 版');
    await wrapper.find('[data-testid="history-restore-3"]').trigger('click');
    await until(() => wrapper.find('[data-testid="history-restore-confirm"]').exists(), '确认行出来');

    expect(wrapper.find('[data-testid="history-restore-confirm"]').classes()).toContain('bg-danger-soft');
    expect(wrapper.find('[data-testid="history-restore-yes"]').classes()).toContain('bg-danger');
    // 正向对照：取消那颗不是 danger —— 两颗同色就等于没有默认方向
    expect(wrapper.find('[data-testid="history-restore-no"]').classes()).not.toContain('bg-danger');
  }, 30_000);
});
