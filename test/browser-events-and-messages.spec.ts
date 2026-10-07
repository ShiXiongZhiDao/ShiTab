/**
 * BrowserEventsPort 的真实现 + 自建消息层（shared/messages.ts）。
 *
 * 这两件都是"接线件"：写错了不会让任何 use case 测试变红，只会让真机上"点了没反应"。
 * 事件用 fakeBrowser 的 `.trigger()` 真发（@webext-core/fake-browser 的事件对象带这个非标准方法）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserEventsPort } from '@/infrastructure/browser/browser-events';
import { COMMAND_MESSAGE, CommandError, registerCommandHandler, sendCommand } from '@/shared/messages';
import type { Command } from '@/shared/messages';
import type { LifecycleHandlers } from '@/core/ports/browser-events';
import { newId } from '@/shared/utils';

/**
 * fakeBrowser 的事件对象有个非标准的 `trigger()`，但它的**类型签名**是真实 webextension 的，
 * 传测试构造的畸形参数会被类型系统挡下。这里统一走一个放宽过的取法。
 */
function triggerOf(event: unknown): (...args: unknown[]) => Promise<unknown[]> {
  return (event as { trigger: (...args: unknown[]) => Promise<unknown[]> }).trigger;
}

// ---------------------------------------------------------------------------
// 事件适配层
// ---------------------------------------------------------------------------

describe('browser-events adapter', () => {
  let off: (() => void) | undefined;

  afterEach(() => {
    off?.();
    off = undefined;
    vi.restoreAllMocks();
  });

  it('onWindowCreated 只把窗口 id 交给处理器，畸形事件不往下传', async () => {
    const seen: number[] = [];
    off = createBrowserEventsPort().subscribe({
      onWindowCreated: (windowId) => {
        seen.push(windowId);
      },
    });

    await triggerOf(fakeBrowser.windows.onCreated)({ id: 3 });
    expect(seen).toEqual([3]);

    // 平台没给 id 的畸形事件不该把 undefined 传下去
    await triggerOf(fakeBrowser.windows.onCreated)({} as never);
    expect(seen).toHaveLength(1);
  });

  it('onTabRemoved 映射 isWindowClosing，缺失时按 false', async () => {
    const seen: unknown[] = [];
    off = createBrowserEventsPort().subscribe({
      onTabRemoved: (info) => {
        seen.push(info);
      },
    });

    await triggerOf(fakeBrowser.tabs.onRemoved)(5, { windowId: 2, isWindowClosing: true });
    await triggerOf(fakeBrowser.tabs.onRemoved)(6, { windowId: 2 });

    expect(seen).toEqual([
      { tabId: 5, windowId: 2, isWindowClosing: true },
      { tabId: 6, windowId: 2, isWindowClosing: false },
    ]);
  });

  it('windows.onCreated 只把 id 交出去；没有 id 的窗口事件被忽略', async () => {
    const created: number[] = [];
    const removed: number[] = [];
    off = createBrowserEventsPort().subscribe({
      onWindowCreated: (windowId) => {
        created.push(windowId);
      },
      onWindowRemoved: (windowId) => {
        removed.push(windowId);
      },
    });

    await triggerOf(fakeBrowser.windows.onCreated)({ id: 9, type: 'normal' });
    await triggerOf(fakeBrowser.windows.onCreated)({ type: 'normal' });
    await triggerOf(fakeBrowser.windows.onRemoved)(9);

    expect(created).toEqual([9]);
    expect(removed).toEqual([9]);
  });

  it('onInstalled / onStartup 接通', async () => {
    let installed = 0;
    let startup = 0;
    off = createBrowserEventsPort().subscribe({
      onInstalled: () => {
        installed += 1;
      },
      onStartup: () => {
        startup += 1;
      },
    });

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' });
    await fakeBrowser.runtime.onStartup.trigger();
    expect([installed, startup]).toEqual([1, 1]);
  });

  it('退订之后事件不再送达', async () => {
    const seen: number[] = [];
    const unsubscribe = createBrowserEventsPort().subscribe({
      onWindowCreated: (windowId) => {
        seen.push(windowId);
      },
    });

    await triggerOf(fakeBrowser.windows.onCreated)({ id: 1 });
    unsubscribe();
    await triggerOf(fakeBrowser.windows.onCreated)({ id: 2 });

    expect(seen).toEqual([1]);
  });

  it('处理器抛错被吞进日志，不会让触发方 reject，也不会让后续事件失联', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let later = 0;
    off = createBrowserEventsPort().subscribe({
      onTabRemoved: () => {
        throw new Error('同步炸');
      },
      onWindowCreated: () => {
        later += 1;
        return Promise.reject(new Error('异步炸'));
      },
    });

    // trigger 的返回值是"每个 listener 的返回值数组"（Promise.all），
    // 所以这里断言的是**没有 reject**，而不是返回 undefined 本身。
    await expect(
      triggerOf(fakeBrowser.tabs.onRemoved)(1, { windowId: 1, isWindowClosing: false }),
    ).resolves.toEqual([undefined]);
    await expect(triggerOf(fakeBrowser.windows.onCreated)({ id: 2 })).resolves.toEqual([undefined]);

    expect(later).toBe(1);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('没给某个处理器时不去订阅那个事件（避免留下没人听的 listener）', () => {
    const spy = vi.spyOn(fakeBrowser.tabs.onActivated, 'addListener');
    off = createBrowserEventsPort().subscribe({ onStartup: () => undefined } as LifecycleHandlers);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 消息层
// ---------------------------------------------------------------------------

describe('registerCommandHandler + sendCommand', () => {
  const handled: Command[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    handled.length = 0;
    unsubscribe?.();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    vi.restoreAllMocks();
  });

  it('信封往返一次：命令出去、结果回来，operationId 全程带着', async () => {
    unsubscribe = registerCommandHandler(async (command, operationId) => {
      handled.push(command);
      return { operationId, echoed: command };
    });

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (message: unknown) => {
      const [response] = await triggerOf(fakeBrowser.runtime.onMessage)(message);
      return response;
    });

    const command = { kind: 'restoreGroup', windowId: 4, groupId: 'g1' } as const;
    const result = await sendCommand(command, 'op-42');

    expect(handled).toEqual([command]);
    expect(result).toMatchObject({ operationId: 'op-42', echoed: command });
  });

  it('handler 抛错时返回 ok:false + 错误文本，而不是让消息通道悬空', async () => {
    unsubscribe = registerCommandHandler(async () => {
      throw new Error('平台拒绝了这次操作');
    });

    const [response] = await triggerOf(fakeBrowser.runtime.onMessage)({
      __shitab: COMMAND_MESSAGE,
      operationId: 'op',
      command: { kind: 'captureWindow', windowId: 1 },
    });

    expect(response).toEqual({ ok: false, error: '平台拒绝了这次操作' });
  });

  it('不是我们的消息一律返回 undefined（把响应让给别的扩展/别的 listener）', async () => {
    unsubscribe = registerCommandHandler(async () => '不该被调用');

    const emit = (message: unknown) => triggerOf(fakeBrowser.runtime.onMessage)(message);

    expect(await emit('字符串')).toEqual([undefined]);
    expect(await emit({ someOtherExtensionKey: 1 })).toEqual([undefined]);
    expect(await emit({ __shitab: COMMAND_MESSAGE, command: { kind: 'x' } })).toEqual([undefined]); // 缺 operationId
  });

  it('没有响应时 sendCommand 抛 CommandError(no-response)', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    await expect(
      sendCommand({ kind: 'ensureEntryTab', windowId: 1 }, newId()),
    ).rejects.toBeInstanceOf(CommandError);
  });

  it('ok:false 的响应被翻成 CommandError，并带上原始错误文本', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: false, error: '收纳失败' } as never);
    await expect(sendCommand({ kind: 'undoCapture', windowId: 1, groupId: 'g' }, newId())).rejects.toThrow('收纳失败');
  });
});
