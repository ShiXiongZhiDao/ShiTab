<script lang="ts" setup>
/**
 * 设置页外壳。
 *
 * 形状：**左侧分区导航 + 右侧一次一个分区**。之前是 8 张卡一列到底（实测 1488px），
 * 而这次要加的公众号/赞助二维码自己就有 891px —— 再往下接就是 2393px。
 * 换成导航之后整页最高 656px，而且**以后加分区不再让页面变长**。
 *
 * 分区的依据是"用户来这儿想干什么"，不是"代码里有几个面板"：
 * 常规（收纳 + 入口 T + 那句恢复说明）/ 外观 / 数据 / 同步 / 关于。
 * 原来那张只有说明、0 个控件的「恢复」卡不再占一张卡，那句话挪到常规分区底部。
 *
 * 三件事别在下次"再简化一点"时弄丢：
 * 1. **`SyncPanel` 与 `SnapshotHistoryPanel` 的内部结构一个字没动**，只是被搬进「同步」分区。
 *    它们的用例各自独立 `mount()`（`test/ui-sync-panel.spec.ts`、`test/ui-history-panel.spec.ts`），
 *    所以这一页怎么重排都不该弄红它们 —— 真红了就说明改到面板内部了。
 * 2. **版本号只有一个来源**：这里读 manifest，不写字面量。
 *    `test/search-and-backup.spec.ts` 那两条守卫盯的就是这一页。
 * 3. **分区写进 URL hash**，所以「打开设置页的同步那一节」是可以直接发给别人的链接，
 *    后退键也能退回上一个分区。工作台那颗同步异常 pill 将来要直达某节，改一行就行。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import AboutPanel from '@/components/AboutPanel.vue';
import AppIcon from '@/components/AppIcon.vue';
import PaneHeader from '@/components/PaneHeader.vue';
import ResultToast from '@/components/ResultToast.vue';
import SettingRow from '@/components/SettingRow.vue';
import SettingSegment, { type SegmentOption } from '@/components/SettingSegment.vue';
import SettingSwitch from '@/components/SettingSwitch.vue';
import SnapshotHistoryPanel from '@/components/SnapshotHistoryPanel.vue';
import SyncPanel from '@/components/SyncPanel.vue';
import { useGroups } from '@/composables/useGroups';
import { useLocale } from '@/composables/useLocale';
import { useTheme } from '@/composables/useTheme';
import { storagePort } from '@/shared/services';
import { startSyncHeartbeat } from '@/shared/sync-heartbeat';
import { t, type MessageKey } from '@/shared/i18n';
import { TRASH_RETENTION_MS } from '@/shared/constants';
import type { LocaleChoice, Settings, Theme } from '@/shared/types';

const store = useGroups();
const theme = useTheme();
const locale = useLocale();
const settings = ref<Settings | null>(null);
const file = ref<HTMLInputElement | null>(null);
const lastExport = ref('—');
/** 版本读 manifest，不在这里手写第二遍。导航底部那一行是给人截图报障用的。 */
const version = `v${browser.runtime.getManifest().version}`;

/* ── 分区导航 ─────────────────────────────────────────────── */

const PANE_IDS = ['general', 'appearance', 'data', 'sync', 'about'] as const;
type PaneId = (typeof PANE_IDS)[number];
/** 只列这一页真用到的四颗；类型是 `AppIcon` 那套名字的字面量子集，写错编译就红。 */
type PaneIcon = 'settings' | 'sun' | 'folder' | 'cloud' | 'star';

const PANES: readonly { id: PaneId; labelKey: MessageKey; icon: PaneIcon }[] = [
  { id: 'general', labelKey: 'options_nav_general', icon: 'settings' },
  // 外观与数据的分区名直接复用已有的 `*_section`，同一个词不在两份目录里各写一遍。
  { id: 'appearance', labelKey: 'options_appearance_section', icon: 'sun' },
  { id: 'data', labelKey: 'options_data_section', icon: 'folder' },
  { id: 'sync', labelKey: 'options_nav_sync', icon: 'cloud' },
  { id: 'about', labelKey: 'options_nav_about', icon: 'star' },
];

function paneFromHash(): PaneId {
  const raw = location.hash.replace(/^#/, '');
  return (PANE_IDS as readonly string[]).includes(raw) ? (raw as PaneId) : 'general';
}

const pane = ref<PaneId>(paneFromHash());

function go(next: PaneId): void {
  if (pane.value === next) return;
  pane.value = next;
  // 写 hash 而不是 replaceState：后退键就该退回上一个分区
  location.hash = next;
}

function onHashChange(): void {
  pane.value = paneFromHash();
}

/* ── 设置项 ───────────────────────────────────────────────── */

let stopHeartbeat: (() => void) | undefined;

onMounted(async () => {
  // 设置页是「刚配好同步、正等着看结果」的那个页面 ⇒ 同样要有节拍
  stopHeartbeat = startSyncHeartbeat();
  window.addEventListener('hashchange', onHashChange);
  await theme.init();
  await locale.init();
  settings.value = await storagePort.getSettings();
  storagePort.watchSettings((next) => {
    settings.value = next;
  });
  const meta = await storagePort.getMeta();
  lastExport.value = meta.lastExportAt ? new Date(meta.lastExportAt).toLocaleString() : '—';
});

onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
  stopHeartbeat?.();
  stopHeartbeat = undefined;
});

async function patch(over: Partial<Settings>): Promise<void> {
  if (!settings.value) return;
  const next = { ...settings.value, ...over };
  settings.value = next;
  await storagePort.setSettings(next);
}

/**
 * 依赖项的副标题：能用的时候说它做什么，不能用的时候说**为什么不能用**。
 *
 * 原来只是 `:disabled` 一挂、什么都不讲，用户看不出这两项有关 ——
 * 而"我点了没反应"和"这项现在不该有反应"是两种完全不同的投诉。
 */
function hint(own: MessageKey, blocked: boolean): string {
  return blocked ? t('options_dependency_hint') : t(own);
}

const themeOptions: SegmentOption[] = [
  { value: 'system', label: t('options_theme_system') },
  { value: 'light', label: t('options_theme_light') },
  { value: 'dark', label: t('options_theme_dark') },
];
const localeOptions: SegmentOption[] = [
  { value: 'system', label: t('options_language_system') },
  { value: 'zh_CN', label: '中文' },
  { value: 'en', label: 'English' },
];

/** 回收站留几天从常量算，别把 7 写进文案里：改了常量这句话会跟着变。 */
const trashDays = String(Math.round(TRASH_RETENTION_MS / 86_400_000));

async function onPickFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const chosen = input.files?.[0];
  if (!chosen) return;
  await store.importFile(await chosen.text());
  input.value = '';
}
</script>

<template>
  <div class="min-h-screen bg-bg text-ink">
    <div class="mx-auto flex max-w-[916px] flex-col gap-5 px-5 py-8 md:flex-row md:items-start">
      <!-- 导航。品牌与版本住在这里，所以每个分区都不必再挂一行页头（省下 134px 的那一笔）。 -->
      <aside class="w-full shrink-0 md:w-[196px]">
        <div class="rounded-card border border-line bg-panel p-3.5 md:sticky md:top-8">
          <div class="mb-2 flex items-center gap-2.5 border-b border-line px-1.5 pb-3">
            <div class="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-tight bg-brand text-[15px] font-extrabold text-brand-contrast">T</div>
            <div class="min-w-0">
              <p class="m-0 truncate text-[13px] font-extrabold tracking-tight">{{ t('brandName') }}</p>
              <p class="m-0 text-[10.5px] text-muted">{{ t('options_subtitle') }}</p>
            </div>
          </div>

          <nav class="flex flex-wrap gap-0.5 md:flex-col" :aria-label="t('options_title')">
            <button
              v-for="item in PANES"
              :key="item.id"
              :aria-current="pane === item.id ? 'true' : undefined"
              :class="pane === item.id
                ? 'bg-brand-soft font-extrabold text-brand'
                : 'text-muted hover:bg-chip hover:text-ink'"
              class="flex items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-2 text-left text-[12.5px] font-semibold transition-colors"
              :data-testid="`nav-${item.id}`"
              type="button"
              @click="go(item.id)"
            >
              <AppIcon :name="item.icon" :size="15" />
              <span>{{ t(item.labelKey) }}</span>
            </button>
          </nav>

          <div class="mt-2.5 border-t border-line px-2.5 pt-2.5 text-[10.5px] leading-relaxed text-muted">
            {{ version }} · {{ t('options_local_only') }}
          </div>
        </div>
      </aside>

      <!-- 交叉淡入淡出的容器（既有约定 补格三）：`relative` 是给离场那一屏当定位祖先，
           它撤出文档流之后要叠在**同一块地方**才叫交叉，不然淡出期间会空出一屏高。 -->
      <main class="relative min-w-0 flex-1">
        <Transition name="tn-fade">
          <!-- :key 一换，Vue 就把整屏当"旧元素离场 + 新元素入场"来处理 ⇒ 两屏同时在场。
               语义状态（哪一屏、aria-current、URL hash）全部由 `pane` 这个 ref 直接驱动，
               **没有任何一处挂在 transitionend 上** —— 连点导航打断动画时，落点仍然是对的。 -->
          <div :key="pane">
          <!-- ══ 常规 ══ -->
          <template v-if="pane === 'general'">
            <PaneHeader :sub="t('options_general_sub')" :title="t('options_nav_general')" />

            <section class="mb-3.5 rounded-card border border-line bg-panel p-5">
              <h3 class="m-0 mb-1 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_capture_section') }}</h3>
              <SettingRow :title="t('options_close_after_capture')">
                <SettingSwitch
                  :checked="settings?.closeAfterCapture === true"
                  :label="t('options_close_after_capture')"
                  test-id="set-close-after-capture"
                  @toggle="patch({ closeAfterCapture: !(settings?.closeAfterCapture ?? false) })"
                />
              </SettingRow>
              <SettingRow
                :disabled="settings?.closeAfterCapture === false"
                :hint="hint('options_keep_active_tab_hint', settings?.closeAfterCapture === false)"
                :title="t('options_keep_active_tab')"
              >
                <SettingSwitch
                  :checked="settings?.keepActiveTab === true"
                  :disabled="settings?.closeAfterCapture === false"
                  :label="t('options_keep_active_tab')"
                  test-id="set-keep-active-tab"
                  @toggle="patch({ keepActiveTab: !(settings?.keepActiveTab ?? false) })"
                />
              </SettingRow>
              <SettingRow :title="t('options_include_pinned_tabs')">
                <SettingSwitch
                  :checked="settings?.includePinnedTabs === true"
                  :label="t('options_include_pinned_tabs')"
                  test-id="set-include-pinned"
                  @toggle="patch({ includePinnedTabs: !(settings?.includePinnedTabs ?? false) })"
                />
              </SettingRow>
            </section>

            <section class="mb-3.5 rounded-card border border-line bg-panel p-5">
              <h3 class="m-0 mb-1 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_entry_section') }}</h3>
              <SettingRow :title="t('options_pinned_entry_enabled')">
                <SettingSwitch
                  :checked="settings?.pinnedEntryEnabled === true"
                  :label="t('options_pinned_entry_enabled')"
                  test-id="set-pinned-entry"
                  @toggle="patch({ pinnedEntryEnabled: !(settings?.pinnedEntryEnabled ?? false) })"
                />
              </SettingRow>
              <SettingRow
                :disabled="settings?.pinnedEntryEnabled === false"
                :hint="settings?.pinnedEntryEnabled === false ? t('options_dependency_hint') : undefined"
                :title="t('options_auto_restore_pinned_tab')"
              >
                <SettingSwitch
                  :checked="settings?.autoRestorePinnedTab === true"
                  :disabled="settings?.pinnedEntryEnabled === false"
                  :label="t('options_auto_restore_pinned_tab')"
                  test-id="set-auto-restore-entry"
                  @toggle="patch({ autoRestorePinnedTab: !(settings?.autoRestorePinnedTab ?? false) })"
                />
              </SettingRow>
              <SettingRow
                :disabled="settings?.pinnedEntryEnabled === false"
                :hint="settings?.pinnedEntryEnabled === false ? t('options_dependency_hint') : undefined"
                :title="t('options_keep_pinned_tab_first')"
              >
                <SettingSwitch
                  :checked="settings?.keepPinnedTabFirst === true"
                  :disabled="settings?.pinnedEntryEnabled === false"
                  :label="t('options_keep_pinned_tab_first')"
                  test-id="set-keep-entry-first"
                  @toggle="patch({ keepPinnedTabFirst: !(settings?.keepPinnedTabFirst ?? false) })"
                />
              </SettingRow>
              <p class="m-0 mt-2.5 text-[11px] leading-relaxed text-muted">{{ t('options_entry_hint') }}</p>
            </section>

            <!-- 原来这是一整张卡，里面 0 个控件、只有一句话。话留着，卡不开了。
                 这里**故意没有开关**，别顺手加回来：
                 「恢复后是否保留会话」由每个会话上的锁定决定（既有约定：恢复即消费）；
                 「恢复到哪个窗口」是每条会话标题行上的两个按钮，不是全局设置项——
                 用设置项去猜用户想要哪个窗口，不如让他点一下就说出来。 -->
            <p class="m-0 px-1 text-[11px] leading-relaxed text-muted">{{ t('options_restore_hint') }}</p>
          </template>

          <!-- ══ 外观 ══（这一节不写副标题：卡片里那句 `options_language_note` 已经在说"立刻生效"） -->
          <template v-else-if="pane === 'appearance'">
            <PaneHeader :title="t('options_appearance_section')" />
            <section class="mt-4 rounded-card border border-line bg-panel p-5">
              <SettingRow :title="t('options_theme')">
                <SettingSegment
                  :label="t('options_theme')"
                  :model-value="theme.theme.value"
                  :options="themeOptions"
                  test-id="theme-segment"
                  @update:model-value="theme.set($event as Theme)"
                />
              </SettingRow>
              <SettingRow :title="t('options_language')">
                <SettingSegment
                  :label="t('options_language')"
                  :model-value="locale.locale.value"
                  :options="localeOptions"
                  test-id="language-segment"
                  @update:model-value="locale.set($event as LocaleChoice)"
                />
              </SettingRow>
              <p class="m-0 mt-3 text-[11px] leading-relaxed text-muted" data-testid="language-note">{{ t('options_language_note') }}</p>
            </section>
          </template>

          <!-- ══ 数据 ══ -->
          <template v-else-if="pane === 'data'">
            <PaneHeader :sub="t('options_data_sub')" :title="t('options_data_section')" />

            <section class="rounded-card border border-line bg-panel p-5">
              <SettingRow :hint="t('options_import_append_hint')" :title="`${t('export_action')} / ${t('import_action')}`">
                <div class="flex items-center gap-2">
                  <button
                    class="rounded-control bg-brand px-3.5 py-2 text-[11px] font-bold text-brand-contrast transition-colors hover:bg-brand-hover"
                    type="button"
                    @click="store.exportAll()"
                  >
                    {{ t('export_action') }}
                  </button>
                  <button
                    class="rounded-control border border-line bg-panel px-3.5 py-2 text-[11px] font-bold text-ink transition-colors hover:border-brand hover:text-brand"
                    type="button"
                    @click="file?.click()"
                  >
                    {{ t('import_action') }}
                  </button>
                  <input ref="file" class="hidden" type="file" accept="application/json,.json" @change="onPickFile" />
                </div>
              </SettingRow>
              <SettingRow :title="t('options_last_export')">
                <span class="text-[11.5px] text-muted">{{ lastExport }}</span>
              </SettingRow>
            </section>

            <p class="m-0 mt-3.5 px-1 text-[11px] leading-relaxed text-muted">{{ t('options_trash_hint', { days: trashDays }) }}</p>
          </template>

          <!-- ══ 同步 ══
               ★ 这里**曾经没有分区标题**，我上一轮的理由是"两块面板自带「WEBDAV 同步」「远端历史」，
               再叠一层就是三行同义"。那个判断错了：那两句是 11px 大写的卡片 eyebrow，
               和别的分区那个 16px 粗体标题根本不是一个视觉层级 ⇒ 用户读到的是
               "这一页没标题，其他页都有"（2026-10-06 他两张截图对比出来的）。
               分区之间**形状一致**优先于"少一行字"。 -->
          <template v-else-if="pane === 'sync'">
            <PaneHeader :sub="t('options_sync_sub')" :title="t('options_nav_sync')" />
            <SyncPanel />
            <SnapshotHistoryPanel />
          </template>

          <!-- ══ 关于 ══ -->
          <AboutPanel v-else />
          </div>
        </Transition>
      </main>
    </div>

    <!-- 这一页的动作也要有人播报。
         以前设置页**没有挂这个组件**：`store.importFile()` 成功时确实 `showToast({ kind: 'import' … })`，
         但渲染 toast 的 `ResultToast` 只在工作台挂着 ⇒ 状态被设进 store，屏幕上什么都没有。
         真机反馈就是那一句"导入成功后没有提示（实际导入成功了）"（2026-10-06）。
         同一页上的导出、复制等播报此前一起失效。 -->
    <ResultToast />
  </div>
</template>
