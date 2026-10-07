/**
 * StoragePort 的 WXT 实现。
 *
 * 四条实现约束全部来自实测与类型定义，不是推断（见 既有约定）：
 * 1. 键要带 `local:` 区域名前缀，落盘时会剥掉。
 * 2. 每键自带 version + migrations；`migrate()` 在扩展更新时自动跑，迁移状态持久。
 * 3. 版本元数据写在同名加 `$` 后缀的兄弟键里 => 按前缀扫描键必须排除 `$` 结尾的键。
 * 4. `removeValue()` **默认不删元数据键**（`RemoveItemOptions.removeMeta` 默认 false），
 *    删分组必须显式传 `{ removeMeta: true }`，否则永久留下 `shitab:group:<id>$` 孤儿。
 *
 * 另外 `storage.watch(key, cb)` 的签名只接受**精确**键、没有通配支持，所以跨 surface
 * 的"分组数据变了"通知靠一个自增的 rev 键来做，而不是猜一个 `group:*` 通配。
 *
 * 为什么还是 `storage.local` 而不是 V1.1 设计包 §11 推荐的 IndexedDB：见 既有约定
 * （体量实测 10k 条 ≈ 4.6 MiB，在默认 10 MiB 配额内，而 IndexedDB 与 storage.local 受同一条
 * `unlimitedStorage` 配额规则约束，换引擎并不绕开配额）。
 */

import type { SelfHealReport, StoragePort } from '@/core/ports/storage';
import type {
  Category,
  GroupIndexEntry,
  Settings,
  SlotName,
  SlotValue,
  StorageMeta,
  SyncMeta,
  TabGroup,
  Tombstone,
  TrashEntry,
  UiPrefs,
  WebDavConfig,
} from '@/shared/types';
import { SCHEMA_VERSION, STORAGE_KEYS } from '@/shared/constants';
import { compareGroups, toIndexEntry } from '@/core/domain/group';
import { isDanglingCategory, sortedCategories } from '@/core/domain/category';
import { DEFAULT_SETTINGS, mergeSettings } from '@/core/domain/settings';
import { DEFAULT_UI_PREFS, mergeUiPrefs } from '@/core/domain/ui-prefs';
import { newId, now } from '@/shared/utils';

/** 存储项自身的 schema 版本（与 meta.schemaVersion 是两回事：后者标导出文件格式）。 */
const META_VERSION = 1;
const INDEX_VERSION = 1;

/**
 * Settings 与 group 各自带自己的版本链，所以**只给这两类键**声明迁移。
 *
 * 用 per-key version 而不是全局 schemaVersion：只有真的动过形状的键
 * 才会被迁移碰，`meta` / `groups:index` / `categories` / `rev` 保持 v1，升级时不产生无谓的兄弟键。
 *
 * - Settings：v1→v2 翻转 `closeActiveTab`；v2→v3 删 `openRestoredGroupInNewWindow`；
 *   v3→v4 删 `deleteGroupAfterRestore`（既有约定，恢复即消费）
 * - group：v1→v2 补快照字段；v2→v3 补 `locked`
 */
const SETTINGS_VERSION = 4;
const GROUP_VERSION = 3;

const GROUP_PREFIX = STORAGE_KEYS.groupKeyPrefix;

type AreaKey = `local:${string}`;
const areaKey = (key: string): AreaKey => `local:${key}` as AreaKey;

function defineItem<T>(key: string, fallback: T, version = 1) {
  return storage.defineItem<T>(areaKey(key), { fallback, version });
}

/**
 * v1 的 Settings 里是 `closeActiveTab`（默认 false），v2 换成语义相反的
 * `keepActiveTab`（默认 false = 连活动页一起关）。
 *
 * 交给 mergeSettings 翻译而不是在这里手写：老备份导入走的是同一个函数，
 * 两条路径必须给出同样的结果（见 core/domain/settings.ts）。
 *
 * 导出是为了**能被单测直接喂 v1 数据**：`@wxt-dev/storage` 的 `migrate()` 是在
 * `defineItem()` 被调用的那一刻跑的（核实自 `dist/index.mjs` 里 `const migrationsDone =
 * opts?.migrations == null ? ... : migrate()`），而下面这个 settings 项是**模块级**定义，
 * 所以它在测试文件 import 本模块时就跑完了 —— 测试没法再用"先塞 v1 再读"去触发它。
 * group 项反过来：`groupItem(id)` 是每次调用现定义，所以那条路径能被端到端测到。
 */
export const migrateSettingsV1toV2 = (previous: Settings): Settings => mergeSettings(previous);

/**
 * v2→v3：删掉 `openRestoredGroupInNewWindow`。
 *
 * 走的还是 mergeSettings —— 它只认自己知道的那些键，所以老值被自然丢弃，
 * 而"在新窗口还原"从此由组标题行上的按钮显式表达。
 */
export const migrateSettingsV2toV3 = (previous: Settings): Settings => mergeSettings(previous);

/**
 * v3→v4：删掉 `deleteGroupAfterRestore`。
 *
 * 还是走 mergeSettings —— 它只认自己知道的键，所以老值被自然丢弃。
 * 那个开关的行为现在是默认且唯一的：恢复 = 消费掉那条记录 / 那个会话。
 */
export const migrateSettingsV3toV4 = (previous: Settings): Settings => mergeSettings(previous);

const settingsItem = storage.defineItem<Settings>(areaKey(STORAGE_KEYS.settings), {
  fallback: DEFAULT_SETTINGS,
  version: SETTINGS_VERSION,
  migrations: { 2: migrateSettingsV1toV2, 3: migrateSettingsV2toV3, 4: migrateSettingsV3toV4 },
});
const metaItem = defineItem<StorageMeta>(
  STORAGE_KEYS.meta,
  { schemaVersion: SCHEMA_VERSION, installedAt: 0, updatedAt: 0 },
  META_VERSION,
);
const indexItem = defineItem<GroupIndexEntry[]>(STORAGE_KEYS.groupIndex, [], INDEX_VERSION);
/** 分类列表。整读整写：它小、总是整块用，且不像 group 那样需要一键一条。 */
const categoriesItem = defineItem<Category[]>(STORAGE_KEYS.categories, [], INDEX_VERSION);
/**
 * 界面偏好。v1 且没有迁移链：它是**能整个丢掉的派生数据** ——
 * 键没了就回到默认宽度，用户不会以为丢了东西，也不需要 heal 参与。
 * 正因如此它既不进 Settings，也不进 snapshotAll() 的备份载荷。
 */
const uiItem = defineItem<UiPrefs>(STORAGE_KEYS.ui, DEFAULT_UI_PREFS, 1);
/** 每次分组数据变化 +1。跨 surface 的失效通知只看这一个键（见文件头第 5 条）。 */
const revItem = defineItem<number>(STORAGE_KEYS.rev, 0, INDEX_VERSION);

// ---------------------------------------------------------------------------
// 耐久快照与删除模型
//
// 三条实现前提：
// 1. 槽值是 **gzip+base64 的字符串**，不是对象。`storage.local` 落盘时走 JSON 序列化，
//    存 Uint8Array 会变成一堆 `{"0":131,"1":188,...}` 的十进制表 —— 体积反而膨胀约 4 倍，
//    把我压缩省下来的空间又赔回去。base64 是这件事的最低成本编码。
// 2. 这三个键**都不进** `heal()`：heal 只管"分键布局内部自不自洽"（index 与 group 键对得上），
//    快照是另一条线，它的一致性由 checksum 保证。混进 heal 会让"快照坏了"被当成
//    "index 需要重建"，那是两套真相互相污染。
// 3. 键名不能落在 `groupKeyPrefix` 里，否则 `groupIdsFrom()` 的前缀扫描会把快照当成一个分组。
//    `shitab:snap:*` / `shitab:tombstones` / `shitab:trash` 都避开了（实测见
//    test/durable-snapshot.spec.ts 的"新键不会被分键自愈当成会话"那条）。
// ---------------------------------------------------------------------------

const snapshotSlotA = defineItem<SlotValue>(STORAGE_KEYS.snapshotSlotA, null, 1);
const snapshotSlotB = defineItem<SlotValue>(STORAGE_KEYS.snapshotSlotB, null, 1);
/** 指针只管"哪一槽算数"，所以它是个字面量，不是对象。默认 'a'：两槽都空时选哪个都一样。 */
const snapshotPointer = defineItem<SlotName>(STORAGE_KEYS.snapshotPointer, 'a', 1);
const tombstonesItem = defineItem<Tombstone[]>(STORAGE_KEYS.tombstones, [], 1);
/** 回收站：一个键装整个数组。软删除是低频动作，不值得为它再造一键一条 + 索引。 */
const trashItem = defineItem<TrashEntry[]>(STORAGE_KEYS.trash, [], 1);
/** 本机设备身份。v1 无迁移链：它是**能整个重生成**的东西，丢了就当第一次用。 */
const deviceItem = defineItem<string>(STORAGE_KEYS.device, '', 1);

/**
 * 同步配置与账本。
 *
 * 默认值写在读路径上（`{ ...DEFAULT, ...stored }`）而不是只写在 `fallback` 里，
 * 是因为**旧版本写过的键会缺新字段**：`fallback` 只在"键完全不存在"时生效。
 * 少了这一层，升级后的第一次 `getWebDavConfig()` 会给出 `enabled: undefined`，
 * 而 `undefined` 在 `if (config.enabled)` 里是 falsy —— 看起来正常，
 * 但设置页的开关绑的是 `:checked="config?.enabled"`，于是它显示成"关"而存储里其实是 true。
 */
const DEFAULT_WEBDAV_CONFIG: WebDavConfig = {
  enabled: false,
  baseUrl: '',
  username: '',
  allowInsecureHttp: false,
};

const DEFAULT_SYNC_META: SyncMeta = {
  status: 'disabled',
  lastPushedRevision: 0,
  consecutiveFailures: 0,
};

const configItem = defineItem<WebDavConfig>(STORAGE_KEYS.syncConfig, DEFAULT_WEBDAV_CONFIG, 1);
const syncMetaItem = defineItem<SyncMeta>(STORAGE_KEYS.syncMeta, DEFAULT_SYNC_META, 1);
/** 密码。空串 = 没存。它**不在** `snapshotAll()` 的载荷里，也永远不会被序列化进备份。 */
const credentialItem = defineItem<string>(STORAGE_KEYS.syncCredential, '', 1);

const SLOT_ITEMS: Record<SlotName, typeof snapshotSlotA> = {
  a: snapshotSlotA,
  b: snapshotSlotB,
};

/** 墓碑要按删除时间排：合并时"谁更晚"是唯一的判据来源。 */
function sortedTombstones(items: Tombstone[]): Tombstone[] {
  return [...items].sort((a, b) => a.deletedAt - b.deletedAt);
}

/**
 * 回收站按删除时间降序，与主列表"最新在前"同一条轴。
 *
 * `group.id` 做第二位**不是**为了好看：同一天删掉两个会话会有相同的 `deletedAt`，
 * 而数组顺序进 checksum。没有这条 tiebreak，同一份事实在两台机器上能排出两种顺序，
 * 于是每轮同步都多出一个"内容看起来一样"的远端快照（既有约定 的去重防的就是这个）。
 */
function sortedTrash(items: TrashEntry[]): TrashEntry[] {
  return [...items].sort(
    (a, b) => b.deletedAt - a.deletedAt || (a.group.id < b.group.id ? -1 : a.group.id > b.group.id ? 1 : 0),
  );
}

/**
 * v2 的 TabGroup 没有 `locked`。缺失一律按 false：
 * "没锁"是安全的默认，把老数据集体锁成删不掉才是意外行为。
 */
export function migrateGroupV2toV3(group: TabGroup | null): TabGroup | null {
  if (!group || typeof group !== 'object') return group;
  return { ...group, locked: group.locked === true };
}

/**
 * v1 的 SavedTab 没有 originalIndex / originalPinned。
 *
 * 补齐规则：originalIndex 用 sortOrder 顶上 —— 老数据里两者恒等（收纳时就是按
 * 窗口顺序 0..n-1 写的），而跨组移动/导入后 sortOrder 会被重排成稠密序列，
 * 用当时的值近似"原位置"比留 undefined 参与算术好。originalPinned 只能填 false：
 * v1 根本不会收纳固定页，所以"记录里没有固定页"这个事实是可靠的。
 */
export function migrateGroupV1toV2(group: TabGroup | null): TabGroup | null {
  if (!group || !Array.isArray(group.tabs)) return group;
  return {
    ...group,
    tabs: group.tabs.map((tab) => ({
      ...tab,
      originalIndex: Number.isFinite(tab.originalIndex) ? tab.originalIndex : tab.sortOrder,
      originalPinned: tab.originalPinned === true,
    })),
  };
}

const groupItem = (id: string) =>
  storage.defineItem<TabGroup | null>(areaKey(STORAGE_KEYS.group(id)), {
    fallback: null,
    version: GROUP_VERSION,
    migrations: {
      2: (previous: TabGroup | null) => migrateGroupV1toV2(previous),
      3: (previous: TabGroup | null) => migrateGroupV2toV3(previous),
    },
  });

/**
 * 既有约定：进程内所有写串行。
 *
 * 这里不解决**跨** surface 的并发 —— 那靠分键布局把冲突面缩到单个 group 键。
 * 多键 `set` 是否原子尚未确认，所以 putGroup 一律"先写 group、后写 index"，
 * index 永远可以由 group 重建（heal 保证）。
 */
function createWriteQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}

/** 前缀扫描，排除 `$` 元数据兄弟键（文件头第 3 条）。 */
export function groupIdsFrom(raw: Record<string, unknown>): string[] {
  return Object.keys(raw)
    .filter((key) => key.startsWith(GROUP_PREFIX) && !key.endsWith('$'))
    .map((key) => key.slice(GROUP_PREFIX.length));
}

/** `heal()` 从整块 `raw` 里读一个会话的三种回答（既有约定 决定 4）。 */
export type RawGroupRead =
  | { kind: 'ok'; group: TabGroup }
  | { kind: 'needs-migration' }
  | { kind: 'unreadable' };

/**
 * 从 `heal()` **已经拉到手**的那一份 `raw` 里取出某个会话的值。
 *
 * 为什么不用 `groupItem(id).getValue()`：`groupItem` 是**每次调用现 define**（上面 `:224-232`，
 * 文件头第 76-78 行那条注释也写了这件事），而 `defineItem` 只要带 `migrations` 就会立刻读
 * "值 + `$` 元数据"再读一次值 ⇒ 每个会话三次读请求。实测：300 组 = 900 次、3,000 组 = 9,000 次
 * （`test/perf-baseline.spec.ts`）。而 `:293` 那次 `get(null)` 本来就把整块拉回来了，
 * 值也是浏览器解析好的对象（同一条用例钉着形状）。
 *
 * ★ 版本这一道判断不能省：`meta.v` 缺失或不等于当前 `GROUP_VERSION` 时必须让调用方
 *   **退回 `groupItem(id).getValue()`** —— 只有那条路径会跑 `migrations`（既有约定 的 per-key 版本链）。
 *   省掉它，"升级后第一次打开工作台"就会把 v2 形状的会话原样当 v3 写进 index，`locked` 那一档静默丢失。
 *   稳态下这个分支一次都不走（一次写就会把 `$` 元数据抬到当前版本），所以收益不丢。
 */
export function groupFromRaw(
  raw: Record<string, unknown>,
  id: string,
  currentVersion = GROUP_VERSION,
): RawGroupRead {
  const value = raw[`${GROUP_PREFIX}${id}`];
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unreadable' };
  }
  // 与 @wxt-dev/storage 同向兜底：没有 `$` 兄弟键就按 v1 算（dist/index.mjs 里 `meta?.v ?? 1`）。
  const storedVersion = (raw[`${GROUP_PREFIX}${id}$`] as { v?: number } | undefined)?.v ?? 1;
  if (storedVersion !== currentVersion) return { kind: 'needs-migration' };
  const group = value as TabGroup;
  // id 与键不一致 = 半截写入 / 手工塞进去的东西；与原来"清掉孤儿"同一处置。
  if (group.id !== id || !Array.isArray(group.tabs)) return { kind: 'unreadable' };
  return { kind: 'ok', group };
}

/**
 * 整份/批量取会话的**唯一**实现（既有约定 决定 4 的手法搬到批量读上）。
 *
 * 一次 `get(keys)` 把每个会话的值与它的 `$` 兄弟键一起拿回来 ⇒ N 个会话只要**一次往返**；
 * 只有版本号对不上的那几个才回 `getValue()`（迁移只在那条路径上跑，稳态一次都不走）。
 * 读不出形状的键静默跳过 —— 旧写法 `filter(Boolean)` 会把一个非空字符串当成一个会话带进快照，
 * 那是往远端写垃圾的形状，所以这一处是修正，不是等价改写（`test/storage-port.spec.ts` 钉着）。
 */
async function readGroupsBulk(ids: readonly string[]): Promise<TabGroup[]> {
  if (ids.length === 0) return [];
  const keys: string[] = [];
  for (const id of ids) {
    keys.push(`${GROUP_PREFIX}${id}`, `${GROUP_PREFIX}${id}$`);
  }
  const raw = ((await browser.storage.local.get(keys)) ?? {}) as Record<string, unknown>;

  const groups: TabGroup[] = [];
  for (const id of ids) {
    const fromRaw = groupFromRaw(raw, id);
    if (fromRaw.kind === 'ok') {
      groups.push(fromRaw.group);
      continue;
    }
    if (fromRaw.kind === 'needs-migration') {
      const migrated = (await groupItem(id).getValue()) ?? undefined;
      if (migrated) groups.push(migrated);
    }
  }
  return groups;
}

export function createStoragePort(): StoragePort {
  const write = createWriteQueue();
  let healed = false;

  const readIndex = async (): Promise<GroupIndexEntry[]> => (await indexItem.getValue()) ?? [];

  const listCategoriesSorted = async (): Promise<Category[]> =>
    sortedCategories((await categoriesItem.getValue()) ?? []);

  const bumpRev = () =>
    write(async () => {
      await revItem.setValue((await revItem.getValue()) + 1);
    });

  async function upsertIndexEntry(group: TabGroup): Promise<void> {
    const entries = await readIndex();
    const entry = toIndexEntry(group);
    const at = entries.findIndex((candidate) => candidate.id === group.id);
    const next = at === -1 ? [...entries, entry] : entries.map((candidate, i) => (i === at ? entry : candidate));
    await write(() => indexItem.setValue(next));
  }

  return {
    async heal(): Promise<SelfHealReport> {
      const report: SelfHealReport = {
        droppedFromIndex: 0,
        rebuiltIntoIndex: 0,
        fixedTabCounts: 0,
        clearedDanglingCategoryRefs: 0,
        groupCount: 0,
      };
      if (healed) {
        report.groupCount = (await readIndex()).length;
        return report;
      }

      const raw = ((await browser.storage.local.get(null)) ?? {}) as Record<string, unknown>;
      const onDiskIds = new Set(groupIdsFrom(raw));
      const entries = await readIndex();
      const indexedIds = new Set(entries.map((entry) => entry.id));

      // 1) index 有、group 键缺 => 剔除（留着会让 UI 显示一个点不开的空组）
      const survivors: GroupIndexEntry[] = [];
      for (const entry of entries) {
        if (onDiskIds.has(entry.id)) survivors.push(entry);
        else report.droppedFromIndex += 1;
      }

      // 2) group 键在、index 缺 => 用 group 自身的数据重建条目
      for (const id of onDiskIds) {
        if (indexedIds.has(id)) continue;
        const fromRaw = groupFromRaw(raw, id);
        // 只有"值带着旧版本号"这一档才回到逐键路径 —— 那一趟要跑迁移，不能省。
        const group =
          fromRaw.kind === 'ok'
            ? fromRaw.group
            : fromRaw.kind === 'needs-migration'
              ? ((await groupItem(id).getValue()) ?? undefined)
              : undefined;
        if (!group || group.id !== id) {
          // 键存在但内容不可用（半截写入）：连元数据一起清掉，别留孤儿
          await write(() => groupItem(id).removeValue({ removeMeta: true }));
          report.droppedFromIndex += 1;
          continue;
        }
        survivors.push(toIndexEntry(group));
        report.rebuiltIntoIndex += 1;
      }

      // 3) tabCount 是派生冗余，以 group 实际内容为准修正
      //    ★ 值直接取自上面那份 `raw`，不再逐键 `getValue()`（既有约定 决定 4；修正语义一个字没动）。
      const corrected: GroupIndexEntry[] = [];
      for (const entry of survivors) {
        const fromRaw = groupFromRaw(raw, entry.id);
        if (fromRaw.kind === 'unreadable') {
          /**
           * ★ 这里**故意保守**：读不出形状的键就原样留着那条 index，不动它、也不删它。
           *
           * 旧实现这一档要么在 `group.tabs.length` 上抛（整条 heal reject，页面初始化跟着失败），
           * 要么走到 `if (!group) continue` 把那条**从 index 里丢掉** —— 丢掉比抛更坏：
           * 会话先从界面上消失，而下一次 heal 的第 2 步会把它当"index 缺、group 在"的孤儿**连键带元数据删掉**，
           * 于是一条也许还能手工救回来的数据被自动销毁。既有约定 的口径是"宁可少一个分类归属，
           * 也不能显示成看不见的东西"，同一句话反过来成立：**不许把看得见的东西悄悄弄没**。
           */
          corrected.push(entry);
          continue;
        }
        // 版本号对不上 ⇒ 回到逐键路径，那一趟会跑 per-key 迁移，不能省。
        const group =
          fromRaw.kind === 'ok' ? fromRaw.group : ((await groupItem(entry.id).getValue()) ?? undefined);
        if (!group) {
          corrected.push(entry);
          continue;
        }
        if (group.tabs.length === entry.tabCount) {
          corrected.push(entry);
        } else {
          corrected.push({ ...entry, tabCount: group.tabs.length });
          report.fixedTabCounts += 1;
        }
      }

      // 4) 分类是后加的实体：老数据 / 半截删除都可能留下指向不存在分类的引用。
      //    悬空引用不报错、不显示成"某个看不见的分类里"，一律按未分类处理。
      const categories = await listCategoriesSorted();
      const withLiveRefs: GroupIndexEntry[] = [];
      for (const entry of corrected) {
        if (!isDanglingCategory(entry.categoryId, categories)) {
          withLiveRefs.push(entry);
          continue;
        }
        const { categoryId: _dropped, ...rest } = entry;
        withLiveRefs.push(rest);
        report.clearedDanglingCategoryRefs += 1;
      }

      const ordered = [...withLiveRefs].sort(compareGroups);
      await write(() => indexItem.setValue(ordered));
      report.groupCount = ordered.length;

      const meta = await metaItem.getValue();
      if (!meta.installedAt) {
        await write(() =>
          metaItem.setValue({
            ...meta,
            schemaVersion: SCHEMA_VERSION,
            installedAt: now(),
            updatedAt: now(),
          }),
        );
      }

      healed = true;
      return report;
    },

    async getMeta() {
      const meta = await metaItem.getValue();
      if (meta.installedAt) return meta;
      const fresh: StorageMeta = {
        schemaVersion: SCHEMA_VERSION,
        installedAt: now(),
        updatedAt: now(),
      };
      await write(() => metaItem.setValue(fresh));
      return fresh;
    },

    async markExported(at) {
      const meta = await metaItem.getValue();
      await write(() => metaItem.setValue({ ...meta, lastExportAt: at, updatedAt: at }));
    },

    async touchUpdatedAt(at) {
      const meta = await metaItem.getValue();
      await write(() => metaItem.setValue({ ...meta, updatedAt: at }));
    },

    async getSettings() {
      return mergeSettings(await settingsItem.getValue());
    },

    setSettings(settings) {
      return write(() => settingsItem.setValue(mergeSettings(settings)));
    },

    watchSettings(listener) {
      return settingsItem.watch((value) => listener(mergeSettings(value)));
    },

    async getUiPrefs() {
      return mergeUiPrefs(await uiItem.getValue());
    },

    // 整块覆盖写：宽度只有一个字段，没有需要保护的"读-改-写"，串行队列照走是为了
    // 与其余写同一个秩序，不是为了防并发。
    setUiPrefs(prefs) {
      return write(() => uiItem.setValue(mergeUiPrefs(prefs)));
    },

    watchUiPrefs(listener) {
      return uiItem.watch((value) => listener(mergeUiPrefs(value)));
    },

    listCategories: listCategoriesSorted,

    setCategories(categories) {
      // 整块写：分类数量是"人手几个"的量级，没有做增删改细粒度键的收益。
      return write(() => categoriesItem.setValue(sortedCategories(categories)));
    },

    watchCategories(listener) {
      return categoriesItem.watch((value) => listener(sortedCategories(value ?? [])));
    },

    async listGroupIndex() {
      return [...(await readIndex())].sort(compareGroups);
    },

    async getGroup(id) {
      return (await groupItem(id).getValue()) ?? undefined;
    },

    /**
     * 整份读回所有会话（同步 / 导入导出 / 耐久快照的唯一入口）。
     *
     * ★ 2026-10-06 改了读法、没改语义：以前对**每个会话**调一次 `groupItem(id).getValue()`，
     *   而 `groupItem` 每次现 define ⇒ 每次要三趟往返（实测 300 组 = 900 次组键读、904 次 `get()`）。
     *   现在跟 `heal()` 一样：**一次批量 `get(keys)` 把值与 `$` 兄弟键一起拿回来**，再用同一个
     *   `groupFromRaw()` 认形状 ⇒ 往返次数从 3N 降到 2（一次读索引 + 一次批量读）。
     *   `needs-migration` 那一档仍逐键回 `getValue()`（迁移只在那条路径上跑），稳态一次都不走。
     *
     * 语义三条要记住的（都跟以前一致，除了第 3 条）：
     * 1. **以 `groups:index` 为准**：不在索引里的孤儿键不参与（索引由 heal 维持）。
     * 2. 索引有、键没有 ⇒ 跳过（旧的 `getValue() ?? undefined` 然后 `filter(Boolean)` 同一处置）。
     * 3. ★ **值读不出形状（半截写入 / 手工塞的字符串）时现在跳过**，
     *    而旧实现 `Boolean(group)` 会把一个非空字符串**当成一个会话带进快照** ——
     *    那是把垃圾写进远端快照的形状，所以这一处是修正，不是等价改写（配了用例钉住）。
     */
    async listGroupsByIds(ids) {
      return readGroupsBulk(ids);
    },

    async listAllGroups() {
      const entries = await readIndex();
      return readGroupsBulk(entries.map((entry) => entry.id));
    },

    async putGroup(group) {
      await write(() => groupItem(group.id).setValue(group));
      await upsertIndexEntry(group);
      await this.touchUpdatedAt(now());
      await bumpRev();
    },

    async removeGroup(id) {
      // removeMeta: true 是必须的，否则 shitab:group:<id>$ 永久残留
      await write(() => groupItem(id).removeValue({ removeMeta: true }));
      const entries = await readIndex();
      await write(() => indexItem.setValue(entries.filter((entry) => entry.id !== id)));
      await this.touchUpdatedAt(now());
      await bumpRev();
    },

    async replaceGroupIndex(entries) {
      await write(() => indexItem.setValue([...entries].sort(compareGroups)));
      await bumpRev();
    },

    watchGroups(listener) {
      return revItem.watch(() => listener());
    },

    async snapshotAll() {
      return {
        groups: await this.listAllGroups(),
        categories: await listCategoriesSorted(),
        settings: await this.getSettings(),
        meta: await this.getMeta(),
      };
    },

    // --- 耐久快照---------------------------------------------------
    // 走 `write()` 队列是必须的：快照写与分组写共用同一条串行线，
    // 才能保证"写完第 37 组之后再拍快照"看到的是一致状态，而不是写一半的状态。

    async getSnapshotPointer() {
      return (await snapshotPointer.getValue()) ?? 'a';
    },

    async readSnapshotSlot(slot) {
      return (await SLOT_ITEMS[slot].getValue()) ?? null;
    },

    writeSnapshotSlot(slot, value) {
      return write(() => SLOT_ITEMS[slot].setValue(value));
    },

    commitSnapshotPointer(slot) {
      return write(() => snapshotPointer.setValue(slot));
    },

    // --- 删除模型---------------------------------------------------

    async listTombstones() {
      return sortedTombstones((await tombstonesItem.getValue()) ?? []);
    },

    setTombstones(tombstones) {
      return write(() => tombstonesItem.setValue(sortedTombstones(tombstones)));
    },

    watchTombstones(listener) {
      return tombstonesItem.watch((value) => listener(sortedTombstones(value ?? [])));
    },

    async listTrash() {
      return sortedTrash((await trashItem.getValue()) ?? []);
    },

    async putTrash(entry) {
      const current = await this.listTrash();
      const next = sortedTrash([entry, ...current.filter((item) => item.group.id !== entry.group.id)]);
      await write(() => trashItem.setValue(next));
    },

    async removeTrash(groupId) {
      const current = await this.listTrash();
      const next = current.filter((item) => item.group.id !== groupId);
      if (next.length === current.length) return;
      await write(() => trashItem.setValue(next));
    },

    setTrash(entries) {
      return write(() => trashItem.setValue(sortedTrash(entries)));
    },

    watchTrash(listener) {
      return trashItem.watch((value) => listener(sortedTrash(value ?? [])));
    },

    /**
     * 先到先得，靠"写完再读一次"收敛，不靠锁。
     *
     * 三个 surface 都可能在第一次使用时发现"还没有身份"。真撞上就是两个候选 UUID 先后落盘，
     * 最后落盘的那个赢 —— 这对数据正确性没有影响（身份只是墓碑的署名），
     * 但"每个 surface 各自一个身份"是必须避免的：那会让同一台机器在同步里看起来像三台设备，
     * 冲突 UI 会显示两台不存在的主机。所以身份只存一处、读取一律走这个函数。
     */
    async getDeviceId() {
      const stored = await deviceItem.getValue();
      if (stored) return stored;
      const mine = newId();
      await write(() => deviceItem.setValue(mine));
      return (await deviceItem.getValue()) || mine;
    },

    async getWebDavConfig() {
      const stored = await configItem.getValue();
      // 读出来就规范化：键被旧版本写过、或者被人手改过，都不能让 UI 拿到 `undefined` 的 enabled
      return { ...DEFAULT_WEBDAV_CONFIG, ...(stored ?? {}) };
    },

    setWebDavConfig(config) {
      return write(() => configItem.setValue({ ...DEFAULT_WEBDAV_CONFIG, ...config }));
    },

    watchWebDavConfig(listener) {
      return configItem.watch((value) => listener({ ...DEFAULT_WEBDAV_CONFIG, ...(value ?? {}) }));
    },

    async getSyncCredential() {
      const password = await credentialItem.getValue();
      return password ? { password } : undefined;
    },

    setSyncCredential(password) {
      return write(() => credentialItem.setValue(password));
    },

    clearSyncCredential() {
      return write(() => credentialItem.removeValue({ removeMeta: true }));
    },

    async getSyncMeta() {
      return { ...DEFAULT_SYNC_META, ...(await syncMetaItem.getValue()) };
    },

    setSyncMeta(meta) {
      return write(() => syncMetaItem.setValue({ ...DEFAULT_SYNC_META, ...meta }));
    },

    watchSyncMeta(listener) {
      return syncMetaItem.watch((value) => listener({ ...DEFAULT_SYNC_META, ...(value ?? {}) }));
    },
  };
}
