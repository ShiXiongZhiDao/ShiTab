<script lang="ts" setup>
/**
 * 空态块：居中的图标 + 粗体标题 + 一句提示（+ 可选的一颗按钮）。
 *
 * 两边共用它的理由不是省那 15 行模板，是**份量要对等**：
 * 会话列表空的时候是一整块居中的东西，回收站空的时候原来只有一行 12px 小字 ——
 * 同一个产品里"什么都没有"不该一边像正常状态、一边像页面没加载出来。
 */
import AppIcon from '@/components/AppIcon.vue';

/** 只有这两处在用，所以写成联合而不是 `string`：图标名打错编译就红。 */
const props = defineProps<{ icon: 'inbox' | 'trash'; title: string; hint: string }>();
</script>

<template>
  <div class="mt-10 px-4 text-center" data-testid="view-empty">
    <div
      class="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-card bg-brand-soft text-brand"
      aria-hidden="true"
    >
      <AppIcon :name="props.icon" :size="22" />
    </div>
    <h3 class="m-0 text-[13px] font-bold">{{ props.title }}</h3>
    <p class="mt-1.5 text-[11px] leading-relaxed text-muted">{{ props.hint }}</p>
    <slot />
  </div>
</template>
