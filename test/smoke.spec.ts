import { describe, expect, it } from 'vitest';

// 构建链自检：证明 WxtVitest 真的把 auto-imports 与扩展 API mock 接上了。
// 下面刻意不使用 import —— browser / storage / fakeBrowser 必须来自 WXT 的
// unimport 配置，否则整条测试链是假的。
describe('wxt vitest 环境', () => {
  it('auto-import 了 browser / storage，fakeBrowser 可读写', async () => {
    expect(typeof browser.runtime.id).toBe('string');
    expect(fakeBrowser.storage.local).toBeDefined();
    expect(storage.defineItem).toBeTypeOf('function');

    await fakeBrowser.storage.local.set({ probe: { a: 1 } });
    await expect(fakeBrowser.storage.local.get('probe')).resolves.toEqual({ probe: { a: 1 } });
  });

  it('storage.defineItem 支持 per-key version + migrations（既有约定 的迁移前提）', async () => {
    // 刻意全程用 storage API 读写，不去手填键名 —— 键名前缀（local:）如何落到
    // 具体 storage area 是库的实现细节，测试不该猜。
    const v1 = storage.defineItem<number>('local:migration_probe', { fallback: 0, version: 1 });
    await v1.setValue(5);

    const v2 = storage.defineItem<number>('local:migration_probe', {
      fallback: 0,
      version: 2,
      migrations: {
        2: (value: unknown) => (typeof value === 'number' ? value * 10 : 0),
      },
    });

    await expect(v2.getValue()).resolves.toBe(50);
  });

  it('item.watch 能在同一上下文内感知写入（既有约定 跨 surface 同步的机制）', async () => {
    const item = storage.defineItem<number>('local:watch_probe', { fallback: 0 });
    const seen: number[] = [];
    const stop = item.watch((value) => seen.push(value ?? -1));

    await item.setValue(7);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    expect(seen).toContain(7);
  });
});
