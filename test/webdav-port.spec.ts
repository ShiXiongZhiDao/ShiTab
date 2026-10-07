/**
 * WebDavPort 的 HTTP 实现（`infrastructure/webdav/http-webdav.ts`）跑在注入的 fetch 桩上。
 *
 * 这里不打真服务器，也不测"能不能连上 WebDAV"，测的是**翻译**：
 * 状态码 → kind、异常 → network、头 → 条件请求、XML → RemoteResourceMeta。
 * 这四件事没有一件能在生产产物里被肉眼验收（用户看的是"同步成没成"，
 * 而分类表错一格的后果是"该只报告的网络故障去改了本地数据"），所以只能在这一层钉死。
 *
 * 桩只造 `ok/status/headers/text` 四个成员：适配器只读这四个，
 * 多造一个就是在给实现留"顺手用了一个没被测到的字段"的空间。
 * 也不依赖 jsdom 是否提供 Response/Headers —— 它本来就不提供 fetch。
 */

// 这个文件**必须跑在 node 环境**。
// 默认的 jsdom 里有 DOMParser，而生产环境（MV3 service worker）没有 —— 也就是说
// jsdom 比生产宽容。propfind 的 XML 解析曾经只靠 DOMParser 实现，42 条用例全绿、
// 真机一跑就抛 ReferenceError。换到 node 环境后，这类"只在扩展运行时才炸"的
// 依赖会在这一层直接红，所以别把它改回 jsdom。
// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { createWebDavPort } from '@/infrastructure/webdav/http-webdav';
import { WebDavError, type WebDavErrorKind } from '@/core/ports/webdav';

const BASE = 'https://dav.test/dav/shitab/';
const CREDENTIAL = { username: 'bob', password: 'hunter2' };

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: string;
}

let captured: CapturedRequest[] = [];
let plan: (request: CapturedRequest) => Response = () => stubResponse();

/** 形状对齐 fetch 的 Response，但只实现适配器真正读的那四项。 */
function stubResponse(init: { status?: number; headers?: Record<string, string>; body?: string } = {}): Response {
  const status = init.status ?? 200;
  const lowered = new Map(
    Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    // 与 fetch 同规则：ok 覆盖 200..299，所以 207 也是 ok（适配器就靠这一点不给 207 开后门）
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => init.body ?? '',
  } as unknown as Response;
}

const port = createWebDavPort({
  fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
      // `signal: null` 与"没给 signal"在 fetch 里同义，所以这里用真值判断一次把两种都收掉；
      // 写成 `init?.signal === undefined` 会把 null 原样塞进 CapturedRequest，
      // 那个类型的 `signal?: AbortSignal` 接不住 null（vue-tsc 会在这里报错）。
      ...(init?.signal ? { signal: init.signal } : {}),
      ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
    };
    captured.push(request);
    return plan(request);
  }) as unknown as typeof fetch,
});

function respondAlways(status: number, headers: Record<string, string> = {}, body = ''): void {
  plan = () => stubResponse({ status, headers, body });
}

function respondThrowing(error: unknown): void {
  plan = () => {
    throw error;
  };
}

function lastRequest(): CapturedRequest {
  const request = captured.at(-1);
  if (!request) throw new Error('没有捕获到任何请求');
  return request;
}

/** 断言"抛的是 WebDavError、kind 和 status 都对"。成功路径直接算失败。 */
async function expectFailure(run: Promise<unknown>, kind: WebDavErrorKind, status: number): Promise<WebDavError> {
  let reason: unknown;
  try {
    await run;
  } catch (caught) {
    reason = caught;
  }
  if (!(reason instanceof WebDavError)) throw new Error(`期望 WebDavError(${kind})，实际拿到 ${String(reason)}`);
  expect(reason.kind).toBe(kind);
  expect(reason.status).toBe(status);
  return reason;
}

beforeEach(() => {
  captured = [];
  plan = () => stubResponse();
});

describe('Authorization 头：MV3 的 fetch 不认 username/password，认证只有这一条路', () => {
  it('每个请求都带 Basic 头，串是自己按 UTF-8 编出来的', async () => {
    // 期望值是 `Buffer.from('bob:hunter2','utf8').toString('base64')` 的独立参考值，
    // 不是拿被测函数自己算的 —— 否则实现写反了也能自证通过。
    respondAlways(200);
    await port.get('https://dav.test/a.json', CREDENTIAL);
    expect(lastRequest().headers.Authorization).toBe('Basic Ym9iOmh1bnRlcjI=');
  });

  it('中文密码走 UTF-8：裸 btoa 在这串上直接抛 InvalidCharacterError', async () => {
    respondAlways(200);
    await port.get('https://dav.test/a.json', { username: 'user1', password: '密码test' });
    expect(lastRequest().headers.Authorization).toBe('Basic dXNlcjE65a+G56CBdGVzdA==');
    // 这一行是"为什么要 TextEncoder"的证据：少了它，中文密码的用户看到的是崩溃而不是 401。
    expect(() => btoa('user1:密码test')).toThrow();
  });
});

describe('状态码 → 语义（分类表错一格，"401/网络只报告不改本地"就悄悄失效）', () => {
  it('401 在 testConnection 上得到 credentials，不是 forbidden', async () => {
    respondAlways(401);
    await expectFailure(port.testConnection(BASE, CREDENTIAL), 'credentials', 401);
  });

  it('403 得到 forbidden：认证过了但没权限，与"密码错了"是两种处置', async () => {
    respondAlways(403);
    await expectFailure(port.get(`${BASE}snap.json`, CREDENTIAL), 'forbidden', 403);
  });

  it('409 得到 parent-conflict：ensureCollection 之后还在，就是远端结构坏了', async () => {
    respondAlways(409);
    await expectFailure(port.put(`${BASE}snap.json`, '{}', CREDENTIAL), 'parent-conflict', 409);
  });

  it('412 得到 precondition-failed，即"有别的设备先写了"', async () => {
    respondAlways(412);
    await expectFailure(
      port.put(`${BASE}manifest.json`, '{}', CREDENTIAL, { ifMatch: '"old"' }),
      'precondition-failed',
      412,
    );
  });

  it('503 得到 server（可退避重试），不被降级成 bad-response', async () => {
    respondAlways(503);
    await expectFailure(port.get(`${BASE}snap.json`, CREDENTIAL), 'server', 503);
  });

  it('head 的 404 是答案不是故障：返回 exists:false，不抛', async () => {
    respondAlways(404);
    await expect(port.head(`${BASE}missing.json`, CREDENTIAL)).resolves.toEqual({
      url: `${BASE}missing.json`,
      exists: false,
      isDirectory: false,
    });
    expect(lastRequest().method).toBe('HEAD');
  });

  it('head 的 503 绝不能也走 exists:false：那会被读成"远端文件被人删了"', async () => {
    respondAlways(503);
    await expectFailure(port.head(`${BASE}snap.json`, CREDENTIAL), 'server', 503);
  });
});

describe('没有响应 = network + status 0，与"服务器说了不"是两件事', () => {
  it('fetch 抛 TypeError（DNS/TLS/离线/被 CORS 拒）翻译成 network，原始异常挂在 cause 上', async () => {
    const typeError = new TypeError('Failed to fetch');
    respondThrowing(typeError);
    const error = await expectFailure(port.get(`${BASE}snap.json`, CREDENTIAL), 'network', 0);
    // status 必须是 0 而不是 undefined：0 本身就携带"根本没有状态码"这个信息。
    expect(error.url).toBe(`${BASE}snap.json`);
    expect(error.method).toBe('GET');
    expect(error.cause).toBe(typeError);
    // 这条是整个文件最要紧的断言：网络故障一旦被分类成 forbidden，
    // 上层就会去改本地数据/提示用户改密码。
    expect(error.kind).not.toBe('forbidden');
  });

  it('AbortError（超时/用户取消）也是 network，不是 bad-response', async () => {
    respondThrowing(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
    await expectFailure(port.propfind(BASE, CREDENTIAL, 1), 'network', 0);
  });

  it('MKCOL 打到一半断掉同样是 network：确保目录这一步不许换成"权限问题"', async () => {
    respondThrowing(new TypeError('net::ERR_INTERNET_DISCONNECTED'));
    await expectFailure(port.ensureCollection(BASE, CREDENTIAL), 'network', 0);
  });

  it('AbortSignal 原样透传给 fetch：超时/取消不归这层实现', async () => {
    respondAlways(200);
    const controller = new AbortController();
    await port.put(`${BASE}snap.json`, '{}', CREDENTIAL, { signal: controller.signal });
    expect(lastRequest().signal).toBe(controller.signal);
  });
});

describe('ensureCollection：语义是"确保有"，不是"必须新建"', () => {
  it('MKCOL 405 不算失败（已存在就是成功），且逐级各打一次', async () => {
    // 405 落在**所有**请求上，包括快路径那次 Depth 0 探测 ⇒ 探测问不出"已就绪"，
    // 于是照旧逐级 MKCOL。这一条留着就是为了证明快路径不会把老行为改掉。
    respondAlways(405);
    await expect(port.ensureCollection(BASE, CREDENTIAL)).resolves.toBeUndefined();
    expect(captured.map((request) => [request.method, request.url])).toEqual([
      ['PROPFIND', BASE],
      ['MKCOL', 'https://dav.test/dav/'],
      ['MKCOL', BASE],
    ]);
    expect(captured[0]?.headers.Depth).toBe('0');
  });

  it('MKCOL 409 也算已存在：这条实现把"父在、自身在"报成冲突，但不是故障', async () => {
    respondAlways(409);
    await expect(port.ensureCollection(BASE, CREDENTIAL)).resolves.toBeUndefined();
  });

  it('403 是真失败，照抛 forbidden（否则只读目录会被当成"已就绪"）', async () => {
    respondAlways(403);
    const error = await expectFailure(port.ensureCollection(BASE, CREDENTIAL), 'forbidden', 403);
    expect(error.method).toBe('MKCOL');
    expect(error.url).toBe('https://dav.test/dav/');
  });

  it('不对根目录发 MKCOL：主机对根回 403 是常见的，那会被误报成没权限', async () => {
    respondAlways(201);
    await port.ensureCollection(BASE, CREDENTIAL);
    expect(captured.map((request) => request.url)).not.toContain('https://dav.test/');
  });

  it('URL 里已有的百分号编码不再编一次（%20 → %2520 会新建一个"存在但永远空"的目录）', async () => {
    respondAlways(201);
    await port.ensureCollection('https://dav.test/dav/%E4%B8%AD%20%E6%96%87/', CREDENTIAL);
    expect(captured.at(-1)?.url).toBe('https://dav.test/dav/%E4%B8%AD%20%E6%96%87/');
    expect(captured.map((request) => request.url)).toContain('https://dav.test/dav/');
  });
});

describe('ensureCollection 的稳态快路径：目录早就在，就别每轮再打八个写请求', () => {
  /**
   * Depth 0 的正文，形状照抄 2026-10-04 真坚果云的响应（href 不带尾斜杠、
   * `<d:getetag/>` 空自闭合、属性藏在 propstat/prop 两层下）。
   * 用我自己顺眼的写法就会测不到真正咬人的那一口：比对 URL 时的尾斜杠。
   */
  const collectionBody = (href: string): string =>
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
    '<d:multistatus xmlns:d="DAV:"><d:response><d:href>' +
    href +
    '</d:href><d:propstat><d:prop><d:getetag/><d:getcontentlength>0</d:getcontentlength>' +
    '<d:resourcetype><d:collection/></d:resourcetype></d:prop>' +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';

  /** 同名文件：resourcetype 是空的，且 href 不带尾斜杠（带了就会被"尾斜杠=集合"的兜底认成目录）。 */
  const fileBody = (href: string): string =>
    collectionBody(href).replace('<d:resourcetype><d:collection/></d:resourcetype>', '<d:resourcetype/>');

  function answerPropfindWith(status: number, body: string): void {
    plan = (request) =>
      request.method === 'PROPFIND' ? stubResponse({ status, body }) : stubResponse({ status: 201 });
  }

  it('Depth 0 说是集合 ⇒ 只发那一次探测，一个 MKCOL 都不发', async () => {
    answerPropfindWith(207, collectionBody('/dav/shitab/'));
    await expect(port.ensureCollection(BASE, CREDENTIAL)).resolves.toBeUndefined();
    expect(captured.map((request) => request.method)).toEqual(['PROPFIND']);
    expect(captured[0]?.headers.Depth).toBe('0');
  });

  it('href 少一个尾斜杠也算命中（坚果云实测就这么回）', async () => {
    answerPropfindWith(207, collectionBody('/dav/shitab'));
    await port.ensureCollection(BASE, CREDENTIAL);
    expect(captured.map((request) => request.method)).toEqual(['PROPFIND']);
  });

  it('探测到的是同名文件 ⇒ 不能当目录用，照走逐级 MKCOL', async () => {
    answerPropfindWith(207, fileBody('/dav/shitab'));
    await port.ensureCollection(BASE, CREDENTIAL);
    expect(captured.map((request) => [request.method, request.url])).toEqual([
      ['PROPFIND', BASE],
      ['MKCOL', 'https://dav.test/dav/'],
      ['MKCOL', BASE],
    ]);
  });

  it('Depth 0 回 404（真的没有）⇒ MKCOL 建出来', async () => {
    answerPropfindWith(404, '');
    await port.ensureCollection(BASE, CREDENTIAL);
    expect(captured.map((request) => request.method)).toEqual(['PROPFIND', 'MKCOL', 'MKCOL']);
  });

  it('探测阶段就断网也不改语义：不认"已就绪"，让 MKCOL 那一步去抛真的错误', async () => {
    plan = (request) => {
      if (request.method === 'PROPFIND') throw new TypeError('offline');
      return stubResponse({ status: 201 });
    };
    await expect(port.ensureCollection(BASE, CREDENTIAL)).resolves.toBeUndefined();
    // 少这一条断言，"catch 之后 return false" 写成 "catch 之后 return true" 也能全绿，
    // 而后果是同步以为目录好了、直接 PUT，用户看到的是每次都 409。
    expect(captured.map((request) => request.method)).toEqual(['PROPFIND', 'MKCOL', 'MKCOL']);
  });

  it('正文解不开（回了 HTML）⇒ 同样退回逐级 MKCOL', async () => {
    answerPropfindWith(200, '<html><body>登录页</body></html>');
    await port.ensureCollection(BASE, CREDENTIAL);
    expect(captured.map((request) => request.method)).toEqual(['PROPFIND', 'MKCOL', 'MKCOL']);
  });
});

describe('条件写：头没发出去就等于并发保护不存在', () => {
  it('put 带 Content-Type: application/json，并把 If-Match 原样发出', async () => {
    respondAlways(204, { ETag: '"new-etag"' });
    await port.put(`${BASE}manifest.json`, '{"a":1}', CREDENTIAL, { ifMatch: '"old"' });
    const request = lastRequest();
    expect(request.method).toBe('PUT');
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.headers['If-Match']).toBe('"old"');
    expect(request.body).toBe('{"a":1}');
    // 不该出现的键也不能出现：`If-None-Match: undefined` 会变成空值头，服务器按"带了条件头但没对上"回 412
    expect(request.headers).not.toHaveProperty('If-None-Match');
  });

  it('ifNoneMatch 走 If-None-Match，且此时没有 If-Match', async () => {
    respondAlways(201);
    await port.put(`${BASE}snap-1.json`, 'x', CREDENTIAL, { ifNoneMatch: '*' });
    expect(lastRequest().headers['If-None-Match']).toBe('*');
    expect(lastRequest().headers).not.toHaveProperty('If-Match');
  });

  it('两个条件头都没给时，一个条件头都不发（普通写就是普通写）', async () => {
    respondAlways(201);
    await port.put(`${BASE}snap-1.json`, 'x', CREDENTIAL);
    expect(lastRequest().headers).not.toHaveProperty('If-Match');
    expect(lastRequest().headers).not.toHaveProperty('If-None-Match');
  });

  it('put 把响应里的 ETag 带回来：下一轮条件写就用它，弄丢等于放弃并发保护', async () => {
    respondAlways(204, { ETag: '"W/xyz"' });
    await expect(port.put(`${BASE}snap.json`, 'x', CREDENTIAL)).resolves.toEqual({ etag: '"W/xyz"' });
  });

  it('响应没有 ETag 时返回的对象里不该出现 etag 键', async () => {
    respondAlways(204);
    const result = await port.put(`${BASE}snap.json`, 'x', CREDENTIAL);
    expect(result).not.toHaveProperty('etag');
  });

  it('redirect 保持 follow：跨站重定向会带着 Basic 头出去，所以 baseUrl 必须是 https（这层的取舍，不在此实现剥离）', async () => {
    respondAlways(204);
    await port.put(`${BASE}snap.json`, 'x', CREDENTIAL);
    expect(lastRequest().redirect).toBe('follow');
  });
});

describe('head 的元数据解析', () => {
  it('ETag / Content-Length / Last-Modified 都取到，尾斜杠判成目录', async () => {
    const httpDate = 'Tue, 15 Sep 2026 08:00:00 GMT';
    respondAlways(200, { ETag: '"e1"', 'Content-Length': '2048', 'Last-Modified': httpDate });
    const meta = await port.head(`${BASE}snap.json`, CREDENTIAL);
    expect(meta).toEqual({
      url: `${BASE}snap.json`,
      exists: true,
      isDirectory: false,
      etag: '"e1"',
      lastModified: Date.parse(httpDate),
      contentLength: 2048,
    });
  });

  it('垃圾 Last-Modified 得到**缺失**而不是 0：0 会被读成"1970 年改过"，于是"比这个新"恒真', async () => {
    respondAlways(200, { 'Last-Modified': 'yesterday-ish', 'Content-Length': '' });
    const meta = await port.head(`${BASE}snap.json`, CREDENTIAL);
    expect(meta).not.toHaveProperty('lastModified');
    expect(meta.lastModified).not.toBe(0);
    expect(meta).not.toHaveProperty('contentLength');
  });

  it('服务器明说 httpd/unix-directory 时按目录算，即使 URL 不带尾斜杠', async () => {
    respondAlways(200, { 'Content-Type': 'httpd/unix-directory' });
    const meta = await port.head('https://dav.test/dav/shitab', CREDENTIAL);
    expect(meta.isDirectory).toBe(true);
  });

  it('get 返回的是文本而不是字节：base64→bytes 的解码属于 core/domain/gzip.ts', async () => {
    respondAlways(200, {}, 'H4sIAAAAAAAA');
    const body = await port.get(`${BASE}snap.json`, CREDENTIAL);
    expect(typeof body).toBe('string');
    expect(body).toBe('H4sIAAAAAAAA');
  });
});

describe('propfind：解析必须是命名空间无关的', () => {
  const MULTI_PREFIXED = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/shitab/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getlastmodified>Tue, 15 Sep 2026 08:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/shitab/snap-1.json</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getcontentlength>1024</D:getcontentlength>
        <D:getetag>"a1b2"</D:getetag>
        <D:getlastmodified>Tue, 15 Sep 2026 08:00:01 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/shitab/gone.json</D:href>
    <D:propstat><D:prop/><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>
  </D:response>
</D:multistatus>`;

  const MULTI_UNPREFIXED = MULTI_PREFIXED
    .replace('<D:multistatus xmlns:D="DAV:">', '<multistatus xmlns="DAV:">')
    .replaceAll('</D:', '</')
    .replaceAll('<D:', '<');

  const EXPECTED = [
    {
      url: BASE,
      exists: true,
      isDirectory: true,
      lastModified: Date.parse('Tue, 15 Sep 2026 08:00:00 GMT'),
    },
    {
      url: `${BASE}snap-1.json`,
      exists: true,
      isDirectory: false,
      etag: '"a1b2"',
      lastModified: Date.parse('Tue, 15 Sep 2026 08:00:01 GMT'),
      contentLength: 1024,
    },
    { url: `${BASE}gone.json`, exists: false, isDirectory: false },
  ];

  it('请求体是标准 PROPFIND，Depth 按参数发 0 或 1', async () => {
    respondAlways(207, {}, MULTI_PREFIXED);
    await port.propfind(BASE, CREDENTIAL, 1);
    const request = lastRequest();
    expect(request.method).toBe('PROPFIND');
    expect(request.headers.Depth).toBe('1');
    expect(request.body).toContain('<d:propfind');
    for (const name of ['resourcetype', 'getcontentlength', 'getlastmodified', 'getetag']) {
      expect(request.body).toContain(name);
    }
    respondAlways(207, {}, MULTI_PREFIXED);
    await port.testConnection(BASE, CREDENTIAL);
    expect(lastRequest().method).toBe('PROPFIND');
    expect(lastRequest().headers.Depth).toBe('0');
  });

  it('testConnection 是 PROPFIND Depth:0，一个字节都不写', async () => {
    respondAlways(207, {}, MULTI_PREFIXED);
    await port.testConnection(BASE, CREDENTIAL);
    expect(captured.map((request) => request.method)).toEqual(['PROPFIND']);
  });

  it('D: 前缀与无前缀两种写法解出**同一张表**：按 localName 匹配是这里唯一的护栏', async () => {
    respondAlways(207, {}, MULTI_PREFIXED);
    const prefixed = await port.propfind(BASE, CREDENTIAL, 1);
    respondAlways(207, {}, MULTI_UNPREFIXED);
    const bare = await port.propfind(BASE, CREDENTIAL, 1);
    expect(prefixed).toEqual(EXPECTED);
    expect(bare).toEqual(EXPECTED);
  });

  it('全大写标签也得认（少数服务器就是这么回的）', async () => {
    const uppercase = `<?xml version="1.0" encoding="utf-8"?>
<D:MULTISTATUS xmlns:D="DAV:">
  <D:RESPONSE><D:HREF>/dav/shitab/UP.json</D:HREF>
    <D:PROPSTAT><D:PROP><D:GETETAG>"upper"</D:GETETAG></D:PROP><D:STATUS>HTTP/1.1 200 OK</D:STATUS></D:PROPSTAT>
  </D:RESPONSE>
</D:MULTISTATUS>`;
    respondAlways(207, {}, uppercase);
    expect(await port.propfind(BASE, CREDENTIAL, 1)).toEqual([
      { url: `${BASE}UP.json`, exists: true, isDirectory: false, etag: '"upper"' },
    ]);
  });

  it('href 回的是绝对路径时，用请求 URL 的 origin 还原成完整 URL', async () => {
    respondAlways(207, { 'Content-Type': 'application/xml' }, MULTI_PREFIXED);
    const urls = (await port.propfind(BASE, CREDENTIAL, 1)).map((meta) => meta.url);
    expect(urls).toEqual([BASE, `${BASE}snap-1.json`, `${BASE}gone.json`]);
    // 键必须与调用方传进去的同形：上层拿它和 manifest 里记的 url 比对，
    // 串不一致就判"远端没有这个快照"，于是每次同步都重复上传一份。
    expect(urls.every((url) => url.startsWith('https://dav.test/'))).toBe(true);
  });

  it('424 Failed Dependency 不整体抛：坏的那条丢掉，其余照报', async () => {
    const partial = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/dav/shitab/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/dav/shitab/broken.json</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 424 Failed Dependency</D:status></D:propstat></D:response>
  <D:response><D:href>/dav/shitab/ok.json</D:href><D:propstat><D:prop><D:getetag>"z"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
    respondAlways(424, {}, partial);
    const entries = await port.propfind(BASE, CREDENTIAL, 1);
    expect(entries.map((meta) => meta.url)).toEqual([BASE, `${BASE}ok.json`]);
  });

  it('200 也算数（有服务器对单个资源直接回属性体）', async () => {
    const single = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>${BASE}snap-1.json</D:href><D:propstat><D:prop><D:getetag>"q"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
    respondAlways(200, {}, single);
    const entries = await port.propfind(`${BASE}snap-1.json`, CREDENTIAL, 0);
    expect(entries).toEqual([{ url: `${BASE}snap-1.json`, exists: true, isDirectory: false, etag: '"q"' }]);
  });

  it('说要给 207 结果正文不是 multistatus ⇒ bad-response，而不是静默返回空表', async () => {
    respondAlways(207, {}, '<html><body>登录页</body></html>');
    await expectFailure(port.propfind(BASE, CREDENTIAL, 1), 'bad-response', 207);
  });

  it('propfind 的 5xx 与 401 照状态码分类：列目录不是特例', async () => {
    respondAlways(500);
    await expectFailure(port.propfind(BASE, CREDENTIAL, 1), 'server', 500);
    respondAlways(401);
    await expectFailure(port.propfind(BASE, CREDENTIAL, 1), 'credentials', 401);
  });

  it('getlastmodified 是垃圾时该条目也没有 lastModified（不给 0）', async () => {
    const broken = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/dav/shitab/x.json</D:href>
    <D:propstat><D:prop><D:getlastmodified>tomorrow maybe</D:getlastmodified><D:getcontentlength>7</D:getcontentlength></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;
    respondAlways(207, {}, broken);
    const [entry] = await port.propfind(BASE, CREDENTIAL, 1);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('lastModified');
    expect(entry?.contentLength).toBe(7);
  });
});

describe('move：Destination 编码与 Overwrite', () => {
  it('Destination 是完整 URL 且只做 encodeURI（整体 encodeURIComponent 会毁掉 scheme 的 : 与 /）', async () => {
    respondAlways(201);
    const to = 'https://dav.test/dav/shitab/旧 名.json';
    await port.move(`${BASE}new.json`, to, false, CREDENTIAL);
    const request = lastRequest();
    expect(request.method).toBe('MOVE');
    expect(request.headers.Destination).toBe('https://dav.test/dav/shitab/%E6%97%A7%20%E5%90%8D.json');
    expect(request.headers.Destination).toContain('https://');
    expect(request.headers.Overwrite).toBe('F');
  });

  it('overwrite=true 发 Overwrite: T', async () => {
    respondAlways(204);
    await port.move(`${BASE}a.json`, `${BASE}b.json`, true, CREDENTIAL);
    expect(lastRequest().headers.Overwrite).toBe('T');
  });

  it('412 → precondition-failed，405/501 → unsupported-method（不少主机不实现 MOVE）', async () => {
    respondAlways(412);
    await expectFailure(port.move(`${BASE}a.json`, `${BASE}b.json`, false, CREDENTIAL), 'precondition-failed', 412);
    respondAlways(405);
    await expectFailure(port.move(`${BASE}a.json`, `${BASE}b.json`, false, CREDENTIAL), 'unsupported-method', 405);
    respondAlways(501);
    await expectFailure(port.move(`${BASE}a.json`, `${BASE}b.json`, false, CREDENTIAL), 'unsupported-method', 501);
  });

  it('错误里的 URL 是源：调用方拿着它定位资源，Destination 只是改名目标', async () => {
    respondAlways(403);
    const error = await expectFailure(
      port.move(`${BASE}a.json`, `${BASE}b.json`, false, CREDENTIAL),
      'forbidden',
      403,
    );
    expect(error.url).toBe(`${BASE}a.json`);
  });
});
