<script lang="ts" setup>
/**
 * 会发请求的按钮。
 *
 * 它存在的理由只有一条：**一次网络动作必须有看得见的进行中状态**。
 * 真机反馈的原话是"点了没反应"—— 2–8 秒的 WebDAV 往返，屏幕上既没有转圈也没有换文案，
 * 用户只能反复点（然后拿到两份重复请求）或者以为坏了。
 *
 * 顺手收掉另一条同类缺陷：`disabled` 的按钮以前在几个面板里**没有任何禁用样式**
 * （`TrashPanel` / `ConflictPanel` / `SnapshotHistoryPanel` 的 `disabled:` 计数是 0），
 * 禁用与可用长得一模一样 —— 这正是第一轮真机反馈骂过的形状，散在四个组件里必然漏改，
 * 所以收进这一处。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 平时显示的文案（已经翻好语言的字符串，不是 key）。 */
    label: string;
    /** 进行中显示的文案。不给就沿用 `label`，靠转圈表达 —— 但换文案更明确，调用方一般该给。 */
    busyLabel?: string;
    /** **只有这一颗**在跑的时候才转圈。别的动作在跑时用 `disabled` 表达。 */
    busy?: boolean;
    /** 额外禁用（例如"没勾确认不许清理"）。 */
    disabled?: boolean;
    /**
     * `danger` 是 2026-10-08 加的第三档：破坏性动作的那一颗要长得像它自己
     * （`GroupRow.vue` 删会话的确认条用的是 `bg-danger`，那处是散在组件里的字面 class，
     * 这里收进 tone，免得下一个确认条又抄一遍还抄歪）。
     */
    tone?: 'primary' | 'ghost' | 'danger';
    /** 尺寸档：面板主按钮与行内小按钮的字级/内边距不同，这里收三档而不是让调用方抄 class。 */
    size?: 'md' | 'sm';
    testId?: string;
  }>(),
  { busy: false, disabled: false, tone: 'ghost', size: 'md' },
);

const emit = defineEmits<{ click: [] }>();

const classes = computed(() => [
  'inline-flex items-center justify-center gap-1.5 rounded-control font-bold transition-opacity',
  props.size === 'sm' ? 'px-2.5 py-1 text-[10px]' : 'px-3.5 py-2 text-[11px]',
  props.tone === 'primary'
    ? 'bg-brand text-brand-contrast'
    : props.tone === 'danger'
      ? 'bg-danger text-white'
      : 'border border-line bg-panel text-ink',
  // 禁用态一律可见：这是这个组件存在的第二理由
  'disabled:cursor-not-allowed disabled:opacity-40',
]);
</script>

<template>
  <button
    :aria-busy="busy ? 'true' : 'false'"
    :class="classes"
    :data-testid="testId"
    :disabled="disabled || busy"
    type="button"
    @click="emit('click')"
  >
    <!-- 转圈 + 换文案双通道：色盲/关动画/读屏任一条下都还得看得出"正在做事" -->
    <span v-if="busy" aria-hidden="true" class="tn-spinner" data-testid="action-spinner" />
    <span>{{ busy && busyLabel ? busyLabel : label }}</span>
  </button>
</template>
