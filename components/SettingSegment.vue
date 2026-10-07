<script lang="ts" setup>
/**
 * 两三选一的分段控件。
 *
 * 换掉原来的 `<select>` 的理由：主题和语言都只有 3 个固定选项，藏进下拉里要多一次点击才能改，
 * 而且**当前值看不见**。摊成三段之后一眼能看见"现在是哪个"，改一次只要一下。
 *
 * 为什么是 `role="group"` + 按钮 + `aria-pressed`，而不是 `role="radiogroup"` + `role="radio"`：
 * 后者要求实现方向键在选项间移动焦点，那是另一件事、另一次测试。现在这个形态里
 * Tab 走到每颗按钮、Enter/Space 按下即选中，读屏逐颗播报"已按下/未按下" —— 不缺信息，
 * 只是不省按键。哪天要上 radiogroup，改这一个组件就够了，调用方不用动。
 */
export type SegmentOption = { value: string; label: string };

const props = defineProps<{
  options: readonly SegmentOption[];
  modelValue: string;
  /** 这组按钮叫什么（读屏进组时的那句说明）。 */
  label: string;
  testId?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [string] }>();
</script>

<template>
  <div
    :aria-label="props.label"
    :data-testid="props.testId"
    class="inline-flex gap-0.5 rounded-control border border-line bg-chip p-0.5"
    role="group"
  >
    <button
      v-for="option in props.options"
      :key="option.value"
      :aria-pressed="option.value === props.modelValue ? 'true' : 'false'"
      :class="option.value === props.modelValue ? 'bg-panel font-extrabold text-ink' : 'text-muted hover:text-ink'"
      :data-value="option.value"
      class="rounded-tight border-0 bg-transparent px-2.5 py-1.5 text-[11.5px] font-semibold transition-colors"
      type="button"
      @click="emit('update:modelValue', option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
