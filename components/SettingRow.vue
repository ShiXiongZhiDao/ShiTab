<script lang="ts" setup>
/**
 * 设置页的一行：标题 + 可选副标题在左，控件在右。
 *
 * 为什么要抽出来：这一页会一直长（这次就从 3 行长成 6 行），而"禁用"这件事必须每次长得一样 ——
 * 整行降到半透明、副标题换成"为什么现在点不动"。散在模板里写必然出现某一行只改了透明度、
 * 另一行只改了副标题。
 *
 * 注意 `disabled` **只负责看起来禁用**。真正不让点的是调用方传给控件的 `:disabled`
 * （`SettingSwitch` 会把原生 `disabled` 挂到 `<button>` 上）—— 这里不重复拦一遍，
 * 免得两处判断哪天不一致。
 */
withDefaults(
  defineProps<{
    /** 屏幕上可见的那句标题。同一个字符串也要传给控件当无障碍名，两边必须一致。 */
    title: string;
    hint?: string;
    /** 禁用态：整行降透明。副标题由调用方换成原因。 */
    disabled?: boolean;
  }>(),
  { disabled: false },
);
</script>

<template>
  <div
    class="flex items-start justify-between gap-4 border-b border-line py-2.5 last:border-b-0"
    :class="disabled ? 'opacity-50' : ''"
  >
    <div class="min-w-0">
      <p class="m-0 text-[12.5px] leading-snug">{{ title }}</p>
      <p v-if="hint" class="m-0 mt-1 text-[11px] leading-snug text-muted">{{ hint }}</p>
    </div>
    <div class="flex shrink-0 items-center pt-0.5">
      <slot />
    </div>
  </div>
</template>
