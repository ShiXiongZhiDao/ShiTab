<script lang="ts" setup>
/**
 * 分区的标题行（既有约定 的补格）。
 *
 * 为什么要有这一颗：五个分区的标题原来是各自在模板里手写一遍 `<h2 class="…16px…">` +
 * 一句副标题。结果「同步」分区就漏了 —— 它里面两块面板自带 11px 大写的 eyebrow
 * （「WEBDAV 同步」「远端历史」），我据此判断"再加分区标题就是三行同义"，
 * 但那是错的：**11px 灰字 eyebrow 和 16px 粗体分区标题不是一个视觉层级**，
 * 用户读到的是"这一页没有标题，其他页都有"（2026-10-06 他两张截图对比出来的）。
 *
 * 收成一颗之后，"每个分区都有标题"是结构上成立的，不是靠人每次记得写。
 * 用例 `test/ui-options.spec.ts` 里那条"五个分区都有 `pane-title`"钉的是这件事。
 */
defineProps<{
  /** 分区名，与左栏导航那颗用的是同一个文案 key。 */
  title: string;
  /** 可选的一句副标题。 */
  sub?: string;
}>();
</script>

<template>
  <h2 class="m-0 mt-0.5 mb-1 text-[16px] font-extrabold tracking-tight" data-testid="pane-title">{{ title }}</h2>
  <p v-if="sub" class="m-0 mb-4 text-[11.5px] leading-relaxed text-muted">{{ sub }}</p>
</template>
