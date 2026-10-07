/**
 * 性能基线的共用夹具（既有约定 决定 10 / 既有约定 采纳 2 的实施第 1 步）。
 *
 * 两个消费者：
 * - `test/perf-baseline.spec.ts` —— 存储侧的结构量（`heal()` 的读次数、状态字节数）。
 * - `test/perf-dom-baseline.spec.ts` —— 界面侧的结构量（首屏元素节点数 / 行数 / favicon 数）。
 *
 * ★ 播种**不走 `putGroup`**：那函数每写一组都读-改-写整份 index（`infrastructure/storage/wxt-storage.ts:439-443`
 *   + `upsertIndexEntry` 的 `:271-277`），3,000 组就是 3,000 次全表重写 —— 那是**被测的病灶之一**，
 *   不能混进"把数据准备好"的成本里，否则测出来的数分不清是谁。
 *   这里照 `perf-baseline.spec.ts` 第 1 段**量出来的真实落盘形状**直接 `set`。
 */

import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { toIndexEntry } from '@/core/domain/group';
import { STORAGE_KEYS } from '@/shared/constants';
import type { GroupIndexEntry, SavedTab, TabGroup } from '@/shared/types';

export const AT = 1_700_000_000_000;

export function perfTab(groupId: string, index: number): SavedTab {
  const url = `https://example${index % 7}.com/path/${groupId}/${index}?q=query-value`;
  return {
    id: `${groupId}-t${index}`,
    groupId,
    url,
    title: `页面标题 ${groupId}-${index} with a reasonably long document title here`,
    faviconUrl: `https://example${index % 7}.com/favicon.ico`,
    domain: `example${index % 7}.com`,
    createdAt: AT + index,
    sortOrder: index,
    originalIndex: index,
    originalPinned: false,
    wasActive: index === 0,
    closeState: 'closed',
    restorable: true,
  };
}

export function perfGroup(index: number, tabs: SavedTab[]): TabGroup {
  return {
    id: `perf-g${index}`,
    title: `性能夹具会话 ${index}`,
    createdAt: AT,
    updatedAt: AT,
    isPinned: false,
    locked: false,
    sortOrder: index,
    tabs,
  };
}

/**
 * 五种分布。前四种口径来自外部设计包的 BENCHMARK §1（既有约定 采纳 2），
 * 第五种 `A2` 是为了**复现我们那句"首屏 600 行"的估算**而加的：
 * 同样 3,000 条，摊成 100 组 × 30 条时每张卡都恰好塞满 `COLLAPSED_TAB_LIMIT`。
 */
export const DISTRIBUTIONS = [
  { key: 'A', name: 'A 常规分布 300×10', groups: 300, tabsPerGroup: 10 },
  { key: 'A2', name: 'A2 深会话分布 100×30', groups: 100, tabsPerGroup: 30 },
  { key: 'B', name: 'B 大量小组 3000×1', groups: 3_000, tabsPerGroup: 1 },
  { key: 'C', name: 'C 超大单组 1×3000', groups: 1, tabsPerGroup: 3_000 },
  { key: 'D', name: 'D 预警档 500×10', groups: 500, tabsPerGroup: 10 },
] as const;

/**
 * 元数据兄弟键（`shitab:group:<id>$`）的形状**从一次真实写入里抓**，不手抄版本号常量 ——
 * `GROUP_VERSION` / `INDEX_VERSION` 在 `wxt-storage.ts` 里是模块私有的，抄进夹具就成了第二份真相。
 */
export async function captureGroupMetaShape(): Promise<Record<string, unknown>> {
  const storage = createStoragePort();
  await storage.putGroup(perfGroup(0, []));
  const raw = (await fakeBrowser.storage.local.get(null)) as Record<string, unknown>;
  const meta = raw[`${STORAGE_KEYS.group('perf-g0')}$`];
  if (typeof meta !== 'object' || meta === null) {
    throw new Error(`夹具假设元数据是对象，实际拿到 ${JSON.stringify(meta)}`);
  }
  await fakeBrowser.storage.local.clear();
  return meta as Record<string, unknown>;
}

export interface SeededState {
  totalTabs: number;
  /** 组值 + 索引条目 + 元数据的 JSON 字节总数（与平台无关，可和 既有约定 那批实测直接比）。 */
  stateBytes: number;
}

/** 按量出来的落盘形状一次写完，返回条数与字节数。 */
export async function seedDistribution(distribution: { groups: number; tabsPerGroup: number }): Promise<SeededState> {
  const metaShape = await captureGroupMetaShape();
  const entries: Record<string, unknown> = {};
  const index: GroupIndexEntry[] = [];
  let totalTabs = 0;
  let stateBytes = 0;

  for (let g = 0; g < distribution.groups; g += 1) {
    const tabs = Array.from({ length: distribution.tabsPerGroup }, (_, i) => perfTab(`perf-g${g}`, i));
    const record = perfGroup(g, tabs);
    totalTabs += tabs.length;
    const key = STORAGE_KEYS.group(record.id);
    entries[key] = record;
    // 每个兄弟键**新拷贝一份**：共享同一个对象引用会在后续写入里互相污染。
    entries[`${key}$`] = { ...metaShape };
    index.push(toIndexEntry(record));
  }
  entries[STORAGE_KEYS.groupIndex] = index;
  entries[`${STORAGE_KEYS.groupIndex}$`] = { ...metaShape };

  for (const [key, value] of Object.entries(entries)) {
    stateBytes += key.length + JSON.stringify(value).length;
  }

  await fakeBrowser.storage.local.set(entries);
  return { totalTabs, stateBytes };
}

export interface ReadWatch {
  calls: unknown[];
  /** 请求过的 `shitab:group:<id>` 键次数（不含 `$` 兄弟键、index、meta、rev）—— 逐键重读的直接计量。 */
  groupKeyReads(): number;
  /** `get(null)` / `get()` 这种"整块拉走"的次数。它一次覆盖所有组键，所以**不并进**上面那个数。 */
  bulkReads(): number;
  restore(): void;
}

/**
 * 包住 `storage.local.get` 记调用。WXT 的 driver 最终就是走这颗 API
 * （`@wxt-dev/storage@1.2.9/dist/index.mjs` 里 `createDriver` 取 `browser.storage[area]`），
 * 所以这层包装能看到全部读请求。
 */
export function watchStorageReads(): ReadWatch {
  const area = fakeBrowser.storage.local;
  const original = area.get.bind(area) as (keys?: unknown) => Promise<Record<string, unknown>>;
  const calls: unknown[] = [];
  (area as { get: unknown }).get = (keys?: unknown) => {
    calls.push(keys);
    return original(keys);
  };

  const flat = (call: unknown): string[] =>
    call == null ? [] : Array.isArray(call) ? (call as string[]) : [call as string];

  return {
    calls,
    groupKeyReads() {
      let count = 0;
      for (const call of calls) {
        count += flat(call).filter(
          (key) => typeof key === 'string' && key.startsWith(STORAGE_KEYS.groupKeyPrefix) && !key.endsWith('$'),
        ).length;
      }
      return count;
    },
    bulkReads() {
      return calls.filter((call) => call === null || call === undefined).length;
    },
    restore() {
      (area as { get: unknown }).get = original;
    },
  };
}
