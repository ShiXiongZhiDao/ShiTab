<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import TabRow from './TabRow.vue';
import { useGroups } from '@/composables/useGroups';
import { canRevealMore, revealMore, windowLimit } from '@/shared/tab-window';
import { vIndeterminate } from '@/shared/directives';
import { decodeTab, GROUP_MIME, TAB_MIME, encode } from '@/shared/dnd';
import { t } from '@/shared/i18n';
import { clockStamp } from '@/shared/utils';
import type { GroupIndexEntry, SavedTab } from '@/shared/types';

/**
 * 右栏里的一个会话（V1.2 既有约定 的主单元）。
 *
 * 图标条按已签的 Q9 分两层：
 * - 常驻 5 个：还原全部 / 在新窗口还原 / 置顶 / 锁定 / 复制
 * - ⋯ 溢出：重命名、在无痕窗口还原、导出为网页、放进分类（含"从分类中移除"）、删除
 *
 * "在无痕窗口还原"也在这里（⋯ 里），不占常驻位：它是一次性的特殊动作，
 * 而且平台前提（扩展需被允许在无痕模式运行）不总成立 —— 点了失败会如实报错，
 * 不降级成普通窗口。
 */
const props = defineProps<{
  entry: GroupIndexEntry;
  /** undefined = 还没加载完；空数组 = 这个会话确实是空的 */
  tabs?: SavedTab[];
  /** 搜索态：列表是命中子集，组内重排的语义不成立 */
  searching?: boolean;
}>();

const store = useGroups();
const renaming = ref(false);
const draft = ref('');
const confirming = ref(false);
const input = ref<HTMLInputElement | null>(null);
const body = ref<HTMLElement | null>(null);
/**
 * 这张卡**额外摊开**了多少条（既有约定 采纳 1 的分批）。
 *
 * 0 = 折叠态，只渲染前 `COLLAPSED_TAB_LIMIT` 条；每点一次"展开其余"加一批。
 * ★ 它进不了勾选判据：`visibleIds` 用的是整表 `ordered`，不是 `shown`。
 */
const revealed = ref(0);

/**
 * ⋯ 菜单的受控开合。
 *
 * 之前用的是原生 `<details>`：它只在点 summary 时切换，**点页面别处不会关**，
 * 真机上菜单一直悬在那儿挡住下面的会话。改成受控状态 + 三条关闭路径：
 * 外部 pointerdown、Esc、选中任意一项。
 */
const menuOpen = ref(false);
const menuRoot = ref<HTMLElement | null>(null);

function onDocPointerDown(event: PointerEvent): void {
  if (menuRoot.value?.contains(event.target as Node)) return;
  menuOpen.value = false;
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') menuOpen.value = false;
}

watch(menuOpen, (open) => {
  // 写成两个分支而不是 `document[open ? 'addEventListener' : 'removeEventListener'](...)`：
  // 那种联合方法名会让 TS 把 handler 当成 `EventListener`，PointerEvent 参数就过不了类型。
  if (open) {
    // capture 阶段：菜单项自己的 click 不能被别的监听吃掉
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('keydown', onDocKeydown);
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeydown);
});

/** 菜单里点一项：先收起，再执行。 */
function fromMenu(task: () => void | Promise<unknown>): void {
  menuOpen.value = false;
  void task();
}

onMounted(() => {
  void store.loadTabs(props.entry.id);
});

const ordered = computed(() =>
  [...(props.tabs ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.originalIndex - b.originalIndex,
  ),
);
const label = computed(() => props.entry.title || t('group_untitled'));
const locked = computed(() => props.entry.locked === true);
/**
 * 这一行现在渲染出来的记录 id。
 *
 * 平时它等于整表（折叠只影响 `shown`，不影响这里），所以行首框 = "整组全选"；
 * **搜索态它等于命中子集**（`App.vue` 的 `tabsFor` 给的是 `matchedTabs`），
 * 于是行首框只勾"你看得见的这些" —— 一次点击把没命中的记录一起选走、再让「删除所选」
 * 走整组路径，表现成"我只是在搜索结果里删了两条，整个会话没了"（既有约定 补的那一格）。
 */
const visibleIds = computed(() => ordered.value.map((tab) => tab.id));
const categoryName = computed(() =>
  props.entry.categoryId === undefined
    ? undefined
    : store.categories.find((category) => category.id === props.entry.categoryId)?.name,
);

const shown = computed(() => ordered.value.slice(0, windowLimit(ordered.value.length, revealed.value)));
const hidden = computed(() => ordered.value.length - shown.value.length);

/**
 * 那颗按钮的两用点击：还有没摊开的就再摊一批，摊完了就收回折叠态。
 * 名字沿用旧语义（`expanded` 决定按钮显示"展开其余"还是"收起"），模板那边不改读法。
 */
function toggleExpansion(): void {
  revealed.value = canRevealMore(ordered.value.length, revealed.value)
    ? revealMore(ordered.value.length, revealed.value)
    : 0;
}

const countLabel = computed(() =>
  props.entry.tabCount === 1 ? t('group_tab_count_one') : t('group_tab_count', { count: props.entry.tabCount }),
);
/**
 * 标题行**只有一行**：名字 + 时间戳并排，不再有小字第二行。
 *
 * 时间戳带秒：会话默认没有名字，它就是唯一的身份，两分钟内连收两次也要分得开。
 * 相对时间（"现在 / 36 秒前"）整条去掉 —— 同一行里它和绝对时间是同一件事的两种说法。
 */
const stamp = computed(() => clockStamp(props.entry.createdAt));

async function startRename(): Promise<void> {
  renaming.value = true;
  draft.value = props.entry.title;
  await nextTick();
  input.value?.select();
}

async function commitRename(): Promise<void> {
  if (!renaming.value) return;
  renaming.value = false;
  const next = draft.value.trim();
  if (!next || next === props.entry.title) return;
  await store.rename(props.entry.id, next);
}

function onRenameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    renaming.value = false;
    return;
  }
  if (event.key === 'Enter') void commitRename();
}

function onDragStart(event: DragEvent): void {
  if (locked.value || props.searching || !event.dataTransfer) return;
  event.dataTransfer.setData(GROUP_MIME, encode({ groupId: props.entry.id }));
  event.dataTransfer.effectAllowed = 'move';
}

function onTabDragStart(event: DragEvent, tab: SavedTab): void {
  if (!event.dataTransfer || locked.value || props.searching) return;
  event.dataTransfer.setData(TAB_MIME, encode({ tabId: tab.id, groupId: props.entry.id }));
  event.dataTransfer.effectAllowed = 'move';
  event.stopPropagation();
}

/** 指针落在条目上半/下半决定插到它前面还是后面（组内重排的落点）。 */
function insertIndex(event: DragEvent): number {
  const container = body.value;
  if (!container) return ordered.value.length;
  const rows = [...container.querySelectorAll<HTMLElement>('[data-tab-row]')];
  const pointer = event.clientY;
  let index = 0;
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (pointer > box.top + box.height / 2) index += 1;
  }
  return index;
}

async function onBodyDrop(event: DragEvent): Promise<void> {
  if (!event.dataTransfer || locked.value || props.searching) return;
  const payload = decodeTab(event.dataTransfer.getData(TAB_MIME) || null);
  if (!payload) return;
  event.preventDefault();
  event.stopPropagation();
  if (payload.groupId === props.entry.id) {
    await store.moveTabWithin(props.entry.id, payload.tabId, insertIndex(event));
    return;
  }
  await store.moveTabAcross(payload.tabId, payload.groupId, props.entry.id, insertIndex(event));
}

function onHeaderDrop(event: DragEvent): void {
  // 整组排序交给父层的列表 drop；这里只接"从别的会话拖一条进来"
  if (!event.dataTransfer) return;
  const payload = decodeTab(event.dataTransfer.getData(TAB_MIME) || null);
  if (!payload || payload.groupId === props.entry.id) return;
  event.preventDefault();
  event.stopPropagation();
  void store.moveTabAcross(payload.tabId, payload.groupId, props.entry.id, ordered.value.length);
}
</script>

<template>
  <section
    class="tn-group mb-3 rounded-card border bg-panel"
    :class="locked ? 'border-brand/40' : 'border-line'"
    :draggable="!locked && !searching"
    data-group-card
    @dragstart="onDragStart"
  >
    <header class="flex items-center gap-2 px-3 py-2" @drop="onHeaderDrop" @dragover.prevent>
      <!-- 行首框 = 这一行的全选 / 全不选，只勾了一半时半选（既有约定，形状与回收站那颗同源 = 既有约定）。
           它不是另一种选择状态：勾满一整行，批量才会按**整组**动作处理。 -->
      <label
        class="tn-check flex shrink-0 cursor-pointer items-center"
        :title="t('bulk_check_row')"
      >
        <input
          v-indeterminate="store.rowState(entry.id, visibleIds) === 'some'"
          class="accent-brand"
          type="checkbox"
          :checked="store.rowState(entry.id, visibleIds) === 'all'"
          :aria-label="t('bulk_check_row')"
          :data-testid="`group-check-${entry.id}`"
          @change="void store.toggleRow(entry.id, visibleIds)"
        />
      </label>

      <div
        class="grid h-6 w-6 shrink-0 place-items-center rounded-tight bg-brand-soft text-[11px] leading-none text-brand"
        aria-hidden="true"
      >
        <AppIcon :name="entry.isPinned ? 'star' : 'folder'" :size="13" />
      </div>

      <!-- 一行摆平：名字（点了就能改）+ 时间戳。既有约定。 -->
      <div class="flex min-w-0 flex-1 items-center gap-2.5">
        <input
          v-if="renaming"
          ref="input"
          v-model="draft"
          class="min-w-0 w-[220px] shrink-0 rounded-tight border border-brand bg-panel-raised px-2 py-0.5 text-[13px] font-extrabold text-ink outline-none"
          type="text"
          :placeholder="t('group_name_placeholder')"
          :aria-label="t('group_rename')"
          @blur="commitRename"
          @keydown="onRenameKeydown"
        />
        <!-- 标题可以被压窄（`min-w-0` + 默认 flex-shrink）：`tn-ellipsis` 是 nowrap + overflow:hidden，
             盒子不被压窄就永远轮不到省略号。原来这里带着 `shrink-0`，等于一边要求截断一边禁止压缩，
             结果是长标题把整行撑破、把右边那排常驻图标挤出卡片（2026-10-06 真机「回收站标签多了会溢出」
             在列表侧的同形问题）。判据见 `ui-components.spec.ts` 的 `group-title` 那条。 -->
        <button
          v-else
          class="tn-ellipsis min-w-0 bg-transparent px-0 py-0 text-left text-[13px] leading-none font-extrabold"
          :class="entry.title ? 'text-ink' : 'text-muted'"
          type="button"
          :title="t('group_rename')"
          data-testid="group-title"
          @click="startRename"
        >
          {{ label }}
        </button>

        <span class="flex shrink-0 items-center gap-1 text-[11px] leading-none text-muted" data-session-stamp>
          <AppIcon name="clock" :size="12" />{{ stamp }}
        </span>
      </div>

      <span class="shrink-0 text-[11px] leading-none font-bold text-muted">{{ countLabel }}</span>
      <span
        v-if="categoryName"
        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-chip px-2 py-0.5 text-[10px] text-muted"
      >
        <AppIcon name="folder" :size="11" />{{ categoryName }}
      </span>
      <span
        v-if="locked"
        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand"
        :title="t('group_locked_hint')"
      >
        <AppIcon name="lock" :size="11" />{{ t('group_locked') }}
      </span>

      <div class="flex shrink-0 items-center gap-0.5">
        <button
          class="grid h-6 w-6 place-items-center rounded-tight text-muted hover:bg-chip hover:text-ink disabled:opacity-35"
          type="button"
          :disabled="entry.tabCount === 0 || store.busy || searching"
          :title="t('group_restore_all')"
          :aria-label="t('group_restore_all')"
          @click="store.restoreGroup(entry.id, 'current')"
        >
          <AppIcon name="restore" />
        </button>
        <button
          class="grid h-6 w-6 place-items-center rounded-tight text-muted hover:bg-chip hover:text-ink disabled:opacity-35"
          type="button"
          :disabled="entry.tabCount === 0 || store.busy || searching"
          :title="t('restore_in_new_window')"
          :aria-label="t('restore_in_new_window')"
          @click="store.restoreGroup(entry.id, 'newWindow')"
        >
          <AppIcon name="window" />
        </button>
        <button
          class="grid h-6 w-6 place-items-center rounded-tight hover:bg-chip disabled:opacity-35"
          :class="entry.isPinned ? 'text-brand' : 'text-muted hover:text-ink'"
          type="button"
          :title="entry.isPinned ? t('group_unpin') : t('group_pin')"
          :aria-label="entry.isPinned ? t('group_unpin') : t('group_pin')"
          :aria-pressed="entry.isPinned"
          @click="store.pin(entry.id)"
        >
          <AppIcon name="star" />
        </button>
        <button
          class="grid h-6 w-6 place-items-center rounded-tight hover:bg-chip"
          :class="locked ? 'text-brand' : 'text-muted hover:text-ink'"
          type="button"
          :title="locked ? t('group_unlock') : t('group_lock')"
          :aria-label="locked ? t('group_unlock') : t('group_lock')"
          :aria-pressed="locked"
          @click="store.lock(entry.id)"
        >
          <AppIcon :name="locked ? 'lock' : 'unlock'" />
        </button>
        <button
          class="grid h-6 w-6 place-items-center rounded-tight text-muted hover:bg-chip hover:text-ink disabled:opacity-35"
          type="button"
          :disabled="entry.tabCount === 0"
          :title="t('copy_links')"
          :aria-label="t('copy_links')"
          @click="store.copyGroup(entry.id)"
        >
          <AppIcon name="copy" />
        </button>

        <div ref="menuRoot" class="relative">
          <button
            class="grid h-6 w-6 place-items-center rounded-tight text-muted hover:bg-chip hover:text-ink"
            :class="menuOpen ? 'bg-chip text-ink' : ''"
            type="button"
            :aria-label="t('more_actions')"
            :aria-expanded="menuOpen"
            aria-haspopup="menu"
            @click="menuOpen = !menuOpen"
          >
            <AppIcon name="dots" />
          </button>
          <ul
            v-if="menuOpen"
            role="menu"
            class="absolute right-0 top-8 z-20 max-h-[60vh] w-[190px] overflow-y-auto rounded-control border border-line bg-panel py-1 shadow-card"
          >
            <li><button class="w-full bg-transparent px-3 py-1.5 text-left text-[11px] text-ink hover:bg-chip" type="button" role="menuitem" @click="fromMenu(startRename)">{{ t('group_rename') }}</button></li>
            <li><button class="w-full bg-transparent px-3 py-1.5 text-left text-[11px] text-ink hover:bg-chip" type="button" role="menuitem" :disabled="searching" @click="fromMenu(() => store.restoreGroup(entry.id, 'incognito'))">{{ t('restore_in_incognito') }}</button></li>
            <li><button class="w-full bg-transparent px-3 py-1.5 text-left text-[11px] text-ink hover:bg-chip" type="button" role="menuitem" @click="fromMenu(() => store.exportGroupHtml(entry.id))">{{ t('export_html') }}</button></li>

            <li class="mt-1 border-t border-line pt-1">
              <p class="px-3 py-1 text-[10px] font-extrabold tracking-widest text-muted">{{ t('move_to_category') }}</p>
            </li>
            <!-- 显式的"解除归类"，只在确实属于某个分类时出现。
                 原来这一项写的是"未分类"—— 那是个**桶名**，读起来像"把它放进未分类这个桶"，
                 而不是"切断它和现在这个分类的关系"（真机第五轮反馈）。 -->
            <li v-if="entry.categoryId !== undefined">
              <button
                class="w-full bg-transparent px-3 py-1.5 text-left text-[11px] font-bold text-brand hover:bg-brand-soft"
                type="button"
                role="menuitem"
                @click="fromMenu(() => store.assign(entry.id, undefined))"
              >
                {{ t('category_remove') }}
              </button>
            </li>
            <li v-for="category in store.categories" :key="category.id">
              <button
                class="tn-ellipsis w-full bg-transparent px-3 py-1.5 text-left text-[11px] hover:bg-chip disabled:cursor-not-allowed disabled:opacity-40"
                :class="entry.categoryId === category.id ? 'font-bold text-brand' : 'text-ink'"
                type="button"
                role="menuitem"
                :disabled="entry.categoryId === category.id"
                @click="fromMenu(() => store.assign(entry.id, category.id))"
              >
                {{ category.name }}
              </button>
            </li>
            <li v-if="!store.categories.length">
              <p class="px-3 py-1.5 text-[10px] leading-relaxed text-muted">{{ t('category_empty_hint') }}</p>
            </li>

            <li class="mt-1 border-t border-line pt-1">
              <button
                class="w-full bg-transparent px-3 py-1.5 text-left text-[11px] font-bold text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-40"
                type="button"
                role="menuitem"
                :disabled="locked"
                :title="locked ? t('group_locked_hint') : t('group_delete')"
                @click="fromMenu(() => { confirming = true; })"
              >
                {{ t('group_delete') }}
              </button>
            </li>
          </ul>
        </div>
      </div>
    </header>

    <div v-if="confirming && !locked" class="rounded-b-card border-t border-line bg-danger-soft px-4 py-2.5">
      <p class="m-0 text-[11px] font-semibold text-ink">{{ t('confirm_delete_group_title') }}</p>
      <p class="mb-2 mt-1 text-[10px] text-muted">{{ t('confirm_delete_group_body', { count: entry.tabCount }) }}</p>
      <div class="flex gap-2">
        <button class="rounded-control bg-danger px-3 py-1.5 text-[11px] font-bold text-white" type="button" @click="store.remove(entry.id)">{{ t('confirm_yes') }}</button>
        <button class="rounded-control border border-line bg-panel px-3 py-1.5 text-[11px] font-bold text-ink" type="button" @click="confirming = false">{{ t('confirm_no') }}</button>
      </div>
    </div>

    <div v-else ref="body" class="border-t border-line px-3 pb-2 pt-1" @dragover.prevent @drop.prevent="onBodyDrop">
      <p v-if="tabs === undefined" class="px-1.5 py-2 text-[10px] text-muted">…</p>
      <p v-else-if="ordered.length === 0" class="px-1.5 py-2 text-[10px] text-muted">{{ t('group_empty') }}</p>

      <div v-for="tab in shown" :key="tab.id" data-tab-row>
        <TabRow
          :tab="tab"
          :locked="locked"
          :draggable="!locked && !searching"
          selectable
          :checked="store.isRecordChecked(entry.id, tab.id)"
          @restore="store.restoreOneTab(entry.id, tab.id)"
          @remove="store.removeTab(entry.id, tab.id)"
          @copy="store.copyOneTab(tab)"
          @dragstart="onTabDragStart($event, tab)"
          @toggle-select="store.toggleRecord(entry.id, tab.id)"
        />
      </div>

      <button
        v-if="hidden > 0 || revealed > 0"
        class="mt-0.5 w-full rounded bg-transparent px-1.5 py-1.5 text-left text-[10px] font-bold text-brand hover:bg-brand-soft"
        type="button"
        @click="toggleExpansion()"
      >
        {{ hidden > 0 ? t('show_remaining', { count: hidden }) : t('collapse') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 勾选框平时淡一点，hover 或已勾选时清楚 —— 截图里没有它，但批量恢复需要它（Q11）。 */
.tn-check {
  opacity: 0.35;
  transition: opacity 0.12s ease;
}
.tn-group:hover .tn-check,
.tn-check:focus-within {
  opacity: 1;
}
</style>
