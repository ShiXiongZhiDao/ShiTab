<script lang="ts" setup>
import { computed } from 'vue';
import { useGroups } from '@/composables/useGroups';
import { t } from '@/shared/i18n';

const store = useGroups();

/**
 * skipped 与 failed 的措辞必须不同（glossary）：
 * skipped 是"有意没做"，failed 是"试着做了但没成"。
 */
const body = computed(() => {
  const toast = store.toast;
  if (!toast) return '';
  if (toast.kind === 'capture') {
    return t('result_capture_summary', {
      saved: toast.result.saved,
      closed: toast.result.closed,
      kept: toast.result.kept,
    });
  }
  if (toast.kind === 'restore') {
    return t('result_restore_summary', {
      restored: toast.result.restored,
      skipped: toast.result.skipped,
      failed: toast.result.failed,
    });
  }
  if (toast.kind === 'import') {
    return t('import_result', {
      groups: toast.groups,
      tabs: toast.tabs,
      categories: toast.categories,
    });
  }
  return t(toast.key, toast.subs);
});

const tone = computed(() => {
  const toast = store.toast;
  if (!toast) return 'ok';
  if (toast.kind === 'message') return toast.tone === 'error' ? 'error' : 'warn';
  if (toast.kind === 'restore' && toast.result.failed > 0) return 'warn';
  return 'ok';
});

const note = computed(() => {
  const toast = store.toast;
  if (!toast) return '';
  if (toast.kind === 'capture') {
    const parts: string[] = [];
    if (toast.result.failed > 0) parts.push(t('result_failed_note', { count: toast.result.failed }));
    if (toast.result.pinnedSkipped > 0) {
      parts.push(t('result_pinned_skipped', { count: toast.result.pinnedSkipped }));
    }
    if (toast.result.nonRestorableSaved > 0) {
      parts.push(t('result_non_restorable_saved', { count: toast.result.nonRestorableSaved }));
    }
    // 落脚页没安排好时会保留活动页，不说出来的话"为什么少关了一个"无法解释
    if (!toast.result.hasLanding) parts.push(t('result_no_landing'));
    return parts.join(' · ');
  }
  if (toast.kind === 'restore') {
    const parts: string[] = [];
    if (toast.result.failed > 0) parts.push(t('result_failed_note', { count: toast.result.failed }));
    if (toast.result.skipped > 0) parts.push(t('result_skipped_note', { count: toast.result.skipped }));
    return parts.join(' · ');
  }
  return '';
});
</script>

<template>
  <!-- 外层负责定位（居中），内层负责进出场。把 translate-y 与居中放在同一个元素上，
       Tailwind 的两个 translate 工具类会互相覆盖，动效就变成从左边跳进来。 -->
  <div class="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-6">
    <transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <div
        v-if="store.toast"
        class="pointer-events-auto flex w-full max-w-[640px] items-center gap-2 rounded-card border px-3 py-2.5 shadow-card"
        :class="tone === 'error' ? 'border-danger bg-danger-soft' : tone === 'warn' ? 'border-warn bg-warn-soft' : 'border-line bg-panel-raised'"
        role="status"
        aria-live="polite"
      >
        <div class="min-w-0 flex-1">
          <p class="tn-ellipsis m-0 text-[11px] font-bold text-ink">{{ body }}</p>
          <p v-if="note" class="tn-ellipsis mt-0.5 text-[10px] text-muted">{{ note }}</p>
        </div>
        <button
          v-if="store.toast.kind === 'capture' && store.toast.canUndo"
          class="shrink-0 rounded-control bg-brand px-3 py-1.5 text-[11px] font-bold text-brand-contrast"
          type="button"
          @click="store.undo()"
        >
          {{ t('undo_action') }}
        </button>
        <button
          class="shrink-0 rounded bg-transparent px-1.5 py-1 text-[13px] text-muted hover:text-ink"
          type="button"
          :aria-label="t('close')"
          @click="store.dismissToast()"
        >
          ✕
        </button>
      </div>
    </transition>
  </div>
</template>
