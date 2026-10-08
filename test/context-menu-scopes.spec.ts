/**
 * 收纳范围与右键菜单注册表的判据。
 *
 * 这一层全是纯函数与常量，所以这里测的是**判据本身**；
 * "点下去真的走到哪"归 `test/background.spec.ts` 那组路由用例。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_MENU_TOP_LEVEL_LIMIT,
  MENU_ENTRIES,
  menuEntryOf,
  selectScopeTabs,
} from '@/core/application/capture-scopes';
import { escapeMenuTitle } from '@/infrastructure/browser/browser-context-menus';
import type { BrowserTab } from '@/shared/types';

/** 一条最小可用的活标签。`index` 与数组位置**故意分开传**，好测那条判据取的是哪一个。 */
function tab(id: number, index: number, extra: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    windowId: 1,
    url: `https://a.test/${id}`,
    title: `T${id}`,
    active: false,
    pinned: false,
    index,
    ...extra,
  };
}

// 11 锚点在第 2 格（0 号位是钉住的入口页，3 号位是活动页）
const T = tab(10, 0, { pinned: true });
const ANCHOR = tab(11, 1);
const MID = tab(12, 2);
const ACTIVE = tab(13, 3, { active: true });
const TAIL = tab(14, 4);
const ROW = [T, ANCHOR, MID, ACTIVE, TAIL];

const ids = (tabs: BrowserTab[]) => tabs.map((item) => item.id);

describe('selectScopeTabs：四个范围各自的集合', () => {
  it('window = 整窗，锚点在不在都无所谓', () => {
    expect(ids(selectScopeTabs(ROW, ANCHOR.id, 'window'))).toEqual([10, 11, 12, 13, 14]);
    expect(ids(selectScopeTabs(ROW, 999, 'window'))).toEqual([10, 11, 12, 13, 14]);
  });

  it('except-current 只去掉锚点那一条，其余四条都在（含活动页与固定页）', () => {
    expect(ids(selectScopeTabs(ROW, ANCHOR.id, 'except-current'))).toEqual([10, 12, 13, 14]);
  });

  // 左右是**对称判据**：只测一侧的话，把其中一条写反（`<` 写成 `>`）测试照样绿。
  it('left = 锚点**左侧**，不含锚点自己', () => {
    expect(ids(selectScopeTabs(ROW, MID.id, 'left'))).toEqual([10, 11]);
  });

  it('right = 锚点**右侧**，不含锚点自己', () => {
    expect(ids(selectScopeTabs(ROW, MID.id, 'right'))).toEqual([13, 14]);
  });

  it('两端各一条边界：最左的左边是空，最右的右边是空', () => {
    expect(selectScopeTabs(ROW, T.id, 'left')).toEqual([]);
    expect(selectScopeTabs(ROW, TAIL.id, 'right')).toEqual([]);
  });

  it('判据取浏览器的 index，不取数组下标', () => {
    // 同一批标签，数组顺序被打乱（适配器理论上按 index 返回，但这条钉的是"我们读哪个字段"）
    const shuffled = [ACTIVE, T, TAIL, MID, ANCHOR];
    expect(ids(selectScopeTabs(shuffled, MID.id, 'left'))).toEqual([10, 11]);
    expect(ids(selectScopeTabs(shuffled, MID.id, 'right'))).toEqual([13, 14]);
  });

  it('锚点已经不在了 ⇒ 三个靠锚点的范围全为空，绝不退化成整窗', () => {
    // 退化成整窗会把用户**没点**的标签关掉，那是最不该猜的一种情况。
    for (const scope of ['except-current', 'left', 'right'] as const) {
      expect(selectScopeTabs(ROW, 999, scope), `${scope} 在锚点缺失时不该返回东西`).toEqual([]);
    }
  });
});

describe('菜单注册表（既有约定 决定 2 / 4）', () => {
  const zh = JSON.parse(
    readFileSync(join(process.cwd(), 'public', '_locales', 'zh_CN', 'messages.json'), 'utf8'),
  ) as Record<string, { message: string }>;
  const en = JSON.parse(
    readFileSync(join(process.cwd(), 'public', '_locales', 'en', 'messages.json'), 'utf8'),
  ) as Record<string, { message: string }>;

  it('顶层项没撞上工具栏那 6 格上限', () => {
    // 撞上之后平台的行为是**静默丢弃**，所以这条红必须发生在提交前，而不是在用户的右键里。
    expect(MENU_ENTRIES.length).toBeLessThanOrEqual(ACTION_MENU_TOP_LEVEL_LIMIT);
    expect(ACTION_MENU_TOP_LEVEL_LIMIT).toBe(6);
  });

  it('id 不重复，且每项都能在表里查到（menuEntryOf 的反向对照）', () => {
    const seen = new Set(MENU_ENTRIES.map((entry) => entry.id));
    expect(seen.size).toBe(MENU_ENTRIES.length);
    for (const entry of MENU_ENTRIES) {
      expect(menuEntryOf(entry.id), `${entry.id} 查不到`).toBe(entry);
    }
    // 正向对照：查不存在的 id 必须是 undefined，否则"没注册过的 id"那条守卫是假的
    expect(menuEntryOf('not-a-menu-item')).toBeUndefined();
  });

  it('六项的标题在两份文案里都有，且中英都不是空串', () => {
    for (const entry of MENU_ENTRIES) {
      const zhMessage = zh[entry.titleKey]?.message;
      const enMessage = en[entry.titleKey]?.message;
      expect(zhMessage, `zh_CN 缺 ${entry.titleKey}`).toBeDefined();
      expect(enMessage, `en 缺 ${entry.titleKey}`).toBeDefined();
      expect(zhMessage?.trim(), `${entry.titleKey} 的中文是空串`).not.toBe('');
      expect(enMessage?.trim(), `${entry.titleKey} 的英文是空串`).not.toBe('');
    }
  });

  it('「打开工作台」是唯一不关标签的那一项，其余五项都会写会话', () => {
    // 这条是**操作顺序**判据：真机清单里要先点这一项，再点会关标签的那些。
    const readOnly = MENU_ENTRIES.filter((entry) => entry.action.kind === 'open-workbench');
    expect(readOnly.map((entry) => entry.id)).toEqual(['open-workbench']);
    expect(MENU_ENTRIES.filter((entry) => entry.action.kind !== 'open-workbench')).toHaveLength(5);
  });

  it('现有六项文案里没有裸 &，转义是防以后加（不是现在就在改东西）', () => {
    for (const entry of MENU_ENTRIES) {
      // 存在性由上一条钉；这里 ?? '' 只是给 TS 的可选索引收口
      expect(en[entry.titleKey]?.message ?? '', entry.id).not.toContain('&');
      expect(zh[entry.titleKey]?.message ?? '', entry.id).not.toContain('&');
    }
  });
});

describe('escapeMenuTitle（既有约定 补充格 A10）', () => {
  it('每个 & 都变成 &&，其余字符一字不动', () => {
    expect(escapeMenuTitle('A & B')).toBe('A && B');
    expect(escapeMenuTitle('R&D && more')).toBe('R&&D &&&& more');
    expect(escapeMenuTitle('收纳此窗口的所有标签')).toBe('收纳此窗口的所有标签');
  });
});
