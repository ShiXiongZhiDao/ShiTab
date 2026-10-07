<script lang="ts" setup>
/**
 * 标题槽：滚动区**外面**那一行「这一档是什么 + 有多少」。
 *
 * 存在的理由只有一个：会话列表与回收站原来是两边各抄一串类名，抄的那一份会长歪
 * （回收站那屏的标题当初被塞进一层面板壳里，字号还从 10px 变成 11px）。
 * 同形必须是**同一个组件**，不是同一串类名。
 *
 * `count` 的轴恒为**会话数**：列表那侧是 `store.visible.length`，回收站那侧是行数。
 * 传 `undefined` 就不显 —— 搜索态刻意不显（命中的是子集，那个数不是"这一档有多少"）。
 */
const props = defineProps<{ label: string; count?: number }>();
</script>

<template>
  <div class="flex shrink-0 items-baseline gap-2 px-4 pb-1 pt-3" data-testid="view-heading">
    <h2 class="m-0 text-[10px] font-extrabold tracking-widest text-muted">{{ props.label }}</h2>
    <span v-if="props.count !== undefined" class="text-[10px] text-muted" data-testid="view-heading-count">
      {{ props.count }}
    </span>
  </div>
</template>
