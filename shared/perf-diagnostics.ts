/**
 * 首屏计时（既有约定 决定 10 / 既有约定 采纳 2 的开发环境 instrumentation）。
 *
 * 存在的理由是一条分工：结构量（读次数、节点数）我能在 jsdom 里测，**墙上毫秒只能在浏览器里量**，
 * 而他那边每次手粘 DevTools 代码是不成立的协作方式（2026-10-06 真机第一轮就试了，一行 JSON
 * 来回两轮才拿到数）。所以把这四个数打在控制台：**重载产物就能看到，不用开 DevTools 敲代码**。
 *
 * ★ 三条纪律：
 * 1. **只在开发构建里打印**。判据是 `import.meta.env.DEV`：生产构建里 Vite 把它折成 `false`，
 *    实测产物里那个开关函数直接编译成 `function(){return!1}` ⇒ 线上**一个字都不会打印**。
 *    ⚠ 诚实起见记一条差别：**字符串与函数体仍然留在产物里**（约百来字节），
 *    Rollup 没把整块调用点摇掉 —— 所以"静默"是折叠后的开关保证的，不是"代码没进线上"。
 *    两条都有据：`test/perf-diagnostics.spec.ts` 用对称的两条用例（开着必打印 / 关着必静默），
 *    产物那一侧是对 `.output/chrome-mv3` grep 出来的。
 * 2. **不新增任何统计服务、不上报任何数据**（既有约定 拒绝清单里"不引服务器"是同一条底线）。
 * 3. 这些毫秒是**真机数据**，与 `test/perf-baseline.spec.ts` 里那些"内存假件的墙上时间"是两类数字，
 *    引用时不许互相顶替（既有约定 决定 10 要求的三类分开标注：结构量 / 原型页 / 真机）。
 */

/**
 * 日志前缀。⚠ **不要给它加方括号** —— Tailwind v4 会把源码里形如 `[a:b]` 的字面串
 * 当成任意值类名候选，实测生成过一条 `.\[shitab\:perf\]{shitab:perf}` 的垃圾 CSS 规则
 * （2026-10-06 那次构建产物里抓到的，改回不带括号后重建就没了）。
 */
export const PERF_LOG_PREFIX = 'shitab:perf';

/** 只有开发构建为真；写成函数而不是常量，是为了让用例能分别在两种取值下各跑一次。 */
export function perfDiagnosticsEnabled(): boolean {
  return import.meta.env.DEV === true;
}

/** `ensureReady()` 里 `heal()` 那一段的耗时，等首屏报告一起发出去。 */
let healMs: number | undefined;
let healReport: { groupCount: number; fixedTabCounts: number } | undefined;
/** 页面脚本开始执行的时刻（相对导航起点），用来把"解析执行"与"等数据"分开。 */
const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;

/**
 * 由 `shared/services.ts` 的 `ensureReady()` 调用，记录存储自愈花了多久。
 *
 * ⚠ 每个页面进程只会跑一次 `heal()`（模块级 `healed` 闸），所以这个数**代表冷启动那一趟**；
 *   同一进程里第二次调用是 0，别拿它当"热启动也很快"的证据。
 */
export function markHealDuration(ms: number, report?: { groupCount: number; fixedTabCounts: number }): void {
  if (!perfDiagnosticsEnabled()) return;
  healMs = ms;
  if (report) healReport = report;
}

export interface FirstScreenShape {
  cards: number;
  rows: number;
  elements: number;
  images: number;
}

function paintStart(name: string): number | undefined {
  if (typeof performance === 'undefined') return undefined;
  const entry = performance.getEntriesByName?.(name)[0] as { startTime?: number } | undefined;
  return entry?.startTime === undefined ? undefined : Math.round(entry.startTime);
}

/** 导航与整页加载的时刻；jsdom 里没有 navigation timing，取不到就给 `undefined`（不许抛）。 */
function navigationTimes(): { domReady?: number; loadEnd?: number } {
  if (typeof performance === 'undefined') return {};
  const entry = performance.getEntriesByType?.('navigation')[0] as
    | { domContentLoadedEventEnd?: number; loadEventEnd?: number }
    | undefined;
  if (!entry) return {};
  return {
    domReady: entry.domContentLoadedEventEnd === undefined ? undefined : Math.round(entry.domContentLoadedEventEnd),
    loadEnd: entry.loadEventEnd === undefined ? undefined : Math.round(entry.loadEventEnd),
  };
}

/**
 * 首屏渲染完成后打一行：`首屏FCP / DOM就绪 / 整页load / heal / init / 结构量`。
 * 任何一项取不到就写 `?`，**这条日志永远不许把页面搞崩**（它是诊断，不是判据的来源）。
 *
 * 怎么读这行：`DOM就绪` 是**首包解析执行完**（那 240 KiB 的钱付在这里），`heal` 是存储自愈那一趟，
 * `init` 是页面自己从挂载到数据齐，`首屏FCP` 是浏览器真正画出内容的一刻。
 * 他报的那"一秒多空白"就看两条比例：**`DOM就绪` ≈ `FCP`** ⇒ 钱在解析执行（该切首包）；
 * **`DOM就绪` 很小而 `FCP` 大得多** ⇒ 钱在等数据或首帧渲染（该查还剩哪一次整块读）。
 * `脚本起算到此` 是从本模块被求值（首包已解析）算到打印这一刻，别和前面几个"从导航起点算"的混着比。
 */
export function reportFirstScreen(shape: FirstScreenShape, initMs: number): void {
  if (!perfDiagnosticsEnabled()) return;
  const { domReady, loadEnd } = navigationTimes();
  const fcp = paintStart('first-contentful-paint');
  const show = (value: number | undefined): string => (value === undefined ? '?' : `${value}ms`);
  const now = Math.round(performance.now());
  console.log(
    `${PERF_LOG_PREFIX} 首屏FCP=${show(fcp)} DOM就绪=${show(domReady)} 整页load=${show(loadEnd)} ` +
      `heal=${show(healMs)} init=${show(Math.round(initMs))} 脚本起算到此=${show(now - Math.round(startedAt))} ` +
      `结构量：卡${shape.cards} 行${shape.rows} 节点${shape.elements} 图${shape.images}` +
      (healReport ? ` 会话${healReport.groupCount}` : ''),
  );
}
