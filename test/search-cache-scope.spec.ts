/**
 * 搜索缓存的**失效粒度**（既有约定 决定 6 / 既有约定 采纳 3）。
 *
 * 判据是一条可数的量：一次变更后，下一次搜索回源**几个会话**。
 * 旧形状是"变更信号一来整份作废 ⇒ 下一次搜索 `listAllGroups()` 读全部"，
 * 实测每个会话三次读 ⇒ 300 组那一档每改一条就要付 900 次读。
 *
 * 用的是**真仓储 + fakeBrowser**（不是假仓储自证）：`test/search-and-backup.spec.ts` 里那条
 * 用假仓储数调用次数，只能证明服务自己的逻辑；这条证明的是"存储真的少读了"。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { createSearchService } from '@/core/application/search-tabs';
import { deleteGroup, deleteTab, renameGroup, reorderTab } from '@/core/application/group-commands';
import type { StoragePort } from '@/core/ports/storage';
import { perfGroup, perfTab, watchStorageReads } from './perf-fixtures';

const GROUPS = 12;
const TABS_PER_GROUP = 5;

/** 跑一段代码，返回它期间请求过的 `shitab:group:<id>` 键次数。 */
async function countGroupReads(run: () => Promise<void>): Promise<number> {
  const watcher = watchStorageReads();
  try {
    await run();
    return watcher.groupKeyReads();
  } finally {
    watcher.restore();
  }
}

describe('搜索缓存按会话失效', () => {
  let storage: StoragePort;
  let service: ReturnType<typeof createSearchService>;

  beforeEach(async () => {
    await fakeBrowser.storage.local.clear();
    storage = createStoragePort();
    for (let g = 0; g < GROUPS; g += 1) {
      const id = `perf-g${g}`;
      await storage.putGroup(perfGroup(g, Array.from({ length: TABS_PER_GROUP }, (_, i) => perfTab(id, i))));
    }
    service = createSearchService({
      listGroupIndex: () => storage.listGroupIndex(),
      listGroupsByIds: (ids) => storage.listGroupsByIds(ids),
    });
  });

  it('第一次把全部会话认一遍，第二次一次都不回源', async () => {
    const first = await countGroupReads(async () => {
      const hits = await service.search('example0');
      expect(hits.length, '每个会话都有 example0.com 的记录，应该全命中').toBe(GROUPS);
    });
    expect(first, '第一次要认全部会话（一次批量，每个会话只算一键）').toBe(GROUPS);

    const second = await countGroupReads(async () => {
      await service.search('example0');
    });
    expect(second, '指纹没变还去读存储 ⇒ 缓存等于没有').toBe(0);
  });

  /**
   * ★ 这条就是本轮要省的那笔钱：删掉一条记录之后搜索，只许回源**被改的那一个会话**。
   * 旧形状在这里会是 `GROUPS × 3` 次读（整份作废 + 全量重建）。
   */
  it('删掉一条记录 ⇒ 下一次搜索只回源那一个会话', async () => {
    // 词选 `perf-g3`：它命中那一组的**全部** 5 条（每条 URL 都带组 id），才数得出"少了一条"
    await service.search('perf-g3');

    await deleteTab({ storage }, { groupId: 'perf-g3', tabId: 'perf-g3-t1' });

    const reads = await countGroupReads(async () => {
      const hits = await service.search('perf-g3');
      const target = hits.find((hit) => hit.group.id === 'perf-g3');
      expect(target?.matchedTabs, '被删的那条不再出现在命中里').toHaveLength(TABS_PER_GROUP - 1);
      expect(target?.matchedTabs.some((tab) => tab.id === 'perf-g3-t1'), '旧记录不许留在结果里').toBe(false);
    });
    expect(reads, '只该回源被改的那一个会话（一次批量 = 一键）').toBe(1);
  });

  /**
   * ★ 承重前提的正向对照：**只有 `updatedAt` 变、`tabCount` 不变**的那种改动（组内重排）
   * 也必须被指纹认出来。认不出来的话，搜索结果里的行序会停在旧顺序 ——
   * 而这条前提同时是 既有约定 实体级 LWW 的地基，所以它坏了不能只在这里兜底。
   */
  it('组内重排（条数没变）也认得出来：搜索结果的行序跟着变', async () => {
    await service.search('perf-g7');
    const before = (await service.search('perf-g7')).find((hit) => hit.group.id === 'perf-g7')?.matchedTabs;
    expect(before?.map((tab) => tab.id)).toEqual([
      'perf-g7-t0',
      'perf-g7-t1',
      'perf-g7-t2',
      'perf-g7-t3',
      'perf-g7-t4',
    ]);

    await reorderTab({ storage }, { groupId: 'perf-g7', tabId: 'perf-g7-t0', toIndex: 4 });

    const reads = await countGroupReads(async () => {
      await service.search('perf-g7');
    });
    expect(reads, '条数没变就不回源 ⇒ 这条前提没成立（会显示旧顺序）').toBe(1);

    const after = (await service.search('perf-g7')).find((hit) => hit.group.id === 'perf-g7')?.matchedTabs;
    expect(after?.map((tab) => tab.id).at(-1), '被拖到末尾的那条要真的在末尾').toBe('perf-g7-t0');
  });

  it('会话改名 ⇒ 认出来；旧标题搜不到、新标题搜得到', async () => {
    await service.search('性能夹具会话 5');

    await renameGroup({ storage }, { groupId: 'perf-g5', title: '换了个名字' });

    const stale = await service.search('性能夹具会话 5');
    expect(stale.some((hit) => hit.group.id === 'perf-g5'), '改完名还能按旧名搜到 ⇒ 缓存陈旧').toBe(false);
    const fresh = await service.search('换了个名字');
    expect(fresh.map((hit) => hit.group.id), '按新名字要能搜到它').toEqual(['perf-g5']);
  });

  it('整组删除 ⇒ 结果里没有它，而且一次都不回源', async () => {
    await service.search('example0');

    await deleteGroup({ storage }, { groupId: 'perf-g9' });

    const reads = await countGroupReads(async () => {
      const hits = await service.search('example0');
      expect(hits.length).toBe(GROUPS - 1);
      expect(hits.some((hit) => hit.group.id === 'perf-g9'), '删掉的组不该还在结果里').toBe(false);
    });
    expect(reads, '索引里已经没有的会话不该再去读它的键').toBe(0);
  });

  it('对面同步写进来一批新会话 ⇒ 搜索认得出来（不靠变更信号）', async () => {
    await service.search('example0');

    // 模拟"另一台设备推过来的一版"：直接写存储，不经过本机的任何服务
    const other = createStoragePort();
    await other.putGroup(perfGroup(900, Array.from({ length: 2 }, (_, i) => perfTab('perf-g900', i))));

    const hits = await service.search('example0');
    expect(hits.length, '新会话必须出现在结果里（收窄失效不能变成看不见新数据）').toBe(GROUPS + 1);
  });

  it('缓存与查询词无关：换词搜索不回源', async () => {
    await service.search('example0');
    const reads = await countGroupReads(async () => {
      const hits = await service.search('example1.com');
      expect(hits.length).toBeGreaterThan(0);
    });
    expect(reads, '换个词不该把会话再读一遍').toBe(0);
  });
});
