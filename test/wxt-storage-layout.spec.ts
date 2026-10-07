import { describe, expect, it } from 'vitest';

/**
 * @wxt-dev/storage 的物理布局 —— 既有约定 的两条前提都建立在这上面，
 * 且**只能实测得知**（读 .d.mts 看不出来，注释里也没写）：
 *
 * 1. 值存在去掉 `local:` 前缀的键下；版本元数据存在**同名加 `$` 后缀的兄弟键**里，
 *    而这个兄弟键**只在真的发生版本升级/迁移时**才写 —— 纯写入和不改版本的读取都不产生它
 *    （这两点我各错过一次，见下面测试里的注释）。
 *    => 任何"按前缀扫描键"的代码都必须排除以 `$` 结尾的键，否则将来某次迁移之后，
 *       `shitab:group:<id>$` 会被当成一个分组，自愈逻辑反而制造脏数据。
 * 2. 迁移只跑一次，且状态跨 defineItem 调用持久（重开扩展同理）。
 */
describe('@wxt-dev/storage 物理布局', () => {
  it('版本元数据只在发生迁移时写入 "$" 兄弟键，按前缀扫描必须过滤掉它', async () => {
    const key = 'local:layout_probe_group:abc';
    const listKeys = async () => Object.keys((await browser.storage.local.get(null)) ?? {});

    const v1 = storage.defineItem<{ x: number }>(key, { fallback: { x: 0 }, version: 1 });
    await v1.setValue({ x: 7 });
    expect(await listKeys()).not.toContain('layout_probe_group:abc$');

    // 同版本读一次也不写元数据 —— 我先前两次都把它误推广成"setValue 会写"
    // 和"首次读取会写"，只有下面这次真跑过迁移才有 "$" 键。
    await expect(v1.getValue()).resolves.toEqual({ x: 7 });
    expect(await listKeys()).not.toContain('layout_probe_group:abc$');

    // 版本升级 + 迁移真正执行 => "$" 兄弟键出现
    const v2 = storage.defineItem<{ x: number }>(key, {
      fallback: { x: 0 },
      version: 2,
      migrations: {
        2: (value: unknown) =>
          typeof value === 'object' && value !== null ? { x: (value as { x: number }).x * 10 } : { x: 0 },
      },
    });
    await expect(v2.getValue()).resolves.toEqual({ x: 70 });

    const afterMigration = await listKeys();
    expect(afterMigration).toContain('layout_probe_group:abc');
    expect(afterMigration).toContain('layout_probe_group:abc$');

    // 这才是会踩的坑：一旦将来某次版本升级跑过迁移，朴素前缀扫描就会把
    // shitab:group:<id>$ 也当成一个分组，自愈逻辑反而制造脏数据。
    const naiveScan = afterMigration.filter((key2) => key2.startsWith('layout_probe_group:'));
    expect(naiveScan).toHaveLength(2);

    const correctScan = afterMigration.filter(
      (key2) => key2.startsWith('layout_probe_group:') && !key2.endsWith('$'),
    );
    expect(correctScan).toEqual(['layout_probe_group:abc']);
  });

  it('迁移只执行一次，且跨 item 定义保持已迁移状态', async () => {
    let calls = 0;
    const v1 = storage.defineItem<number>('local:layout_probe_mig', { fallback: 0, version: 1 });
    await v1.setValue(5);

    const makeV2 = () =>
      storage.defineItem<number>('local:layout_probe_mig', {
        fallback: 0,
        version: 2,
        migrations: {
          2: (value: unknown) => {
            calls += 1;
            return typeof value === 'number' ? value * 10 : 0;
          },
        },
      });

    await expect(makeV2().getValue()).resolves.toBe(50);
    await expect(makeV2().getValue()).resolves.toBe(50);
    expect(calls).toBe(1);

    // 版本链：2 -> 3 在已迁移的值上继续
    const v3 = storage.defineItem<number>('local:layout_probe_mig', {
      fallback: 0,
      version: 3,
      migrations: { 3: (value: unknown) => (typeof value === 'number' ? value + 100 : 0) },
    });
    await expect(v3.getValue()).resolves.toBe(150);
  });
});
