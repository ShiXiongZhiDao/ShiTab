<script lang="ts" setup>
/**
 * 冲突裁决面板（既有约定 的脸）。
 *
 * 引擎撞到"一边删了、另一边在删之后又改了"时会停在 conflict 且**不推远端**，
 * 账落在 `SyncMeta.pendingConflicts`。这个组件就是那笔账的出口 —— 没有它，
 * 用户只会看见「有冲突，等你选择」而屏幕上没有任何能选的地方，同步永久卡在那儿。
 *
 * 面板只读 `groupId` 去主存储取标题，不在账里再存一份标题：
 * 那会是第二个真相，而用户裁完"保留"之后标题还要能跟着本机那份走。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { storagePort } from '@/shared/services';
import { resolveConflict } from '@/core/application/sync-engine';
import { createWebDavPort } from '@/infrastructure/webdav/http-webdav';
import { t, type MessageKey } from '@/shared/i18n';
import type { DeleteReason, StoredConflict, TabGroup } from '@/shared/types';

/**
 * 墓碑的 `reason` 是代码里的判别值，不能直接印到界面上
 * —— 用户看见「reason: consumed」只会以为那是个错误码。
 */
const reasonText: Record<DeleteReason, MessageKey> = {
  'user-delete': 'conflict_reason_deleted',
  consumed: 'conflict_reason_consumed',
  undone: 'conflict_reason_undone',
};

const rows = ref<Array<{ conflict: StoredConflict; group?: TabGroup }>>([]);

async function reload(): Promise<void> {
  const meta = await storagePort.getSyncMeta();
  const pending = meta.pendingConflicts ?? [];
  const groups = await Promise.all(pending.map((conflict) => storagePort.getGroup(conflict.groupId)));
  rows.value = pending.map((conflict, index) => ({ conflict, group: groups[index] }));
}

/**
 * 订阅 sync_meta：冲突是 **background 的同步**落下来的，工作台可能早就开着了。
 * 只在挂载时读一次的话，用户会看见"状态条说 syncing 完了"而这里仍然空着，
 * 非得刷新页面才长出裁决入口 —— 那正好是 Q9 把冲突放工作台的理由的反面。
 */
let stopWatch: (() => void) | undefined;
onMounted(async () => {
  await reload();
  stopWatch = storagePort.watchSyncMeta(() => void reload());
});
onBeforeUnmount(() => stopWatch?.());

/**
 * 正在裁决哪一行（既有约定，既有约定 欠的最后一处禁用样式）。
 *
 * 这不是观感问题，是一个真能丢数据的窗口：`choose()` 里 `await resolveConflict(...)` 期间
 * 两颗按钮都还能点。同一行先点「保留会话」再点「删除」，第二次会走 `softDeleteGroup`
 * —— 用户刚保留下来的那个会话就这么被删了，而且屏幕上不会有任何解释。
 *
 * 两层不一样，都是故意的：**视觉上只灰被点那一行**（别的冲突是独立的事，不该跟着变暗），
 * **逻辑上全局一次只允许一次裁决在飞** —— 因为 `resolveConflict` 写的也是整块数组
 * （`pendingConflicts` 与墓碑都是读-改-写），两行同时裁决会互相覆盖，症状又是"我明明裁过了"。
 */
const busy = ref<string | null>(null);

async function choose(groupId: string, choice: 'keep' | 'delete'): Promise<void> {
  if (busy.value !== null) return; // 任何一行在飞时都不接第二次（见下面的理由）
  const row = rows.value.find((item) => item.conflict.groupId === groupId);
  if (!row) return;
  busy.value = groupId;
  try {
    await resolveConflict({ storage: storagePort, webdav: createWebDavPort() }, row.conflict, choice);
    await reload();
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section v-if="rows.length > 0" class="mb-6 rounded-card border border-line bg-panel p-5" data-testid="conflict-section">
    <h2 class="m-0 mb-2 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_conflict_section') }}</h2>
    <p class="m-0 mb-3 text-[11px] leading-relaxed text-muted">{{ t('conflict_hint') }}</p>

    <div
      v-for="row in rows"
      :key="row.conflict.groupId"
      class="mb-2 rounded-control border border-line px-3 py-2"
      data-testid="conflict-row"
    >
      <p class="m-0 text-[12px] font-bold">{{ row.group?.title || row.conflict.groupId }}</p>
      <p class="m-0 mt-0.5 text-[10px] text-muted">
        {{ t('conflict_deleted_on_other', { device: row.conflict.deletedByDeviceId.slice(0, 8) }) }} · {{ t(reasonText[row.conflict.deleteReason]) }}
      </p>
      <div class="mt-2 flex gap-2">
        <!-- 禁用态与「处理中」这句是 既有约定 欠的最后一处（既有约定 补上）：
             灰掉 + 光标 + aria-busy 三样都在，读屏用户也知道"这一下已经在跑了"。 -->
        <button
          class="rounded-control bg-brand px-3 py-1.5 text-[11px] font-bold text-brand-contrast disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="busy !== null"
          :aria-busy="busy === row.conflict.groupId ? 'true' : undefined"
          data-testid="conflict-keep"
          @click="choose(row.conflict.groupId, 'keep')"
        >{{ busy === row.conflict.groupId ? t('conflict_busy') : t('conflict_action_keep') }}</button>
        <button
          class="rounded-control border border-line bg-panel px-3 py-1.5 text-[11px] font-bold text-ink disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="busy !== null"
          :aria-busy="busy === row.conflict.groupId ? 'true' : undefined"
          data-testid="conflict-delete"
          @click="choose(row.conflict.groupId, 'delete')"
        >{{ busy === row.conflict.groupId ? t('conflict_busy') : t('conflict_action_delete') }}</button>
      </div>
    </div>

    <p class="m-0 text-[10px] leading-relaxed text-muted">{{ t('conflict_after_resolve') }}</p>
  </section>
</template>
