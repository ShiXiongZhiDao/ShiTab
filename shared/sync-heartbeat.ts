/**
 * 扩展页面的同步心跳。
 *
 * 要解决的问题是一条真机反馈（2026-10-05）：「在 Edge 删了标签，在 Chrome 的 ShiTab 页面
 * 等了半天没同步过来，得两边都点一次『立即同步』」。原因不在合并、也不在判据 ——
 * 判据（既有约定 的"不脏也要按拉取间隔去拉"）**需要有人来问它**。而 MV3 的 service worker
 * 空闲 30 秒就被杀，我们**没申请 `alarms`**，所以没有任何东西会在睡着之后
 * 自己醒来看一眼：`lastSyncAt` 摆在那里过期，却没人去比它。
 *
 * 心跳就是把"节拍"搬到**页面还活着**的那段时间里：工作台与设置页开着的时候，每 60 秒
 * 给 background 发一条 ping，background 收到就按判据判一次（`trySync`）。
 * 选页面而不是 SW 是因为：页面是用户"正在看数据"的那个地方 —— 他盯着 Chrome 的列表等更新时，
 * 那个页面本身就是活的；而页面关着的时候没人在等，延迟到下次打开再拉不影响任何人的操作。
 *
 * 三条刻意的取舍：
 * - **挂载即发一次**（不等满 60 秒）。"打开页面就看到最新"这条价值比省一次请求高，
 *   而它并不额外花钱：判据会立刻拒掉"上次同步才过了 5 秒"的那种情况。
 * - **发不出去不重试**（`browser.runtime.sendMessage` 在 fakeBrowser 里是"未实现即抛"，
 *   真机上也可能因为 SW 正在冷启动而失败）。下一次心跳会补上，与 `publishCaptureNotice` 同一条口径。
 * - **退订必须干净**：页面切走/关掉要能 `clearInterval`，否则测试之间与多窗口场景会留下幽灵节拍。
 */

export const SYNC_PING_MESSAGE = 'shitab:sync-ping' as const;

/**
 * 心跳间隔。与 `PULL_INTERVAL_MS`（`core/domain/sync-wake.ts`）同值不是巧合：
 * 页面敲得比拉取间隔更勤只会每次都被判据拒掉（白敲一次消息通道），
 * 敲得更疏则用户等得明显。**改一个要同时看另一个**，所以这里不 import 那个常量 ——
 * 页面侧不该依赖 domain 层的判据细节，两者各自有测试钉住数值。
 */
export const SYNC_PING_EVERY_MS = 60_000;

/**
 * 启动心跳，返回退订函数。
 *
 * `send` 参数只为测试存在（jsdom 里 `runtime.sendMessage` 可能是未实现即抛的假件）；
 * 生产调用一律不传。
 */
export function startSyncHeartbeat(
  send: () => void = sendSyncPing,
  everyMs: number = SYNC_PING_EVERY_MS,
): () => void {
  send();
  const timer = setInterval(send, everyMs);
  return () => clearInterval(timer);
}

/** 单向通知：不关心回值，判据在 background 那一侧。 */
export function sendSyncPing(): void {
  try {
    void Promise.resolve(browser.runtime.sendMessage({ __shitab: SYNC_PING_MESSAGE })).catch(
      () => undefined,
    );
  } catch {
    // 没有接收方 / 假浏览器未实现：下一次心跳补
  }
}

/** background 侧认这条消息。 */
export function isSyncPing(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { __shitab?: string }).__shitab === SYNC_PING_MESSAGE
  );
}
