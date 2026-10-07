/**
 * `shared/tab-window.ts` 的算术（既有约定 采纳 1：单组几千条时改成分批摊开）。
 *
 * 这一层只管**渲染多少行**。勾选判据不吃它 —— 那条在 `test/ui-components.spec.ts` 里
 * 用一次真点击钉住（行首框勾的是整表 `ordered`，不是已摊开的那一批）。
 * 两处用它的组件（主列表 `GroupRow` 与回收站 `TrashPanel`）各有一条点击用例，
 * 因为这份判断曾经是**两份实现**（同一逻辑有两份实现就要各钉一次）。
 */

import { describe, expect, it } from 'vitest';
import { COLLAPSED_TAB_LIMIT, TAB_EXPAND_BATCH } from '@/shared/constants';
import { canRevealMore, remaining, revealMore, windowLimit } from '@/shared/tab-window';

describe('分批展开的算术', () => {
  it('折叠态就是前 COLLAPSED_TAB_LIMIT 条，30 条以下的会话一行都不藏', () => {
    expect(windowLimit(8, 0)).toBe(8);
    expect(windowLimit(30, 0)).toBe(30);
    expect(windowLimit(31, 0)).toBe(COLLAPSED_TAB_LIMIT);
    expect(remaining(31, 0)).toBe(1);
  });

  it('点一次加一批；最后一批不足一批时正好停在整表上', () => {
    expect(revealMore(300, 0)).toBe(TAB_EXPAND_BATCH);
    expect(windowLimit(300, revealMore(300, 0))).toBe(COLLAPSED_TAB_LIMIT + TAB_EXPAND_BATCH);
    const afterSecond = revealMore(300, revealMore(300, 0));
    expect(afterSecond, '300 - 230 = 70，第二批只有 70 条').toBe(270);
    expect(windowLimit(300, afterSecond)).toBe(300);
    expect(canRevealMore(300, afterSecond), '摊到底就不许再多点一次').toBe(false);
  });

  it('整表不超过折叠线时点一次也抬不动 revealed（那颗按钮本来就不该出现）', () => {
    expect(revealMore(12, 0)).toBe(0);
    expect(canRevealMore(12, 0)).toBe(false);
  });

  it('3,000 条那一档要点 15 次才摊完（旧形状是一次点到底，实测 63,127 个元素节点）', () => {
    let revealed = 0;
    let clicks = 0;
    while (canRevealMore(3_000, revealed)) {
      revealed = revealMore(3_000, revealed);
      clicks += 1;
    }
    expect(clicks).toBe(15);
    expect(windowLimit(3_000, revealed)).toBe(3_000);
  });
});
