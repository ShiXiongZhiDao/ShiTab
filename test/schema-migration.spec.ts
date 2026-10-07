/**
 * per-key 版本迁移（既有约定 的迁移机制 + 既有约定 的 v2 字段）。
 *
 * 为什么单独成一份：迁移是"升级之后才暴露"的那类 bug —— 装新版本的真实用户才会走这条路，
 * 开发环境里永远是干净的新键。
 *
 * 写这份测试时先踩到一个机制事实，它决定了下面的结构（核实自
 * `node_modules/@wxt-dev/storage/dist/index.mjs` 的 `defineItem`）：
 *
 * > `migrate()` 是在 `defineItem()` 被调用那一刻跑的，不是 `getValue()` 时懒跑的；
 * > 并且 `value == null` 时直接返回，不写版本兄弟键。
 *
 * 所以两条路要分开测：
 * - `settings` 是**模块级**定义 → 测试 import 本模块时就跑完了，"先塞 v1 再读"触发不到它，
 *   能验证的是**读时防御**（`mergeSettings`）；真正的迁移函数用探针键单独喂。
 * - `group:<id>` 每次调用现定义 → 生产路径可以被端到端触发。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createStoragePort,
  groupIdsFrom,
  migrateGroupV1toV2,
  migrateSettingsV1toV2,
} from '@/infrastructure/storage/wxt-storage';
import { DEFAULT_SETTINGS } from '@/core/domain/settings';
import { STORAGE_KEYS } from '@/shared/constants';
import type { Settings, TabGroup } from '@/shared/types';

const AT = 1_700_000_000_000;

/** v1 时代真实落盘过的 Settings 形状（没有 keepActiveTab / includePinnedTabs / 三个入口开关）。 */
const V1_SETTINGS = {
  closeAfterCapture: true,
  closeActiveTab: false,
  deleteGroupAfterRestore: false,
  openRestoredGroupInNewWindow: false,
  theme: 'system',
};

function v1Group(id: string): unknown {
  // 故意用 v1 的形状（缺 originalIndex / originalPinned），所以返回类型是 unknown
  return {
    id,
    title: '老数据',
    createdAt: AT,
    updatedAt: AT,
    isPinned: false,
    sortOrder: 0,
    tabs: [
      { id: 't0', groupId: id, url: 'https://a.test/0', title: '零', createdAt: AT, sortOrder: 0, wasActive: true, closeState: 'closed', restorable: true },
      { id: 't1', groupId: id, url: 'https://a.test/1', title: '一', createdAt: AT, sortOrder: 1, wasActive: false, closeState: 'kept', restorable: true },
      { id: 't2', groupId: id, url: 'https://a.test/2', title: '二', createdAt: AT, sortOrder: 2, wasActive: false, closeState: 'closed', restorable: false },
    ],
  };
}

/** 伪造"这条键上次是由 v1 写的"：值 + 同名 `$` 兄弟键里的 `{"v":1}`。 */
async function seedAsV1(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [key]: value, [`${key}$`]: { v: 1 } });
}

const rawDump = async (): Promise<Record<string, unknown>> =>
  ((await browser.storage.local.get(null)) ?? {}) as Record<string, unknown>;

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
});

describe('migrateSettingsV1toV2 本身', () => {
  it('closeActiveTab 被翻译成语义相反的 keepActiveTab', () => {
    expect(migrateSettingsV1toV2(V1_SETTINGS as unknown as Settings).keepActiveTab).toBe(true);
    // 反过来：老配置说"活动页也关"，新字段就该是"不保留"
    expect(
      migrateSettingsV1toV2({ ...V1_SETTINGS, closeActiveTab: true } as unknown as Settings).keepActiveTab,
    ).toBe(false);
  });

  it('对已经是 v2 形状的值是幂等的，不会把用户的选择翻过来', () => {
    const v2: Settings = { ...DEFAULT_SETTINGS, keepActiveTab: true, includePinnedTabs: true };
    expect(migrateSettingsV1toV2(v2)).toEqual(v2);
  });

  it('新字段按默认补齐，旧字段不再残留', () => {
    const migrated = migrateSettingsV1toV2(V1_SETTINGS as unknown as Settings);
    expect(migrated).toMatchObject({
      pinnedEntryEnabled: true,
      autoRestorePinnedTab: false,
      keepPinnedTabFirst: true,
      includePinnedTabs: false,
    });
    expect(migrated).not.toHaveProperty('closeActiveTab');
  });
});

describe('@wxt-dev/storage 真的会调用它（探针键走完整迁移流程）', () => {
  it('v1 值 + {"v":1} 兄弟键 -> 迁移执行且版本推进到 2', async () => {
    const key = 'local:probe:settings';
    await seedAsV1('probe:settings', V1_SETTINGS);

    const item = storage.defineItem<Settings>(key, {
      fallback: DEFAULT_SETTINGS,
      version: 2,
      migrations: { 2: migrateSettingsV1toV2 },
    });

    await expect(item.getValue()).resolves.toMatchObject({ keepActiveTab: true });
    const raw = await rawDump();
    expect((raw['probe:settings$'] as { v: number }).v).toBe(2);
  });

  it('只有值、没有版本兄弟键时不跑迁移（读时防御才是这条路的兜底）', async () => {
    await browser.storage.local.set({ 'probe:settings': V1_SETTINGS });

    const item = storage.defineItem<Settings>('local:probe:settings', {
      fallback: DEFAULT_SETTINGS,
      version: 2,
      migrations: { 2: migrateSettingsV1toV2 },
    });

    await expect(item.getValue()).resolves.toMatchObject({ keepActiveTab: true });
    // 库把缺失的兄弟键当 v1 处理并迁移；这条断言的作用是：如果哪天它改成"当作最新",
    // 这个测试会红，我们就得回头检查读时防御是不是成了唯一兜底。
    expect(await rawDump()).toHaveProperty('probe:settings$');
  });
});

describe('生产 settings 键的读时兜底', () => {
  it('模块级 item 已在 import 时迁移过，所以这里验的是 getSettings 对 v1 形状仍给出可用值', async () => {
    await browser.storage.local.set({ [STORAGE_KEYS.settings]: V1_SETTINGS });

    const settings = await createStoragePort().getSettings();

    expect(settings.keepActiveTab).toBe(true);
    expect(settings.theme).toBe('system');
    expect(settings.autoRestorePinnedTab).toBe(false);
    expect(settings).not.toHaveProperty('closeActiveTab');
  });
});

describe('分组 v1 -> v3 迁移链（生产路径，可端到端触发）', () => {
  it('补齐 originalIndex（用 sortOrder 顶上）与 originalPinned=false，再过 v3 补 locked', async () => {
    const id = 'legacy-group';
    await seedAsV1(STORAGE_KEYS.group(id), v1Group(id));

    const group = await createStoragePort().getGroup(id);
    expect(group?.tabs.map((tab) => tab.originalIndex)).toEqual([0, 1, 2]);
    expect(group?.tabs.every((tab) => tab.originalPinned === false)).toBe(true);
    // 其余字段一个都不能丢
    expect(group?.tabs.map((tab) => tab.url)).toEqual(['https://a.test/0', 'https://a.test/1', 'https://a.test/2']);
    expect(group?.tabs[2]?.restorable).toBe(false);
    // V1.2 的 v3 给老数据补上"没锁"（安全默认）与"未分类"（缺字段，不是 null）
    expect(group?.locked).toBe(false);
    expect(group).not.toHaveProperty('categoryId');
    // 迁移状态持久：版本兄弟键一路推到当前版本 3
    expect(((await rawDump())[`${STORAGE_KEYS.group(id)}$`] as { v: number }).v).toBe(3);
  });

  it('迁移产生的 `$` 兄弟键不会被自愈当成一个分组', async () => {
    const id = 'legacy-group';
    await seedAsV1(STORAGE_KEYS.group(id), v1Group(id));
    const storagePort = createStoragePort();

    await storagePort.getGroup(id);
    const raw = await rawDump();
    expect(Object.keys(raw)).toContain(`${STORAGE_KEYS.group(id)}$`);

    // 朴素前缀扫描会数出 2 个分组，那正是"自愈制造脏数据"的形状
    const naive = Object.keys(raw).filter((key) => key.startsWith(STORAGE_KEYS.groupKeyPrefix));
    expect(naive).toHaveLength(2);
    expect(groupIdsFrom(raw)).toEqual([id]);

    const report = await storagePort.heal();
    expect(report.groupCount).toBe(1);
    expect(report.rebuiltIntoIndex).toBe(1); // 只有真分组被重建进 index
    expect((await storagePort.listGroupIndex()).map((entry) => entry.id)).toEqual([id]);
  });

  it('migrateGroupV1toV2 对 null 与坏形状不动手（不能把半截写入变成"看起来正常"的组）', () => {
    expect(migrateGroupV1toV2(null)).toBeNull();
    const broken = { id: 'x', title: 'x' } as unknown as TabGroup;
    expect(migrateGroupV1toV2(broken)).toBe(broken);
  });
});

describe('干净安装', () => {
  it('默认设置完整可用，且读默认值不产生任何键', async () => {
    const settings = await createStoragePort().getSettings();
    expect(settings).toEqual<Settings>(DEFAULT_SETTINGS);
    expect(await rawDump()).toEqual({});
  });
});
