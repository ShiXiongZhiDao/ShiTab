/**
 * 界面偏好的规范化。
 *
 * 放在 core/domain 而不是写在组件里，是因为同一个数有三个地方要用、而且必须给同一个答案：
 * 存储适配器读出来要夹一次（库里可能有手改过的 9999）、拖拽时要夹一次（指针能跑到屏幕外）、
 * 渲染时 CSS 还要再兜一道（窗口被拖窄之后 40% 变了）。
 * 散成三份就会漂移，所以口径收在这一处。
 */

import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
  RAIL_WIDTH_VIEWPORT_RATIO,
} from '@/shared/constants';
import type { UiPrefs } from '@/shared/types';

export const DEFAULT_UI_PREFS: UiPrefs = { railWidth: RAIL_WIDTH_DEFAULT };

/**
 * 宽度上限：静态的 420 与"窗口宽度的 40%"取小。
 *
 * `viewportWidth` 拿不到（0 / NaN / service worker 里没有 window）时退回静态上限，
 * 而不是算出 0 —— 那会让侧栏缩成一条线，看起来像功能坏了。
 */
export function railWidthCeiling(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return RAIL_WIDTH_MAX;
  return Math.max(RAIL_WIDTH_MIN, Math.min(RAIL_WIDTH_MAX, Math.floor(viewportWidth * RAIL_WIDTH_VIEWPORT_RATIO)));
}

/**
 * 单个宽度的规范化：整数、落在 [min, ceiling]。非数字一律回默认值。
 *
 * `Math.round` 而不是 `floor`：指针坐标带小数（高分屏 devicePixelRatio 缩放后必然是小数），
 * 而写进存储的应该是一个能原样读回来的整数。
 */
export function clampRailWidth(value: unknown, viewportWidth: number): number {
  const ceiling = railWidthCeiling(viewportWidth);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Math.min(Math.max(RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN), ceiling);
  }
  return Math.min(Math.max(Math.round(value), RAIL_WIDTH_MIN), ceiling);
}

/**
 * 读回来的整块偏好的规范化。
 *
 * 与 `mergeSettings`（core/domain/settings.ts）同一套哲学：**只认自己知道的键**，
 * 所以库里多出来的东西被自然丢弃，缺的键补默认值。备份导入与存储读取走的都是它。
 *
 * 这里用静态上限（不传 viewportWidth）：存储适配器不能在 service worker 里读 `window`。
 * 渲染前 useRailWidth 会再按当前窗口夹一次，所以"存 420、窗口只有 700px 宽"这种情况
 * 存的是 420、显示的是 280，CSS 的 max-w 保证最后一道防线。
 */
export function mergeUiPrefs(raw: unknown): UiPrefs {
  const value = (raw ?? {}) as Partial<UiPrefs>;
  return { railWidth: clampRailWidth(value.railWidth, 0) };
}
