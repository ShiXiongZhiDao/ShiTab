<script lang="ts" setup>
/**
 * 回收站（既有约定 的 UI 面，载体在 4afb2e2 之后是**工作台左栏**，不再是设置页）。
 *
 * 它存在的意义：删除是软删除，**没有这个界面，用户删掉的会话就是"在本机看不见的地方
 * 躺 7 天然后消失"** —— 那比原来的物理删除更坏。
 *
 * 条目的两种来源（既有约定 之后）：`user-delete` 与 `consumed`（恢复即消费）。
 * 后者必须**当场标出来**：回收站里出现一条他没删过的会话，如果不写清"这是恢复掉的"，
 * 用户的第一反应会是"谁把它弄进来的"，而这正是他会不会信任这个面板的分界。
 *
 * 行的形状现在与主列表的会话卡**同形**：同一套标题行（文件夹图标 + 名字 +
 * 时钟时间戳 + 条数 + 状态胶囊 + 右侧图标条），展开后就是同一颗 `TabRow` 组件。
 * 之前这里自造了一套"▸ 箭头 + 两行小字 + 两颗文字按钮"的形状，看起来是另一个东西，
 * 用户要重新学一遍"这一行怎么展开、这两颗按钮是干什么的"。
 *
 * ★ 既有约定 把那条口径从"行同形"延伸到**外壳同形**：这一屏不再自带一层 `p-5` 的面板壳，
 * 标题槽 / 通栏批量条 / 空态块三处都换成与会话列表**同一颗组件**（不是同一串类名 ——
 * 抄类名正是这层壳当初长歪的方式）。DOM 顺序两屏统一成 `[标题槽][通栏条][滚动区]`，
 * 而**滚动区在这里、在这一屏内部**：通栏条要不随内容滚，它就得是滚动区的兄弟。
 * 出口也不在这屏里：左栏那颗是 `toggleTrashView`（再点一次就回列表），点任意分类走
 * `CategoryRail` 里的 `leaveTrashView()` —— 原来那颗「返回标签组列表」是第三个入口，删了。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { vIndeterminate } from '@/shared/directives';
import AppIcon from '@/components/AppIcon.vue';
import TabRow from '@/components/TabRow.vue';
import BulkStrip from '@/components/BulkStrip.vue';
import ViewEmpty from '@/components/ViewEmpty.vue';
import ViewHeading from '@/components/ViewHeading.vue';
import { storagePort } from '@/shared/services';
import { canRevealMore, revealMore, windowLimit } from '@/shared/tab-window';
import {
  purgeFromTrash,
  purgeTrashTab,
  recordReason,
  restoreFromTrash,
  restoreTrashTab,
  sweepExpiredTrash,
} from '@/core/application/delete-model';
import { clipboardTextOfTab } from '@/core/application/share';
import { copyToClipboard } from '@/shared/clipboard';
import { t } from '@/shared/i18n';
import { clockStamp } from '@/shared/utils';
import type { SavedTab, TrashEntry } from '@/shared/types';

const items = ref<TrashEntry[]>([]);

/**
 * 展开到**超过前 COLLAPSED_TAB_LIMIT 条**的那些行。
 *
 * 命名与语义都照主列表的 `GroupRow.expanded`。它**必须跨 reload 保住**：每条记录的操作
 * 都会 `reload()`，状态跟着单行组件走的话，用户点一下"还原这一条"整行就当场收起 ——
 * 他要接着看剩下的几条还得再点一次，这正是"反馈打断操作"。
 */
const expanded = ref<Set<string>>(new Set());
/** 每一行**额外摊开**了多少条（与主列表同一套算法，见 `shared/tab-window.ts`）。 */
const revealed = ref<Map<string, number>>(new Map());

function toggle(groupId: string): void {
  const entry = items.value.find((candidate) => candidate.group.id === groupId);
  const total = entry ? ordered(entry).length : 0;
  const now = revealed.value.get(groupId) ?? 0;
  const next = canRevealMore(total, now) ? revealMore(total, now) : 0;
  const revealedNext = new Map(revealed.value);
  if (next === 0) revealedNext.delete(groupId);
  else revealedNext.set(groupId, next);
  revealed.value = revealedNext;

  // `expanded` 这份集合留着是给模板与"该行是否摊开过"的读法用的（跨 reload 保住的那条要求不变）。
  const nextExpanded = new Set(expanded.value);
  if (next === 0) nextExpanded.delete(groupId);
  else nextExpanded.add(groupId);
  expanded.value = nextExpanded;
}

/** 排序轴与主列表一致（`GroupRow.ordered`），否则回收站里的顺序是并入历史的顺序。 */
function ordered(entry: TrashEntry): SavedTab[] {
  return [...entry.group.tabs].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.originalIndex - b.originalIndex,
  );
}

function shown(entry: TrashEntry): SavedTab[] {
  const all = ordered(entry);
  // 回收站的行以前是"一次摊全表"；现在与主列表同形：折叠 30 条 + 每次点一批。
  return all.slice(0, windowLimit(all.length, revealed.value.get(entry.group.id) ?? 0));
}

function hidden(entry: TrashEntry): number {
  return ordered(entry).length - shown(entry).length;
}

/** 一行里全是"恢复掉的"记录时才标「已恢复」；混着用户删除的，标了反而误导。 */
function allConsumed(entry: TrashEntry): boolean {
  return entry.group.tabs.every((tab) => recordReason(entry, tab.id) === 'consumed');
}

function countLabel(entry: TrashEntry): string {
  return entry.group.tabs.length === 1
    ? t('group_tab_count_one')
    : t('group_tab_count', { count: entry.group.tabs.length });
}

/**
 * 面板自己的勾选—— **故意不与 `useGroups.checked` 共用一份**，这不是省事。
 *
 * 共用会串台成一件危险的事：在回收站勾 5 行、切回会话列表，那 5 个 id 还在勾选里，
 * 而主列表那颗按钮是「删除所选」= 真的把活会话删掉。两个视图的 selection 分开，
 * 代价只是"切走再切回来要重勾"，而那恰好是用户期望的 —— 回收站里那些行已经不是他的会话了。
 *
 * ★ **状态只有一份：`checkedRecords`（键 `groupId::tabId`），行首框是它的派生视图**。
 * 既有约定 曾把"整行"做成另一种选择、并与行内互斥（整行选中 ⇒ 行内那颗灰掉），
 * 他真机第一次用就问「点了标签组，组里的标签选不了，是不是 bug」。那不是 bug，但**跨行可以混选、
 * 同行不行**这个不对称确实就是"坏了"的样子。现在行首框只代表"这一行全选/全不选"，
 * 部分选中时半选（`v-indeterminate`），行内那颗永远能点。
 *
 * ⚠ 行首框**不代表另一种动作**：整行还原/彻底删除要写的组墓碑与整行 `'trash'` 标记，
 * 由"这一行被全部覆盖"推导出来（`wholeRowIds`）⇒ 既有约定 那两套写入语义一个字没动，
 * 变的只是它怎么被表达。
 */
const checkedRecords = ref<Set<string>>(new Set());
const recordKey = (groupId: string, tabId: string): string => `${groupId}::${tabId}`;
const splitRecordKey = (key: string): { groupId: string; tabId: string } => {
  const at = key.lastIndexOf('::');
  return { groupId: key.slice(0, at), tabId: key.slice(at + 2) };
};

/** 一行的全部记录键。入站时已经滤掉不可恢复的记录，所以这里不需要再滤。 */
function keysOf(entry: TrashEntry): string[] {
  return entry.group.tabs.map((tab) => recordKey(entry.group.id, tab.id));
}

/** 行首框的三态；`some` 只用来画那根半选横杠。 */
function rowState(entry: TrashEntry): 'all' | 'some' | 'none' {
  const keys = keysOf(entry);
  const hit = keys.reduce((sum, key) => (checkedRecords.value.has(key) ? sum + 1 : sum), 0);
  if (keys.length > 0 && hit === keys.length) return 'all';
  return hit > 0 ? 'some' : 'none';
}

/** 行首框 = 这一行的全选 / 全不选。别的手一碰就跳变的事都不做：只动这一行的键。 */
function toggleRow(groupId: string): void {
  const entry = items.value.find((item) => item.group.id === groupId);
  if (!entry) return;
  const keys = keysOf(entry);
  const next = new Set(checkedRecords.value);
  if (rowState(entry) === 'all') keys.forEach((key) => next.delete(key));
  else keys.forEach((key) => next.add(key));
  checkedRecords.value = next;
}

function toggleRecord(groupId: string, tabId: string): void {
  const next = new Set(checkedRecords.value);
  const key = recordKey(groupId, tabId);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  checkedRecords.value = next;
}

/** 被整行覆盖的那些行 ⇒ 批量时按整行处理（组墓碑、整行标记照写）。 */
const wholeRowIds = computed(() =>
  items.value.filter((entry) => rowState(entry) === 'all').map((entry) => entry.group.id),
);
/** 没被整行覆盖的那部分勾选才是"记录级"的 —— 两个数这样分才不会重复计。 */
const looseRecordKeys = computed(() => {
  const whole = new Set(wholeRowIds.value);
  return [...checkedRecords.value].filter((key) => !whole.has(splitRecordKey(key).groupId));
});
const checkedCount = computed(() => wholeRowIds.value.length);
const recordCount = computed(() => looseRecordKeys.value.length);
/** 批量条出没出现看这个：整行与记录级都算"有勾选"。 */
const selectionCount = computed(() => checkedRecords.value.size);

function clearChecked(): void {
  checkedRecords.value = new Set();
  confirmingPurge.value = false;
}

/** 「全选」= 每一行都被整行覆盖（于是记录级那部分归零，汇总读作"N 个标签组 · 0 条记录"）。 */
function selectAll(): void {
  checkedRecords.value = new Set(items.value.flatMap((entry) => keysOf(entry)));
  confirmingPurge.value = false;
}

/** 批量进行中：两颗按钮都灰着，避免"点了第二下把第一下的目标改了"。 */
const busy = ref(false);
/** 彻底删除是**两步**（与主列表的「删除所选」同一条纪律）：第一下只出确认条。 */
const confirmingPurge = ref(false);

async function reload(): Promise<void> {
  // 过期清理只在这台机器上删东西，不发墓碑、不动远端（delete-model.ts 的那条理由）
  await sweepExpiredTrash({ storage: storagePort }, Date.now());
  /**
   * 滤掉"零可见记录"的壳行。
   *
   * 那种行是**凭证的载体**：逐条还原到空时不能把整行删掉，否则"这几条我处理过了"就没人记得，
   * 远端那一版下一轮会把它们并回回收站。但它不该出现在用户面前 ——
   * 既有约定 早就定过"0 条的空壳是一个都不该露出来的形状"，这里只是把同一条口径
   * 用到新出现的那种壳上。存储层不过滤（同步要读它），所以过滤放在这一处、也是唯一一处显示侧。
   *
   * 顺带一条批量相关的后果：壳行不进 `items` ⇒ 它也**不会被全选挑中**，
   * 也就不会出现"用户批量删掉了自己从没见过的凭证行"。
   */
  const rows = (await storagePort.listTrash()).filter((entry) => entry.group.tabs.length > 0);
  items.value = rows;
  // 后台同步可能刚把某一行或某几条处理掉（对面还原/彻底删除）：勾选里那些已经不存在的键要剔掉，
  // 否则批量动作会对着不存在的目标跑一轮，用户看到的是"我勾了 5 个，只动了 3 个"。
  // 只有一份状态 ⇒ 逐条核 `tabId` 就够（行首框是派生的，键被剔掉之后自己会退回半选/未选）。
  const aliveRecords = new Set(
    rows.flatMap((entry) => entry.group.tabs.map((tab) => recordKey(entry.group.id, tab.id))),
  );
  checkedRecords.value = new Set([...checkedRecords.value].filter((key) => aliveRecords.has(key)));
}

/**
 * 挂载时读一次，之后**跟着存储变**：
 * 回收站现在会由后台同步写进来（另一台设备删的会话、另一台设备处理掉的行），
 * 面板只读一次的话，用户看到的就是"我同步完了，回收站里还是上次打开时那份"。
 */
let stopWatch: (() => void) | undefined;

onMounted(() => {
  void reload();
  stopWatch = storagePort.watchTrash(() => {
    void reload();
  });
});

onBeforeUnmount(() => stopWatch?.());

async function restore(groupId: string): Promise<void> {
  await restoreFromTrash({ storage: storagePort }, { groupId, at: Date.now() });
  await reload();
}

async function purge(groupId: string): Promise<void> {
  await purgeFromTrash({ storage: storagePort }, { groupId, at: Date.now() });
  await reload();
}

/**
 * 批量还原 / 批量彻底删除。两条纪律写在这里，别在下次"优化成并发"时弄丢：
 *
 * 1. **必须顺序 `await`，不能 `Promise.all`。** 这两个动作都会写墓碑与 `'trash'` 标记，
 *    而那两个键是**整块数组的读-改-写**（`appendTombstone` / `revokeGroupTombstone`）：
 *    并发跑就是两辆车各拿一份旧账本往前开，后写的那一份把先写的覆盖掉 ——
 *    症状不是报错，是"删掉的行下一轮又回来了"（既有约定 刚修过的那一类）。
 *    回收站里几十行的量级，顺序跑的代价是几十毫秒一次，看不见。
 * 2. **一次批量共用一个 `at`。** 凭证与标记的比较全是 `>=`，同一批里给出两个不同时刻
 *    会让"谁压住谁"依赖循环顺序；一个时刻 ⇒ 批内平手，结果只由内容决定。
 *
 * 整行与记录级两份目标**按构造互斥**（`looseRecordKeys` 剔掉了被整行覆盖的那些），
 * 所以 既有约定 那句"整行先做、记录级后做，否则同一行会被做两遍"现在不需要靠顺序来防了 ——
 * 顺序仍然保留，但它不再承重。
 */
async function restoreChecked(): Promise<void> {
  if (busy.value || selectionCount.value === 0) return;
  busy.value = true;
  const groups = [...wholeRowIds.value];
  const records = looseRecordKeys.value.map(splitRecordKey);
  const at = Date.now();
  try {
    for (const groupId of groups) await restoreFromTrash({ storage: storagePort }, { groupId, at });
    for (const { groupId, tabId } of records) {
      await restoreTrashTab({ storage: storagePort }, { groupId, tabId, at });
    }
    message.value = t('trash_bulk_restored', { groups: groups.length, records: records.length });
  } finally {
    busy.value = false;
    clearChecked();
    await reload();
  }
}

async function purgeChecked(): Promise<void> {
  if (busy.value || selectionCount.value === 0) return;
  busy.value = true;
  const groups = [...wholeRowIds.value];
  const records = looseRecordKeys.value.map(splitRecordKey);
  const at = Date.now();
  try {
    for (const groupId of groups) await purgeFromTrash({ storage: storagePort }, { groupId, at });
    for (const { groupId, tabId } of records) {
      await purgeTrashTab({ storage: storagePort }, { groupId, tabId, at });
    }
    message.value = t('trash_bulk_purged', { groups: groups.length, records: records.length });
  } finally {
    busy.value = false;
    clearChecked();
    await reload();
  }
}

/** 只把这一条记录放回会话（组还活着就是并回去，整组没了就重建一个只带它的会话）。 */
async function restoreRecord(groupId: string, tabId: string): Promise<void> {
  await restoreTrashTab({ storage: storagePort }, { groupId, tabId, at: Date.now() });
  await reload();
}

/** 只把这一条从回收站永久删掉，剩下的继续躺到 7 天。 */
async function purgeRecord(groupId: string, tabId: string): Promise<void> {
  await purgeTrashTab({ storage: storagePort }, { groupId, tabId, at: Date.now() });
  await reload();
}

/**
 * 复制一条。走的是主列表同一份剪贴板文本（`clipboardTextOfTab`）——
 * 回收站的行现在与主列表同形，"能复制"这件事也该同形，
 * 而不是在两个地方各写一遍 `标题\nURL`（那两份迟早会不一样）。
 *
 * 反馈走本面板自己的一行 `role=status`：主列表用 store 的 toast，而那颗 toast 的
 * 状态机在 `useGroups` 里、`showToast` 没有从那个模块导出，为了一行提示去拆它不值。
 */
const message = ref<string | null>(null);

async function copyRecord(tab: SavedTab): Promise<void> {
  try {
    await copyToClipboard(clipboardTextOfTab(tab));
    message.value = t('copy_tab_done');
  } catch {
    // 浏览器不让写剪贴板时如实说一句。这里必须自己 catch：
    // 主列表那套 `run()` 在 store 里，面板没接上，漏了就是"点了没反应"。
    message.value = t('operation_failed');
  }
}

function daysLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));
}
</script>

<template>
  <!--
    一列：`[标题槽][通栏批量条][滚动区]`，与会话列表同一顺序、同一颗外壳组件。
    ⚠ 滚动区必须在**这一屏内部**：通栏条要不随内容滚，它就得是滚动区的兄弟而不是它的内容。
  -->
  <div class="flex min-h-0 flex-1 flex-col" data-testid="trash-view">
    <!-- 计数轴是**行数（会话数）**，与列表那屏的 `store.visible.length` 同一个轴；
         原来底部那行「这里共 N 条记录」是另一个轴，两个数同时存在时总有一个是噪音。 -->
    <ViewHeading :label="t('nav_trash')" :count="items.length" />

    <!--
      批量条（既有约定 的"两份勾选分开"一个字没动，既有约定 只把**载体**收成同一条通栏）：
      勾选数 > 0 才出现，「彻底删除」那颗是**两步**（第一下只把条子变成确认句，第二下才真删）。
    -->
    <BulkStrip v-if="selectionCount > 0" data-testid="trash-bulk-bar">
      <!-- 两个数一起说：整行与记录级是同一份勾选的两种覆盖程度，分开挂就会有一个数被漏看。 -->
      <span class="text-[11px] font-bold text-ink" data-testid="trash-bulk-summary">
        {{ t('bulk_summary', { groups: checkedCount, records: recordCount }) }}
      </span>
      <button
        class="rounded-control bg-brand px-3 py-1.5 text-[11px] font-bold text-brand-contrast disabled:opacity-50"
        type="button"
        :disabled="busy"
        data-testid="trash-bulk-restore"
        @click="restoreChecked"
      >
        {{ t('trash_bulk_restore') }}
      </button>
      <button
        v-if="!confirmingPurge"
        class="rounded bg-transparent px-2 py-1 text-[11px] font-bold text-danger hover:bg-danger-soft disabled:opacity-50"
        type="button"
        :disabled="busy"
        data-testid="trash-bulk-purge"
        @click="confirmingPurge = true"
      >
        {{ t('trash_bulk_purge') }}
      </button>
      <template v-else>
        <span class="text-[11px] font-semibold text-ink" data-testid="trash-bulk-confirm">
          {{ t('trash_bulk_purge_confirm', { groups: checkedCount, records: recordCount }) }}
        </span>
        <button
          class="rounded-control bg-danger px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
          type="button"
          :disabled="busy"
          data-testid="trash-bulk-purge-yes"
          @click="purgeChecked"
        >{{ t('trash_action_purge') }}</button>
        <button
          class="rounded-control border border-line bg-panel px-3 py-1.5 text-[11px] font-bold text-ink"
          type="button"
          data-testid="trash-bulk-purge-no"
          @click="confirmingPurge = false"
        >{{ t('confirm_no') }}</button>
      </template>

      <span class="ml-auto flex items-center gap-2">
        <button
          class="rounded bg-transparent px-2 py-1 text-[11px] font-bold text-muted hover:text-brand"
          type="button"
          data-testid="trash-bulk-all"
          @click="selectAll"
        >{{ t('select_all') }}</button>
        <button
          class="rounded bg-transparent px-2 py-1 text-[11px] font-bold text-muted hover:text-brand"
          type="button"
          data-testid="trash-bulk-clear"
          @click="clearChecked"
        >{{ t('clear_selection') }}</button>
      </span>
    </BulkStrip>

    <div class="tn-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-1">
      <!-- 空态换成与会话列表同一块形状：图标 + 粗体标题 + 那句 7 天承诺。
           原来这里是一行 12px 小字，两边"什么都没有"的份量不一样重。 -->
      <ViewEmpty
        v-if="items.length === 0"
        icon="trash"
        :title="t('trash_empty_title')"
        :hint="t('trash_empty')"
      />
      <ul v-else class="m-0 list-none p-0">
      <li
        v-for="item in items"
        :key="item.group.id"
        class="mb-3 rounded-card border border-line bg-panel"
        data-testid="trash-row"
      >
        <!-- 标题行：与 GroupRow 的 header 同一套排布与字号。
             差别只有两处，且都是回收站特有的信息：什么时候删的（时间戳用 deletedAt）、还剩几天。 -->
        <header class="flex items-center gap-2 px-3 py-2">
          <!-- 勾选框与主列表那颗同形同字号（既有约定 把它接上批量动作）。
               既有约定：它是"这一行的全选/全不选"，选了一半时半选 —— 不是另一种选择状态。
               只有把一整行勾满，批量才会按整行处理（写组墓碑与整行标记，既有约定 那两套语义不变）。 -->
          <label class="tn-check flex shrink-0 cursor-pointer items-center" :title="t('bulk_check_row')">
            <input
              v-indeterminate="rowState(item) === 'some'"
              class="accent-brand"
              type="checkbox"
              :checked="rowState(item) === 'all'"
              :aria-label="t('bulk_check_row')"
              :data-testid="`trash-check-${item.group.id}`"
              @change="toggleRow(item.group.id)"
            />
          </label>

          <div
            class="grid h-6 w-6 shrink-0 place-items-center rounded-tight bg-brand-soft text-[11px] leading-none text-brand"
            aria-hidden="true"
          >
            <AppIcon name="folder" :size="13" />
          </div>

          <div class="flex min-w-0 flex-1 items-center gap-2.5">
            <!-- 标题可以被压窄（`min-w-0` + 默认 flex-shrink），右侧那些才钉住宽度。
                 ⚠ 这里原来写着 `shrink-0`：它和 `tn-ellipsis` 是直接矛盾的 —— nowrap 的盒子
                 不让我压，那三行省略号属性就永远不生效，长标题把整行撑破、把「还剩 N 天」和
                 还原/彻底删除挤出卡片外面。判据在 `ui-trash-panel.spec.ts`，与
                 `ui-components.spec.ts` 里 `group-title` 那条成对（两处各写了一份排布）。 -->
            <span
              class="tn-ellipsis min-w-0 text-[13px] leading-none font-extrabold"
              :class="item.group.title ? 'text-ink' : 'text-muted'"
              data-testid="trash-title"
            >{{ item.group.title || t('group_untitled') }}</span>
            <span class="flex shrink-0 items-center gap-1 text-[11px] leading-none text-muted" data-session-stamp>
              <AppIcon name="clock" :size="12" />{{ clockStamp(item.deletedAt) }}
            </span>
          </div>

          <span class="shrink-0 text-[11px] leading-none font-bold text-muted">{{ countLabel(item) }}</span>
          <!-- 来源胶囊用「锁定」那颗的同一种强调：它是信任问题，不是装饰。 -->
          <span
            v-if="allConsumed(item)"
            class="inline-flex shrink-0 items-center rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand"
            data-testid="trash-badge-restored"
          >{{ t('trash_badge_restored') }}</span>
          <span
            class="inline-flex shrink-0 items-center rounded-full bg-chip px-2 py-0.5 text-[10px] text-muted"
            data-testid="trash-days"
          >{{ t('trash_days_left', { days: daysLeft(item.expiresAt) }) }}</span>

          <div class="flex shrink-0 items-center gap-0.5">
            <button
              class="grid h-6 w-6 place-items-center rounded-tight text-muted hover:bg-chip hover:text-ink"
              type="button"
              :title="t('trash_action_restore')"
              :aria-label="t('trash_action_restore')"
              :data-testid="`trash-restore-${item.group.id}`"
              @click="restore(item.group.id)"
            >
              <AppIcon name="restore" />
            </button>
            <button
              class="grid h-6 w-6 place-items-center rounded-tight text-muted hover:bg-chip hover:text-danger"
              type="button"
              :title="t('trash_action_purge')"
              :aria-label="t('trash_action_purge')"
              :data-testid="`trash-purge-${item.group.id}`"
              @click="purge(item.group.id)"
            >
              <AppIcon name="trash" />
            </button>
          </div>
        </header>

        <!-- 展开的标签列表：直接复用主列表那颗 TabRow，所以域名行、favicon 占位、
             右键链接菜单、hover 才出现的行级操作全都一样。 -->
        <div class="border-t border-line px-3 pb-2 pt-1">
          <div
            v-for="tab in shown(item)"
            :key="tab.id"
            data-tab-row
            :data-testid="`trash-record-${tab.id}`"
          >
            <TabRow
              :tab="tab"
              restore-label="trash_action_restore"
              remove-label="trash_action_purge"
              selectable
              :checked="checkedRecords.has(recordKey(item.group.id, tab.id))"
              @restore="restoreRecord(item.group.id, tab.id)"
              @remove="purgeRecord(item.group.id, tab.id)"
              @copy="copyRecord(tab)"
              @toggle-select="toggleRecord(item.group.id, tab.id)"
            />
          </div>

          <button
            v-if="hidden(item) > 0 || expanded.has(item.group.id)"
            class="mt-0.5 w-full rounded bg-transparent px-1.5 py-1.5 text-left text-[10px] font-bold text-brand hover:bg-brand-soft"
            type="button"
            :data-testid="`trash-expand-${item.group.id}`"
            @click="toggle(item.group.id)"
          >
            {{ hidden(item) > 0 ? t('show_remaining', { count: hidden(item) }) : t('collapse') }}
          </button>
        </div>
      </li>
      </ul>

      <!-- 复制/批量操作的反馈那句仍然要说（`role=status`）。原来它下面那两行常驻小字
           （「这里共 N 条记录」与「彻底删除之后无法在本机找回…」）删了：条数搬进标题槽，
           永久删除的警告只在确认条里说一次（既有约定 决定 4，代价记在那份 既有约定 里）。 -->
      <p v-if="message" class="m-0 mt-2 text-[10px] text-muted" role="status" data-testid="trash-message">{{ message }}</p>
    </div>
  </div>
</template>
