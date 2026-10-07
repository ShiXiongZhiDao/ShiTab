import type { AlarmPort } from '@/core/ports/alarms';

/**
 * `browser.alarms` 的适配器。
 *
 * 平台事实（一手来源，见 既有约定 的出处段）：
 * - Chrome：`alarms` **不触发任何权限警告**（权限表里那一条只有
 *   "Gives access to the chrome.alarms API."），所以更新时新增它不会禁用扩展；
 *   最小周期 30 秒（Chrome 120 起，之前是 1 分钟），且官方明写"可能被再多延迟任意时长"；
 *   alarm 默认跨浏览器会话持久化（`persistAcrossSessions` 在 Chrome 侧默认 true）。
 * - Firefox：需要声明 `alarms` 权限；**alarm 不跨浏览器会话**（MDN 原文
 *   "Alarms do not persist across browser sessions."）⇒ 所以每次 worker 启动都要 ensure 一遍。
 * - Edge：沿用 Chromium 平台行为，权限提示表与 Chrome 同源。
 *
 * 这两条不对称的事实合起来只指向一个实现形状：**每次 worker 启动都 ensure，
 * 且 ensure 必须幂等**。不幂等的话，Chrome 上"已经存在"会被反复覆盖成新的 5 分钟，
 * 用户看到的现象是"它有时候十分钟才动一次"。
 */
export function createAlarmPort(): AlarmPort {
  return {
    async ensure(name, periodMinutes) {
      const existing = await browser.alarms.get(name);
      if (existing?.periodInMinutes === periodMinutes) return;
      // 名字相同就是"替换"，不是"再加一条"（Chrome 侧有每扩展 500 条的上限）
      await browser.alarms.create(name, { delayInMinutes: periodMinutes, periodInMinutes: periodMinutes });
    },

    async clear(name) {
      await browser.alarms.clear(name);
    },

    onAlarm(listener) {
      const handler = (alarm: { name: string }) => listener(alarm.name);
      browser.alarms.onAlarm.addListener(handler);
      return () => browser.alarms.onAlarm.removeListener(handler);
    },
  };
}
