<script lang="ts" setup>
import ConflictPanel from '@/components/ConflictPanel.vue';
import TrashPanel from '@/components/TrashPanel.vue';
import { showTrash, toggleTrashView } from '@/shared/trash-view';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import CategoryRail from '@/components/CategoryRail.vue';
import BulkStrip from '@/components/BulkStrip.vue';
import ViewEmpty from '@/components/ViewEmpty.vue';
import ViewHeading from '@/components/ViewHeading.vue';
import GroupRow from '@/components/GroupRow.vue';
import ResultToast from '@/components/ResultToast.vue';
import { useGroups } from '@/composables/useGroups';
import { useRailWidth } from '@/composables/useRailWidth';
import { useSearch } from '@/composables/useSearch';
import { useTheme } from '@/composables/useTheme';
import { useLocale } from '@/composables/useLocale';
import { deriveSyncView } from '@/core/domain/sync-view';
import { storagePort } from '@/shared/services';
import { reportFirstScreen } from '@/shared/perf-diagnostics';
import { decodeGroup, decodeTab, GROUP_MIME, TAB_MIME } from '@/shared/dnd';
import { onCaptureNotice } from '@/shared/messages';
import { startSyncHeartbeat } from '@/shared/sync-heartbeat';
import { t } from '@/shared/i18n';
import { RAIL_WIDTH_MIN } from '@/shared/constants';
import type { GroupIndexEntry, SavedTab, SyncMeta } from '@/shared/types';

/**
 * 工作台（V1.2 真机第二轮之后的样子，既有约定）。
 *
 * 顶栏**只剩搜索**：收纳的唯一入口是工具栏图标，页面上那个按钮是重复入口；
 * 设置与主题切换挪到左栏底部（它们是"偶尔调一次"的东西，不该占住主视野）。
 *
 * 撤销条还在这里，但改由 background 的收纳通知驱动（`onCaptureNotice`）——
 * 页面自己不再收纳，就没人告诉它"刚刚发生过一次可撤销的收纳"。
 *
 * `h-screen` 在这里是对的：这是一个真实标签页，有真正的视口。
 * （V1.0 的教训是 popup 不能用 100vh —— 弹窗高度由内容反推，会自我指涉塌成一条。）
 */
const store = useGroups();
const theme = useTheme();
/** 语言：设置页改了要在这里当场生效，所以工作台也 init 一次。 */
const locale = useLocale();
/**
 * 侧栏宽度。解构成局部变量是为了在模板里当顶层绑定用（`rail.width` 是 ref，
 * 模板只会解包**顶层**绑定 —— 见上面 `theme.theme.value` 那个写法）。
 */
const {
  width: railWidth,
  preview: railPreview,
  dragging: railDragging,
  ceiling: railCeiling,
  init: railInit,
  startDrag: railStartDrag,
  reset: railReset,
  onKeydown: railKeydown,
} = useRailWidth();
const { query, hits, searching, clear } = useSearch();
const sentinel = ref<HTMLElement | null>(null);
/** 批量删除是两步：第一下把选择栏变成确认条，第二下才真删。 */
const confirmingBulkDelete = ref(false);
let unsubscribeNotice: (() => void) | undefined;
/** 同步心跳的退订：页面开着才有节拍，关掉就停。 */
let stopHeartbeat: (() => void) | undefined;

/**
 * 同步状态的顶栏 pill（既有约定 Q6b：工作台与设置页**两处**都显示）。
 *
 * 为什么工作台也要有一条：同步坏掉时，只有设置页一个出口的话，用户看到的现象是
 * "我删的东西没上去，但屏幕上没有任何地方说为什么"。这条 pill 不解释原因，
 * 它只负责**承认坏事存在过**并把人送到设置页 —— 那里有状态、有退避、有下一次检查时刻。
 *
 * 正常态不显形（Q11c）：一切正常时顶栏不该多出一个占位元素，列表才是用户要看的。
 *
 * 时间怎么来的：`deriveSyncView` 要拿 `Date.now()` 比退避时刻，而 computed 不会因为
 * 时间流逝自己重算 —— 但它会因为账本变而重算，而同步的每一次尝试都必写账本
 * （成功、失败、退避都写）。所以"退避结束了"这件事一定会被重新判一遍，不需要定时器。
 */
const syncMeta = ref<SyncMeta | null>(null);
let stopSyncWatch: (() => void) | undefined;
const syncView = computed(() => deriveSyncView(syncMeta.value, Date.now()));
/**
 * 冲突不在这里重复播报：同一屏下方已经有 `ConflictPanel`（它的显示条件就是
 * `pendingConflicts` 非空），而那块是对话框、能点。顶栏再来一句"同步冲突"是
 * 同一件事说两遍，还会让人以为有两个不同的问题。
 */
const hasPendingConflicts = computed(() => (syncMeta.value?.pendingConflicts?.length ?? 0) > 0);
const showSyncPill = computed(() => syncView.value.abnormal && !hasPendingConflicts.value);
const syncPillText = computed(() =>
  syncView.value.messageKey ? t(syncView.value.messageKey) : '',
);

const isSearching = computed(() => searching.value && query.value.trim().length > 0);
/** 搜索态走 hits（带命中子集）；平时走分类筛选后的整列。 */
const listed = computed<GroupIndexEntry[]>(() =>
  isSearching.value ? hits.value.map((hit) => hit.group) : store.rendered,
);

function tabsFor(entry: GroupIndexEntry): SavedTab[] | undefined {
  if (isSearching.value) return hits.value.find((hit) => hit.group.id === entry.id)?.matchedTabs;
  return store.tabsOf(entry.id);
}

const filterLabel = computed(() => {
  if (isSearching.value) return t('search_results');
  const filter = store.filter;
  if (filter.kind === 'all') return t('category_all');
  if (filter.kind === 'uncategorized') return t('category_uncategorized');
  return store.categories.find((category) => category.id === filter.id)?.name ?? t('category_all');
});
const remaining = computed(() => Math.max(0, store.visible.length - store.rendered.length));

onMounted(() => {
  // 打开页面就敲一次 + 每 60 秒一次：用户盯着这页等对面更新时，
  // 「页面活着」这件事本身必须成为同步的节拍，而不是等他再去点一次立即同步。
  stopHeartbeat = startSyncHeartbeat();
  /**
   * 顶栏那条 pill 的账本。先订阅再补读一次：
   * 同步是 background 跑的，事件可能在这两条之间就到 —— 反过来写会漏掉那一发，
   * 而"页面开着却看不到同步坏了"正是这条 pill 要消灭的现象。
   * 补读只在还没有值时落，所以迟到的旧值不会盖掉刚订阅到的新值。
   */
  stopSyncWatch = storagePort.watchSyncMeta((next) => {
    syncMeta.value = next;
  });
  void storagePort
    .getSyncMeta()
    .then((meta) => {
      if (!syncMeta.value) syncMeta.value = meta;
    })
    .catch(() => undefined);
  void theme.init();
  void locale.init();
  void railInit();
  /** 首屏计时的起点：从发起 `init()` 到数据齐（只在开发构建里打印这条日志）。 */
  const initStartedAt = performance.now();
  void store
    .init()
    .then(async () => {
      await store.ensureEntry();
      // 先拿到本窗口 id 再订阅：通知要按窗口过滤，别的窗口的收纳不该在本窗口弹撤销条
      const mine = await store.windowId();
      unsubscribeNotice = onCaptureNotice((notice) => {
        if (notice.windowId !== mine) return;
        store.noteCapture(notice);
      });
      // 数据齐了、DOM 也刷完一轮 ⇒ 这一刻才是"首屏"，结构量顺手一起报（既有约定 决定 10）。
      await nextTick();
      reportFirstScreen(
        {
          cards: document.querySelectorAll('[data-group-card]').length,
          rows: document.querySelectorAll('[data-tab-row]').length,
          elements: document.querySelectorAll('*').length,
          images: document.querySelectorAll('img').length,
        },
        performance.now() - initStartedAt,
      );
    })
    .catch((cause: unknown) => console.error('[shitab] 工作台初始化失败', cause));
});

onBeforeUnmount(() => {
  stopHeartbeat?.();
  stopHeartbeat = undefined;
  stopSyncWatch?.();
  stopSyncWatch = undefined;
  unsubscribeNotice?.();
  unsubscribeNotice = undefined;
  observer?.disconnect();
  store.dispose();
});

/**
 * 无限滚动的观察器。
 *
 * 只在真的支持 IntersectionObserver 时建（jsdom 与老浏览器没有），
 * 不支持时下面那颗"加载更多"按钮仍然可用 —— 两条路都得通，不能只留一条。
 */
let observer: IntersectionObserver | undefined;
watch(sentinel, (el) => {
  observer?.disconnect();
  observer = undefined;
  if (!el || typeof IntersectionObserver === 'undefined') return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) store.requestMore();
    },
    { rootMargin: '240px 0px' },
  );
  observer.observe(el);
});

/** 指针落在卡片上半/下半 -> 插到它前面还是后面（组间拖拽的落点）。 */
function listIndex(clientY: number, event: Event): number {
  const container = event.currentTarget as HTMLElement | null;
  if (!container) return -1;
  const cards = [...container.querySelectorAll<HTMLElement>('[data-group-card]')];
  let index = 0;
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    if (clientY > box.top + box.height / 2) index += 1;
  }
  return index;
}

async function onListDrop(event: DragEvent): Promise<void> {
  const transfer = event.dataTransfer;
  if (!transfer) return;

  const groupPayload = decodeGroup(transfer.getData(GROUP_MIME) || null);
  if (groupPayload) {
    await store.moveGroupTo(groupPayload.groupId, listIndex(event.clientY, event));
    return;
  }

  const tabPayload = decodeTab(transfer.getData(TAB_MIME) || null);
  if (!tabPayload) return; // 桌面文件等外部拖放：什么都不做（M9）
  const target = listed.value[Math.min(listIndex(event.clientY, event), listed.value.length - 1)];
  if (!target || target.id === tabPayload.groupId) return;
  await store.moveTabAcross(tabPayload.tabId, tabPayload.groupId, target.id, target.tabCount);
}

/**
 * 设置页。
 *
 * 模板里其实可以直接写 `browser.runtime.openOptionsPage()` —— WXT 的自动导入会把模板里的
 * `browser` 编译成"取全局注入的那个"（本轮在产物里核对过：`` `browser` in t ? t.browser : … ``）。
 * 仍然包一层，是因为把平台调用留在 script 里，组件测试与后续换实现都只有一处要改。
 */
function openOptions(): void {
  void browser.runtime.openOptionsPage();
}
</script>

<template>
  <div
    class="flex h-screen bg-bg text-ink"
    :class="{ 'cursor-col-resize select-none': railDragging }"
  >
    <!-- 宽度来自 storage。下面那个 max-w 是**第二道闸**，两个数与
         shared/constants.ts 里的 RAIL_WIDTH_MAX / RAIL_WIDTH_VIEWPORT_RATIO 必须一致
         （有测试按源码核对，见 test/ui-workbench.spec.ts 的"CSS 那道闸与常量同源"）：
         窗口在页面打开之后被拖窄，40% 变了而存的数没变，这时只有 CSS 能实时兜住。 -->
    <aside
      class="flex max-w-[min(420px,40vw)] shrink-0 flex-col bg-panel"
      :style="{ width: `${railWidth}px` }"
      :class="railDragging ? '' : 'transition-[width] duration-150'"
    >
      <header class="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <div
          class="grid h-8 w-8 shrink-0 place-items-center rounded-tight bg-brand text-[14px] font-extrabold text-brand-contrast"
        >
          T
        </div>
        <!-- 200px 是这一栏最窄的样子：品牌字与计数都得能优雅地退让，不能把行撑破。 -->
        <!-- 品牌字读 brandName（既有约定 决定 1）：界面跟应用内语言走，中文界面就是「师兄收纳」。 -->
        <span class="tn-ellipsis min-w-0 text-[13px] font-extrabold">{{ t('brandName') }}</span>
        <span
          class="ml-auto shrink-0 rounded-full bg-chip px-2 py-0.5 text-[10px] text-muted"
          :title="t('total_tabs')"
        >
          {{ store.totalTabs }}
        </span>
      </header>

      <CategoryRail />

      <!--
        底部这一区（既有约定 挪位 + 既有约定 改形状）：
        回收站那一行**与分类行同形**（同一把 `tn-item`：12px、图标 13、hover:bg-chip、
        选中 bg-brand-soft + 粗体品牌色），因为它在用户眼里就是"列表里的一行"，
        上一版给它套了主题/设置那颗 chip 按钮的样式，看起来像一个开关而不是一行。
        分隔线也跟着挪：原来压在回收站上面（把它和分类列表切开，读起来像"这不是列表"），
        现在压在**主题与设置上面** —— 线下面才是"设置类按钮"那一组。
      -->
      <footer class="shrink-0">
        <div class="px-2 pb-1 pt-2">
          <button
            class="tn-item flex w-full items-center gap-2 rounded-tight px-2 py-1.5 text-left text-[12px]"
            :class="showTrash ? 'bg-brand-soft font-bold text-brand' : 'text-ink hover:bg-chip'"
            type="button"
            :aria-current="showTrash ? 'true' : undefined"
            :title="t('nav_trash')"
            data-testid="rail-trash"
            @click="toggleTrashView"
          >
            <AppIcon name="trash" :size="13" />
            <span class="tn-ellipsis min-w-0 flex-1">{{ t('nav_trash') }}</span>
          </button>
        </div>
        <div class="flex items-center gap-1 border-t border-line px-2 py-2">
        <button
          class="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control bg-chip px-2 py-1.5 text-[11px] font-bold text-ink transition hover:bg-brand-soft hover:text-brand"
          type="button"
          :title="t('toggle_theme')"
          :aria-label="t('toggle_theme')"
          @click="theme.cycle()"
        >
          <AppIcon :name="theme.theme.value === 'dark' ? 'sun' : 'moon'" :size="14" />
          <span class="tn-ellipsis">{{ t('theme_label') }}</span>
        </button>
        <button
          class="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control bg-chip px-2 py-1.5 text-[11px] font-bold text-ink transition hover:bg-brand-soft hover:text-brand"
          type="button"
          :title="t('open_options')"
          :aria-label="t('open_options')"
          @click="openOptions"
        >
          <AppIcon name="settings" :size="14" />
          <span class="tn-ellipsis">{{ t('open_options') }}</span>
        </button>
        </div>
      </footer>
    </aside>

    <!-- 分隔条：宽 5px 是为了手指能命中，视觉上只有 1px 的线（hover/聚焦才上色）。
         双击 = 回默认宽度；键盘 ← → 调整、Home 复位。 -->
    <div
      class="group/-divider relative z-10 -ml-1 w-1 shrink-0 cursor-col-resize bg-transparent outline-none"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="t('rail_resize')"
      :title="t('rail_resize_hint')"
      :aria-valuemin="RAIL_WIDTH_MIN"
      :aria-valuemax="railCeiling"
      :aria-valuenow="railWidth"
      @pointerdown="railStartDrag"
      @dblclick="railReset"
      @keydown="railKeydown"
    >
      <span
        class="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line group-hover/-divider:bg-brand group-focus-visible/-divider:bg-brand"
        aria-hidden="true"
      ></span>
    </div>

    <main class="flex min-w-0 flex-1 flex-col">
      <header class="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
        <label class="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-line bg-bg px-2.5 py-1.5">
          <span class="shrink-0 text-muted"><AppIcon name="search" :size="14" /></span>
          <input
            v-model="query"
            class="w-full border-0 bg-transparent text-[12px] text-ink outline-none"
            type="search"
            :placeholder="t('search_placeholder')"
          />
          <button
            v-if="query"
            class="shrink-0 bg-transparent text-[12px] text-muted hover:text-ink"
            type="button"
            :aria-label="t('close')"
            @click="clear"
          >
            ✕
          </button>
        </label>
        <!--
          同步异常时这里会出现一条 pill：它不解释原因，只把人送到设置页 ——
          那里才有状态、退避和「下一次自动检查约几点」。正常时整段不渲染，顶栏不给它留位。
          冲突不在这条里（`showSyncPill` 已排除）：那一件事由下方的 ConflictPanel 负责，
          同一屏说两遍会让人以为有两个问题。
        -->
        <button
          v-if="showSyncPill"
          class="flex shrink-0 items-center gap-1 rounded-full bg-danger-soft px-2 py-1 text-[10px] font-bold text-danger transition hover:bg-danger hover:text-white"
          type="button"
          data-testid="workbench-sync-status"
          :title="t('open_options')"
          @click="openOptions"
        >
          <AppIcon name="cloud" :size="12" />
          <span class="tn-ellipsis">{{ syncPillText }}</span>
        </button>
      </header>

      <!-- 冲突是数据现场的事（Q9）：有账就自己冒出来，没账整段不渲染 -->
      <ConflictPanel />

      <!-- 回收站占掉右栏时，标题行与会话列表整段让位（留着一个只会数错数的表头是噪音） -->
      <!-- 视图交叉淡入淡出（既有约定 补格四）：工作台真正的"换页"只有这一处 ——
           会话列表 ↔ 回收站（`shared/trash-view.ts` 那个正交视图）。
           切分类与进出搜索**不在这里**：那是同一个列表重新筛选，不换组件，
           要做交叉淡就得让两份列表在动画期间同时存在（首屏 ~600 行时是双份 DOM），
           与 既有约定 刚做的窗口化对着干，所以没顺手加。

           外层这个 div 是**定位祖先**：离场那一屏在 shitab.css 的 .tn-fade-leave-active 里
           被摆成 position:absolute，它要叠在同一块地方才叫交叉。
           flex-1 + min-h-0 是为了让滚动链不断（原来 <section> 直接挂在 main 上，现在多包了一层）。

           ★ 回收站那一屏**自己必须是滚动容器**（`tn-scroll … overflow-y-auto`，与会话列表同一套）：
           原来这里只有 `flex min-h-0 flex-1 flex-col`，没有 `overflow-y-auto` ⇒ 行一多就把
           `h-screen` 那层壳撑破（浏览器探针实测：壳 800 高、面板 2337 高、文档被撑到 2391），
           于是滚的是**整页** —— 左栏和顶栏跟着滑出视野，这正是 2026-10-06 真机那句
           「回收站标签多了会溢出」。契约由 `test/ui-workbench.spec.ts` 那条祖先链判据钉住。 -->
      <div class="relative flex min-h-0 flex-1 flex-col">
        <Transition name="tn-fade">
          <!-- 滚动区在 TrashPanel **内部**：那条通栏批量条要不随内容滚，
               它就得是滚动区的兄弟。祖先链判据（`overflow-y-auto` + `min-h-0`）仍然成立。
               这颗组件也不再发 `close` —— 出口是左栏那颗与点任意分类。 -->
          <div v-if="showTrash" key="trash" class="flex min-h-0 flex-1 flex-col">
            <TrashPanel />
          </div>
          <div v-else key="list" class="flex min-h-0 flex-1 flex-col">

            <!-- 标题槽与会话列表同一颗组件。搜索态刻意不显计数：
                 命中的是子集，那个数不是"这一档有多少"。 -->
            <ViewHeading :label="filterLabel" :count="isSearching ? undefined : store.visible.length" />

            <BulkStrip v-if="store.selectionCount > 0">
            <!-- 两个数一起说（既有约定，与回收站那条批量栏同形）：整组与记录级是同一份勾选的
                 两种覆盖程度，分开挂就会有一个数被漏看。 -->
            <span class="text-[11px] font-bold text-ink" data-testid="bulk-summary">
              {{ t('bulk_summary', { groups: store.checkedCount, records: store.recordCount }) }}
            </span>
            <button
              class="rounded-control bg-brand px-3 py-1.5 text-[11px] font-bold text-brand-contrast"
              type="button"
              data-testid="bulk-restore"
              @click="store.restoreChecked()"
            >
              {{ t('bulk_restore') }}
            </button>
            <button
              v-if="!isSearching"
              class="rounded bg-transparent px-2 py-1 text-[11px] font-bold text-ink hover:text-brand"
              type="button"
              @click="store.clearChecked()"
            >
              {{ t('clear_selection') }}
            </button>
            <button
              v-if="!isSearching && listed.length"
              class="rounded bg-transparent px-2 py-1 text-[11px] font-bold text-muted hover:text-brand"
              type="button"
              @click="void store.selectAllVisible()"
            >
              {{ t('select_all') }}
            </button>

            <span class="ml-auto flex items-center gap-2">
              <button
                v-if="!confirmingBulkDelete"
                class="rounded bg-transparent px-2 py-1 text-[11px] font-bold text-danger hover:bg-danger-soft"
                type="button"
                @click="confirmingBulkDelete = true"
              >
                {{ t('bulk_delete') }}
              </button>
              <template v-else>
                <span class="text-[11px] font-semibold text-ink">
                  {{ t('bulk_delete_confirm', { groups: store.checkedCount, records: store.recordCount }) }}
                </span>
                <button
                  class="rounded-control bg-danger px-3 py-1.5 text-[11px] font-bold text-white"
                  type="button"
                  @click="
                    confirmingBulkDelete = false;
                    store.removeChecked();
                  "
                >
                  {{ t('confirm_yes') }}
                </button>
                <button
                  class="rounded-control border border-line bg-panel px-3 py-1.5 text-[11px] font-bold text-ink"
                  type="button"
                  @click="confirmingBulkDelete = false"
                >
                  {{ t('confirm_no') }}
                </button>
              </template>
            </span>
            </BulkStrip>

            <section
              class="tn-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-1"
              @dragover.prevent
              @drop.prevent="onListDrop"
            >
              <p v-if="store.error" class="mb-2 rounded-control bg-danger-soft px-3 py-2 text-[11px]">
                {{ store.error }}
              </p>

              <p v-if="store.loading" class="m-2 text-[11px] text-muted">…</p>

              <p v-else-if="isSearching && listed.length === 0" class="m-2 text-[11px] text-muted">
                {{ t('search_no_results', { q: query }) }}
              </p>

              <!-- 空态块与会话列表同一颗组件：回收站那边原来只有一行小字。 -->
              <ViewEmpty
                v-else-if="!isSearching && listed.length === 0"
                icon="inbox"
                :title="store.isEmpty ? t('empty_title') : t('list_empty_filtered')"
                :hint="store.isEmpty ? t('empty_hint') : t('category_empty_hint')"
              >
                <button
                  v-if="!store.isEmpty"
                  class="mt-3 rounded-control border border-line bg-panel px-3 py-1.5 text-[11px] font-bold text-ink hover:text-brand"
                  type="button"
                  @click="store.setFilter({ kind: 'all' })"
                >
                  {{ t('category_all') }}
                </button>
              </ViewEmpty>

              <template v-else>
                <GroupRow
                  v-for="entry in listed"
                  :key="entry.id"
                  :entry="entry"
                  :tabs="tabsFor(entry)"
                  :searching="isSearching"
                />

                <div v-if="!isSearching && store.hasMore" ref="sentinel" aria-hidden="true"></div>
                <button
                  v-if="!isSearching && store.hasMore"
                  class="w-full rounded-control border border-line bg-panel px-3 py-2 text-[11px] font-bold text-muted hover:text-brand"
                  type="button"
                  @click="store.requestMore()"
                >
                  {{ t('load_more_sessions', { count: remaining }) }}
                </button>
              </template>
            </section>
          </div>
        </Transition>
      </div>
    </main>

    <!-- 拖拽中的预览：一根 fixed 的幽灵线 + 当前像素数。
         它**不改** aside 的宽度，所以整拖拽过程右栏一次布局都不重算（既有约定 的性能前提），
         松手才把宽度一次性落下去。pointer-events-none：线自己不能把 pointerup 吃掉。 -->
    <div
      v-if="railPreview !== null"
      class="tn-rail-ghost pointer-events-none fixed inset-y-0 z-50 w-0.5 -translate-x-1/2 bg-brand"
      :style="{ left: `${railPreview}px` }"
      aria-hidden="true"
    >
      <span
        class="absolute left-2 top-3 rounded-tight bg-brand px-1.5 py-0.5 text-[10px] font-bold text-brand-contrast"
        >{{ railPreview }}px</span
      >
    </div>

    <ResultToast />
  </div>
</template>
