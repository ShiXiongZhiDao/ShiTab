/**
 * 运行期单例。三个 surface 与 background 都从这里拿同一套 port。
 *
 * 放 shared/ 而不是 infrastructure/，是因为它同时装配 port 与 use case 的依赖；
 * 放 infrastructure/ 会让 core 反过来依赖基础设施目录，破坏 ARCHITECTURE §3 的单向分层。
 */

import { createSearchService } from '@/core/application/search-tabs';
import { createBrowserTabsPort } from '@/infrastructure/browser/browser-tabs';
import { createBrowserEventsPort } from '@/infrastructure/browser/browser-events';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { createWebDavPort } from '@/infrastructure/webdav/http-webdav';
import { createAlarmPort } from '@/infrastructure/browser/browser-alarms';
import { createContextMenusPort } from '@/infrastructure/browser/browser-context-menus';
import type { StoragePort } from '@/core/ports/storage';
import type { WebDavAdminPort, WebDavPort } from '@/core/ports/webdav';
import type { AlarmPort } from '@/core/ports/alarms';
import type { BrowserTabsPort } from '@/core/ports/browser-tabs';
import type { BrowserEventsPort } from '@/core/ports/browser-events';
import type { ContextMenusPort } from '@/core/ports/context-menus';
import { markHealDuration } from '@/shared/perf-diagnostics';

export const storagePort: StoragePort = createStoragePort();
export const tabsPort: BrowserTabsPort = createBrowserTabsPort();

/**
 * 生命周期事件**只在 background 订阅**。
 *
 * 这个 port 在这里创建是因为三个 surface 与 background 共用同一套装配点，
 * 但 `subscribe()` 只在 background.ts 里调用一次 —— 在 UI 进程里订阅会让
 * 每个打开的页面各自补建一次入口页（用户会看到标签栏多出一排 T）。
 */
export const eventsPort: BrowserEventsPort = createBrowserEventsPort();

/**
 * WebDAV 与后台定时器同样是这里的单例。
 *
 * 为什么不在 `background.ts` 里自己 new：那样**测试碰不到它们**。真接线的用例要能
 * 桩掉网络、看清 alarm 有没有被 ensure/clear；自己 new 的话唯一选择是去打真 fetch，
 * 那既不确定也不该出现在 CI 里。
 */
const webdavInstance = createWebDavPort();
/** 同步引擎的依赖：只读接口那一半（`remove` 不在 `WebDavPort` 上，既有约定）。 */
export const webdavPort: WebDavPort = webdavInstance;
/**
 * 同一个实例的**管理视图**：保留策略要删文件，而删除能力只在
 * `WebDavAdminPort` 那一半上。刻意用同一个实例而不是再 new 一个 —— 两份实现会各自
 * 维护自己的连接语义，而"我刚 PUT 的那个文件在不在"必须问的是同一台对象。
 */
export const webdavAdminPort: WebDavAdminPort = webdavInstance;
export const alarmPort: AlarmPort = createAlarmPort();

/**
 * 浏览器右键菜单。
 *
 * 同样**只在 background 用**，但放在这里是为了让测试能桩掉它 —— 与 webdav/alarm 那条理由一致。
 * 注册判据（六项、两个上下文、标题随语言）全部要靠读它才能钉住。
 */
export const contextMenusPort: ContextMenusPort = createContextMenusPort();

/** use case 的依赖包。所有命令都收这个，方便单测换实现。 */
export const deps = { storage: storagePort, tabs: tabsPort };

let ready: Promise<void> | undefined;

/**
 * 首次使用前必须 await：heal() 会修 index 与 group 键的偏差，
 * 没跑完就读快照会读到脏 index。
 */
export function ensureReady(): Promise<void> {
  // 首屏计时的 heal 那一段（开发构建里才打印，见 `shared/perf-diagnostics.ts`）。
  const healStartedAt = Date.now();
  ready ??= storagePort
    .heal()
    .then((report) => {
      markHealDuration(Date.now() - healStartedAt, {
        groupCount: report.groupCount,
        fixedTabCounts: report.fixedTabCounts,
      });
      if (report.droppedFromIndex || report.rebuiltIntoIndex || report.fixedTabCounts) {
        console.warn('[shitab] 存储自愈', report);
      }
    })
    .catch((error: unknown) => {
      // 不让一次失败的 heal 永久卡住后续调用
      ready = undefined;
      console.error('[shitab] 初始化失败', error);
    });
  return ready;
}

export const searchService = createSearchService({
  listGroupIndex: () => storagePort.listGroupIndex(),
  listGroupsByIds: (ids) => storagePort.listGroupsByIds(ids),
});

/**
 * 这里**以前**有一行 `storagePort.watchGroups(() => searchService.invalidate())`，2026-10-06 删掉了。
 * 删它的理由就是上面那条缓存策略：搜索每次都先读 index、按会话条目比指纹 ⇒ 变更本来就会被认出来，
 * 而"整份作废"反而让每次变更后的第一次搜索重读全部会话（实测 300 组 = 900 次读，既有约定 决定 6）。
 * ⚠ 别把它当死代码加回来 —— `watchGroups` 仍然被工作台重载与同步标脏用着，只有搜索这一路不再订阅。
 */
