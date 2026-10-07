<script lang="ts" setup>
import { leaveTrashView } from '@/shared/trash-view';
import { computed, nextTick, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { useGroups } from '@/composables/useGroups';
import { CAT_MIME, decodeCategory, decodeGroup, encode, GROUP_MIME } from '@/shared/dnd';
import { categoryDropIndex, countByCategory } from '@/core/domain/category';
import { t } from '@/shared/i18n';
import type { Category, CategoryFilter } from '@/shared/types';

/**
 * 左栏：分类（V1.2 既有约定）+ 分类拖拽排序。
 *
 * 点分类是**筛选**，不是切换视图 —— 右栏永远是同一套会话列表，只是被过滤了。
 * 会话可以拖到某个分类上改归属；拖到"未分类"上就是取消归类。
 *
 * 同一块像素上因此有两种拖放，靠 MIME 分开：
 * 载荷里带 `GROUP_MIME` 的落在行上 = 归类，带 `CAT_MIME` 的落在行**之间** = 排序。
 * 排序的插入缝由指针落在这一行的上半还是下半决定，与会话列表那套半区判定同一个口径。
 */
const store = useGroups();
const creating = ref(false);
const draft = ref('');
const editingId = ref<string | null>(null);
const editingName = ref('');
const input = ref<HTMLInputElement | null>(null);
/**
 * 分类行在 `v-for` 里，模板 ref 会变成数组（`editInput.value?.focus is not a function`
 * 就是这么来的）。同一时刻只可能有一个编辑框，所以改成从根节点查那个类名。
 */
const rail = ref<HTMLElement | null>(null);
/** 排序拖放的几何基准用这个 ref，不用 `event.currentTarget`：两种落点的事件都会冒泡，currentTarget 是哪个取决于监听器挂在哪。 */
const list = ref<HTMLElement | null>(null);

/** 每个分类里有多少个会话 —— 用 domain 的派生，不在组件里重写一遍计数循环。 */
const counts = computed(() => countByCategory(store.index));

/**
 * 分类名的查找（真机第五轮："左侧的分类名称可以修改、删除、查找"）。
 *
 * 只筛**左栏这些行**，不动右栏 —— 右栏的筛选是"点了某个分类"那件事。
 * 大小写不敏感，与建类/改名时的重名判定同一套口径。
 */
const search = ref('');
const searching = computed(() => search.value.trim().length > 0);
const shownCategories = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (!needle) return store.categories;
  return store.categories.filter((category) => category.name.toLowerCase().includes(needle));
});

/** ↑↓ 与拖拽用的是**真实下标**：过滤后的行号不等于列表位置，按行号移动会跳位。 */
function indexOfCategory(id: string | null): number {
  if (id === null) return -1;
  return store.categories.findIndex((candidate) => candidate.id === id);
}

function realIndex(category: Category): number {
  return indexOfCategory(category.id);
}

/**
 * 正在拖的那一行的 id（null = 现在没有分类在被拖）。
 *
 * `dragover` 阶段读不到 dataTransfer 的内容（浏览器只在 drop 时放行数据，只有 `types`
 * 可见），所以"我在拖谁"只能记在组件里；它的位置用 `indexOfCategory` 现查。
 * 拖拽期间别的窗口把那个分类删了 -> 查出来是 -1，落点随之作废。
 */
const dragCategory = ref<string | null>(null);
/** 指针算出的插入缝（0..n，被拖的那行也算在内）；null = 当前没有可落的位置（含"拖回原位"）。 */
const dropSlot = ref<number | null>(null);

function hasType(event: DragEvent, mime: string): boolean {
  return event.dataTransfer?.types.includes(mime) === true;
}

/**
 * 指针落在第几道缝：从上到下数"指针在哪几行的下半区"。
 *
 * 与右栏会话列表的 `listIndex()` 同一套算法（既有约定 要求两处手感一致），
 * 差别只在行是 `<li>` 而不是卡片，且 n 行有 n+1 道缝。
 */
function slotFromPointer(clientY: number): number {
  const rows = [...(list.value?.querySelectorAll<HTMLElement>('[data-cat-row]') ?? [])];
  let slot = 0;
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (clientY > box.top + box.height / 2) slot += 1;
  }
  return slot;
}

function isActive(target: CategoryFilter): boolean {
  const current = store.filter;
  if (current.kind !== target.kind) return false;
  if (current.kind === 'category' && target.kind === 'category') return current.id === target.id;
  return true;
}

function pick(target: CategoryFilter): void {
  /* 选任何分类都要把视图交还给会话列表。
     不接这一句的话：回收站开着时点分类，筛选器变了而右栏还停在回收站 ——
     用户看到的是"点了没反应"。开关与筛选是两个正交状态，正因如此才必须显式收敛。 */
  leaveTrashView();

  store.setFilter(target);
}

async function startCreate(): Promise<void> {
  creating.value = true;
  draft.value = '';
  await nextTick();
  input.value?.focus();
}

async function commitCreate(): Promise<void> {
  if (!creating.value) return;
  creating.value = false;
  const name = draft.value.trim();
  if (!name) return;
  const created = await store.addCategory(name);
  if (created) pick({ kind: 'category', id: created.id });
}

function onCreateKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') creating.value = false;
  if (event.key === 'Enter') void commitCreate();
}

async function startEdit(category: Category): Promise<void> {
  editingId.value = category.id;
  editingName.value = category.name;
  await nextTick();
  const field = rail.value?.querySelector<HTMLInputElement>('.tn-cat-edit');
  field?.focus();
  field?.select();
}

async function commitEdit(): Promise<void> {
  const id = editingId.value;
  const name = editingName.value.trim();
  editingId.value = null;
  if (!id || !name) return;
  await store.renameCategoryById(id, name);
}

function onEditKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') editingId.value = null;
  if (event.key === 'Enter') void commitEdit();
}

/** 行自身的 dragover 只管会话（归类）；分类排序的落点在 `<ul>` 上，见 onListDragOver。 */
function onDragOver(event: DragEvent): void {
  if (!hasType(event, GROUP_MIME)) return;
  event.preventDefault();
}

async function onDrop(event: DragEvent, categoryId?: string): Promise<void> {
  const payload = decodeGroup(event.dataTransfer?.getData(GROUP_MIME) || null);
  if (!payload) return; // 分类拖放：这里不动，交给 <ul> 的排序落点
  event.preventDefault();
  await store.assign(payload.groupId, categoryId);
}

function onCategoryDragStart(event: DragEvent, category: Category): void {
  // 查找中不排序：过滤后的行号不是列表位置，这时候排序会跳位（既有约定 同一条理由）
  if (searching.value || !event.dataTransfer) return;
  event.dataTransfer.setData(CAT_MIME, encode({ categoryId: category.id }));
  event.dataTransfer.effectAllowed = 'move';
  dragCategory.value = category.id;
}

function onCategoryDragEnd(): void {
  dragCategory.value = null;
  dropSlot.value = null;
}

function onListDragOver(event: DragEvent): void {
  if (!hasType(event, CAT_MIME)) return;
  const from = indexOfCategory(dragCategory.value);
  if (from < 0) return;
  const slot = slotFromPointer(event.clientY);
  // 落在自己上下的缝里 = 没有移动：不给 preventDefault，指示线也不出现，
  // 于是 drop 事件根本不会发生，一次空拖拽不会写库。
  if (categoryDropIndex(from, slot) === -1) {
    dropSlot.value = null;
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropSlot.value = slot;
}

async function onListDrop(event: DragEvent): Promise<void> {
  const payload = decodeCategory(event.dataTransfer?.getData(CAT_MIME) || null);
  dragCategory.value = null;
  dropSlot.value = null;
  if (!payload) return; // 会话拖放：归类已由行的 @drop 处理
  const from = indexOfCategory(payload.categoryId);
  if (from < 0) return; // 拖拽期间被别的窗口删掉了
  const to = categoryDropIndex(from, slotFromPointer(event.clientY));
  if (to === -1) return; // 拖回原位：不写库、不 bump updatedAt、不惊动其他窗口
  await store.moveCategoryTo(payload.categoryId, to);
}
</script>

<template>
  <nav ref="rail" class="tn-rail min-h-0 flex-1 overflow-y-auto px-2 py-2">
    <!-- 头部就是"查找 + 新建"两件事（真机第六轮）：
         "分类"这两个字是这一栏的名字，不是信息，占一行不如让给查找框。 -->
    <div class="flex items-center gap-1.5 px-2 pb-2 pt-1">
      <label class="flex min-w-0 flex-1 items-center gap-1.5 rounded-tight border border-line bg-bg px-2 py-1">
        <span class="shrink-0 text-muted"><AppIcon name="search" :size="12" /></span>
        <input
          v-model="search"
          class="w-full min-w-0 border-0 bg-transparent text-[12px] text-ink outline-none"
          type="search"
          :placeholder="t('category_search_placeholder')"
          :aria-label="t('category_search_placeholder')"
        />
        <button
          v-if="searching"
          class="shrink-0 bg-transparent text-[11px] text-muted hover:text-ink"
          type="button"
          :aria-label="t('close')"
          @click="search = ''"
        >
          ✕
        </button>
      </label>
      <button
        class="grid h-6 w-6 shrink-0 place-items-center rounded-tight text-muted hover:bg-chip hover:text-ink"
        type="button"
        :title="t('category_add')"
        :aria-label="t('category_add')"
        @click="startCreate"
      >
        <AppIcon name="plus" :size="13" />
      </button>
    </div>

    <input
      v-if="creating"
      ref="input"
      v-model="draft"
      class="mb-1.5 w-full rounded-tight border border-brand bg-panel-raised px-2 py-1 text-[12px] text-ink outline-none"
      type="text"
      :placeholder="t('category_name_placeholder')"
      @blur="commitCreate"
      @keydown="onCreateKeydown"
    />

    <!-- 两行系统项：既不能被拖（它们不是分类，没有顺序可言），
         也不给分类排序当落点（它们不在这个 <ul> 里）。"未分类"仍然收会话拖放 = 取消归类。 -->
    <button
      class="tn-item flex w-full items-center gap-2 rounded-tight px-2 py-1.5 text-left text-[12px]"
      :class="isActive({ kind: 'all' }) ? 'bg-brand-soft font-bold text-brand' : 'text-ink hover:bg-chip'"
      type="button"
      :aria-current="isActive({ kind: 'all' }) ? 'true' : undefined"
      @click="pick({ kind: 'all' })"
    >
      <AppIcon name="panel" :size="13" />
      <span class="tn-ellipsis min-w-0 flex-1">{{ t('category_all') }}</span>
      <span class="shrink-0 text-[10px] text-muted">{{ store.index.length }}</span>
    </button>

    <button
      class="tn-item flex w-full items-center gap-2 rounded-tight px-2 py-1.5 text-left text-[12px]"
      :class="isActive({ kind: 'uncategorized' }) ? 'bg-brand-soft font-bold text-brand' : 'text-ink hover:bg-chip'"
      type="button"
      :aria-current="isActive({ kind: 'uncategorized' }) ? 'true' : undefined"
      @dragover="onDragOver($event)"
      @drop.prevent="onDrop($event, undefined)"
      @click="pick({ kind: 'uncategorized' })"
    >
      <AppIcon name="folder" :size="13" />
      <span class="tn-ellipsis min-w-0 flex-1">{{ t('category_uncategorized') }}</span>
      <span class="shrink-0 text-[10px] text-muted">{{ store.uncategorizedCount }}</span>
    </button>

    <!--
      回收站入口**不在这里**：它原来跟在分类列表末尾，被读成"回收站是一个分类"——
      而它其实是一个正交视图（`shared/trash-view.ts`）。用户 2026-10-05 的指令是
      "回收站放在左侧栏设置与主题上面"，于是它挪到 `entrypoints/app/App.vue` 的 footer 里，
      与主题/设置同一区，并且**没有在这里留第二个入口**（重复入口是他明确反对过的形状）。
    -->
    <p v-if="searching && !shownCategories.length" class="px-2 py-1 text-[10px] text-muted">
      {{ t('search_no_results', { q: search }) }}
    </p>
    <p v-else-if="!store.categories.length && !creating" class="px-2 pb-1 pt-3 text-[10px] leading-relaxed text-muted">
      {{ t('category_empty_hint') }}
    </p>

    <ul ref="list" class="mt-1" @dragover="onListDragOver($event)" @drop.prevent="onListDrop($event)">
      <li
        v-for="(category, index) in shownCategories"
        :key="category.id"
        data-cat-row
        :class="{ 'tn-drop-above': dropSlot === index, 'tn-drop-below': dropSlot === index + 1 }"
      >
        <input
          v-if="editingId === category.id"
          v-model="editingName"
          class="tn-cat-edit mb-1 mt-1 w-full rounded-tight border border-brand bg-panel-raised px-2 py-1 text-[12px] text-ink outline-none"
          type="text"
          :placeholder="t('category_name_placeholder')"
          @blur="commitEdit"
          @keydown="onEditKeydown"
        />
        <div
          v-else
          class="group/cat flex items-center gap-1 rounded-tight px-2 py-1.5"
          :class="isActive({ kind: 'category', id: category.id }) ? 'bg-brand-soft' : 'hover:bg-chip'"
          :draggable="!searching"
          @dragover="onDragOver($event)"
          @drop.prevent="onDrop($event, category.id)"
          @dragstart="onCategoryDragStart($event, category)"
          @dragend="onCategoryDragEnd"
        >
          <button
            class="flex min-w-0 flex-1 items-center gap-2 bg-transparent px-0 py-0 text-left text-[12px]"
            :class="isActive({ kind: 'category', id: category.id }) ? 'font-bold text-brand' : 'text-ink'"
            type="button"
            :aria-current="isActive({ kind: 'category', id: category.id }) ? 'true' : undefined"
            @click="pick({ kind: 'category', id: category.id })"
          >
            <AppIcon name="folder" :size="13" />
            <span class="tn-ellipsis min-w-0 flex-1">{{ category.name }}</span>
            <span class="shrink-0 text-[10px] text-muted">{{ counts.perCategory.get(category.id) ?? 0 }}</span>
          </button>

          <button
            class="shrink-0 rounded bg-transparent p-1 text-[10px] text-muted hover:text-ink"
            type="button"
            :aria-label="t('category_rename')"
            :title="t('category_rename')"
            @click="startEdit(category)"
          >
            ✎
          </button>
          <button
            class="shrink-0 rounded bg-transparent p-1 text-[10px] text-muted hover:text-danger"
            type="button"
            :aria-label="t('category_delete')"
            :title="t('category_delete')"
            @click="store.removeCategory(category.id)"
          >
            <AppIcon name="trash" :size="12" />
          </button>
          <!-- 查找中不排序：过滤后的行号不是列表位置，这时候移动会跳位 -->
          <template v-if="!searching">
            <button
              class="tn-cat-order shrink-0 rounded bg-transparent p-1 text-[10px] text-muted hover:text-ink disabled:opacity-30"
              type="button"
              :aria-label="t('category_move_up')"
              :disabled="realIndex(category) === 0"
              :title="t('category_move_up')"
              @click="store.moveCategoryTo(category.id, realIndex(category) - 1)"
            >
              ↑
            </button>
            <button
              class="tn-cat-order shrink-0 rounded bg-transparent p-1 text-[10px] text-muted hover:text-ink disabled:opacity-30"
              type="button"
              :aria-label="t('category_move_down')"
              :disabled="realIndex(category) === store.categories.length - 1"
              :title="t('category_move_down')"
              @click="store.moveCategoryTo(category.id, realIndex(category) + 1)"
            >
              ↓
            </button>
          </template>
        </div>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.tn-cat-order {
  opacity: 0;
  transition: opacity 0.12s ease;
}
.group\/cat:hover .tn-cat-order,
.group\/cat:focus-within .tn-cat-order {
  opacity: 1;
}

/* 排序落点的指示线：画在 <li> 的上沿或下沿（伪元素不占布局宽度，
   所以 200px 窄栏里也不会把行挤出一根横向滚动条）。既有约定。 */
[data-cat-row].tn-drop-above::before,
[data-cat-row].tn-drop-below::after {
  content: '';
  display: block;
  height: 2px;
  margin-inline: 4px;
  border-radius: 999px;
  background: var(--color-brand);
}
</style>
