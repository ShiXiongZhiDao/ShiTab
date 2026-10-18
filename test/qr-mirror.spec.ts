/**
 * 二维码镜像源的选源与回落。
 *
 * 这里最重要的那条用例是**第一条（文件名守卫）**：它补回的是"图不在 `public/` 之后
 * 丢掉的那道编译期守卫"。原来 `AboutPanel` 把路径标成 `PublicPath`，WXT 从 `public/`
 * 生成联合类型 ⇒ 图被改名或删掉时 `vue-tsc` 当场红。图挪走之后那条没了，
 * **没有替代的话，"改名忘改代码"就退化成用户看到一个裂图** —— 这类失败最难发现。
 *
 * 其余用例验的是"选源"这件本身有异步与竞态的事：谁先通、都不通怎么办、
 * 超时算不算失败、缓存会不会把失败结果一直留着。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  QR_FILES,
  QR_MIRRORS,
  chooseQrMirror,
  chooseQrMirrorCached,
  probeImage,
  qrUrls,
  resetQrMirrorCache,
  type QrField,
} from '@/shared/qr-mirror';

/**
 * jsdom 不真的取图（`new Image().src = …` 之后 `onload`/`onerror` 永远不触发），
 * 所以探活这件事**只能靠替身验**。返回的三种值对应三种现实：
 * `true` 通 / `false` 明确失败 / `'hang'` 一直不回（比报错更耽误人，必须超时兜住）。
 */
type Reply = boolean | 'hang';
let reply: (url: string) => Reply = () => true;
const requested: string[] = [];

const REAL_IMAGE = globalThis.Image;
function installImage(next: (url: string) => Reply): void {
  reply = next;
  requested.length = 0;
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = '';
    get src(): string {
      return this._src;
    }
    set src(value: string) {
      this._src = value;
      requested.push(value);
      queueMicrotask(() => {
        const r = reply(value);
        if (r === 'hang') return;
        if (r) this.onload?.();
        else this.onerror?.();
      });
    }
  }
  globalThis.Image = FakeImage as unknown as typeof Image;
}

beforeEach(async () => {
  // 缓存是模块级的，用例之间必须清干净，否则上一个用例的结果会漏进下一个
  await resetQrMirrorCache();
  resetQrMirrorCache();
  installImage(() => true);
});

afterEach(() => {
  globalThis.Image = REAL_IMAGE;
  vi.useRealTimers();
});

describe('文件名守卫（补回 PublicPath 失去的那条）', () => {
  it('三个文件名都在 assets/qr/ 下真实存在', () => {
    for (const field of Object.keys(QR_FILES) as QrField[]) {
      const path = join(process.cwd(), 'assets', 'qr', QR_FILES[field]);
      expect(existsSync(path), `assets/qr/${QR_FILES[field]} 不存在 —— 改名了就要改 QR_FILES`).toBe(true);
    }
  });

  it('仓库里这三张与 BrandAssets 那份逐字节相同', () => {
    // 既有约定 记下的三个 sha256。图一旦被换过（而不是只挪了位置），这条会红，
    // 提醒人去重新确认"能不能扫"—— 那件事自动化不了，只能靠这条把变化摆到眼前。
    const EXPECTED: Record<QrField, string> = {
      alipay: '0362eb93469edcc4bdbd5e488ac7280f8024422b775551a0c9c88abe39b74cec',
      wechatPay: '936d272d2d2aae5851a26ca573d1646f3ca9137a4cfd1ab4680ee8e7f5e7724e',
      wechatOfficial: 'a83629c30406c8213866a0aed699de2c03785f835e15cb7b1242d4accc2623b3',
    };
    for (const field of Object.keys(EXPECTED) as QrField[]) {
      const buf = readFileSync(join(process.cwd(), 'assets', 'qr', QR_FILES[field]));
      expect(createHash('sha256').update(buf).digest('hex'), `${QR_FILES[field]} 被换了`).toBe(EXPECTED[field]);
    }
  });

  it('两个源的路径都带着 images/about 那一层', () => {
    // Gitee 的浏览地址显示成 `.../BrandAssets/about`，照着抄会少一层 `images/` ⇒ 404。
    // 同门 shistart 真踩过（2026-10-17），这里钉死，别让下一仓再踩一遍。
    for (const mirror of QR_MIRRORS) {
      for (const field of Object.keys(QR_FILES) as QrField[]) {
        expect(mirror[field]).toContain('/images/about/');
        expect(mirror[field].endsWith(`/${QR_FILES[field]}`)).toBe(true);
      }
    }
    expect(QR_MIRRORS.map((m) => m.id)).toEqual(['github', 'gitee']);
  });
});

describe('选源', () => {
  it('两个都通时取先成功的那个', async () => {
    installImage(() => true);
    const mirror = await chooseQrMirror();
    expect(mirror?.id).toBe('github');
  });

  it('GitHub 一直不回、Gitee 通了 ⇒ 用 Gitee（不能干等）', async () => {
    installImage((url) => (url.startsWith('https://gitee.com') ? true : 'hang'));
    const mirror = await chooseQrMirror();
    expect(mirror?.id).toBe('gitee');
  });

  it('两个都不通时返回 null，而不是"默认源"', async () => {
    installImage(() => false);
    // 返回默认源等于告诉调用方"有图"，实际上一张也加载不出来 —— 那正是静默失败
    expect(await chooseQrMirror()).toBeNull();
  });

  it('探测只探一张图，不是六张', async () => {
    installImage(() => true);
    await chooseQrMirror();
    expect(requested).toHaveLength(QR_MIRRORS.length);
    expect(new Set(requested).size).toBe(QR_MIRRORS.length);
  });
});

describe('超时', () => {
  it('迟迟不回按失败处理 —— 用户看到的是长时间空白', async () => {
    vi.useFakeTimers();
    installImage(() => 'hang');
    const probe = probeImage('https://example.com/x.png', 1000);
    // 先把 handler 挂上再推时钟：否则 reject 落在一个还没人接的 promise 上，
    // 会被 vitest 记成 unhandled rejection（假失败比真失败更难查）。
    const rejected = expect(probe).rejects.toThrow(/图片源不可用/);

    await vi.advanceTimersByTimeAsync(999);
    expect(vi.getTimerCount(), '还没到点就不该判死 —— 超时是兜底，不是提前放弃').toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2);
    await rejected;
  });
});

describe('候选顺序与缓存', () => {
  it('选中的源排第一，其余跟在后面', () => {
    const gitee = QR_MIRRORS.find((m) => m.id === 'gitee')!;
    expect(qrUrls(gitee, 'wechatPay')[0]).toContain('gitee.com');
    expect(qrUrls(gitee, 'wechatPay')).toHaveLength(QR_MIRRORS.length);
  });

  it('没选出源时按原序试 —— 探活失败不等于没图', () => {
    const urls = qrUrls(null, 'alipay');
    expect(urls).toHaveLength(QR_MIRRORS.length);
    expect(urls[0]).toContain('raw.githubusercontent.com');
  });

  it('缓存的是那个 Promise：连着调用只探一次', async () => {
    installImage(() => true);
    const [a, b] = await Promise.all([chooseQrMirrorCached(), chooseQrMirrorCached()]);
    expect(a).toBe(b);
    expect(requested).toHaveLength(QR_MIRRORS.length);
  });

  it('重试会作废缓存 —— 否则上一轮的失败会一直留着', async () => {
    installImage(() => false);
    expect(await chooseQrMirrorCached()).toBeNull();

    // 网络恢复了：不 reset 的话，第二次拿到的还是那个 null
    expect(await chooseQrMirrorCached()).toBeNull();
    resetQrMirrorCache();
    await resetQrMirrorCache();
    installImage(() => true);
    expect((await chooseQrMirrorCached())?.id).toBe('github');
  });
});
