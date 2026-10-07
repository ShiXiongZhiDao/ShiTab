/**
 * 领域与边界类型。术语必须与 既有约定 一致：
 * capture=收纳，restore=恢复，group=分组，SavedTab=数据，BrowserTab=活的浏览器 tab。
 *
 * 这里只 import `STATE_FORMAT` 一个**值**，且只用在 `typeof` 位置上（编译后这行被擦掉，
 * 不产生运行时依赖）。之所以不直接写 `'shitab-state'` 字面量：那会让类型和
 * `shared/constants.ts` 里那个真值各写一份，而 checksum/格式校验的判据正是这两个必须同源。
 */

import { MANIFEST_FORMAT, SNAPSHOT_FORMAT, STATE_FORMAT } from '@/shared/constants';

// ---------------------------------------------------------------------------
// 持久化数据
// ---------------------------------------------------------------------------

/** 收纳那一刻这条 tab 的关闭结果。**仅用于 UI 展示**，不参与恢复决策。 */
export type CloseState = 'closed' | 'kept' | 'failed' | 'unknown';

export interface SavedTab {
  id: string;
  groupId: string;
  /** 原始 URL，不清洗查询参数（DATA-MODEL §7） */
  url: string;
  title: string;
  faviconUrl?: string;
  domain?: string;
  createdAt: number;
  sortOrder: number;
  /**
   * 收纳那一刻它在**原窗口标签栏里的位置**（V1.1 AC-03）。
   *
   * 与 sortOrder 不是一回事：sortOrder 是用户在我们列表里拖出来的顺序，
   * originalIndex 是"当时那个窗口长什么样"的事实。恢复按 sortOrder，
   * 撤销按 originalIndex —— 撤销的语义是"这次收纳没发生"，要把窗口结构复原。
   */
  originalIndex: number;
  /** 收纳那一刻它是否被用户固定（V1.1 §9）。只记录，恢复时不重钉（见 既有约定）。 */
  originalPinned: boolean;
  /** 收纳那一刻它是否是窗口的活动 tab（既有约定 用它把焦点还回去） */
  wasActive: boolean;
  closeState: CloseState;
  /** 能否被 tabs.create 打开。必填，收纳时判定 */
  restorable: boolean;
}

export interface TabGroup {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 收藏/置顶：决定落在列表的哪个区（既有约定 第 5 条的两轴之一）。与"锁定"是两件事。 */
  isPinned: boolean;
  /**
   * 锁定：**删不掉**。删除按钮禁用、批量删除与"清空"跳过它。
   *
   * 与 `isPinned` 不可互赋（术语表里两条各有一句定义）：置顶是"我要它排在前面"，
   * 锁定是"这批我还要用，别让我手滑删掉"。
   */
  locked: boolean;
  sortOrder: number;
  /** 所属分类；缺失 = 未分类（V1.2 既有约定，重开了 既有约定 里"tags[] 不进 schema"那半条） */
  categoryId?: string;
  /** 仅记录来源，不依赖它恢复（DATA-MODEL §2） */
  sourceWindowId?: number;
  tabs: SavedTab[];
}

/** 分类：一个装会话的容器。会话至多属于一个分类（多对一，既有约定）。 */
export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** 左栏的筛选目标：全部、未分类、或某个分类。不是持久化数据，是 UI 状态。 */
export type CategoryFilter = { kind: 'all' } | { kind: 'uncategorized' } | { kind: 'category'; id: string };

/**
 * `groups:index` 里的一条。列表渲染、分组搜索、置顶排序只读这个，不加载 tabs。
 * tabCount 是派生数据的冗余存储，靠启动自愈兜底。
 */
export interface GroupIndexEntry {
  id: string;
  title: string;
  isPinned: boolean;
  locked: boolean;
  categoryId?: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  tabCount: number;
  sourceWindowId?: number;
}

export type Theme = 'system' | 'light' | 'dark';

/**
 * 界面语言。`system` = 跟随浏览器 UI 语言，也是默认值。
 *
 * 只有中英两档，因为 `_locales` 里就只有这两份：加第三种语言要同时加目录，
 * 而 `resolveLocale()` 的兜底（认不出的一律 en）跟着 manifest 的 `default_locale` 走。
 */
export type LocaleChoice = 'system' | 'zh_CN' | 'en';

/**
 * 注意：**没有** compactMode 与 restoreInOrder —— 两者在 既有约定 中被砍掉
 * （前者全套文档零定义，后者的 false 没有可解释的语义）。
 *
 * 也**没有** status / isDeleted / syncStatus：V1.1 设计包 §10 提过它们，
 * 但同步在 §45 明确排除在 V1 之外，字段存在却永远为空就是说谎字段（既有约定 的理由）。
 */
export interface Settings {
  closeAfterCapture: boolean;
  /**
   * 收纳后保留当前活动标签页。
   *
   * **V1.1 把默认改成 false**（连活动页一起关，浏览器瞬间清爽），
   * 落地页由入口 T 页承担；T 不可用时用例自己退回"保留活动页"（见 既有约定）。
   * 原名 closeActiveTab（默认 false）语义与它相反，老数据由 Settings v2 迁移翻转。
   */
  keepActiveTab: boolean;
  /** 用户自己钉住的标签页要不要一起收走（V1.1 §5，默认关）。ShiTab 的入口页永远不受它影响。 */
  includePinnedTabs: boolean;
  /**
   * V1.2 真机第六轮起**没有** `deleteGroupAfterRestore`：恢复就是消费 ——
   * 点过一次恢复的会话不该继续躺在列表里等着被点第二次。
   * 想让它留下就锁定它，所以这个开关没有第二种用途了。
   */
  /**
   * V1.2 起**没有** `openRestoredGroupInNewWindow`：那件事变成了组标题行上的"在新窗口还原"按钮
   * —— 一个每次都要显式选的动作不该再有一个默认值开关跟它抢（既有约定，走 Settings v3 迁移删掉）。
   *
   * 标签栏入口 T 的三个开关（V1.1 设计包 A §19）。
   */
  pinnedEntryEnabled: boolean;
  /** T 被用户关闭后是否自动重建。默认关 —— "关不掉的标签页"是投诉源。 */
  autoRestorePinnedTab: boolean;
  /** ensure 时把 T 拽回固定区最左侧。 */
  keepPinnedTabFirst: boolean;
  theme: Theme;
  /** 界面语言。默认 `system`（跟随浏览器）；和 theme 一样是"每台机器自己的偏好"，进备份。 */
  locale: LocaleChoice;
}

/**
 * 界面偏好。与 Settings 分开放的两个理由：
 * 1. Settings 会进备份文件，而"这台机器的窗口多宽"不是数据 —— 换一台机器、
 *    把备份导进另一个屏幕尺寸里，都不该带着一个宽度走。
 * 2. 它会高频写（拖拽松手时写一次），不该让"改宽度"变成"设置项变了"，
 *    那会让每个 watchSettings 的 surface 都跟着抖一下。
 *
 * 只有侧栏宽度这一项。没有"上次选中的分类"之类的会话恢复状态：那是每次进页面都要重看的东西，
 * 存下来只会造成"我明明在'所有标签组'，怎么打开是'阅读'"。
 */
export interface UiPrefs {
  railWidth: number;
}

export interface StorageMeta {
  /** 导出文件的格式标记，供 importBackup 校验用；运行时迁移靠 per-key version */
  schemaVersion: number;
  installedAt: number;
  updatedAt: number;
  lastExportAt?: number;
}

// ---------------------------------------------------------------------------
// 耐久快照—— UI 不读它，它是"崩溃之后还能回到哪一刻"的证据
// ---------------------------------------------------------------------------

/** 快照格式标识与载荷形状版本都在 `shared/constants.ts`（本文件只放类型，不放值）。 */

/**
 * 一份全量本地状态。
 *
 * 载荷只有这三样，是 既有约定 定下的同步范围：**不含** `settings`（每台机器自己的偏好）、
 * 不含 `ui`（既有约定 的判据：键整个丢了用户不会以为丢了东西）、不含 `meta`。
 * `tombstones` 在里面的理由是"删除也要能传播"，而不是"它也是数据"。
 */
export interface StoredState {
  groups: TabGroup[];
  categories: Category[];
  tombstones: Tombstone[];
  /**
   * 回收站。**可选**：老快照与老载荷里根本没有这个键，
   * 读时按 `[]` 兜底（既有约定 的零迁移口径），写的时候 current build 一律带上这个键
   * —— "键不存在"和"键是空数组"在 canonicalJson 下是两个 checksum，
   * 所以把"永远写出来"固定下来才不会每台设备各算各的。
   *
   * 读侧请用 `trashOf(state)`（`core/domain/merge.ts` 导出），不要在调用点各写一遍 `?? []`。
   */
  trash?: TrashEntry[];
}

/**
 * 落进槽里的信封。`checksum` 只覆盖 `payload` 的规范化 JSON，
 * **不覆盖** `revision` / `savedAt` —— 否则"内容没变、时间变了"会被当成一次真变更，
 * 远端去重就永远不生效。
 */
export interface StateEnvelope {
  format: typeof STATE_FORMAT;
  schemaVersion: number;
  revision: number;
  savedAt: number;
  payload: StoredState;
  checksum: string;
}

export type SlotName = 'a' | 'b';

/** 槽里的物理值：gzip+base64 后的 `StateEnvelope`。没写过就是 null。 */
export type SlotValue = string | null;

/** 校验失败的分类。"为什么无效"要能写进日志，否则坏槽变成一条无信息量的一次性报错。 */
export type EnvelopeInvalid = 'empty' | 'not-json' | 'shape' | 'format' | 'checksum' | 'unzip';

export type EnvelopeVerification =
  | { ok: true; envelope: StateEnvelope }
  | { ok: false; reason: EnvelopeInvalid };

// ---------------------------------------------------------------------------
// 删除模型
// ---------------------------------------------------------------------------

/**
 * 墓碑：**整组**消失这件事的记录。
 *
 * 与来文（WebDAV-SYNC.md §5）的 `entityType: 'group' | 'tab'` 有意不同 ——
 * 这里不收 `'tab'`，理由不是省事而是"收了也没用"：单条记录被删掉之后，
 * 它所属的**组还在**，而合并是按组比的，组的 `updatedAt` 在删条目时会被
 * `touch()` 抬起，所以"少了这条"这个事实本来就随组传播。
 * 只有组整个没了，才需要一个组之外的东西来替它说话。
 * `'category'` 是第三种：分类删掉之后，指向它的会话引用会变悬空（heal 已有处理）。
 *
 * `'trash'` 是第四种，它说的**不是"一个会话没了"，而是"这一组的回收站条目被
 * 用户处理掉了"**（还原整行 / 彻底删除整行 / 逐条删到空）。`entityId` 仍是组 id。
 * 为什么非要有它：回收站进同步之后，"条目没了"这个事实如果没有载体，另一台设备手上的
 * 那一份就会在合并时把用户已经捞走或已经销毁的那一行又送回回收站 —— 那是个幽灵条目，
 * 而且**每次同步都回来一次**。为什么不复用组墓碑：组墓碑在"还原"时是要被撤销的
 * （`revokeGroupTombstone`），而这两件事都需要"条目不再回来"，语义正好相反。
 */
export interface Tombstone {
  id: string;
  entityType: 'group' | 'category' | 'trash';
  entityId: string;
  deletedAt: number;
  deletedByDeviceId: string;
  /**
   * 这次删除在用户那里长什么样。它有**读取方**，不是装饰：
   * - `user-delete`：用户点了删除 ⇒ 进回收站，可以被还原
   * - `consumed`：恢复即消费⇒ **也进**回收站（既有约定 改判：恢复完手滑关掉窗口，
   *   那批 URL 在列表和回收站里都没有了，而回收站正好能救；重复恢复的风险不存在，
   *   因为 `restoreGroup` 本来就按 URL 对目标窗口去重）
   * - `undone`：撤销收纳⇒ 不进，那条会话本来只活了 10 秒，内容已原样还给浏览器
   *
   * `entityType: 'trash'` 上这个字段记的是**那一行原本的来历**，只用于日志与排查，
   * 不参与判断（冲突对话框只看 `'group'`）。
   */
  reason: DeleteReason;
}

export type DeleteReason = 'user-delete' | 'consumed' | 'undone';

// ---------------------------------------------------------------------------
// 同步载荷
// ---------------------------------------------------------------------------

/**
 * 上传到远端的一份不可变快照。
 *
 * 与 `StateEnvelope` 的区别不是格式，是**受众**：
 * 信封是本机的双槽存储，写坏了可以退回另一槽；快照一旦上传就是**别人也要读的东西**，
 * 所以它带 `deviceId` / `baseSnapshotId` 这两项本机根本不需要的东西 ——
 * 冲突判定靠它们（两台设备从同一个 base 分叉 = 冲突）。
 *
 * 与来文（WebDAV-SYNC.md §6.1）的偏差：那份把 `tombstones` 平铺在快照顶层、
 * 又让 `state` 单独装数据。这里收进 `state` 里，因为墓碑在本机就是状态的一部分
 * （`StoredState` 已经有它），拆成两处会造成"同步时带没带删除记录"这种问不出的问题。
 */
export interface SyncSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: 1;
  snapshotId: string;
  deviceId: string;
  revision: number;
  /** 我是从哪一版改出来的。缺省 = 我是这个库的第一版。 */
  baseSnapshotId?: string;
  createdAt: number;
  /** 只覆盖 `state`：内容与 `StateEnvelope.checksum` 同源，两边算出来的必须一样。 */
  stateChecksum: string;
  state: StoredState;
}

/** manifest 里一条历史项。带着 checksum，重建时不用回读快照本体。 */
export interface ManifestEntry {
  snapshotId: string;
  revision: number;
  deviceId: string;
  createdAt: number;
  stateChecksum: string;
}

/**
 * 远端的"最新在哪"指针。
 *
 * 它**不是唯一真相**（§5 规则 5）：丢了就扫 `snapshots/` 目录、逐个验 checksum、
 * 取最高有效 revision 重建。`history` 那一项是为这件事省钱的 ——
 * 攒了几千个快照之后，"重建 manifest"不该等于"把几千个文件都下下来验一遍"。
 */
export interface SyncManifest {
  format: typeof MANIFEST_FORMAT;
  version: 1;
  latestRevision: number;
  latestSnapshotId: string;
  updatedAt: number;
  /** 参与过这个库的设备身份，只用于冲突 UI 上写"另一设备"。 */
  deviceIds: string[];
  history: ManifestEntry[];
}

/**
 * 用户在设置页填的那一坨。
 *
 * **故意没有 password**：密码单独一键。这两样的出口不同 —— 配置可以回显、可以写进
 * 远端的 `meta.json`，密码不行。放一个对象里，迟早会有一句 `JSON.stringify(config)`
 * 把它写进用户下载的备份文件（§14 明令禁止的那件事）。
 */
export interface WebDavConfig {
  enabled: boolean;
  /** 用户原样填的地址。校验过，但保留原样以便回显。 */
  baseUrl: string;
  username: string;
  /** 明文 http 要用户显式确认过一次（局域网 NAS 是真需求，但不能默认放行）。 */
  allowInsecureHttp: boolean;
  /** 上次"测试连接"成功的时刻。缺省 = 从没通过，UI 要能区分这两种。 */
  lastTestedAt?: number;
}

export type SyncStatus =
  | 'disabled'
  | 'idle'
  | 'syncing'
  | 'pending'
  | 'conflict'
  | 'suspicious_change'
  | 'error';

/**
 * 谁叫醒了这一轮同步。
 *
 * 五类 trigger **只负责"提醒"，不负责"决定要不要跑"** —— 决定权在 `decideSync`
 * （`core/domain/sync-scheduler.ts`）。这是这套东西唯一的新颖之处：之前只有一个问者
 * （本机变脏）和一颗手动按钮，"谁叫醒的"根本不是问题。
 *
 * - `heartbeat`：扩展页面活着，每 60 秒问一次
 * - `local-change`：本机数据成功写入之后（既有约定 的三个存储键）
 * - `alarm`：后台兜底，每 5 分钟（既有约定，申请 `alarms` 换来的）
 * - `startup`：service worker 起来补一刀
 * - `manual`：用户在设置页点「立即同步」。**它不绕过判据**（用户 2026-10-05 拍的 Q2b），
 *   代价是这颗按钮会被拒 ⇒ UI 必须同时说清下一次是几点，否则它长得像坏了。
 */
export type SyncTriggerReason =
  | 'heartbeat'
  | 'local-change'
  | 'alarm'
  | 'startup'
  | 'manual';

/**
 * 待用户裁决的 delete-vs-edit 冲突。
 *
 * 只存判定要用的那几个数，**不存整条会话**：合并时那条会话已经落回本地存储了，
 * 再在 meta 里复制一份就是第二个真相，而且用户改主意时两处会不一致。
 */
export interface StoredConflict {
  groupId: string;
  deletedAt: number;
  editedAt: number;
  deletedByDeviceId: string;
  deleteReason: DeleteReason;
}

/**
 * 同步引擎自己的账本。
 *
 * `dirtySinceAt` 是这套设计里唯一绕开"MV3 service worker 会被杀"的办法：
 * 去抖**不靠定时器活着**，靠这个持久化的脏标记 —— 引擎被任何事件唤醒时看到
 * "脏了，且距上次变更已超过去抖窗口"就立刻同步。
 *
 * ⚠ 这一格原来结尾是"因此不需要 `alarms` 权限"。那句在**发送侧**成立，
 * 但漏了另一半：本机不脏、对面推了新东西时，没有任何事件会来问判据
 * （既有约定 补判据 → 既有约定 补页面心跳 → 既有约定 补后台 alarm）。
 * `alarms` 现在申请了，而"脏标记不靠定时器活着"这条**原样保留** —— alarm 只是又一个来问的人。
 */
export interface SyncMeta {
  status: SyncStatus;
  /** 本机已经推上去的最高 revision。 */
  lastPushedRevision: number;
  lastSyncAt?: number;
  /** 上一次成功推上去的**内容** checksum。去重只比这一个值。 */
  lastPushedChecksum?: string;
  /** 本地数据变了但还没推出去的时刻；缺省 = 不脏。 */
  dirtySinceAt?: number;
  /** 远端最新 revision。与本机对比决定要不要拉。 */
  remoteRevision?: number;
  /** 连续失败次数 ⇒ 指数退避的指数。 */
  consecutiveFailures: number;
  /**
   * 等着用户选的冲突。空或缺省 = 没有。
   *
   * 必须落盘：引擎是在 background 里跑出冲突的，而看冲突的是某个页面上的对话框。
   * 只放在 `runSync` 的返回值里，用户一切换页面冲突就"没人知道了"，
   * 而同步会一直静默停在 conflict —— 那是最难发现的一种卡死。
   */
  pendingConflicts?: StoredConflict[];
  /** 退避到什么时候才允许再试。 */
  nextAttemptAt?: number;
  /** 最近一次错误的语义与原文。只用于显示，不参与任何判断。 */
  lastError?: { kind: string; message: string; at: number };
  /**
   * **上一次读过的远端快照文件名**，只为省流量而存在。
   *
   * manifest 指的那一版 == 这一格，**且**本地内容就是那一版（`lastPushedChecksum` 对得上）、
   * **且**本机不脏 ⇒ 这一轮不可能有新东西，不必把整份快照（压缩后 0.2–0.4 MiB）再下一遍。
   * 后台 alarm 每 5 分钟来一次，没有这一格就是每天 288 次完整下载。
   *
   * ⚠ 它**不能单独当判据**：只说"我见过这一版"，不说"我本地的内容就是这一版"。
   */
  lastSeenSnapshotId?: string;
  /**
   * 最后一次叫醒同步的是谁。不进任何判据，只用于显示与排查。
   * 落盘的理由很实际：连着两条真机投诉都卡在"到底有没有人来问过判据"这一格上。
   */
  lastTrigger?: SyncTriggerReason;
  /**
   * 有一轮同步正在飞的**跨进程认领**（时刻，既有约定）。
   *
   * 为什么不用进程内的 `let inFlight` 就够了：同步有两个执行者 —— background（心跳/alarm/
   * 本机变更/启动）与设置页那个进程（用户点「立即同步」）。两个进程各有一把进程内的锁
   * 等于没有锁：各自读一份旧账本、各自写回，后写的把前写的盖掉。
   *
   * 为什么带过期时间而不是"结束清掉就行"：进程可能在同步中途被平台杀掉（MV3 的 SW 就是会被杀），
   * 那把锁就永远没人解。所以读的时候一律按 `SYNC_CLAIM_TTL_MS` 判新旧。
   */
  syncClaimedAt?: number;
}

/**
 * 回收站里的一条。整组快照留着（不是只留 ID），因为还原要能原样放回：
 * 一个会话的价值在"那 12 个标签页是哪些"，重建不回来。
 */
export interface TrashEntry {
  group: TabGroup;
  deletedAt: number;
  /**
   * `deletedAt + TRASH_RETENTION_MS`。到点由 `sweepExpiredTrash` 物理删除。
   *
   * 它**跟着同步走，但过期判定在各机本地做**：这一格是从 `deletedAt` 推出来的，
   * 所以两台机器对同一条目会推出同一个到期时刻，不需要谁去通知谁。
   * 反过来，过期清除**绝不写移除标记** —— 否则"我这台机器的 7 天到了"会变成
   * 另一台机器上的一次删除，那正是 既有约定 要防的那类事。
   */
  expiresAt: number;
  reason: DeleteReason;
  /**
   * 每条记录**各自**是怎么进来的：`tabId → reason`。
   *
   * 为什么需要：回收站的条目不再只来自"整组被删"。单条恢复会把那一条记录
   * 单独放进来，于是同一组可能先躺了两条恢复掉的、第三天整组又被删 —— 这时条目里
   * 每条记录的来历不一样，而界面必须说清"这条你没删过"。
   *
   * 为什么是**可选 + 读时兜底**而不是加字段迁移：老条目最迟一周后自然消失
   * （既有约定 的零迁移口径）。读的时候缺省按 `reason` 算。
   *
   * ⚠ **既有约定 之后它降级成"只读旧数据"**：新的写入一律走下面的 `records`，
   * 这里只剩兼容读路径（对面那台还没升级的产物、以及远端那些旧快照）。
   * 同一行里同时存在时以 `records` 为准 —— 两处判据不一致时**不**做合并，
   * 因为 `records` 一定更新（它是这一版唯一会写的地方）。
   */
  recordReasons?: Partial<Record<string, DeleteReason>>;
  /**
   * 每条记录的完整状态：来历 + **这一次入站的时刻** + 可选的处理凭证。
   *
   * 它解决的问题很具体：记录级合并是**并集**（两台设备各往同一行新增不同记录时一条都不能丢），
   * 而并集表达不了"移除" ⇒ 逐条「彻底删除」/「还原」不留凭证的话，
   * 远端那一版（常常是本机自己上一轮推上去的）会把它并回来，用户看到的就是"删完立马又回来"。
   *
   * ⚠ **ledger 允许含有已经不在 `group.tabs` 里的 id** —— 那不是脏数据，那是凭证本身：
   * 记录可以消失，"它已被处理掉"这个事实不能跟着消失。
   * 它的回收也不需要新机制：barrier 挂在行上，行的 `expiresAt`（两台机器算出同一个值）就是它的 GC。
   *
   * 可选 + 读时兜底 ⇒ **零 schema 迁移**（`recordsOf()` 一处负责，见 `core/domain/trash-record.ts`）。
   */
  records?: Record<string, TrashRecordState>;
}

/** 用户对一条回收站记录做的那个"处理掉"的动作。 */
export type TrashRecordAction = 'purge' | 'restore';

/**
 * 一次记录级处理的凭证。
 *
 * 为什么不是复用 `Tombstone` 加一个新的 `entityType`：墓碑是全局数组、要自己写清扫，
 * 而这一条的生命周期严格属于那一行 —— 挂在行上，行没了它自然没了，
 * 也就不需要"什么时候才能安全删掉一个 barrier"这个还没法回答的问题。
 */
export interface TrashRecordBarrier {
  /** `purge` = 彻底删除这一条；`restore` = 把它还原回会话。两者都要压住远端那一版的旧副本。 */
  action: TrashRecordAction;
  /** 处理掉的那一刻，与 `arrivedAt` 比较的就是它。 */
  at: number;
  /** 同一毫秒两台设备各写一条时用它把结果钉成确定性总序（两边必须算出同一个 winner）。 */
  deviceId: string;
}

/** 一条记录在回收站里的状态。判据读的是它，不是整行的 `reason`/`deletedAt`。 */
export interface TrashRecordState {
  reason: DeleteReason;
  /**
   * 这一条**这一次**进回收站的时刻。
   *
   * 它是 barrier 的另一个操作数：少了它，barrier 就只能"永久压住这个 id"，
   * 于是后来重新入站的同一条记录也会被静默吞掉 —— 那比它要修的"会复活"更糟。
   */
  arrivedAt: number;
  barrier?: TrashRecordBarrier;
}

// ---------------------------------------------------------------------------
// 活的浏览器 tab —— 与 SavedTab 严格分开，两者不可互相赋值
// ---------------------------------------------------------------------------

export interface BrowserTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  favIconUrl?: string;
  active: boolean;
  pinned: boolean;
  index: number;
}

export interface BrowserWindow {
  id: number;
  focused: boolean;
}

export interface CreateTabInput {
  url: string;
  windowId: number;
  index?: number;
  active: boolean;
  /** 入口 T 页创建时要用（V1.1 设计包 A §7）。不给就是 false。 */
  pinned?: boolean;
}

export interface UpdateTabInput {
  url?: string;
  active?: boolean;
  pinned?: boolean;
}

// ---------------------------------------------------------------------------
// 结果计数（glossary 的"互斥且穷尽"口径）
// ---------------------------------------------------------------------------

export interface CaptureResult {
  operationId: string;
  groupId: string;
  groupTitle: string;
  /** 写进分组的条数（收纳轴） */
  saved: number;
  /** closed + kept + failed === saved（关闭轴，穷尽） */
  closed: number;
  kept: number;
  failed: number;
  /** 因为被固定住而**没有纳入收纳**的 tab 数（不进 saved 任何轴） */
  pinnedSkipped: number;
  /** 其中 restorable=false 的条数，UI 要提示"这些没法直接恢复" */
  nonRestorableSaved: number;
  /** 撤销所需的快照，按原顺序 */
  savedTabs: SavedTab[];
  /** 撤销时需要重开的、确实被关掉的那些（closeState==='closed'） */
  closableTabIds: number[];
  activeTabUrl: string | undefined;
  /**
   * 收纳前窗口里是否确实有了落脚点（入口 T 页或退路新标签页）。
   * false 时活动页会被保留（`kept`），因为关掉最后一条 tab 会连窗口一起关。
   */
  hasLanding: boolean;
}

/** 收纳没做成时不是"失败"，是"没东西可收"或"上一次还没做完"—— UI 要能区分。 */
export interface CaptureFailure {
  ok: false;
  /**
   * - `no-stashable-tabs`：窗口里除了入口页/固定页没别的（不建空组）
   * - `in-progress`：上一次收纳还在跑，本次点击被忽略（V1.1 §22 / AC-12）
   */
  reason: 'no-stashable-tabs' | 'in-progress';
  pinnedSkipped: number;
}

export type CaptureOutcome = { ok: true; result: CaptureResult } | CaptureFailure;

/**
 * 还原的去向（V1.2 既有约定：四个按钮里的三个动作维度）。
 *
 * - `current`：就在调用方所在的窗口里开（截图里的"在此窗口中还原"，也是"全部还原"的默认落点）
 * - `newWindow`：新开一个普通窗口
 * - `incognito`：新开一个无痕窗口。平台前提没满足时会**抛错**，由 UI 明确报错，
 *   不允许静默降级成普通窗口（那等于悄悄改变用户要的隐私边界）。
 */
export type RestoreMode = 'current' | 'newWindow' | 'incognito';

export interface RestoreResult {
  operationId: string;
  /** 实际开在哪个窗口（新建时是新窗口的 id） */
  windowId: number;
  mode: RestoreMode;
  /** restored + skipped + failed === 组内条目数（穷尽） */
  restored: number;
  /** **有意**没打开：已经开着或 restorable=false */
  skipped: number;
  /** **意外**失败：tabs.create 抛错 */
  failed: number;
  failedUrls: string[];
  skippedUrls: string[];
}

export interface RestoreTabResult {
  operationId: string;
  ok: boolean;
  reason?: 'not-restorable' | 'create-failed';
  error?: string;
}

export interface ImportResult {
  groupsImported: number;
  tabsImported: number;
  /** 新建的分类数（与现有分类同名时**不**重复建，只复用 —— 见 既有约定） */
  categoriesImported: number;
  /** 备份里因 ID 与现有数据重复而重新生成的**分组**数（DATA-MODEL §8）。tab ID 一律重生成，不计数。 */
  idsRegenerated: number;
}

export type ValidationError =
  | { kind: 'invalid-json' }
  | { kind: 'wrong-format'; found: unknown }
  | { kind: 'unsupported-version'; found: unknown }
  | { kind: 'shape'; path: string; message: string };

export type ValidationRejection = { ok: false; errors: ValidationError[] };

/** 校验结果。刻意**不含** ImportResult —— 那是"导入做成了"的返回值，不是校验的。 */
export type ValidateOutcome = { ok: true; backup: BackupFile } | ValidationRejection;

// ---------------------------------------------------------------------------
// 备份文件格式（DATA-MODEL §8）—— 与内部分键布局解耦
// ---------------------------------------------------------------------------

/**
 * 备份文件格式（DATA-MODEL §8）—— 与内部分键布局解耦。
 *
 * V1.2 加了 `categories`，但**版本仍是 1**：新字段全部可选，`validateBackup` 缺失时补默认
 * （没有分类列表、组没有 categoryId ⇒ 一律"未分类"）。抬版本号会让"v2 读不了 v1"成为事实，
 * 而这里没有任何破坏性变更（既有约定 的后果条）。
 */
export interface BackupFile {
  format: 'shitab-backup';
  version: 1;
  exportedAt: number;
  groups: TabGroup[];
  categories: Category[];
  settings: Settings;
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

export interface SearchHit {
  group: GroupIndexEntry;
  /** 命中来自分组名（含标题/URL/域名命中时也给出所属组） */
  matchedGroup: boolean;
  /** 组内命中的 tab；matchedGroup 为 true 且整组都算命中时给出全部 */
  matchedTabs: SavedTab[];
}
