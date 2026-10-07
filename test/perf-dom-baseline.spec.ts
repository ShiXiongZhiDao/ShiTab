/**
 * 性能基线 · 界面侧（既有约定 决定 3 / 决定 8，既有约定 采纳 2 的 DOM 预算那一档）。
 *
 * 量的是**结构**：首屏挂了多少个元素节点、多少行记录、多少颗 favicon `<img>`。
 * 这几列与机器无关，可以直接和 既有约定 背景里那句"600 行 / 约 1.2 万元素节点 / ~1340 个 SVG"的
 * **估算**对账（对不上就要在文档里改估算，不许糊过去）。
 *
 * ⚠ 这里的 `ms` 只是 jsdom 的挂载耗时，**不是浏览器渲染实测**；
 *   浏览器那一档归"localhost 原型页"与他的真机清单（既有约定 决定 10 / 既有约定 采纳 2 的三类数字）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import Workbench from '@/entrypoints/app/App.vue';
import { COLLAPSED_TAB_LIMIT, TAB_EXPAND_BATCH } from '@/shared/constants';
import { RENDER_BATCH } from '@/composables/useGroups';
import { DISTRIBUTIONS, seedDistribution } from './perf-fixtures';

interface DOMShape {
  name: string;
  groups: number;
  tabsPerGroup: number;
  /** 挂出来的会话卡数 `[data-group-card]`（≤ RENDER_BATCH：分页游标先只给一批） */
  cards: number;
  /** 挂出来的记录行数 `[data-tab-row]` */
  rows: number;
  elements: number;
  svgs: number;
  /** favicon 的 `<img>` 颗数 —— 每一颗都是一次网络请求（既有约定 决定 7 的那一笔） */
  images: number;
  mountMsInMemory: number;
}

const REPORT: DOMShape[] = [];

type Mounted = ReturnType<typeof mount>;

/**
 * 挂载工作台并等 lazy 回源落齐。
 * ⚠ **不要在这里卸载**：`attachTo: document.body` 之后 `wrapper.element.remove()` 会把整棵树摘掉，
 *   那时再数节点就只剩 `<html>/<head>/<body>` 四颗 —— 第一版就这么错过了一次，靠"0 卡 / 4 节点"暴露。
 *   卸载统一交给 `afterEach`（那里清 `document.body`）。
 */
async function mountWorkbench(): Promise<Mounted> {
  const wrapper = mount(Workbench, { global: { plugins: [createPinia()] }, attachTo: document.body });
  // 每张卡的条目是挂载后 lazy 回源的（`useGroups.loadTabs`），要冲掉两轮微任务才落齐。
  await flushPromises();
  await flushPromises();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('[data-tab-row]').length, '至少有一行记录才说明回源完成了').toBeGreaterThan(0);
  });
  return wrapper;
}

function measure(name: string, distribution: { groups: number; tabsPerGroup: number }, mountMs: number): DOMShape {
  const rows = document.querySelectorAll('[data-tab-row]').length;
  const shape: DOMShape = {
    name,
    groups: distribution.groups,
    tabsPerGroup: distribution.tabsPerGroup,
    cards: document.querySelectorAll('[data-group-card]').length,
    rows,
    elements: document.querySelectorAll('*').length,
    svgs: document.querySelectorAll('svg').length,
    images: document.querySelectorAll('img').length,
    mountMsInMemory: mountMs,
  };
  REPORT.push(shape);
  return shape;
}

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  document.body.innerHTML = '';
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(() => Promise.resolve({ ok: true, value: true }) as never);
  vi.spyOn(fakeBrowser.windows, 'getCurrent').mockResolvedValue({ id: 7 } as never);
});

afterEach(() => {
  // 断言失败中途退出的用例也要把节点从 body 上摘掉，否则下一个用例量到的是上一档的形状。
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('性能基线 · 首屏 DOM 形状', () => {
  it.each([...DISTRIBUTIONS])('$name', async (distribution) => {
    const seeded = await seedDistribution(distribution);
    expect(seeded.totalTabs, '夹具的条数要和分布定义对得上').toBe(distribution.groups * distribution.tabsPerGroup);

    const started = Date.now();
    const wrapper = await mountWorkbench();
    const shape = measure(distribution.name, distribution, Date.now() - started);
    wrapper.unmount();

    /** 卡数受分页游标限制；行数受 `COLLAPSED_TAB_LIMIT` 与每组条数的较小值限制。 */
    expect(shape.cards).toBe(Math.min(RENDER_BATCH, distribution.groups));
    expect(shape.rows).toBe(Math.min(RENDER_BATCH, distribution.groups) * Math.min(COLLAPSED_TAB_LIMIT, distribution.tabsPerGroup));
    /** 既有约定 决定 7 的病：一行一颗 favicon，没有 `loading="lazy"`。 */
    expect(shape.images).toBe(shape.rows);
  }, 60_000);

  /**
   * ★ 一次摊全表，没有分批 —— 这就是 既有约定 采纳 1 说的那格缺口的**机制**。
   *
   * 门槛里只跑 300 条那一档（jsdom 挂 3,000 行要 9 秒，会把 `pnpm verify` 拖成 flaky 的温床），
   * 3,000 那一档用环境变量开：`SHITAB_PERF_HEAVY=1 npx vitest run test/perf-dom-baseline.spec.ts`。
   * 两档测的是同一件事：`shown` 在点下去之后等于**整表**，不是一批。
   */
  const EXPAND_CASES = [
    { label: '单组 300 条', tabsPerGroup: 300 },
    ...(process.env.SHITAB_PERF_HEAVY === '1' ? [{ label: '单组 3,000 条（重测）', tabsPerGroup: 3_000 }] : []),
  ];


  it.each(EXPAND_CASES)('展开其余 $label：一次点一批，摊到 200 为止', async ({ label, tabsPerGroup }) => {
    const distribution = { groups: 1, tabsPerGroup };
    await seedDistribution(distribution);
    const wrapper = await mountWorkbench();

    const before = document.querySelectorAll('[data-tab-row]').length;
    const button = [...document.querySelectorAll('button')].find((node) =>
      /Show\s*\d+\s*more tabs/.test(node.textContent ?? ''),
    );
    expect(button, `默认折叠时必须出现"Show ${tabsPerGroup - COLLAPSED_TAB_LIMIT} more tabs"那颗按钮`).toBeTruthy();

    const started = Date.now();
    button?.click();
    await flushPromises();
    await flushPromises();
    const ms = Date.now() - started;

    const after = document.querySelectorAll('[data-tab-row]').length;
    const elements = document.querySelectorAll('*').length;
    const images = document.querySelectorAll('img').length;
    /* eslint-disable no-console */
    console.log(
      `[expand] ${label}：折叠 ${before} 行 → 展开 ${after} 行；元素节点 ${elements}；favicon ${images} 颗；` +
        `jsdom 内 ${ms} ms（**不是浏览器实测**）`,
    );
    /* eslint-enable no-console */

    /** 折叠那一档确实是 `COLLAPSED_TAB_LIMIT` 行 */
    expect(before).toBe(COLLAPSED_TAB_LIMIT);
    /**
     * ★ 既有约定 采纳 1 落地之后的断言：一次点击只摊**一批**（`TAB_EXPAND_BATCH` = 200）。
     *   改之前的实测（同一条用例、同一批夹具）：一次点下去 300 条档摊出 300 行、
     *   3,000 条档摊出 3,000 行 / 63,127 个元素节点。⚠ 这条不许删，也不许把批次调大来"让它继续绿"。
     */
    expect(after).toBe(COLLAPSED_TAB_LIMIT + TAB_EXPAND_BATCH);
    expect(after).toBeLessThan(tabsPerGroup);
    /** 最后一批可能不足一批：连点到位之后剩下的那条按钮换成"收起"，且行数正好等于整表。 */
    let clicks = 1;
    while (clicks < 40) {
      const next = [...document.querySelectorAll('button')].find((node) =>
        /Show\s*\d+\s*more tabs/.test(node.textContent ?? ''),
      );
      if (!next) break;
      next.click();
      await flushPromises();
      await flushPromises();
      clicks += 1;
    }
    expect(document.querySelectorAll('[data-tab-row]').length, '摊到底就是整表').toBe(tabsPerGroup);
    const collapse = [...document.querySelectorAll('button')].find((node) => (node.textContent ?? '').includes('Collapse'));
    expect(collapse, '摊到底之后那颗按钮应当变成"收起"').toBeTruthy();
    collapse?.click();
    await flushPromises();
    expect(document.querySelectorAll('[data-tab-row]').length, '收回折叠态').toBe(COLLAPSED_TAB_LIMIT);
    /** 一行一颗 favicon（既有约定 决定 7 那一笔）：数的是**已摊开**的那些行。 */
    expect(images, 'favicon 颗数应当等于已渲染的行数').toBe(after);
    wrapper.unmount();
  }, 30_000);

  it('把各档的测量结果汇总打印出来（基线报告的数据源）', () => {
    if (REPORT.length === 0) throw new Error('前面的用例没跑，汇总不了 —— 这个文件不许单独跑');
    /* eslint-disable no-console */
    console.table(REPORT);
    const a2 = REPORT.find((item) => item.name.startsWith('A2'));
    if (a2) {
      console.log(
        `[对账] A2 档（${a2.cards} 卡 × ${a2.rows / a2.cards} 行）实测：元素节点 ${a2.elements}、SVG ${a2.svgs}、` +
          `favicon ${a2.images} —— 既有约定 背景里那句估算是"600 行 / 约 1.2 万节点 / ~1340 SVG"。`,
      );
    }
    /* eslint-enable no-console */
    expect(REPORT.length).toBeGreaterThanOrEqual(DISTRIBUTIONS.length);
  });
});
