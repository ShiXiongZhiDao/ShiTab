import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import Vue from '@vitejs/plugin-vue';

// WxtVitest 提供：auto-imports（browser / storage / defineBackground 等）、
// tsconfig 路径别名、扩展 API mock。核实自 node_modules/wxt/dist/testing/
// wxt-vitest-plugin.mjs —— 它**不包含** vue 插件，所以 .vue 的编译要显式加。
export default defineConfig({
  plugins: [WxtVitest(), Vue()],
  test: {
    globals: false,
    environment: 'jsdom',
    include: ['test/**/*.spec.ts', 'test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // ★ 默认超时 5s → 20s（2026-10-18）。证据是连跑三轮全量（44 文件并行），**每轮各撞一条
    //   不同的 UI 用例**、全是 5 秒超时、隔离重跑全绿：ui-components「超过一批…」(480 行)、
    //   ui-trash-panel「还原其中一条」(230+1 行) 与「超过一屏…」(430+230 行那一族的邻居)。
    //   根因是这一类 DOM 用例（jsdom 挂几百行 + Vue 编译）在满载下系统性超过 5s，逐条补
    //   `}, 20_000)` 是打地鼠 —— 本仓早有单条 20s 的先例，只是没盖全。
    //   代价说清：真挂死的用例从 5s 才报变成 20s 才报；认了 —— 发版轮 release.yml 要跑
    //   pnpm test，一个 flake 就是一发生产发布红，那比"死得快"贵。
    //   单条上已有的 `}, 20_000)` 保留：它们标记"这一条格外重"，与全局线同档不冲突。
    testTimeout: 20_000,
  },
});
