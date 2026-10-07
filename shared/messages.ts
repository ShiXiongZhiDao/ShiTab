/**
 * background 命令通道的类型化消息层。
 *
 * WXT 0.21.4 不提供任何消息工具（无 wxt/utils/message，全包无 defineCustomEvent），
 * 所以这是自建件 —— 既有约定 的"约 40 行"就是这里。
 *
 * 只有**需要 background 才做得对**的长任务走这条通道：restoreGroup / restoreTab /
 * undoCapture / ensureEntryTab。工作台页面
 * 可能被用户随时关掉，而开关几十个 tab 的任务不能断。纯数据命令（重命名 / 排序 /
 * 删除 / 设置 / 导入导出）仍在调用方进程内直接执行 use case。
 *
 * V1.2 真机第二轮：收纳**只剩工具栏图标一个入口**，页面上的"收纳当前窗口"按钮删掉，
 * 于是 `captureWindow` 命令变体也一起删 —— 没有调用方的命令不该留在判别联合里。
 * 收纳的结果改由 `CaptureNotice` 单向广播回页面（撤销条的宿主是那个页面，既有约定）。
 */

import type {
  CaptureResult,
  RestoreMode,
  RestoreResult,
  RestoreTabResult,
} from '@/shared/types';

export const COMMAND_MESSAGE = 'shitab:command' as const;

/**
 * 命令**自带 windowId**（V1.1 既有约定，取代 既有约定 第 3 条的"由 background 用
 * `windows.getLastFocused()` 猜一次"）。
 *
 * 那条猜测当初是为了绕开"popup 与 sidepanel 里 currentWindow 语义是否一致"这个未验证项。
 * V1.1 之后两个 surface 都没了：图标点击的窗口来自 `action.onClicked` 给的 `tab.windowId`
 * （平台直接告诉你的那个），工作台的窗口来自页面自己的 `windows.getCurrent()`。
 * 两边都不需要猜，所以把猜测整个删掉 —— 也顺带满足设计包 AC-02/AC-07"只处理所在窗口"。
 */
export type Command =
  /** `mode` 缺省 'current'；'incognito' 失败时如实报错，不降级 */
  | { kind: 'restoreGroup'; windowId: number; groupId: string; mode?: RestoreMode }
  | { kind: 'restoreTab'; windowId: number; groupId: string; tabId: string }
  | { kind: 'undoCapture'; windowId: number; groupId: string }
  /** 入口页自己的"自修复"：页面挂载时校正一次本窗口的 T（设计包 A §13）。 */
  | { kind: 'ensureEntryTab'; windowId: number };

/** 判别联合的返回值映射：加命令时这里必须同轮补，否则类型会漏。 */
export interface CommandResults {
  restoreGroup: RestoreResult;
  restoreTab: RestoreTabResult;
  undoCapture: RestoreResult;
  /** 本窗口是否确实有了入口页 */
  ensureEntryTab: boolean;
}

export type CommandName = keyof CommandResults;

export interface CommandEnvelope {
  /** operationId 串起一次操作的所有日志（ARCHITECTURE §7） */
  operationId: string;
  command: Command;
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly kind: 'unknown-command' | 'handler-threw' | 'no-response',
  ) {
    super(message);
  }
}

function isEnvelope(data: unknown): data is CommandEnvelope {
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as Partial<CommandEnvelope>;
  return typeof candidate.operationId === 'string' && typeof candidate.command === 'object';
}

/** UI 侧。 */
export async function sendCommand<K extends Command['kind']>(
  command: Extract<Command, { kind: K }>,
  operationId: string,
): Promise<CommandResults[K]> {
  const response = (await browser.runtime.sendMessage({
    __shitab: COMMAND_MESSAGE,
    operationId,
    command,
  })) as { ok: boolean; value?: unknown; error?: string } | undefined;

  if (!response) throw new CommandError(`${command.kind} 没有收到响应`, 'no-response');
  if (!response.ok) throw new CommandError(response.error ?? `${command.kind} 失败`, 'handler-threw');
  return response.value as CommandResults[K];
}

type Handler = (command: Command, operationId: string) => Promise<unknown>;

/** background 侧。返回退订函数：单测要能把 listener 摘干净，不靠模块隔离兜着。 */
export function registerCommandHandler(handler: Handler): () => void {
  const listener = (message: unknown) => {
    if (typeof message !== 'object' || message === null) return undefined;
    if ((message as { __shitab?: string }).__shitab !== COMMAND_MESSAGE) return undefined;
    if (!isEnvelope(message)) return undefined;

    const { command, operationId } = message;
    // 必须返回 Promise：MV3 的 onMessage 只有在 listener 返回 promise 时才保持
    // 消息通道开放，否则 sendResponse 永远收不到值。
    return handler(command, operationId).then(
      (value) => ({ ok: true, value }),
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

// ---------------------------------------------------------------------------
// 收纳完成的通知（V1.2 真机第二轮）
// ---------------------------------------------------------------------------

export const CAPTURE_NOTICE_MESSAGE = 'shitab:capture-notice' as const;

/**
 * 图标收纳成功后广播给各页面。
 *
 * 为什么需要它：撤销条的宿主是**工作台页面**，而收纳入口现在只剩工具栏图标。
 * 没有这条通知，页面就只知道"数据变了"（watchGroups 会 reload），
 * 却不知道"刚刚发生了一次可撤销的收纳、是哪条会话、关了几条" —— 撤销就没人能按了。
 *
 * 只带页面要显示的东西 + 撤销要的 `groupId`/`windowId`：撤销本身直接读存储，
 * 不需要把 `closableTabIds` 之类的载荷搬过进程。
 */
export interface CaptureNotice {
  /** 收纳发生在哪扇窗口 —— 页面只认自己那一扇，别的窗口的收纳不该在本窗口弹出撤销条 */
  windowId: number;
  result: CaptureResult;
}

/** background 侧。发不出去就算了：badge 已经报过这次收纳的结果。 */
export function publishCaptureNotice(notice: CaptureNotice): void {
  try {
    // fakeBrowser 的 runtime.sendMessage 是"未实现即抛"，所以这里必须 try 而不是只 .catch
    void Promise.resolve(
      browser.runtime.sendMessage({ __shitab: CAPTURE_NOTICE_MESSAGE, ...notice }),
    ).catch(() => undefined);
  } catch {
    /* 没有接收方（页面还没开）或平台不支持：不重试，撤销条本来就只有 10 秒 */
  }
}

/** 页面侧订阅。返回退订函数。 */
export function onCaptureNotice(handler: (notice: CaptureNotice) => void): () => void {
  const listener = (message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const candidate = message as Partial<CaptureNotice> & { __shitab?: string };
    if (candidate.__shitab !== CAPTURE_NOTICE_MESSAGE) return;
    if (typeof candidate.windowId !== 'number' || !candidate.result) return;
    handler({ windowId: candidate.windowId, result: candidate.result });
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
