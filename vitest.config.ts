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
  },
});
