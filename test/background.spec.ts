/**
 * background 的接线测试（既有约定 / 既有约定 / 既有约定 说的"接通了"就归这里验）。
 *
 * 手法与别的测试不同：**不 mock 掉 use case**，而是把 `BrowserTabsPort` 单例的方法逐个
 * 委托给仓库里那份假仓储（`infrastructure/testing/fake-browser-tabs.ts`），
 * 让真实的 `entrypoints/background.ts` + `shared/services.ts` + `shared/messages.ts` +
 * 真实存储适配器一起跑起来。原因很简单：@webext-core/fake-browser@2.0.1 的
 * `tabs.remove()` **自己会抛错**（我实测过），所以完全裸跑假浏览器做不到；
 * 而只测 use case 又永远证明不了"图标真的被接上了、badge 真的会动"。
 *
 * 事件用 fakeBrowser 事件对象的非标准 `.trigger()` 真发；`action.onClicked` 也真发。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import background from '@/entrypoints/background';
import { CAPTURE_NOTICE_MESSAGE, COMMAND_MESSAGE } from '@/shared/messages';
import { SYNC_PING_MESSAGE } from '@/shared/sync-heartbeat';
import { BACKGROUND_ALARM_PERIOD_MINUTES, SYNC_ALARM_NAME } from '@/shared/constants';
import { groupFixture, putEmptyGroup, savedTabFixture } from './fixtures';
import { eventsPort, storagePort, tabsPort, webdavPort } from '@/shared/services';
import { createFakeWebDav, FAKE_CREDENTIAL } from '@/infrastructure/testing/fake-webdav';
import type { FakeWebDavPort } from '@/infrastructure/testing/fake-webdav';
import { createFakeBrowserTabsPort, FAKE_EXTENSION_ORIGIN } from '@/infrastructure/testing/fake-browser-tabs';
import type { FakeBrowserTabsPort, FakeWindowSpec } from '@/infrastructure/testing/fake-browser-tabs';
import type { BrowserTabsPort } from '@/core/ports/browser-tabs';
import type { LifecycleHandlers } from '@/core/ports/browser-events';
import type { WebDavPort } from '@/core/ports/webdav';
import type { SyncMeta } from '@/shared/types';
import type { Command } from '@/shared/messages';

const ENTRY_URL = `${FAKE_EXTENSION_ORIGIN}/app.html?entry=pinned-tab`;

let fake: FakeBrowserTabsPort;
/** 每条用例一份内存 WebDAV；同步节拍那组用例靠它的 `calls` 判断"到底发没发过请求"。 */
let remote: FakeWebDavPort;
/** background 里每个服务订阅的 handler 合集（管理器 5 个 + 活跃序列 3 个）。 */
let subscriptions: LifecycleHandlers[];
let handlers: LifecycleHandlers;

/**
 * 把所有订阅**合并**成一个句柄。
 *
 * 第一版这里只留"最后一次 subscribe 的 handlers"，于是 `handlers.onStartup?.()` 变成
 * 在"没人注册的东西"上调用 —— 测试安静地什么都不做。合并之后，缺注册会真的让断言红。
 */
function recordSubscription(next: LifecycleHandlers): void {
  subscriptions.push(next);
  handlers = { ...handlers, ...next };
}

/** 把单例 port 的方法委托给假仓储（真实 background 拿到的就是这个对象）。 */
function delegate(target: BrowserTabsPort, source: BrowserTabsPort): void {
  const keys: Array<keyof BrowserTabsPort> = [
    'queryWindowTabs',
    'getCurrentWindow',
    'listNormalWindows',
    'create',
    'update',
    'move',
    'entryPageUrl',
    'remove',
    'createWindow',
    'existingUrls',
  ];
  for (const key of keys) {
    const method = source[key] as (...args: unknown[]) => unknown;
    vi.spyOn(target, key).mockImplementation(((...args: unknown[]) => method.apply(source, args)) as never);
  }
}

const WEBDAV_METHODS: Array<keyof WebDavPort> = [
  'testConnection',
  'ensureCollection',
  'put',
  'get',
  'head',
  'propfind',
  'move',
];

/**
 * 把 WebDAV 也委托给假件，**在 `background.main()` 之前装好**。
 *
 * 这一条是安全闸，不是整洁要求：background 里那五类节拍一旦真的跑起来就会发 fetch，
 * 而测试进程里的 fetch 打的是 `https://host/dav`（真 DNS、真超时），
 * 全量跑时会以"某个用例 5 秒后红"的形式回来，报的还不是被测的那件事。
 * 装在这里 ⇒ 这个文件里**任何**一次同步都只会打到内存假件上。
 */
function delegateWebDav(source: FakeWebDavPort): void {
  for (const key of WEBDAV_METHODS) {
    const method = source[key] as unknown as (...args: unknown[]) => unknown;
    vi.spyOn(webdavPort, key).mockImplementation(((...args: unknown[]) => method.apply(source, args)) as never);
  }
}

/**
 * 触发消息通道并取回**响应**。
 *
 * 必须把 `undefined` 滤掉：真 MV3 的语义是"第一个给出回值的监听者算回复，别的监听者
 * 不吭声不影响它"，而 fakeBrowser 的 `trigger` 把**每个**监听器的返回值原样摊成一个数组。
 * background 现在除了命令通道还多了一个只听心跳的监听者，它对命令消息就是
 * `undefined` —— 不滤的话 `emit(...)[0]` 会拿到那个"没回话"，测试红得与被测的事无关。
 */
const emit = async (message: unknown) => {
  const results = await (fakeBrowser.runtime.onMessage as unknown as {
    trigger: (m: unknown) => Promise<unknown[]>;
  }).trigger(message);
  return results.filter((item) => item !== undefined);
};

async function sendCommand(command: Command) {
  const [response] = await emit({ __shitab: COMMAND_MESSAGE, operationId: 'op-test', command });
  return response as { ok: boolean; value?: unknown; error?: string };
}

const clickIcon = (tab: { windowId?: number; id?: number }) =>
  (fakeBrowser.action.onClicked as unknown as { trigger: (t: unknown) => Promise<unknown> }).trigger(tab);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  fakeBrowser.action.resetState();
  /**
   * alarm 的状态与监听器都要显式清。`fakeBrowser.alarms` 是**模块级**的 Map（不像 storage
   * 有 clear 的概念），而 `background.main()` 每跑一次就在 `onAlarm` 上加一个 handler ——
   * 不清的话第二个用例里一次触发会叫醒两个引擎，第二个看到的账本已经被第一个改过，
   * 那种红查三天也查不到被测代码上。
   */
  fakeBrowser.alarms.resetState();

  fake = createFakeBrowserTabsPort({ windows: [] });
  delegate(tabsPort, fake);
  remote = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
  delegateWebDav(remote);

  // 记录 background 订阅了什么，好在测试里手动触发生命周期
  subscriptions = [];
  handlers = {};
  vi.spyOn(eventsPort, 'subscribe').mockImplementation((next: LifecycleHandlers) => {
    recordSubscription(next);
    return () => undefined;
  });

  await background.main();
});

afterEach(async () => {
  /**
   * 等这一轮的锁自己松开。
   *
   * `wake()` 是 `void requestSync(...)`，用例不等它 ⇒ 模块级的 `inFlight` 可能还挂着，
   * 下一条用例的 ping 就会被判成 `in-flight` 而 skip，红得像"心跳根本没接上"。
   * 读不到那个私有布尔，但它只在 `finally` 里落账之后仍然为真，所以账本里
   * `syncClaimedAt` 被清掉 ⇒ 本进程的锁也一定已经放了（engine 里就那个顺序）。
   */
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const meta = await storagePort.getSyncMeta();
    if (meta.syncClaimedAt === undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // background.main() 每个用例都跑一次，而 registerCommandHandler 会往 runtime.onMessage
  // 上再加一个 listener。不清理的话，trigger 的第一个响应来自**上一个用例的陈旧 handler**
  // （它闭包里的假仓储已经没有这个窗口的 tab 了）—— 我第一次就是这么被骗到的。
  fakeBrowser.runtime.onMessage.removeAllListeners();
  vi.restoreAllMocks();
});

const groupIndexSize = async () => (await storagePort.listGroupIndex()).length;

describe('图标点击 = 收纳', () => {
  it('点一次：当前窗口被存成一个会话、网页被关掉、T 被建出来并聚焦', async () => {
    fake = createFakeBrowserTabsPort({
      windows: [
        {
          id: 7,
          tabs: [
            { id: 71, url: 'https://a.test/1' },
            { id: 72, url: 'https://a.test/2', active: true },
            { id: 73, url: 'https://a.test/3' },
          ],
        },
      ],
    });
    delegate(tabsPort, fake);

    await clickIcon({ windowId: 7, id: 72 });
    await flush();

    expect(await groupIndexSize()).toBe(1);
    const left = (fake.dump()[7] ?? []).map((tab) => tab.url);
    expect(left).toEqual([ENTRY_URL]); // 只剩落脚页：入口 T
    expect((fake.dump()[7] ?? []).find((tab) => tab.active)?.url).toBe(ENTRY_URL);
  });

  it('badge 与 tooltip 跟着结果变（§26/§27 的反馈通道真的接上了）', async () => {
    fake = createFakeBrowserTabsPort({
      windows: [{ id: 7, tabs: [{ id: 71, url: 'https://a.test/1', active: true }] }],
    });
    delegate(tabsPort, fake);

    await clickIcon({ windowId: 7, id: 71 });
    await flush();

    expect(await fakeBrowser.action.getBadgeText({})).toBe('1');
    expect(await fakeBrowser.action.getTitle({})).toBe('ShiTab: stashed 1 tabs');
  });

  it('平台没给 windowId 时什么都不做（不去猜某个窗口）', async () => {
    fake = createFakeBrowserTabsPort({
      windows: [{ id: 7, tabs: [{ id: 71, url: 'https://a.test/1', active: true }] }],
    });
    delegate(tabsPort, fake);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await clickIcon({ id: 71 });
    await flush();

    expect(await groupIndexSize()).toBe(0);
    expect(fake.dump()[7]).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });

  it('持久化失败时一条都不关，并把"原标签未关闭"打到 tooltip 上（AC-04）', async () => {
    fake = createFakeBrowserTabsPort({
      windows: [{ id: 7, tabs: [{ id: 71, url: 'https://a.test/1', active: true }, { id: 72, url: 'https://a.test/2' }] }],
    });
    delegate(tabsPort, fake);
    vi.spyOn(storagePort, 'putGroup').mockRejectedValue(new Error('storage is full'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await clickIcon({ windowId: 7, id: 71 });
    await flush();

    expect(fake.dump()[7]).toHaveLength(2);
    expect(await fakeBrowser.action.getTitle({})).toBe('Stash failed — no tabs were closed.');
    expect(error).toHaveBeenCalled();
  });

  it('连点两次只生成一个会话，第二次被忽略（AC-12）', async () => {
    // 让关闭动作慢下来，第二次点击才会落在"第一次还没结束"的窗口里
    const slow = createFakeBrowserTabsPort({
      windows: [{ id: 7, tabs: [{ id: 71, url: 'https://a.test/1', active: true }, { id: 72, url: 'https://a.test/2' }] }],
    });
    vi.spyOn(slow, 'remove').mockImplementation(async (ids) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { closed: ids, failed: [] };
    });
    delegate(tabsPort, slow);

    await Promise.all([clickIcon({ windowId: 7, id: 71 }), clickIcon({ windowId: 7, id: 71 })]);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await groupIndexSize()).toBe(1);
  });

  it('订阅发生在 background 里，且每个服务恰好一次', () => {
    // 只剩一个服务订阅生命周期：入口页管理器。
    // （原来还有"最近在看哪一页"的活跃序列，随"添加当前标签页"一起在真机第七轮删了，既有约定）
    expect(subscriptions).toHaveLength(1);
    expect(handlers.onStartup, '管理器没订阅 onStartup').toBeDefined();
    expect(handlers.onWindowCreated, '管理器没订阅 onWindowCreated').toBeDefined();
  });
});

describe('入口 T 的生命周期挂在 background 上', () => {
  it('onStartup 给每个普通窗口补一个 T', async () => {
    fake = createFakeBrowserTabsPort({
      windows: [
        { id: 1, tabs: [{ id: 11, url: 'https://a.test/1' }] },
        { id: 2, tabs: [{ id: 21, url: 'https://b.test/1' }] },
      ],
    });
    delegate(tabsPort, fake);

    await handlers.onStartup?.();

    for (const id of [1, 2]) {
      expect((fake.dump()[id] ?? []).filter((tab) => tab.url === ENTRY_URL)).toHaveLength(1);
    }
  });

  it('新建窗口时补 T；关掉 T 默认不重建（autoRestorePinnedTab 默认关）', async () => {
    fake = createFakeBrowserTabsPort({ windows: [{ id: 1, tabs: [] }] });
    delegate(tabsPort, fake);

    await handlers.onWindowCreated?.(1);
    const tab = (fake.dump()[1] ?? [])[0];
    expect(tab?.url).toBe(ENTRY_URL);

    if (tab) await fake.remove([tab.id]);
    await handlers.onTabRemoved?.({ tabId: tab?.id ?? -1, windowId: 1, isWindowClosing: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((fake.dump()[1] ?? []).map((t) => t.url)).toEqual([]);
  });
});

describe('命令通道（4 条命令各就各位）', () => {
  beforeEach(() => {
    fake = createFakeBrowserTabsPort({
      windows: [
        { id: 7, tabs: [{ id: 71, url: 'https://a.test/1', active: true }, { id: 72, url: 'https://a.test/2' }] },
        { id: 8, tabs: [] },
      ],
    });
    delegate(tabsPort, fake);
  });

  it('图标收纳成功后广播 CaptureNotice —— 页面上的撤销条靠它', async () => {
    // fakeBrowser 的 runtime.sendMessage 是"未实现即抛"，所以这里替掉它来收 SW 发出的通知。
    // 页面侧的订阅与按窗口过滤在 test/ui-workbench.spec.ts 里验，两边合起来才是这条链路。
    const sent: unknown[] = [];
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(((message: unknown) => {
      sent.push(message);
      return Promise.resolve(undefined);
    }) as never);

    await clickIcon({ windowId: 7, id: 71 });
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      __shitab: CAPTURE_NOTICE_MESSAGE,
      windowId: 7,
      result: { saved: 2, closed: 2 },
    });
  });

  it('通知发不出去也不影响收纳本身（badge 已经报过结果，撤销条只是锦上添花）', async () => {
    // 不替 sendMessage => 真抛 MockNotImplementedError，走 publishCaptureNotice 的 try/catch
    await clickIcon({ windowId: 7, id: 71 });
    await flush();

    expect(await groupIndexSize()).toBe(1);
    expect((fake.dump()[7] ?? []).map((tab) => tab.url)).toEqual([ENTRY_URL]);
  });

  it('restoreGroup / restoreTab / undoCapture 都按传入的 windowId 落窗口', async () => {
    // 收纳只剩图标一个入口，所以这里用图标造出待恢复的会话
    await clickIcon({ windowId: 7, id: 71 });
    await flush();
    const groupId = (await storagePort.listGroupIndex())[0]?.id ?? '';
    expect(groupId, '收纳没建出会话').toBeTruthy();

    // restoreTab 必须排在 restoreGroup 前面：一次成功的整组恢复会把会话消费掉
    const one = (await storagePort.getGroup(groupId))?.tabs[0];
    const single = await sendCommand({ kind: 'restoreTab', windowId: 8, groupId, tabId: one?.id ?? '' });
    expect((single.value as { ok: boolean }).ok).toBe(true);
    expect((fake.dump()[8] ?? []).map((tab) => tab.url)).toContain(one?.url);
    // 单条恢复只消费那一条记录，会话本身还在
    expect(await storagePort.getGroup(groupId)).toBeDefined();

    const restored = await sendCommand({ kind: 'restoreGroup', windowId: 8, groupId });
    expect((restored.value as { restored: number }).restored).toBeGreaterThan(0);
    expect((fake.dump()[8] ?? []).length).toBeGreaterThan(0);
    expect(await storagePort.getGroup(groupId)).toBeUndefined(); // 恢复即消费

    // 撤销得另起一次收纳：上面那条会话已经被吃掉了
    await fake.create({ url: 'https://a.test/undo-me', windowId: 7, active: true });
    await clickIcon({ windowId: 7 });
    await flush();
    const second = (await storagePort.listGroupIndex())[0]?.id ?? '';
    expect(second, '第二次收纳没建出会话').toBeTruthy();

    const undone = await sendCommand({ kind: 'undoCapture', windowId: 8, groupId: second });
    expect((undone.value as { restored: number }).restored).toBe(1);
    expect(await storagePort.getGroup(second)).toBeUndefined(); // 撤销删会话
  });

  it('ensureEntryTab 会校正本窗口的 T，且不抢焦点', async () => {
    // 一个"被用户取消固定"的 T
    await fake.create({ url: ENTRY_URL, windowId: 7, active: true });
    const before = (await fake.queryWindowTabs(7)).find((tab) => tab.url === ENTRY_URL);
    expect(before?.pinned).toBe(false);

    const response = await sendCommand({ kind: 'ensureEntryTab', windowId: 7 });
    expect(response.value).toBe(true);

    const after = (await fake.queryWindowTabs(7)).find((tab) => tab.url === ENTRY_URL);
    expect(after?.pinned).toBe(true);
    expect(after?.index).toBe(0);
    expect(after?.active).toBe(true); // 已经在看的页面不该被抢走
  });

  it('未知命令被拒并带回错误文本（判别联合不会静默漏掉）', async () => {
    const response = await sendCommand({ kind: 'ensureEntryTab', windowId: 7 });
    expect(response.ok).toBe(true);

    const bogus = await emit({
      __shitab: COMMAND_MESSAGE,
      operationId: 'op-bogus',
      command: { kind: 'deleteEverything', windowId: 7 },
    });
    expect((bogus[0] as { ok: boolean; error?: string }).ok).toBe(false);
    expect((bogus[0] as { error: string }).error).toContain('未知命令');
  });
});

// ---------------------------------------------------------------------------
// 同步的脏标记—— 这条接线原来只听 `watchGroups`，于是
// "只写回收站与墓碑"的那批动作（从回收站彻底删除一行、逐条删到空、删分类）
// **在这台机器上根本不算"变了"**，永远不推。用户报的是对面收不到，这里补的是发送侧那一半。
// ---------------------------------------------------------------------------

describe('同步的脏标记覆盖回收站与墓碑', () => {
  const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 只有开了同步才谈得上"脏"：`markDirty` 在同步关闭时直接返回。 */
  async function setSyncEnabled(enabled: boolean): Promise<void> {
    await storagePort.setWebDavConfig({
      enabled,
      baseUrl: 'https://host/dav',
      username: 'u',
      allowInsecureHttp: false,
    });
    await wait();
  }

  async function dirtyField(): Promise<number | undefined> {
    return (await storagePort.getSyncMeta()).dirtySinceAt;
  }

  /** 同步关着的时候写入 ⇒ 不留脏标记，这样下面那条"之后才变脏"才是被测出来的、不是 setup。 */
  it('从回收站彻底删除一行（一个会话键都不碰）⇒ 本机标脏', async () => {
    await storagePort.putTrash({
      group: groupFixture('会话 bin-only', [savedTabFixture('bin-only', 'bin-only-t0', 0)], { id: 'bin-only' }),
      deletedAt: 1,
      expiresAt: 2,
      reason: 'user-delete',
    });
    await setSyncEnabled(true);
    expect(await dirtyField(), '同步刚打开时不该已经脏').toBeUndefined();

    await storagePort.removeTrash('bin-only');
    await wait();

    expect(await dirtyField(), '回收站的写入没被当成变化 ⇒ 这台机器的彻底删除永远不会推出去').toBeDefined();
    await setSyncEnabled(false);
  });

  it('只写墓碑（删分类走的那条路）也标脏', async () => {
    await storagePort.setTombstones([]);
    await setSyncEnabled(true);
    expect(await dirtyField()).toBeUndefined();

    await storagePort.setTombstones([
      {
        id: 'tomb-cat',
        entityType: 'category',
        entityId: 'c1',
        deletedAt: 1,
        deletedByDeviceId: 'dev-1',
        reason: 'user-delete',
      },
    ]);
    await wait();

    expect(await dirtyField(), '墓碑的写入没被当成变化').toBeDefined();
    await setSyncEnabled(false);
  });

  it('同步关着时写回收站不留脏标记（`markDirty` 的那条 early return）', async () => {
    await storagePort.setTombstones([]);
    await storagePort.putTrash({
      group: groupFixture('会话 off-only', [savedTabFixture('off-only', 'off-t0', 0)], { id: 'off-only' }),
      deletedAt: 1,
      expiresAt: 2,
      reason: 'user-delete',
    });
    await wait();

    expect(await dirtyField()).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// 同步的五类节拍（既有约定 心跳 / 0083 后台 alarm / 0084 统一入口 requestSync）。
//
// 这一组是被"触发层"逼出来的：仓里所有引擎用例都**手动调 `runSync`**，
// 于是"判据写对了但没人来问"这种 bug 全绿看不见 —— 用户报的正是那一种
// （「在 Edge 删了标签，Chrome 的页面等了半天没同步」）。
// 所以这里断的不是"同步得对不对"，而是**谁敲门、敲门之后到底跑没跑、不该跑时一个请求都不发**。
//
// ⚠ `remote.calls` 是"有没有真的发过请求"的唯一硬证据。只看 `SyncMeta.status` 会被
//   `requestSync` 之前的 skip 与"跑了但没变化"两种情况同时糊过去。
// ---------------------------------------------------------------------------

describe('同步的五类节拍都收敛到 requestSync', () => {
  const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
  const metaOf = () => storagePort.getSyncMeta();

  /**
   * 开同步 = 三件事一起摆好：凭据落盘（否则 `runSync` 在 `no-credential` 就早退，
   * 那会让"发了几个请求"少一发，断言红得与被测的事无关）、配置写开、
   * 然后**等 watcher 落定**（装 alarm 与写 status 都发生在那之后）。
   */
  async function enableSync(): Promise<void> {
    await storagePort.setSyncCredential(FAKE_CREDENTIAL.password);
    await storagePort.setWebDavConfig({
      enabled: true,
      baseUrl: 'https://host/dav',
      username: FAKE_CREDENTIAL.username,
      allowInsecureHttp: false,
    });
    await wait();
  }

  async function disableSync(): Promise<void> {
    const current = await storagePort.getWebDavConfig();
    await storagePort.setWebDavConfig({ ...current, enabled: false });
    await wait();
  }

  /**
   * 等账本满足条件。超时**不抛**，把最后一次读到的 meta 交回给断言 ——
   * 断言消息里能看见"当时到底是什么状态"，比一句"等不到"好查。
   * 用轮询而不是固定 sleep：一次同步要 gzip + 两次 PUT，快慢随并行度抖。
   */
  async function untilMeta(
    predicate: (meta: SyncMeta) => boolean,
    timeoutMs = 4_000,
  ): Promise<SyncMeta> {
    let meta = await metaOf();
    const deadline = Date.now() + timeoutMs;
    while (!predicate(meta) && Date.now() < deadline) {
      await wait(10);
      meta = await metaOf();
    }
    return meta;
  }

  /**
   * 等一个"不在账本里"的条件成立（alarm 有没有被装上就是这种）。
   *
   * background 的启动序列是 `void (async () => …)()` —— fire-and-forget，`main()` 返回时
   * 它还在第一个 `await` 上。所以"重启后 alarm 该被补回来"这句话不能紧跟在 `main()` 后面
   * 同步断言，那样读到的一定是 undefined（我第一次就是这么红的，而且是**假红**：
   * 被测的实现是对的）。
   */
  async function untilTrue(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let ok = await predicate();
    while (!ok && Date.now() < deadline) {
      await wait(10);
      ok = await predicate();
    }
    return ok;
  }

  /** 请求计数：跑没跑一轮看这个，不看 status。 */
  const requested = () => remote.calls.length;

  const ping = () => emit({ __shitab: SYNC_PING_MESSAGE });

  /** 平台假件不会自己到点（`create` 只是登记），触发靠 `onAlarm.trigger`。 */
  const fireAlarm = (name: string = SYNC_ALARM_NAME) =>
    (fakeBrowser.alarms.onAlarm as unknown as { trigger: (alarm: unknown) => Promise<unknown> }).trigger({
      name,
      scheduledTime: Date.now(),
      periodInMinutes: BACKGROUND_ALARM_PERIOD_MINUTES,
    });

  /**
   * 重跑一次 worker 的启动序列。先清 alarm 与消息监听器：`background.main()` 每调一次
   * 就多注册一组 handler，不清的话一次触发会叫醒两个引擎（第二个看到的账本已经被第一个改过）。
   */
  async function restart(): Promise<void> {
    fakeBrowser.alarms.resetState();
    fakeBrowser.runtime.onMessage.removeAllListeners();
    await background.main();
  }

  it('页面心跳 + 同步开着 ⇒ 真的跑一轮，账上记的是 heartbeat', async () => {
    await enableSync();

    await ping();
    const meta = await untilMeta((value) => value.lastTrigger === 'heartbeat');

    expect(meta.lastTrigger, '心跳没被理 ⇒ 页面开着也不会去拉').toBe('heartbeat');
    expect(meta.lastSyncAt, '跑完要落 lastSyncAt').toBeTypeOf('number');
    expect(requested(), '一轮同步至少要有 PROPFIND + PUT').toBeGreaterThan(0);
    expect(remote.calls.some((call) => call.method === 'PROPFIND'), '没去看过远端').toBe(true);
  });

  it('同步关着 ⇒ 心跳一个请求都不发（skip 发生在进引擎之前）', async () => {
    // 关着的期间对面可能推了新东西，但"用户说别再碰我的服务器"优先 ⇒ 零请求。
    // 注意这里断的是**没写进引擎**：以前那条用例断的是"status 被写成 disabled"，
    // 那正是旧实现顺手写的，而 既有约定 之后 skip 在前，那句断言就成了假话。
    await storagePort.setSyncMeta({ status: 'idle', lastPushedRevision: 0, consecutiveFailures: 0 });
    await ping();
    await wait(120);

    expect(remote.calls, '同步关着还在敲门').toHaveLength(0);
    expect((await metaOf()).status, 'skip 之后不该动账本历史').toBe('idle');
  });

  it('判据说"还早"（60 秒内刚查过）⇒ 心跳不改账也不发请求', async () => {
    await enableSync();
    const meta = await metaOf();
    await storagePort.setSyncMeta({ ...meta, status: 'idle', lastSyncAt: Date.now() });

    await ping();
    await wait(120);

    expect(requested(), '没到点也去敲门 ⇒ 心跳会把服务器打成节拍器').toBe(0);

    // 正向对照：把上次检查时刻挪到两分钟前，同一个 ping 就该发请求
    const before = requested();
    const fresh = await metaOf();
    await storagePort.setSyncMeta({ ...fresh, status: 'idle', lastSyncAt: Date.now() - 120_000 });
    await ping();
    const ran = await untilMeta((value) => value.lastTrigger === 'heartbeat');
    expect(ran.lastTrigger, '到了拉取间隔还是不发 ⇒ 那条判据是死的').toBe('heartbeat');
    expect(requested(), '到了拉取间隔还是不发').toBeGreaterThan(before);
  });

  it('有冲突等人裁决 ⇒ 自动节拍不重跑（重跑会把用户刚做的裁决盖回去）', async () => {
    await enableSync();
    const meta = await metaOf();
    await storagePort.setSyncMeta({
      ...meta,
      status: 'conflict',
      pendingConflicts: [
        {
          groupId: 'g-conflict',
          deletedAt: 1,
          editedAt: 2,
          deletedByDeviceId: 'dev-2',
          deleteReason: 'user-delete',
        },
      ],
    });

    await ping();
    await wait(120);

    expect(remote.calls, '冲突挂着还在自动跑 ⇒ 同一份冲突会被算第二遍').toHaveLength(0);
    expect((await metaOf()).pendingConflicts, '自动节拍不该把等裁决的账清掉').toHaveLength(1);
  });

  it('别的进程已经认领了这一轮 ⇒ 不排队、也不敲门（跨进程那把锁）', async () => {
    await enableSync();
    const meta = await metaOf();
    // 认领时刻用"现在"：另一处（隔壁页面的同步、或还没被杀的 worker）正在飞
    await storagePort.setSyncMeta({ ...meta, syncClaimedAt: Date.now() });

    await ping();
    await wait(120);

    expect(remote.calls, '两辆马车同时跑会互相盖写 sync_meta').toHaveLength(0);

    // 认领过期（TTL 60 秒）之后同一个 ping 就该跑
    const stale = await metaOf();
    await storagePort.setSyncMeta({
      ...stale,
      syncClaimedAt: (stale.syncClaimedAt ?? Date.now()) - 61_000,
    });
    await ping();
    const meta2 = await untilMeta((value) => value.lastTrigger === 'heartbeat');
    expect(meta2.lastTrigger, '锁过期后仍然不动 ⇒ TTL 那条判据没接上').toBe('heartbeat');
  });

  it('后台 alarm 到点 ⇒ 跑一轮并记 alarm（页面全关着也有节拍）', async () => {
    // 这里**不写会话**：写了就 arm 了 background 那个 3 秒去抖定时器，它会抢在 alarm 之前
    // 把这一轮跑掉，账上留下的就是 `local-change` 而不是 `alarm` —— 我第一次就是这么红的，
    // 而红的不是被测的那件事（"push 真的推上去"归引擎用例管，这里只管是谁叫醒的）。
    await enableSync();

    await fireAlarm();
    const meta = await untilMeta((value) => value.lastTrigger === 'alarm');

    expect(meta.lastTrigger).toBe('alarm');
    expect(requested()).toBeGreaterThan(0);
  });

  it('不认识的 alarm 名不去叫醒同步（别人家的 alarm 也挂在这条总线上）', async () => {
    await enableSync();

    await fireAlarm('some-other-alarm');
    await wait(120);

    expect(remote.calls).toHaveLength(0);
    expect((await metaOf()).lastTrigger).toBeUndefined();
  });

  it('开着同步 ⇒ alarm 存在且周期是 5 分钟；关掉 ⇒ 撤掉并把账写成 disabled', async () => {
    await enableSync();
    const alarm = await fakeBrowser.alarms.get(SYNC_ALARM_NAME);
    expect(alarm, '开着同步却没有后台兜底节拍 ⇒ 页面全关着时永远不会拉').toBeDefined();
    expect(alarm?.periodInMinutes, '周期改了但 alarm 还是旧的，界面上看不出来').toBe(
      BACKGROUND_ALARM_PERIOD_MINUTES,
    );
    // ensure 幂等：再写一次配置不该多出一条 alarm（重复 create 会重置计时，还有每扩展 500 条上限）
    await storagePort.setWebDavConfig({ ...(await storagePort.getWebDavConfig()), lastTestedAt: 2 });
    await wait();
    expect((await fakeBrowser.alarms.getAll()).filter((item) => item.name === SYNC_ALARM_NAME)).toHaveLength(1);

    await disableSync();
    expect(await fakeBrowser.alarms.get(SYNC_ALARM_NAME), '关掉同步之后 alarm 还醒着').toBeUndefined();
    expect(
      (await metaOf()).status,
      '关掉之后账上还挂着上一次的失败 ⇒ 看起来像"关掉反而更坏了"',
    ).toBe('disabled');
  });

  it('worker 重启会把 alarm 补回来，并补一刀 startup 同步（Firefox 的 alarm 不跨浏览器会话）', async () => {
    await storagePort.setSyncCredential(FAKE_CREDENTIAL.password);
    await storagePort.setWebDavConfig({
      enabled: true,
      baseUrl: 'https://host/dav',
      username: FAKE_CREDENTIAL.username,
      allowInsecureHttp: false,
    });

    await restart();

    expect(
      await untilTrue(async () => (await fakeBrowser.alarms.get(SYNC_ALARM_NAME)) !== undefined),
      '重启后没补装 alarm',
    ).toBe(true);
    const meta = await untilMeta((value) => value.lastTrigger === 'startup');
    expect(meta.lastTrigger).toBe('startup');
    expect(requested()).toBeGreaterThan(0);
  });

  it('别的消息不许被当成心跳（只认那一个 __shitab 值）', async () => {
    await enableSync();

    await emit({ __shitab: 'some-other-thing' });
    await wait(120);

    expect(remote.calls).toHaveLength(0);
  });
});
