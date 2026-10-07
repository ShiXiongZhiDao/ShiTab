import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureWindow,
  createStashLock,
  selectableToClose,
} from '@/core/application/capture-window';
import { restoreGroup, restoreTab, undoCapture } from '@/core/application/restore-group';
import {
  deleteTab,
  moveTab,
  renameGroup,
  reorderGroups,
  togglePin,
} from '@/core/application/group-commands';
import { createFakeBrowserTabsPort, FAKE_EXTENSION_ORIGIN } from '@/infrastructure/testing/fake-browser-tabs';
import { putEmptyGroup } from './fixtures';
import type { FakeBrowserTabsPort } from '@/infrastructure/testing/fake-browser-tabs';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import type { EntryTabPort } from '@/core/ports/entry-tab';
import type { StoragePort } from '@/core/ports/storage';
import type { BrowserTab, Settings, TabGroup } from '@/shared/types';

const AT = 1_700_000_000_000;
/** 入口页在测试里的完整 URL：与 adapter 给的形状一致（带 entry 查询串）。 */
const ENTRY_URL = `${FAKE_EXTENSION_ORIGIN}/app.html?entry=pinned-tab`;

/** 假入口页控制器：只记"被要求过几次、给哪个窗口"，并把结果按需返回。 */
function createFakeEntryPort(available = true): EntryTabPort & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async ensureForWindow(windowId) {
      calls.push(windowId);
      return available;
    },
  };
}

function ports(
  initialWindows: Parameters<typeof createFakeBrowserTabsPort>[0],
  entryAvailable = true,
) {
  const tabs = createFakeBrowserTabsPort(initialWindows);
  return { tabs, storage: createStoragePort(), entry: createFakeEntryPort(entryAvailable) };
}

async function settings(overrides: Partial<Settings> = {}) {
  const storage = createStoragePort();
  await storage.setSettings({
    ...(await storage.getSettings()),
    ...overrides,
  });
}

const groupOf = async (storage: StoragePort, id: string): Promise<TabGroup> => {
  const found = await storage.getGroup(id);
  if (!found) throw new Error('分组不存在');
  return found;
};

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
});

describe('captureWindow（V1.1 设计包 §3.1 / §6 / §21）', () => {
  it('顺序是 持久化 -> 落脚页 -> 关闭（AC-04：先存后关；既有约定：关之前先落脚）', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://a.test/2' },
    ] }] });
    const calls: string[] = [];
    const storage = deps.storage;
    const tabs = deps.tabs as FakeBrowserTabsPort;
    const entry = deps.entry;
    const realPut = storage.putGroup.bind(storage);
    const realRemove = tabs.remove.bind(tabs);
    const realEnsure = entry.ensureForWindow.bind(entry);

    vi.spyOn(storage, 'putGroup').mockImplementation(async (group) => {
      calls.push('persist');
      return realPut(group);
    });
    vi.spyOn(entry, 'ensureForWindow').mockImplementation(async (windowId) => {
      calls.push('landing');
      return realEnsure(windowId);
    });
    vi.spyOn(tabs, 'remove').mockImplementation(async (ids) => {
      calls.push('close');
      return realRemove(ids);
    });

    await captureWindow({ storage, tabs, entry }, { windowId: 1, at: AT });
    expect(calls.slice(0, 3)).toEqual(['persist', 'landing', 'close']);
  });

  it('持久化失败时一条 tab 都不关、也不安排落脚页（§21 情况 C）', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://a.test/2' },
    ] }] });
    const storage = deps.storage;
    const tabs = deps.tabs as FakeBrowserTabsPort;
    vi.spyOn(storage, 'putGroup').mockRejectedValue(new Error('storage is full'));

    await expect(
      captureWindow({ storage, tabs, entry: deps.entry }, { windowId: 1, at: AT }),
    ).rejects.toThrow('storage is full');

    expect(deps.entry.calls).toEqual([]);
    expect(tabs.dump()[1]).toHaveLength(2);
  });

  it('默认把活动页也关掉，落脚页由入口 T 承担（V1.1 §3.1 步骤 9）', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://a.test/2' },
      { id: 13, url: 'https://a.test/3' },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');

    expect(outcome.result).toMatchObject({ saved: 3, closed: 3, kept: 0, failed: 0, hasLanding: true });
    expect(deps.entry.calls).toEqual([1]);
    // 窗口里剩下的都是"没被收纳的"，活动页确实被关了
    expect((deps.tabs.dump()[1] ?? []).map((tab) => tab.url)).not.toContain('https://a.test/1');
  });

  it('keepActiveTab=true 时保留活动页并记成 kept', async () => {
    await settings({ keepActiveTab: true });
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://a.test/2' },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');

    expect(outcome.result).toMatchObject({ saved: 2, closed: 1, kept: 1 });
    // kept 的那条不能进撤销名单，否则撤销会开出重复页
    expect(outcome.result.closableTabIds).toEqual([12]);
    const group = await groupOf(deps.storage, outcome.result.groupId);
    expect(group.tabs.find((tab) => tab.wasActive)?.closeState).toBe('kept');
  });

  it('入口页不可用时退一步开一个空新标签页当落脚页（§3.1 步骤 9 的反面）', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://a.test/2' },
    ] }] }, false);
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');

    expect(outcome.result.hasLanding).toBe(true);
    expect(outcome.result).toMatchObject({ saved: 2, closed: 2, kept: 0 });
    const left = (deps.tabs.dump()[1] ?? []).map((tab) => tab.url);
    expect(left).toEqual(['about:blank']);
  });

  it('连落脚页都创建不出来时绝不关活动页（既有约定 的兜底）', async () => {
    const tabs = createFakeBrowserTabsPort({
      windows: [{ id: 1, tabs: [
        { id: 11, url: 'https://a.test/1', active: true },
        { id: 12, url: 'https://a.test/2' },
      ] }],
      unopenableUrls: ['about:blank'],
    });
    const deps = { tabs, storage: createStoragePort(), entry: createFakeEntryPort(false) };
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');

    expect(outcome.result.hasLanding).toBe(false);
    expect(outcome.result).toMatchObject({ saved: 2, closed: 1, kept: 1 });
    const left = (deps.tabs.dump()[1] ?? []).map((tab) => tab.url);
    expect(left).toEqual(['https://a.test/1']);
  });

  it('closeAfterCapture=false 时只存不关', async () => {
    await settings({ closeAfterCapture: false });
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://a.test/2' },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');
    expect(outcome.result).toMatchObject({ saved: 2, closed: 0, kept: 2 });
    expect(deps.tabs.dump()[1]).toHaveLength(2);
  });

  it('固定的 tab 默认既不收纳也不关闭，只报计数', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://mail.google.com/mail', pinned: true },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');

    expect(outcome.result.saved).toBe(1);
    expect(outcome.result.pinnedSkipped).toBe(1);
    expect(outcome.result.savedTabs.some((tab) => tab.url.includes('gmail'))).toBe(false);
    expect(deps.tabs.dump()[1]?.map((tab) => tab.id)).toEqual([12]);
  });

  it('includePinnedTabs=true 时固定页也收，但入口页永远不收（V1.1 §5 / AC-06）', async () => {
    await settings({ includePinnedTabs: true });
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://mail.google.com/mail', pinned: true },
      { id: 13, url: ENTRY_URL, pinned: true },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');

    expect(outcome.result.saved).toBe(2);
    expect(outcome.result.pinnedSkipped).toBe(0);
    expect(outcome.result.savedTabs.map((tab) => tab.url)).not.toContain(ENTRY_URL);
    // 入口页还原封不动地钉在那儿
    expect(deps.tabs.dump()[1]?.map((tab) => tab.id)).toEqual([13]);
  });

  it('入口页即使没固定也不收纳', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: ENTRY_URL, active: true },
      { id: 12, url: 'https://a.test/2' },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');
    expect(outcome.result.savedTabs.map((tab) => tab.url)).toEqual(['https://a.test/2']);
  });

  it('关闭失败时记录保留，closeState=failed（AC-11）', async () => {
    const deps = ports({
      windows: [{ id: 1, tabs: [
        { id: 11, url: 'https://a.test/1', active: true },
        { id: 12, url: 'https://a.test/2' },
      ] }],
      unremovableTabIds: [11],
    });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');

    expect(outcome.result).toMatchObject({ saved: 2, closed: 1, failed: 1, kept: 0 });
    const group = await groupOf(deps.storage, outcome.result.groupId);
    expect(group.tabs.find((tab) => tab.url === 'https://a.test/1')?.closeState).toBe('failed');
  });

  it('不可恢复的内部页照样保存，并计入 nonRestorableSaved', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'chrome://extensions' },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');

    expect(outcome.result.nonRestorableSaved).toBe(1);
    const group = await groupOf(deps.storage, outcome.result.groupId);
    expect(group.tabs.find((tab) => tab.url === 'chrome://extensions')?.restorable).toBe(false);
  });

  it('窗口里只有固定页时返回 no-stashable-tabs，不建空组也不安排落脚页', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://mail.google.com', pinned: true },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    expect(outcome).toEqual({ ok: false, reason: 'no-stashable-tabs', pinnedSkipped: 1 });
    expect(await deps.storage.listGroupIndex()).toEqual([]);
    expect(deps.entry.calls).toEqual([]);
  });

  it('快照带原窗口的 index 与固定状态（AC-03）', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1' },
      { id: 12, url: 'https://a.test/2', active: true, pinned: true },
    ] }] });
    await settings({ includePinnedTabs: true });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('不该失败');
    const [first, second] = outcome.result.savedTabs;
    expect(first).toMatchObject({ url: 'https://a.test/1', originalIndex: 0, originalPinned: false, wasActive: false });
    expect(second).toMatchObject({ url: 'https://a.test/2', originalIndex: 1, originalPinned: true, wasActive: true });
  });

  it('连续收纳两批时 sortOrder 递增', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://docs.flutter.dev/1', active: true },
      { id: 12, url: 'https://docs.flutter.dev/2' },
    ] }] });
    const first = await captureWindow(deps, { windowId: 1, at: AT });
    expect(first.ok).toBe(true);
    // 收纳把活动页也关了，窗口还剩入口页之外的东西才能再收一次：这里重建一个页面
    await deps.tabs.create({ url: 'https://api.flutter.dev/3', windowId: 1, active: true });
    const second = await captureWindow(deps, { windowId: 1, at: AT + 1000 });
    expect(second.ok).toBe(true);
    const index = await deps.storage.listGroupIndex();
    expect(index.map((entry) => entry.sortOrder).sort()).toEqual([0, 1]);
  });

  it('收纳不生成自动标题：默认空标题，界面上是"未命名标签组"占位', async () => {
    const deps = ports({
      windows: [{ id: 1, tabs: [{ id: 11, url: 'https://a.test/1', active: true }, { id: 12, url: 'https://a.test/2' }] }],
    });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('收纳不该失败');

    // 标题为空串，而不是"未命名标签组"这个中文字面量 —— 后者会把数据钉死在收纳时的浏览器语言上
    expect(outcome.result.groupTitle).toBe('');
    expect((await deps.storage.getGroup(outcome.result.groupId))?.title).toBe('');
    // 时间戳不进名字，由标题行的 clockStamp(createdAt) 展示
    expect((await deps.storage.listGroupIndex())[0]?.createdAt).toBe(AT);

    // 显式传标题时照用（导入与未来的批量收纳入口靠它）
    const named = await captureWindow(ports({
      windows: [{ id: 1, tabs: [{ id: 11, url: 'https://a.test/1', active: true }] }],
    }), { windowId: 1, at: AT, title: '  待办  ' });
    if (!named.ok) throw new Error('收纳不该失败');
    expect(named.result.groupTitle).toBe('待办');
  });

  it('收纳结果为纯函数 selectableToClose：三个开关各自成立', () => {
    const tab = (over: Partial<BrowserTab>): BrowserTab => ({
      id: 1, windowId: 1, url: 'https://a.test', title: '', active: false, pinned: false, index: 0, ...over,
    });
    const tabs = [tab({ active: true }), tab({ id: 2 })];
    expect(selectableToClose(tabs, { closeAfterCapture: false, keepActiveTab: false, hasLanding: true })).toEqual([]);
    expect(selectableToClose(tabs, { closeAfterCapture: true, keepActiveTab: false, hasLanding: true })).toHaveLength(2);
    expect(selectableToClose(tabs, { closeAfterCapture: true, keepActiveTab: true, hasLanding: true })).toHaveLength(1);
    // 没落脚页时 keepActiveTab=false 也救不回活动页 —— 这条是"不许连窗口一起关"的兜底
    expect(selectableToClose(tabs, { closeAfterCapture: true, keepActiveTab: false, hasLanding: false })).toHaveLength(1);
  });

  it('收纳锁：第二次点击被忽略而不是排队（AC-12 / §22）', () => {
    const lock = createStashLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.busy).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
    lock.release();
    expect(lock.tryAcquire()).toBe(true);
  });
});

describe('restoreGroup', () => {
  async function captured(input: {
    tabs: { url: string; active?: boolean }[];
    existing?: string[];
    unopenableUrls?: string[];
    incognitoDisallowed?: boolean;
  }) {
    const windowTabs = input.tabs.map((tab, index) => ({
      id: 100 + index,
      url: tab.url,
      active: tab.active === true,
    }));
    const deps = ports({
      windows: [
        { id: 1, tabs: windowTabs },
        { id: 2, tabs: (input.existing ?? []).map((url, index) => ({ id: 900 + index, url, active: false })) },
      ],
      unopenableUrls: input.unopenableUrls,
      incognitoDisallowed: input.incognitoDisallowed,
    });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('收纳不该失败');
    return { deps, groupId: outcome.result.groupId };
  }

  it('按 sortOrder 顺序恢复到指定窗口，并激活原来活动的那条', async () => {
    const { deps, groupId } = await captured({
      tabs: [
        { url: 'https://a.test/1', active: true },
        { url: 'https://a.test/2' },
        { url: 'https://a.test/3' },
      ],
    });
    const result = await restoreGroup(deps, { groupId, windowId: 2 });

    expect(result).toMatchObject({ restored: 3, skipped: 0, failed: 0 });
    const restored = deps.tabs.dump()[2] ?? [];
    expect(restored.map((tab) => tab.url)).toEqual([
      'https://a.test/1',
      'https://a.test/2',
      'https://a.test/3',
    ]);
    expect(restored.find((tab) => tab.active)?.url).toBe('https://a.test/1');
  });

  it('目标窗口已有同 URL 时跳过而不是开重复页', async () => {
    const { deps, groupId } = await captured({
      tabs: [{ url: 'https://a.test/1', active: true }, { url: 'https://a.test/2' }],
      existing: ['https://a.test/2'],
    });
    const result = await restoreGroup(deps, { groupId, windowId: 2 });

    expect(result).toMatchObject({ restored: 1, skipped: 1 });
    expect(result.skippedUrls).toEqual(['https://a.test/2']);
  });

  it('组内重复 URL 只会开一条', async () => {
    const { deps, groupId } = await captured({
      tabs: [{ url: 'https://a.test/x', active: true }, { url: 'https://a.test/x' }],
    });
    const result = await restoreGroup(deps, { groupId, windowId: 2 });
    expect(result).toMatchObject({ restored: 1, skipped: 1 });
  });

  it('不可恢复的条目算 skipped，不算 failed', async () => {
    const deps = ports({
      windows: [
        { id: 1, tabs: [
          { id: 11, url: 'https://a.test/1', active: true },
          { id: 12, url: 'chrome://extensions' },
        ] },
        { id: 2, tabs: [] },
      ],
    });
    const capturedResult = await captureWindow(deps, { windowId: 1, at: AT });
    if (!capturedResult.ok) throw new Error('收纳不该失败');

    const result = await restoreGroup(deps, {
      groupId: capturedResult.result.groupId,
      windowId: 2,
    });
    expect(result).toMatchObject({ restored: 1, skipped: 1, failed: 0 });
    expect(result.skippedUrls).toEqual(['chrome://extensions']);
    expect(deps.tabs.dump()[2]?.map((tab) => tab.url)).toEqual(['https://a.test/1']);
  });

  it('用户拖过排序后按 sortOrder 恢复；没拖过时 originalIndex 只是次级键', async () => {
    const { deps, groupId } = await captured({
      tabs: [
        { url: 'https://a.test/1', active: true },
        { url: 'https://a.test/2' },
        { url: 'https://a.test/3' },
      ],
    });
    const group = await groupOf(deps.storage, groupId);
    const second = group.tabs[1];
    const third = group.tabs[2];
    if (!second || !third) throw new Error('缺条目');
    // 把第 3 条拖到最前：sortOrder 重写，originalIndex 不动
    await deps.storage.putGroup({
      ...group,
      tabs: [
        { ...third, sortOrder: 0 },
        { ...second, sortOrder: 1 },
        { ...group.tabs[0]!, sortOrder: 2 },
      ],
    });

    const result = await restoreGroup(deps, { groupId, windowId: 2 });
    expect(result.restored).toBe(3);
    expect((deps.tabs.dump()[2] ?? []).map((tab) => tab.url)).toEqual([
      'https://a.test/3',
      'https://a.test/2',
      'https://a.test/1',
    ]);
  });

  it('单条打开失败不阻断整组，并回报 partial success', async () => {
    const { deps, groupId } = await captured({
      tabs: [
        { url: 'https://a.test/1', active: true },
        { url: 'https://boom.test/2' },
        { url: 'https://a.test/3' },
      ],
      unopenableUrls: ['https://boom.test/2'],
    });
    const result = await restoreGroup(deps, { groupId, windowId: 2 });

    expect(result).toMatchObject({ restored: 2, failed: 1 });
    expect(result.failedUrls).toEqual(['https://boom.test/2']);
    expect(deps.tabs.dump()[2]).toHaveLength(2);
  });

  it('恢复即消费：开出来几条就把会话删掉，不需要任何设置项', async () => {
    const { deps, groupId } = await captured({ tabs: [{ url: 'https://a.test/1', active: true }] });
    await restoreGroup(deps, { groupId, windowId: 2 });
    expect(await deps.storage.getGroup(groupId)).toBeUndefined();
    expect(await deps.storage.listGroupIndex()).toEqual([]);
  });

  it('一条都没开出来时不删会话（失败的点击不能把数据弄丢）', async () => {
    const { deps, groupId } = await captured({
      tabs: [{ url: 'https://boom.test/1', active: true }],
      unopenableUrls: ['https://boom.test/1'],
    });
    const result = await restoreGroup(deps, { groupId, windowId: 2 });
    expect(result.restored).toBe(0);
    expect(result.failed).toBe(1);
    expect(await deps.storage.getGroup(groupId)).toBeDefined();
  });

  it('单条恢复只消费那一条记录，会话本身留着', async () => {
    const { deps, groupId } = await captured({
      tabs: [{ url: 'https://a.test/1', active: true }, { url: 'https://a.test/2' }],
    });
    const before = await deps.storage.getGroup(groupId);
    const victim = before?.tabs.find((tab) => tab.url === 'https://a.test/1');

    const result = await restoreTab(deps, { groupId, tabId: victim?.id ?? '', windowId: 2 });
    expect(result.ok).toBe(true);

    const after = await deps.storage.getGroup(groupId);
    expect(after?.tabs.map((tab) => tab.url)).toEqual(['https://a.test/2']);
    // 剩下的那条 sortOrder 重写为稠密，不留空洞
    expect(after?.tabs.map((tab) => tab.sortOrder)).toEqual([0]);
  });

  it("mode='current'（缺省）开在调用方窗口，不新建窗口", async () => {
    const { deps, groupId } = await captured({ tabs: [{ url: 'https://a.test/1', active: true }] });
    const result = await restoreGroup(deps, { groupId, windowId: 2 });
    const tabs = deps.tabs as FakeBrowserTabsPort;
    expect(result.mode).toBe('current');
    expect(result.windowId).toBe(2);
    expect(tabs.createdWindows()).toEqual([]);
    expect(tabs.dump()[2]?.map((tab) => tab.url)).toEqual(['https://a.test/1']);
  });

  it("mode='newWindow' 新建普通窗口，并把它报回结果", async () => {
    const { deps, groupId } = await captured({ tabs: [{ url: 'https://a.test/1', active: true }] });
    const tabs = deps.tabs as FakeBrowserTabsPort;
    const result = await restoreGroup(deps, { groupId, windowId: 2, mode: 'newWindow' });

    expect(tabs.createdWindows()).toEqual([{ id: 3, incognito: false }]);
    expect(result.mode).toBe('newWindow');
    expect(result.windowId).toBe(3);
    // 原窗口没被污染
    expect(tabs.dump()[2]).toEqual([]);
    expect(tabs.dump()[3]?.map((tab) => tab.url)).toEqual(['https://a.test/1']);
  });

  it("mode='incognito' 带 incognito 建窗，结果里 mode 与 windowId 一起回传", async () => {
    const { deps, groupId } = await captured({ tabs: [{ url: 'https://a.test/1', active: true }] });
    const tabs = deps.tabs as FakeBrowserTabsPort;
    const result = await restoreGroup(deps, { groupId, windowId: 2, mode: 'incognito' });

    expect(tabs.createdWindows()).toEqual([{ id: 3, incognito: true }]);
    expect(result).toMatchObject({ mode: 'incognito', windowId: 3, restored: 1 });
  });

  it('无痕不被平台允许时如实抛出，不降级成普通窗口', async () => {
    const { deps, groupId } = await captured({
      tabs: [{ url: 'https://a.test/1', active: true }],
      incognitoDisallowed: true,
    });
    const tabs = deps.tabs as FakeBrowserTabsPort;

    await expect(restoreGroup(deps, { groupId, windowId: 2, mode: 'incognito' })).rejects.toThrow(
      /incognito/i,
    );
    expect(tabs.createdWindows()).toEqual([]);
    // 会话必须还在：报错不能把用户的数据一起弄丢
    expect(await deps.storage.getGroup(groupId)).toBeDefined();
  });

  it('restoreTab 对不可恢复的记录直接拒绝，不调 create', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [{ id: 11, url: 'chrome://settings', active: true }] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('收纳不该失败');
    const tabId = (await groupOf(deps.storage, outcome.result.groupId)).tabs[0]?.id;

    const result = await restoreTab(deps, { groupId: outcome.result.groupId, tabId: tabId ?? '', windowId: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-restorable');
  });
});

describe('undoCapture（V1.1 §29 / 既有约定）', () => {
  it('按原窗口位置重开真的被关掉的那些，然后删掉会话', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1' },
      { id: 12, url: 'https://a.test/2', active: true },
      { id: 13, url: 'https://a.test/3' },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('收纳不该失败');
    expect(outcome.result.closed).toBe(3);

    const result = await undoCapture(deps, { groupId: outcome.result.groupId, windowId: 1 });

    expect(result).toMatchObject({ restored: 3, skipped: 0, failed: 0 });
    // 撤销看的是 originalIndex，不是用户在列表里拖出来的 sortOrder
    expect((deps.tabs.dump()[1] ?? []).map((tab) => tab.url)).toEqual([
      'https://a.test/1',
      'https://a.test/2',
      'https://a.test/3',
    ]);
    // 焦点回到原来那一页
    expect((deps.tabs.dump()[1] ?? []).find((tab) => tab.active)?.url).toBe('https://a.test/2');
    expect(await deps.storage.getGroup(outcome.result.groupId)).toBeUndefined();
  });

  it('kept / failed 的条目不重开（它们从来没离开过窗口）', async () => {
    await settings({ keepActiveTab: true });
    const deps = ports({ windows: [{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: 'https://a.test/2' },
      { id: 13, url: 'https://a.test/3' },
    ] }] });
    const outcome = await captureWindow(deps, { windowId: 1, at: AT });
    if (!outcome.ok) throw new Error('收纳不该失败');
    expect(outcome.result).toMatchObject({ closed: 2, kept: 1 });

    const result = await undoCapture(deps, { groupId: outcome.result.groupId, windowId: 1 });
    expect(result).toMatchObject({ restored: 2, skipped: 1 });
    const urls = (deps.tabs.dump()[1] ?? []).map((tab) => tab.url);
    expect(urls.filter((url) => url === 'https://a.test/1')).toHaveLength(1);
  });

  it('分组已经不在时返回全零而不是抛错', async () => {
    const deps = ports({ windows: [{ id: 1, tabs: [{ id: 11, url: 'https://a.test/1', active: true }] }] });
    const result = await undoCapture(deps, { groupId: 'nope', windowId: 1 });
    expect(result).toMatchObject({ restored: 0, skipped: 0, failed: 0 });
  });
});

describe('纯数据命令', () => {
  async function withGroup(tabs: { url: string; active?: boolean }[]) {
    const storage = createStoragePort();
    const fakeTabs = createFakeBrowserTabsPort({
      windows: [{ id: 1, tabs: tabs.map((tab, index) => ({ id: 50 + index, ...tab })) }],
    });
    const outcome = await captureWindow(
      { storage, tabs: fakeTabs, entry: createFakeEntryPort() },
      { windowId: 1, at: AT },
    );
    if (!outcome.ok) throw new Error('收纳不该失败');
    return { deps: { storage, tabs: fakeTabs }, groupId: outcome.result.groupId };
  }

  it('renameGroup 拒绝空白标题并 bump updatedAt', async () => {
    const { deps, groupId } = await withGroup([{ url: 'https://a.test/1', active: true }]);
    await expect(renameGroup(deps, { groupId, title: '   ' })).rejects.toThrow();

    const renamed = await renameGroup(deps, { groupId, title: '  Flutter 开发  ' });
    expect(renamed.title).toBe('Flutter 开发');
    expect(renamed.updatedAt).toBeGreaterThanOrEqual(AT);
    expect((await deps.storage.listGroupIndex())[0]?.title).toBe('Flutter 开发');
  });

  it('togglePin 让组排到最前', async () => {
    const { deps, groupId } = await withGroup([{ url: 'https://a.test/1', active: true }]);
    // 列表是最新在前，所以要给"另一个"一个**更小**的 sortOrder，
    // 它才落在收纳那条的后面 —— 否则这条测试测的是方向而不是置顶。
    const other = await putEmptyGroup(deps.storage, { title: '另一个', sortOrder: -5 });

    const before = await deps.storage.listGroupIndex();
    expect(before[0]?.id).toBe(groupId);

    await togglePin(deps, { groupId: before[1]?.id ?? groupId });
    const after = await deps.storage.listGroupIndex();
    expect(after[0]?.id).toBe(before[1]?.id);
  });

  it('reorderGroups 不允许把未置顶的组拖进置顶区（避免视觉上弹回去）', async () => {
    const { deps, groupId } = await withGroup([{ url: 'https://a.test/1', active: true }]);
    const pinned = await putEmptyGroup(deps.storage, { title: '收藏区' });
    await togglePin(deps, { groupId: pinned.id });

    const order = await deps.storage.listGroupIndex();
    expect(order.map((entry) => entry.id)).toEqual([pinned.id, groupId]);

    const rejected = await reorderGroups(deps, { groupId, toIndex: 0 });
    expect(rejected.map((entry) => entry.id)).toEqual([pinned.id, groupId]);
  });

  it('会话列表按**最新在前**排', async () => {
    const { deps, groupId } = await withGroup([{ url: 'https://a.test/1', active: true }]);
    const second = await putEmptyGroup(deps.storage, { title: '后收的' });
    const third = await putEmptyGroup(deps.storage, { title: '最新' });

    const order = await deps.storage.listGroupIndex();
    expect(order.map((entry) => entry.id)).toEqual([third.id, second.id, groupId]);
  });

  it('reorderGroups：拖到哪个显示位置就落在哪个位置，且落盘（降序坐标系最容易在这里翻车）', async () => {
    const { deps, groupId } = await withGroup([{ url: 'https://a.test/1', active: true }]);
    const a = await putEmptyGroup(deps.storage, { title: 'A' });
    const b = await putEmptyGroup(deps.storage, { title: 'B' });
    const display = (entries: { id: string }[]) => entries.map((entry) => entry.id);
    expect(display(await deps.storage.listGroupIndex())).toEqual([b.id, a.id, groupId]);

    // 把最下面那条拖到最上面
    const after = await reorderGroups(deps, { groupId, toIndex: 0 });
    expect(display(after)).toEqual([groupId, b.id, a.id]);
    // 返回值对不算数，磁盘上重读必须一样（否则刷新一下就弹回去）
    expect(display(await deps.storage.listGroupIndex())).toEqual([groupId, b.id, a.id]);

    // 再拖回末尾，验证两个方向都对
    const back = await reorderGroups(deps, { groupId, toIndex: 2 });
    expect(display(back)).toEqual([b.id, a.id, groupId]);
  });

  it('deleteTab 后 sortOrder 重写为稠密', async () => {
    const { deps, groupId } = await withGroup([
      { url: 'https://a.test/1', active: true },
      { url: 'https://a.test/2' },
      { url: 'https://a.test/3' },
    ]);
    const group = await groupOf(deps.storage, groupId);
    const victim = group.tabs[0]?.id ?? '';
    const next = await deleteTab(deps, { groupId, tabId: victim });
    expect(next.tabs.map((tab) => tab.sortOrder)).toEqual([0, 1]);
    expect((await deps.storage.listGroupIndex())[0]?.tabCount).toBe(2);
  });

  it('moveTab 跨组移动，两边 tabCount 与 updatedAt 都更新', async () => {
    await settings({ keepActiveTab: true });
    const { deps, groupId } = await withGroup([
      { url: 'https://a.test/1', active: true },
      { url: 'https://a.test/2' },
    ]);
    const target = await putEmptyGroup(deps.storage, { title: 'Flutter 开发' });

    const source = await groupOf(deps.storage, groupId);
    const movedTab = source.tabs[1];
    if (!movedTab) throw new Error('缺第二条');

    const result = await moveTab(deps, {
      tabId: movedTab.id,
      fromGroupId: groupId,
      toGroupId: target.id,
      insertAt: 0,
    });
    expect(result).toBeDefined();

    const index = await deps.storage.listGroupIndex();
    expect(index.find((entry) => entry.id === groupId)?.tabCount).toBe(1);
    expect(index.find((entry) => entry.id === target.id)?.tabCount).toBe(1);
    const moved = await groupOf(deps.storage, target.id);
    expect(moved.tabs[0]?.url).toBe('https://a.test/2');
    expect(moved.tabs[0]?.groupId).toBe(target.id);
    // 跨组移动不改 originalIndex：那是"当时在窗口里的位置"，属于历史事实
    expect(moved.tabs[0]?.originalIndex).toBe(1);
  });

});
