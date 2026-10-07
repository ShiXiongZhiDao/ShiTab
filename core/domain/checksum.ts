/**
 * 规范化 JSON + SHA-256（WebDAV-SYNC.md §3.1 的 `checksum`，既有约定）。
 *
 * 这里定的不是"怎么算一个哈希"，而是**同一份数据在两台设备上必须算出同一个串**。
 * checksum 同时承担三件事，任何一件都经不起"两边算出来的不一样"：
 * 1. 本地槽写入后的回读校验（写进去的和我要验的是不是同一份）；
 * 2. 损坏检测（崩溃留下的半截状态一律判无效，绝不成为同步源）；
 * 3. 远端去重（Q4：内容没变就不该新建一个不可变快照）。
 *
 * 三条会让"同一份数据算出不同串"的现实来源，都被 canonicalJson 处理掉了：
 * - **键序**：`{a,b}` 与 `{b,a}` 在 JS 里 JSON.stringify 结果不同，这里按键名排序；
 * - **undefined**：`storage.local` 落盘时是 JSON 序列化，会**丢掉**值为 undefined 的键
 *   （我们的 `categoryId?: string` 就常是 undefined）。所以这里也跳过它们，
 *   否则"从存储读回来的对象"和"写入前的对象"会算出两个 checksum；
 * - **数字**：`NaN`/`Infinity` 不是合法 JSON（stringify 成 null），这里直接抛错。
 *   宁可算不出 checksum，也不能让一个 NaN 悄悄变成"两份不同的等价数据"。
 */

/**
 * 递归编码。`seen` 只在**当前路径**上传递（不是全局 visited 集合）——
 * 共享引用不是循环，JSON.stringify 也能处理它，只有真的成环才该抛。
 */
function encode(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError(`checksum: 不接受非有限数字 ${String(value)}`);
      }
      return JSON.stringify(value);
    }
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    // 与 JSON.stringify 同构：函数 / symbol / undefined 在对象里被跳过（调用方负责），
    // 出现在数组里则降级成 null。
    case 'function':
    case 'symbol':
    case 'undefined':
      return 'null';
    case 'bigint':
      throw new TypeError('checksum: 不接受 bigint');
  }

  if (seen.has(value as object)) {
    throw new TypeError('checksum: 检测到循环引用');
  }
  const path = new Set(seen).add(value as object);

  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item, path)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  // Date 之类的自定义序列化必须照 JSON.stringify 的规矩走，否则两边不一致。
  if (typeof record.toJSON === 'function') {
    return encode((record as { toJSON(): unknown }).toJSON(), path);
  }

  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], path)}`).join(',')}}`;
}

/** 稳定序列化。抛错 = 这份数据不该被同步，不是"换个算法再试一次"。 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * SHA-256（小写十六进制）。
 *
 * `crypto.subtle` 在 MV3 的 service worker 与扩展页面里都可用（两者都是安全上下文），
 * 我在本仓库的 vitest jsdom 环境里实测也可用（`'abc'` → `ba7816bf…`，与标准向量一致）。
 * 拿不到就抛：这里不存在"退化成 FNV 之类弱哈希"的合理路径 —— checksum 是损坏检测，
 * 一个碰撞概率高的哈希会让半截数据被判成有效，那正好是这套设计要防的事。
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('checksum: crypto.subtle 不可用');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** 一份内容的身份。与它在哪个 revision、什么时候保存无关。 */
export async function checksumOf(payload: unknown): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}

/** 两个 checksum 是不是同一份内容。大小写差异按"不同"处理：串是算出来的，不是人手写的。 */
export function checksumEquals(a: string, b: string): boolean {
  return a === b;
}
