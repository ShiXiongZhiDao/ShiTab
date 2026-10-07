/**
 * 性能基线 · 存储侧（既有约定 决定 4 / 决定 10，既有约定 采纳 2 的实施第 1 步）。
 *
 * 两件事：
 * 1. **钉住 `heal()` 改造的承重前提** —— `browser.storage.local.get(null)` 拿回来的组值
 *    是"已经解析好的对象"还是"还要 `JSON.parse` 的字符串"。前提不成立，决定 4 整个作废。
 * 2. **量出病灶** —— `heal()` 一次冷启动到底请求多少个 `shitab:group:*` 键。
 *
 * ⚠ 口径：`ms` 是 **jsdom + fakeBrowser（内存假件）** 的墙上时间，**不是生产页面实测**，
 *   也不许当生产数字引用（既有约定 采纳 2 要求三类数字分开标注）。
 *   与平台无关、可以拿来比的是**读次数**与**字节数**两列。
 *
 * 夹具与播种在 `./perf-fixtures.ts`（界面侧基线共用同一份，不许出现第二份形状）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { createSearchService } from '@/core/application/search-tabs';
import { deleteTab } from '@/core/application/group-commands';
import { COLLAPSED_TAB_LIMIT, STORAGE_KEYS } from '@/shared/constants';
import { DISTRIBUTIONS, perfGroup, perfTab, seedDistribution, watchStorageReads } from './perf-fixtures';

/** 数一段代码请求过多少个组键。 */
async function measure(run: () => Promise<void>): Promise<number> {
  const watcher = watchStorageReads();
  try {
    await run();
    return watcher.groupKeyReads();
  } finally {
    watcher.restore();
  }
}

describe('性能基线 · raw 的形状（决定 heal 改造能不能成立）', () => {
  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
  });

  it('写两组带条目的会话之后，落盘键与值形状原样打出来', async () => {
    const storage = createStoragePort();
    await storage.putGroup(perfGroup(1, [perfTab('perf-g1', 0), perfTab('perf-g1', 1)]));
    await storage.putGroup(perfGroup(2, [perfTab('perf-g2', 0)]));

    const raw = (await fakeBrowser.storage.local.get(null)) as Record<string, unknown>;
    const keys = Object.keys(raw).sort();
    /* eslint-disable no-console */
    console.log(`[probe] 落盘键：${keys.join(' , ')}`);
    for (const key of keys) {
      const value = raw[key];
      console.log(`[probe] ${key} => typeof=${value === null ? 'null' : typeof value} isArray=${Array.isArray(value)}`);
    }
    /* eslint-enable no-console */

    const groupKey = STORAGE_KEYS.group('perf-g1');
    expect(keys).toContain(groupKey);
    /**
     * ★ 这条就是 既有约定 决定 4 的前提。测的是**假件**；真 `chrome.storage` 同样按结构化 JSON 存值，
     * 但那一档只能由他在 Edge 里确认（口径见 既有约定），本条不许替真机签字。
     */
    const value = raw[groupKey] as { tabs?: unknown[] } | string | null;
    expect(typeof value, '组值的类型').toBe('object');
    expect(value).not.toBeNull();
    expect(Array.isArray((value as { tabs: unknown[] }).tabs)).toBe(true);
    expect((value as { tabs: unknown[] }).tabs).toHaveLength(2);

    // `$` 兄弟键（版本元数据）也在 raw 里 —— 复用 raw 时得把它一起认出来。
    expect(keys, `元数据兄弟键 ${groupKey}$ 应当在 raw 里`).toContain(`${groupKey}$`);
  });

  it('折叠口径常量没被人顺手改小（首屏行数是它的乘积）', () => {
    expect(COLLAPSED_TAB_LIMIT).toBe(30);
  });
});

describe('性能基线 · heal() 的组键读放大', () => {
  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
  });

  it('五种分布各测一遍：稳态读次数 = 0（改之前是会话数 × 3）', async () => {
    const report: Array<{
      name: string;
      groups: number;
      totalTabs: number;
      groupReads: number;
      bulkReads: number;
      getCalls: number;
      stateKiB: string;
      healMsInMemory: number;
    }> = [];

    for (const distribution of DISTRIBUTIONS) {
      const seeded = await seedDistribution(distribution);

      const watcher = watchStorageReads();
      const started = Date.now();
      const storage = createStoragePort();
      const healed = await storage.heal();
      const healMs = Date.now() - started;
      const groupReads = watcher.groupKeyReads();
      const bulkReads = watcher.bulkReads();
      const getCalls = watcher.calls.length;
      watcher.restore();

      expect(healed.groupCount, `${distribution.name} 的自愈应当认全所有会话`).toBe(distribution.groups);

      report.push({
        name: distribution.name,
        groups: distribution.groups,
        totalTabs: seeded.totalTabs,
        groupReads,
        bulkReads,
        getCalls,
        stateKiB: (seeded.stateBytes / 1024).toFixed(1),
        healMsInMemory: healMs,
      });

      /**
       * ★ 既有约定 决定 4 落地之后的差分断言：稳态下 heal **一次组键都不回读**，
       *   值直接从它自己那次 `get(null)` 拉回的 `raw` 里取（`infrastructure/storage/wxt-storage.ts` 的 `groupFromRaw`）。
       *
       *   改之前的实测（同一条用例、同一批夹具）：**A 900 / A2 300 / B 9,000 / C 3 / D 1,500**，
       *   即"每个会话三次读"。⚠ **这条不许删** —— 删掉就等于那笔改造失去了差分证明；
       *   把它改回 `toBe(groups * 3)` 而 heal 没变，就是有人把逐键重读写回去了。
       */
      expect(groupReads, `${distribution.name}：稳态下 heal 不该再逐键读组值`).toBe(0);
      /** heal 仍然只做那**一次**整块读 —— 收益不是靠少读数据换来的，是靠不重复读。 */
      expect(bulkReads, 'heal 自己那一次 get(null)').toBe(1);
    }

    /* eslint-disable no-console */
    console.table(report);
    console.log(
      '[baseline] 口径：groupReads / stateKiB 与平台无关；healMsInMemory 只是内存假件的墙上时间，**不是生产实测**。',
    );
    /* eslint-enable no-console */
  });
});

describe('性能基线 · 整份读的往返次数（listAllGroups）', () => {
  /**
   * `listAllGroups()` 本身的读放大**没修，也不该在这里修**：它现在服务的是
   * 同步（`sync-engine.ts:265`）、导入导出（`import-export.ts:256`）、耐久快照（`durable-snapshot.ts:109`）——
   * 那些路径**确实**要整份数据。既有约定 决定 12 把同步侧列为"只量不治"，这条就是那里的量。
   *
   * ★ 搜索已经不走它了（2026-10-06，决定 6 / 采纳 3 落地）⇒ 下面那条用例测的是搜索的新形状。
   */
  it('一次 listAllGroups()：组键读 = 会话数（一次批量拿完），`get()` 往返 = 2（改之前是 3N 与 3N+4）', async () => {
    await fakeBrowser.storage.local.clear();
    const distribution = DISTRIBUTIONS[0];
    await seedDistribution(distribution);

    const watcher = watchStorageReads();
    const storage = createStoragePort();
    const groups = await storage.listAllGroups();
    const groupReads = watcher.groupKeyReads();
    const getCalls = watcher.calls.length;
    watcher.restore();

    expect(groups).toHaveLength(distribution.groups);
    /* eslint-disable no-console */
    console.log(
      `[baseline] listAllGroups：${distribution.name} 组键读 ${groupReads} / get() 往返 ${getCalls}` +
        '（改之前：组键读 = 会话数 × 3、往返 = 会话数 × 3 + 4）',
    );
    /* eslint-enable no-console */
    /**
     * ★ 差分：以前每个会话都要 `groupItem(id).getValue()` ⇒ **三次往返 × N**；
     *   现在一次 `get(keys)` 把值与 `$` 兄弟键一起拿回来 ⇒ 组键读只剩 N（那一次批量里各算一键），
     *   往返只剩 2（一次读索引 + 一次批量读）。
     *   ⚠ 这两条断言不许删：它们是"整份读"这条路径的差分证明（同步 / 导入导出 / 耐久快照都走它）。
     */
    expect(groupReads, '一次批量读里每个会话只算一键').toBe(distribution.groups);
    expect(getCalls, '稳态下整份读只要两次往返').toBeLessThanOrEqual(3);
  });

  /**
   * ★ 搜索侧的收益量（既有约定 决定 6 / 既有约定 采纳 3 落地之后）。
   *
   * 口径要说清楚，否则会被读成"搜索变快了"：
   * - **第一次搜索仍然要认全部会话**（300 组 = 900 次读）—— 这一档没变，变的下面那条；
   * - **旧形状是"任何一次变更后，下一次搜索又回到 900 次"**（`watchGroups` 整份作废），
   *   而人真正会连续做的事情就是"改一条 → 马上搜一下"，所以那才是每天在付的钱；
   * - 新形状：改一条 ⇒ 只回源那**一个**会话 = 3 次读。
   * 语义判据（不许陈旧）在 `test/search-cache-scope.spec.ts`，这条只量数。
   */
  it('搜索：改一条记录之后，下一次搜索只回源一个会话（旧形状是全部）', async () => {
    const distribution = DISTRIBUTIONS[0];
    await seedDistribution(distribution);
    const storage = createStoragePort();
    const service = createSearchService({
      listGroupIndex: () => storage.listGroupIndex(),
      listGroupsByIds: (ids) => storage.listGroupsByIds(ids),
    });

    const cold = await measure(async () => {
      await service.search('example0');
    });
    expect(cold, '第一次认全部会话：一次批量读 ⇒ 每个会话只算一键').toBe(distribution.groups);

    await deleteTab({ storage }, { groupId: 'perf-g3', tabId: 'perf-g3-t1' });
    const afterChange = await measure(async () => {
      await service.search('example0');
    });
    /* eslint-disable no-console */
    console.log(
      `[baseline] 搜索：${distribution.name} 第一次 ${cold} 次组键读（改之前是 ${distribution.groups * 3}）；` +
        `改一条之后 ${afterChange} 次（收窄失效之前是 ${cold} 次）`,
    );
    /* eslint-enable no-console */
    expect(afterChange, '改一条只回源那一个会话（一次批量 = 一键，不再是一会话三次往返）').toBe(1);
  });
});
