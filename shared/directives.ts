import type { Directive } from 'vue';

/**
 * 半选（indeterminate）只能命令式设 —— 它是 DOM 属性，不是可以 `:indeterminate` 绑的 HTML 属性。
 *
 * 行首框的三态靠它（既有约定 回收站、既有约定 主列表）："这一行选了一半"没有别的形状能说清楚，
 * 而勾选状态本身只剩记录级一份（`checkedRecords`），行首框是它的派生视图。
 * 用指令而不是给每行挂 ref：行数不定，挂 ref 就得自己管一张 `Map<id, Element>` 的生命周期。
 */
export const vIndeterminate: Directive<HTMLInputElement, boolean> = {
  mounted: (el, binding) => {
    el.indeterminate = binding.value;
  },
  updated: (el, binding) => {
    el.indeterminate = binding.value;
  },
};
