<script lang="ts" setup>
/**
 * WebDAV 同步设置面板（形状 = 既有约定 文件的 **0073** 节；凭据那半在 0068 节）。
 *
 * 一句话：配好之前是一颗星，配好之后是**一行摘要 + 一颗按钮**，不再是一张表单。
 * 用户 2026-10-04 的抱怨是"打勾、保存同步好复杂"，量出来的根因不是字段多
 * （同类产品 Saladict 也是 3 字段 + 一个验证按钮），而是三件事：
 * ① 两颗勾选都在要授权，其中「允许 http://」对填 https 的人永远是噪声；
 * ② 「保存」是工程概念 —— 它做的是"校验 + 要权限 + 记配置"，还得再点「立即同步」才算真推一次；
 * ③ 「测试连接」与「立即同步」在用户眼里是一件事，却并排放着。
 *
 * 三条不变的东西，别在下次"再简化一点"时弄丢：
 * 1. **要权限必须是一次真实点击**（官方原文：`permissions.request()` 只能在用户动作的 handler 里调）。
 *    合并成一颗按钮合法（一次点击做三件事，其中要权限那件独占这次点击）；
 *    做成"填完自动连接"就是拿掉那次手势，后果是"配好了但一直 401"。
 * 2. **密码不回显**。存过只显示"已保存"，要改就重新填。
 * 3. **落点那一行必须留在地址框下面**：路径双拼在字面地址里看不出来，
 *    在这一行上一眼就能看见，而双拼的代价是"多出一个没人认得的空库"。
 *
 * 既有约定 加了一条新的界面义务：从这版起「立即同步」**会被拒**（manual 也要过判据，
 * 用户 2026-10-05 拍的 Q2b）。被拒不是错误，所以它有自己的文案（`sync_notice_skipped` /
 * `sync_notice_in_flight`），而且必须当场给"下一次自动检查约几点"。
 * 一颗会被拒的按钮如果什么都不说，用户读到的就是"这功能坏了"。
 */
import { computed, onMounted, ref } from 'vue';
import ActionButton from '@/components/ActionButton.vue';
import SettingSwitch from '@/components/SettingSwitch.vue';
import { useSyncPanel, type SyncNotice } from '@/composables/useSync';
import { isInsecureHttp, parseBaseUrl, remoteRootUrl } from '@/core/domain/remote-layout';
import { storagePort } from '@/shared/services';
import { t, type MessageKey } from '@/shared/i18n';
import type { WebDavPort } from '@/core/ports/webdav';
import type { SyncAttempt } from '@/core/application/sync-engine';
import type { SuspiciousCounts } from '@/core/domain/safety';
import type { SyncStatus, SyncTriggerReason } from '@/shared/types';

/**
 * `webdav` 只有测试会传（真环境一律用真的 fetch 适配器）。
 * 传进来的理由是 `connect()` 一次点击就走到发请求那一步 —— 界面用例要么打真网络，
 * 要么只能测到一半。默认值是 `undefined`，`useSyncPanel` 里才决定用哪个实现。
 */
const props = defineProps<{ webdav?: WebDavPort }>();

const panel = useSyncPanel({ webdav: props.webdav });

const baseUrl = ref('');
const username = ref('');
const password = ref('');
const allowInsecureHttp = ref(false);
/** 已连接之后表单默认收起；这颗只是"展开改设置"的开关，不是功能开关。 */
const expanded = ref(false);

/**
 * 配过 = 有地址 **且至少成功连接过一次**（`lastTestedAt` 有值）。这一条决定"摘要还是表单"。
 *
 * 为什么不看 `enabled`：掺了它会造出走不通的死胡同 —— 关掉同步后面板退回表单，那颗
 * 「同步」开关随之消失，用户想再打开得重走一遍连接（还得保证密码框留空才对）。
 * 开关关掉就该留在原地、标成"已暂停"，再点一下就回来。
 *
 * 为什么也不只看 `baseUrl`：填了但第一次就没连上（密码错、权限被拒）时 `enabled` 是 false、
 * 地址却已经写进表单状态里 —— 那种情况必须留在表单，否则用户对着一个"已暂停"的摘要
 * 完全没法改他刚填错的东西。`lastTestedAt` 正是这个区分：类型注释里写的就是
 * "缺省 = 从没通过，UI 要能区分这两种"。
 */
const configured = computed(
  () => (panel.config.value?.baseUrl ?? '') !== '' && panel.config.value?.lastTestedAt !== undefined,
);
/** 已连接 = 配过且开着。摘要行上那颗 pill 说的就是它。 */
const connected = computed(() => configured.value && panel.config.value?.enabled === true);

/** 明文披露只在**地址真的是 http://** 时出现（原来它常驻，对 https 用户是纯噪声）。 */
const insecure = computed(() => {
  const parsed = parseBaseUrl(baseUrl.value);
  return parsed.ok && isInsecureHttp(parsed.url);
});

/** 摘要行的主机名：`https://dav.jianguoyun.com/dav/` → `dav.jianguoyun.com`。 */
const host = computed((): string => {
  const parsed = parseBaseUrl(panel.config.value?.baseUrl ?? baseUrl.value);
  return parsed.ok ? parsed.url.hostname : '';
});

/**
 * 落点（既有约定 的验收面）。地址不合法时整行不出现，改说"认不出来"。
 */
const remoteRoot = computed((): string => {
  const parsed = parseBaseUrl(baseUrl.value);
  return parsed.ok ? remoteRootUrl(parsed.url).href : '';
});

onMounted(async () => {
  await panel.load();
  const config = panel.config.value;
  if (!config) return;
  baseUrl.value = config.baseUrl;
  username.value = config.username;
  allowInsecureHttp.value = config.allowInsecureHttp;
});

/**
 * 保存/连接失败的原因 → 文案。走穷尽映射而不是把 reason 原样印出去：
 * 'insecure-http' 这类串对用户没有意义（真机第一轮反馈里"点了没提示"就是这个形状）。
 */
function saveFailure(reason?: string): SyncNotice {
  switch (reason) {
    case 'insecure-http': return 'sync_err_insecure';
    case 'no-credential': return 'sync_err_need_password';
    case 'permission-denied': return 'sync_err_permission_denied';
    default:
      if (reason && reason.includes('地址无效')) return 'sync_err_bad_url';
      return 'sync_err_generic';
  }
}

/**
 * 同步结果 → 文案。`outcome.status` 与 skip 的 `cause` 都是内部判别值，绝不能原样上屏。
 *
 * 从 既有约定 起"点了但没跑"是一种**正常结果**（manual 也要过判据，这是用户拍的 Q2b），
 * 所以这一层必须把它翻成人话，而不是当成错误。四条 skip 分支各自的真话：
 * - `disabled`：按钮本不该出现（摘要行那颗在暂停时是藏起来的），出现了也说"先打开同步"。
 * - `awaiting-user`：有冲突等人裁决 ⇒ 说冲突那句，因为用户要去的下一站就是那块对话框。
 * - `in-flight`：另一处已经有一轮在飞 ⇒ 说"已加入"，**不说失败**（没发过的请求不能报错）。
 * - `not-due`：退避 / 去抖 / 60 秒拉取间隔还没到 ⇒ 说"本轮未发起"，并配一行下一次是几点
 *   （`skipHint`）。少了那一行，这颗按钮在用户眼里就是坏了 —— 这是他最难自己分辨的
 *   一种"什么都没发生"。
 */
function noticeFor(attempt: SyncAttempt): SyncNotice {
  if (!attempt.ran) {
    return attempt.cause === 'disabled'
      ? 'sync_hint_enable_first'
      : attempt.cause === 'awaiting-user'
        ? 'sync_notice_conflict'
        : attempt.cause === 'in-flight'
          ? 'sync_notice_in_flight'
          : 'sync_notice_skipped';
  }
  const { status } = attempt.outcome;
  return status === 'idle' && attempt.outcome.pushed
    ? 'sync_notice_pushed'
    : status === 'idle'
      ? 'sync_notice_nothing'
      : status === 'suspicious_change'
        ? 'sync_notice_suspicious'
        : status === 'conflict'
          ? 'sync_notice_conflict'
          : status === 'disabled'
            ? 'sync_hint_enable_first'
            : 'sync_notice_failed';
}

/**
 * 「检测到异常变化」那句要带**四个数**（本机这一版 / 服务器那一份 × 标签组 / 记录）。
 *
 * 原来那句只说"比服务器少得多"，用户没法判断这是误报还是真删了（2026-10-06 真机反馈），
 * 而条数是他唯一能自己核对的东西：看一眼回收站有没有那 25 条，就知道该选哪一边。
 *
 * 数字只存在于**这一轮的结果**里（`outcome.suspicious.counts`），账本 `syncMeta` 没有它 ——
 * 所以它跟着 notice 一起记，不假装是持久状态。工作台顶部那颗 pill 读的是账本，
 * 那里没有一次尝试可以问，只能继续说短的那句（`sync_status_suspicious`）。
 */
const suspiciousCounts = ref<SuspiciousCounts | null>(null);

/**
 * 结果那一行里**由同步尝试驱动**的那些文案，唯一写入口：文案 key 和它要用的数字同一次落下。
 *
 * （「测试连接」那两句在 `useSync.testConnection` 里直接写 `notice`，它们和这一轮的结果
 * 数字无关，所以不绕到这里。）
 */
function setNotice(key: SyncNotice, attempt?: SyncAttempt): void {
  suspiciousCounts.value = attempt?.ran ? attempt.outcome.suspicious?.counts ?? null : null;
  panel.notice.value = key;
}

/**
 * 叫醒上一次同步的那四类节拍 → 文案。
 *
 * 穷尽 `Record<SyncTriggerReason, MessageKey>` 而不是 `t(\`sync_trigger_${x}\`)` 拼字符串：
 * 拼出来的 key 不存在时屏幕上就是一个空洞（`t()` 在目录查不到时**回原 key**，用户会看见
 * `sync_trigger_alarm`）。加一种 trigger 时这里必须同轮补一条，否则编译红。
 */
const triggerLabel: Record<SyncTriggerReason, MessageKey> = {
  heartbeat: 'sync_trigger_heartbeat',
  'local-change': 'sync_trigger_local_change',
  alarm: 'sync_trigger_alarm',
  startup: 'sync_trigger_startup',
  manual: 'sync_trigger_manual',
};

const lastTriggerLine = computed((): string | null => {
  const reason = panel.meta.value?.lastTrigger;
  if (!reason) return null;
  return t('sync_last_trigger', { trigger: t(triggerLabel[reason]) });
});

/**
 * 「立即同步」被拒时多出来的那一行。`skipHint` 由 `runNow` 决定，不在 computed 里猜：
 * 只有**这一次点击**确实被拒才该解释，页面刚打开时挂着"下一次自动检查约 …"像是
 * 在预告一个用户没问的东西。
 */
const skipHint = ref(false);
const nextCheckLine = computed(() =>
  t('sync_next_check', { time: new Date(panel.nextCheckAt()).toLocaleTimeString() }),
);

const statusLabel: Record<SyncStatus, MessageKey> = {
  disabled: 'sync_status_disabled',
  idle: 'sync_status_idle',
  syncing: 'sync_status_syncing',
  pending: 'sync_status_pending',
  conflict: 'sync_status_conflict',
  suspicious_change: 'sync_status_suspicious',
  error: 'sync_status_error',
};

const busy = computed(() => panel.busy.value);
/**
 * 状态行读的是**开关**，不是账本。
 *
 * 账本里那一格记的是"上一次为什么没同步成"（error / conflict / idle），它是历史；
 * 而用户此刻的状态是"同步开着还是关着"。既有约定 之前那句历史会被 `runSync` 顺手改成
 * `disabled`，两者刚好碰巧一致；现在 skip 发生在进引擎之前，那笔顺手写没了 ⇒ 必须在这里
 * 按开关判，否则关掉同步之后屏幕上还挂着「同步失败」，看起来像"关掉反而更坏了"。
 * （background 那边也把账本落成 `disabled`，两处口径一致 —— 但界面不依赖那一次写会不会来。）
 */
const status = computed<SyncStatus>(() =>
  panel.enabled.value ? (panel.meta.value?.status ?? 'disabled') : 'disabled',
);

/** 只有**被点的那一颗**在转圈；其余按钮靠 disabled 表达。 */
const connecting = computed(() => panel.pending.value === 'connect');
const testing = computed(() => panel.pending.value === 'test');
const syncing = computed(() => panel.pending.value === 'sync');

/**
 * 摘要行那颗「立即同步」要不要转圈：`sync` 或 `connect` 都算。
 *
 * 这不是凑数：点「连接并同步」之后 `save()` 一落盘，`configured` 立刻变真、面板当场折成摘要，
 * 而连接动作还剩"推第一版"没跑完 —— 这时转圈必须跟着搬到摘要那颗按钮上，
 * 否则用户看到的正是这轮要修的那个现象："屏幕换了，事情还在跑，但没有任何东西在动"。
 */
const summaryBusy = computed(() => syncing.value || connecting.value);

/**
 * 结果那一行的语气。穷尽 Record（少写一条编译就红）——
 * 用 `key.startsWith('sync_err_')` 那种字符串猜法也能跑，但加一个新文案 key 时它静默走 default，
 * 于是"失败了"和"成功了"长得一样，而这行字是用户判断"我刚才那一下到底成没成"的唯一依据。
 */
const noticeTone: Record<SyncNotice, 'ok' | 'bad' | 'neutral'> = {
  sync_notice_pushed: 'ok',
  sync_notice_nothing: 'ok',
  sync_notice_saved: 'ok',
  sync_notice_test_ok: 'ok',
  sync_notice_paused: 'neutral',
  sync_notice_suspicious: 'neutral',
  sync_notice_conflict: 'neutral',
  sync_notice_skipped: 'neutral',
  sync_notice_in_flight: 'neutral',
  sync_hint_enable_first: 'neutral',
  sync_notice_failed: 'bad',
  sync_notice_test_failed: 'bad',
  sync_notice_connected_failed: 'bad',
  sync_err_insecure: 'bad',
  sync_err_need_password: 'bad',
  sync_err_permission_denied: 'bad',
  sync_err_bad_url: 'bad',
  sync_err_generic: 'bad',
};

const tone = computed<'ok' | 'bad' | 'neutral'>(() =>
  panel.notice.value ? noticeTone[panel.notice.value] : 'neutral',
);

/**
 * 屏幕上那一句结果。只有「异常变化」需要数字，其余文案里没有占位符。
 *
 * 拿不到数字时退回**那句短的**（`sync_status_suspicious`，状态行与工作台 pill 用的同一条），
 * 而不是把带占位符的那条原样印出去 —— 漏传一次屏幕上就是一个 `__sessions__`
 * （这次改动自己的失败形状，界面用例里钉了一句 `not.toContain('__')`）。
 *
 * ⚠ 这一支正常**走不到**：引擎报 `suspicious_change` 就一定带 counts，那条契约由
 *   `test/sync-engine.spec.ts` 的 counts 判据钉住。所以这里是防御，不是第二种产品状态，
 *   也因此没有为它新加一条没人能看见的文案。
 */
const noticeText = computed(() => {
  const key = panel.notice.value;
  if (!key) return '';
  if (key === 'sync_notice_suspicious') {
    const counts = suspiciousCounts.value;
    if (!counts) return t('sync_status_suspicious');
    return t('sync_notice_suspicious', {
      sessions: counts.outgoing.sessions,
      records: counts.outgoing.records,
      remoteSessions: counts.remote.sessions,
      remoteRecords: counts.remote.records,
    });
  }
  return t(key);
});

async function refreshLast(): Promise<void> {
  lastSync.value = formatLast((await storagePort.getSyncMeta()).lastSyncAt);
}

/**
 * 一颗按钮做完"存配置 + 要权限 + 建目录 + 推第一版"。
 *
 * 同步失败时**不**回退到"没连上"：配置与权限已经到手，这时说"已连接，但这次同步没完成"。
 * 把两步绑成一个错误，用户会以为地址填错了，而真因可能只是网盘那边 503。
 */
async function connect(): Promise<void> {
  skipHint.value = false;
  const result = await panel.connect(
    {
      enabled: true,
      baseUrl: baseUrl.value,
      username: username.value,
      allowInsecureHttp: allowInsecureHttp.value,
    },
    password.value,
  );
  if (!result.ok) {
    setNotice(saveFailure(result.message));
    return;
  }
  password.value = '';
  await refreshLast();
  const attempt = result.attempt;
  setNotice(
    !attempt
      ? 'sync_notice_saved'
      : attempt.ran && attempt.outcome.status === 'error'
        ? 'sync_notice_connected_failed'
        : noticeFor(attempt),
    attempt,
  );
}

async function runNow(): Promise<void> {
  const attempt = await panel.syncNow();
  setNotice(noticeFor(attempt), attempt);
  skipHint.value = !attempt.ran && (attempt.cause === 'not-due' || attempt.cause === 'in-flight');
  await refreshLast();
}

/** 关掉「同步」只翻 enabled：不删远端、不清密码、不改地址。 */
async function toggle(): Promise<void> {
  skipHint.value = false;
  const next = !(panel.config.value?.enabled ?? false);
  const attempt = await panel.setEnabled(next);
  await refreshLast();
  if (!next) setNotice('sync_notice_paused');
  else if (attempt) setNotice(noticeFor(attempt), attempt);
}

async function testOnly(): Promise<void> {
  await panel.testConnection();
}

const lastSync = ref<string>('');
function formatLast(at?: number): string {
  if (!at) return t('sync_never');
  return new Date(at).toLocaleString();
}

onMounted(refreshLast);
</script>

<template>
  <section class="mb-6 rounded-card border border-line bg-panel p-5">
    <h2 class="m-0 mb-3 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_sync_section') }}</h2>

    <!-- ① 配过之后：一行摘要。暂停时它也得留在这（否则那颗开关自己会消失）。 -->
    <div v-if="configured && !expanded" class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="m-0 text-[12px] font-bold">
          {{ host }}
          <span v-if="connected" class="ml-1 rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand">{{ t('sync_connected') }}</span>
          <span v-else class="ml-1 rounded-full bg-chip px-2 py-0.5 text-[10px] font-bold text-muted" data-testid="sync-paused">{{ t('sync_paused') }}</span>
        </p>
        <p class="m-0 mt-0.5 break-all text-[10px] text-muted">
          <span class="font-mono">{{ remoteRoot }}</span>
          · {{ t('sync_last_sync') }} {{ lastSync }}
          · {{ t(statusLabel[status]) }}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <!-- 这颗就是原来的总开关，但从"要不要启用"的抽象勾选挪到挂在已连接状态上。
             开关本体是 SettingSwitch —— 原来这里手画了一份 19×34 的轨道，和设置页那 6 项各画各的。 -->
        <SettingSwitch
          :checked="connected"
          :label="t('sync_switch_label')"
          :text="t('sync_switch_label')"
          test-id="sync-switch"
          @toggle="toggle"
        />
        <!-- 暂停时不给「立即同步」：关了还让你点，点完只能报错（真机第一轮反馈的原话） -->
        <ActionButton v-if="connected" test-id="sync-now" :label="t('sync_action_now')" :busy-label="t('sync_busy_sync')" :busy="summaryBusy" :disabled="busy" tone="primary" @click="runNow" />
      </div>
    </div>

    <!-- 关掉之后的后果写在脸前：不删远端、不清密码、不改地址 -->
    <p v-if="configured && !expanded" class="m-0 mt-2 text-[10px] leading-relaxed text-muted" data-testid="sync-off-hint">{{ t('sync_off_hint') }}</p>

    <button v-if="configured && !expanded" class="mt-3 block bg-transparent p-0 text-[11px] text-muted underline" type="button" data-testid="sync-expand" @click="expanded = true">{{ t('sync_expand') }}</button>

    <!-- ② 没配过（或已展开）：表单 -->
    <template v-if="!configured || expanded">
      <p v-if="!configured" class="m-0 mb-3 text-[11px] leading-relaxed text-muted">{{ t('sync_connect_note') }}</p>
      <p class="m-0 mb-3 text-[10px] leading-relaxed text-muted">{{ t('sync_permission_note') }}</p>

      <label class="block text-[12px]">
        <span class="text-muted">{{ t('options_sync_base_url') }}</span>
        <input v-model="baseUrl" class="mt-1 w-full rounded-control border border-line bg-panel px-2.5 py-1.5 text-[12px] outline-none" type="url" :placeholder="t('sync_placeholder_url')" />
      </label>

      <!-- 落点显示在脸前：双拼那种错肉眼在地址栏里看不出来 -->
      <p v-if="remoteRoot" class="m-0 mt-1 break-all text-[10px] leading-relaxed text-muted" data-testid="sync-remote-path">
        {{ t('sync_remote_path') }}：<span class="font-mono">{{ remoteRoot }}</span>
      </p>

      <!-- ③ 明文确认：只在地址真是 http:// 时出现（渐进披露），不再常驻 -->
      <div v-if="insecure" class="mt-2 rounded-control border-l-[3px] border-warn bg-warn-soft px-3 py-2" data-testid="sync-http-disclose">
        <p class="m-0 text-[11px] leading-relaxed">{{ t('sync_http_title') }}</p>
        <label class="mt-1.5 flex items-start gap-2.5 text-[11px]">
          <input v-model="allowInsecureHttp" class="mt-0.5 accent-brand" type="checkbox" />
          <span>{{ t('options_sync_allow_insecure') }}</span>
        </label>
      </div>

      <!-- 凭据这一格是"连不上"的头号原因：坚果云不接受登录密码，只接受应用密码（真服务器实测）。
           写成一行说明而不是新控件 —— 这颗面板的日常接触面只有摘要行与一颗按钮。 -->
      <p class="m-0 mb-2 text-[10px] leading-relaxed text-muted" data-testid="sync-credential-hint">{{ t('sync_credential_hint') }}</p>

      <div class="mt-3 grid grid-cols-2 gap-3">
        <label class="block text-[12px]">
          <span class="text-muted">{{ t('options_sync_username') }}</span>
          <input v-model="username" class="mt-1 w-full rounded-control border border-line bg-panel px-2.5 py-1.5 text-[12px] outline-none" type="text" autocomplete="off" />
        </label>
        <label class="block text-[12px]">
          <span class="text-muted">{{ t('options_sync_password') }}</span>
          <!-- 密码永远不回显：有值就只显示"已保存"，输入框始终是空的 -->
          <input v-model="password" class="mt-1 w-full rounded-control border border-line bg-panel px-2.5 py-1.5 text-[12px] outline-none" type="password" autocomplete="new-password" :placeholder="panel.hasCredential.value ? t('sync_password_kept') : t('sync_placeholder_password')" />
        </label>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <!-- 一颗：校验 → 要这一个源的权限 → 建目录 → 推第一版。要权限那件必须独占这次点击。 -->
        <ActionButton test-id="sync-connect" :label="configured ? t('sync_action_apply') : t('sync_action_connect')" :busy-label="configured ? t('sync_busy_apply') : t('sync_busy_connect')" :busy="connecting" :disabled="busy" tone="primary" @click="connect" />
        <!-- 「测试连接」不删（§5f B4 的判据靠它：只读、不写任何东西），但它不该和「立即同步」平级 -->
        <ActionButton v-if="configured" test-id="sync-test" :label="t('sync_action_test_only')" :busy-label="t('sync_busy_test')" :busy="testing" :disabled="busy" @click="testOnly" />
        <button v-if="configured" class="mt-1 block bg-transparent p-0 text-[11px] text-muted underline" type="button" data-testid="sync-collapse" @click="expanded = false">{{ t('sync_collapse') }}</button>
      </div>

      <p v-if="!configured" class="m-0 mt-2 text-[10px] leading-relaxed text-muted" data-testid="sync-step-note">{{ t('sync_step_once') }}</p>
    </template>

    <!-- 状态与结果合成一处：原来那两行「同步状态：已是最新」+「没有要上传的…」说的是同一件事 -->
    <p v-if="!configured || expanded" class="m-0 mt-3 text-[11px] text-muted">
      {{ t('sync_status_label') }}：<strong>{{ t(statusLabel[status]) }}</strong>
      · {{ t('sync_last_sync') }}：{{ lastSync }}
    </p>
    <!--
      「这一轮是谁叫醒的」只在展开时出现：它是给用户**核对节拍是否存在**的（页面心跳 / 本机改动 /
      后台定时器 / 启动 / 手动），不是每次都要看的读数。放摘要行会变成第四行小字。
    -->
    <p v-if="expanded && lastTriggerLine" class="m-0 mt-0.5 text-[10px] text-muted" data-testid="sync-last-trigger">
      {{ lastTriggerLine }}
    </p>
    <!--
      结果那一行：语气靠颜色 + 一个符号双通道表达（色盲与关动画下还得能分辨），
      `role=status` + `aria-live=polite` 让读屏在动作完成时念出来 —— 这行字是用户判断
      "我刚才那一下到底成没成"的唯一依据，不能只是灰字挂在那。
    -->
    <p
      v-if="panel.notice.value"
      class="m-0 mt-1 text-[11px]"
      :class="tone === 'bad' ? 'font-bold text-danger' : tone === 'ok' ? 'text-brand' : 'text-muted'"
      aria-live="polite"
      data-testid="sync-notice"
      role="status"
    >
      <span aria-hidden="true">{{ tone === 'bad' ? '✕' : tone === 'ok' ? '✓' : '·' }}</span>
      {{ noticeText }}
    </p>
    <!--
      「本轮未发起」必须当场配一句"那什么时候才会发起"。
      少了这一行，被判据拒掉的「立即同步」和一颗坏掉的按钮长得一模一样，
      而用户分辨不了的代价就是他多发一轮反馈 —— 这次那两条真机投诉就是这么来的。
    -->
    <p v-if="skipHint" class="m-0 mt-0.5 text-[10px] text-muted" data-testid="sync-next-check">
      {{ nextCheckLine }}
    </p>
  </section>
</template>
