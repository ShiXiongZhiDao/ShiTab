/**
 * BrowserEventsPort 的测试实现：`subscribe` 存下 handlers，`emit.*` 手动触发。
 *
 * 不用 fakeBrowser.tabs.onRemoved：入口页管理器的逻辑（去重、锁、debounce、
 * 只在开关打开时重建）全靠"事件按什么顺序到、到了几次"，而 fake-browser 是签名 mock，
 * 事件对象能不能真的响没人能保证。这里给的是**确定性的发射器**。
 */

import type { BrowserEventsPort, LifecycleHandlers, TabRemovedInfo } from '@/core/ports/browser-events';

export interface FakeBrowserEventsPort extends BrowserEventsPort {
  /** 当前是否处于订阅状态（管理器 start/stop 的可观测证据）。 */
  readonly subscribed: boolean;
  /** 每个 emit 返回订阅者那些 promise 的合并结果，测试可以 await 之后再断言。 */
  emit: {
    installed(): Promise<void>;
    startup(): Promise<void>;
    windowCreated(windowId: number): Promise<void>;
    windowRemoved(windowId: number): Promise<void>;
    tabRemoved(info: TabRemovedInfo): Promise<void>;
  };
}

export function createFakeBrowserEventsPort(): FakeBrowserEventsPort {
  let handlers: LifecycleHandlers | undefined;

  async function run(run?: () => void | Promise<void>): Promise<void> {
    await run?.();
  }

  return {
    subscribe(next: LifecycleHandlers): () => void {
      handlers = next;
      return () => {
        handlers = undefined;
      };
    },

    get subscribed(): boolean {
      return handlers !== undefined;
    },

    emit: {
      async installed() {
        await run(handlers?.onInstalled);
      },
      async startup() {
        await run(handlers?.onStartup);
      },
      async windowCreated(windowId) {
        await run(handlers?.onWindowCreated && (() => handlers?.onWindowCreated?.(windowId)));
      },
      async windowRemoved(windowId) {
        await run(handlers?.onWindowRemoved && (() => handlers?.onWindowRemoved?.(windowId)));
      },
      async tabRemoved(info) {
        await run(handlers?.onTabRemoved && (() => handlers?.onTabRemoved?.(info)));
      },
    },
  };
}
