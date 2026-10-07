import { createPinia } from 'pinia';
import type { App } from 'vue';
import '@/assets/styles/shitab.css';

/**
 * 两个 UI surface（工作台 app.html / options.html）共用的挂载前置。
 *
 * Pinia 只装 UI/session 状态（快照、选中态、搜索词、toast 计时）。
 * 业务数据的真相在 StoragePort 后面，不在 store 里。
 */
export function installApp(app: App): App {
  app.use(createPinia());
  return app;
}
