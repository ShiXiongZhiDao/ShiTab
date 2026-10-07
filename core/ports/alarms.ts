/**
 * 后台定时器的端口。
 *
 * 为什么要有这一层：`browser.alarms` 是**平台 API**，而它有三处平台不对称
 * （Chrome 不触发权限警告、周期最小 30 秒且"可被任意延迟"、Firefox 需要声明权限且
 * **alarm 不跨浏览器会话**，见 `infrastructure/browser/browser-alarms.ts` 的出处段）。
 * 不包一层的话这些事实会散进 background 的分支里，而散出去的版本没法测 ——
 * 这一层的契约恰恰是这次全部风险所在：**重复创建、重启后没了、关掉同步还醒着**，
 * 三条都是用户看得见的事。
 *
 * ⚠ 这条注释原来写的是"fakeBrowser 里根本没有 `alarms` 这个键"。**那句现在是假的**：
 * `@webext-core/fake-browser@2.0.1` 实现了 `alarms.create/get/getAll/clear/clearAll` 与
 * `onAlarm`（还带 `resetState()`，因为 `fakeBrowser` 的事件监听器不会随存储清空）。
 * 我是读 `dist/src-W-WGXBaG.mjs:176-249` 核实的 —— 所以用例直接用平台的假件，
 * 不再自建一个"我以为的 alarm"。
 *
 * 端口只给三个动作，故意不给"读所有 alarm"：调用方没有需要列出来的场景，
 * 给了就会有人拿它去做条件判断，那第二个真相就来了。测试要看清单走的是
 * `fakeBrowser.alarms.getAll()`（平台假件上的，不是本端口的）。
 */
export interface AlarmPort {
  /**
   * 确保这个名字的周期 alarm 存在且周期是 `periodMinutes`。
   *
   * "已存在就什么都不做"是**必须**的：MV3 的 worker 会被反复唤醒，每次唤醒都 `create`
   * 一遍会把同一个 alarm 反复覆盖（Chrome 侧还有每扩展 500 条 alarm 的上限）。
   * 周期变了要真的改过来 —— 否则改了配置常数，老用户的 alarm 还是旧周期，
   * 而这件事在界面上完全看不出来。
   */
  ensure(name: string, periodMinutes: number): Promise<void>;
  /** 撤掉。关掉同步时必须调它（既有约定：用户关了同步就是"别再碰我的服务器"）。 */
  clear(name: string): Promise<void>;
  /** 订阅触发。返回退订函数。 */
  onAlarm(listener: (name: string) => void): () => void;
}
