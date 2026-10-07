/**
 * 一张卡"摊开到哪一条"的**唯一**算法（既有约定 采纳 1）。
 *
 * 为什么要有这个文件：折叠/展开这套判断在仓库里曾经有**两份**实现
 * （`components/GroupRow.vue` 与 `components/TrashPanel.vue`，后者注释里写着"命名与语义都照主列表"），
 * 分批这件事必须同轮落到两处 —— 只改一处就是"回收站里一次点到底"还留着。
 *
 * ★ 这里的返回值**只许当渲染视图**（`shown`）。勾选判据与"整组动作"的输入永远是整表 `ordered`：
 *   既有约定 补的那一格说的是"行首框说看得见的都勾了、整组动作说整表被勾满了"，
 *   而 `visibleTabIds` 现在传的是 `ordered`（折叠本来就不影响它）。
 *   谁把 `windowLimit(...)` 的返回值拿去当 `visibleTabIds`，
 *   就等于把"勾了整组、删完剩几条"重新引进来 —— 那是数据损失，不是显示问题。
 */

import { COLLAPSED_TAB_LIMIT, TAB_EXPAND_BATCH } from './constants';

/** 摊开 `revealed` 条之后，这张卡现在**渲染**多少条（封顶在整表长度）。 */
export function windowLimit(total: number, revealed: number, collapsed = COLLAPSED_TAB_LIMIT): number {
  return Math.min(Math.max(0, total), collapsed + Math.max(0, revealed));
}

/** 还有多少条没摊出来（0 = 整表都看得见，那颗按钮该换成"收起"）。 */
export function remaining(total: number, revealed: number, collapsed = COLLAPSED_TAB_LIMIT): number {
  return Math.max(0, total - windowLimit(total, revealed, collapsed));
}

/**
 * 点一次"展开其余"之后 `revealed` 的新值：一批 `TAB_EXPAND_BATCH` 条，
 * **不超过剩下的那些**（所以最后一批可能小于 200，`revealed` 正好停在整表上）。
 */
export function revealMore(total: number, revealed: number, collapsed = COLLAPSED_TAB_LIMIT): number {
  return revealed + Math.min(TAB_EXPAND_BATCH, remaining(total, revealed, collapsed));
}

/** 这一点能不能叫"展开"（还能摊 = 按钮该写"展开其余 N 个"；不能摊 = 该写"收起"）。 */
export function canRevealMore(total: number, revealed: number, collapsed = COLLAPSED_TAB_LIMIT): boolean {
  return remaining(total, revealed, collapsed) > 0;
}
