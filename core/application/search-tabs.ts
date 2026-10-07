/**
 * 搜索（第 2 轮待决第 2 条的定案）。
 *
 * 既有约定 已否决倒排索引：匹配用线性扫描，1 万条记录的 `includes` 是毫秒级。
 *
 * ★ 2026-10-06（既有约定 决定 6 / 既有约定 采纳 3）改了**缓存的失效粒度**，判据没动：
 *   旧形状是"变更信号一来就整份作废 ⇒ 下一次搜索 `listAllGroups()` 重读全部会话"，
 *   实测每个会话三次读 ⇒ 300 组那一档每次变更后第一次搜索要付 900 次读。
 *   现在按**会话**判断新旧：索引条目本身就是指纹（`tabCount` / `updatedAt` / 标题 / 分类 / 置顶 / 锁定），
 *   只有指纹变了的会话才回源。
 *
 * 匹配口径：**不区分大小写的子串**，命中分组名 / tab 标题 / URL / 域名任一即算命中。
 * 不做分词、不做权重、不做模糊 —— 这些在 1 万条规模下收益为零，且会让"为什么这条
 * 没搜到"变成不可解释的问题。
 */

import type { GroupIndexEntry, SearchHit, TabGroup } from '@/shared/types';
import { compareGroups } from '@/core/domain/group';

export function searchGroups(
  index: GroupIndexEntry[],
  groups: Map<string, TabGroup>,
  query: string,
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: SearchHit[] = [];
  for (const entry of [...index].sort(compareGroups)) {
    const matchedGroup = entry.title.toLowerCase().includes(needle);
    const group = groups.get(entry.id);
    const matchedTabs =
      matchedGroup || !group
        ? [...group?.tabs ?? []].sort((a, b) => a.sortOrder - b.sortOrder)
        : [...group.tabs]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .filter((tab) => tabMatches(tab.title, tab.url, tab.domain, needle));

    if (!matchedGroup && matchedTabs.length === 0) continue;
    hits.push({ group: entry, matchedGroup, matchedTabs });
  }
  return hits;
}

export function tabMatches(
  title: string,
  url: string,
  domain: string | undefined,
  needle: string,
): boolean {
  if (title.toLowerCase().includes(needle)) return true;
  if (url.toLowerCase().includes(needle)) return true;
  if (domain && domain.toLowerCase().includes(needle)) return true;
  return false;
}

/**
 * 带缓存的搜索服务：**按会话失效**。
 *
 * 为什么可以只按 index 的条目判断新旧（这是整条收窄的承重前提）：
 * 本仓库每一条会改动一个会话内容的命令，在 `putGroup` 之前都走 `core/domain/group.ts` 的 `touch()`
 * 抬 `updatedAt` —— 重命名(`group-commands.ts:61`)、增删记录(`:82`)、置顶/锁定(`:123`/`:134`)、
 * 组内重排(`group.ts:123`)、跨组移动(`group.ts:142-143` 两边都抬)；`tabCount` 又直接来自内容长度。
 * 而 `updatedAt` 就存在 `groups:index` 的那一条里。⇒ **哪天冒出一条"改了内容却没抬 updatedAt、
 * 也没改 tabCount"的写路径，坏掉的不只是搜索缓存：既有约定 的实体级 LWW 同样会选错边，
 * 那次改动根本传不到对面去。** 那种情况要修的是写侧，不是在这里加兜底。
 *
 * 缓存与查询词无关，所以**清空搜索框不该把它扔掉**（旧实现那么做，等于"下一次搜索又全量重读"）。
 * `invalidate()` 保留：那是"我要一份干净缓存"的显式手段（测试与极端兜底用）。
 */
export interface SearchService {
  search(query: string): Promise<SearchHit[]>;
  /** 不传 = 整份丢掉；传 id = 只让那一个会话回源。 */
  invalidate(groupId?: string): void;
}

/**
 * 指纹就是那条索引条目本身。
 * 字段顺序由 `JSON.stringify` 按对象实际键序走，因此**不许**在这里手挑字段（手挑就是漏一个字段的机会）。
 */
function fingerprintOf(entry: GroupIndexEntry): string {
  return JSON.stringify(entry);
}

export function createSearchService(sources: {
  listGroupIndex: () => Promise<GroupIndexEntry[]>;
  /** 需要回源的会话**一次批量**取（一颗都不许退回逐个 getGroup，见端口那条注释）。 */
  listGroupsByIds: (ids: readonly string[]) => Promise<TabGroup[]>;
}): SearchService {
  const cache = new Map<string, { fingerprint: string; group: TabGroup }>();

  return {
    async search(query) {
      const index = await sources.listGroupIndex();
      if (!query.trim()) return [];

      // 1) 索引里已经没有的会话先从缓存摘掉（整组删除、对面同步删掉的都走这一支）。
      const live = new Set(index.map((entry) => entry.id));
      for (const id of [...cache.keys()]) {
        if (!live.has(id)) cache.delete(id);
      }

      // 2) 指纹变过的才回源，而且**一次批量**读回来（N 个只要一次往返）。
      const stale = index.filter((entry) => cache.get(entry.id)?.fingerprint !== fingerprintOf(entry));
      if (stale.length > 0) {
        const loaded = new Map(
          (await sources.listGroupsByIds(stale.map((entry) => entry.id))).map((group) => [group.id, group]),
        );
        for (const entry of stale) {
          const group = loaded.get(entry.id);
          if (!group) {
            // 索引说有、键里读不到：不缓存一个"看起来正常"的空会话（heal 会来修这条偏差）。
            cache.delete(entry.id);
            continue;
          }
          cache.set(entry.id, { fingerprint: fingerprintOf(entry), group });
        }
      }

      const groups = new Map<string, TabGroup>();
      for (const [id, value] of cache) groups.set(id, value.group);
      return searchGroups(index, groups, query);
    },
    invalidate(groupId) {
      if (groupId === undefined) cache.clear();
      else cache.delete(groupId);
    },
  };
}
