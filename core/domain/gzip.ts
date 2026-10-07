/**
 * gzip + base64 编解码（既有约定 决定 2）。
 *
 * 为什么要有这个文件：WebDAV-SYNC.md §3 的双槽方案是按**单体 state.json** 写的，
 * 而本仓库是 既有约定 的分键布局。我按 既有约定 的口径造了同规模合成数据实测：
 * 1,000 组 / 10,000 tab 的 JSON 是 **4.46 MiB**（它记的实测值是 4.58 MiB，对得上），
 * gzip 之后 **0.38 MiB**（8.5%），再 base64 是 0.50 MiB。
 * `storage.local` 的配额是 `QUOTA_BYTES = 10,485,760` 且本仓库不申请 `unlimitedStorage`，
 * 所以"未压缩的全量双槽"在 PRD §142 自己写的目标体量上会超配额 —— 压缩是双槽能成立的前提，
 * 不是优化项。
 *
 * ⚠ 8.5% 这个比例**偏乐观**：合成数据的域名和标题是模板生成的，真实数据的熵更高。
 * 我在 既有约定 里按 25% 做预算（10k tab → 约 1.5 MiB / 槽），这样最坏情况也算得过来。
 */

/** 单次入队的字节数。太大没有意义，太小会让 reader 循环跑几千圈。 */
const CHUNK_BYTES = 64 * 1024;

/** base64 拼接时的步长：`String.fromCharCode` 的参数个数有上限，必须分片。 */
const B64_STEP = 8192;

/**
 * 自己造 ReadableStream，**不用** `Blob.prototype.stream()`。
 *
 * 不是洁癖：我在本仓库的 vitest jsdom 环境里实测 `new Blob([json]).stream()` 抛
 * `TypeError: (intermediate value).stream is not a function` —— jsdom 的 Blob 没有 stream()。
 * 用 Blob 当管道入口的实现能在真浏览器里跑、在测试里当场炸，而这套压缩恰恰是
 * 双槽与远端去重的基础，必须有测试。
 */
function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK_BYTES, bytes.length - offset);
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset += size;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.byteLength;
  }
  return merged;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += B64_STEP) {
    const slice = bytes.subarray(at, at + B64_STEP);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** gzip 变换的输入输出对。两个构造器的返回值都是这个形状。 */
type DuplexStream = { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };

async function transform(bytes: Uint8Array, direction: 'compress' | 'decompress'): Promise<Uint8Array> {
  // 显式取全局再判空：这个环境缺哪个就报哪个的名字，别写出 "undefined is not a constructor"。
  const Ctor = direction === 'compress' ? globalThis.CompressionStream : globalThis.DecompressionStream;
  if (!Ctor) {
    throw new Error(`压缩不可用：当前环境没有 ${direction === 'compress' ? 'CompressionStream' : 'DecompressionStream'}`);
  }
  /**
   * 这个 cast 是**类型层面的**，不是运行时妥协。
   * DOM 库把 `CompressionStream.writable` 声明成 `WritableStream<BufferSource>`，
   * 而 `pipeThrough` 要求它正好接受源流的元素类型（`Uint8Array`），
   * 于是 `BufferSource`（含裸 `ArrayBuffer`）让这两个签名在 TS 的不变性规则下对不上。
   * 运行时它照收 `Uint8Array` 不误 —— 传进去的就是 `Uint8Array`。
   */
  const pair = new Ctor('gzip') as unknown as DuplexStream;
  return collect(streamFromBytes(bytes).pipeThrough(pair));
}

/** UTF-8 → gzip → base64。存进 storage.local 的就是这个字符串。 */
export async function gzipToBase64(text: string): Promise<string> {
  const bytes = await transform(new TextEncoder().encode(text), 'compress');
  return bytesToBase64(bytes);
}

/** base64 → gunzip → UTF-8。解不开就抛：调用方按"这一槽无效"处理，不做任何猜测。 */
export async function base64FromGzip(encoded: string): Promise<string> {
  const bytes = await transform(base64ToBytes(encoded), 'decompress');
  return new TextDecoder().decode(bytes);
}
