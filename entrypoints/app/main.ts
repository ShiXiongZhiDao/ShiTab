import { createApp } from 'vue';
import App from './App.vue';
import { installApp } from '@/shared/app';
import { t } from '@/shared/i18n';

/**
 * 标签页标题走 i18n。
 *
 * `<title>` 不支持 `__MSG_` 替换（那是 manifest 才有的机制），所以 HTML 里留一份英文兜底，
 * 页面一起来就用 extensionName 覆写 —— 品牌字仍然只在两份 `_locales` 文案里定义一次。
 * 上一轮改名漏掉的正是这两个 HTML：扫描只覆盖了 ts/vue/json 三类载体。
 */
document.title = t('extensionName');

installApp(createApp(App)).mount('#app');
