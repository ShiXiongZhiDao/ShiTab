<script lang="ts" setup>
/**
 * 远端历史面板（既有约定 决定 4 的 UI 面）。
 *
 * 它存在的意义有两件，都不是"看着方便"：
 * 1. §19 最后一行「恢复历史版本 ⇒ 新建本地 revision，不删除旧 snapshot」需要一个人能点的地方；
 * 2. 「清理远端历史」是整套设计里**唯一**一个会删用户服务器上东西的动作，
 *    所以它必须同时显示"会省下多少"和"要勾那一下确认"，不能是一个默默按下去的按钮。
 *
 * 列表默认不自动加载：`listRemoteHistory` 要打网络（读指针 + 读 manifest + 一次 `snapshots/`
 * 列举），打开设置页不该顺手敲服务器 —— 坚果云免费账号限 600 请求 / 30 分钟。
 */
import { computed, nextTick, ref } from 'vue';
import ActionButton from '@/components/ActionButton.vue';
import { storagePort } from '@/shared/services';
import { createWebDavPort } from '@/infrastructure/webdav/http-webdav';
import { listRemoteHistory, pruneRemoteHistory, previewRestore, restoreRemoteSnapshot } from '@/core/application/snapshot-history';
import type { RemoteHistoryEntry } from '@/core/application/snapshot-history';
import type { RestorePlanCounts } from '@/core/domain/restore-as-revert';
import { t, type MessageKey } from '@/shared/i18n';
import type { HistoryFailure } from '@/core/application/snapshot-history';
import type { WebDavAdminPort, WebDavPort } from '@/core/ports/webdav';

/** 这一面板里会发请求的几颗按钮。转圈只给正在跑的那一颗。 */
type HistoryAction = 'load' | 'restore' | 'prune' | 'preview';

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
  unreachable: 'history_err_unreachable',
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
/**
 * 有几版的大小**问不出来**（服务器没报，或整次目录列举问不通）。
 * 不为 0 时总数那一句必须换成"至少共"那一版文案：`totalBytes` 只是已知那些的和，
 * 把它当精确值印出来就是一句会被用户当真的假数（他会照着判断"清理能省多少空间"）。
 */
const unknownSizes = ref(0);
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

/** 推送这一版的设备：名字解析不到就回退 id 前 8 位（与 `ConflictPanel.vue` 同一口径）。 */
function deviceOf(entry: RemoteHistoryEntry): string {
  return entry.deviceName ?? entry.deviceId.slice(0, 8);
}

/** 「什么时候、由哪台设备推的」：两个数都在 manifest 的条目里，不为此多发一次请求。 */
function pushedLine(entry: RemoteHistoryEntry): string {
  return t('history_row_push', { time: new Date(entry.createdAt).toLocaleString(), device: deviceOf(entry) });
}

/**
 * 顶部那一句总数。`unknownSizes > 0` 时走"至少共"那一版文案，并点出有几版没报大小 ——
 * 沉默地把未知的那几版漏掉、再说一句"共 X"，是把下限报成了精确值。
 */
const totalLine = computed<string>(() =>
  unknownSizes.value === 0
    ? t('history_total_size', { count: entries.value.length, size: humanSize(totalBytes.value) })
    : t('history_total_size_at_least', {
        count: entries.value.length,
        size: humanSize(totalBytes.value),
        unknown: unknownSizes.value,
      }),
);

/**
 * 一屏先列几版（2026-10-08 真机反馈：远端历史「很长」）。
 *
 * 取 20 不是凑数：一版行在两行高，20 版就是约 40 行 —— 比设置页那一屏还长，
 * 而 40 版之后基本没人会逐条看。真正的条数仍然在那句总数里报着。
 */
const HISTORY_PAGE = 20;
const visibleLimit = ref(HISTORY_PAGE);

/** 清单上实际渲染的那几版（`entries` 已经是 revision 降序，切前 N 条就是"最近的那几版"）。 */
const visibleEntries = computed(() => entries.value.slice(0, visibleLimit.value));
const hiddenCount = computed(() => Math.max(0, entries.value.length - visibleLimit.value));

/** 再放一屏。本地切片，不发请求。 */
function showEarlier(): void {
  visibleLimit.value += HISTORY_PAGE;
}

/**
 * 每次重新读取都把窗口收回去。
 * 不收的话：上一次翻到第 120 版，这次清理完只剩 30 版，而屏幕上仍然挂着"我翻到过 120"这个状态 ——
 * 它已经不成立了，而且用户看不见这条线在哪儿。
 */

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
    unknownSizes.value = listed.unknownSizes;
    loaded.value = true;
    visibleLimit.value = HISTORY_PAGE;
    // 预览是"当时那一版账本 + 当时那份本机状态"的函数：重新读取之后它可能已经不成立
    pendingRestore.value = null;
    message.value = null;
  } finally {
    pending.value = null;
  }
}

/**
 * ★ 第一下只**算给他看**，第二下才落盘。
 *
 * 恢复是替换：会把"现在多出来的那些"换掉，而对面那台下一轮也跟着变。
 * 一个按钮一次点击就把这种事做掉，是这套设计里最不该有的形状 ——
 * 同一份顾虑已经在「清理远端历史」上用勾选解决过。
 * 这里没有再放一颗勾选，因为确认行本身就把后果写在脸前，而且它只有一下点击的距离。
 */
const pendingRestore = ref<{ entry: RemoteHistoryEntry; counts: RestorePlanCounts } | null>(null);
/** 确认条那个 DOM 节点：只为"点完第一下把它滚进视野"服务。 */
const restoreConfirmEl = ref<HTMLElement | null>(null);

async function askRestore(entry: RemoteHistoryEntry): Promise<void> {
  begin('preview');
  restoringId.value = entry.snapshotId;
  try {
    const preview = await previewRestore(deps, entry.snapshotId);
    if (!preview.ok) {
      say(t(failureText[preview.reason]), 'bad');
      pendingRestore.value = null;
      return;
    }
    pendingRestore.value = { entry, counts: preview.counts };
    message.value = null;
    // ★ 点第一下之后把确认条带到眼前（2026-10-08 他问"能不能用弹窗"，选的是这条）：
    // 他从清单**深处**点恢复，而确认条在清单上方 —— 不滚过来就是"点了没反应"，
    // 那正是 既有约定 立项要防的形状。弹窗能解决同一件事，但要为它现造一套原语
    // （遮罩 / Esc / 焦点陷阱 / 滚动锁 / aria-modal），而且这一屏会出现第二种确认方式；
    // 仓库里三处破坏性确认走的都是"贴在动作旁边的确认条"（`GroupRow.vue` 那族）。
    await nextTick();
    // jsdom 不实现 scrollIntoView（真浏览器有），所以先判存在再调 ——
    // 用例那边是把 `Element.prototype.scrollIntoView` 换成 spy 来断言"真的滚了"。
    restoreConfirmEl.value?.scrollIntoView?.({ block: 'nearest' });
  } finally {
    pending.value = null;
    restoringId.value = null;
  }
}

async function confirmRestore(): Promise<void> {
  const target = pendingRestore.value;
  if (!target) return;
  pendingRestore.value = null;
  begin('restore');
  restoringId.value = target.entry.snapshotId;
  try {
    const result = await restoreRemoteSnapshot(deps, target.entry.snapshotId);
    // 结果那句报的是**实际**带回与换掉的条数，不是预览时那两个数：
    // 中间本机可能又动了，拿预览的数当结果就是拿旧账充新账。
    say(
      result.ok
        ? t('history_restored_counts', { brought: result.counts.broughtSessions, removed: result.counts.removedSessions })
        : t(failureText[result.reason]),
      result.ok ? 'ok' : 'bad',
    );
  } finally {
    pending.value = null;
    restoringId.value = null;
  }
}

function cancelRestore(): void {
  pendingRestore.value = null;
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

    <!--
      ★ 结果行在**最上面**，紧跟它自己那一排动作（2026-10-08 真机第二张截图：
      清理完之后那句「✓ 已删除 4 个快照，保留 30 个」掉在整份清单底下，看不见）。
      这行字是"我刚才那一下成没成"的唯一依据，而清单可以很长 ——
      放在下面等于每次都要滚到底去确认自己刚才做了什么。
      `aria-live="polite"` 与位置无关，读屏仍然会念出来；对眼睛来说只有"在不在首屏"这一条。
      ⚠ 换来的代价写在 `既有约定` 的 O22：从清单深处点「恢复到这一版」时，
      结果行在**上面**，那一行不在视野里 —— 真机觉得别扭就报回来，那是位置的二选一，不是 bug。
    -->
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

    <template v-if="loaded">
      <p class="m-0 mt-3 text-[11px] text-muted" data-testid="history-total">
        {{ totalLine }}
      </p>

      <!--
        ★ 清理这一格挪到**列表上面**（2026-10-08 真机：不可变历史攒到上百版之后，
        它在最底部，要滚过整份清单才够得着，而它恰恰是唯一那一格能腾出空间的动作）。
        危险动作的护栏一条没减：还是那颗勾选、没勾就 disabled。
      -->
      <div class="mt-3 rounded-control border border-line p-3">
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

      <!--
        ★ 恢复的确认行：第一下只把后果算出来，第二下才落盘。
        位置紧贴清单上方 —— 它说的是"下面这一版会被换成什么"，而 既有约定 那条
        "沉在长清单下面的东西看不见"的教训已经付过一次学费了。
      -->
      <div
        v-if="pendingRestore"
        ref="restoreConfirmEl"
        class="mt-3 rounded-control border border-danger/40 bg-danger-soft p-3"
        data-testid="history-restore-confirm"
        role="group"
      >
        <p class="m-0 text-[11px]">
          {{ t('history_restore_confirm', {
            revision: pendingRestore.entry.revision,
            brought: pendingRestore.counts.broughtSessions,
            removed: pendingRestore.counts.removedSessions,
          }) }}
        </p>
        <p
          v-if="pendingRestore.counts.askedBack > 0"
          class="m-0 mt-1 text-[10px] text-muted"
          data-testid="history-restore-asked"
        >
          {{ t('history_restore_asked', { count: pendingRestore.counts.askedBack }) }}
        </p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <ActionButton
            test-id="history-restore-yes"
            size="sm"
            tone="danger"
            :label="t('history_restore_confirm_action', { revision: pendingRestore.entry.revision })"
            :busy-label="t('history_busy_restore')"
            :busy="pending === 'restore'"
            :disabled="busy && pending !== 'restore'"
            @click="confirmRestore"
          />
          <ActionButton test-id="history-restore-no" size="sm" :label="t('confirm_no')" :disabled="busy" @click="cancelRestore" />
        </div>
      </div>

      <!--
        清单**只列最近 20 版**，其余靠「显示更早」往下翻页（既有约定 之后一台机器不再每 60 秒
        攒一版，但不可变历史本来就是"永不删"的设计，攒到上百版是常态而不是故障）。
        顶部那句总数报的是**全部**条数与总体量，不是这 20 条的和 —— 少报体量会让人以为不用清理。
        ★ 翻页是纯本地的：`listRemoteHistory` 已经一次把 manifest 读完了，
          多显示几条不许多发一次请求（坚果云免费档 600 请求 / 30 分钟）。
      -->
      <ul class="m-0 mt-2 list-none space-y-1 p-0">
        <!--
          两行的行：第一行是"挑哪一版"要用的三个数（版本号 / 当前徽章 / 体量）加那颗按钮，
          第二行是"这一版是几点、由哪台设备推的"。`flex-wrap` + 最后一行 `basis-full`
          让窄屏（选项页右侧那一栏被拉到最窄时）自动折行而不是把按钮挤出容器；
          `truncate` 保证一个 40 字的设备名不会把这行撑破。
        -->
        <li
          v-for="entry in visibleEntries"
          :key="entry.snapshotId"
          class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]"
          data-testid="history-row"
        >
          <span class="shrink-0 font-bold">{{ t('history_revision', { revision: entry.revision }) }}</span>
          <span
            v-if="entry.isLatest"
            class="shrink-0 rounded-control border border-line px-1.5 py-0.5 text-[10px]"
            data-testid="history-current"
          >{{ t('history_badge_current') }}</span>
          <!-- 问不出大小就是 `—`：`0 B` 曾经是"这台主机没报"被当成"这个文件是空的" -->
          <span class="shrink-0 text-muted" data-testid="history-size">
            {{ entry.bytes === undefined ? '—' : humanSize(entry.bytes) }}
          </span>
          <ActionButton
            class="ml-auto shrink-0"
            size="sm"
            :test-id="`history-restore-${entry.revision}`"
            :label="t('history_action_restore')"
            :busy-label="t('history_busy_restore')"
            :busy="(pending === 'restore' || pending === 'preview') && restoringId === entry.snapshotId"
            :disabled="busy"
            @click="askRestore(entry)"
          />
          <span class="w-full min-w-0 basis-full truncate text-[10px] text-muted" data-testid="history-push">
            {{ pushedLine(entry) }}
          </span>
        </li>
      </ul>

      <ActionButton
        v-if="hiddenCount > 0"
        class="mt-2"
        size="sm"
        test-id="history-show-earlier"
        :label="t('history_show_earlier', { count: hiddenCount })"
        :busy="false"
        @click="showEarlier"
      />
      <!-- 翻到末尾要说一声"到底了"，否则用户会以为还有没读出来的（这条面板本来就"读多少由服务器配额决定"） -->
      <p v-else-if="entries.length > HISTORY_PAGE" class="m-0 mt-2 text-[10px] text-muted" data-testid="history-all-shown">
        {{ t('history_all_shown', { count: entries.length }) }}
      </p>
    </template>
  </section>
</template>
