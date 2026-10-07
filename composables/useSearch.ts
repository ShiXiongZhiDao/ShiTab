import { onScopeDispose, ref, watch } from 'vue';
import { searchService } from '@/shared/services';
import type { SearchHit } from '@/shared/types';

/**
 * 搜索。输入防抖 150ms —— 不是性能需要（线性扫描很快），是为了避免每敲一个字
 * 都把列表重排一次导致眼睛跟不住。
 */
export function useSearch() {
  const query = ref('');
  const hits = ref<SearchHit[]>([]);
  const searching = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run(): Promise<void> {
    const needle = query.value.trim();
    if (!needle) {
      hits.value = [];
      searching.value = false;
      return;
    }
    hits.value = await searchService.search(needle);
    searching.value = true;
  }

  watch(query, () => {
    if (timer) clearTimeout(timer);
    if (!query.value.trim()) {
      hits.value = [];
      searching.value = false;
      return;
    }
    timer = setTimeout(run, 150);
  });

  onScopeDispose(() => {
    if (timer) clearTimeout(timer);
  });

  function clear(): void {
    query.value = '';
    hits.value = [];
    searching.value = false;
  }

  return { query, hits, searching, clear, refetch: run };
}
