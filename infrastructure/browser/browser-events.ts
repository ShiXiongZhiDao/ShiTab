/**
 * BrowserEventsPort 的实现。
 *
 * 这里只做三件事：把 WXT 的统一 `browser` 事件签名收敛成 port 的形状、
 * 把每个回调里的异常吃掉并打日志、返回一个能全部退掉的 unsubscribe。
 *
 * 为什么必须自己 catch：MV3 的 service worker 里 listener 抛出的异常没有任何
 * 用户可见信号，只会让这一次事件被静默丢弃（表现是"点了没反应"）。
 */

import type { BrowserEventsPort, LifecycleHandlers, TabRemovedInfo } from '@/core/ports/browser-events';

type Listener = (...args: never[]) => void;

interface Topic {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** 一个"订阅并保证可退订"的最小封装。 */
function on(topic: Topic, listener: Listener): () => void {
  topic.addListener(listener);
  return () => topic.removeListener(listener);
}

/**
 * 把回调包成"异常进日志、promise 不悬空"的形式。
 *
 * 调用方**必须把处理器的 promise 原样返回**给它：`guard(() => void run(...))` 这种写法
 * 会把 promise 丢掉，异步异常就变成 unhandled rejection —— 测试里加了一条专门盯这个的断言
 * （`test/browser-events-and-messages.spec.ts`），因为我第一版就是这么写错的。
 */
function guard(run: () => void | Promise<void>): () => void {
  return () => {
    try {
      const result = run();
      if (result instanceof Promise) {
        result.catch((error: unknown) => console.error('[shitab] 生命周期处理失败', error));
      }
    } catch (error) {
      console.error('[shitab] 生命周期处理失败', error);
    }
  };
}

export function createBrowserEventsPort(): BrowserEventsPort {
  return {
    subscribe(handlers: LifecycleHandlers): () => void {
      const offs: Array<() => void> = [];

      if (handlers.onInstalled) {
        offs.push(on(browser.runtime.onInstalled as unknown as Topic, guard(handlers.onInstalled)));
      }

      if (handlers.onStartup) {
        offs.push(on(browser.runtime.onStartup as unknown as Topic, guard(handlers.onStartup)));
      }

      if (handlers.onWindowCreated) {
        const run = handlers.onWindowCreated;
        // windows.onCreated 给的是窗口对象，port 只把 id 交出去
        offs.push(
          on(browser.windows.onCreated as unknown as Topic, ((raw: unknown) => {
            const id = (raw as { id?: number }).id;
            if (id !== undefined) guard(() => run(id))();
          }) as Listener),
        );
      }

      if (handlers.onWindowRemoved) {
        const run = handlers.onWindowRemoved;
        offs.push(
          on(browser.windows.onRemoved as unknown as Topic, ((windowId: number) => {
            guard(() => run(windowId))();
          }) as Listener),
        );
      }

      if (handlers.onTabRemoved) {
        const run = handlers.onTabRemoved;
        offs.push(
          on(browser.tabs.onRemoved as unknown as Topic, ((tabId: number, removeInfo: unknown) => {
            const info: TabRemovedInfo = {
              tabId,
              windowId: (removeInfo as { windowId?: number }).windowId ?? -1,
              isWindowClosing: (removeInfo as { isWindowClosing?: boolean }).isWindowClosing === true,
            };
            guard(() => run(info))();
          }) as Listener),
        );
      }

      return () => offs.forEach((off) => off());
    },
  };
}
