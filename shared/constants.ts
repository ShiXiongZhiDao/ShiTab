/** 跨层共享常量。 */

/** 存储键前缀。全部落在 storage.local。 */
export const STORAGE_PREFIX = 'shitab' as const;

export const STORAGE_KEYS = {
  meta: `${STORAGE_PREFIX}:meta`,
  settings: `${STORAGE_PREFIX}:settings`,
  groupIndex: `${STORAGE_PREFIX}:groups:index`,
  /** 分类列表（单个键，数组）。它不像 group 那样一键一条：分类是小而整读的派生数据。 */
  categories: `${STORAGE_PREFIX}:categories`,
  /** 分组数据自增版本号。跨 surface 的失效通知只看它（见 infrastructure/storage/wxt-storage.ts）。 */
  rev: `${STORAGE_PREFIX}:rev`,
  /** 界面偏好（侧栏宽度）。单独一键、不进备份，理由见 既有约定。 */
  ui: `${STORAGE_PREFIX}:ui`,
  group: (id: string) => `${STORAGE_PREFIX}:group:${id}`,
  groupKeyPrefix: `${STORAGE_PREFIX}:group:`,

  // ---------------------------------------------------------------------------
  // 耐久快照与同步层。
  //
  // 这一批键**不参与** `heal()` 的分键自愈，也不是 UI 的读取路径：
  // UI 永远只读 `group:<id>` + `groups:index`。快照是"崩溃之后还能回到哪一刻"的证据，
  // 不是"现在有哪些会话"的答案 —— 后者由分键布局 + 自愈给出。
  //
  // 命名必须避开 `groupKeyPrefix`：否则 `groupIdsFrom()` 的前缀扫描会把快照当成一个分组
  // （同文件头第 3 条那个 `$` 兄弟键的坑）。
  // ---------------------------------------------------------------------------

  /** 耐久快照的两个槽（gzip+base64 的 StateEnvelope）。 */
  snapshotSlotA: `${STORAGE_PREFIX}:snap:a`,
  snapshotSlotB: `${STORAGE_PREFIX}:snap:b`,
  /** 指向"当前有效的那一槽"。翻指针 = 提交；指针没翻就是没发生。 */
  snapshotPointer: `${STORAGE_PREFIX}:snap:pointer`,
  /** 已删除实体的墓碑。整组删除要靠它传播，组键本身已经没了。 */
  tombstones: `${STORAGE_PREFIX}:tombstones`,
  /** 回收站：一个键装整个数组。 */
  trash: `${STORAGE_PREFIX}:trash`,
  /**
   * 本机设备身份。一个随机 UUID，**不同步、不进备份**。
   * 它只回答"这条删除是谁干的"，不回答"这是哪台机器"——后者我们不需要，也不该猜。
   */
  device: `${STORAGE_PREFIX}:device`,
  /** 同步配置（无密码）。 */
  syncConfig: `${STORAGE_PREFIX}:sync:config`,
  /** 同步引擎的账本。整块读写，因为它只被引擎一个人写。 */
  syncMeta: `${STORAGE_PREFIX}:sync:meta`,
  /**
   * WebDAV 密码。**单独一键**的理由见 既有约定：
   * `snapshotAll()` 与备份导出走的都是"把数据对象序列化一遍"的路径，
   * 密码一旦和 baseUrl 住在同一个对象里，就迟早会顺着那条路径走到用户下载的 JSON 里。
   */
  syncCredential: `${STORAGE_PREFIX}:sync:credential`,
} as const;

/**
 * 耐久快照信封的两个字面值。
 *
 * 与 `BACKUP_FORMAT` 是**两份不同的合同**：那个是给用户下载的备份文件，改它要考虑
 * 老文件读不读得动；这个是写给机器自己的，坏了就直接判无效、退回另一槽，不需要向后兼容。
 * 合成一个会诱导后来者"顺手也让快照兼容老备份"，那是把损坏检测关掉。
 */
export const STATE_FORMAT = 'shitab-state' as const;
export const STATE_SCHEMA_VERSION = 1 as const;

/**
 * 远端两份载荷的格式标记。
 *
 * 与 `STATE_FORMAT` 分开的理由和 `BACKUP_FORMAT` 那条一样：这三份 JSON 会各自落到
 * 不同的地方（本机槽 / 远端快照 / 用户下载的备份文件），一份被另一份误读时
 * 必须**当场拒绝**，而不是"字段大体对得上就当有效"。
 */
export const SNAPSHOT_FORMAT = 'shitab-snapshot' as const;
export const MANIFEST_FORMAT = 'shitab-manifest' as const;

/**
 * 远端目录名。大小写跟着产品名走（ShiTab），因为这是用户在文件管理器里看得见的东西。
 *
 * ⚠ 上架前要重新看这条和下面那条：`ShiXiongZhiDao` 是**师兄自己的网盘归属目录**，
 * 对一个公开扩展来说把别人的名字写进路径拼接是不成立的（别的用户会看见一个以他名字命名的目录）。
 * 落点记在 `既有约定` 的上架待办里，别让它默默跟着 v1.3 出门。
 */
export const REMOTE_ROOT_FOLDER = 'ShiTab' as const;
/** 归属目录：数据放在 `<baseUrl>/ShiXiongZhiDao/ShiTab/`，而不是直接把应用目录挂在根上。 */
export const REMOTE_OWNER_FOLDER = 'ShiXiongZhiDao' as const;
export const REMOTE_SNAPSHOTS_FOLDER = 'snapshots' as const;
export const REMOTE_MANIFESTS_FOLDER = 'manifests' as const;

/** 快照载荷里 `revision` 的起点。它只在快照这条线上单调递增，与 `rev` 键无关。 */
export const SNAPSHOT_REVISION_START = 1 as const;

/**
 * 后台兜底定时器的名字与周期。
 *
 * 名字固定一个值、不做成可配置：alarm 的"是否已存在"靠名字判，名字变了就等于
 * 老用户机器上留下一条永远不会被触发的僵尸 alarm。
 *
 * 周期 5 分钟而不是 1 分钟：同步的是标签页元数据，不是实时协同。真正的代价不在唤醒次数
 * （Chrome 明写 alarm 可能被任意延迟），在**流量**：一轮"远端没变"的检查如果不跳过下载，
 * 就是每 5 分钟一次 0.2–0.4 MiB。所以 既有约定 的"见过这一版就不下载"是这条 alarm 的前提。
 */
export const SYNC_ALARM_NAME = 'shitab:webdav-sync' as const;
export const BACKGROUND_ALARM_PERIOD_MINUTES = 5 as const;

/**
 * 回收站保留期（既有约定 决定 3）：7 天 = 604,800,000 ms。
 *
 * 7 天这条线不是新造的：`既有约定` 在"撤销"那节早就把它当成
 * "P1 的 7 天回收站"记着，并且明写撤销**不是**它。这一轮把那个承诺兑现了。
 *
 * 写成字面量而不是 `7 * 24 * 60 * 60 * 1000`：`as const` 加在算术表达式上是非法的
 * （TS1355），而宁可在这里把换算写进注释，也不要为了 `as const` 把表达式拆成一个
 * 谁都不会再去核对的数。
 */
export const TRASH_RETENTION_MS = 604_800_000;

/**
 * 左栏宽度的三个数。默认值就是重写一版之前那个写死的 `w-[248px]`，
 * 所以老用户第一次打开时看到的是同一张脸，只是这次能拖。
 *
 * 上限还要被视口再压一道（`min(420, 40% 窗口宽)`）：420 是"分类名最长的一条也放得下"，
 * 而"放得下"不该以吃掉半个工作台为代价 —— 右栏才是主视野（PRD §41 的两栏分工）。
 */
export const RAIL_WIDTH_DEFAULT = 248 as const;
export const RAIL_WIDTH_MIN = 200 as const;
export const RAIL_WIDTH_MAX = 420 as const;
/** 窄窗口里侧栏最多占到的比例（与 CSS 的 `max-w-[40vw]` 必须是同一个数）。 */
export const RAIL_WIDTH_VIEWPORT_RATIO = 0.4 as const;

/** 导出文件的 schemaVersion 与格式名（DATA-MODEL §8）。 */
export const BACKUP_FORMAT = 'shitab-backup' as const;
export const BACKUP_VERSION = 1 as const;

/** meta.schemaVersion 的初值。 */
export const SCHEMA_VERSION = 1 as const;

/**
 * 批量恢复时的并发上限（ARCHITECTURE §7）。
 * 取 5 而不是更高：几十个 tab 一起 tabs.create 会让浏览器排队渲染，
 * 用户看到的是窗口卡住；5 个一批既不让界面冻结，也不至于太慢。
 */
export const RESTORE_CONCURRENCY = 5 as const;

/**
 * 撤销窗口的时长。
 *
 * V1.1 设计包 §29/AC-10 定为 10 秒（既有约定 的 6 秒被它取代）：
 * 图标一键收纳之后，用户从"咦我窗口呢"到找回手感的平均时间比在 popup 里长，
 * 6 秒是给"面板还开着"的场景设计的。
 */
export const UNDO_WINDOW_MS = 10_000 as const;

/**
 * 入口页的路径（V1.1 设计包 A §6.1）。
 *
 * 带前导斜杠，因为它同时是两样东西：
 * - `browser.runtime.getURL` 的参数（WXT 把它生成成 `PublicPath` 字面量联合，
 *   所以必须是字面量常量，不能是运行时拼出来的 string）
 * - 身份判定时比较的 `URL.pathname`
 *
 * 身份判定用 **pathname 精确相等**，既不用整串 URL 比较（浏览器会补斜杠、
 * 查询串会被复制粘贴改写），也不用模糊 `includes('app.html')`。
 */
export const ENTRY_PAGE_PATH = '/app.html' as const;

/** 入口页的识别查询串，仅作"这个 tab 是不是从 T 进来的"的展示/调试信息。 */
export const ENTRY_PAGE_QUERY = 'entry=pinned-tab' as const;

/** tabs.move 撞上"用户正在拖标签"时的重试次数与间隔（V1.1 设计包 A §12）。 */
export const MOVE_RETRY_LIMIT = 5 as const;
export const MOVE_RETRY_DELAY_MS = 80 as const;

export const MIN_TAB_GROUP_TITLE_LENGTH = 1 as const;
export const MAX_TAB_GROUP_TITLE_LENGTH = 120 as const;

export const MIN_CATEGORY_NAME_LENGTH = 1 as const;
export const MAX_CATEGORY_NAME_LENGTH = 60 as const;

/**
 * 一个会话在右栏里默认展开显示多少条 tab，超出折叠成"展开剩余 N 条"。
 *
 * 存在的理由是一条平台事实的反面：右栏改成"所有会话全部平铺"之后，
 * PRD §5 的"1,000 组 / 10,000 条仍可滚动"就不能再靠"一次只渲染一个组"来保证。
 */
export const COLLAPSED_TAB_LIMIT = 30 as const;

/**
 * 点一次"展开其余 N 个"多摊开多少条（既有约定 采纳 1）。
 *
 * 存在的理由是一条实测：一个会话 3,000 条时，旧形状是**一次点击挂出 3,000 行 /
 * 约 6.3 万个元素节点**（`test/perf-dom-baseline.spec.ts` 的 C 档，jsdom 里 9-11 秒）。
 * 分批把"一次点到底"变成"每点一次 +200 条"，展开到 3,000 条要点 15 次 ——
 * 而 30 条以下的会话（绝大多数）一次点完，行为与以前完全一样。
 *
 * ⚠ 它只许影响**渲染**（`shown`）。勾选与"整组动作"的输入永远是整表 `ordered`
 *   （既有约定 补格：显示与动作是两条判据），算法收敛在 `shared/tab-window.ts` 一处。
 */
export const TAB_EXPAND_BATCH = 200 as const;
