import { createApp } from 'vue';
import App from './App.vue';
import { installApp } from '@/shared/app';
import { t } from '@/shared/i18n';

/** 标题走 i18n，理由同 app 入口：`<title>` 吃不到 `__MSG_`，品牌只在 `_locales` 定义一处。 */
document.title = t('options_title');

installApp(createApp(App)).mount('#app');
