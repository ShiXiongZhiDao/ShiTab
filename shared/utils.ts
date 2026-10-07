/** 无领域知识的工具函数。有领域判断的放 core/domain/，i18n 放 shared/i18n.ts。 */

/**
 * UUID v4（DATA-MODEL §6：不用自增 ID）。
 * crypto.randomUUID 在 Chrome MV3 的 service worker 与 Firefox 112+ 均可用；
 * 保留一条 getRandomValues 兜底给更早的 Firefox。
 */
export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] ?? 0) & 0x0f;
  bytes[6] = (bytes[6] ?? 0) | 0x40;
  bytes[8] = (bytes[8] ?? 0) & 0x3f;
  bytes[8] = (bytes[8] ?? 0) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`;
}

/** 时间统一 epoch milliseconds（DATA-MODEL §6）。 */
export function now(): number {
  return Date.now();
}

/**
 * 取域名用于列表展示与搜索。无效 URL 返回 undefined —— 不猜。
 * 去掉 www. 前缀，因为用户扫列表时它是纯噪声。
 *
 * 只对**有主机概念**的协议返回：`new URL('chrome://extensions').hostname` 是
 * `"extensions"`，把它当域名显示到列表里会误导用户（那不是个网站）。
 */
const HOST_BEARING_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'sftp:', 'file:']);

export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!HOST_BEARING_PROTOCOLS.has(parsed.protocol)) return undefined;
    const host = parsed.hostname.toLowerCase();
    if (!host) return undefined; // file:// 的 hostname 是空串
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return undefined;
  }
}

/** 从标题+域名生成展示用的单字母占位（favicon 加载失败/没有时用，见原型）。 */
export function initialsOf(title: string, fallback = '?'): string {
  const trimmed = title.trim();
  if (!trimmed) return fallback;
  const first = trimmed.codePointAt(0);
  return first === undefined ? fallback : String.fromCodePoint(first).toUpperCase();
}

/**
 * 数组移动。返回**新数组**，不改入参。
 * to 以"移除之后的坐标系"计算 —— 与 HTML5 拖放里先 splice 再 insert 的直觉一致。
 */
export function moved<T>(items: T[], from: number, to: number): T[] {
  if (from === to) return [...items];
  const next = [...items];
  const [picked] = next.splice(from, 1);
  if (picked === undefined) return [...items];
  const target = Math.max(0, Math.min(next.length, to));
  next.splice(target, 0, picked);
  return next;
}

/** 等待。入口页的 debounce 重建与 tabs.move 重试都用它。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 会话标题行上那个时间戳：`2026-10-04 09:48:49`。
 *
 * 不走 Intl：`Intl.DateTimeFormat` 的字段顺序随 locale 变（en-GB 给
 * "04/10/2026, 09:48:49"，sv-SE 才是 ISO 顺序），而这一列要**按时间扫读**、
 * 也要能被测试钉住，所以手工拼 ISO 风格。（V1.1 的 既有约定 用同样的写法生成
 * 自动标题；那个标题现在不再生成，见 既有约定 —— 这个格式化器只剩展示用途。）
 *
 * 带秒：会话默认没有名字，时间戳就是它唯一的身份，两分钟内连续收纳两次也要分得开。
 */
export function clockStamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
