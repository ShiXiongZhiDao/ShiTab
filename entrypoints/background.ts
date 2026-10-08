/**
 * Background service worker（既有约定 §5 + V1.1 设计包 §7 / §48）。
 *
 * 挂三样东西：
 * 1. **图标点击 = 收纳**（`action.onClicked`）。manifest 里**不能有 `default_popup`**：
 *    官方文档明写"if you set default_popup, the onClicked event will not be triggered"，
 *    所以 popup 整套删除不是"产品选择"而是这条机制的直接后果。
 * 2. **入口页 T 的生命周期**（core/application/pinned-entry-tab）。只在**这里**订阅事件。
 * 3. **长任务的命令通道**：整组恢复 / 单条恢复 / 撤销 + 页面自修复。
 * 4. **收纳结果的通知**（`publishCaptureNotice`）：撤销条的宿主是工作台页面，
 *    而收纳入口只剩图标之后，页面自己不知道"刚刚发生过一次可撤销的收纳"。
 *
 * 纯数据命令（重命名 / 排序 / 删除 / 设置 / 导入导出）在调用方进程内直接执行
 * core/application 里的 use case，不绕这一圈。
 */

import { captureWindow, createStashLock } from '@/core/application/capture-window';
import { MENU_ENTRIES, menuEntryOf, type CaptureScope } from '@/core/application/capture-scopes';
import { restoreGroup, restoreTab, undoCapture } from '@/core/application/restore-group';
import { createPinnedEntryTab } from '@/core/application/pinned-entry-tab';
import { publishCaptureNotice, registerCommandHandler } from '@/shared/messages';
import { isSyncPing } from '@/shared/sync-heartbeat';
import { alarmPort, contextMenusPort, deps, ensureReady, eventsPort, storagePort, webdavAdminPort, webdavPort } from '@/shared/services';
import { markDirty, requestSync } from '@/core/application/sync-engine';
import { SYNC_DEBOUNCE_MS } from '@/core/domain/sync-wake';
import { BACKGROUND_ALARM_PERIOD_MINUTES, SYNC_ALARM_NAME } from '@/shared/constants';
import { activeLocale, t, setLocaleChoice } from '@/shared/i18n';
import type { MenuClickInfo } from '@/core/ports/context-menus';
import type { ResolvedLocale } from '@/core/domain/settings';
import type { CaptureOutcome, SyncTriggerReason, WebDavConfig } from '@/shared/types';

/** 收纳进行中/刚结束时工具栏图标的短暂反馈。设计包 §26：默认不显示数字，只在反馈时显示。 */
const BADGE_FEEDBACK_MS = 4_000;

/**
 * 菜单注册的**进程级**串行队列。
 *
 * 为什么放在闭包外面：一个浏览器进程里只有一份菜单，而"两批 create 交错"会留下缺格的菜单 ——
 * 后一次的 `removeAll` 清掉前一次已建好的项，前一次排着的 `create` 再撞上重复 id。
 * 这在真机上有一条到达路径（启动读设置那条链，和紧随其后的 onInstalled/onStartup），
 * 在测试里有一条更常见的：`test/background.spec.ts` 的"worker 重启"那组会**再调一次
 * `background.main()`**，两个闭包共用同一个 port。队列按闭包分就管不住它们。
 *
 * ⚠ 这条不是测试噪音、也不该靠把假件改成"重复 id 静默覆盖"糊过去：那个 throw 正是
 * 现场证据，把它调哑就等于把这道闸拆了。
 */
let menuRegistration: Promise<void> = Promise.resolve();

export default defineBackground(() => {
  void ensureReady();

  /**
   * 语言也要在 background 里跟着设置走：badge 的标题、"已收纳 N 个"那几句
   * 是这里生成的。不接的话会出现"界面选了 English、工具栏提示还是中文"，
   * 而用户没法判断是哪一边没跟上。
   * 这里不用 `useLocale()`：SW 没有组件作用域，`onScopeDispose` 会当场告警。
   *
   * 右键菜单的注册**挂在这条链上**（既有约定 决定 8），两个原因：
   * - 菜单标题是浏览器层的，那个开关本来管不到它 ⇒ 不主动重建就是"界面切了英文、菜单还中文"；
   * - 注册必须排在语言读回来**之后**。早一步注册，标题会按兜底语言（en）落一次，
   *   中文用户装完立刻右键看到的是一排英文。
   */
  void storagePort
    .getSettings()
    .then((settings) => setLocaleChoice(settings.locale))
    .then(() => ensureMenus(true))
    .catch(() => undefined);
  storagePort.watchSettings((settings) => {
    setLocaleChoice(settings.locale);
    // 语言没变时 ensureMenus 自己会跳过，所以这个 watcher 对每一次设置写入都触发也不吵
    void ensureMenus().catch((error: unknown) => console.error('[shitab] 右键菜单重建失败', error));
  });

  const entry = createPinnedEntryTab({ ...deps, events: eventsPort });
  const captureDeps = { ...deps, entry };
  const stashLock = createStashLock();
  entry.start();

  // ---------------------------------------------------------------------------
  // 同步的节拍与入口（既有约定 的账本 + 既有约定 的判据 + 既有约定 的页面心跳
  // + 既有约定 的后台 alarm + 既有约定 的统一 requestSync）
  //
  // 三件事分开看，别再混成一句"定时器只是加速器"：
  // - **账本**（`dirtySinceAt`）保证"本机改了迟早会推出去"，不靠 `setTimeout` 活着；
  // - **判据**（`decideSync` → `dueForSync`）回答"这一轮要不要真跑"：退避 > 脏(去抖) > 拉取间隔；
  // - **节拍**（谁来问一次）：本机变更、页面心跳、后台 alarm、worker 启动、用户点按钮。
  // 五类节拍**只能走 `requestSync`**，谁都不许自己决定跑不跑、更不许直接调 `runSync`。
  // ---------------------------------------------------------------------------

  // `admin` 是保留策略那一格：账本裁到窗口之后，被裁掉的那几版要真删掉，
  // 否则网盘上留下的是界面看不见的孤儿文件。不传就等于不删。
  const syncDeps = { storage: storagePort, webdav: webdavPort, admin: webdavAdminPort };
  const alarms = alarmPort;

  /** 自动节拍的共同出口：`requestSync` 自己不抛，这里只兜"意外"那一条。 */
  function wake(reason: SyncTriggerReason): void {
    void requestSync(syncDeps, reason, Date.now()).catch((error: unknown) => {
      // 同步失败绝不能把收纳这条主路径带下水（§7.3）
      console.warn('[shitab] 同步异常', error);
    });
  }

  /**
   * 同步开着 ⇒ 装后台兜底定时器；关着 ⇒ 撤掉。
   *
   * "关掉同步就不许再碰我的服务器"这句话只有配上 `clear` 才是真的：光让 `requestSync`
   * 在回调里 skip，服务器仍然每 5 分钟被敲一次（propfind 都省不掉，因为 alarm 本身就是那次唤醒）。
   */
  async function syncAlarmFor(config: WebDavConfig): Promise<void> {
    if (config.enabled) await alarms.ensure(SYNC_ALARM_NAME, BACKGROUND_ALARM_PERIOD_MINUTES);
    else await alarms.clear(SYNC_ALARM_NAME);
  }

  alarms.onAlarm((name) => {
    if (name !== SYNC_ALARM_NAME) return;
    void storagePort.getWebDavConfig()
      .then(async (config) => {
        // 兜底：关掉同步那一次的 clear 万一没落地（进程被强杀 / 平台抖动），在这里再撤一次
        if (!config.enabled) {
          await alarms.clear(SYNC_ALARM_NAME);
          return;
        }
        await requestSync(syncDeps, 'alarm', Date.now());
      })
      .catch(() => undefined);
  });

  /**
   * 配置变了：同步开着就保证后台节拍存在，关着就把 alarm 撤掉并把账本写清。
   *
   * 那笔 `status: 'disabled'` 的落账**不能省**。以前它由 `runSync` 开头那句顺手写了，
   * 而 既有约定 之后 `requestSync` 在进引擎之前就 skip 掉 ⇒ 那句再也不执行，
   * 用户关掉同步之后，设置页的状态行会一直挂着上一次失败留下的那句「同步失败」，
   * 工作台顶栏的 pill 也不会消失 —— 那是"关掉同步反而更像坏了"这种最难解释的现象。
   *
   * 只在真的从别的状态切过来时写一次：这个 watcher 对**每一次**配置写入都会触发
   * （改地址、点测试连接都会），无条件写就是每次多一发存储写 + 一轮 watcher 广播。
   */
  storagePort.watchWebDavConfig((config) => {
    void (async () => {
      await syncAlarmFor(config);
      if (config.enabled) return;
      const meta = await storagePort.getSyncMeta();
      if (meta.status !== 'disabled') {
        await storagePort.setSyncMeta({ ...meta, status: 'disabled' });
      }
    })().catch(() => undefined);
  });

  let syncTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 什么算"本地变了"。**三个键都要接**，不是只接会话：
   * 同步载荷是 会话 + 分类 + 墓碑 + 回收站 四项，而有一批用户动作**只碰后两项** ——
   * 最典型的就是"从回收站里彻底删除一行"（`purgeFromTrash` 只写墓碑与回收站，
   * 一个会话键都不动）。旧代码只听 `watchGroups`，那种动作在这里根本不算"变了"，
   * 于是这台机器**永远不会把它推出去**：用户点了彻底删除，另一台设备上那一行还在躺著。
   *
   * 反过来（拉取侧）也会写到这两个键，所以本机的落库会再标一次脏 ——
   * 那是收敛不是循环：`runSync` 比对的是内容 checksum，两边一样就走 `no-changes`
   * 并把脏标记清掉（既有约定 的去重），远端不会因此多出文件。
   */
  function markChanged(): void {
    void markDirty(syncDeps)
      .then(() => {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => wake('local-change'), SYNC_DEBOUNCE_MS);
      })
      .catch(() => undefined);
  }

  storagePort.watchGroups(markChanged);
  storagePort.watchTombstones(markChanged);
  storagePort.watchTrash(markChanged);

  // worker 一起来就做两件事：把后台兜底定时器补上（Firefox 的 alarm 不跨浏览器会话，
  // 重启之后只有这里能把它装回来），再补一刀同步 —— 死在去抖窗口里的改动、以及
  // "对面推了新东西而本机一直没动"这两笔欠账都靠这里落地。
  void (async () => {
    await syncAlarmFor(await storagePort.getWebDavConfig());
    await requestSync(syncDeps, 'startup', Date.now());
  })().catch((error: unknown) => console.warn('[shitab] 启动同步失败', error));

  /**
   * 页面的心跳：工作台/设置页开着的时候，每 60 秒有人来敲一下，这里判一次。
   *
   * 这条是被一条真机反馈逼出来的：「在 Edge 删了标签，Chrome 的 ShiTab 页面等了半天没同步过来」。
   * 判据（0081）已经会答"该拉了"，问题是**没人来问** —— SW 空闲 30 秒就被杀，而"用户正盯着
   * 那个页面看"这件事本身不会叫醒 SW。心跳把节拍搬到页面活着的那段时间上：
   * 有人看的时候保证会更新，没人看的时候不花任何请求。
   *
   * 单向、不回值：`requestSync` 自己不抛（判据 skip，或引擎把失败编进返回值）。
   */
  const onSyncPing = (message: unknown): undefined => {
    if (isSyncPing(message)) wake('heartbeat');
    return undefined;
  };
  browser.runtime.onMessage.addListener(onSyncPing);

  let clearBadgeTimer: ReturnType<typeof setTimeout> | undefined;

  function flashBadge(text: string, title: string): void {
    // setBadgeText/setTitle 是 action 级全局，多窗口共用一个图标，这是有意的取舍
    void browser.action.setBadgeText({ text }).catch(() => undefined);
    void browser.action.setTitle({ title }).catch(() => undefined);
    if (clearBadgeTimer) clearTimeout(clearBadgeTimer);
    clearBadgeTimer = setTimeout(() => {
      void browser.action.setBadgeText({ text: '' }).catch(() => undefined);
      void browser.action
        .setTitle({ title: t('action_default_title') })
        .catch(() => undefined);
    }, BADGE_FEEDBACK_MS);
  }

  /**
   * 一次收纳。并发保护用**忽略**而不是排队（设计包 §22 的建议）：
   * 排队会让用户的第二次点击在几百毫秒后突然又关掉一个窗口。
   *
   * `scope` 不给 = 整窗（图标左键那条老路径，一字未动）；给 = **在这一个窗口内**缩小集合
   * （既有约定 决定 6）。菜单项与图标左键共用这一把锁，所以从右键连点两下和从左键连点
   * 两下是同一个语义。
   */
  async function stash(
    windowId: number,
    scope?: { kind: CaptureScope; anchorTabId: number },
  ): Promise<CaptureOutcome> {
    if (!stashLock.tryAcquire()) {
      flashBadge('…', t('action_in_progress'));
      return { ok: false, reason: 'in-progress', pinnedSkipped: 0 };
    }
    try {
      return await captureWindow(captureDeps, { windowId, scope });
    } finally {
      stashLock.release();
    }
  }

  function reportOutcome(windowId: number, outcome: CaptureOutcome): void {
    if (outcome.ok) {
      flashBadge(String(outcome.result.saved), t('action_stashed', { count: outcome.result.saved }));
      // 撤销条的宿主是工作台页面。收纳入口只剩图标之后，页面自己不会再有
      // "刚按了一下"的时机，所以由这里把结果告诉它。带上 windowId 很关键：
      // 别的窗口发生的收纳不该在本窗口弹出一条撤销。
      publishCaptureNotice({ windowId, result: outcome.result });
      return;
    }
    flashBadge(
      outcome.reason === 'in-progress' ? '…' : '0',
      t(outcome.reason === 'in-progress' ? 'action_in_progress' : 'capture_no_tabs'),
    );
  }

  /**
   * 「收纳所有窗口」= 对每个 normal 窗口各跑一次整窗收纳（既有约定 决定 6 的补充格）。
   *
   * 三件事分开说清：
   * 1. **锁整段持有**，不是每窗口各抢一次 —— 否则这一次点击会跟自己的第二个窗口抢锁，
   *    后面的窗口全被判成"上一次收纳还在跑"而忽略掉。
   * 2. **一个窗口一个会话**，不并成一个：`sourceWindowId`、落脚页、撤销条都是按窗口成立的，
   *    并成一个要动的是快照格式（同步载荷的格式名是冻结的）。代价如实记着 ——
   *    点一次可能在列表顶部留下 N 个未命名会话。
   * 3. **一个窗口失败不中断其余**，但 badge 要说实话（"收纳失败，原标签未关闭"）。
   */
  async function stashAllWindows(anchorWindowId: number): Promise<void> {
    if (!stashLock.tryAcquire()) {
      flashBadge('…', t('action_in_progress'));
      return;
    }
    const outcomes: Array<{ windowId: number; outcome: CaptureOutcome }> = [];
    let threw = false;
    try {
      // "所有窗口"吃的是既有的 normal 窗口口径（弹出窗、devtools 都不算），
      // 与每个窗口一个入口页那条用的是同一个函数，不另开一份"什么算窗口"。
      for (const win of await deps.tabs.listNormalWindows()) {
        try {
          outcomes.push({
            windowId: win.id,
            outcome: await captureWindow(captureDeps, { windowId: win.id }),
          });
        } catch (error) {
          threw = true;
          console.error('[shitab] 跨窗口收纳在一个窗口上失败，继续其余窗口', win.id, error);
        }
      }
    } finally {
      stashLock.release();
    }

    if (threw) {
      flashBadge('!', t('capture_failed_kept_open'));
      return;
    }
    const saved = outcomes.reduce(
      (total, item) => total + (item.outcome.ok ? item.outcome.result.saved : 0),
      0,
    );
    if (saved === 0) {
      flashBadge('0', t('capture_no_tabs'));
      return;
    }
    flashBadge(String(saved), t('action_stashed', { count: saved }));
    // badge 报**总数**，撤销条只报**发起那一窗口**的结果：一条撤销兑现不了四个窗口的回滚
    // （既有约定 决定 8）。撤销条上的数字就是那一个窗口的数，所以它不过度承诺。
    const own = outcomes.find((item) => item.windowId === anchorWindowId)?.outcome;
    if (own?.ok) publishCaptureNotice({ windowId: anchorWindowId, result: own.result });
  }

  browser.action.onClicked.addListener((tab) => {
    // tab.windowId 缺失只在异常情况下出现；没有它宁可什么都不做，也不去猜某个窗口
    const windowId = tab.windowId;
    if (windowId === undefined) {
      console.warn('[shitab] 图标点击没带 windowId，忽略本次');
      return;
    }
    void stash(windowId)
      .then((outcome) => reportOutcome(windowId, outcome))
      .catch((error: unknown) => {
        // AC-04 / §21 情况 C：持久化失败时一条 tab 都没关，必须说清楚
        console.error('[shitab] 收纳失败', error);
        flashBadge('!', t('capture_failed_kept_open'));
      });
  });

  // ---------------------------------------------------------------------------
  // 浏览器原生右键菜单：网页右键 + 工具栏图标右键，同一套六项
  // ---------------------------------------------------------------------------

  /**
   * 两个上下文，一次注册。**故意不写 `'all'`**：官方定义里 `'all'` 等于除 `'launcher'`
   * 之外的全部上下文，那会把 `selection` / `link` / `image` / `editable` 一起带上，
   * 而这四项跟"收纳这窗口的标签"无关 —— 多一处出现就多一处要解释的位置。
   *
   * ⚠ 这里记一次我自己犯过的错：上一轮我从"OneTab 的 bundle 里搜不到 `'action'` 字样"
   * 推出"OneTab 没有工具栏图标右键菜单"。错在 `'all'` **本来就含** `'action'`。
   * 负面检索不是证据（同一条教训在本仓库已经记过三次了）。
   */
  const MENU_CONTEXTS = ['page', 'action'] as const;

  /** 上一次注册用的语言。SW 每次唤醒重置，所以"唤醒即重建"是天然行为，不需要额外记账。 */
  let registeredLocale: ResolvedLocale | undefined;

  /**
   * 注册 = 先清后建，只在**生效语言变了**或被平台事件要求重建时做。
   *
   * 语言这一刀必须接：菜单标题活在浏览器层，我们那个应用内语言开关管不到它。
   * 不接的结果是"界面切了 English、右键菜单还是中文"，而 `shared/i18n.ts` 文件头写的
   * 恰恰是这类自相矛盾要避免。先 `removeAll` 是幂等的前提：不先清，更新一次就多堆一排重复项。
   *
   * 排队用的是文件头那个**进程级**的 `menuRegistration`，理由写在那里。
   */
  function ensureMenus(force = false): Promise<void> {
    const run = () => registerMenusNow(force);
    menuRegistration = menuRegistration.then(run, run);
    return menuRegistration;
  }

  async function registerMenusNow(force: boolean): Promise<void> {
    const locale = activeLocale.value;
    if (!force && locale === registeredLocale) return;
    registeredLocale = locale;
    await contextMenusPort.removeAll();
    for (const item of MENU_ENTRIES) {
      await contextMenusPort.create({
        id: item.id,
        title: t(item.titleKey),
        contexts: MENU_CONTEXTS,
      });
    }
  }

  /**
   * 点击路由。**锚点 = 平台带回来的那个标签页**（既有约定 决定 5）：
   * 网页右键时它是被右键那页的标签，图标右键时它是该窗口的活动标签。
   * 两处都由平台给，我们自己不算"当前标签" —— 那会造出第二个真相。
   */
  async function onMenuClick(info: MenuClickInfo): Promise<void> {
    const item = menuEntryOf(info.menuItemId);
    if (!item) {
      console.warn('[shitab] 收到没注册过的菜单项 id', info.menuItemId);
      return;
    }
    await ensureReady();

    if (item.action.kind === 'capture-all-windows') {
      // 这一项不依赖"哪一个是当前窗口"，但撤销条要落在一个窗口上，所以拿不到就退回最后聚焦的。
      const anchorWindowId =
        info.windowId ?? (await deps.tabs.getCurrentWindow()).id;
      await stashAllWindows(anchorWindowId);
      return;
    }

    const windowId = info.windowId;
    if (windowId === undefined) {
      console.warn('[shitab] 菜单点击没带 windowId，忽略本次', item.id);
      return;
    }

    if (item.action.kind === 'open-workbench') {
      // 按窗口算：本窗口已有入口页就聚焦它，没有就开一个 —— 不跳去隔壁窗口（既有约定 决定 5）。
      await entry.ensureForWindow(windowId, { focus: true });
      return;
    }

    if (item.action.scope === 'window') {
      reportOutcome(windowId, await stash(windowId));
      return;
    }

    const anchorTabId = info.tabId;
    if (anchorTabId === undefined) {
      // 左侧 / 右侧 / 除当前外**以锚点为准**，没有锚点就没有"左"。
      // 宁可什么都不做，也不能退化成整窗 —— 那会把用户没点的标签关掉。
      console.warn('[shitab] 范围收纳没带锚点标签，忽略本次', item.id);
      return;
    }
    reportOutcome(windowId, await stash(windowId, { kind: item.action.scope, anchorTabId }));
  }

  contextMenusPort.onClicked(onMenuClick);

  // 安装/更新与浏览器启动各重建一次：菜单项**不保证**跨浏览器重启存活，而更新之后
  // 旧版本留下的项也要先清掉。SW 每次唤醒本来也会走一遍下面那条初始注册。
  eventsPort.subscribe({
    onInstalled: () => ensureMenus(true),
    onStartup: () => ensureMenus(true),
  });

  registerCommandHandler(async (command, operationId) => {
    await ensureReady();

    switch (command.kind) {
      case 'restoreGroup':
        return restoreGroup(deps, {
          groupId: command.groupId,
          windowId: command.windowId,
          mode: command.mode,
        });

      case 'restoreTab':
        return restoreTab(deps, {
          groupId: command.groupId,
          tabId: command.tabId,
          windowId: command.windowId,
        });

      case 'undoCapture':
        return undoCapture(deps, { groupId: command.groupId, windowId: command.windowId });

      case 'ensureEntryTab':
        // 页面自己挂载时校正本窗口：不加 focus，用户已经在看了
        return entry.ensureForWindow(command.windowId, { focus: false });

      default: {
        // 判别联合穷尽性检查：新增 command 忘了在这里处理会编译失败
        const exhausted: never = command;
        throw new Error(`未知命令 ${JSON.stringify(exhausted)} (${operationId})`);
      }
    }
  });
});
