/**
 * WebDAV 边界接口（既有约定，WebDAV-SYNC.md §13）。
 *
 * 分层规矩照 既有约定：同步引擎只认**这个接口**，不认 `fetch`。
 * 理由不是教条 —— `ARCHITECTURE.md` 那条"UI 不允许直接调用 browser.storage"的同一条线，
 * 在 HTTP 上就叫"core 不允许直接调用 fetch"。网络层必须能被一个内存假服务器替换，
 * 否则 §19 那张表里"上传到一半断掉""412 条件失败"这类场景只能靠真服务器复现，
 * 而这个仓库的唯一验收通道是用户在 Edge 里重载生产产物（他那一轮看的是结果，不是竞态）。
 *
 * 路径一律传**绝对 URL**，不是相对路径。原因很实际：用户填的 baseUrl 可能是
 * `https://dav.example.com/dav/shitab`，也可能是 `https://host/`，
 * 拼相对路径的规则（斜杠有无、是否已经编码）是同步层最容易出静默 404 的地方。
 * 拼接由 `core/domain/remote-layout.ts` 一处负责，接口本身不做字符串魔法。
 */

/** 一个远端资源的存在性信息。`HEAD` 与 `PROPFIND` 都产出它。 */
export interface RemoteResourceMeta {
  /** 绝对 URL，与调用时传进去的那个一致 */
  url: string;
  exists: boolean;
  isDirectory: boolean;
  /** 服务器给的实体标签。条件请求（If-Match / If-None-Match）用它，412 也从它来。 */
  etag?: string;
  /** epoch 毫秒；解析不出 Last-Modified 时缺失（不是 0 —— 0 会被读成"1970 年改过"）。 */
  lastModified?: number;
  /** 字节数；服务器不给 content-length 时缺失。 */
  contentLength?: number;
}

export type WebDavMethod = 'GET' | 'HEAD' | 'PUT' | 'PROPFIND' | 'MKCOL' | 'MOVE' | 'DELETE';

/**
 * 错误分类。刻意把 HTTP 状态码**翻译**成语义：
 * 同步引擎要按"该怎么办"分支（要不要重试、要不要让用户重填密码、要不要重拉），
 * 而按数字分支会把服务器的实现细节变成引擎的合同。
 */
export type WebDavErrorKind =
  /** 401/407：用户名或密码不对。只能让用户改凭据，重试没有意义。 */
  | 'credentials'
  /** 403：认证过了但没权限（远端目录只读、配额、服务器策略）。 */
  | 'forbidden'
  /** 404：路径不存在。manifest 丢失走重建流程就落在这里。 */
  | 'not-found'
  /** 409：父目录不存在或状态冲突。`ensureCollection` 之后应当消失；还在就是远端结构坏了。 */
  | 'parent-conflict'
  /** 412：条件请求失败（ETag / revision 不匹配）⇒ 有别的设备先写了 ⇒ 重新拉取并处理冲突。 */
  | 'precondition-failed'
  /** 405/501：这台服务器不支持我们要的方法（不少 WebDAV 主机不实现 MOVE）。 */
  | 'unsupported-method'
  /** 5xx：服务器异常。可退避重试。 */
  | 'server'
  /** 请求没得到响应：DNS、TLS、超时、离线。与"服务器说 no"是两件事，前者不该改动本地数据。 */
  | 'network'
  /** 拿到了响应但内容不对：状态码与我们的假设矛盾（例如 200 却解不开 gzip）。 */
  | 'bad-response';

export class WebDavError extends Error {
  constructor(
    readonly kind: WebDavErrorKind,
    readonly method: WebDavMethod,
    readonly url: string,
    /** 原始状态码。`network` 时是 0 —— 不是"缺省 undefined"，因为 0 本身有信息量。 */
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `WebDAV ${method} ${url} 失败：${kind}（HTTP ${status}）`);
    this.name = 'WebDavError';
  }
}

/**
 * 状态码 → 语义。导出来是为了让它能被直接喂数字测到：
 * 分类表是整个网络层最容易被"顺手改一下"的地方，而它一改，
 * 上层"401 只报错不改本地数据"（§19）那条判据就悄悄失效了。
 *
 * 只收状态码：方法名不参与判定（同一台服务器上同一个 403 在 GET 和 PUT 上是同一个含义），
 * 而调用点已经拿着 method 在构造 `WebDavError` 了。
 */
export function webDavErrorKind(status: number): WebDavErrorKind {
  if (status === 0) return 'network';
  if (status === 401 || status === 407) return 'credentials';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'parent-conflict';
  if (status === 412) return 'precondition-failed';
  if (status === 405 || status === 501) return 'unsupported-method';
  if (status >= 500) return 'server';
  // 其余 4xx（400 请求不对、413 载荷过大、423 被锁……）统一按 bad-response：
  // 意思是"我们的假设和这台服务器对不上"，不是"权限不够"。把没分类过的状态码
  // 翻译成 'forbidden' 会让上层去提示用户改密码，那是把实现细节当结论。
  if (status >= 400) return 'bad-response';
  // 2xx/3xx 走到这里说明调用方把成功的响应喂给了错误分类器。
  return 'bad-response';
}

/** 认证信息。由调用方逐个请求带上，接口自己不碰凭据存储（既有约定：凭据不属于网络层）。 */
export interface WebDavCredential {
  username: string;
  password: string;
}

export interface WebDavRequestOptions {
  /** 条件写：只有远端当前 ETag 等于这个值才允许覆盖。防"两个设备同时写 manifest"。 */
  ifMatch?: string;
  /** 只在不存在时写：`412` 由服务器给回来，用来实现"不可变快照绝不覆盖已有文件"。 */
  ifNoneMatch?: '*' | string;
  signal?: AbortSignal;
}

export interface WebDavPort {
  /**
   * 只做"能不能连上、能不能看到我们的目录"这一件事。
   * 它**不写任何东西** —— 用户在设置页点"测试连接"不该把本地数据推上去。
   */
  testConnection(url: string, credential: WebDavCredential): Promise<void>;

  /** 逐级 MKCOL。已存在（405）算成功：这条路径是"确保有"，不是"必须新建"。 */
  ensureCollection(url: string, credential: WebDavCredential): Promise<void>;

  /** 写一个资源。`body` 是已经编码好的字符串（我们的载荷是 gzip+base64 文本）。 */
  put(
    url: string,
    body: string,
    credential: WebDavCredential,
    options?: WebDavRequestOptions,
  ): Promise<{ etag?: string }>;

  get(url: string, credential: WebDavCredential): Promise<string>;

  head(url: string, credential: WebDavCredential): Promise<RemoteResourceMeta>;

  /**
   * 列目录。`depth` 只用 1：递归列（Infinity）在快照攒到几千个文件时会把一次同步
   * 变成一台服务器上的扫描，而重建 manifest 只需要一层。
   */
  propfind(url: string, credential: WebDavCredential, depth: 0 | 1): Promise<RemoteResourceMeta[]>;

  /**
   * 条件改名。本设计里只用于"把旧 manifest 挪走再写新的"这种少数场景；
   * 远端历史快照**永远不 MOVE、不 DELETE**（§5 规则 3 与 4）。
   */
  move(
    from: string,
    to: string,
    overwrite: boolean,
    credential: WebDavCredential,
  ): Promise<void>;
}

/**
 * 破坏性操作的独立接口（既有约定 决定 4）。
 *
 * **故意不放进 `WebDavPort`**：§5 规则 3 与 4 定的是"普通同步永不删除远端历史"。
 * 如果 `remove` 只是端口的一个普通方法，那条规则就只写在注释里，靠调用方自觉 ——
 * 而"漏传一个可选参数不会编译错、也不会单测错"这一类事在这个仓库已经踩过。
 * 拆成另一个接口之后，`SyncDeps.webdav` 的类型里没有这个方法，
 * 同步引擎**拿不到删除能力**，只有显式接受 `WebDavAdminPort` 的清理用例才能拿到。
 *
 * 运行时它和 `WebDavPort` 是同一个对象；隔离是类型层面的，作用是让"谁在删远端"
 * 变成一个必须写在函数签名上的决定。
 */
export interface WebDavAdminPort {
  /**
   * 删一个资源。调用方**必须**已经落好一个当前可恢复的本地快照（§18 的前置条件），
   * 这条前置由 `snapshot-history.ts` 检查，不由这里保证。
   *
   * `404` 按幂等成功处理：目标是"这里没有东西"，已经没有了就是达到了。
   */
  remove(url: string, credential: WebDavCredential): Promise<void>;
}
