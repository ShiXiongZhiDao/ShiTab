/**
 * 同步心跳。
 *
 * 钉的是"节拍源"那一半：判据（0081）会答"该拉了"，但得有人来问。
 * 这里用假时间把 60 秒这一格压成一次 `advanceTimersByTime`，
 * 所以测的是**挂载即敲 + 周期敲 + 退订后不再敲**这三件事，不依赖真时钟。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  isSyncPing,
  sendSyncPing,
  startSyncHeartbeat,
  SYNC_PING_EVERY_MS,
  SYNC_PING_MESSAGE,
} from '@/shared/sync-heartbeat';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startSyncHeartbeat', () => {
  it('挂载立刻敲一次，之后每 60 秒一次（不是等满一分钟才第一次）', () => {
    const pings = vi.fn();
    const stop = startSyncHeartbeat(pings);

    expect(pings).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SYNC_PING_EVERY_MS - 1);
    expect(pings).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(pings).toHaveBeenCalledTimes(2);

    stop();
  });

  /** 不退订的话，切走的页面会一直留一个幽灵节拍：多开几个工作台就是几倍请求。 */
  it('退订之后不再敲', () => {
    const pings = vi.fn();
    const stop = startSyncHeartbeat(pings);
    stop();

    vi.advanceTimersByTime(SYNC_PING_EVERY_MS * 3);
    expect(pings).toHaveBeenCalledTimes(1);
  });

  it('心跳发的就是 background 认得的那条消息', () => {
    const sent: unknown[] = [];
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(((message: unknown) => {
      sent.push(message);
      return Promise.resolve(undefined);
    }) as never);

    sendSyncPing();

    expect(sent).toHaveLength(1);
    expect(isSyncPing(sent[0])).toBe(true);
  });

  /** fakeBrowser 的 `runtime.sendMessage` 是"未实现即抛"（`publishCaptureNotice` 同一条），
   *  心跳必须咽得下去 —— 它只是节拍，敲不响不该把页面弄红。 */
  it('发不出去也不抛（下一次心跳补）', () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation((() => {
      throw new Error('MockNotImplementedError');
    }) as never);

    expect(() => sendSyncPing()).not.toThrow();
    expect(() => startSyncHeartbeat()).not.toThrow();
  });

  it('别的消息不算心跳（判别值只认那一个）', () => {
    expect(isSyncPing({ __shitab: 'shitab:command' })).toBe(false);
    expect(isSyncPing({ __shitab: SYNC_PING_MESSAGE })).toBe(true);
    expect(isSyncPing(null)).toBe(false);
    expect(isSyncPing('x')).toBe(false);
  });

  it('间隔与拉取判据同量级：敲得比判据还勤只是白敲', async () => {
    const { PULL_INTERVAL_MS } = await import('@/core/domain/sync-wake');
    expect(SYNC_PING_EVERY_MS).toBe(PULL_INTERVAL_MS);
  });
});
