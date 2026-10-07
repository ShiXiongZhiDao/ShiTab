<script lang="ts" setup>
/**
 * 通栏批量条的**外壳**：一条贴着 pane 宽度、不随内容滚的条。
 *
 * 只收敛载体，不收敛内容 —— 两屏的按钮与文案本来就该不同（列表是「恢复所选 / 删除所选」，
 * 回收站是「还原所选 / 彻底删除所选」+ 全选/清空），勾选状态也是两份
 * （既有约定 那条隔离一个字没动：共用会把回收站勾的行变成主列表那颗**真删除**的目标）。
 *
 * ★ 它必须是滚动区的**兄弟**而不是里面的第一块内容，否则一滚就跑掉了。
 * `flex-wrap` 是两边一起收的：回收站那条按钮更多，窄窗口下原来就会折。
 */
</script>

<template>
  <div
    class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-brand-soft px-4 py-2"
    data-bulk-strip=""
    data-testid="bulk-strip"
  >
    <slot />
  </div>
</template>
