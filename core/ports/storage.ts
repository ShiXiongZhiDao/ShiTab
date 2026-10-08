/**
 * 持久化边界接口。
 *
 * 有哪些键（meta / settings / ui / groups:index / group:<id> / categories / rev）
 * 的存在**完全藏在本接口后面**：use case 只见语义方法，不见键名。这样将来换 IndexedDB 不动业务层。
 */

import type {
  Category,
  DeviceProfile,
  GroupIndexEntry,
  Settings,
  SlotName,
  SlotValue,
  StorageMeta,
  SyncEventInput,
  SyncEventRecord,
  SyncMeta,
  TabGroup,
  Tombstone,
  TrashEntry,
  UiPrefs,
  WebDavConfig,
} from '@/shared/types';

export interface SelfHealReport {
  /** index 里有但 group 键缺失，已从 index 剔除 */
  droppedFromIndex: number;
  /** group 键存在但 index 里没有，已重建条目 */
  rebuiltIntoIndex: number;
  /** index 的 tabCount 与 group 实际条目数不符，已按 group 修正 */
  fixedTabCounts: number;
  /** 指向已不存在的分类的引用，已清成"未分类" */
  clearedDanglingCategoryRefs: number;
  /** 总分组数，用于日志 */
  groupCount: number;
}

export interface StoragePort {
  /** 首次读取前跑一次自愈（既有约定 的一致性兜底）。 */
  heal(): Promise<SelfHealReport>;

  getMeta(): Promise<StorageMeta>;
  markExported(at: number): Promise<void>;
  touchUpdatedAt(at: number): Promise<void>;

  getSettings(): Promise<Settings>;
  setSettings(settings: Settings): Promise<void>;
  watchSettings(listener: (settings: Settings) => void): () => void;

  /**
   * 界面偏好：单独一个键，**不在** Settings 里、**不进**备份。
   *
   * 读出来已经过 mergeUiPrefs 规范化，所以调用方拿到的一定是范围内的整数；
   * 按当前窗口再夹一道是渲染方的事（service worker 没有 window，适配器不能夹视口）。
   */
  getUiPrefs(): Promise<UiPrefs>;
  setUiPrefs(prefs: UiPrefs): Promise<void>;
  watchUiPrefs(listener: (prefs: UiPrefs) => void): () => void;

  /** 分类列表，已按 compareCategories 排好序。单个键、整读整写（它小且总是整块用）。 */
  listCategories(): Promise<Category[]>;
  setCategories(categories: Category[]): Promise<void>;
  watchCategories(listener: (categories: Category[]) => void): () => void;

  /** 已按 compareGroups 排好序的轻量索引。列表与分组搜索只读它。 */
  listGroupIndex(): Promise<GroupIndexEntry[]>;

  getGroup(id: string): Promise<TabGroup | undefined>;
  /**
   * 按 id 批量取会话（既有约定 决定 6 之后，搜索回源走这一颗，不再一个个 `getGroup`）。
   *
   * 为什么要有它：`getGroup` 每次都现 define 一个存储项 ⇒ 每个会话三次往返；
   * 这颗把 N 个会话压成**一次** `get(keys)`（值与 `$` 兄弟键一起拿），
   * 只有版本号对不上的那几个才回源跑迁移。索引里 300 条时，第一次搜索从 900 次读 / 904 次往返
   * 掉到 300 次读 / 2 次往返（实测见 `test/perf-baseline.spec.ts`）。
   * 顺序不保证与入参一致；ids 里不存在或读不出形状的键**静默跳过**（与 `listAllGroups` 同口径）。
   */
  listGroupsByIds(ids: readonly string[]): Promise<TabGroup[]>;
  /** 全量加载，导出与同步用（既有约定 的内存缓存来源）。 */
  listAllGroups(): Promise<TabGroup[]>;

  /** 写入一个分组，并同步 groups:index。 */
  putGroup(group: TabGroup): Promise<void>;
  removeGroup(id: string): Promise<void>;

  /** 整体替换索引（组间拖拽与导入用）。 */
  replaceGroupIndex(entries: GroupIndexEntry[]): Promise<void>;

  /** 任何分组数据变化（本上下文或其他 surface 写入）都会触发。 */
  watchGroups(listener: () => void): () => void;

  /** 导出前的原始快照，用于生成备份文件。 */
  snapshotAll(): Promise<{
    groups: TabGroup[];
    categories: Category[];
    settings: Settings;
    meta: StorageMeta;
  }>;

  // -------------------------------------------------------------------------
  // 耐久快照。UI 与 use case 都不从这里读数据 —— 它只回答
  // "崩溃之后还能回到哪一刻"。槽名（'a' / 'b'）可以暴露，**键名不行**：
  // 本接口的老约定是"有哪些键存在完全藏在实现后面"。
  // -------------------------------------------------------------------------

  /** 当前指针指向哪一槽。从没写过就是 `'a'`（默认槽，语义上等价于"两边都空"）。 */
  getSnapshotPointer(): Promise<SlotName>;

  /** 读一槽的原始值。返回 `null` 表示没写过；解不开/校验失败**不在这一层判断**。 */
  readSnapshotSlot(slot: SlotName): Promise<SlotValue>;

  /** 写一槽。**故意不校验** —— 校验是调用方（写入顺序算法）的活，见 既有约定。 */
  writeSnapshotSlot(slot: SlotName, value: string): Promise<void>;

  /** 翻指针 = 提交。这是整套双槽里唯一"让新版本生效"的动作。 */
  commitSnapshotPointer(slot: SlotName): Promise<void>;

  // -------------------------------------------------------------------------
  // 删除模型
  // -------------------------------------------------------------------------

  /** 墓碑列表，按 `deletedAt` 升序（合并时要按时间判先后）。 */
  listTombstones(): Promise<Tombstone[]>;
  setTombstones(tombstones: Tombstone[]): Promise<void>;
  watchTombstones(listener: (tombstones: Tombstone[]) => void): () => void;

  /** 回收站，按 `deletedAt` 降序（最新删的排最前，与主列表同一条排序轴）。 */
  listTrash(): Promise<TrashEntry[]>;
  putTrash(entry: TrashEntry): Promise<void>;
  removeTrash(groupId: string): Promise<void>;
  /**
   * 整块覆写回收站。**只有同步的落库路径该用它**：
   * 合并结果是"两侧并集减去被处理掉的"，逐条 `putTrash` 会把本机那份没进结果的旧行留在盘上。
   * 用户动作一律走 `core/application/delete-model.ts`。
   */
  setTrash(entries: TrashEntry[]): Promise<void>;
  /** 回收站变了（另一台设备的删除、本机同步落库都要让面板重读）。 */
  watchTrash(listener: (entries: TrashEntry[]) => void): () => void;

  /**
   * 本机设备身份。**现在是 `getDeviceProfile().id` 的一层门面**。
   *
   * 它是**墓碑的署名**：`deletedByDeviceId` 与冲突 UI 上"哪台设备改的"都读它。
   * 不进同步载荷、不进备份（把身份同步过去等于让两台机器共用一个署名，那不如没有）。
   *
   * 为什么还留着这颗而不是把所有调用点改成读档案：它有 4 个调用点、语义就是"给我一个 id"，
   * 换成 `getDeviceProfile()` 会让每一处都多带一次没人用的 name 读取。
   */
  getDeviceId(): Promise<string>;

  /**
   * 本机设备档案。不存在则**懒生成**：新 id + 默认名 + 当场检测浏览器/平台，
   * 一次落盘。两次调用拿到的是同一个 id（身份不能每个 surface 各一个，
   * 否则一台机器在同步里会显示成三台设备）。
   */
  getDeviceProfile(): Promise<DeviceProfile>;

  /**
   * 改名：规范化（trim / 空名回退默认 / 40 字截断）后落盘，返回新档案。
   *
   * ⚠ 改名**不标脏、不触发同步**：设备名不进 `state`、不参与 checksum，
   * 它随下一次**任何原因**产生的推送自然带出（代价：对面要等下一次推送才看到新名字，接受）。
   */
  setDeviceName(name: string): Promise<DeviceProfile>;

  // -------------------------------------------------------------------------
  // 同步配置与账本
  // -------------------------------------------------------------------------

  /** 同步配置（**不含密码**）。从没配过就是 `disabled` + 空地址。 */
  getWebDavConfig(): Promise<WebDavConfig>;
  setWebDavConfig(config: WebDavConfig): Promise<void>;
  watchWebDavConfig(listener: (config: WebDavConfig) => void): () => void;

  /**
   * 密码单独一键。它**不进** `snapshotAll()`、不进备份、不进快照载荷。
   * 拆开的唯一理由是出口不同：配置可以回显，密码不能。
   */
  getSyncCredential(): Promise<{ password: string } | undefined>;
  setSyncCredential(password: string): Promise<void>;
  clearSyncCredential(): Promise<void>;

  /** 引擎自己的账本。整块读写：只有引擎一个人写它。 */
  getSyncMeta(): Promise<SyncMeta>;
  setSyncMeta(meta: SyncMeta): Promise<void>;
  watchSyncMeta(listener: (meta: SyncMeta) => void): () => void;

  // -------------------------------------------------------------------------
  // 同步事件日志
  //
  // 这一条线**只为回答"这台机器上发生过什么同步"**而存在。它不是判据的一部分：
  // 引擎不许读它，`runSync` 的任何一个分支都不问它。写它也因此必须永不影响主流程
  // （见 `appendSyncEvent` 那条），否则一次 `storage.local` 写失败就会把同步弄成失败 ——
  // 而日志的价值恰恰是在同步出问题的时候还在。
  // -------------------------------------------------------------------------

  /** 同步事件，按 `at` **升序**（最旧的在前）。UI 展示时反转，最新在上。 */
  listSyncEvents(): Promise<SyncEventRecord[]>;

  /**
   * 追加一条事件：`id` 与 `at` 由实现内部生成（`at` 缺省取当前时刻，传值是为了让一轮
   * 同步里的账本与日志用同一个时刻），并做环形裁剪（只留最近 `SYNC_EVENT_LIMIT` 条）。
   *
   * ⚠ 实现**必须 catch 自身错误、永不因写日志失败而把调用方带倒**：存储坏了的时候
   * 返回一条内存记录即可，同步该成的照样成。
   */
  appendSyncEvent(input: SyncEventInput, at?: number): Promise<SyncEventRecord>;
}
