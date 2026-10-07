/**
 * 两份"口径"测试：拖拽载荷的防御解码 + 结果计数的互斥且穷尽。
 *
 * 计数口径是术语表里定的产品契约（glossary「结果计数口径」）：
 * 每条被处理的 tab 必须落进且只落进一个桶。它错了不会让任何单个功能坏掉，
 * 只会让用户看到"已存 8 · 已关 5 · 保留 2"这种加起来对不上的话 —— 所以必须用矩阵钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  CAT_MIME,
  decodeCategory,
  decodeGroup,
  decodeTab,
  encode,
  GROUP_MIME,
  TAB_MIME,
} from '@/shared/dnd';
import { captureWindow } from '@/core/application/capture-window';
import { restoreGroup } from '@/core/application/restore-group';
import { createFakeBrowserTabsPort, FAKE_EXTENSION_ORIGIN } from '@/infrastructure/testing/fake-browser-tabs';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import type { EntryTabPort } from '@/core/ports/entry-tab';
import type { SavedTab, Settings } from '@/shared/types';

const ENTRY_URL = `${FAKE_EXTENSION_ORIGIN}/app.html?entry=pinned-tab`;
const AT = 1_700_000_000_000;

const alwaysLanding: EntryTabPort = { ensureForWindow: async () => true };

// ---------------------------------------------------------------------------
// 拖拽载荷
// ---------------------------------------------------------------------------

describe('dnd 解码', () => {
  it('我们的载荷能往返', () => {
    expect(decodeGroup(encode({ groupId: 'g1' }))).toEqual({ groupId: 'g1' });
    expect(decodeTab(encode({ tabId: 't1', groupId: 'g1' }))).toEqual({ tabId: 't1', groupId: 'g1' });
    expect(decodeCategory(encode({ categoryId: 'c1' }))).toEqual({ categoryId: 'c1' });
  });

  /**
   * 下面每一种都对应一次真实的桌面拖放：用户把文件、图片、选中的文字拖进工作台。
   * 解码必须安静地返回 undefined，而不是抛错打断 drop 或凭空造出一条移动。
   */
  it.each([
    ['null（什么都没带）', null],
    ['空串', ''],
    ['不是 JSON', 'C:\\Users\\me\\Desktop.pdf'],
    ['选中的纯文字', '一段选中的文字'],
    ['数组', '[1,2,3]'],
    ['形状不对的对象', '{"foo":"bar"}'],
    ['只有 tabId 没有 groupId', '{"tabId":"t1"}'],
    ['数字载荷', '42'],
  ])('decodeGroup 对%s 返回 undefined', (_label, raw) => {
    expect(decodeGroup(raw)).toBeUndefined();
    expect(decodeTab(raw)).toBeUndefined();
    expect(decodeCategory(raw)).toBeUndefined();
  });

  it('组载荷与 tab 载荷互不认领（放错位置就不动）', () => {
    expect(decodeTab(encode({ groupId: 'g1' }))).toBeUndefined();
    expect(decodeGroup(encode({ tabId: 't1', groupId: 'g1' }))).toEqual({ groupId: 'g1' });
  });

  /**
   * 分类载荷与另外两种**必须**互不认领，这是 既有约定 里最贵的一条：
   * 同一次 drop 在分类行上既可能是"归类"也可能是"排序"，认错了就会把用户的会话搬走。
   */
  it('分类载荷只认领 categoryId', () => {
    expect(decodeCategory(encode({ groupId: 'g1' }))).toBeUndefined();
    expect(decodeCategory(encode({ tabId: 't1', groupId: 'g1' }))).toBeUndefined();
    expect(decodeGroup(encode({ categoryId: 'c1' }))).toBeUndefined();
    // 同时带两种 id 的畸形载荷不能被分类解码认领成"半个排序"
    expect(decodeCategory('{"categoryId":"c1","groupId":"g1"}')).toEqual({ categoryId: 'c1' });
  });

  it('三种 MIME 是分开的键，不会互相覆盖', () => {
    expect(new Set([GROUP_MIME, TAB_MIME, CAT_MIME]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 计数口径
// ---------------------------------------------------------------------------

type Shape = { id: number; url: string; active?: boolean; pinned?: boolean };

async function runCapture(windows: Shape[], overrides: Partial<Settings>) {
  const storage = createStoragePort();
  await storage.setSettings({ ...(await storage.getSettings()), ...overrides });
  const tabs = createFakeBrowserTabsPort({ windows: [{ id: 1, tabs: windows }] });
  const outcome = await captureWindow({ tabs, storage, entry: alwaysLanding }, { windowId: 1, at: AT });
  if (!outcome.ok) throw new Error('这批数据应该能收纳');
  return { storage, tabs, result: outcome.result };
}

describe('收纳计数：saved === closed + kept + failed', () => {
  const shapes: Array<[string, Shape[]]> = [
    ['三个普通页，一个是活动页', [
      { id: 1, url: 'https://a.test/1', active: true },
      { id: 2, url: 'https://a.test/2' },
      { id: 3, url: 'https://a.test/3' },
    ]],
    ['含固定页与内部页与工作台', [
      { id: 1, url: 'https://a.test/1', active: true },
      { id: 2, url: 'chrome://extensions' },
      { id: 3, url: 'https://mail.google.com', pinned: true },
      { id: 4, url: ENTRY_URL, pinned: true },
    ]],
    ['两条同 URL（快照不能互相顶替）', [
      { id: 1, url: 'https://a.test/dup', active: true },
      { id: 2, url: 'https://a.test/dup' },
    ]],
  ];

  const settingsMatrix: Array<[string, Partial<Settings>]> = [
    ['默认：全关', {}],
    ['保留活动页', { keepActiveTab: true }],
    ['只存不关', { closeAfterCapture: false }],
    ['固定页也收', { includePinnedTabs: true }],
  ];

  for (const [shapeLabel, shape] of shapes) {
    for (const [settingsLabel, overrides] of settingsMatrix) {
      it(`${shapeLabel} × ${settingsLabel}`, async () => {
        const { result } = await runCapture(shape, overrides);

        expect(result.saved).toBe(result.closed + result.kept + result.failed);
        expect(result.savedTabs).toHaveLength(result.saved);
        // 工作台自己永远不进 saved
        expect(result.savedTabs.map((tab) => tab.url)).not.toContain(ENTRY_URL);
        // closableTabIds 只能来自真的被关掉的那些（撤销靠它）
        const closedIds = result.savedTabs
          .filter((tab) => tab.closeState === 'closed')
          .map((tab) => tab.id);
        expect(closedIds).toHaveLength(result.closed);
        expect(result.closableTabIds).toHaveLength(result.closed);
      });
    }
  }
});

describe('恢复计数：restored + skipped + failed === 组内条目数', () => {
  async function restore(over: { tabs: Array<Partial<SavedTab> & { url: string }>; existing?: string[]; unopenable?: string[] }) {
    const storage = createStoragePort();
    const tabs = createFakeBrowserTabsPort({
      windows: [
        { id: 1, tabs: [{ id: 91, url: 'https://a.test/1', active: true }] },
        { id: 2, tabs: (over.existing ?? []).map((url, index) => ({ id: 800 + index, url })) },
      ],
      unopenableUrls: over.unopenable,
    });
    const group = {
      id: 'g1',
      title: '待恢复',
      createdAt: AT,
      updatedAt: AT,
      isPinned: false,
      locked: false,
      sortOrder: 0,
      tabs: over.tabs.map((tab, index) => ({
        id: `t${index}`,
        groupId: 'g1',
        url: tab.url,
        title: tab.url,
        createdAt: AT,
        sortOrder: index,
        originalIndex: index,
        originalPinned: false,
        wasActive: false,
        closeState: 'closed' as const,
        restorable: tab.restorable ?? true,
      })),
    };
    await storage.putGroup(group);
    return restoreGroup({ storage, tabs }, { groupId: 'g1', windowId: 2 });
  }

  it('混合：正常页 + 已开着 + 不可恢复 + 打不开', async () => {
    const result = await restore({
      tabs: [
        { url: 'https://a.test/new' },
        { url: 'https://a.test/open' },
        { url: 'chrome://settings', restorable: false },
        { url: 'https://boom.test/x' },
      ],
      existing: ['https://a.test/open'],
      unopenable: ['https://boom.test/x'],
    });

    expect(result.restored + result.skipped + result.failed).toBe(4);
    expect(result).toMatchObject({ restored: 1, skipped: 2, failed: 1 });
    // skipped 与 failed 的名单不能串（glossary：两者的措辞和颜色必须不同）
    expect(result.skippedUrls).toEqual(expect.arrayContaining(['chrome://settings', 'https://a.test/open']));
    expect(result.failedUrls).toEqual(['https://boom.test/x']);
  });

  it('空组恢复给出全零而不是抛错', async () => {
    const result = await restore({ tabs: [] });
    expect(result).toMatchObject({ restored: 0, skipped: 0, failed: 0 });
  });
});
