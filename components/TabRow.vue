<script lang="ts" setup>
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import type { SavedTab } from '@/shared/types';
import { initialsOf } from '@/shared/utils';
import { t, type MessageKey } from '@/shared/i18n';

/**
 * 右栏里的一条已保存标签页。
 *
 * 行级操作默认收起，**hover 或键盘聚焦时出现**：既保住截图那种干净的列表观感，
 * 又不至于让键盘用户根本找不到按钮（`group-hover` + `focus-within` 两条都开）。
 * 会话被锁定时整行的写操作都不出现。
 */
const props = defineProps<{
  tab: SavedTab;
  /** 会话锁定中：隐藏"从会话里删除"，但复制与还原照给（它们不改数据） */
  locked?: boolean;
  /** 组内重排的可拖拽把手（锁定或搜索态下父层会关掉） */
  draggable?: boolean;
  /**
   * 两个动作的文案 key，可覆盖。
   *
   * 存在的理由不是"想换个词"：回收站复用同一行形状，但那里那颗叉的语义是
   * **彻底删除这一条**，不是"从会话里移除"。沿用主列表的文案会当场说错话 ——
   * 用户以为还能撤销，实际是永久删。默认值就是主列表现在用的那两把 key。
   */
  restoreLabel?: MessageKey;
  removeLabel?: MessageKey;
  /**
   * 行内多选（既有约定，回收站用）。**默认关**——主列表的记录行不给勾选框，
   * 那边"多选"的粒度是标签组（GroupRow 的 header 那颗），这里给了就是把两套语义混进同一颗组件。
   */
  selectable?: boolean;
  checked?: boolean;
}>();

const emit = defineEmits<{
  restore: [];
  remove: [];
  copy: [];
  dragstart: [event: DragEvent];
  toggleSelect: [];
}>();

// favicon 能不能直接 <img> 远程地址取决于 MV3 的 CSP（既有约定 未验证项）。
// 这里两种答案都不怕：加载失败就退回首字母占位，形状与原型一致。
const failed = ref(false);
const showImage = computed(() => Boolean(props.tab.faviconUrl) && !failed.value);
const letter = computed(() =>
  initialsOf(props.tab.title || props.tab.domain || props.tab.url),
);
const title = computed(() => props.tab.title || props.tab.url);

/**
 * 只有 http(s) 才渲染成真正的 `<a>`（真机第六轮："右键要图二那种链接菜单"）。
 *
 * 浏览器给链接的右键菜单（在新标签页/新窗口/拆分视图/隐身窗口中打开链接、复制链接地址）
 * **只有元素本身就是 `<a href>` 时才会出现** —— 用 button 冒充标题，右键拿到的就是
 * 页面级菜单（返回/前进/打印/检查），那是我们给不了的。
 * 而 `chrome://` 这类内部页做成链接没有意义：浏览器根本不允许从链接打开它，
 * 给了 `<a>` 反而是在承诺一个做不到的菜单。
 */
const linkUrl = computed(() => (/^https?:/i.test(props.tab.url) ? props.tab.url : undefined));

/** 左键仍然是"我们的恢复"（会走 background、按设置去重）；preventDefault 关掉链接的默认跳转。 */
function onActivate(event: MouseEvent): void {
  event.preventDefault();
  emit('restore');
}
</script>

<template>
  <div
    class="group/row flex items-center gap-2 rounded-row px-1.5 py-1.5 hover:bg-chip focus-within:bg-chip"
    :draggable="draggable === true"
    @dragstart="emit('dragstart', $event)"
  >
    <!--
      行内勾选框（既有约定，只有回收站会传 `selectable`）。
      与主列表那颗同形同字号，但**始终可见**（不像行级动作那样 hover 才出现）——
      勾它是批量操作的入口，藏起来就等于没有。
      既有约定：它**永远能点**。上一轮给它加过一个"整行已选时灰掉"的状态，
      表现成"组里的标签选不了"，他当场问是不是 bug —— 层级关系交给行首框那根半选横杠去说，
      不要把可用的控件锁住。
    -->
    <label v-if="selectable" class="tn-check flex shrink-0 cursor-pointer items-center" :title="t('bulk_select_record')">
      <input
        class="accent-brand"
        type="checkbox"
        :checked="checked === true"
        :aria-label="t('bulk_select_record')"
        :data-testid="`record-check-${tab.id}`"
        @change="emit('toggleSelect')"
      />
    </label>

    <div
      class="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] bg-chip text-[10px] font-bold text-muted"
      aria-hidden="true"
    >
      <img
        v-if="showImage"
        :src="tab.faviconUrl"
        :alt="''"
        loading="lazy"
        class="h-[18px] w-[18px] rounded-[5px]"
        @error="failed = true"
      />
      <!-- `loading="lazy"`：首屏最多 600 行（实测 既有约定 基线一节），一行一颗 favicon 就是 600 次图片请求
           —— 屏外那些根本不该发。既有约定 决定 7。
           ⚠ 懒加载不改变失败语义：图进不了视口就一直不 load，进了视口取不到照样触发 `@error` ⇒
           上面那套"退回首字母"的防御仍然成立（配了用例钉住，不许只靠这句注释）。 -->
      <span v-else>{{ letter }}</span>
    </div>

    <!-- draggable=false：不让浏览器把这里变成"拖一个链接出去"，
         内部的重排/跨会话移动靠父层那套 DnD（shared/dnd.ts）。 -->
    <component
      :is="linkUrl ? 'a' : 'button'"
      class="min-w-0 flex-1 cursor-pointer bg-transparent px-0 py-0 text-left"
      :href="linkUrl"
      :draggable="false"
      :title="linkUrl ? undefined : tab.url"
      @click="onActivate"
    >
      <span class="tn-ellipsis block text-[11px] leading-tight text-ink">{{ title }}</span>
      <span class="tn-ellipsis mt-0.5 block text-[9px] text-muted">
        <span v-if="tab.domain">{{ tab.domain }}</span>
        <span v-else class="uppercase">{{ tab.url.split(':')[0] }}</span>
        <span v-if="tab.closeState === 'kept'" class="ml-1">· {{ t('tab_kept_open') }}</span>
      </span>
    </component>

    <!-- 不可恢复时给原因而不是给一个点下去没反应的按钮。
         ⚠ 既有约定 之后**新收纳不会再有这种行**（不可恢复的页面根本不进会话），这一格因此只服务
         老会话 / 老备份 / 老同步载荷 —— 不要把它当死代码删掉，删了等于把老数据读成"能恢复"。
         用例见 test/ui-components.spec.ts 的「不可恢复的记录给原因」那两条，它们钉的就是这件事。 -->
    <span
      v-if="!tab.restorable"
      class="shrink-0 rounded-full bg-warn-soft px-1.5 py-0.5 text-[9px] font-bold text-warn"
      :title="t('tab_not_restorable')"
    >
      {{ t('tab_not_restorable') }}
    </span>
    <template v-else>
      <button
        class="tn-row-action shrink-0 rounded bg-transparent px-1 py-1 text-[10px] font-extrabold text-brand hover:bg-brand-soft"
        type="button"
        :title="t(restoreLabel ?? 'tab_restore')"
        @click="emit('restore')"
      >
        {{ t(restoreLabel ?? 'tab_restore') }}
      </button>
    </template>

    <button
      class="tn-row-action shrink-0 rounded bg-transparent p-1 text-[10px] text-muted hover:text-ink"
      type="button"
      :aria-label="t('copy_tab_action')"
      :title="t('copy_tab_action')"
      @click="emit('copy')"
    >
      <AppIcon name="copy" :size="13" />
    </button>

    <button
      v-if="!locked"
      class="tn-row-action shrink-0 rounded bg-transparent p-1 text-[10px] text-muted hover:text-danger"
      type="button"
      :aria-label="t(removeLabel ?? 'tab_delete')"
      :title="t(removeLabel ?? 'tab_delete')"
      @click="emit('remove')"
    >
      <AppIcon name="close" :size="13" />
    </button>
  </div>
</template>

<style scoped>
/* 行级操作默认透明，hover / 键盘聚焦时出现。用 opacity 而不是 display，
   这样按钮宽度一直占位，出现时整行不会抖。 */
.tn-row-action {
  opacity: 0;
  transition: opacity 0.12s ease;
}
.group\/row:hover .tn-row-action,
.group\/row:focus-within .tn-row-action {
  opacity: 1;
}
</style>
