<script lang="ts" setup>
/**
 * 远端历史面板（既有约定 决定 4 的 UI 面）。
 *
 * 它存在的意义有两件，都不是"看着方便"：
 * 1. §19 最后一行「恢复历史版本 ⇒ 新建本地 revision，不删除旧 snapshot」需要一个人能点的地方；
 * 2. 「清理远端历史」是整套设计里**唯一**一个会删用户服务器上东西的动作，
 *    所以它必须同时显示"会省下多少"和"要勾那一下确认"，不能是一个默默按下去的按钮。
 *
 * 列表默认不自动加载：`listRemoteHistory` 是一串 HEAD 请求，打开设置页不该顺手敲服务器。
 */
import { computed, ref } from 'vue';
import ActionButton from '@/components/ActionButton.vue';
import { storagePort } from '@/shared/services';
import { createWebDavPort } from '@/infrastructure/webdav/http-webdav';
import { listRemoteHistory, pruneRemoteHistory, restoreRemoteSnapshot } from '@/core/application/snapshot-history';
import type { RemoteHistoryEntry } from '@/core/application/snapshot-history';
import { t, type MessageKey } from '@/shared/i18n';
import type { HistoryFailure } from '@/core/application/snapshot-history';
import type { WebDavAdminPort, WebDavPort } from '@/core/ports/webdav';

/** 这一面板里会发请求的三颗按钮。转圈只给正在跑的那一颗。 */
type HistoryAction = 'load' | 'restore' | 'prune';

/**
 * 失败原因 → 文案。用穷尽的 Record 而不是 `t(`history_err_${reason}`)`：
 * 后者是运行时拼字符串，少写一个 key 就编译得过、然后把
 * `history_err_no-manifest` 这种内部标识直接印到用户脸上（既有约定 说的"会说谎的字段"的界面版）。
 */
const failureText: Record<HistoryFailure | 'not-found' | 'corrupt', MessageKey> = {
  disabled: 'history_err_disabled',
  'bad-base-url': 'history_err_bad_url',
  'no-credential': 'history_err_no_credential',
  'no-manifest': 'history_err_no_manifest',
  'not-confirmed': 'history_err_not_confirmed',
  'durable-snapshot-failed': 'history_err_snapshot_failed',
  'nothing-to-prune': 'history_err_nothing_to_prune',
  'not-found': 'history_err_not_found',
  corrupt: 'history_err_corrupt',
};

/**
 * `webdav` / `admin` 只有测试会传（真环境用真的 fetch 适配器）。
 * 没有这个口子就没法在测试里造出"请求还在飞"的状态 —— 而这一轮改的正是那个状态。
 */
const props = defineProps<{ webdav?: WebDavPort & WebDavAdminPort; admin?: WebDavAdminPort }>();

const port = createWebDavPort();
const deps = {
  storage: storagePort,
  webdav: props.webdav ?? port,
  admin: props.admin ?? props.webdav ?? port,
};

const entries = ref<RemoteHistoryEntry[]>([]);
const totalBytes = ref(0);
const loaded = ref(false);
/** 正在跑的是哪一颗；`null` = 空闲。 */
const pending = ref<HistoryAction | null>(null);
const busy = computed(() => pending.value !== null);
const restoringId = ref<string | null>(null);
const message = ref<string | null>(null);
const tone = ref<'ok' | 'bad' | 'neutral'>('neutral');
const keep = ref(30);
const confirmed = ref(false);

/**
 * 每次动作开始都先清掉上一行的结果。
 * 不清是实打实的误导：屏幕上挂着「清理完成，删了 4 版」，用户接着点「读取」，
 * 那行旧字还在原地 —— 看起来像"读取也成功了"，而它可能报了 no-manifest。
 */
function begin(action: HistoryAction): void {
  pending.value = action;
  message.value = null;
}

function say(next: string, nextTone: 'ok' | 'bad' | 'neutral'): void {
  message.value = next;
  tone.value = nextTone;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1048576).toFixed(2)} MiB`;
}

async function load(): Promise<void> {
  begin('load');
  try {
    const listed = await listRemoteHistory(deps);
    if (!listed.ok) {
      // 'no-manifest' 是"远端还没有可恢复的历史"，那是正常状态不是故障 ⇒ neutral，不用红字吓人
      say(t(failureText[listed.reason]), listed.reason === 'no-manifest' ? 'neutral' : 'bad');
      return;
    }
    entries.value = listed.entries;
    totalBytes.value = listed.totalBytes;
    loaded.value = true;
    message.value = null;
  } finally {
    pending.value = null;
  }
}

async function restore(entry: RemoteHistoryEntry): Promise<void> {
  begin('restore');
  restoringId.value = entry.snapshotId;
  try {
    const result = await restoreRemoteSnapshot(deps, entry.snapshotId);
    say(result.ok ? t('history_restored') : t(failureText[result.reason]), result.ok ? 'ok' : 'bad');
  } finally {
    pending.value = null;
    restoringId.value = null;
  }
}

async function prune(): Promise<void> {
  begin('prune');
  try {
    const result = await pruneRemoteHistory(deps, { keep: keep.value, confirmed: confirmed.value });
    if (!result.ok) {
      say(t(failureText[result.reason]), 'bad');
      return;
    }
    confirmed.value = false;
    const done = t('history_prune_done', { deleted: result.deleted, kept: result.kept });
    /**
     * 先刷新再写结果，顺序反了那句话就永远看不见。
     * `load()` 一进来就 `begin('load')` —— 那里会清掉上一行的结果（这是对的：读之前挂着
     * "清理完成"会让人以为读取也成功了），但它顺手把 prune 刚写的结果也擦了。
     */
    await load();
    say(done, 'ok');
  } finally {
    pending.value = null;
  }
}
</script>

<template>
  <section class="mb-6 rounded-card border border-line bg-panel p-5">
    <h2 class="m-0 mb-3 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_history_section') }}</h2>

    <ActionButton test-id="history-load" :label="t('history_action_load')" :busy-label="t('history_busy_load')" :busy="pending === 'load'" :disabled="busy" @click="load" />

    <template v-if="loaded">
      <p class="m-0 mt-3 text-[11px] text-muted" data-testid="history-total">
        {{ t('history_total_size', { count: entries.length, size: humanSize(totalBytes) }) }}
      </p>
      <ul class="m-0 mt-2 list-none space-y-1 p-0">
        <li v-for="entry in entries" :key="entry.snapshotId" class="flex items-center gap-2 text-[11px]" data-testid="history-row">
          <span class="font-bold">{{ t('history_revision', { revision: entry.revision }) }}</span>
          <span v-if="entry.isLatest" class="rounded-control border border-line px-1.5 py-0.5 text-[10px]" data-testid="history-current">{{ t('history_badge_current') }}</span>
          <span class="text-muted">{{ entry.bytes === undefined ? '—' : humanSize(entry.bytes) }}</span>
          <ActionButton class="ml-auto" size="sm" :test-id="`history-restore-${entry.revision}`" :label="t('history_action_restore')" :busy-label="t('history_busy_restore')" :busy="pending === 'restore' && restoringId === entry.snapshotId" :disabled="busy" @click="restore(entry)" />
        </li>
      </ul>

      <div class="mt-4 border-t border-line pt-3">
        <label class="flex items-center gap-2 text-[11px]">
          <span>{{ t('history_keep_newest') }}</span>
          <input v-model.number="keep" class="w-16 rounded-control border border-line bg-panel px-2 py-1 text-[11px] outline-none" type="number" min="1" data-testid="history-keep" />
        </label>
        <label class="mt-2 flex items-start gap-2.5 text-[11px]">
          <input v-model="confirmed" class="mt-0.5 accent-brand" type="checkbox" data-testid="history-confirm" />
          <span>{{ t('history_prune_confirm') }}</span>
        </label>
        <ActionButton class="mt-2" test-id="history-prune" :label="t('history_prune_action')" :busy-label="t('history_busy_prune')" :busy="pending === 'prune'" :disabled="busy || !confirmed" @click="prune" />
      </div>
    </template>

    <!-- 结果行带语气（✓/✕ + 颜色），并声明成 live region：这行字是"我刚才那一下成没成"的唯一依据 -->
    <p
      v-if="message"
      class="m-0 mt-3 break-all text-[10px]"
      :class="tone === 'bad' ? 'font-bold text-danger' : tone === 'ok' ? 'text-brand' : 'text-muted'"
      aria-live="polite"
      data-testid="history-message"
      role="status"
    >
      <span aria-hidden="true">{{ tone === 'bad' ? '✕' : tone === 'ok' ? '✓' : '·' }}</span>
      {{ message }}
    </p>
  </section>
</template>
