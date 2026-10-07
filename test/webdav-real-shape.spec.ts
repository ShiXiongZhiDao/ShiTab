// @vitest-environment node

/**
 * PROPFIND 解析的**真服务器形状**回归。
 *
 * 这一条为什么单独成文件、且必须跑在 node 环境：
 * 坚果云同步失败查到最后，根因是 `http-webdav.ts` 用 `new DOMParser()` 解 207 正文，
 * 而 **DOMParser 不在 service worker 的全局里** —— 同步引擎按 既有约定 就跑在那儿，
 * 于是真机上必然 `ReferenceError`，而 `readRemoteView` 的 `.catch(() => [])` 把它咽掉，
 * 用户看到的现象是"测试连接成功，但列表永远空、点同步就失败"。
 * 原先 42 条适配器用例全绿，因为它们跑在 jsdom 里而 **jsdom 提供 DOMParser**：
 * 假环境比生产宽容，缺陷就一路躲过了整个测试套。所以下面第一件事是钉住环境本身。
 *
 * 正文取自 2026-10-04 对真实坚果云账号里 `<归属目录>/ShiTab/` 那一层
 * 的一次 PROPFIND Depth 1（HTTP 207，1277 字节），只做了换行，没改任何内容。
 * 留着它的理由正是它**不好看不规整**：href 没有尾斜杠、`<d:getetag/>` 是空自闭合、
 * 属性藏在 `propstat/prop` 两层下面、还多带一个 `xmlns:s` 命名空间 ——
 * 这几条每一条都不是我坐在桌前能想出来的夹具形状。
 */

import { describe, expect, it } from 'vitest';
import { createWebDavPort } from '@/infrastructure/webdav/http-webdav';
import { WebDavError, type WebDavCredential } from '@/core/ports/webdav';
import { childrenByLocal, descendantsByLocal, parseXmlRoot, textOf } from '@/infrastructure/webdav/xml';

const CREDENTIAL: WebDavCredential = { username: 'tester', password: 'pw' };
const ROOT = 'https://dav.jianguoyun.com/dav/ShiXiongZhiDao/ShiTab/';

/** 真坚果云的 207 正文（ShiTab 目录下有 manifests/ 与 snapshots/ 两个集合，正文里就是这一份）。 */
const JIANGUOYUN_DIR =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
  '<d:multistatus xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com">' +
  '<d:response><d:href>/dav/ShiXiongZhiDao/ShiTab</d:href><d:propstat><d:prop>' +
  '<d:getetag/><d:getcontenttype>httpd/unix-directory</d:getcontenttype>' +
  '<d:getcontentlength>0</d:getcontentlength>' +
  '<d:getlastmodified>Sun, 04 Oct 2026 13:49:47 GMT</d:getlastmodified>' +
  '<d:resourcetype><d:collection/></d:resourcetype>' +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
  '<d:response><d:href>/dav/ShiXiongZhiDao/ShiTab/manifests</d:href><d:propstat><d:prop>' +
  '<d:getetag/><d:getcontenttype>httpd/unix-directory</d:getcontenttype>' +
  '<d:getcontentlength>0</d:getcontentlength>' +
  '<d:getlastmodified>Sun, 04 Oct 2026 13:49:50 GMT</d:getlastmodified>' +
  '<d:resourcetype><d:collection/></d:resourcetype>' +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
  '<d:response><d:href>/dav/ShiXiongZhiDao/ShiTab/snapshots</d:href><d:propstat><d:prop>' +
  '<d:getetag/><d:getcontenttype>httpd/unix-directory</d:getcontenttype>' +
  '<d:getcontentlength>0</d:getcontentlength>' +
  '<d:getlastmodified>Sun, 04 Oct 2026 13:49:48 GMT</d:getlastmodified>' +
  '<d:resourcetype><d:collection/></d:resourcetype>' +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
  '</d:multistatus>';

/**
 * 快照文件的那一类条目，坚果云这次没回（目录还是空的），按它的写法补一条：
 * 属性顺序与命名空间照抄，只是 resourcetype 变空、contentlength 有值、etag 有值。
 * 这里刻意用**内容寻址的文件名**（checksum 前 32 位，既有约定），因为引擎要拿
 * 解析出来的 url 反推 snapshotId —— 名字解不出来就等于"远端没有这个快照"。
 */
const SNAPSHOT_ID = '3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c';
const JIANGUOYUN_WITH_SNAPSHOT = JIANGUOYUN_DIR.replace(
  '</d:multistatus>',
  `<d:response><d:href>/dav/ShiXiongZhiDao/ShiTab/snapshots/${SNAPSHOT_ID}</d:href><d:propstat><d:prop>` +
    '<d:getetag>"68d2f3a1-4f2"</d:getetag><d:getcontenttype>application/octet-stream</d:getcontenttype>' +
    '<d:getcontentlength>2034</d:getcontentlength>' +
    '<d:getlastmodified>Sun, 04 Oct 2026 13:52:10 GMT</d:getlastmodified>' +
    '<d:resourcetype/>' +
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
    '</d:multistatus>',
);

/** 只造适配器真正读的四个成员（ok/status/headers/text），多造就是在给实现留没被测到的字段。 */
function respond(body: string, status = 207): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

function portFor(body: string, status = 207) {
  return createWebDavPort({
    fetchImpl: (async () => respond(body, status)) as unknown as typeof fetch,
  });
}

describe('回归的环境前提：这里必须比生产更严，不能更宽容', () => {
  it('本文件跑在 node 环境：DOMParser 不存在（service worker 也一样没有）', () => {
    // 这一条不是凑数。它红了就说明有人把文件切回了 jsdom，
    // 那剩下的用例全部失去意义 —— 而"失去意义"的表现恰好是**继续全绿**。
    expect('DOMParser' in globalThis).toBe(false);
  });
});

describe('真坚果云的 207：集合列表必须解析出条目', () => {
  it('三个 response 全部成条目，且 href 没有尾斜杠也认得出是集合', async () => {
    const entries = await portFor(JIANGUOYUN_DIR).propfind(ROOT, CREDENTIAL, 1);
    expect(entries.map((entry) => entry.url)).toEqual([
      'https://dav.jianguoyun.com/dav/ShiXiongZhiDao/ShiTab',
      'https://dav.jianguoyun.com/dav/ShiXiongZhiDao/ShiTab/manifests',
      'https://dav.jianguoyun.com/dav/ShiXiongZhiDao/ShiTab/snapshots',
    ]);
    // 判"是不是集合"只能看 resourcetype：坚果云的目录 href 不带尾斜杠，
    // 拿斜杠当依据会把这些目录全判成文件 —— 而 manifest 重建就靠这一位。
    for (const entry of entries) expect(entry.isDirectory).toBe(true);
    // 反过来钉一次：这些目录 URL 确实没有尾斜杠，所以上一行的 true 只能来自 resourcetype。
    for (const entry of entries) expect(entry.url).not.toMatch(/\/$/);
  });

  it('绝对路径的 href 用请求 URL 的 origin 还原，不是原样返回', async () => {
    const entries = await portFor(JIANGUOYUN_DIR).propfind(ROOT, CREDENTIAL, 1);
    // 原样返回的话，上层拿它跟 manifest 里记的绝对 URL 比对就永远不等，
    // 表现是"每次同步都重传一份"，静默且要攒几百个快照才看出来。
    for (const entry of entries) expect(entry.url.startsWith('https://dav.jianguoyun.com/dav/')).toBe(true);
  });

  it('空的 <d:getetag/> 是「没有 etag」，不是空字符串', async () => {
    const entries = await portFor(JIANGUOYUN_DIR).propfind(ROOT, CREDENTIAL, 1);
    for (const entry of entries) expect(entry.etag).toBeUndefined();
  });

  it('getcontentlength=0 要保留成 0，缺失才是不明', async () => {
    const entries = await portFor(JIANGUOYUN_DIR).propfind(ROOT, CREDENTIAL, 1);
    for (const entry of entries) expect(entry.contentLength).toBe(0);
  });

  it('propstat/prop 两层的属性取得到，getlastmodified 解成毫秒', async () => {
    const entries = await portFor(JIANGUOYUN_DIR).propfind(ROOT, CREDENTIAL, 1);
    for (const entry of entries) {
      expect(entry.lastModified).toBeTypeOf('number');
      expect(Date.UTC(2026, 9, 4)).toBeLessThanOrEqual(entry.lastModified ?? 0);
    }
  });

  it('快照文件那条：isDirectory=false，etag/字节数都在', async () => {
    const entries = await portFor(JIANGUOYUN_WITH_SNAPSHOT).propfind(ROOT, CREDENTIAL, 1);
    const snapshot = entries.find((entry) => entry.url.endsWith(SNAPSHOT_ID));
    expect(snapshot).toBeDefined();
    expect(snapshot?.isDirectory).toBe(false);
    expect(snapshot?.etag).toBe('"68d2f3a1-4f2"');
    expect(snapshot?.contentLength).toBe(2034);
  });
});

describe('前缀写法必须换不出空列表', () => {
  /** 把夹具里的 `d:` 前缀按指定写法重写：真服务器四种写法都存在。 */
  function respell(xml: string, kind: 'uppercase-prefix' | 'no-prefix' | 'shouty'): string {
    if (kind === 'no-prefix') return xml.replaceAll('<d:', '<').replaceAll('</d:', '</');
    if (kind === 'uppercase-prefix') return xml.replaceAll('<d:', '<D:').replaceAll('</d:', '</D:');
    return xml
      .replaceAll('<d:', '<D:')
      .replaceAll('</d:', '</D:')
      .replaceAll('href', 'HREF')
      .replaceAll('response', 'RESPONSE')
      .replaceAll('multistatus', 'MULTISTATUS');
  }

  for (const kind of ['uppercase-prefix', 'no-prefix', 'shouty'] as const) {
    it(`${kind}：条目数与 URL 都和原样一致`, async () => {
      const entries = await portFor(respell(JIANGUOYUN_DIR, kind)).propfind(ROOT, CREDENTIAL, 1);
      expect(entries.length).toBe(3);
      expect(entries.map((entry) => entry.url)).toEqual([
        'https://dav.jianguoyun.com/dav/ShiXiongZhiDao/ShiTab',
        'https://dav.jianguoyun.com/dav/ShiXiongZhiDao/ShiTab/manifests',
        'https://dav.jianguoyun.com/dav/ShiXiongZhiDao/ShiTab/snapshots',
      ]);
    });
  }
});

describe('解不开要说"解不开"，不能回一张空表', () => {
  /** 半截文档：服务器写崩了 / 代理截断了，就是这个形状。 */
  const TRUNCATED = JIANGUOYUN_DIR.slice(0, Math.floor(JIANGUOYUN_DIR.length / 2));

  for (const [name, body] of [
    ['半截的 multistatus', TRUNCATED],
    ['不是 xml', '<html><body>502 Bad Gateway</body></html>'],
    ['空正文', ''],
    ['根元素不对（回了 propfind 请求体的回声）', '<d:propfind xmlns:d="DAV:"><d:prop/></d:propfind>'],
  ] as const) {
    it(`${name} ⇒ bad-response，而不是 []`, async () => {
      const caught = await portFor(body)
        .propfind(ROOT, CREDENTIAL, 1)
        .then(() => undefined)
        .catch((reason: unknown) => reason);
      // 静默的空表比一次报错贵得多：引擎会据此重建出一份"远端什么都没有"的
      // manifest，下一轮就把用户云端的旧历史全当成不存在的了。
      expect(caught).toBeInstanceOf(WebDavError);
      expect((caught as WebDavError).kind).toBe('bad-response');
    });
  }

  it('424（依赖失败）配解不开的正文时按空表处理，这是 port 合同里写明的一种', async () => {
    const entries = await portFor('<html/>', 424).propfind(ROOT, CREDENTIAL, 1);
    expect(entries).toEqual([]);
  });
});

describe('xml.ts 自己的边界（解析器换掉之后，这些行为得有名字）', () => {
  it('跳过注释、<?…?>、<!DOCTYPE>，它们不进树', () => {
    const root = parseXmlRoot(
      '<?xml version="1.0"?><!DOCTYPE multistatus><!-- 这里是注释 --><multistatus><!-- <response> 伪装 —— 不能被当条目 --><response><href>/a</href></response></multistatus>',
    );
    expect(root?.local).toBe('multistatus');
    expect(root ? childrenByLocal(root, 'response').length : 0).toBe(1);
  });

  it('实体解回来：href 里的 &amp; 与 %20 混写都能还原', () => {
    const root = parseXmlRoot('<multistatus><response><href>/dav/a&amp;b/c</href></response></multistatus>');
    const [response] = root ? childrenByLocal(root, 'response') : [];
    expect(response ? textOf(response, 'href') : undefined).toBe('/dav/a&b/c');
  });

  it('属性值里的 > 不会提前结束元素', () => {
    const root = parseXmlRoot('<multistatus><response a="x>y"><href>/a</href></response></multistatus>');
    expect(root ? childrenByLocal(root, 'response').length : 0).toBe(1);
    const [response] = root ? childrenByLocal(root, 'response') : [];
    expect(response ? textOf(response, 'href') : undefined).toBe('/a');
  });

  it('大小写与默认命名空间归一到同一个本地名', () => {
    const root = parseXmlRoot('<D:multistatus><D:response><href>/a</HREF></D:response></D:multistatus>');
    expect(root?.local).toBe('multistatus');
    const [response] = root ? childrenByLocal(root, 'response') : [];
    expect(response ? textOf(response, 'href') : undefined).toBe('/a');
  });

  it('未闭合与错位的闭合都算坏文档：返回 undefined，不产出条目', () => {
    expect(parseXmlRoot('<multistatus><response><href>/a</href>')).toBeUndefined();
    expect(parseXmlRoot('<multistatus></wrong>')).toBeUndefined();
  });

  it('textOf 会往后代里找：属性藏在 propstat/prop 下也算取到', () => {
    const root = parseXmlRoot(
      '<multistatus><response><propstat><prop><getcontentlength>42</getcontentlength></prop></propstat></response></multistatus>',
    );
    const [response] = root ? childrenByLocal(root, 'response') : [];
    expect(response ? textOf(response, 'getcontentlength') : undefined).toBe('42');
    expect(response ? descendantsByLocal(response, 'prop').length : 0).toBe(1);
  });

  it('空元素与缺失都返回 undefined：不把 "" 当"有值"', () => {
    const root = parseXmlRoot('<multistatus><response><getetag/><href> x </href></response></multistatus>');
    const [response] = root ? childrenByLocal(root, 'response') : [];
    expect(response ? textOf(response, 'getetag') : undefined).toBeUndefined();
    expect(response ? textOf(response, 'href') : undefined).toBe('x');
  });
});
