/**
 * 首屏计时的两条闸（既有约定 决定 10）。
 *
 * 这两条用例的形状是**对称的**：一条证明开着会打印，一条证明关着什么都不发。
 * 只写前者，"生产里不吵"就是没根据的（同一门课在别的项目上吃过两次）。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

async function loadModule(): Promise<typeof import('@/shared/perf-diagnostics')> {
  vi.resetModules();
  return import('@/shared/perf-diagnostics');
}

describe('首屏计时（perf-diagnostics）', () => {
  const log = vi.fn();

  beforeEach(() => {
    log.mockClear();
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      log(args.join(' '));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('开发构建：打一行，里面有前缀、六个时间和四个结构量', async () => {
    vi.stubEnv('DEV', true);
    const module = await loadModule();
    expect(module.perfDiagnosticsEnabled(), '这条用例的前提是开关为真，否则后面都是假绿').toBe(true);

    module.markHealDuration(12, { groupCount: 7, fixedTabCounts: 0 });
    module.reportFirstScreen({ cards: 3, rows: 42, elements: 1234, images: 42 }, 30);

    const line = log.mock.calls.map((call) => call[0]).find((text) => String(text).includes(module.PERF_LOG_PREFIX));
    expect(line, '没打任何一行日志 ⇒ 开关或调用链断了').toBeTruthy();
    expect(String(line)).toContain('heal=12ms');
    expect(String(line)).toContain('结构量：卡3 行42 节点1234 图42');
    expect(String(line)).toContain('会话7');
    // jsdom 没有 paint / navigation timing，取不到的项必须是 `?`，不许是 NaN 或 undefined
    expect(String(line)).toContain('首屏FCP=?');
    expect(String(line), '取不到的项一个都不许漏成 NaN：' + String(line)).not.toMatch(/NaN|undefined/);
  });

  it('生产构建：一个字都不打（判据是 import.meta.env.DEV）', async () => {
    vi.stubEnv('DEV', false);
    const module = await loadModule();
    expect(module.perfDiagnosticsEnabled()).toBe(false);

    module.markHealDuration(12, { groupCount: 7, fixedTabCounts: 0 });
    module.reportFirstScreen({ cards: 3, rows: 42, elements: 1234, images: 42 }, 30);

    expect(log, '生产构建里必须完全静默').not.toHaveBeenCalled();
  });

  it('没量到 heal 也不能抛（首屏日志是诊断，不是判据来源）', async () => {
    vi.stubEnv('DEV', true);
    const module = await loadModule();
    expect(() => module.reportFirstScreen({ cards: 0, rows: 0, elements: 10, images: 0 }, 5)).not.toThrow();
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('heal=?');
  });
});
