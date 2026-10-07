import { describe, expect, it } from 'vitest';
import {
  isInsecureHttp,
  manifestUrl,
  manifestsDirUrl,
  parseBaseUrl,
  remoteRootUrl,
  revisionFromUrl,
  snapshotIdFromUrl,
  snapshotUrl,
  snapshotsDirUrl,
  toOriginPattern,
} from '@/core/domain/remote-layout';
import { REMOTE_OWNER_FOLDER, REMOTE_ROOT_FOLDER } from '@/shared/constants';

describe('WebDAV 地址校验', () => {
  it('空、纯空格、以及"少了 scheme"的串都被拒', () => {
    expect(parseBaseUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseBaseUrl('   ')).toEqual({ ok: false, reason: 'empty' });
    // `dav.example.com` 不是 scheme 不对，是它压根不成 URL —— 两个拒因要给不同的文案，
    // 前者是"你少打了 https://"，后者是"这不是个地址"。
    expect(parseBaseUrl('dav.example.com')).toEqual({ ok: false, reason: 'not-a-url' });
  });

  it.each(['file:///C:/dav', 'ftp://h/p', 'chrome://settings', 'javascript:alert(1)'])(
    '非 http(s) 的 %s 一律拒绝：permissions.request 授不了它，放行只会换来一个更难懂的网络错',
    (raw) => {
      expect(parseBaseUrl(raw).ok).toBe(false);
    },
  );

  it('https 与 http 都收（局域网 NAS 常是明文），并且能认出哪一个不安全', () => {
    const secure = parseBaseUrl('https://dav.example.com/dav');
    const plain = parseBaseUrl('http://192.0.2.10:5000/dav');
    expect(secure.ok).toBe(true);
    expect(plain.ok).toBe(true);
    if (secure.ok) expect(isInsecureHttp(secure.url)).toBe(false);
    if (plain.ok) expect(isInsecureHttp(plain.url)).toBe(true);
  });

  it('带查询串与 hash 的地址照样能用（它们不参与目录拼接）', () => {
    const parsed = parseBaseUrl('https://dav.example.com/dav?token=abc#frag');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(snapshotUrl(parsed.url, '11111111-1111-4111-8111-111111111111').href).not.toContain('token');
  });
});

describe('远端路径拼接（静默 404 的高发地）', () => {
  /** 挂在用户地址后面的两段：归属目录 + 应用目录。 */
  const TAIL = `${REMOTE_OWNER_FOLDER}/${REMOTE_ROOT_FOLDER}`;

  const cases: Array<{ label: string; base: string; expectPath: string }> = [
    { label: '无结尾斜杠', base: 'https://h/dav', expectPath: `/dav/${TAIL}/snapshots` },
    { label: '一个结尾斜杠', base: 'https://h/dav/', expectPath: `/dav/${TAIL}/snapshots` },
    { label: '多个结尾斜杠', base: 'https://h/dav///', expectPath: `/dav/${TAIL}/snapshots` },
    { label: '根路径', base: 'https://h', expectPath: `/${TAIL}/snapshots` },
    { label: '中文目录', base: 'https://h/远程文件', expectPath: `/${encodeURIComponent('远程文件')}/${TAIL}/snapshots` },
    { label: '带空格的目录', base: 'https://h/my dav', expectPath: `/my%20dav/${TAIL}/snapshots` },
  ];

  for (const item of cases) {
    it(`${item.label}：${item.base} ⇒ ${item.expectPath}，且中间不出现 //`, () => {
      const parsed = parseBaseUrl(item.base);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const dir = snapshotsDirUrl(parsed.url);
      expect(dir.pathname).toBe(item.expectPath);
      expect(dir.href).not.toMatch(/[^:]\/\//);
    });
  }

  it('已编码的路径不会被二次编码（% 变 %25 就是另一个文件）', () => {
    const parsed = parseBaseUrl('https://h/%E8%BF%9C%E7%A8%8B');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(snapshotsDirUrl(parsed.url).pathname).toBe(`/%E8%BF%9C%E7%A8%8B/${TAIL}/snapshots`);
  });

  it('快照与 manifest 的文件名形状', () => {
    const base = parseBaseUrl('https://h/dav');
    if (!base.ok) throw new Error('setup');
    const contentId = '0123456789abcdef0123456789abcdef';
    expect(snapshotUrl(base.url, contentId).pathname).toBe(`/dav/${TAIL}/snapshots/${contentId}.json`);
    expect(manifestUrl(base.url, 101).pathname).toBe(`/dav/${TAIL}/manifests/revision-101.json`);
    expect(remoteRootUrl(base.url).pathname).toBe(`/dav/${TAIL}/`);
  });

  it('端口与用户名密码形式的地址保持原样', () => {
    const parsed = parseBaseUrl('https://user:pw@h:8443/dav');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(snapshotsDirUrl(parsed.url).host).toBe('h:8443');
  });
});

describe('地址里已经写了的目录，不许再拼一遍（双拼 = 一个全新的空库）', () => {
  /** 真实主机上最常见的那条形状：地址只写到归属目录那一层。 */
  const owner = `https://dav.jianguoyun.com/dav/${REMOTE_OWNER_FOLDER}`;

  function pathOf(base: string): string {
    const parsed = parseBaseUrl(base);
    if (!parsed.ok) throw new Error(`setup：${base} 应当是合法地址`);
    return snapshotsDirUrl(parsed.url).pathname;
  }

  it('地址到 /dav 为止 ⇒ 拼上归属目录与应用目录', () => {
    expect(pathOf('https://dav.jianguoyun.com/dav')).toBe(
      `/dav/${REMOTE_OWNER_FOLDER}/${REMOTE_ROOT_FOLDER}/snapshots`,
    );
  });

  it('地址已经带了归属目录 ⇒ 只补应用目录，绝不出现 ShiXiongZhiDao/ShiXiongZhiDao', () => {
    expect(pathOf(owner)).toBe(`/dav/${REMOTE_OWNER_FOLDER}/${REMOTE_ROOT_FOLDER}/snapshots`);
    // 反向对照：双拼那份是真会打出去的路径，它必须**不等于**上面那条。
    expect(owner.includes(`${REMOTE_OWNER_FOLDER}/${REMOTE_OWNER_FOLDER}`)).toBe(false);
    expect(pathOf(owner)).not.toContain(`${REMOTE_OWNER_FOLDER}/${REMOTE_OWNER_FOLDER}`);
  });

  it('归属目录写在地址里但带尾斜杠 ⇒ 同一条路径', () => {
    expect(pathOf(`${owner}/`)).toBe(pathOf(owner));
    expect(pathOf(`${owner}///`)).toBe(pathOf(owner));
  });

  it('地址一路写到应用目录 ⇒ 一个字都不再补', () => {
    const full = `${owner}/${REMOTE_ROOT_FOLDER}`;
    expect(pathOf(full)).toBe(`/dav/${REMOTE_OWNER_FOLDER}/${REMOTE_ROOT_FOLDER}/snapshots`);
    expect(pathOf(`${full}/`)).toBe(pathOf(full));
  });

  it('大小写不同的那段不算同一条路径（WebDAV 多数主机区分大小写，折叠会让我们读写两个库）', () => {
    expect(pathOf('https://h/dav/shixiongzhidao')).toBe(
      `/dav/shixiongzhidao/${REMOTE_OWNER_FOLDER}/${REMOTE_ROOT_FOLDER}/snapshots`,
    );
  });

  it('remoteRootUrl 与 manifests 走的是同一套判据（三处各拼一次迟早会拼出两个库）', () => {
    const parsed = parseBaseUrl(owner);
    if (!parsed.ok) throw new Error('setup');
    expect(remoteRootUrl(parsed.url).pathname).toBe(`/dav/${REMOTE_OWNER_FOLDER}/${REMOTE_ROOT_FOLDER}/`);
    expect(manifestsDirUrl(parsed.url).pathname).toBe(
      `/dav/${REMOTE_OWNER_FOLDER}/${REMOTE_ROOT_FOLDER}/manifests`,
    );
  });
});

describe('权限模式与安全提示', () => {
  it('申请的是 <scheme>://<host>/* —— 只给 origin 会被判成"没有路径可访问"', () => {
    const https = parseBaseUrl('https://dav.example.com/dav/shitab');
    const http = parseBaseUrl('http://192.0.2.10:5000/dav');
    if (!https.ok || !http.ok) throw new Error('setup');
    expect(toOriginPattern(https.url)).toBe('https://dav.example.com/*');
    expect(toOriginPattern(http.url)).toBe('http://192.0.2.10:5000/*');
  });
});

describe('从目录里的文件名反推身份', () => {
  const ID = '0123456789abcdef0123456789abcdef'; // 内容寻址的 id：32 位十六进制

  it('认得出的两个形状都能解出来', () => {
    expect(revisionFromUrl('https://h/d/manifests/revision-102.json')).toBe(102);
    expect(revisionFromUrl('https://h/d/manifests/revision-0.json')).toBe(0);
    expect(snapshotIdFromUrl(`https://h/d/snapshots/${ID}.json`)).toBe(ID);
  });

  it.each([
    'https://h/d/manifests/latest.json',
    'https://h/d/manifests/revision-abc.json',
    'https://h/d/snapshots/notes.txt',
    'https://h/d/snapshots/not-a-content-id.json',
    'https://h/d/snapshots/11111111-1111-4111-8111-111111111111.json',
  ])('目录里用户自己的文件一律认不出来 ⇒ null，不是抛（%s）', (url) => {
    expect(revisionFromUrl(url)).toBeNull();
    expect(snapshotIdFromUrl(url)).toBeNull();
  });

  it('revision 极大值不塌成浮点误差（重建 manifest 要比大小）', () => {
    expect(revisionFromUrl('https://h/manifests/revision-999999999.json')).toBe(999999999);
  });
});
