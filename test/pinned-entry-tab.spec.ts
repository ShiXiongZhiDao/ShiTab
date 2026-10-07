/**
 * 入口标签页管理器（V1.1 设计包 A 的 AC-01..AC-11）。
 *
 * 这些用例全部走 fake ports，不在真浏览器里跑 —— 真机能验的是"Chrome 把 pinned tab
 * 画成什么样"，而这里要钉住的是**状态机**：什么时候建、什么时候不建、并发会不会建出两个、
 * move 失败几次之后会放弃。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENTRY_REBUILD_DEBOUNCE_MS,
  createPinnedEntryTab,
  isDraggingError,
} from '@/core/application/pinned-entry-tab';
import { createFakeBrowserTabsPort, FAKE_EXTENSION_ORIGIN } from '@/infrastructure/testing/fake-browser-tabs';
import { createFakeBrowserEventsPort } from '@/infrastructure/testing/fake-browser-events';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import type { FakeBrowserTabsOptions, FakeBrowserTabsPort } from '@/infrastructure/testing/fake-browser-tabs';
import type { Settings } from '@/shared/types';

const ENTRY_URL = `${FAKE_EXTENSION_ORIGIN}/app.html?entry=pinned-tab`;

async function patchSettings(overrides: Partial<Settings>): Promise<void> {
  const storage = createStoragePort();
  await storage.setSettings({ ...(await storage.getSettings()), ...overrides });
}

function harness(
  windows: FakeBrowserTabsOptions['windows'],
  options: Omit<FakeBrowserTabsOptions, 'windows'> = {},
) {
  const tabs = createFakeBrowserTabsPort({ windows, ...options });
  const events = createFakeBrowserEventsPort();
  const storage = createStoragePort();
  const manager = createPinnedEntryTab({ tabs, events, storage });
  return { tabs, events, storage, manager };
}

const entryTabsOf = (tabs: FakeBrowserTabsPort, windowId: number) =>
  (tabs.dump()[windowId] ?? []).filter((tab) => tab.url.startsWith(FAKE_EXTENSION_ORIGIN));

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
});

describe('ensureForWindow', () => {
  it('建出来的入口页是 pinned + index 0 + 带 entry 查询串（AC-01/02/03）', async () => {
    const { tabs, manager } = harness([{ id: 1, tabs: [{ id: 11, url: 'https://a.test/1' }] }]);
    await expect(manager.ensureForWindow(1)).resolves.toBe(true);

    const entries = entryTabsOf(tabs, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ pinned: true, index: 0, url: ENTRY_URL });
  });

  it('同一个窗口并发 ensure 两次只建一个（AC-05/AC-11 的窗口级锁）', async () => {
    const { tabs, manager } = harness([{ id: 1, tabs: [] }]);
    await Promise.all([manager.ensureForWindow(1), manager.ensureForWindow(1)]);
    expect(entryTabsOf(tabs, 1)).toHaveLength(1);
  });

  it('pinnedEntryEnabled=false 时什么都不做，并如实回报"没有落脚页"', async () => {
    await patchSettings({ pinnedEntryEnabled: false });
    const { tabs, manager } = harness([{ id: 1, tabs: [{ id: 11, url: 'https://a.test/1' }] }]);
    await expect(manager.ensureForWindow(1)).resolves.toBe(false);
    expect(entryTabsOf(tabs, 1)).toHaveLength(0);
  });

  it('重复实例只留一个，其余关掉（场景 D）', async () => {
    const { tabs, manager } = harness([{ id: 1, tabs: [
      { id: 11, url: ENTRY_URL, pinned: true },
      { id: 12, url: ENTRY_URL, pinned: true },
      { id: 13, url: 'https://a.test/1' },
    ] }]);
    await manager.ensureForWindow(1);

    expect(entryTabsOf(tabs, 1).map((tab) => tab.id)).toEqual([11]);
    expect((tabs.dump()[1] ?? []).map((tab) => tab.id)).toEqual([11, 13]);
  });

  it('用户取消固定后，下一次 ensure 会重新钉住', async () => {
    const { tabs, manager } = harness([{ id: 1, tabs: [
      { id: 11, url: ENTRY_URL, pinned: false },
      { id: 12, url: 'https://a.test/1' },
    ] }]);
    await manager.ensureForWindow(1);
    expect(entryTabsOf(tabs, 1)[0]?.pinned).toBe(true);
  });

  it('keepPinnedTabFirst=false 时不把它拽回最左（争议行为留了开关）', async () => {
    await patchSettings({ keepPinnedTabFirst: false });
    const { tabs, manager } = harness([{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1' },
      { id: 12, url: ENTRY_URL, pinned: true },
    ] }]);
    await manager.ensureForWindow(1);
    expect(entryTabsOf(tabs, 1)[0]?.index).toBe(1);
  });

  it('focus=true 时把入口页变成活动页（收纳后的收尾）', async () => {
    const { tabs, manager } = harness([{ id: 1, tabs: [
      { id: 11, url: 'https://a.test/1', active: true },
      { id: 12, url: ENTRY_URL, pinned: true },
    ] }]);
    await manager.ensureForWindow(1, { focus: true });
    expect((tabs.dump()[1] ?? []).find((tab) => tab.active)?.id).toBe(12);
  });

  it('tabs.move 遇到"用户正在拖拽"时有限次重试并成功', async () => {
    const { tabs, manager } = harness(
      [{ id: 1, tabs: [
        { id: 11, url: 'https://a.test/1' },
        { id: 12, url: ENTRY_URL, pinned: true },
      ] }],
      { draggingTabIds: [12] },
    );
    await manager.ensureForWindow(1);
    // 假仓储只在前两次抛错：第三次成功 => 位置被纠正
    expect(entryTabsOf(tabs, 1)[0]?.index).toBe(0);
  });

  it('move 一直失败时不抛穿：入口页仍算"有落脚页"', async () => {
    const { tabs, manager } = harness(
      [{ id: 1, tabs: [
        { id: 11, url: 'https://a.test/1' },
        { id: 12, url: ENTRY_URL, pinned: true },
      ] }],
      { draggingTabIds: [12] },
    );
    // 只让重试上限内失败，超过就抛：验证"位置不对不影响收纳继续"
    const spy = vi.spyOn(tabs, 'move').mockRejectedValue(
      new Error('Tabs cannot be edited right now (user may be dragging a tab).'),
    );
    await expect(manager.ensureForWindow(1)).resolves.toBe(true);
    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });

  it('isDraggingError 只认那句平台文案', () => {
    expect(isDraggingError(new Error('Cannot find tab with id 12.'))).toBe(false);
    expect(isDraggingError('Tabs cannot be edited right now (user may be dragging a tab).')).toBe(true);
  });
});

describe('生命周期', () => {
  it('新建普通窗口时补一个入口页（AC-09 多窗口各一个）', async () => {
    // 窗口 2 在假仓储里必须已经存在：Chrome 是"窗口建好才发 onCreated"，
    // 而假 tabs.create 对不存在的窗口会抛 —— 那正是我们要的严格性。
    const { tabs, events, manager } = harness([
      { id: 1, tabs: [] },
      { id: 2, tabs: [] },
    ]);
    manager.start();
    await events.emit.windowCreated(2);
    expect(entryTabsOf(tabs, 2)).toHaveLength(1);
    manager.stop();
  });

  it('onStartup / onInstalled 会补齐所有已有窗口', async () => {
    const { tabs, events, manager } = harness([
      { id: 1, tabs: [] },
      { id: 2, tabs: [{ id: 21, url: 'https://a.test/1' }] },
    ]);
    manager.start();
    await events.emit.startup();
    expect(entryTabsOf(tabs, 1)).toHaveLength(1);
    expect(entryTabsOf(tabs, 2)).toHaveLength(1);
    manager.stop();
  });

  it('stop 之后事件不再起作用（订阅确实退掉了）', async () => {
    const { tabs, events, manager } = harness([{ id: 1, tabs: [] }]);
    manager.start();
    manager.stop();
    expect(events.subscribed).toBe(false);
    await events.emit.windowCreated(3);
    expect(tabs.dump()[3]).toBeUndefined();
  });

  it('autoRestorePinnedTab=false（默认）时用户关掉入口页就不重建', async () => {
    vi.useFakeTimers();
    try {
      const { tabs, events, manager } = harness([{ id: 1, tabs: [
        { id: 11, url: ENTRY_URL, pinned: true },
      ] }]);
      manager.start();
      await tabs.remove([11]); // 平台先真关掉，再发 onRemoved
      await events.emit.tabRemoved({ tabId: 11, windowId: 1, isWindowClosing: false });
      await vi.advanceTimersByTimeAsync(ENTRY_REBUILD_DEBOUNCE_MS + 50);
      expect(entryTabsOf(tabs, 1)).toHaveLength(0);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoRestorePinnedTab=true 时 debounce 之后重建（AC-06/场景 C）', async () => {
    await patchSettings({ autoRestorePinnedTab: true });
    vi.useFakeTimers();
    try {
      const { tabs, events, manager } = harness([{ id: 1, tabs: [
        { id: 11, url: ENTRY_URL, pinned: true },
      ] }]);
      manager.start();
      await tabs.remove([11]);
      await events.emit.tabRemoved({ tabId: 11, windowId: 1, isWindowClosing: false });
      expect(entryTabsOf(tabs, 1)).toHaveLength(0); // 还没重建
      await vi.advanceTimersByTimeAsync(ENTRY_REBUILD_DEBOUNCE_MS + 50);
      expect(entryTabsOf(tabs, 1)).toHaveLength(1);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('整窗关闭（isWindowClosing）不触发重建风暴', async () => {
    await patchSettings({ autoRestorePinnedTab: true });
    vi.useFakeTimers();
    try {
      const { tabs, events, manager } = harness([{ id: 1, tabs: [
        { id: 11, url: ENTRY_URL, pinned: true },
      ] }]);
      manager.start();
      await tabs.remove([11]);
      await events.emit.tabRemoved({ tabId: 11, windowId: 1, isWindowClosing: true });
      await vi.advanceTimersByTimeAsync(ENTRY_REBUILD_DEBOUNCE_MS + 50);
      expect(entryTabsOf(tabs, 1)).toHaveLength(0);
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
