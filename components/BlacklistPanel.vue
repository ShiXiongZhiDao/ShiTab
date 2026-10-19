<script lang="ts" setup>
/**
 * 收纳黑名单。
 *
 * 形状：**预设勾选 + 自由添加 + 补全后回显 + 硬底说明**。
 *
 * 三件事值得写下来，因为它们都不是"顺手"：
 *
 * 1. **回显是必须的，不是润色。** `normalizePrefix` 在**猜**（`localhost:3000` 该补 http 还是
 *    https、`mail.google.com` 到底是不是个主机名）。猜错的那条会永远命不到任何 URL，
 *    而界面上显示"已添加" —— 那是最典型的静默失败。所以归一化结果必须摆在用户眼前，
 *    让他当场看得见"我填的是这个、它理解成了那个"。
 * 2. **取消勾选默认项要给警告。** 默认表里的那些（内部页 / Web Store）取消之后会出现
 *    "收进来了但点不动"的记录 —— 那是用户自己签的字，但得先让他看见代价。
 *    ⚠ 反过来，**硬底那两项不给勾选框**：给一个点不动的勾选框比不给更糟。
 * 3. **只 emit 新数组，不自己写存储。** 与 SyncPanel / SnapshotHistoryPanel 同形：
 *    落盘在 `App.vue` 的 `patch()` 一处，这里不碰端口。
 * 4. **默认折叠。** 12 项预设铺开有半屏高，而它管的是"进阶排除规则" —— 大多数用户
 *    一辈子不会碰它，铺在「常规」分区里只会把上面那三个开关挤到看不见的地方。
 *    要改的人点一下展开，与 SyncPanel 那张表单（`sync_expand` / `sync_collapse`）同形。
 *    ⚠ 折叠时预设列表**不进 DOM**，不是"渲染了藏起来" —— 折叠态连 checkbox 都不该有，
 *    否则 Tab 焦点会摸到一堆看不见的控件。
 */
import { computed, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { activeLocale, t } from '@/shared/i18n';
import {
  DEFAULT_BLOCKED_PREFIXES,
  PRESET_PREFIXES,
  normalizePrefix,
} from '@/core/domain/blocked-prefixes';

const props = defineProps<{ prefixes: readonly string[] }>();
const emit = defineEmits<{ change: [string[]] }>();

useLocale();

/** 默认折叠，理由见文件头第 4 条。 */
const expanded = ref(false);

const draft = ref('');

/** 归一化结果 —— 猜的那一步要摆给用户看，所以它是 computed 而不是添加时才算。 */
const normalized = computed(() => normalizePrefix(draft.value));
const draftEcho = computed(() =>
  normalized.value === null ? null : t('options_blacklist_echo', { prefix: normalized.value }),
);
/** 认不出来：要么这一格是空的（还没填，不算错），要么是真填错了。 */
const draftInvalid = computed(() => draft.value.trim() !== '' && normalized.value === null);
const draftDuplicate = computed(() =>
  normalized.value !== null && props.prefixes.includes(normalized.value),
);

const customs = computed(() =>
  props.prefixes.filter((prefix) => !(PRESET_PREFIXES as readonly string[]).includes(prefix)),
);

/**
 * 当前**没勾上**的默认项 —— 它们会被照收。
 *
 * 顶部那句摘要就是为它存在的（2026-10-19 用户实测踩过这个坑）：列表标题是「这些不收纳」，
 * 勾选框取消 = 从"不收纳"里移出 = 从此照收。这个双重否定光靠一句 hint 兜不住，
 * 必须把**当前状态**摆在面板最上面，折叠态也看得见。
 */
const unblockedDefaults = computed(() =>
  DEFAULT_BLOCKED_PREFIXES.filter((prefix) => !props.prefixes.includes(prefix)),
);

/** 摘要里的列表：分隔符跟着语言走（中文顿号、英文逗号）。 */
const unblockedList = computed(() =>
  unblockedDefaults.value.join(activeLocale.value === 'zh_CN' ? '、' : ', '),
);

/** 取消勾选这一项要不要警告：默认表里那些取消之后会产出"点了没反应"的记录。 */
const warnsWhenUnchecked = (prefix: string): boolean =>
  (DEFAULT_BLOCKED_PREFIXES as readonly string[]).includes(prefix);

const isChecked = (prefix: string): boolean => props.prefixes.includes(prefix);

function commit(next: string[]): void {
  emit('change', next);
}

function toggle(prefix: string, checked: boolean): void {
  const set = new Set(props.prefixes);
  if (checked) set.add(prefix);
  else set.delete(prefix);
  commit([...set]);
}

function add(): void {
  const prefix = normalized.value;
  if (prefix === null || props.prefixes.includes(prefix)) return;
  commit([...props.prefixes, prefix]);
  draft.value = '';
}

function remove(prefix: string): void {
  commit(props.prefixes.filter((item) => item !== prefix));
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <p class="m-0 text-[11px] leading-relaxed text-muted">{{ t('options_blacklist_hint') }}</p>

    <!-- ★ 当前状态摘要：折叠态也看得见。
         有默认项被取消勾选时整句转成警示色 —— 这是"从此会被收进会话并关掉"的唯一常驻提示，
         不能只在取消那一刻闪一下（用户可能是上次会话里取消的，早忘了）。 -->
    <p
      class="m-0 text-[11px] leading-relaxed"
      :class="unblockedDefaults.length > 0 ? 'text-warn' : 'text-muted'"
      data-testid="blacklist-summary"
    >{{ unblockedDefaults.length === 0
      ? t('options_blacklist_summary', { count: prefixes.length })
      : t('options_blacklist_summary_unblocked', { count: prefixes.length, list: unblockedList }) }}</p>

    <!-- 折叠态（默认）：只留一颗展开按钮，预设列表不进 DOM -->
    <button
      v-if="!expanded"
      class="block bg-transparent p-0 text-[11px] text-muted underline"
      type="button"
      data-testid="blacklist-expand"
      @click="expanded = true"
    >{{ t('options_blacklist_expand') }}</button>

    <template v-else>
      <ul class="m-0 list-none p-0">
        <li v-for="prefix in PRESET_PREFIXES" :key="prefix" class="py-1">
          <label class="flex items-start gap-2.5">
            <input
              :checked="isChecked(prefix)"
              class="mt-0.5 accent-brand"
              type="checkbox"
              :data-testid="`blacklist-preset-${prefix}`"
              @change="toggle(prefix, ($event.target as HTMLInputElement).checked)"
            />
            <span class="min-w-0">
              <span class="block break-all font-mono text-[12px] leading-snug">{{ prefix }}</span>
              <span
                v-if="!isChecked(prefix) && warnsWhenUnchecked(prefix)"
                class="mt-0.5 block text-[11px] leading-snug text-warn"
                data-testid="blacklist-unblock-warning"
              >{{ t('options_blacklist_unblock_warning') }}</span>
            </span>
          </label>
        </li>
      </ul>

      <!-- 用户自己加的那些：预设里没有，所以单独一栏，带删除 -->
      <ul v-if="customs.length > 0" class="m-0 list-none border-t border-line p-0 pt-2.5">
        <li v-for="prefix in customs" :key="prefix" class="flex items-center justify-between gap-3 py-1">
          <span class="min-w-0 break-all font-mono text-[12px]">{{ prefix }}</span>
          <button
            class="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:border-line-strong hover:text-ink"
            type="button"
            :data-testid="`blacklist-remove-${prefix}`"
            :aria-label="t('options_blacklist_remove')"
            @click="remove(prefix)"
          >{{ t('options_blacklist_remove') }}</button>
        </li>
      </ul>

      <div class="flex items-center gap-2 border-t border-line pt-2.5">
        <input
          v-model="draft"
          class="min-w-0 flex-1 rounded-md border border-line bg-panel px-2.5 py-1.5 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-muted"
          type="text"
          data-testid="blacklist-draft"
          :placeholder="t('options_blacklist_add_placeholder')"
          @keyup.enter="add()"
        />
        <button
          class="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink disabled:opacity-50"
          type="button"
          data-testid="blacklist-add"
          :disabled="normalized === null || draftDuplicate"
          @click="add()"
        >{{ t('options_blacklist_add') }}</button>
      </div>

      <!-- ★ 回显：猜的那一步必须看得见。
           顺序有讲究 —— **重复**排在回显前面：已经在列表里的时候，"已经加了"比"会按什么匹配"
           更该先说（两者同时成立，把回显放前面会让"重复"那一格永远不显示）。 -->
      <p
        v-if="draftDuplicate"
        class="m-0 text-[11px] leading-snug text-muted"
        data-testid="blacklist-duplicate"
      >{{ t('options_blacklist_duplicate') }}</p>
      <p
        v-else-if="draftEcho"
        class="m-0 font-mono text-[11px] leading-snug text-muted"
        data-testid="blacklist-echo"
      >{{ draftEcho }}</p>
      <p
        v-else-if="draftInvalid"
        class="m-0 text-[11px] leading-snug text-danger"
        data-testid="blacklist-invalid"
      >{{ t('options_blacklist_invalid') }}</p>

      <p class="m-0 text-[11px] leading-relaxed text-muted">{{ t('options_blacklist_floor_note') }}</p>

      <button
        class="block bg-transparent p-0 text-[11px] text-muted underline"
        type="button"
        data-testid="blacklist-collapse"
        @click="expanded = false"
      >{{ t('options_blacklist_collapse') }}</button>
    </template>
  </div>
</template>
