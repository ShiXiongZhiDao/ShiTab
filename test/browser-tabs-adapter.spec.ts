/**
 * BrowserTabsPort 的真实现（`infrastructure/browser/browser-tabs.ts`）跑在 fakeBrowser 上。
 *
 * 这一层的价值在于：所有业务测试用的都是手写的那份假 port（fake-browser-tabs.ts），
 * 只有这里会真的经过"字段映射 + 缺字段丢弃 + allSettled 计数"。隔壁仓库那次
 * "manifest 缺 action 键导致 SW 启动即抛"的教训说明：**装配点与适配层是最容易没被测到的一层**。
 *
 * 顺带把 @webext-core/fake-browser@2.0.1 的真实能力钉在这里（我实测过，不是猜）：
 * `tabs.create/query/update/get`、`windows.getAll/create/remove`、`runtime.getURL`、
 * `action.set/getBadgeText` 都可用；而 `tabs.move` 抛 "not implemented"、
 * `tabs.remove(number)` 直接崩、`windows.getCurrent()` 返回 undefined ——
 * 所以那几个方法只能靠 spy，那也正是它们该被测的原因（平台不给兜底）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTabsPort, errorMessage } from '@/infrastructure/browser/browser-tabs';
import { ENTRY_PAGE_PATH } from '@/shared/constants';
import type { CreateTabInput } from '@/shared/types';

const port = createBrowserTabsPort();

function createInput(over: Partial<CreateTabInput> = {}): CreateTabInput {
  return { url: 'https://a.test/1', windowId: 0, active: false, ...over };
}

beforeEach(() => {
  fakeBrowser.tabs.resetState();
  fakeBrowser.windows.resetState();
  vi.restoreAllMocks();
});

describe('queryWindowTabs 的字段映射', () => {
  it('把平台 tab 映射成 BrowserTab，保留 index/pinned/active', async () => {
    await fakeBrowser.tabs.create({ url: 'https://a.test/first', windowId: 0 });
    await fakeBrowser.tabs.create({ url: 'https://a.test/second', windowId: 0, pinned: true });

    const tabs = await port.queryWindowTabs(0);

    expect(tabs.map((tab) => tab.url)).toEqual([
      // 假仓储里还有一个没有 url 的默认 tab，它被保留下来（url 归一成空串）
      '',
      'https://a.test/first',
      'https://a.test/second',
    ]);
    expect(tabs[2]).toMatchObject({ pinned: true, active: false });
    expect(tabs.every((tab) => typeof tab.id === 'number' && typeof tab.windowId === 'number')).toBe(true);
  });

  it('没有 id 或没有 windowId 的 tab 直接丢弃，不猜', async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
      { id: 1, url: 'https://a.test/1' }, // 缺 windowId
      { windowId: 0, url: 'https://a.test/2' }, // 缺 id
      { id: 3, windowId: 0, url: 'https://a.test/3' }, // 正常
    ] as never);

    const tabs = await port.queryWindowTabs(0);
    expect(tabs.map((tab) => tab.url)).toEqual(['https://a.test/3']);
  });

  it('url 缺失时归一成空串而不是 undefined', async () => {
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([{ id: 1, windowId: 0 }] as never);
    const [tab] = await port.queryWindowTabs(0);
    expect(tab?.url).toBe('');
    expect(tab?.title).toBe('');
  });
});

describe('create / update / move', () => {
  it('create 把 index 与 pinned 原样传给平台，并回真实 id', async () => {
    const spy = vi.spyOn(fakeBrowser.tabs, 'create');
    const created = await port.create({ ...createInput(), index: 0, pinned: true });

    const arg = spy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).toMatchObject({ url: 'https://a.test/1', windowId: 0, index: 0, active: false, pinned: true });
    expect(typeof created.tabId).toBe('number');
  });

  it('不传 index 时不往参数对象里塞 index 键（把"没意见"和"要 0 号位"分开）', async () => {
    const spy = vi.spyOn(fakeBrowser.tabs, 'create');
    await port.create(createInput());
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('index');
  });

  it('平台没回 id 时抛错而不是返回 undefined', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({ url: 'https://a.test/1' } as never);
    await expect(port.create(createInput())).rejects.toThrow('未返回 tab id');
  });

  it('update 走平台并映射结果', async () => {
    const created = await fakeBrowser.tabs.create({ url: 'https://a.test/1', windowId: 0 });
    const updated = await port.update(created.id as number, { pinned: true });
    expect(updated.pinned).toBe(true);
  });

  it('move 只透传 (tabId, {index})，重试策略不归它管', async () => {
    const spy = vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue([] as never);
    await port.move(42, 0);
    expect(spy).toHaveBeenCalledWith(42, { index: 0 });
  });
});

describe('remove 的逐条计数（ARCHITECTURE §7 的依赖项）', () => {
  it('部分失败时给出 closed 与 failed，且失败带平台原文', async () => {
    // 适配器是**逐条**调 tabs.remove(id)（不是传数组），所以这里按单值收；
    // 平台声明的类型写的是 number[]，与它自己的实现不一致，只能放宽。
    vi.spyOn(fakeBrowser.tabs, 'remove').mockImplementation(
      (async (id: unknown) => {
        if (id === 2) throw new Error('Tab cannot be closed');
        return undefined;
      }) as never,
    );

    const outcome = await port.remove([1, 2, 3]);

    expect(outcome.closed).toEqual([1, 3]);
    expect(outcome.failed).toEqual([{ tabId: 2, error: 'Tab cannot be closed' }]);
  });

  it('全部失败也不会抛穿：调用方拿到的仍是结构化结果', async () => {
    vi.spyOn(fakeBrowser.tabs, 'remove').mockRejectedValue(new Error('nope'));
    await expect(port.remove([7, 8])).resolves.toMatchObject({
      closed: [],
      failed: [{ tabId: 7, error: 'nope' }, { tabId: 8, error: 'nope' }],
    });
  });
});

describe('窗口枚举与 URL', () => {
  it('listNormalWindows 排除 popup / devtools，也排除没有 id 的窗口', async () => {
    vi.spyOn(fakeBrowser.windows, 'getAll').mockResolvedValue([
      { id: 1, type: 'normal' },
      { id: 2, type: 'popup' },
      { id: 3, type: 'devtools' },
      { type: 'normal' }, // 没有 id
    ] as never);

    const windows = await port.listNormalWindows();
    expect(windows.map((window) => window.id)).toEqual([1]);
  });

  it('平台没给 type 时按 normal 处理（假仓储就是这样）', async () => {
    vi.spyOn(fakeBrowser.windows, 'getAll').mockResolvedValue([{ id: 5 }, { id: 6, type: 'popup' }] as never);
    expect((await port.listNormalWindows()).map((window) => window.id)).toEqual([5]);
  });

  it('getCurrent / createWindow 拿不到 id 时抛中文错，而不是返回 NaN', async () => {
    vi.spyOn(fakeBrowser.windows, 'getCurrent').mockResolvedValue(undefined as never);
    await expect(port.getCurrentWindow()).rejects.toThrow('无法解析当前窗口');

    vi.spyOn(fakeBrowser.windows, 'create').mockResolvedValue({} as never);
    await expect(port.createWindow({ focused: true })).rejects.toThrow('无法解析新建窗口');
  });

  it('entryPageUrl 走 runtime.getURL 并带上入口页路径', () => {
    expect(port.entryPageUrl()).toBe(`chrome-extension://test-extension-id${ENTRY_PAGE_PATH}`);
  });
});

describe('existingUrls', () => {
  it('空 url 的 tab 不进集合（否则恢复去重会把"没地址的页"当成已存在）', async () => {
    vi.spyOn(port, 'queryWindowTabs').mockResolvedValue([
      { id: 1, windowId: 0, url: '', title: '', active: false, pinned: false, index: 0 },
      { id: 2, windowId: 0, url: 'https://a.test/1', title: '', active: false, pinned: false, index: 1 },
    ]);
    expect([...(await port.existingUrls(0))]).toEqual(['https://a.test/1']);
  });
});

describe('errorMessage', () => {
  it('Error / 字符串 / 其它对象三种都给出可读文本', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage({ code: 1 })).toContain('code');
  });
});
