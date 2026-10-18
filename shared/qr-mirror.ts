/**
 * 赞助二维码与公众号二维码的**镜像源选择**。
 *
 * 三张图（支付宝收款码 / 微信收款码 / 公众号横幅）不在扩展包里，放在
 * `ShiXiongZhiDao/BrandAssets` 这个共享资产仓，GitHub 与 Gitee 各一份。
 * 打开「关于」时**同时探两个源，谁先加载成功就用谁的** —— 国内与国外的网络对这两个源的
 * 可达性差别很大，写死任何一个都会让一部分人看到空白。
 *
 * ## 为什么图不在包里（这次改动的全部理由）
 *
 * 三张图共 210 KB，占 chrome 产物 zip（376 KB 压缩后）的 **54.8%** —— 也就是说
 * 一半以上的下载体积是三张只有打开「关于」才看得见的图。挪出去之后 zip 约 170 KB。
 *
 * 代价必须写在这里，别让下一个读代码的人自己发现：
 * - 多了一个**运行时外部依赖仓**。它改名 / 删除 / 被风控，所有引用它的插件的「关于」
 *   页会一起失去二维码。失败态是"加载不出来 + 重试"，**不是静默**（见 `useQrImage`）。
 * - 断网时这三张图必然没有。这是集中管理的固有代价，认下。
 *
 * ## 为什么这里不需要任何权限（实测过的，别再"顺手补一条 host_permissions"）
 *
 * 本扩展的 `permissions` 只有 tabs / storage / alarms / contextMenus，**没有**
 * `host_permissions`。MV3 的 host 权限管的是 fetch / XHR，不拦 `<img>` 这种子资源；
 * 扩展页默认 CSP（`script-src 'self'; object-src 'self'`）也没有限制 `img-src`。
 * 这条在同门的 shistart 上真机实测过（`origins: []` 下两个源都加载成功）。
 * **所以别为了这几张图去申请权限** —— 那是白给用户加一条安装警告。
 *
 * ## 探测只探一张图
 *
 * 每次打开多两个请求已经是上限了，不值得为"三个字段分别验"发六个请求：支付宝那张
 * 能加载，就认为这个源整体可用（三张图在同一个仓库同一个目录，不存在"只有一张通"的
 * 现实场景）。**真的出现了单张 404，由显示端逐张回落兜住**（见 `useQrImage`）。
 *
 * ## 结果要缓存
 *
 * 「关于」是设置页里的一个分区，用户可能来回切。不缓存的话每次切回来都重新发两个
 * 探测请求。缓存的是**那个 Promise 本身**（不是结果），所以并发调用只探一次。
 * 用户点了「重试」时由 `resetQrMirrorCache()` 主动作废 —— 那正是"上一轮网络不通、
 * 这一轮可能通了"的场景。
 */

/** 三张图的字段；名字与 `assets/qr/` 下的文件名一一对应（有单测钉着）。 */
export type QrField = 'alipay' | 'wechatPay' | 'wechatOfficial';

/**
 * 文件名只在这里写一遍。
 *
 * 为什么不再用 WXT 的 `PublicPath`：那个联合类型是 WXT 扫 `public/` 生成的，
 * 图挪走之后它就不存在了 —— 而"`satisfies Record<string, PublicPath>` ⇒ 图被删掉时
 * `vue-tsc` 当场红"这条编译期守卫会一起消失。补回来的办法是让**文件名**留在常量里，
 * 由 `test/qr-mirror.spec.ts` 断言 `assets/qr/<文件名>` 真实存在：改名忘改代码仍然会红，
 * 只是从编译期挪到了测试期。
 */
export const QR_FILES = {
  alipay: 'alipay.png',
  wechatPay: 'wechat-pay.png',
  wechatOfficial: 'wechat-official.png',
} as const satisfies Record<QrField, string>;

export interface QrMirror {
  id: 'github' | 'gitee';
  /** 探测用地址（取支付宝那张），也代表这个源通不通。 */
  probeUrl: string;
  alipay: string;
  wechatPay: string;
  wechatOfficial: string;
}

/**
 * 二维码在资产仓里的目录；两边目录结构一致，只换域名。
 *
 * **为什么在 `BrandAssets` 而不在本仓**：这几张图是「师兄知道」名下**多个插件共用**的
 * 资产（支付宝 / 微信收款码、公众号二维码对作者是同一套）。放在各自仓库里等于同一张图
 * 存 N 份，换一次就得改 N 个仓库、N 次发版；单独一个资产仓则是改一处、所有插件下次打开
 * 「关于」就生效 —— **不用发版**。
 *
 * 路径是 `images/about/`，两个平台**一致**（Gitee 的页面地址会显示成 `.../BrandAssets/about`，
 * 那只是浏览时的简化路径，raw 必须是 `raw/main/images/about/...`；同门实测：少一层
 * `images/` 是 404）。
 *
 * 2026-10-18 核对：BrandAssets 里这三张与本机原来的 `public/qr/` **sha256 逐字节相同**
 * （alipay `0362eb93…`、wechat-official `a83629c3…`、wechat-pay `936d272d…`），
 * 所以这次换源**不改变画面**，也不触动"能不能扫"这件事。
 */
const GITHUB_DIR = 'https://raw.githubusercontent.com/ShiXiongZhiDao/BrandAssets/main/images/about';
// Gitee 的 raw 链接会 302 跳到 raw.giteeusercontent.com 的签名地址（每次请求现签），
// 所以这里**必须写原始 URL** —— 把跳转后的地址抄下来会过期。
const GITEE_DIR = 'https://gitee.com/ShiXiongZhiDao/BrandAssets/raw/main/images/about';

export const QR_MIRRORS: readonly QrMirror[] = [
  {
    id: 'github',
    probeUrl: `${GITHUB_DIR}/${QR_FILES.alipay}`,
    alipay: `${GITHUB_DIR}/${QR_FILES.alipay}`,
    wechatPay: `${GITHUB_DIR}/${QR_FILES.wechatPay}`,
    wechatOfficial: `${GITHUB_DIR}/${QR_FILES.wechatOfficial}`,
  },
  {
    id: 'gitee',
    probeUrl: `${GITEE_DIR}/${QR_FILES.alipay}`,
    alipay: `${GITEE_DIR}/${QR_FILES.alipay}`,
    wechatPay: `${GITEE_DIR}/${QR_FILES.wechatPay}`,
    wechatOfficial: `${GITEE_DIR}/${QR_FILES.wechatOfficial}`,
  },
];

export const PROBE_TIMEOUT_MS = 4000;

/**
 * 探一张图能不能加载。成功 resolve，失败或**超时** reject。
 *
 * 超时按失败处理：一个迟迟不返回的地址比一个明确报错的地址更耽误人 —— 用户看到的
 * 是长时间空白。
 *
 * ⚠ jsdom（本仓单测环境）里 `Image` 存在但**不会真的去取图**，`onload`/`onerror`
 * 永远不触发。所以这里必须有超时，否则单测会挂住；而单测要验证探活逻辑就得
 * **自己替换全局 `Image`**（见 `test/qr-mirror.spec.ts`），别指望 jsdom 替你发请求。
 */
export function probeImage(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    // 没有 Image 的环境（纯 node）明确失败，让调用方走"不可用"分支，
    // 而不是抛一个 TypeError 把上层炸掉。
    if (typeof Image === 'undefined') {
      reject(new Error(`当前环境没有 Image：${url}`));
      return;
    }
    const image = new Image();
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (success: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (success) resolve();
      else reject(new Error(`图片源不可用：${url}`));
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });
}

/**
 * 选出可用的镜像：**并发探，谁先成功用谁**（不是"探通了再比速度"—— 那要多一轮）。
 *
 * 全部失败时返回 **null**，不返回"默认源"：返回默认源等于告诉调用方"有图"，
 * 而实际上一张也加载不出来，那正是"看起来一切正常"的静默失败。明确返回 null，
 * 由显示端说"加载不出来"。
 */
export function chooseQrMirror(timeoutMs = PROBE_TIMEOUT_MS): Promise<QrMirror | null> {
  return Promise.any(
    QR_MIRRORS.map(async (mirror) => {
      await probeImage(mirror.probeUrl, timeoutMs);
      return mirror;
    }),
  ).catch(() => null);
}

/** 缓存的是那个 Promise：并发调用只探一次，失败了也只留着失败的结果。 */
let cached: Promise<QrMirror | null> | null = null;

/** 带缓存的选源。界面一律用这个，不要直接调 `chooseQrMirror`。 */
export function chooseQrMirrorCached(timeoutMs = PROBE_TIMEOUT_MS): Promise<QrMirror | null> {
  cached ??= chooseQrMirror(timeoutMs);
  return cached;
}

/**
 * 作废缓存（重试按钮 / 单测）。
 *
 * 返回上一个 Promise 只是为了让调用方能 `await` 掉它，避免上一轮还在飞行中的探测
 * 在 reset 之后又落回来写成新缓存 —— 那种"旧结果覆盖新结果"的竞态很难复现，
 * 所以在这里一次性处理掉。
 */
export function resetQrMirrorCache(): Promise<QrMirror | null> | null {
  const previous = cached;
  cached = null;
  return previous;
}

/**
 * 一个字段的候选地址列表：**选中的源排第一，其余跟在后面**。
 *
 * 顺序就是回落的顺序 —— 探测时的胜者未必每张图都通（单张 404 / 被缓存污染），
 * 显示端按这个列表一张张退。没选出源时按 QR_MIRRORS 原序试。
 */
export function qrUrls(mirror: QrMirror | null, field: QrField): string[] {
  const ordered = mirror
    ? [mirror, ...QR_MIRRORS.filter((item) => item.id !== mirror.id)]
    : [...QR_MIRRORS];
  return ordered.map((item) => item[field]);
}
