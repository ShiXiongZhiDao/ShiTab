import { computed, onScopeDispose, ref } from 'vue';
import { RAIL_WIDTH_DEFAULT } from '@/shared/constants';
import { DEFAULT_UI_PREFS, clampRailWidth, railWidthCeiling } from '@/core/domain/ui-prefs';
import { storagePort } from '@/shared/services';

/**
 * 左栏宽度。
 *
 * 两条设计约束决定了它的形状，都不是"随手这么写"：
 *
 * 1. **拖拽过程中不碰布局**。`width` 只在松手那一刻变，指针移动只更新 `preview`，
 *    而 `preview` 画的是一根 `position: fixed` 的幽灵线。原因是这个页面的成本结构：
 *    右栏平铺几十个会话卡片、上千个元素节点，改一次 `<aside>` 宽度 = 整棵树的
 *    重新布局与重绘；把它绑在 pointermove 上就是一帧一次全页 reflow。
 * 2. **它是偏好，不是数据**。存单独一个键、不进备份，所以读写都绕开 Settings，
 *    改宽度不会让 watchSettings 的 surface 抖动（理由见 core/domain/ui-prefs.ts）。
 *
 * 与 useTheme 同构：真相在 storage 里，这里把它投影到 DOM，并跟着别的窗口改。
 */

/** service worker 里没有 window；返回 0 让上层用静态上限，而不是算出个 0 宽度。 */
function viewportWidth(): number {
  if (typeof window === 'undefined') return 0;
  const value = window.innerWidth;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 一次键盘调整步长：16px 在 200..420 的区间里是 14 下，够细也不至于按到手酸。 */
const KEY_STEP_PX = 16;

export function useRailWidth() {
  const width = ref(DEFAULT_UI_PREFS.railWidth);
  /** 拖拽中的预览宽度（px）；null = 现在没在拖。只有它随指针动。 */
  const preview = ref<number | null>(null);
  const dragging = computed(() => preview.value !== null);
  /** 当前窗口允许的上限，给分隔条的 `aria-valuemax` 与"还能不能放大"用。 */
  const ceiling = computed(() => railWidthCeiling(viewportWidth()));

  let stopWatch: (() => void) | undefined;
  let detachDrag: (() => void) | undefined;

  function clamp(value: number): number {
    return clampRailWidth(value, viewportWidth());
  }

  /**
   * 保存失败不弹错误条：一次没存进去的宽度不值得到一个红色横幅，
   * 界面当下是对的，下次进来回默认值 —— 用户能接受的降级。
   */
  async function commit(next: number): Promise<void> {
    const clamped = clamp(next);
    width.value = clamped;
    try {
      await storagePort.setUiPrefs({ railWidth: clamped });
    } catch (cause: unknown) {
      console.error('[shitab] 侧栏宽度保存失败', cause);
    }
  }

  /**
   * 按下即开始拖。监听挂在 window 上而不是分隔条上：指针会滑出那根 4px 的条，
   * 挂在条上会在边缘处丢事件，拖到一半就断。
   */
  function startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault(); // 拖分隔条时不该顺手选中文本
    preview.value = clamp(event.clientX);

    const move = (ev: Event) => {
      preview.value = clamp((ev as PointerEvent).clientX);
    };
    const finish = () => {
      detachDrag?.();
      detachDrag = undefined;
      const next = preview.value;
      preview.value = null;
      // 宽度没变就不写库：一次没结果的拖拽不该惊动其他窗口的 watch
      if (next === null || next === width.value) return;
      void commit(next);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    detachDrag = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }

  /** 双击分隔条：回到默认宽度（真机上"拖过头了"最快的退路）。 */
  function reset(): void {
    void commit(RAIL_WIDTH_DEFAULT);
  }

  /** 键盘等价操作：左右调整、Home 复位（一根 role=separator 的条不该只有鼠标能用）。 */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      void commit(width.value - KEY_STEP_PX);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      void commit(width.value + KEY_STEP_PX);
    } else if (event.key === 'Home') {
      event.preventDefault();
      reset();
    }
  }

  async function init(): Promise<void> {
    width.value = clamp((await storagePort.getUiPrefs()).railWidth);
    stopWatch = storagePort.watchUiPrefs((prefs) => {
      // 正在拖的时候不跟别的窗口走：预览线归这只手所有，松手再同步
      if (preview.value !== null) return;
      width.value = clamp(prefs.railWidth);
    });
  }

  onScopeDispose(() => {
    stopWatch?.();
    detachDrag?.();
    stopWatch = undefined;
    detachDrag = undefined;
  });

  return { width, preview, dragging, ceiling, init, startDrag, reset, onKeydown, commit };
}
