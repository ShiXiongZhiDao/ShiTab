/**
 * 收纳黑名单（`blockedPrefixes`）的唯一实现处。
 *
 * ## 三层，别混
 *
 * 1. **硬底 `HARD_FLOOR`** —— 不可配置，命中 ⇒ 不收不关。只有两项，理由各不同：
 *    - `about:blank`：**不是**"打不开"（取证：Edge/Chrome 都能开），是它是**我们自己的落脚页**
 *      （`capture-window.ts` 会主动 `create` 它）。解除它 ⇒ 关了入口页的用户连点两次收纳，
 *      第二次会把上一步那个空白页收成一个新会话。
 *    - `javascript:`：取证里**唯一被平台点名拒绝**的 ——
 *      `JavaScript URLs are not allowed in API based extension navigations.`
 *2. **默认黑名单 `DEFAULT_BLOCKED_PREFIXES`** —— 可配置，默认值见下面那张表。
 *3. **用户加的** —— 同一张表，走过同一个 `normalizePrefix`。
 *
 * ## ⚠ 默认表的性质在 2026-10-19 被取证改写过，别再把它读成"平台打不开"
 *
 * 取证（`_probe/protocol-probe.mjs`，Edg 153 / Chrome 155 真机）证明
 * `chrome://extensions`、`chrome://settings`、`about:blank`、`data:`、`view-source:` **全都能打开**。
 * 也就是说这张表**不是**平台事实的映射（既有约定 当年把它当成跨端事实，而它的真正来源是
 * Firefox 的文档 —— MDN 明写 Firefox 下 `chrome:`/`data:`/`file:`/特权 `about:` 会 reject）。
 * 它们留在默认表里的理由是两条，都不自称平台事实：
 * - **为 Firefox 兜底**（三端统一 ⇒ 取最保守那端）；
 * - **产品选择**：内部页收回来也没有意义。
 * 代价如实记着：Chrome/Edge 用户因此白牺牲了一类本来能开的页面。
 *
 * 反过来，**两个 Web Store 域名是被平台拦的**（取证：两平台都开不出，而网络对照
 * `https://example.com/` 开得成 ⇒ 不是网络问题）⇒ 它们**留在**默认表里。
 */

/** 硬底。`about:blank` 是全串精确匹配，`javascript:` 是前缀匹配 —— 两种写法都在一处。 */
const HARD_FLOOR_EXACT = ['about:blank'] as const;
const HARD_FLOOR_PREFIX = ['javascript:'] as const;

/**
 * 默认黑名单。顺序按"先协议、后域名"排，只为读起来成组，与判据无关。
 *
 * ⚠ 三个扩展协议（`chrome-extension://` / `moz-extension://` / `extension://`）**不在**表里：
 * 取证里 `chrome-extension://` 两端都开得成，而 `extension://` 在 Edge 上会被浏览器
 * 规范成 `chrome-extension://`（`tab.url` 读回来就是后者）⇒ 留着它只会多一项永远命不到。
 */
export const DEFAULT_BLOCKED_PREFIXES: readonly string[] = [
  'chrome://',
  'edge://',
  'about:',
  'data:',
  'view-source:',
  'blob:',
  'devtools:',
  'https://chrome.google.com/',
  'https://chromewebstore.google.com/',
];

/**
 * 设置页上摆出来的预设。前 9 项默认勾上（= 不收），后 3 项默认不勾（= 收），
 * 用户勾上就是"我也不收扩展页"。
 */
export const PRESET_PREFIXES: readonly string[] = [
  ...DEFAULT_BLOCKED_PREFIXES,
  'chrome-extension://',
  'moz-extension://',
  'extension://',
];

const MAX_PREFIXES = 50;
const MAX_PREFIX_LENGTH = 200;

/**
 * 把用户填的一格归一化成一条前缀；认不出来返回 `null`（调用方负责告诉用户）。
 *
 * 规则一处，五条，顺序有意义：
 * 1. trim + 小写；空 ⇒ `null`
 * 2. 含 `://` ⇒ 必须**以 `/` 结尾**（没有就补）
 *    —— 这条是安全底线不是洁癖：不补的话 `https://chrome.google.com` 会命中
 *    `https://chrome.google.com.evil.com`
 * 3. 形如 `host:端口` ⇒ `https://host:端口/`
 * 4. 形如 `scheme:…`（裸协议前缀，`about:blank` / `view-source:` / `data:` 都属于这类）⇒ 原样
 * 5. 不含 `:` ⇒ 当域名，补 `https://` 与结尾 `/`
 * 其余（说不清的）⇒ `null`
 *
 * ⚠ 第 3 与第 4 条都在**猜**（`localhost:3000` 该补 http 还是 https），所以调用方
 * **必须把归一化结果回显给用户** —— 猜错又不显示就是静默失败，那是最坏的一类 bug。
 */
export function normalizePrefix(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.length > MAX_PREFIX_LENGTH) return null;
  if (value.includes('://')) {
    const withSlash = value.endsWith('/') ? value : `${value}/`;
    // ★ 形状校验**不能用 `new URL()`**（2026-10-19 真机事故，既有约定 修订三）。
    //   URL 解析是 scheme 相关的：Chrome 155 里 `new URL('chrome://')` 抛
    //   "Invalid URL"（`chrome-extension://` / `moz-extension://` / `devtools:` 同样抛），
    //   而 **Node 不抛** ⇒ 单测全绿、真机上整条前缀被 `mergeBlockedPrefixes` 当垃圾丢掉，
    //   表现就是"勾上了 → 刷新后又没勾"。`edge://` 反而能过 —— 按 scheme 逐个列只会更脆。
    //   这里要的只是 "scheme:// + 非空白"，不是"一个完整 URL"：**前缀本来就可以没有 host**
    //   （`chrome://` 就是全部内部页）。空白仍然拒（`http://a b c/` 那种拼错）。
    if (!/^[a-z][a-z0-9+.-]*:\/\/\S*$/.test(withSlash)) return null;
    return withSlash;
  }
  if (/^[a-z0-9.-]+:\d+$/.test(value)) return `https://${value}/`;
  // 裸协议前缀：**只允许一个冒号**（`about:blank` / `view-source:` / `data:` 都长这样）。
  // 出现第二个冒号（ `a:b:c` 那种）就说不清了 —— 它既不是 `scheme://` 也不是 `host:端口`，
  // 存进去会变成一条永远命不到任何 URL 的前缀，那是最典型的静默失效。
  if (/^[a-z][a-z0-9+.-]*:[^:]*$/.test(value)) return value;
  if (!value.includes(':')) {
    return value.endsWith('/') ? `https://${value}` : `https://${value}/`;
  }
  return null;
}

/** 把一整份（可能来自 storage / 导入的备份）收敛成可用名单。老数据缺这个键 ⇒ 默认值。 */
export function mergeBlockedPrefixes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_BLOCKED_PREFIXES];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const normalized = normalizePrefix(item);
    if (normalized === null) continue;
    if (out.includes(normalized)) continue;
    out.push(normalized);
    if (out.length >= MAX_PREFIXES) break;
  }
  return out;
}

/** 命中硬底？—— 与配置无关，勾掉也没用。 */
export function isHardFloor(url: string | undefined): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (HARD_FLOOR_EXACT.some((exact) => lower === exact)) return true;
  return HARD_FLOOR_PREFIX.some((prefix) => lower.startsWith(prefix));
}

/** 命中黑名单（含硬底）？命中 ⇒ 不收、也不关。 */
export function isBlockedUrl(url: string | undefined, prefixes: readonly string[]): boolean {
  if (!url) return true; // 读不到 URL 的 tab 一律不收：它本来也开不回来（既有约定 后果条）
  if (isHardFloor(url)) return true;
  const lower = url.toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(prefix));
}
