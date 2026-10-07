<script lang="ts" setup>
/**
 * 一颗开关。
 *
 * 它存在的理由：**同一件事在仓库里有两份实现**。设置页那 6 项是 `<input type="checkbox">` + 一句文字，
 * 而 SyncPanel 摘要行那颗是手画的 `<button role="switch">`（SyncPanel.vue:333-336）。
 * 两份各画各的轨道尺寸（19×34 与 20×36），改一处必然漏另一处 —— 所以收在这里。
 *
 * 内核为什么是 `button[role=switch]` 而不是原生 checkbox（**这一条推翻了我自己在原型说明里写的话**，
 * 我当时写的是"内核仍是原生 input[type=checkbox] ⇒ 键盘与读屏免费"）：
 * 落地前查到 `test/ui-sync-panel.spec.ts` 里有两条守卫，
 * 一条断未配置态 `findAll('input[type="checkbox"]') === 0`（第 164 行），
 * 一条断已连接摘要态 `findAll('input') === 0`（第 325 行）。
 * 后者正是 既有约定 那次"把两颗勾选从同步面板里拿掉"的守门人 ——
 * 换成原生 checkbox 就等于把一个 checkbox 放回那块被明确禁止放的地方，
 * 要么弄红那条用例，要么改掉它的判据。而 `button[role=switch]` + `aria-checked`
 * 本来就是合法且已在生产里跑的形态：键盘（Tab 聚焦、Enter/Space 切换）与读屏播报都不缺。
 *
 * 无障碍名走 `aria-label`：行布局里标题在开关**左边**、不是包着开关，
 * 所以名字必须显式给。传的就是屏幕上那四个字 —— 可见文字与无障碍名一致，
 * 语音输入的人念得出标题就点得动（不一致才是坑）。
 */
withDefaults(
  defineProps<{
    /** 现在的开/关。 */
    checked: boolean;
    /** 无障碍名。传屏幕上可见的那句标题，别另编一套。 */
    label: string;
    /** 开关右边再显示一遍的文字（SyncPanel 摘要行那种「同步」）。不传就只有开关。 */
    text?: string;
    disabled?: boolean;
    testId?: string;
  }>(),
  { disabled: false },
);

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <!--
    内边距 p-1 是给点击区垫大的：轨道本身 36×20，加上内边距 44×28。
    刻意不用 `disabled:` 之外的透明度变化 —— 禁用态由**整行**降透明来表达（见 options/App.vue 的 .srow），
    开关自己再降一次会叠成 0.16，读起来像坏了而不是禁用。
  -->
  <button
    :aria-checked="checked ? 'true' : 'false'"
    :aria-label="label"
    :class="disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'"
    :data-testid="testId"
    :disabled="disabled"
    class="flex items-center gap-2 rounded-full bg-transparent p-1 outline-none"
    role="switch"
    type="button"
    @click="emit('toggle')"
  >
    <span
      aria-hidden="true"
      class="h-[20px] w-[36px] shrink-0 rounded-full p-[2.5px] transition-colors"
      :class="checked ? 'bg-brand' : 'bg-line-strong'"
    >
      <span
        class="block h-[15px] w-[15px] rounded-full bg-panel transition-transform"
        :class="checked ? 'translate-x-[16px]' : ''"
      />
    </span>
    <span v-if="text" class="text-[11px] text-muted">{{ text }}</span>
  </button>
</template>
