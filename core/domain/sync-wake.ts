/**
 * 同步的唤醒判据（既有约定，WebDAV-SYNC.md §17）。
 *
 * 这一层要解决的问题很具体：**MV3 的 service worker 会在 30 秒空闲后被杀**，
 * 所以"改完数据 debounce 3 秒再同步"这句话不能靠一个活着的 `setTimeout` 实现 ——
 * 定时器可以在那一刻之前就没了，而用户看到的现象是"改了但没同步，也没报错"。
 *
 * 做法是把"该不该同步"做成一个**纯判据**，喂给它的是持久化的账本与当前时刻：
 * 脏标记落盘（`markDirty`），任何一次唤醒都重新判一遍。定时器只是加速器，不是正确性来源。
 */

import type { SyncMeta } from '@/shared/types';

/** 去抖窗口。§17 给的是 2~5 秒，取 3 秒：再短就赶不上用户连续收纳的节奏，再长就开始觉得"没反应"。 */
export const SYNC_DEBOUNCE_MS = 3_000;

/**
 * 本机**不脏**时也去拉一次的间隔。
 *
 * 存在的理由是一条用户投诉：Chrome 里删掉的东西，Edge 的回收站始终没有。两台设备里
 * "没动手的那台"永远不会变脏 —— 对面的改动不在本地留任何痕迹，而旧判据是
 * "没有脏标记就什么都不做"，于是它连一次 GET 都不发。
 * `alarms` 权限没申请，所以没有定时器，只能借"每次唤醒"这个天然的节拍。
 *
 * 60 秒这个数：短于此会与"SW 每次唤醒都判一次"叠起来变成对服务器的稳定敲门，
 * 而一轮"其实没变化"的同步也要一次 PROPFIND + 一次 GET；长于此用户在第二台机器上
 * 等得明显。
 *
 * ⚠ **这句话在 既有约定 之后改过一次**：原本这里写的是"用户点「立即同步」那条路径不受
 * 本条约束"，而用户在 Q2b 明确拍了要把它也收进门卫 —— 于是"刚检查过再点"就是没到点，
 * 界面必须把下一次时刻说出来（`sync_notice_skipped` + `sync_next_check`）。
 * 现在唯一的绕行是**换了配置或重新开启同步**（`useSync.resetSyncCadence`），
 * 那算问了一个新问题，不是把同一个问题问第二遍。
 */
export const PULL_INTERVAL_MS = 60_000;

/**
 * 现在该不该跑一次同步。
 *
 * 三条判据的顺序是刻意的：
 * 1. **退避优先于另外两条**（脏的要压住，"到点该拉一次"也要压住）。失败之后服务器还在抖，
 *    此时"本地又变了"不该绕过退避 —— 否则一次 503 会变成每秒一次的请求轰炸。
 * 2. 去抖窗口只看**第一次变脏的时刻**（`dirtySinceAt`），不看最后一次变更 ——
 *    用户连续收纳 10 次时，第 11 秒必须同步，而不是每次都把窗口重置、永远不推。
 * 3. **本机不脏也要按拉取间隔去拉一次**。这一条是被一条真实投诉逼出来的：
 *    「Chrome 的回收站彻底删除标签或者标签组，Edge 的回收站没有同步」。
 *    没动手的那台设备本地不会留下任何痕迹，`dirtySinceAt` 永远不会亮 ⇒ 旧判据
 *    "没有脏标记就什么都不做"让它连一次 GET 都不发，对面推上来的那一版于是永远进不来。
 *    **旧的那三条只回答了"我改了要推出去"，没回答"对面改了我要拉进来"。**
 *    代价：两边内容一样时 `runSync` 走 `no-changes`，也就是一次 PROPFIND + 一次 GET，
 *    不是一次上传，也不会在远端留下新文件（文件名按内容 checksum，既有约定 的去重在这里生效）。
 */
export function dueForSync(meta: SyncMeta, at: number, debounceMs: number = SYNC_DEBOUNCE_MS): boolean {
  if (meta.nextAttemptAt !== undefined && at < meta.nextAttemptAt) return false;
  if (meta.dirtySinceAt !== undefined) return at - meta.dirtySinceAt >= debounceMs;
  // 从没成功同步过 ⇒ 立刻算到点：新设备第一次唤醒就该把远端那一版拉下来。
  return meta.lastSyncAt === undefined || at - meta.lastSyncAt >= PULL_INTERVAL_MS;
}
