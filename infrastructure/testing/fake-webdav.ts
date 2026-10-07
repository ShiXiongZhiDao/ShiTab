/**
 * WebDavPort 的内存实现，只给单测用。
 *
 * 它存在的唯一理由：那几条"只能靠场景证明"的规则 —— 上传到一半断掉、412 条件失败、
 * 远端历史快照不可变 —— 用真 fetch 打真服务器复现不了，而本仓库的验收通道是
 * 用户在浏览器里重载生产产物（他看的是结果，不是竞态）。
 *
 * 三条"必须像真服务器"的纪律，缺一条这个假件就会骗过测试：
 * 1. **状态码一律经 `webDavErrorKind` 翻译**。注入的 503 若被直接写成 'server' 字符串，
 *    分类表被改坏也测不出来；走同一张表才叫"可替换的双"。
 * 2. **凭据检查先于注入的故障**。真服务器上没登录根本走不到业务逻辑；反过来排会让
 *    "密码错了"这条分支被注入表盖住。
 * 3. **集合不存在就 PUT ⇒ 409**。少这一条，同步层"忘了 ensureCollection"会绿得毫无意义。
 *
 * `calls` 记的是**真服务器会看到的动词**（`testConnection` 记成 PROPFIND、`move` 记成 MOVE），
 * 不是 port 方法名 —— 否则"断言 testConnection 没发出任何写"这类检查会随实现措辞漂移。
 */

import {
  webDavErrorKind,
  WebDavError,
  type RemoteResourceMeta,
  type WebDavCredential,
  type WebDavMethod,
  type WebDavAdminPort,
  type WebDavPort,
  type WebDavRequestOptions,
} from '@/core/ports/webdav';

/** 一条注入的故障。`status` 是唯一必填项，其余是收窄命中范围。 */
export interface FakeWebDavFault {
  /** 假件要回的状态码（经 webDavErrorKind 翻译，与真服务器同一张表） */
  status: number;
  /** 只对这一个动词发作；省略 = 队列轮到的任何动词 */
  method?: WebDavMethod;
  /** 只对这个 URL 发作；省略 = 队列轮到的任何 URL */
  url?: string;
}

export interface FakeWebDavOptions {
  /** 预置文件（绝对 URL → 文本）。写入时自动登记它的父集合，省掉"忘了 MKCOL"这种假件噪音。 */
  files?: Record<string, string>;
  /** 预置集合（建议带尾斜杠；不带也会归一成带斜杠的键） */
  collections?: string[];
  /**
   * 配了它 = "这台服务器要认证"：用户名或密码对不上就 401。
   * 省略 = 谁都放行，让不需要测凭据的用例少一层噪音。
   */
  expectedCredential?: WebDavCredential;
  /** 默认 **true**：见 `FakeWebDavPort.immutable` */
  immutable?: boolean;
  /** 这些前缀下的任何写（MKCOL/PUT/MOVE）一律 403：远端目录只读、配额、服务器策略 */
  readOnlyPrefixes?: string[];
  /** 有序故障队列：接下来的调用依次中招（"传到第 3 个快照时断掉"就是这么写的） */
  faults?: FakeWebDavFault[];
  /** 虚拟时钟起点（epoch 毫秒）。默认固定值：测试要能断言"后写的更新"，而不是跟着跑表抖。 */
  clockStart?: number;
}

export interface FakeWebDavPort extends WebDavPort, WebDavAdminPort {
  /**
   * 内存仓储本体，**按绝对 URL 键控**，值就是远端那份文本。
   * 断言"这一份到底落没落到远端"看它，而不是看 port 的返回值 ——
   * 返回值只是接口给的保证，落库才是同步引擎真正改动过的东西。
   */
  files: Map<string, string>;
  /** 已存在的集合（尾斜杠键）。propfind 列子项与 PUT 的 409 判定都读它。 */
  dirs: Set<string>;
  /** 调用轨迹，按发生顺序。 */
  calls: Array<{ method: WebDavMethod; url: string }>;
  /**
   * **按路径**注入：键是 URL、值是这一跳要回的状态码。命中一次即删除 ——
   * "GET 这个快照返回 503 一次"要的正是"第二次必须成功"，否则测不出重试收敛。
   */
  faults: Map<string, number>;
  /**
   * 有序故障队列（可直接 push，也可读剩余长度确认"队列被消费干净了"）。
   * 语义：**每一项对它下一次命中的调用发作，命中即出队**。
   * 不带 method/url 过滤时就是"第 k 次调用坏"；带过滤时是"第 k 次这种调用坏"，
   * 不匹配的调用直接越过去（所以一次 GET 不会把留给 PUT 的故障"用掉"）。
   */
  nextFaults: FakeWebDavFault[];
  /** 往有序队列追加一条。传数字 = 只写状态码的简写。 */
  nextFault(fault: FakeWebDavFault | number): void;
  /**
   * 远端历史快照不可变（§5 规则 3/4）。默认 true：
   * PUT 一个**已存在且内容不同**的路径 ⇒ `WebDavError('precondition-failed', …, 412)`。
   * 这条规则只有"默认拒绝"才测得住：假件若允许静默覆盖，任何写错路径的同步实现
   * 都能靠"PUT 总是成功"混过去。
   * manifest 这类**本来就要重写**的资源在真服务器上是会放行的，所以测它时要显式关掉
   * （`fake.immutable = false`）—— 要显式，正是为了让"覆盖历史快照"只能在测试明确表达意图时发生。
   */
  immutable: boolean;
  /** 断言辅助：某个 URL 此刻在远端的样子（不存在则 exists:false）。 */
  metaOf(url: string): RemoteResourceMeta;
}

/**
 * ETag 的串形状。真服务器给的是实现相关串（inode+mtime 之类），这里用 FNV-1a：
 * **强度无关紧要** —— 上层只比"它变没变"，从不解析内容。任何解析 etag 的代码都会在真服务器上炸，
 * 所以这个假件也刻意不给它任何可解析的结构。
 */
function makeEtag(url: string, content: string): string {
  return `"${fnv(url)}-${fnv(content)}-${content.length.toString(16)}"`;
}

function fnv(value: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < value.length; at += 1) {
    hash ^= value.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 弱标记与大小写：`W/"x"` 与 `"X"` 比较时算同一个（RFC 9110 只对 W/ 前缀不敏感）。 */
function normalizeEtag(tag: string): string {
  const trimmed = tag.trim();
  const strong = trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
  return strong.toLowerCase();
}

/**
 * 条件头匹配。`*` 的含义由调用方向决定（If-Match 的 `*` = "只要有当前版本"，
 * If-None-Match 的 `*` = "只要还没有版本"），这里只负责"当前版本存不存在、串对不对得上"。
 * 逗号分隔的多值也支持 —— 有些客户端会一次给一串。
 */
function etagMatches(current: string | undefined, condition: string): boolean {
  if (current === undefined) return false;
  const wanted = normalizeEtag(current);
  return condition
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((candidate) => (candidate === '*' ? true : normalizeEtag(candidate) === wanted));
}

const withSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`);

/** 父集合的键（尾斜杠）。没有分隔符时返回 '/'（= 根）。 */
function parentOf(url: string): string {
  const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
  const at = trimmed.lastIndexOf('/');
  return at <= 0 ? '/' : trimmed.slice(0, at + 1);
}

function originRootOf(url: string): string {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return '';
  }
}

/**
 * 逐级集合路径，**不含根**，也**不重新编码** —— 两条都与 http-webdav.ts 保持一致：
 * 对根 MKCOL 会被少数主机回 403（于是"目录已就绪"被报成没权限）；
 * 二次编码会把 `%20` 变成 `%2520`，于是写进一个"存在但永远空"的新目录。
 * 这里必须自己算一份而不是复用适配器：假件的前提就是"不经过 fetch"。
 */
function collectionPathOf(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [withSlash(url)];
  }
  const out: string[] = [];
  let path = '/';
  for (const segment of parsed.pathname.split('/').filter(Boolean)) {
    path += `${segment}/`;
    out.push(`${parsed.origin}${path}`);
  }
  return out;
}

/** 字节数而不是字符数：上层若拿 contentLength 做体积/去重判断，UTF-16 长度会在中文载荷上骗过测试。 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function createFakeWebDav(options?: Partial<FakeWebDavOptions>): FakeWebDavPort {
  const files = new Map<string, string>(Object.entries(options?.files ?? {}));
  const dirs = new Set<string>((options?.collections ?? []).map(withSlash));
  const attrs = new Map<string, { etag: string; lastModified: number }>();
  const calls: Array<{ method: WebDavMethod; url: string }> = [];
  const faults = new Map<string, number>();
  const nextFaults: FakeWebDavFault[] = [...(options?.faults ?? [])];
  const expectedCredential = options?.expectedCredential;
  const readOnlyPrefixes = options?.readOnlyPrefixes ?? [];

  // 虚拟时钟：每次写 +1000ms。用 Date.now() 的话"后写的 lastModified 一定更大"
  // 这条断言会在同一毫秒内随机失败，而它正是冲突判定的测试支点。
  let tick = options?.clockStart ?? 1_700_000_000_000;
  const stamp = (): number => (tick += 1000);

  for (const [url, body] of Object.entries(options?.files ?? {})) {
    for (const collection of collectionPathOf(parentOf(url))) dirs.add(collection);
    attrs.set(url, { etag: makeEtag(url, body), lastModified: stamp() });
  }

  /** 唯一的抛错出口：状态码 → kind 走 port 那张表，不在这里另立一套。 */
  function fail(method: WebDavMethod, url: string, status: number, why: string): never {
    throw new WebDavError(
      webDavErrorKind(status),
      method,
      url,
      status,
      `假 WebDAV ${method} ${url}：${why}（HTTP ${status}）`,
    );
  }

  function authorize(method: WebDavMethod, url: string, credential: WebDavCredential): void {
    if (!expectedCredential) return;
    if (
      credential.username !== expectedCredential.username ||
      credential.password !== expectedCredential.password
    ) {
      fail(method, url, 401, '凭据与服务器配置的 expectedCredential 不一致');
    }
  }

  /**
   * 有序队列先于按路径的表：队列描述的是"第 k 次调用坏"，测试按调用顺序读它才不迷。
   * 命中即出队 —— 留在队列里会下一次再炸一遍，那就变成"永久故障"，
   * 而"永久故障"该用别的方式表达（这个假件不该有隐式的黏性状态）。
   */
  function injectFault(method: WebDavMethod, url: string): void {
    const at = nextFaults.findIndex(
      (fault) =>
        (fault.method === undefined || fault.method === method) &&
        (fault.url === undefined || fault.url === url),
    );
    if (at !== -1) {
      const fault = nextFaults[at];
      nextFaults.splice(at, 1);
      if (fault) fail(method, url, fault.status, '命中有序故障队列');
    }
    const status = faults.get(url);
    if (status !== undefined) {
      faults.delete(url);
      fail(method, url, status, `命中 ${url} 上的注入状态`);
    }
  }

  function enter(method: WebDavMethod, url: string, credential: WebDavCredential): void {
    calls.push({ method, url });
    authorize(method, url, credential);
    injectFault(method, url);
  }

  function assertWritable(method: WebDavMethod, url: string): void {
    const blocked = readOnlyPrefixes.find((prefix) => url.startsWith(prefix));
    if (blocked !== undefined) fail(method, url, 403, `${blocked} 是只读前缀`);
  }

  /** 根按定义存在（与 collectionPathOf 不建根是同一条约定，两边不一致会导致假件比真服务器更严）。 */
  function hasParent(url: string): boolean {
    const parent = parentOf(url);
    return parent === originRootOf(url) || parent === '/' || dirs.has(parent);
  }

  function fileMeta(url: string): RemoteResourceMeta {
    const attr = attrs.get(url);
    const meta: RemoteResourceMeta = { url, exists: true, isDirectory: false };
    if (attr) {
      meta.etag = attr.etag;
      meta.lastModified = attr.lastModified;
      meta.contentLength = byteLength(files.get(url) ?? '');
    }
    return meta;
  }

  function dirMeta(url: string): RemoteResourceMeta {
    return { url: withSlash(url), exists: true, isDirectory: true };
  }

  /**
   * 直接子项。集合键自带尾斜杠，所以"是不是孙子"要先把那个斜杠摘掉再判断 ——
   * 直接对含斜杠的键 `includes('/')` 会把每个子集合都当成孙子，
   * 后果是 propfind(depth:1) 永远返回只剩自己的表，manifest 重建看起来像"远端被清空了"。
   */
  function directChildren(dirKey: string): string[] {
    const subDirs = [...dirs].filter((key) => {
      if (key === dirKey || !key.startsWith(dirKey)) return false;
      const rest = key.slice(dirKey.length, -1);
      return rest.length > 0 && !rest.includes('/');
    });
    const childFiles = [...files.keys()].filter((url) => {
      if (!url.startsWith(dirKey)) return false;
      const rest = url.slice(dirKey.length);
      return rest.length > 0 && !rest.includes('/');
    });
    return [...subDirs, ...childFiles].sort();
  }

  const fake: FakeWebDavPort = {
    files,
    dirs,
    calls,
    faults,
    nextFaults,
    nextFault(fault) {
      nextFaults.push(typeof fault === 'number' ? { status: fault } : fault);
    },
    immutable: options?.immutable ?? true,

    metaOf(url) {
      if (files.has(url)) return fileMeta(url);
      if (dirs.has(withSlash(url))) return dirMeta(withSlash(url));
      return { url, exists: false, isDirectory: false };
    },

    /** PROPFIND Depth:0：看得见这个路径 = 连得上。不写任何东西。 */
    async testConnection(url, credential) {
      enter('PROPFIND', url, credential);
      if (files.has(url) || dirs.has(withSlash(url))) return;
      fail('PROPFIND', url, 404, '目录或文件不存在');
    },

    /** 逐级建集合。已存在是 no-op 成功（这条路径的语义是"确保有"，不是"必须新建"）。 */
    async ensureCollection(url, credential) {
      for (const collection of collectionPathOf(url)) {
        enter('MKCOL', collection, credential);
        assertWritable('MKCOL', collection);
        // MKCOL 打在文件上：真服务器回 409（路径被别的东西占着），绝不是"覆盖它"。
        const asFile = collection.endsWith('/') ? collection.slice(0, -1) : collection;
        if (files.has(asFile) || files.has(collection)) {
          fail('MKCOL', collection, 409, '同一路径上已经是一个文件');
        }
        dirs.add(collection);
      }
    },

    /**
     * 写一个资源。判定顺序是刻意的：**调用方显式给的条件头**先于**假件自己的不可变规则** ——
     * 前者是真服务器一定会给出的 412，后者是我们额外加的纪律；反过来排会让 if-match 的
     * 失败原因被不可变盖掉，测试里就看不出到底是谁拦的。
     */
    async put(url, body, credential, options?: WebDavRequestOptions) {
      enter('PUT', url, credential);
      assertWritable('PUT', url);
      if (dirs.has(withSlash(url))) fail('PUT', url, 409, '集合不能被一个请求体整体覆盖');
      if (!hasParent(url)) fail('PUT', url, 409, '父集合还没 MKCOL');

      const current = files.get(url);
      const currentEtag = attrs.get(url)?.etag;

      if (options?.ifNoneMatch !== undefined) {
        // If-None-Match = "当前版本存在且对得上就别写"。`*` 时只要文件在就 412。
        if (current !== undefined && etagMatches(currentEtag, options.ifNoneMatch)) {
          fail('PUT', url, 412, 'If-None-Match 命中：远端已经有内容');
        }
      }
      if (options?.ifMatch !== undefined) {
        // 资源不存在时 If-Match 也给 412 而不是 404：RFC 9110 两边都允许，但上层对 404 的分支
        // 是"重建 manifest"，把"etag 没对上"送进那条分支会静默写出一份新 manifest、
        // 丢掉别的设备的更新。412 至少逼它重新拉一次再判。
        if (current === undefined || !etagMatches(currentEtag, options.ifMatch)) {
          fail('PUT', url, 412, 'If-Match 与远端当前 ETag 不一致');
        }
      }

      if (current === body) {
        // 同内容重写 = 幂等：**不**换 etag、**不**动 lastModified。
        // 否则"内容没变就不该新建快照"那条判定在假件上永远不成立。
        return currentEtag === undefined ? {} : { etag: currentEtag };
      }
      if (current !== undefined && fake.immutable) {
        fail('PUT', url, 412, '不可变路径上的内容不同（远端历史快照不许覆盖）');
      }

      const etag = makeEtag(url, body);
      files.set(url, body);
      attrs.set(url, { etag, lastModified: stamp() });
      return { etag };
    },

    async get(url, credential) {
      enter('GET', url, credential);
      if (dirs.has(withSlash(url))) {
        // 真服务器在这儿回的是一页 HTML，喂给 gzip+base64 解码只会得到 bad-response；
        // 提前用 405 挑明"你对集合发了取载荷的请求"。
        fail('GET', url, 405, '集合没有可读的载荷体');
      }
      const body = files.get(url);
      if (body === undefined) fail('GET', url, 404, '没有这个资源');
      return body;
    },

    /** 404 在这里是**答案**不是故障：`exists:false`，让上层自己分"没传过"和"传过但坏了"。 */
    async head(url, credential) {
      enter('HEAD', url, credential);
      if (files.has(url)) return fileMeta(url);
      if (dirs.has(withSlash(url))) return dirMeta(url);
      return { url, exists: false, isDirectory: false };
    },

    /** 列集合。集合自身**永远**是第一条，与真服务器一致（上层靠它判断"目录在不在"）。 */
    async propfind(url, credential, depth) {
      enter('PROPFIND', url, credential);
      const dirKey = withSlash(url);
      if (dirs.has(dirKey)) {
        const entries: RemoteResourceMeta[] = [dirMeta(dirKey)];
        // depth 0 只回自己：攒了几千个快照时递归列举会把一次同步变成一台服务器上的扫描。
        if (depth === 1) {
          for (const child of directChildren(dirKey)) {
            entries.push(files.has(child) ? fileMeta(child) : dirMeta(child));
          }
        }
        return entries;
      }
      if (files.has(url)) return [fileMeta(url)];
      fail('PROPFIND', url, 404, '目录或文件不存在');
    },

    /**
     * 条件改名。目标已存在且没让覆盖 ⇒ 412；源不存在 ⇒ 404；目标父集合不存在 ⇒ 409。
     * 移动集合时把它**整棵子树**一起换键 —— 只改目录名却留下旧路径下的子项，
     * propfind 会列出一堆 HEAD 说"不存在"的孩子，那是假件自己造的鬼数据。
     */
    /**
     * DELETE。与真实现同一条语义：`404` 是幂等成功。
     * 目录**不许**在有子项时删 —— 假要是宽容地级联删掉，清理逻辑里"只删旧快照、
     * 绝不碰目录"这条判据就测不出破了会怎样。
     */
    async remove(url, credential) {
      enter('DELETE', url, credential);
      assertWritable('DELETE', url);
      const dirKey = withSlash(url);
      if (dirs.has(dirKey)) {
        if (directChildren(dirKey).length > 0) fail('DELETE', url, 409, '目录非空');
        dirs.delete(dirKey);
        return;
      }
      if (!files.has(url)) return; // 幂等：已经没有就算成功
      files.delete(url);
    },

    async move(from, to, overwrite, credential) {
      enter('MOVE', from, credential);
      assertWritable('MOVE', from);
      assertWritable('MOVE', to);

      if (files.has(to) && !overwrite) fail('MOVE', from, 412, '目标已存在且 Overwrite: F');
      if (!hasParent(to)) fail('MOVE', from, 409, '目标父集合不存在');

      const body = files.get(from);
      if (body !== undefined) {
        files.delete(from);
        attrs.delete(from);
        const etag = makeEtag(to, body);
        files.set(to, body);
        attrs.set(to, { etag, lastModified: stamp() });
        return;
      }

      const fromKey = withSlash(from);
      if (dirs.has(fromKey)) {
        const toKey = withSlash(to);
        const movedFiles = [...files.keys()].filter((url) => url.startsWith(fromKey));
        const movedDirs = [...dirs].filter((key) => key.startsWith(fromKey) && key !== fromKey);
        for (const url of movedFiles) {
          const content = files.get(url) as string;
          const target = `${toKey}${url.slice(fromKey.length)}`;
          files.delete(url);
          attrs.delete(url);
          const etag = makeEtag(target, content);
          files.set(target, content);
          attrs.set(target, { etag, lastModified: stamp() });
        }
        for (const key of movedDirs) {
          dirs.add(`${toKey}${key.slice(fromKey.length)}`);
          dirs.delete(key);
        }
        // 自身也要登记到新键上：只搬子树不搬目录等于把整个集合删掉了。
        dirs.delete(fromKey);
        dirs.add(toKey);
        return;
      }

      fail('MOVE', from, 404, '源不存在');
    },
  };

  return fake;
}

/** 测试里省一遍字面量：绝大多数用例只关心"对不对得上这台服务器"。 */
export const FAKE_CREDENTIAL: WebDavCredential = { username: 'fake-user', password: 'fake-pass' };
