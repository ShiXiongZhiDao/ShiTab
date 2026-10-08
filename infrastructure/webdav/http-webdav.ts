/**
 * WebDavPort 的 HTTP 实现（既有约定，WebDAV-SYNC.md §13）。
 *
 * 这一层只做三件事：发**对**的请求、把状态码翻译成 port 定义的那几种语义、
 * 把"没拿到响应"和"服务器回答不"分开。业务规则（哪个快照不可变、412 之后要不要重拉）
 * 一律不在这里 —— 理由见 core/ports/webdav.ts 文件头：状态码不是同步引擎的合同。
 *
 * 四条只在 MV3 里成立的实现前提：
 * 1. MV3 的 `fetch` **不支持** Request 的 `username`/`password` 字段（扩展文档写明了），
 *    所以 Basic 认证只能自己拼 `Authorization` 头。少这一句的后果是"每次 401"，
 *    而且报出来的 kind 是 credentials ⇒ 上层会一直让用户重填密码，永远猜不到是没发头。
 * 2. 自定义方法（PROPFIND/MKCOL/MOVE）在 fetch 里合法：规范只禁 CONNECT/TRACE/TRACK，
 *    不需要退回 XMLHttpRequest。
 * 3. **不做重定向剥离**：`redirect: 'follow'`，于是服务器 302 到另一个 origin 时那个
 *    `Authorization` 头会跟着发出去。这不是疏忽，而是把复杂度换成了可预期性 ——
 *    自己实现 `redirect:'manual'` 加逐跳 origin 比对，判错的那一侧是"悄悄不带凭据"，
 *    用户看到的现象是"配好了但一直 401"，比泄露更难诊断。代价转给调用方：
 *    **baseUrl 必须是 https 且指向用户自己的服务器**（设置页那条提示就是为这句话存在的）。
 * 4. 不写 `credentials: 'include'`：认证只走 Authorization 头。带上会把用户浏览器里
 *    那个域的会话 cookie 一起送出去，等于多开一条没人审计过的授权路径。
 */

import {
  WebDavError,
  webDavErrorKind,
  type RemoteResourceMeta,
  type WebDavCredential,
  type WebDavMethod,
  type WebDavAdminPort,
  type WebDavPort,
  type WebDavRequestOptions,
} from '@/core/ports/webdav';
import {
  childrenByLocal,
  descendantsByLocal,
  parseXmlRoot,
  textOf,
  type XmlNode,
} from './xml';

export interface HttpWebDavOptions {
  /**
   * 注入点。测试靠它把整张状态码表（401/403/404/409/412/503/TypeError）
   * 喂给真实适配器，不必架一台 WebDAV 服务器 —— 而这个仓库唯一的验收通道是
   * 用户在浏览器里重载生产产物，他看的是结果不是竞态。
   */
  fetchImpl?: typeof fetch;
  /**
   * 测试注入点：把**每一个**请求的墙上时间改成这个值，用例才不用真的等 15 秒。
   * 生产不传，走下面 `requestTimeoutMs` 的分档。与 `fetchImpl` 同一性质。
   */
  timeoutMs?: number;
}

/**
 * 请求超时。
 *
 * 为什么必须有：端口从建好那天起就把 `signal` 铺到了 `put`，而生产**一次都没传过**
 * （全仓 `ifMatch` / `signal` 的调用点为 0）。后果不是"慢"，是**占着**：坚果云挂住时
 * 请求永不返回，而跨进程认领锁 `SYNC_CLAIM_TTL_MS` 只有 60 秒 ⇒ 锁先过期，
 * 第二个 surface 在第一个还卡在网络上时就开第二轮；MV3 的 worker 也可能在半截 PUT 时被平台杀掉。
 * 同类产品 NiceTab 是给每个请求包一层 10 秒。
 *
 * ⚠ **这一层只能用墙上时间。** 浏览器的 `fetch` 不暴露传输进度，没有"还在动"这个信号可看，
 * 所以 既有约定 那条"判死用进度停滞（`http.lowSpeedLimit` / `lowSpeedTime`）"在这里**不成立**。
 * 那条属于发布管线 —— 它走的是 curl/git，有 `--progress`。把那条照抄过来会得到一个
 * 永远读不到进度的实现，然后所有请求都被判成死的。（这个坑我踩过一次，记在 log.md。）
 *
 * ⚠ 超时**不等于**服务器说了"不"：中止落在 `request()` 的 catch 上，折成 `kind: 'network'`
 * + status 0，于是自动落进已有的指数退避（5 秒起、30 分钟封顶），不新造第二套重试机制，
 * 也不会去改本地数据（§19「网络故障只报告，不改本地数据」）。
 */
/** 小请求（PROPFIND / MKCOL / MOVE / DELETE / HEAD / 测试连接）：载荷是固定的几百字节。 */
export const SMALL_REQUEST_TIMEOUT_MS = 15_000;
/** GET 单独一档：层里事先不知道载荷多大，而它读的可能是一份完整快照。 */
export const GET_REQUEST_TIMEOUT_MS = 60_000;
/** PUT 的下限：再短就没有合法的上传会被允许了。 */
export const PUT_TIMEOUT_FLOOR_MS = 15_000;
/** PUT 的上限：再长就是把"一轮同步"变成"占着 worker 直到被平台杀掉"。 */
export const PUT_TIMEOUT_CEILING_MS = 120_000;
/** 折算 PUT 时假设的最低可用速率。低于它就不当"慢"、当"死"。 */
const PUT_MIN_BYTES_PER_SECOND = 16 * 1024;

/**
 * 这一次请求给多少墙上时间。PUT 按体量折算，其余按方法分档。
 *
 * PUT 不给一个死数是因为两个变量都不在手里：载荷多大（10k 条与 20k 条差一个数量级）、
 * 用户的上行多快。夹在上下限之间，让"慢网络上的合法上传"和"挂死的连接"还能分开。
 * 字节按 UTF-8 数不是按 `string.length`：载荷里的标题与 URL 有大量多字节字符，
 * 按字符数会系统性低估体量。
 */
export function requestTimeoutMs(method: WebDavMethod, body?: string): number {
  if (method === 'PUT') {
    const bytes = body === undefined ? 0 : new TextEncoder().encode(body).length;
    const scaled = Math.ceil((bytes / PUT_MIN_BYTES_PER_SECOND) * 1000);
    return Math.min(PUT_TIMEOUT_CEILING_MS, Math.max(PUT_TIMEOUT_FLOOR_MS, scaled));
  }
  return method === 'GET' ? GET_REQUEST_TIMEOUT_MS : SMALL_REQUEST_TIMEOUT_MS;
}

/**
 * 超时中止时挂在 `signal.reason` 上的标记。
 *
 * 为什么要专门一个类型：`networkError` 会把 cause 的 `name: message` 拼进最终文案，
 * 而日志必须分得开"挂到超时被我们杀掉"与"根本没连上"—— 前者该让用户查服务器/网盘那边，
 * 后者该让他查自己网络。两条都印成 `AbortError: The user aborted a request` 就什么都分不出来。
 */
class RequestTimeout extends Error {
  constructor(method: WebDavMethod, url: string, readonly timeoutMs: number) {
    super(`${method} ${url} 超过 ${timeoutMs}ms 没有完成，已中止`);
    this.name = '请求超时';
  }
}

/** 标准 PROPFIND 载荷。前缀 `d:` 只是我们这一侧的写法，解析侧不依赖任何前缀（见 localName）。 */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:propfind xmlns:d="DAV:">' +
  '<d:prop>' +
  '<d:resourcetype/>' +
  '<d:getcontentlength/>' +
  '<d:getlastmodified/>' +
  '<d:getetag/>' +
  '</d:prop>' +
  '</d:propfind>';

/**
 * UTF-8 安全的 base64。
 *
 * 直接 `btoa('user:pass')` 在**任何**非 latin1 字符上抛 InvalidCharacterError，
 * 而 WebDAV 用户名/密码里有中文是常见配置（自建网盘居多）。不先过 TextEncoder 的话，
 * 用户看到的是"扩展崩了"，而不是"这个密码里有中文"。
 * 分块是防超长串把 `String.fromCharCode` 的实参列表撑爆栈。
 */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode(...bytes.subarray(at, at + chunk));
  }
  return btoa(binary);
}

function authorizationHeader(credential: WebDavCredential): string {
  return `Basic ${base64Utf8(`${credential.username}:${credential.password}`)}`;
}

/** 非 Error 的 reject（有些实现回字符串/DOMException）也要能读，否则报错里只剩 undefined。 */
function reasonText(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  return String(cause);
}

/**
 * 没有响应 = `network` + status 0。
 *
 * 这条翻译是整个文件最重要的一行：TypeError（DNS/TLS/离线/被 CORS 拒）和 AbortError
 * 都**不是**服务器的判断。把它们按 HTTP 状态码去分类会得到 'forbidden' 或 'bad-response'，
 * 而上层对 403 的分支是"提示用户改权限/换目录"、对可重试错误的分支是"重拉 manifest" ——
 * §19 那条"网络故障只报告、不改动本地数据"就从这里开始失效。
 *
 * `WebDavError` 的第 5 个形参是 message 而不是 cause（port 里已经定死了，这里不动它），
 * 所以原文塞进 message 之后再把 `cause` 挂回去，两者都不丢。
 */
function networkError(method: WebDavMethod, url: string, cause: unknown): WebDavError {
  const error = new WebDavError(
    'network',
    method,
    url,
    0,
    `WebDAV ${method} ${url} 没有拿到响应：${reasonText(cause)}`,
  );
  error.cause = cause;
  return error;
}

/** 状态码 → 语义的唯一一张表在 core/ports/webdav.ts，这里**只**调用它，不重抄一遍。 */
function statusError(method: WebDavMethod, url: string, status: number): WebDavError {
  return new WebDavError(webDavErrorKind(status), method, url, status);
}

/**
 * HTTP 日期 → epoch 毫秒；读不出来就**缺失**，绝不给 0。
 *
 * `Date.parse('garbage')` 是 NaN，而 `lastModified: 0` 会被上层读成"1970 年改过"，
 * 于是"这个快照比我手上的新"恒成立，冲突处理永远选错边（port 第 24 行的注释就是这条）。
 * 有些服务器（尤其反代后面的）就是会回空串或 `0` —— 那种情况按"服务器没给"处理。
 */
function parseHttpDate(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
}

/** 同上：Content-Length 缺失/非数字时是"不知道"，不是 0 字节。 */
function parseLength(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const length = Number(value);
  return Number.isFinite(length) && length >= 0 ? length : undefined;
}

/**
 * 这一整段刻意不用 DOMParser —— 它不在 service worker 全局里，而这段代码就跑在那儿
 * 。解析器是同目录的 `xml.ts`，节点类型是 `XmlNode`，纯字符串处理，
 * 因而在 node 环境下也能跑：配套用例就是拿 node 环境跑的，因为 jsdom 有 DOMParser，
 * 只在那儿测过的假件比生产宽容，这个 bug 才一路躲过了 570 条用例。
 *
 * 前缀写法各家不同（`D:` / `d:` / 默认命名空间无前缀 / 全大写），所以一律先成树、
 * 再按**本地标签名**筛。用带前缀的实参去查，换服务器时会**静默返回空列表** ——
 * 后果不是报错，是"列目录成功但一个快照都没看见"，manifest 于是重建成一张空表，
 * 远端看起来被清空了。
 */

/** `<d:status>` 里是 `HTTP/1.1 404 Not Found`，要的是那三位数；版本行写法不一，只抓第一个 3 位数。 */
function perResourceStatus(response: XmlNode): number | undefined {
  const value = textOf(response, 'status');
  if (!value) return undefined;
  const matched = /(\d{3})/.exec(value);
  const code = matched?.[1] === undefined ? undefined : Number(matched[1]);
  return code === undefined || Number.isNaN(code) ? undefined : code;
}

/**
 * `<d:href>` → 绝对 URL。服务器可能回完整 URL、以 `/` 开头的绝对路径（最常见）、相对路径。
 * 绝对路径必须拿请求 URL 的 origin 还原：上层拿它当键与 manifest 里记的 url 比对，
 * 串不一致就判"远端没有这个快照"，代价是每次同步都重复上传一份 —— 静默，
 * 且要攒到几百个快照才看得出来。先 decode 再解析，让 `%20` 与真空格归一；
 * 裸 `%` 这类非法编码就原样用，不能因此丢掉整条记录。
 */
function resolveHref(href: string, baseUrl: string): string | undefined {
  let candidate = href;
  try {
    candidate = decodeURIComponent(href);
  } catch {
    candidate = href;
  }
  try {
    return new URL(candidate, baseUrl).href;
  } catch {
    return undefined;
  }
}

/** 一个 `<d:response>` → RemoteResourceMeta。前提：调用方已确认逐资源 status 不是 >=400。 */
function metaFromResponse(response: XmlNode, url: string): RemoteResourceMeta {
  const isCollection = descendantsByLocal(response, 'resourcetype').some(
    (type) => childrenByLocal(type, 'collection').length > 0,
  );
  const meta: RemoteResourceMeta = {
    url,
    exists: true,
    // resourcetype 没给（有些服务器只回 200 空属性）时退到 WebDAV 的通行约定：尾斜杠 = 集合。
    isDirectory: isCollection || url.endsWith('/'),
  };
  const etag = textOf(response, 'getetag');
  if (etag) meta.etag = etag;
  const lastModified = parseHttpDate(textOf(response, 'getlastmodified'));
  if (lastModified !== undefined) meta.lastModified = lastModified;
  const length = parseLength(textOf(response, 'getcontentlength'));
  if (length !== undefined) meta.contentLength = length;
  return meta;
}

/**
 * 207 Multi-Status 正文 → 条目列表。
 * 返回 `undefined` = "这正文根本不是 multistatus"（解不开 / 根不对 / 半截文档）；
 * 返回空数组 = "解开了但一条都没有"。两者含义不同，调用方要分开处理。
 */
function parseMultistatus(xml: string, baseUrl: string): RemoteResourceMeta[] | undefined {
  const root = parseXmlRoot(xml);
  if (!root || root.local === 'parsererror') return undefined;
  if (root.local !== 'multistatus') return undefined;

  const entries: RemoteResourceMeta[] = [];
  for (const response of childrenByLocal(root, 'response')) {
    const href = textOf(response, 'href');
    // 没 href 的条目连"说的是哪个资源"都不知道，留着会被当成请求的那个 URL 本身。
    if (!href) continue;
    const url = resolveHref(href, baseUrl);
    if (!url) continue;

    const code = perResourceStatus(response);
    // 逐资源 404 = "这个路径没东西"，是**信息**不是错误：重建 manifest 要的正是这张表。
    if (code === 404) {
      entries.push({ url, exists: false, isDirectory: false });
      continue;
    }
    // 其余 >=400 的逐资源条目（424 依赖失败、500 读属性炸了）：这一条坏，别的路径仍有效。
    if (code !== undefined && code >= 400) continue;

    entries.push(metaFromResponse(response, url));
  }
  return entries;
}

/**
 * `Destination` 头的编码。
 *
 * 只 `encodeURI`，不整体 `encodeURIComponent`：后者会把 scheme 的 `:` 和路径的 `/`
 * 一起变成 `%3A`/`%2F`，服务器把它当畸形 URI 回 400，而 400 在我们的表里是
 * bad-response —— 于是"目录名里有空格"这种完全合法的配置会被报成"服务器返回了看不懂的东西"。
 */
function destinationHeader(url: string): string {
  return encodeURI(url);
}

/**
 * 把 URL 拆成"逐级 MKCOL 要打的集合路径"，从最外层开始。
 *
 * `https://h/dav/shitab/` → `['https://h/dav/', 'https://h/dav/shitab/']`。
 * 两点刻意的行为：
 * - **不含根**：根按定义存在，而对 `MKCOL /` 不少主机回 403，那会被翻译成"你没权限"，
 *   把一个"目录已经就绪"的正常状态报成认证问题。
 * - **不重新编码路径段**：进来的 URL 可能已经编码过（`%20`），再编码一次得到 `%2520`，
 *   结果是新建一个"存在但永远空"的目录，写入静默落在别处。
 */
function collectionPathOf(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 不是绝对 URL 就只 MKCOL 它自己：拼路径是 core/domain/remote-layout.ts 的职责（见 port 文件头），
    // 这里不猜用户想表达什么。
    return [url];
  }
  const out: string[] = [];
  let path = '/';
  for (const segment of parsed.pathname.split('/').filter(Boolean)) {
    path += `${segment}/`;
    out.push(`${parsed.origin}${path}`);
  }
  return out;
}

export function createWebDavPort(options?: HttpWebDavOptions): WebDavPort & WebDavAdminPort {
  // 用箭头包一层而不是把 `globalThis.fetch` 存进变量：Chrome 里脱离 global 引用的 fetch
  // 会抛 Illegal invocation（一存变量就炸），而这个炸法在 try 之外，会变成 port 之外的裸 TypeError。
  const fetchImpl: typeof fetch =
    options?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  interface CallInit {
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    /**
     * 把超时从"响应头到达"延长到"正文读完"。
     *
     * 只有 `get` / `propfind` / `probeIsCollection` 开：它们读的正文可能是整份快照
     * 或一次 750 条的目录列举，属于"连上了但一直流不完"那一档 —— 而 `fetch` 在
     * **响应头**到达就 resolve，只掐头不掐尾的话这一档完全没人管。
     *
     * PUT / MKCOL / MOVE / DELETE 不开：它们的 fetch 在服务器答完时就已经把整个请求体
     * 传完了，响应体是空的、没人读。多挂一个计时器只会白白拖着 MV3 的 worker 不死。
     */
    timeoutCoversBody?: boolean;
  }

  /** 发一次请求。任何"没有响应"都在这里被折成 network，之后的代码不必再判异常类型。 */
  async function request(
    method: WebDavMethod,
    url: string,
    credential: WebDavCredential,
    init?: CallInit,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: authorizationHeader(credential),
      ...init?.headers,
    };

    const limit = options?.timeoutMs ?? requestTimeoutMs(method, init?.body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new RequestTimeout(method, url, limit)), limit);
    // 调用方给的 signal 也接进来：端口契约里它一直在那儿，超时只是**多**一个中止源，
    // 不能把它顶掉。两个源汇成一个 controller，靠 `signal.reason` 分清是谁叫的停 ——
    // 所以下面 `networkError` 拿到的是 `RequestTimeout` 而不是笼统的 AbortError。
    const caller = init?.signal;
    const forward = (): void => controller.abort(caller?.reason);
    if (caller) {
      if (caller.aborted) forward();
      else caller.addEventListener('abort', forward, { once: true });
    }
    const release = (): void => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', forward);
    };

    const requestInit: RequestInit = {
      method,
      headers,
      redirect: 'follow',
      signal: controller.signal,
      ...(init?.body === undefined ? {} : { body: init.body }),
    };
    try {
      const response = await fetchImpl(url, requestInit);
      /**
       * GET 与 PROPFIND 的正文**总**会被读（整份快照 / multistatus 目录列举），其余方法的
       * 响应体是空的、没人读 —— 所以这一条由方法自己决定，不给调用方留一个"忘了传"的机会。
       * 五个 PROPFIND 调用点（`probeIsCollection`、稳态快路径、`ensureCollection` 的探测、
       * `propfind`）加一个 `get`，逐个传 flag 迟早会漏掉一个，而漏掉的那个正是
       * "连上了但正文流不完"没人管的那一个。
       */
      const coversBody = init?.timeoutCoversBody ?? (method === 'GET' || method === 'PROPFIND');
      // 两条路都要显式撤，不留 `finally`：开了正文档时计时器**不能**在这里撤，
      // 得等 `view.text()` 真的读完。忘撤的代价是白拖着一个 worker 不死。
      if (!coversBody) {
        release();
        return response;
      }
      return bodyTimeoutView(response, release, method, url);
    } catch (cause) {
      release();
      throw networkError(method, url, cause);
    }
  }

  /**
   * 只暴露适配器真正读的那四项（`status` / `ok` / `headers` / `text`），并把撤计时器
   * 推迟到正文读完。
   *
   * 少暴露一项是故意的：谁将来想在这里读 `response.body`，会直接红在这一层，
   * 而不是静默地绕过一个已经写进 既有约定 的超时约束。
   *
   * ⚠ 正文那一步的失败**必须也折成 `network`**。上层是按 `WebDavError.kind` 分支的
   * （`sync-engine.ts` 那句 `error instanceof WebDavError ? error.kind : 'unknown'`），
   * 让它裸着抛出去，"连上了但快照流不完"就会被记成 `kind: 'unknown'` ——
   * 退避照常，但错误卡片与"该不该改动本地数据"的判读全错位。
   */
  function bodyTimeoutView(
    response: Response,
    release: () => void,
    method: WebDavMethod,
    url: string,
  ): Response {
    let settled = false;
    const once = (): void => {
      if (settled) return;
      settled = true;
      release();
    };
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: async () => {
        try {
          return await response.text();
        } catch (cause) {
          throw networkError(method, url, cause);
        } finally {
          once();
        }
      },
    } as unknown as Response;
  }

  /**
   * 这一级是不是**已经存在的集合**。用 PROPFIND Depth:0 问，不写任何东西。
   *
   * 返回 false 的含义是"问不出它已就绪"，包括"确实没有"和"这台服务器不让我问"两种，
   * 调用方都按原来的逐级 MKCOL 处理 ⇒ 这个快路径只会少打请求，不会改变结果。
   * 探测本身失败（403/404/网络断了）也返回 false 而不是抛：网络真断了的话，
   * 紧接着的 MKCOL 会以同样的原因抛，错误信息里带的是**写**那一步，比"PROPFIND 挂了"有用。
   *
   * 比对 URL 时去掉尾斜杠：坚果云对 `.../ShiTab/snapshots/` 的 PROPFIND 回的 href
   * 是**不带尾斜杠**的 `/dav/.../snapshots`（真服务器实测），留着斜杠一比就永远不等，
   * 快路径形同不存在，每轮同步还是白打八个 MKCOL。
   */
  async function probeIsCollection(url: string, credential: WebDavCredential): Promise<boolean> {
    let response: Response;
    try {
      response = await request('PROPFIND', url, credential, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
    } catch {
      return false;
    }
    if (response.status !== 207 && response.status !== 200) return false;
    let body: string;
    try {
      body = await response.text();
    } catch {
      return false;
    }
    const entries = parseMultistatus(body, url);
    if (!entries) return false;
    const wanted = url.replace(/\/+$/, '');
    return entries.some((entry) => entry.isDirectory && entry.url.replace(/\/+$/, '') === wanted);
  }

  return {
    /**
     * 用 PROPFIND Depth:0 而不是 GET：它只问属性、不下载载荷，也**不写任何东西**
     * （用户在设置页点"测试连接"不该把本地数据推上去）。
     *
     * 顺带它还是"这台服务器到底会不会 WebDAV"的探针：不支持 WebDAV 的主机对 PROPFIND
     * 回 405/501，经 webDavErrorKind 得到 unsupported-method，比 GET 回 200 一页 HTML 有用。
     */
    async testConnection(url, credential) {
      const response = await request('PROPFIND', url, credential, {
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      // 207 落在 fetch 的 ok 区间（200..299）里，所以不必为它单开一支。
      if (!response.ok) throw statusError('PROPFIND', url, response.status);
    },

    /**
     * 逐级 MKCOL。405 = 已存在（RFC 4918 §9.3.1 对"在已有资源上 MKCOL"的规定答复），
     * 409 = 这一条实现把"父在、自身也在"回成冲突。两种都表示"目录现在有了"，
     * 而这条路径的语义是**确保有**，不是**必须新建** —— 把它当错误的话，
     * 第二次同步必然失败，用户看到的是"每次第二次同步都报错"。
     * 其余状态码（403/401/5xx）照旧冒泡：那些是真的没就绪。
     */
    async ensureCollection(url, credential) {
      /**
       * 稳态快路径：目录早就建好了（绝大多数轮次都是这样），一个 PROPFIND 问完就走。
       *
       * 没有这一条的话，每轮同步要对 `snapshots/` 与 `manifests/` 各打一次逐级 MKCOL，
       * 而 ShiTab 之上还有用户填的根 —— 真坚果云实测：`ensureCollection(snapshots/)` 4956ms、
       * `(manifests/)` 3002ms，光"确保目录在"就吃掉一轮同步的 8 秒，而它每次都成功、
       * 每次都什么也没新建。用户点"立即同步"看到的就是转圈十秒。
       */
      if (await probeIsCollection(url, credential)) return;
      for (const collection of collectionPathOf(url)) {
        const response = await request('MKCOL', collection, credential);
        if (response.status === 405 || response.status === 409) continue;
        if (!response.ok) {
          /**
           * MKCOL 被拒不等于"没权限"。真机第一轮就是栽在这：坚果云对**用户填的那个根**
           * （`/dav/`）回 403，而逐级建目录时我们会把它也 MKCOL 一遍 —— 于是同步在第一步
           * 就抛 forbidden，而 `ShiTab/` 从来没被建出来，后面 PUT 全变 409。
           *
           * 所以被拒时先**证一下它在不在**：PROPFIND 得到 207/200 就说明这一级已经就绪，
           * 继续往下建。证不出来才真的抛 —— 只读目录那种情况仍然会被如实报成失败，
           * 不给自己开后门。
           */
          const probe = await request('PROPFIND', collection, credential, {
            headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
            body: PROPFIND_BODY,
          });
          if (probe.status !== 207 && probe.status !== 200) {
            throw statusError('MKCOL', collection, response.status);
          }
        }
      }
    },

    /**
     * `Content-Type: application/json`：载荷**两种形状都是合法 JSON** —— 小载荷是载荷本身的
     * 原文，大载荷是 `{encoding:"gzip+base64",data:"…"}` 那一层信封（既有约定，判定在
     * `sync-data.ts` 的 `encodeWire`）。写成 octet-stream 的话部分主机拒绝落盘、
     * 类型嗅探也白搭，回一个 415。
     *
     * ⚠ 这一句在 既有约定 之前是**假的**：它写着"载荷是 gzip+base64 的文本"，而那时 PUT
     * 出去的是 `JSON.stringify(...)` 原文，10k 条那一档每推一次都是 4.13 MiB。
     * 记账的注释与线上的事实分叉了很久，谁都没发现 —— 因为两侧都没有一条用例钉"线上是什么"。
     *
     * 条件头**只在显式给了的时候**才发：`If-Match: undefined` 序列化成头会变成一个空值，
     * 服务器按"带了条件头但值不匹配"处理成 412 —— 那就是"什么都没做但一直失败"。
     */
    async put(url, body, credential, options?: WebDavRequestOptions) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options?.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
      if (options?.ifNoneMatch !== undefined) headers['If-None-Match'] = options.ifNoneMatch;

      const response = await request('PUT', url, credential, {
        headers,
        body,
        signal: options?.signal,
      });
      // 412 走 webDavErrorKind ⇒ precondition-failed：别的设备先写了，引擎据此重拉。
      if (!response.ok) throw statusError('PUT', url, response.status);

      const etag = response.headers.get('ETag');
      // 没有 ETag 就**不塞这个键**：上层用 etag 做下一轮条件写，`etag: undefined` 与缺失
      // 在 `in`/JSON round-trip 下不是一回事，塞进去会让条件写悄悄退化成永不含匹配头的普通写。
      return etag ? { etag } : {};
    },

    /**
     * 返回**文本**不是字节：port 的 `get` 契约就是 string，base64→bytes 的解码属于
     * core/domain/gzip.ts。在这里提前解码会把"传输"和"编码"两件事焊死在一层，
     * 换载荷编码就得动网络层。
     */
    async get(url, credential) {
      const response = await request('GET', url, credential);
      if (!response.ok) throw statusError('GET', url, response.status);
      return await response.text();
    },

    /**
     * HEAD 只回头部，所以 isDirectory 只能猜：先认服务器明说的 `httpd/unix-directory`，
     * 再退到尾斜杠这条 WebDAV 通行约定。我们的历史快照一律是 `.json` 文件（不带斜杠），
     * 因此不存在"文件被误判成目录"的那一侧风险。
     */
    async head(url, credential) {
      const response = await request('HEAD', url, credential);
      // 404 在 HEAD 上是**答案**不是故障："这个快照还没上传"是同步流程的正常分支。
      // 但 503/401 绝不能也走这条：那会被读成"远端文件没了"，于是本地墓碑/清理逻辑
      // 会把一次服务器抖动当成"别的设备删掉了它"。
      if (response.status === 404) return { url, exists: false, isDirectory: false };
      if (!response.ok) throw statusError('HEAD', url, response.status);

      const meta: RemoteResourceMeta = {
        url,
        exists: true,
        isDirectory:
          response.headers.get('Content-Type') === 'httpd/unix-directory' || url.endsWith('/'),
      };
      const etag = response.headers.get('ETag');
      if (etag) meta.etag = etag;
      const lastModified = parseHttpDate(response.headers.get('Last-Modified'));
      if (lastModified !== undefined) meta.lastModified = lastModified;
      const length = parseLength(response.headers.get('Content-Length'));
      if (length !== undefined) meta.contentLength = length;
      return meta;
    },

    /**
     * 列目录。状态码分三种：
     * - 207 Multi-Status：PROPFIND 的正常答复（fetch 的 ok 已覆盖它）
     * - 200：少数实现对单个资源直接回一个 multistatus/属性体
     * - 424 Failed Dependency：目录里**有一个**子资源的属性读不出来
     *   （mod_dav/Nginx 遇到坏文件就这么回）。一次列目录失败不该把整次同步判死，
     *   所以这里照样解析、只丢掉坏的条目；连一个都解不出来时返回空表而不是抛错。
     */
    async propfind(url, credential, depth) {
      const response = await request('PROPFIND', url, credential, {
        headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      const { status } = response;
      if (status !== 207 && status !== 200 && status !== 424) {
        throw statusError('PROPFIND', url, status);
      }

      const parsed = parseMultistatus(await response.text(), url);
      if (parsed === undefined) {
        if (status === 424) return [];
        // 说要给 207 结果正文解不开 = "拿到了响应但内容不对"，正是 bad-response 的定义。
        throw new WebDavError(
          'bad-response',
          'PROPFIND',
          url,
          status,
          `WebDAV PROPFIND ${url} 的响应体不是 multistatus，无法解析（HTTP ${status}）`,
        );
      }
      return parsed;
    },

    /**
     * 条件改名。412 ⇒ precondition-failed（目标已存在又没让覆盖 / Destination 不归这个域管），
     * 405/501 ⇒ unsupported-method（不少 WebDAV 主机不实现 MOVE，同步引擎据此跳过这一步而不是重试）。
     * 两张表都在 core/ports/webdav.ts，这里不重抄 —— 重抄一份就会出现"改了 port 忘了改这里"。
     * 错误里的 URL 用 `from`：调用方拿着它定位资源，而 `to` 只是这次改名的目标。
     */
    async move(from, to, overwrite, credential) {
      const response = await request('MOVE', from, credential, {
        headers: { Destination: destinationHeader(to), Overwrite: overwrite ? 'T' : 'F' },
      });
      if (!response.ok) throw statusError('MOVE', from, response.status);
    },

    /**
     * DELETE。`404` 按**幂等成功**：目标是"这里没有这个文件"，已经没有了就是达到了。
     * 把它报成失败，"清理到一半崩了"之后的重试就会永远卡在同一条早已删掉的记录上。
     *
     * 这个方法只属于返回类型里 `WebDavAdminPort` 那一半。同步引擎的 `SyncDeps.webdav`
     * 声明成 `WebDavPort`，拿不到它 ⇒ §5 规则 3/4「普通同步永不删除远端历史」
     * 是签名层面的约束，不是注释里的一句约定。
     */
    async remove(url, credential) {
      const response = await request('DELETE', url, credential, {});
      if (response.status === 404) return;
      if (!response.ok) throw statusError('DELETE', url, response.status);
    },
  };
}
