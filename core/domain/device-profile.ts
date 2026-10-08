/**
 * 本机设备档案。
 *
 * 这一层全是**纯函数 + 一处读浏览器指纹**：不做 IO、不读存储、不碰 `browser.*`。
 * 存的时机在 `infrastructure/storage/wxt-storage.ts`，用的时机在 `core/application/sync-engine.ts`，
 * 中间这些判据要能被单条用例直接喂字符串测到 —— 检测那一半如果不能注入，
 * 就只能测 jsdom 的 UA，而 jsdom 的 UA 谁都不会在真机上看见。
 *
 * 为什么设备名要"能改、能跨设备看见"：设备身份是一个随机 UUID，冲突面板过去只能显示
 * 它的前 8 位，两台设备之间无法互相辨识（用户对着 `3f2a9c1e` 决定"保留哪一边"，
 * 那不是在裁决，是在猜）。
 */

import type { DevicePointer, DeviceProfile } from '@/shared/types';

/** 检测出来的浏览器名。`Browser` 是兜底档：认不出来就说实话，不猜一个 Chrome。 */
export type BrowserName = 'Chrome' | 'Edge' | 'Firefox' | 'Safari' | 'Browser';

/** 检测出来的平台。空串 = 认不出来（默认名里就不带平台那半）。 */
export type PlatformName = 'Windows' | 'macOS' | 'Linux' | 'ChromeOS' | 'Android' | '';

/**
 * 一份可注入的指纹来源。
 *
 * ⚠ 三个字段全是可选的，而且这是**事实**不是宽容：`userAgentData` 只有 Chromium 有
 * （Firefox 明确不实现），而 service worker 与 node 环境里 `navigator` 本身都可能是 undefined
 * —— 同步引擎跑在 background，它读档案时会走到这里，任何一处直接 `navigator.userAgent`
 * 就是一次 TypeError，而代价是"整台设备打不开同步设置"。
 */
export interface DeviceNameSource {
  userAgent?: string;
  /** `navigator.userAgentData.brands` 里的品牌名。 */
  brands?: string[];
  /** `navigator.userAgentData.platform`。 */
  uaPlatform?: string;
}

/** 读真的浏览器指纹（唯一的取处）。缺什么就按缺处理。 */
export function readDeviceNameSource(): DeviceNameSource {
  const nav = (globalThis as { navigator?: DeviceNameSource & { userAgentData?: { brands?: Array<{ brand: string }>; platform?: string } } })
    .navigator;
  const data = nav?.userAgentData;
  return {
    userAgent: typeof nav?.userAgent === 'string' ? nav.userAgent : '',
    brands: Array.isArray(data?.brands) ? data.brands.map((brand) => brand.brand) : undefined,
    uaPlatform: typeof data?.platform === 'string' ? data.platform : undefined,
  };
}

/**
 * 浏览器名：`userAgentData` 优先（Chromium 系里它比 UA 准，Edge 在 UA 里也写 Chrome），
 * UA 兜底（Firefox 没有 `userAgentData`，老环境同理）。
 *
 * 顺序里有两条容易被"顺手简化"掉的判据：
 * - Edge 必须比 Chrome 先认 —— Edge 的 `brands` 与 UA 里都同时带着 Chrome。
 * - Safari 那条负向先行（UA 里不许同时出现 chrome/android）：Chromium 系的 UA
 *   结尾也带 `Safari/537.36`，先认 Safari 会把所有 Chrome 用户叫成 Safari。
 */
export function detectBrowser(source: DeviceNameSource = readDeviceNameSource()): BrowserName {
  const brands = (source.brands ?? []).join(' ');
  if (/Microsoft Edge/i.test(brands)) return 'Edge';
  if (/Google Chrome/i.test(brands)) return 'Chrome';

  const ua = source.userAgent ?? '';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  // Opera 的 Blink 内核与 Chrome 同一条渲染线，对用户是同一档
  if (/OPR\//.test(ua)) return 'Chrome';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/^((?!chrome|android).)*safari/i.test(ua)) return 'Safari';
  return 'Browser';
}

export function detectPlatform(source: DeviceNameSource = readDeviceNameSource()): PlatformName {
  const uaPlatform = source.uaPlatform ?? '';
  if (uaPlatform) {
    if (/windows/i.test(uaPlatform)) return 'Windows';
    // `macOS` 与 `Mac OS X` 两种写法都见过（后者来自 `navigator.platform`）
    if (/mac/i.test(uaPlatform)) return 'macOS';
    if (/linux/i.test(uaPlatform)) return 'Linux';
    if (/chrome os|cros/i.test(uaPlatform)) return 'ChromeOS';
    if (/android/i.test(uaPlatform)) return 'Android';
  }
  const ua = source.userAgent ?? '';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Android/.test(ua)) return 'Android';
  // X11 排在 Linux 之前无所谓：两者都是桌面 Linux，而有些发行版只写 X11。
  if (/Linux|X11/.test(ua)) return 'Linux';
  return '';
}

/** 默认名 = `浏览器 · 平台`；认不出平台就只留浏览器，不留一个孤零零的 `·`。 */
export function defaultDeviceName(browser: BrowserName, platform: PlatformName): string {
  return platform ? `${browser} · ${platform}` : browser;
}

/** 改名与默认名的长度上限（字符，不是字节）。 */
export const DEVICE_NAME_MAX = 40;

/**
 * 规范化一次改名：trim / 空名回退默认 / 超长截断。
 *
 * 截断用 `Array.from` 而不是 `slice`：按码元切的话把一个 emoji 或生僻字切成半个代理对，
 * 屏幕上是一个替换字符 —— 而这个名字会进远端载荷、在**另一台**设备的冲突面板上显示。
 * 上限 40 防的是同一条线另一端：有人粘一整段备注进来，冲突那一行就撑破了。
 */
export function normalizeDeviceName(
  raw: string,
  profile: Pick<DeviceProfile, 'browser' | 'platform'>,
): string {
  const trimmed = raw.trim();
  if (!trimmed) return defaultDeviceName(profile.browser as BrowserName, profile.platform as PlatformName);
  const chars = Array.from(trimmed);
  return chars.length > DEVICE_NAME_MAX ? chars.slice(0, DEVICE_NAME_MAX).join('') : trimmed;
}

/**
 * 造一份新档案（懒生成的那一支走这里）。
 *
 * 检测只做**这一次**并落盘：UA 会变（浏览器升级、用户换内核），而设备名跟着变
 * 会让对面看见"昨天那台设备改名了" —— 那是把浏览器版本当成身份，比不变更扰。
 */
export function buildDeviceProfile(at: number, id: string, source?: DeviceNameSource): DeviceProfile {
  const browser = detectBrowser(source);
  const platform = detectPlatform(source);
  return { id, name: defaultDeviceName(browser, platform), browser, platform, createdAt: at };
}

/**
 * 合并两侧的 manifest 设备表。
 *
 * 三条要求，缺一条就得出问题：
 * 1. **同一 id 取 `updatedAt` 大的那条** ⇒ 名字以"这台设备最后一次写 manifest"为准，
 *    不是以"谁的本地缓存先算出来"为准。
 * 2. **平手时取 `name` 字典序小者** ⇒ 两边同时写、时间戳撞车（毫秒级并发是真会发生的）
 *    也能算出同一个结果，而不是各留各的。
 * 3. **结果按 id 排序** ⇒ 设备 A 算出来的那一份与设备 B 算出来的逐字节一致。
 *    这条与 `core/domain/merge.ts` 的可交换性是同一个要求：manifest 是写进远端给别人读的，
 *    两个方向的合并算出两张表就是每轮同步多一版"内容其实一样"的快照。
 */
export function mergeDeviceTables(local: DevicePointer[] = [], remote: DevicePointer[] = []): DevicePointer[] {
  const byId = new Map<string, DevicePointer>();
  for (const pointer of [...local, ...remote]) {
    const held = byId.get(pointer.id);
    if (!held) {
      byId.set(pointer.id, pointer);
      continue;
    }
    const winner =
      pointer.updatedAt > held.updatedAt
        ? pointer
        : pointer.updatedAt < held.updatedAt
          ? held
          : pointer.name < held.name
            ? pointer
            : held;
    byId.set(pointer.id, winner);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 从设备表里解析名字。查不到就 `undefined` —— 由调用方回退，这里不编一个名字。 */
export function nameOfDevice(
  devices: DevicePointer[] | undefined,
  deviceId: string,
): string | undefined {
  return devices?.find((device) => device.id === deviceId)?.name;
}
