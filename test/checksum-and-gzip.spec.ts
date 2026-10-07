// SHA-256 与 gzip 这条原语链在真机上由 background service worker 执行，
// 所以这里跑在 node 环境：`crypto.subtle` / `CompressionStream` / `btoa` 到底是不是
// worker 那一档全局，node 是最接近的替身，而 jsdom 会替它们兜住（既有约定 的教训）。
// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { canonicalJson, checksumEquals, checksumOf, sha256Hex } from '@/core/domain/checksum';
import { base64FromGzip, gzipToBase64 } from '@/core/domain/gzip';
import { groupFixture, savedTabFixture } from './fixtures';

describe('规范化 JSON 与 SHA-256', () => {
  it('标准向量：空串与 "abc" 的 SHA-256 必须是官方值', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('键序不同 = 同一份内容（排序是 checksum 的契约，不是风格）', async () => {
    const a = await checksumOf({ title: 'x', url: 'https://e.com', locked: false });
    const b = await checksumOf({ locked: false, url: 'https://e.com', title: 'x' });
    expect(a).toBe(b);
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('undefined 的键被跳过：与 storage.local 落盘后再读回来的对象算出同一个 checksum', async () => {
    const before = { id: 'g1', categoryId: undefined, tabs: [] };
    // 模拟存储往返：JSON 序列化会整个丢掉值为 undefined 的键
    const afterRoundTrip = JSON.parse(JSON.stringify(before)) as Record<string, unknown>;
    expect('categoryId' in afterRoundTrip).toBe(false);
    expect(await checksumOf(before)).toBe(await checksumOf(afterRoundTrip));
  });

  it('数组顺序参与 checksum（sortOrder 变了就是不同的数据）', async () => {
    expect(await checksumOf([1, 2])).not.toBe(await checksumOf([2, 1]));
  });

  it('NaN / Infinity 直接抛：宁可算不出来，也不让一个非有限数字变成两份"等价"数据', async () => {
    await expect(checksumOf({ createdAt: Number.NaN })).rejects.toThrow(/非有限数字/);
    await expect(checksumOf({ createdAt: Number.POSITIVE_INFINITY })).rejects.toThrow(/非有限数字/);
  });

  it('循环引用抛错而不是栈溢出', async () => {
    const loop: Record<string, unknown> = { id: 'x' };
    loop.self = loop;
    await expect(checksumOf(loop)).rejects.toThrow(/循环引用/);
  });

  it('共享引用不是循环：同一个对象出现在两处要能算', async () => {
    const shared = { name: '同一个分类' };
    await expect(checksumOf([shared, shared])).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('checksumEquals 大小写敏感：串是算出来的，不是人手抄的', () => {
    expect(checksumEquals('AB', 'ab')).toBe(false);
    expect(checksumEquals('ab', 'ab')).toBe(true);
  });
});

describe('gzip + base64', () => {
  it('往返一致（含中文与 emoji）', async () => {
    const text = JSON.stringify({ t: '标签组 · 一些中文', e: '🙂', u: 'https://example.com/a?b=1' });
    expect(await base64FromGzip(await gzipToBase64(text))).toBe(text);
  });

  it('空串也能往返', async () => {
    expect(await base64FromGzip(await gzipToBase64(''))).toBe('');
  });

  it('输出是纯 base64：能直接当 storage.local 的值，不需要第二个编码层', async () => {
    const encoded = await gzipToBase64('hello hello hello hello');
    expect(/^[A-Za-z0-9+/=]+$/.test(encoded)).toBe(true);
  });

  /**
   * 这条测的是**为什么要有这个文件**（既有约定 决定 2）：
   * 未压缩的全量双槽在 PRD 目标体量上会撞 `QUOTA_BYTES = 10,485,760`。
   * 判据取我实测的 10k tab 规模，并允许 25% 的保守膨胀率 —— 真实数据的熵比合成数据高，
   * 所以这里钉的是"压缩后仍然放得下"，不是"压缩率正好 8.5%"。
   */
  it('1,000 组 / 10,000 tab 压缩后仍远小于配额', async () => {
    const groups = Array.from({ length: 1000 }, (_, g) => {
      const id = `g${g}`;
      const tabs = Array.from({ length: 10 }, (_, t) => savedTabFixture(id, `g${g}-t${t}`, t));
      return groupFixture(`会话 ${g} · Mixed 标题 with some English words here`, tabs, { sortOrder: 1000 - g });
    });
    const json = JSON.stringify({ groups });
    const rawBytes = new TextEncoder().encode(json).length;
    const encoded = await gzipToBase64(json);
    const ratio = encoded.length / rawBytes;

    // 合成数据本身应当落在 4–5 MiB 这一档（既有约定 实测 4.58 MiB）
    expect(rawBytes / 1048576).toBeGreaterThan(3.5);
    expect(rawBytes / 1048576).toBeLessThan(6);
    // 保守预算：最坏 25% ⇒ 一槽 1.5 MiB，双槽 3 MiB，加分键主存储 4.5 MiB 仍在 10 MiB 内
    expect(ratio, `压缩比 ${ratio.toFixed(3)} 超出了 25% 的预算`).toBeLessThan(0.25);
    expect((rawBytes + encoded.length * 2) / 1048576).toBeLessThan(10);
  });

  /**
   * 回收站进同步之后，一份载荷的最坏形状是"活的会话都在，
   * 7 天内删掉的也都还在"。这条把它测出来，是为了让 既有约定 里那句"配额仍然放得下"
   * 是一个**实测数**，不是照着 0.20 MiB 心算的两倍。
   */
  it('活的全在 + 回收站也全在：压缩后仍远小于 10 MiB', async () => {
    const groups = Array.from({ length: 1000 }, (_, g) => {
      const id = `g${g}`;
      const tabs = Array.from({ length: 10 }, (_, t) => savedTabFixture(id, `g${g}-t${t}`, t));
      return groupFixture(`会话 ${g} · Mixed 标题 with some English words here`, tabs, { sortOrder: 1000 - g });
    });
    const trash = Array.from({ length: 1000 }, (_, g) => {
      // 另一半是"这周内被删掉的"，它们**不是**上面那些对象的副本：真实数据里被删的会话
      // 与活着的会话是两批不同的 URL。直接复用同一批对象会让 gzip 白捡一次"整段重复"，
      // 量出来的压缩后尺寸会偏小，那就是在给自己作假证据。
      const id = `d${g}`;
      const tabs = Array.from({ length: 10 }, (_, t) => savedTabFixture(id, `d${g}-t${t}`, t));
      return {
        group: groupFixture(`已删会话 ${g} · Mixed 标题 with some English words here`, tabs, { id, sortOrder: g }),
        deletedAt: 1_700_000_000_000 + g,
        expiresAt: 1_700_000_600_000 + g,
        reason: 'user-delete' as const,
      };
    });
    const json = JSON.stringify({ groups, trash });
    const rawBytes = new TextEncoder().encode(json).length;
    const encoded = await gzipToBase64(json);

    // 实测（2026-10-05）：raw 8.02 MiB · gzip+base64 0.39 MiB · 压缩比 4.83%
    expect(rawBytes / 1048576).toBeGreaterThan(7);
    expect(encoded.length / rawBytes).toBeLessThan(0.25);
    // 分键主存储放的是未压缩的那一份（8.02），双槽放的是压缩后的（2 × 0.39）⇒ 最坏 8.8 MiB
    expect((rawBytes + encoded.length * 2) / 1048576).toBeLessThan(10);
  });

  it('解不开就抛：坏槽必须被判成无效，不能被"尽力解出一些东西"', async () => {
    const good = await gzipToBase64('{"a":1}');
    const tampered = `${good.slice(0, good.length - 8)}AAAAAAAA`;
    await expect(base64FromGzip(tampered)).rejects.toThrow();
    await expect(base64FromGzip('这不是 base64 !!!')).rejects.toThrow();
  });
});
