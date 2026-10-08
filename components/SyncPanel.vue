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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import ActionButton from '@/components/ActionButton.vue';
import SettingSwitch from '@/components/SettingSwitch.vue';
import { useSyncPanel, type SyncNotice } from '@/composables/useSync';
import { isInsecureHttp, parseBaseUrl, remoteRootUrl } from '@/core/domain/remote-layout';
import { storagePort } from '@/shared/services';
import { t, type MessageKey } from '@/shared/i18n';
import type { WebDavAdminPort, WebDavPort } from '@/core/ports/webdav';
import type { SyncAttempt } from '@/core/application/sync-engine';
import type { SuspiciousCounts } from '@/core/domain/safety';
import type { SyncEventKind, SyncEventRecord, SyncStatus, SyncTriggerReason } from '@/shared/types';

/**
 * `webdav` 只有测试会传（真环境一律用真的 fetch 适配器）。
 * 传进来的理由是 `connect()` 一次点击就走到发请求那一步 —— 界面用例要么打真网络，
 * 要么只能测到一半。默认值是 `undefined`，`useSyncPanel` 里才决定用哪个实现。
 */
const props = defineProps<{ webdav?: WebDavPort & WebDavAdminPort }>();

const panel = useSyncPanel({ webdav: props.webdav });

const baseUrl = ref('');
const username = ref('');
const password = ref('');
const allowInsecureHttp = ref(false);
/** 已连接之后表单默认收起；这颗只是"展开改设置"的开关，不是功能开关。 */
const expanded = ref(false);

/**
 * 本机设备名那一行。`deviceName` 是**输入框里的那一串**，
 * 落盘之后会被回填成规范化过的值（见 `commitDeviceName`）。
 */
const deviceName = ref('');

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
  // 这一行**不看 config**：档案是懒生成的，永远有一份，而下面那三格读的是同步配置。
  deviceName.value = panel.deviceProfile.value?.name ?? '';
  const config = panel.config.value;
  if (!config) return;
  baseUrl.value = config.baseUrl;
  username.value = config.username;
  allowInsecureHttp.value = config.allowInsecureHttp;
});

/**
 * 改名：失焦或回车各走这一次。
 *
 * 回填读的是**返回值**而不是用户刚打的那串 —— 规范化（trim / 空名回退默认 / 40 字截断）
 * 只有存储层那一份实现，界面重算一遍就是第二套规范。用户因此在框里看见"名字现在真的叫什么"，
 * 而不是一个看起来存好了、对面收到的却是另一个的说法。
 *
 * 这里**不**标脏、也**不**触发同步：设备名不进 `state`、不参与 checksum，
 * 跟着推一版内容完全相同的东西只是白敲门（既有约定 §7.1，判据由界面用例钉着）。
 */
async function commitDeviceName(): Promise<void> {
  const profile = await panel.renameDevice(deviceName.value);
  deviceName.value = profile.name;
}

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
  sync_notice_suspicious_gone: 'neutral',
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

/**
 * 塌陷闸的出口：「我核对过了，照这一版上传」。
 *
 * 授权与推送**分成两步**，而且必须分开 —— 授权只写账本，推送仍走 `panel.syncNow()`
 * 那条唯一入口，所以它照样过退避与 in-flight，这颗按钮不是绕过判据的后门。
 * 它解的是另一个死结：闸每轮都成立、于是那一版永远推不出去。
 *
 * 拿不到可确认的那一版时**不推**：那说明后台已经跑过一轮、内容也变了，
 * 照着旧授权推上去等于替用户确认一版他从没看过数字的内容。
 */
async function pushAnyway(): Promise<void> {
  skipHint.value = false;
  const armed = await panel.acknowledgeSuspicious();
  if (!armed) {
    setNotice('sync_notice_suspicious_gone');
    await panel.load();
    return;
  }
  await runNow();
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

// ---------------------------------------------------------------------------
// 同步日志：这一屏最底部的折叠区。
//
// 三条形状上的决定，都是这条线自己的理由：
// 1. **默认收起 + 展开才读**。它是一份历史，不是读数：常驻就等于在已经很短的同步区里
//    再塞进 100 行小字，而多数时候用户只想看一眼"上次同步是几点"（那已经在状态行了）。
// 2. **翻译在渲染时做**。存储里那串 `R12` / `err:network` 是判别值，换语言不会重写旧记录，
//    所以现翻是"旧日志跟着新语言走"的唯一办法。
// 3. **认不出来的片段原样兜底**，不留空白：宁可显示一串工程师能拿去排查的 token，
//    也不要一行看起来成功、实际上是空的记录 —— 那是比 raw 更坏的失败形状。
// ---------------------------------------------------------------------------

const logsOpen = ref(false);
const logs = ref<SyncEventRecord[]>([]);
/** 展开期间才订阅：收起之后不该留着一条 watcher（它与 `panel.load()` 那条是两条独立订阅）。 */
let stopLogWatch: (() => void) | undefined;

async function refreshLogs(): Promise<void> {
  logs.value = await storagePort.listSyncEvents();
}

async function toggleLogs(): Promise<void> {
  logsOpen.value = !logsOpen.value;
  if (!logsOpen.value) {
    stopLogWatch?.();
    stopLogWatch = undefined;
    return;
  }
  await refreshLogs();
  // 订阅账本而不是日志本身：引擎每一轮的收口都会写 `syncMeta`，而事件写在**它之前**
  // （见 sync-engine 的注释），所以这一拍读回来的一定包含这一轮。
  stopLogWatch ??= storagePort.watchSyncMeta(() => {
    void refreshLogs();
  });
}

onBeforeUnmount(() => {
  stopLogWatch?.();
  stopLogWatch = undefined;
});

/** 存储是 `at` 升序（最旧在前），界面要的是最新在上 ⇒ 在这里翻一次，不改存储秩序。 */
const newestLogs = computed<SyncEventRecord[]>(() => [...logs.value].reverse());

/**
 * kind 的符号。与结果行同一套双通道（符号 + 文字），色盲或关掉颜色区分之后仍然读得出是哪类。
 * `conflict` 用 `⚠`、`suspicious` 用 `⚡`：两者都要人做事，但后者是"数字对不上"而不是"实体撞车"。
 */
const kindSymbol: Record<SyncEventKind, string> = {
  push: '↑',
  pull: '↓',
  conflict: '⚠',
  suspicious: '⚡',
  error: '✕',
};

const kindLabel: Record<SyncEventKind, MessageKey> = {
  push: 'sync_event_push',
  pull: 'sync_event_pull',
  conflict: 'sync_event_conflict',
  suspicious: 'sync_event_suspicious',
  error: 'sync_event_error',
};

/**
 * `err:<判别值>` → 文案。这张表**必须穷尽引擎写得出来的那些值**（`sync-engine.ts` 与
 * `core/ports/webdav.ts` 的 `WebDavErrorKind`），漏一个就是屏幕上出现 raw token。
 * 前三条复用设置页已有的那三句：同一个原因在"结果行"和"日志"里必须是同一句话。
 */
const errLabel: Record<string, MessageKey> = {
  'bad-url': 'sync_err_bad_url',
  'no-credential': 'sync_err_need_password',
  unknown: 'sync_err_generic',
  credentials: 'sync_event_err_credentials',
  forbidden: 'sync_event_err_forbidden',
  'not-found': 'sync_event_err_not_found',
  'parent-conflict': 'sync_event_err_parent_conflict',
  'precondition-failed': 'sync_event_err_precondition',
  'unsupported-method': 'sync_event_err_method',
  server: 'sync_event_err_server',
  network: 'sync_event_err_network',
  'bad-response': 'sync_event_err_response',
  'durable-snapshot': 'sync_event_err_local_write',
  // 原因尾巴（`groups-not-array` 这种）留在存储里给排查用，屏幕上说人话的那一句。
  'invalid-local': 'sync_event_err_local_state',
};

/** 单个判别值 → 一句人话。认不出就原样返回（兜底，不留空白）。 */
function translateToken(token: string): string {
  if (token === 'suspicious') return t('sync_event_summary_suspicious');
  const revision = /^R(\d+)$/.exec(token);
  if (revision) return t('sync_event_summary_revision', { n: revision[1] as string });
  const merged = /^merged:(\d+)$/.exec(token);
  if (merged) return t('sync_event_summary_merged', { n: merged[1] as string });
  const conflicts = /^conflicts:(\d+)$/.exec(token);
  if (conflicts) return t('sync_event_summary_conflicts', { n: conflicts[1] as string });
  const err = /^err:([a-z][a-z-]*)(?::.*)?$/.exec(token);
  const key = err ? errLabel[err[1] as string] : undefined;
  return key ? t(key) : token;
}

/** summary 是 `·` 分隔的若干判别值（`R12 · merged:3`），逐段翻译后再拼回去。 */
function summaryText(event: SyncEventRecord): string {
  const summary = event.summary;
  if (!summary) return '';
  return summary
    .split('·')
    .map((part) => translateToken(part.trim()))
    .filter((part) => part !== '')
    .join(' · ');
}

/** 没有 summary 的记录就不渲染那一段：一个空 `<span>` 在 flex 行里会顶出一个可见的空隙。 */
function hasSummary(event: SyncEventRecord): boolean {
  return summaryText(event) !== '';
}
</script>

<template>
  <section class="mb-6 rounded-card border border-line bg-panel p-5">
    <h2 class="m-0 mb-3 text-[11px] font-extrabold tracking-widest text-muted">{{ t('options_sync_section') }}</h2>

    <!--
      本机设备名：标题正下方，**与"配没配 WebDAV"无关**地一直在这一屏。
      放在顶上而不是摘要行里，是因为它的读者是"另一台设备上的那个人"：这台机器改了名，
      对面要等到下一次推送才看得见，而这一屏是用户唯一会来看自己这台叫什么的地方。
      控件是一颗普通 text 输入 + 失焦/回车提交，不是勾选框（既有约定 在这屏明令禁 checkbox），
      也不是一颗新动作按钮 —— 它不发起任何网络动作。
    -->
    <div class="mb-3" data-testid="device-name-row">
      <label class="block text-[12px]">
        <span class="text-muted">{{ t('device_name_label') }}</span>
        <input
          v-model="deviceName"
          class="mt-1 w-full rounded-control border border-line bg-panel px-2.5 py-1.5 text-[12px] outline-none"
          type="text"
          autocomplete="off"
          data-testid="device-name-input"
          @blur="commitDeviceName"
          @keyup.enter="commitDeviceName"
        />
      </label>
      <p class="m-0 mt-0.5 text-[10px] leading-relaxed text-muted" data-testid="device-name-hint">{{ t('device_name_hint') }}</p>
    </div>

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
          <input v-model="username" class="mt-1 w-full rounded-control border border-line bg-panel px-2.5 py-1.5 text-[12px] outline-none" type="text" autocomplete="off" data-testid="sync-username" />
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
      塌陷闸的出口。在此之前 `suspicious_change` 是一句提示加一个死结：
      闸每轮都成立、那一版永远推不出去，用户唯一的出路是撤回删除或清空远端历史
      （后者正是这道闸立项要防的事）。
      只在**这个状态**下出现，点完账本转 pending、按钮随即消失 ⇒ 天然防连点。
      tone 用默认的 ghost：它是"我确认过了"，不该和「立即同步」抢主色。
    -->
    <div v-if="status === 'suspicious_change'" class="mt-2" data-testid="sync-suspicious-exit">
      <ActionButton
        test-id="sync-push-anyway"
        :label="t('sync_action_push_anyway')"
        :busy-label="t('sync_busy_sync')"
        :busy="summaryBusy"
        :disabled="busy"
        @click="pushAnyway"
      />
      <!-- 后果写在脸前（同 既有约定 那条口径）：远端会变成这一版，但旧版本仍在历史里可恢复 -->
      <p class="m-0 mt-1 text-[10px] leading-relaxed text-muted" data-testid="sync-push-anyway-hint">
        {{ t('sync_push_anyway_hint') }}
      </p>
    </div>
    <!--
      「本轮未发起」必须当场配一句"那什么时候才会发起"。
      少了这一行，被判据拒掉的「立即同步」和一颗坏掉的按钮长得一模一样，
      而用户分辨不了的代价就是他多发一轮反馈 —— 这次那两条真机投诉就是这么来的。
    -->
    <p v-if="skipHint" class="m-0 mt-0.5 text-[10px] text-muted" data-testid="sync-next-check">
      {{ nextCheckLine }}
    </p>

    <!--
      同步日志：这一屏最底部的一条**排查面**，默认收起。
      折叠内核是 `<button aria-expanded>`，不是勾选框 —— 既有约定 明令这屏不许再有 checkbox
      （两颗勾选分不清是这次要修的头号原因），而它本来也不是开关，是一次展开动作。
    -->
    <div class="mt-4 border-t border-line pt-3" data-testid="sync-logs">
      <button
        class="bg-transparent p-0 text-[11px] text-muted underline"
        type="button"
        :aria-expanded="logsOpen ? 'true' : 'false'"
        data-testid="sync-logs-toggle"
        @click="toggleLogs"
      >{{ logsOpen ? '▾' : '▸' }} {{ t('sync_logs_toggle') }}</button>

      <template v-if="logsOpen">
        <p v-if="newestLogs.length === 0" class="m-0 mt-2 text-[10px] text-muted" data-testid="sync-logs-empty">
          {{ t('sync_logs_empty') }}
        </p>
        <!--
          ★ 高度有上限，超出在**这一块里面**滚（2026-10-08 真机：环 100 被 60 秒一条心跳灌满，
          「同步日志」把整屏设置页拉成一条无限长的清单）。
          为什么不改成"只显示最近 20 条 + 展开"：这一屏的用途是排查，用户要的是"往回翻得动"，
          再加一层展开状态就多一个开关、一句文案，而它解决的是同一个问题的一半。
          `overscroll-contain` 不是修饰：没有它，滚到这块的尽头会**带着整页一起跳**，
          看着像列表自己乱了序。`tabindex=0` 是给键盘的 —— 不可聚焦的滚动区键盘滚不动（WCAG 2.1.1）。
        -->
        <ul
          v-else
          class="m-0 mt-2 max-h-64 list-none space-y-1 overflow-y-auto overscroll-contain p-0 pr-2"
          tabindex="0"
          data-testid="sync-logs-list"
        >
          <li
            v-for="event in newestLogs"
            :key="event.id"
            class="flex flex-wrap items-baseline gap-x-2 text-[10px]"
            :class="event.success ? 'text-muted' : 'font-bold text-danger'"
            data-testid="sync-log-row"
          >
            <span class="font-mono">{{ new Date(event.at).toLocaleTimeString() }}</span>
            <span aria-hidden="true">{{ kindSymbol[event.kind] }}</span>
            <span>{{ t(kindLabel[event.kind]) }}</span>
            <span v-if="event.trigger" data-testid="sync-log-trigger">{{ t(triggerLabel[event.trigger]) }}</span>
            <span v-if="hasSummary(event)" data-testid="sync-log-summary">{{ summaryText(event) }}</span>
          </li>
        </ul>
      </template>
    </div>
  </section>
</template>
