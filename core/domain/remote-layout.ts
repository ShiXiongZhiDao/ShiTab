/**
 * 远端路径的拼接。
 *
 * 这是同步层最容易出**静默 404** 的一处，所以单独成一个文件并且可单测：
 * 用户填的 baseUrl 可能是 `https://dav.example.com/`，可能是
 * `https://host/dav/ShiTab`（已经把目录写进去了），也可能带中文或空格
 * （Nextcloud 的 `https://cloud/x/远程文件/shitab` 是真会出现的形状）。
 * 拼接规则一旦散落在调用点，就会出现"在某些主机上永远 404，而本地一切正常"。
 *
 * 三条固定规矩：
 * 1. **不重复编码**：`new URL()` 会保留已经编码好的 `%20`，而手工 `encodeURIComponent`
 *    整个路径会把已有的 `%` 变成 `%25` —— 那是同一条路径的第二个名字，服务器认为是两个文件。
 * 2. **斜杠归一**：base 结尾的斜杠可有可无，中间绝不允许出现 `//`（有的服务器会 301 到
 *    另一个资源，于是写进去和读回来不是同一个文件）。
 * 3. **只在 URL 构造失败时报错**：这里不猜"用户大概想写什么"。
 */

import {
  REMOTE_MANIFESTS_FOLDER,
  REMOTE_OWNER_FOLDER,
  REMOTE_ROOT_FOLDER,
  REMOTE_SNAPSHOTS_FOLDER,
} from '@/shared/constants';

/** 用户填进来的地址不合法。`reason` 直接进 UI 文案，所以它必须是能给人看的那几种。 */
export type BaseUrlRejection = 'empty' | 'not-a-url' | 'unsupported-scheme' | 'no-host';

export type BaseUrlOutcome = { ok: true; url: URL } | { ok: false; reason: BaseUrlRejection };

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * 校验并规范化用户填的 WebDAV 地址。
 *
 * 故意**不接受** `file:` / `ftp:` / `chrome:`：这些既不是 WebDAV，也不能被
 * `permissions.request()` 授予，放行只会让后面的 fetch 报一个更难懂的网络错。
 */
export function parseBaseUrl(raw: string): BaseUrlOutcome {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'empty' };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'not-a-url' };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return { ok: false, reason: 'unsupported-scheme' };
  if (!url.hostname) return { ok: false, reason: 'no-host' };
  return { ok: true, url };
}

/**
 * 是不是明文 http。
 *
 * 单独一个判据是因为 Q11 的 UI 要它：局域网 NAS 常是明文 http，我们不禁止它，
 * 但必须让用户勾一次"我知道是明文传输" —— 标签 URL 与标题是会被路上任何人读到的内容。
 */
export function isInsecureHttp(url: URL): boolean {
  return url.protocol === 'http:';
}

/**
 * 要申请的主机权限模式（`permissions.request({origins:[...]})`）。
 *
 * 用 `<scheme>://<host>/*` 而不是整个 origin 字符串：match pattern 才是权限系统认的单位，
 * 只给 `https://host` 在部分实现里会被判成"没有路径可访问"，
 * 于是权限请求成功、fetch 仍然被 CORS 拦 —— 那种"授权了但不好使"最难查。
 */
export function toOriginPattern(url: URL): string {
  const scheme = url.protocol.replace(':', '');
  return `${scheme}://${url.host}/*`;
}

/** 去掉结尾多余的斜杠。留一个就够，`//` 是另一回事。 */
function trimTrailingSlashes(text: string): string {
  return text.replace(/\/+$/, '');
}

function append(base: URL, segments: string[]): URL {
  // 用 pathname 拼，再交给 URL 归一：query 与 hash 不参与目录结构（用户不该在 baseUrl 带它们，
  // 但真带了也不该污染成 `.../snapshots?a=1/xxx.json` 这种必然 404 的形状）。
  const joined = [trimTrailingSlashes(base.pathname), ...segments].join('/');
  const rebuilt = new URL(base.toString());
  rebuilt.search = '';
  rebuilt.hash = '';
  rebuilt.pathname = joined.startsWith('/') ? joined : `/${joined}`;
  return rebuilt;
}

/**
 * 挂在用户地址后面的那几段目录：**归属目录 + 应用目录**（`ShiXiongZhiDao/ShiTab`），
 * 但**已经在地址里出现过的就别再拼一遍**。
 *
 * 这条"幂等"不是洁癖，是一条数据保护：用户把地址填到归属目录那一层（`https://…/dav/ShiXiongZhiDao`）时，
 * 无条件拼就得到 `/dav/ShiXiongZhiDao/ShiXiongZhiDao/ShiTab/` —— 那是**一个全新的空库**，
 * 而真正那份还在原地。用户看到的现象是"远端历史突然空了、同步又从零开始攒 revision"，
 * 旧数据没丢但再也认不出来。（这个双拼路径在真实主机上打到过，回的就是 404。）
 *
 * 三条判据按**路径最后一段**精确匹配，刻意不做大小写折叠：WebDAV 的路径多数是大小写敏感的，
 * 把 `/dav/shixiongzhidao` 当成 `/dav/ShiXiongZhiDao` 会让我们在区分大小写的主机上
 * 读一个、写另一个 —— 那是"两份历史各自长"的静默故障，比双拼更难查。
 */
export function rootSegments(base: URL): string[] {
  const parts = base.pathname.split('/').filter(Boolean);
  const tail = parts[parts.length - 1];
  if (tail === undefined) return [REMOTE_OWNER_FOLDER, REMOTE_ROOT_FOLDER];
  if (tail === REMOTE_ROOT_FOLDER) return [];
  if (tail === REMOTE_OWNER_FOLDER) return [REMOTE_ROOT_FOLDER];
  return [REMOTE_OWNER_FOLDER, REMOTE_ROOT_FOLDER];
}

/**
 * 根目录：`<baseUrl>/ShiXiongZhiDao/ShiTab/`（地址里已写过的那一段不会重复拼）。
 *
 * 只有这一条带尾斜杠，`snapshotsDirUrl` / `manifestsDirUrl` 不带 —— 不是手滑：
 * 根这条 URL 的用途是**给人看落点**（同步面板那一行），目录的规范写法就该带斜杠，
 * 坚果云自己的网页里也是这个形状；而那两条是喂给 `ensureCollection` / `propfind` 的，
 * 今天已经按不带斜杠的形状在真服务器上验过（PUT/GET/列目录全通），没必要为了好看重开一次验证。
 * 读它们的地方都做了尾斜杠归一（`probeIsCollection` 两侧都剥掉）。
 */
export function remoteRootUrl(base: URL): URL {
  const root = append(base, rootSegments(base));
  root.pathname = `${root.pathname}/`;
  return root;
}

export function snapshotsDirUrl(base: URL): URL {
  return append(base, [...rootSegments(base), REMOTE_SNAPSHOTS_FOLDER]);
}

export function manifestsDirUrl(base: URL): URL {
  return append(base, [...rootSegments(base), REMOTE_MANIFESTS_FOLDER]);
}

/**
 * 快照的文件名身份 = **内容的前 32 位十六进制**（既有约定 决定 3）。
 *
 * 不用随机 UUID 的理由是一条具体的故障：上传快照成功、写 manifest 那一步崩了，
 * 下一轮如果用 `crypto.randomUUID()` 重新生成一个 id，就会把**同一份内容**再存一遍，
 * 而 §18 定的是"历史快照永不自动删除" —— 于是不可变历史会被同一份状态反复塞满，
 * 而且没有任何东西能把它认出来是重复。
 * 内容寻址之后，同内容 → 同文件名 → `If-None-Match: *` 直接由服务器告诉我们"已经有了"，
 * 去重在文件系统这一层就完成，不依赖客户端记得先比一次 checksum。
 */
export function snapshotIdFor(stateChecksum: string): string {
  return stateChecksum.slice(0, 32);
}

/** 快照文件名只由 snapshotId 决定：十六进制是 URL 安全的，不需要再编码一次。 */
export function snapshotUrl(base: URL, snapshotId: string): URL {
  return append(snapshotsDirUrl(base), [`${snapshotId}.json`]);
}

/** manifest 按 revision 命名，所以"最新是哪一版"能靠扫目录名重建，而不必读文件内容。 */
export function manifestUrl(base: URL, revision: number): URL {
  return append(manifestsDirUrl(base), [`revision-${revision}.json`]);
}

/** 从 manifest 文件名里读 revision。认不出来的返回 null —— 目录里可能有用户自己的文件。 */
export function revisionFromUrl(url: string): number | null {
  const matched = /revision-(\d+)\.json$/i.exec(url);
  if (!matched) return null;
  const parsed = Number(matched[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 从快照文件名里读 snapshotId。同样：认不出来就是 null，不是抛。 */
export function snapshotIdFromUrl(url: string): string | null {
  // 32 位十六进制 = 内容寻址的 id（见 snapshotIdFor）。刻意不匹配 UUID：
  // 认成 UUID 会让"上一版实现留下的随机名文件"被扫进重建流程，
  // 而它的 id 与内容不再对应，验 checksum 时那一条必然作废 —— 白下载一次。
  const matched = /\/([0-9a-f]{32})\.json$/i.exec(url);
  return matched?.[1] ?? null;
}
