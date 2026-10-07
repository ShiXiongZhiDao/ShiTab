/**
 * 导入 / 导出（既有约定 §8）。
 *
 * 校验是**手写**的，不引 zod：导入是低频路径，手写能给出更具体的
 * 中文错误定位（哪个组第几条哪里不对），也少一个运行时依赖。
 *
 * 导出**不用 downloads 权限**：用 Blob + `<a download>` 点击，浏览器按普通下载处理，
 * 不需要在 manifest 里加 `downloads`（BROWSER-PERMISSIONS §3 的权限原则）。
 */

import type { StoragePort } from '@/core/ports/storage';
import type {
  BackupFile,
  Category,
  GroupIndexEntry,
  ValidateOutcome,
  ImportResult,
  SavedTab,
  Settings,
  TabGroup,
  ValidationError,
} from '@/shared/types';
import { BACKUP_FORMAT, BACKUP_VERSION, SCHEMA_VERSION } from '@/shared/constants';
import { isRestorableUrl } from '@/core/domain/tab';
import { normalizeTitle, renumberTabs, tailSortOrder, toIndexEntry } from '@/core/domain/group';
import { nextCategorySortOrder, normalizeCategoryName } from '@/core/domain/category';
import { mergeSettings } from '@/core/domain/settings';
import { domainOf, newId } from '@/shared/utils';

export function buildBackup(
  groups: TabGroup[],
  categories: Category[],
  settings: Settings,
  at: number,
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: at,
    groups: groups.map((group) => ({
      ...group,
      tabs: [...group.tabs].sort((a, b) => a.sortOrder - b.sortOrder),
    })),
    categories: [...categories].sort((a, b) => a.sortOrder - b.sortOrder),
    settings,
  };
}

export function serializeBackup(backup: BackupFile): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

function fail(errors: ValidationError[]): { ok: false; errors: ValidationError[] } {
  return { ok: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * 校验并规范化一份外部 JSON。
 *
 * 返回的 groups 已经过清洗：ID 与 groupId 重新生成过冲突检测在这里做不合适
 * （要连现有数据一起看），所以本函数只保证**形状**正确，ID 冲突交给 importBackup。
 */
export function validateBackup(raw: unknown): ValidateOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return fail([{ kind: 'shape', path: '(root)', message: '根节点必须是对象' }]);
  }
  const root = raw as Record<string, unknown>;

  if (root.format !== BACKUP_FORMAT) {
    return fail([{ kind: 'wrong-format', found: root.format }]);
  }
  const version = num(root.version);
  if (version === undefined || version > SCHEMA_VERSION) {
    return fail([{ kind: 'unsupported-version', found: root.version }]);
  }
  if (!Array.isArray(root.groups)) {
    return fail([{ kind: 'shape', path: 'groups', message: '必须是数组' }]);
  }

  const errors: ValidationError[] = [];
  const groups: TabGroup[] = [];

  root.groups.forEach((candidate, groupIndex) => {
    const path = `groups[${groupIndex}]`;
    if (!isRecord(candidate)) {
      errors.push({ kind: 'shape', path, message: '必须是对象' });
      return;
    }
    const createdAt = num(candidate.createdAt);
    const updatedAt = num(candidate.updatedAt);
    const title = str(candidate.title);
    const id = str(candidate.id);
    if (!id) errors.push({ kind: 'shape', path: `${path}.id`, message: '缺少字符串 id' });
    if (title === undefined) errors.push({ kind: 'shape', path: `${path}.title`, message: '缺少字符串 title' });
    if (createdAt === undefined) errors.push({ kind: 'shape', path: `${path}.createdAt`, message: '缺少数字 createdAt' });
    if (!Array.isArray(candidate.tabs)) {
      errors.push({ kind: 'shape', path: `${path}.tabs`, message: '必须是数组' });
      return;
    }

    const tabs: SavedTab[] = [];
    candidate.tabs.forEach((tabCandidate, tabIndex) => {
      const tabPath = `${path}.tabs[${tabIndex}]`;
      if (!isRecord(tabCandidate)) {
        errors.push({ kind: 'shape', path: tabPath, message: '必须是对象' });
        return;
      }
      const url = str(tabCandidate.url);
      const tabCreatedAt = num(tabCandidate.createdAt);
      if (!url) {
        errors.push({ kind: 'shape', path: `${tabPath}.url`, message: '缺少字符串 url' });
        return;
      }
      if (tabCreatedAt === undefined) {
        errors.push({ kind: 'shape', path: `${tabPath}.createdAt`, message: '缺少数字 createdAt' });
        return;
      }
      const tabId = str(tabCandidate.id) ?? newId();
      const sortOrder = num(tabCandidate.sortOrder) ?? tabIndex;
      const restored: SavedTab = {
        id: tabId,
        // groupId 在 importBackup 里按归属重写，这里先占位
        groupId: id ?? '',
        url,
        title: str(tabCandidate.title) || url,
        createdAt: tabCreatedAt,
        sortOrder,
        // V1.0 的备份里没有这两个字段：originalIndex 用 sortOrder 顶上（当时的两者恒等），
        // originalPinned 只能填 false —— 旧版本压根不会收纳固定页。与存储层 v2 迁移同规则。
        originalIndex: num(tabCandidate.originalIndex) ?? sortOrder,
        originalPinned: tabCandidate.originalPinned === true,
        wasActive: tabCandidate.wasActive === true,
        closeState: closeStateOf(tabCandidate.closeState),
        // 既有约定：备份里没有 restorable 时按当前规则重算，而不是拒绝整份备份
        restorable:
          typeof tabCandidate.restorable === 'boolean'
            ? tabCandidate.restorable
            : isRestorableUrl(url),
      };
      const favicon = str(tabCandidate.faviconUrl);
      if (favicon) restored.faviconUrl = favicon;
      restored.domain = str(tabCandidate.domain) ?? domainOf(url) ?? undefined;
      tabs.push(restored);
    });

    if (errors.some((error) => error.kind === 'shape' && error.path.startsWith(`${path}.tabs[`))) return;

    groups.push({
      id: id ?? newId(),
      title: normalizeTitle(title ?? ''),
      createdAt: createdAt ?? Date.now(),
      updatedAt: updatedAt ?? createdAt ?? Date.now(),
      isPinned: candidate.isPinned === true,
      // 老备份没有这两个字段：没锁是安全默认，分类留空（=未分类）
      locked: candidate.locked === true,
      sortOrder: num(candidate.sortOrder) ?? groupIndex,
      tabs,
      ...(str(candidate.categoryId) === undefined
        ? {}
        : { categoryId: str(candidate.categoryId) }),
      ...(num(candidate.sourceWindowId) === undefined
        ? {}
        : { sourceWindowId: num(candidate.sourceWindowId) }),
    });
  });

  // 分类是 V1.2 才加的：老备份里根本没有这一段，缺失就当"全部未分类"，不报形状错。
  const categories: Category[] = Array.isArray(root.categories)
    ? root.categories.flatMap((candidate, index) => {
        if (!isRecord(candidate)) return [];
        const name = str(candidate.name);
        if (!name) return [];
        const createdAt = num(candidate.createdAt) ?? Date.now();
        return [
          {
            id: str(candidate.id) ?? newId(),
            name: normalizeCategoryName(name),
            sortOrder: num(candidate.sortOrder) ?? index,
            createdAt,
            updatedAt: num(candidate.updatedAt) ?? createdAt,
          },
        ];
      })
    : [];
  const knownCategories = new Set(categories.map((category) => category.id));

  if (errors.length > 0) return fail(errors);

  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: num(root.exportedAt) ?? Date.now(),
      // 指向本文件里不存在的分类的引用在这里就清掉：导入后不该出现"看不见的分类里有一批组"
      groups: groups.map((group) =>
        group.categoryId !== undefined && !knownCategories.has(group.categoryId)
          ? { ...group, categoryId: undefined }
          : group,
      ),
      categories,
      settings: mergeSettings(root.settings),
    },
  };
}

const CLOSE_STATES = ['closed', 'kept', 'failed', 'unknown'] as const;
function closeStateOf(value: unknown): SavedTab['closeState'] {
  return CLOSE_STATES.includes(value as (typeof CLOSE_STATES)[number])
    ? (value as SavedTab['closeState'])
    : 'unknown';
}

export function parseBackupJson(text: string): ValidateOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail([{ kind: 'invalid-json' }]);
  }
  return validateBackup(parsed);
}

/**
 * 追加导入（DATA-MODEL §8 的 V1 默认）。
 *
 * - **不覆盖**现有数据：全部作为新组追加。
 * - ID 冲突时重新生成 ID（组与 tab 都重生成 —— tab ID 也要换，否则
 *   moveTab / restoreTab 这类按 ID 定位的操作会命中错的记录）。
 * - 导入后重新计算 sortOrder（接到现有列表末尾）。
 * - 分类按**名字**合并：已有同名分类就归进去，不重复建（否则导入一次多一层"我的资料 (1)"）。
 * - 导入的组**不保留** `isPinned` 也不保留 `locked`：外来数据不该打乱用户的收藏区，
 *   更不该塞进一条"用户删不掉"的组。
 *
 * 没有"覆盖导入"：那需要一套合并规则来决定哪些算同一组，V1 不背这个复杂度。
 */
export async function importBackup(
  deps: { storage: StoragePort },
  backup: BackupFile,
  at: number = Date.now(),
): Promise<ImportResult> {
  const existing = await deps.storage.listGroupIndex();
  const takenIds = new Set<string>(existing.map((entry) => entry.id));
  for (const group of await deps.storage.listAllGroups()) takenIds.add(group.id);

  const existingCategories = await deps.storage.listCategories();
  const categories = [...existingCategories];
  const byName = new Map(categories.map((category) => [category.name.trim().toLowerCase(), category]));
  const categoryIdMap = new Map<string, string>();
  let categoriesImported = 0;

  for (const source of backup.categories ?? []) {
    const key = source.name.trim().toLowerCase();
    const match = byName.get(key);
    if (match) {
      categoryIdMap.set(source.id, match.id);
      continue;
    }
    let id = source.id;
    if (categories.some((category) => category.id === id)) id = newId();
    const created: Category = { ...source, id, sortOrder: nextCategorySortOrder(categories), updatedAt: at };
    categories.push(created);
    byName.set(key, created);
    categoryIdMap.set(source.id, id);
    categoriesImported += 1;
  }
  if (categoriesImported > 0) await deps.storage.setCategories(categories);

  // 导入的组排在**现有列表之后**（既有约定 第 6 条的"追加、不插队"）。
  // 列表是降序显示，所以"之后"= 更小的 sortOrder，从 tail 往**下**走。
  let base = tailSortOrder(existing);
  let tabsImported = 0;
  let idsRegenerated = 0;

  const entries: GroupIndexEntry[] = [...existing];

  for (const source of backup.groups) {
    let id = source.id;
    if (takenIds.has(id)) {
      id = newId();
      idsRegenerated += 1;
    }
    takenIds.add(id);
    const mappedCategory =
      source.categoryId === undefined ? undefined : categoryIdMap.get(source.categoryId);

    const group: TabGroup = {
      ...source,
      id,
      title: source.title,
      createdAt: source.createdAt,
      updatedAt: at,
      isPinned: false,
      locked: false,
      sortOrder: base--,
      categoryId: mappedCategory,
      tabs: renumberTabs(
        source.tabs.map((tab) => ({ ...tab, groupId: id, id: newId() })),
        id,
      ),
    };
    tabsImported += group.tabs.length;
    await deps.storage.putGroup(group);
    entries.push(toIndexEntry(group));
  }

  await deps.storage.replaceGroupIndex(entries);

  return {
    groupsImported: backup.groups.length,
    tabsImported,
    categoriesImported,
    idsRegenerated,
  };
}

/**
 * 触发下载。不依赖 downloads 权限（见文件头）。
 *
 * `mime` 有默认值，因为 V1.2 多了"导出为 HTML"这条本地分享路径——
 * 同一个下载器，两种载荷，不复制第二份实现。
 */
export function downloadFile(
  filename: string,
  contents: string,
  mime = 'application/json',
): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器来不及取数据，延一拍
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadBackup(filename: string, contents: string): void {
  downloadFile(filename, contents, 'application/json');
}

/** 文件名带导出日期，便于在同目录下区分多份备份。 */
export function backupFilename(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `shitab-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.json`;
}
