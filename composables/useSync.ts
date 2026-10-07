/**
 * 设置页与工作台共用的同步动作（既有约定 文件的 0073 节 = 面板形状，0068 节 = 凭据与传输）。
 *
 * 为什么要有这一层而不是在 .vue 里直接调 port：`permissions.request()` **必须在用户手势里**
 * 调用（官方文档明写 "can only make the request inside the handler for a user action"），
 * 所以"存配置"和"要权限"这两步的先后顺序是被平台钉死的，一旦被复制进两个组件就会分叉。
 * 这里收一处。
 */

import { computed, ref } from 'vue';
import { storagePort } from '@/shared/services';
import { createWebDavPort } from '@/infrastructure/webdav/http-webdav';
import { requestSync, markDirty, type SyncAttempt } from '@/core/application/sync-engine';
import { nextCheckAt as nextCheckMoment } from '@/core/domain/sync-scheduler';
import { parseBaseUrl, toOriginPattern, isInsecureHttp } from '@/core/domain/remote-layout';
import type { MessageKey } from '@/shared/i18n';
import type { WebDavPort } from '@/core/ports/webdav';
import type { SyncMeta, WebDavConfig } from '@/shared/types';

export interface SyncPanelState {
  config: WebDavConfig;
  meta: SyncMeta;
  /** 输入框里的密码。它**不进** config —— config 会被回显、可能被写进远端 meta.json。 */
  password: string;
}

/**
 * 面板上会发网络动作的三颗按钮。转圈只给正在跑的那一颗。
 *
 * ⚠ `'sync'` 这颗现在**可能一个请求都不发**（既有约定 之后 manual 也过判据那道闸），
 * 所以它的结果文案里必须能表达"这一轮没发起"，见 `sync_notice_skipped`。
 */
export type SyncAction = 'connect' | 'test' | 'sync';

/**
 * 结果那一行可能出现的文案。**收窄成联合而不是 `MessageKey`**：
 * SyncPanel 要拿它查语气色，查表就得穷尽 —— 类型是 `MessageKey` 的话少写一条编译不报错，
 * 运行时查到 `undefined`，屏幕上就是一行没语气、甚至空白字的结果提示。
 */
export type SyncNotice =
  | 'sync_notice_pushed'
  | 'sync_notice_nothing'
  | 'sync_notice_suspicious'
  | 'sync_notice_conflict'
  | 'sync_notice_failed'
  | 'sync_notice_saved'
  | 'sync_notice_paused'
  | 'sync_notice_test_ok'
  | 'sync_notice_test_failed'
  | 'sync_notice_connected_failed'
  /** 这一轮**没有发过请求**：被退避 / 去抖 / 拉取间隔挡住了（manual 也要过判据，Q2b） */
  | 'sync_notice_skipped'
  /** 另一处已经有一轮在飞（本进程或别的页面 / worker），这次没排队 */
  | 'sync_notice_in_flight'
  | 'sync_hint_enable_first'
  | 'sync_err_insecure'
  | 'sync_err_need_password'
  | 'sync_err_permission_denied'
  | 'sync_err_bad_url'
  | 'sync_err_generic';

export interface SyncPanelOptions {  /**
   * 注入点。**默认用真的 fetch 适配器**，只有测试会传。
   *
   * 为什么要有它：`connect()` 一次点击里既存配置又同步，于是"点一下连接"这条 UI 用例
   * 第一次真的会走到发请求那一步 —— 没有这个口子，界面测试要么打真网络（不可接受），
   * 要么只能测到"没同步的那一半"（现有那批用例就是这样漏掉的）。
   */
  webdav?: WebDavPort;
}

export function useSyncPanel(options: SyncPanelOptions = {}) {
  const webdav = (): WebDavPort => options.webdav ?? createWebDavPort();
  const config = ref<WebDavConfig | null>(null);
  const meta = ref<SyncMeta | null>(null);
  const password = ref('');
  /** 远端已经存过一个密码。UI 用它决定"密码框留空 = 不改"还是"必须填"。 */
  const hasCredential = ref(false);
  /**
   * 正在跑的是**哪一颗**按钮。`null` = 空闲。
   *
   * 为什么不是一根 `busy` 布尔：三颗按钮共用一个布尔时，点「立即同步」会把「改设置」里
   * 那两颗一起灰掉，而用户要看的是"我按的那颗在动"。转圈只给在跑的那一颗，
   * 其余的用 `disabled` 表达（同一时刻跑两个网络动作也没有意义）。
   */
  const pending = ref<SyncAction | null>(null);
  const busy = computed(() => pending.value !== null);

  /**
   * 动作开始：记下是哪一颗，**并清掉上一次的结果**。
   *
   * 不清是实打实的误导：屏幕上挂着「同步失败」，用户按第二次之后那行字还在原地，
   * 看起来像"又失败了"，而这一次可能已经成了。
   */
  function begin(action: SyncAction): void {
    pending.value = action;
    notice.value = null;
  }

  function end(): void {
    pending.value = null;
  }
  /** 最近一次动作的结果，直接给 UI 显示。设置页不需要"日志"那种抽象。 */
  /** 存的是**文案 key**，不是 'ok' 这种内部标识：印到脸上就是我 既有约定 里骂过的东西。 */
  const notice = ref<SyncNotice | null>(null);

  async function load(): Promise<void> {
    config.value = await storagePort.getWebDavConfig();
    meta.value = await storagePort.getSyncMeta();
    hasCredential.value = (await storagePort.getSyncCredential()) !== undefined;
    // 密码不回显：只回显"存过没有"。要改就重新填，这比把一个明文密码框留在页面上好。
    password.value = '';
    storagePort.watchSyncMeta((next) => {
      meta.value = next;
    });
    storagePort.watchWebDavConfig((next) => {
      config.value = next;
    });
  }

  /**
   * 要主机权限。必须在点击这类用户手势的调用栈里跑到这一行。
   *
   * 只申请**用户填的那一个源**（`https://host/*`），不是清单里声明的通配。
   * 通配只是"允许将来这么要"的声明，真正授予的是这一条 —— 这也是我们对
   * "别拿这个权限去读普通网页"那句承诺的实现方式。
   */
  async function requestOrigin(baseUrl: string): Promise<{ ok: boolean; reason?: string }> {
    const parsed = parseBaseUrl(baseUrl);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    try {
      const granted = await browser.permissions.request({ origins: [toOriginPattern(parsed.url)] });
      return { ok: granted };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 把"最近检查过什么"的账清零。`save()`（换/配好服务器）与 `setEnabled(true)`（重新打开同步）
   * 都要走它 —— 这两件事的共同点是：**用户在问一个新的问题**，而 60 秒的拉取间隔防的是
   * "同一个问题被连着问两遍"（既有约定 的节拍、既有约定 之后 manual 也受它管）。
   *
   * 不清的三个后果，按严重程度排：
   * 1. `lastSeenSnapshotId` 是**上一台服务器**（或上一段开启期）的内容指纹。拿它去比新
   *    manifest，一旦 checksum 相同就跳过下载 —— 那正好跳过用户唯一想看的那一份。
   * 2. `lastSyncAt` 还在 60 秒内 ⇒ 「连接并同步」/开关那次的同步被判 `not-due`，
   *    用户对着刚填完的地址点下去，屏幕上是一句"本轮未发起 · 还没到检查时间"。
   * 3. `nextAttemptAt` 是**旧错误**的退避。配置都换了还按它等，等于让他对着一个
   *    已经不存在的原因干等。
   *
   * 不动 `dirtySinceAt`：关掉期间攒的本地改动仍然欠着一次推送，那笔账跟节拍无关。
   */
  async function resetSyncCadence(): Promise<void> {
    const meta = await storagePort.getSyncMeta();
    await storagePort.setSyncMeta({
      ...meta,
      lastSyncAt: undefined,
      lastSeenSnapshotId: undefined,
      nextAttemptAt: undefined,
      consecutiveFailures: 0,
    });
  }

  async function save(next: WebDavConfig, credential: string, at: number = Date.now()): Promise<{ ok: boolean; message?: string }> {
    const parsed = parseBaseUrl(next.baseUrl);
    if (!parsed.ok) return { ok: false, message: `地址无效：${parsed.reason}` };
    if (isInsecureHttp(parsed.url) && !next.allowInsecureHttp) {
      return { ok: false, message: 'insecure-http' };
    }

    // 权限没到手就什么都不写：否则用户看到一个"已保存但一直失败"的配置，
    // 而失败原因（没权限）要翻三层才知道。
    const permission = await requestOrigin(next.baseUrl);
    if (!permission.ok) return { ok: false, message: permission.reason ?? 'permission-denied' };

    /**
     * 密码这一格的三种情况，方向不能反：
     * - 填了新密码 ⇒ 存它。
     * - **留空且之前存过** ⇒ 不动已存的那份。用户只是想改个 URL 时，
     *   逼他重打一遍密码的结果是他干脆取消，或者随手粘一个错的进来。
     * - 留空且从没存过 ⇒ 拒绝保存。放行会造出一个"配置齐了但每次同步都 401"的状态，
     *   而那正是用户最难自己诊断的一种失败。
     */
    let passwordToStore: string;
    if (credential) {
      passwordToStore = credential;
    } else if (hasCredential.value) {
      passwordToStore = ''; // 空串在这里是哨兵"不改"，见下面那行判断
    } else {
      return { ok: false, message: 'no-credential' };
    }

    if (passwordToStore) await storagePort.setSyncCredential(passwordToStore);
    await storagePort.setWebDavConfig({ ...next, lastTestedAt: at });
    await resetSyncCadence();
    hasCredential.value = true;
    return { ok: true };
  }

  /**
   * 一次点击做完"存配置 + 立刻同步"（既有约定 修订 既有约定 的"三颗按钮"那条）。
   *
   * 能合的理由要说准：`permissions.request()` 必须在**用户手势的调用栈里**，
   * 而 `save()` 内部正是按那个顺序走的 —— 合并掉的只是"用户要点几次"，
   * 没有把要权限挪进任何自动流程。反过来做成"填完自动连接"就是拿掉那次手势，
   * 浏览器会把请求拒掉，用户看到的是"配好了但一直 401"，比原来更难诊断。
   *
   * 同步失败**不算连接失败**：配置已经落盘、权限已经拿到，这时返回 ok:true 带上
   * outcome，让界面说"已连接，但这次同步没完成：<原因>"。把两步绑成一个错误，
   * 用户会以为地址填错了，而真正的原因可能是网盘那一头暂时 503。
   */
  async function connect(
    next: WebDavConfig,
    credential: string,
    at: number = Date.now(),
  ): Promise<{ ok: boolean; message?: string; attempt?: SyncAttempt }> {
    begin('connect');
    try {
      const saved = await save({ ...next, enabled: true }, credential, at);
      if (!saved.ok) return saved;
      return { ok: true, attempt: await performSync() };
    } finally {
      end();
    }
  }

  /**
   * 只翻 `enabled`，别的一律不动：不删远端历史、不清密码、不改地址
   * （既有约定 那条"关掉 ≠ 忘掉"的 UI 面）。
   *
   * 打开时顺手补一次同步：用户的期望是"开了就会同步"，让他再点一颗按钮
   * 就是把这条期望差留给他自己发现。权限早在连接那一次就授过了，这里不再要手势。
   */
  async function setEnabled(on: boolean): Promise<SyncAttempt | undefined> {
    // 读**盘上**的那份，不读缓存的 `config.value`：watcher 是异步的，
    // 连点两次开关时缓存还是旧值，`current.enabled === on` 会让第二次点击静默 no-op
    // —— 用户看到的是"开关拨过去了但什么都没发生"。
    const current = await storagePort.getWebDavConfig();
    if (current.enabled === on) return undefined;
    await storagePort.setWebDavConfig({ ...current, enabled: on });
    if (!on) return undefined;
    // 重新打开要清节拍（理由见 `resetSyncCadence`）：关着的这段时间对面推了多少版都不知道，
    // 而"60 秒内查过了"防的是重复敲同一个问题，不是防用户重新开启。
    await resetSyncCadence();
    return syncNow();
  }

  async function testConnection(): Promise<{ ok: boolean; message?: string }> {
    const current = config.value;
    if (!current) return { ok: false, message: 'no-config' };
    const parsed = parseBaseUrl(current.baseUrl);
    if (!parsed.ok) return { ok: false, message: `地址无效：${parsed.reason}` };
    const stored = await storagePort.getSyncCredential();
    if (!stored) return { ok: false, message: 'no-credential' };

    begin('test');
    try {
      await webdav().testConnection(parsed.url.href, {
        username: current.username,
        password: stored.password,
      });
      await storagePort.setWebDavConfig({ ...current, lastTestedAt: Date.now() });
      notice.value = 'sync_notice_test_ok';
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notice.value = 'sync_notice_test_failed';
      return { ok: false, message };
    } finally {
      end();
    }
  }

  /**
   * 跑一轮同步，**不碰 `pending`**。
   *
   * 拆出来是因为「连接并同步」这一颗按钮里也要跑一轮：如果它调的是带记账的 `syncNow()`，
   * 跑到中间 `pending` 会从 `'connect'` 变成 `'sync'`，用户按的那颗按钮的转圈就地停住、
   * 标签换回原文案 —— 看起来像"连接完了但没同步"，而它其实还在飞。
   *
   * ⚠ 走的是 `requestSync` 而不是 `runSync`：这里是**第五个 trigger**，
   * 它必须和其他四类过同一套判据，否则界面上那颗按钮就成了"绕过退避"的后门 ——
   * 一次 503 之后连点五下就是五次敲门。返回值也因此是 `SyncAttempt`（可能根本没跑）。
   */
  async function performSync(): Promise<SyncAttempt> {
    return requestSync({ storage: storagePort, webdav: webdav() }, 'manual');
  }

  async function syncNow(): Promise<SyncAttempt> {
    begin('sync');
    try {
      // 这里**不**写 notice：`SyncAttempt` 里装的是内部判别值（'idle' / 'not-due' …），
      // 直接塞进 notice 就会被印成「结果：idle」。文案由调用方按结果挑（SyncPanel.runNow）。
      return await performSync();
    } finally {
      end();
    }
  }

  const enabled = computed(() => config.value?.enabled === true);

  /**
   * 下一次自动检查大约在什么时候，给「立即同步」被拒时那句解释用。
   *
   * 读的是**账本缓存**：判据本身在 background 那边跑，这一层只负责把 `nextCheckAt`
   * 那个纯函数套在当前 meta 上，不发请求、也不改任何东西。
   */
  function nextCheckAt(at: number = Date.now()): number {
    if (!meta.value) return at;
    return nextCheckMoment(meta.value, at);
  }

  return {
    config,
    meta,
    password,
    hasCredential,
    busy,
    pending,
    notice,
    enabled,
    load,
    save,
    connect,
    setEnabled,
    testConnection,
    syncNow,
    nextCheckAt,
    markDirtyForUI: () => markDirty({ storage: storagePort, webdav: webdav() }),
  };
}
