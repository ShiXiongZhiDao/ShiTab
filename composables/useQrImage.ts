/**
 * 一张远程图的取图状态机：按候选地址**一张张退**，退完了明说。
 *
 * 从同门 shistart 的 `composables/useQrImage.ts` 搬过来，照本仓的情况改了两点：
 *
 * 1. **砍掉了宽高比（`ratio`）那一套。** 那边方形码与横幅两种图位要靠 `aspect-ratio`
 *    收拢；本仓 `AboutPanel` 的三张图一律给**固定尺寸**（`width`/`height` 属性 + 工具类），
 *    图位在解码前就是确定的 —— 也就用不上"加载完再按真实比例收拢"。
 *    留着不用的字段比没有字段更难维护，所以不搬。
 *
 * 2. **候选列表由上层每次重算**，所以入参取的是**取值函数而不是数组**。
 *    选源是异步的（探活要等），拿到源之后候选顺序才定下来；传函数能直接跟住，
 *    不用上层再包一层 watch。
 *
 * ## 为什么逐张回落
 *
 * `chooseQrMirror` 只探了支付宝那一张。探测时的胜者**未必**每张图都通
 * （单张 404、CDN 缓存脏、Gitee 的 raw 链接是每次现签的 302……）。
 * 不回落的话，这种小概率事件在用户眼里就是一块空白。
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';

export interface QrImage {
  /** 当前该试的地址；候选全退完时是空串。 */
  current: ComputedRef<string>;
  /** 候选是不是全部退完了 —— 真时该显示错误态，而不是继续挂一个空 `<img>`。 */
  exhausted: ComputedRef<boolean>;
  /** 绑到 `<img @error>`：换下一个候选。 */
  onError: () => void;
  /** 绑到 `<img @load>`。本仓图位是固定尺寸，所以这里只记"真的出来了"这一件事。 */
  onLoad: () => void;
  /** 图已经真的渲染出来了（用来做淡入，别让空框先闪一下）。 */
  loaded: Ref<boolean>;
}

/**
 * @param urls 取候选地址的**函数**，不是数组。
 */
export function useQrImage(urls: () => string[]): QrImage {
  const index = ref(0);
  const loaded = ref(false);

  const list = computed(() => urls());
  const exhausted = computed(() => index.value >= list.value.length);
  const current = computed(() => list.value[index.value] ?? '');

  // 换了一批候选（重试 / 换了源）⇒ 从头再来。不重置的话，上一轮的 index 会
  // 落在新一轮的中间，用户点了"重试"却从第二张开始试。
  watch(
    () => list.value.join('|'),
    () => {
      index.value = 0;
      loaded.value = false;
    },
  );

  function onLoad(): void {
    loaded.value = true;
  }

  function onError(): void {
    index.value += 1;
    loaded.value = false;
  }

  return { current, exhausted, onLoad, onError, loaded };
}
