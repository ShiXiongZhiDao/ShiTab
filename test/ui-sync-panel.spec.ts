/**
 * WebDAV 同步面板的界面用例（形状见 既有约定：一颗「连接并同步」+ 配好后折叠成一行摘要）。
 *
 * 两件纪律在这份文件里反复用到，别改绿了事：
 * 1. **断言真文案，不断 i18n key**（`test/setup.ts` 读的是真的 en/messages.json）。
 *    屏幕上印出 `sync_notice_saved` 或「结果：ok」这种内部标识，正是真机第一轮反馈骂过的东西。
 * 2. **每条否定断言都配一条正向对照**。"关掉之后什么都没删"必须同时钉住
 *    "关掉之前远端确实有东西" —— 空对空的绿在这类用例里太容易写出来了。
 *
 * 端口是注入的假件（`props.webdav`）：`connect()` 一次点击就会走到发请求那一步，
 * 不注入的话要么打真网络（不可接受），要么只能测到"没同步的那一半"（旧用例正是这样漏的）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import SyncPanel from '@/components/SyncPanel.vue';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { createFakeWebDav, FAKE_CREDENTIAL } from '@/infrastructure/testing/fake-webdav';
import type { FakeWebDavFault, FakeWebDavPort } from '@/infrastructure/testing/fake-webdav';
import type { StoragePort } from '@/core/ports/storage';
import { softDeleteGroup } from '@/core/application/delete-model';
import { groupFixture, savedTabFixture } from './fixtures';

const BASE = 'https://dav.example.com/dav';
const LAND = `${BASE}/ShiXiongZhiDao/ShiTab/`;

/**
 * `fakeBrowser.permissions.request` 是"未实现即抛"（实测：`not implemented: mock the function yourself`），
 * 而面板每次连接的第一步就是要权限。桩在**用例内**打，不塞进 test/setup.ts。
 */
function stubPermissions(granted: boolean) {
  const request = vi.fn(async () => granted);
  (fakeBrowser.permissions.request as unknown) = request;
  return request;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 「连接并同步」一次点击背后是**十几个 await**（要权限 → 落盘 → 读远端 → 合并 → 落耐久快照 →
 * PUT 快照 → PUT manifest）。两次 `flush()` 只够跑到前半段，于是断言会看到"远端还是空的"，
 * 而那看起来像是产品 bug。这里轮询到条件成立为止，超时就当场报错 —— 不靠"多 sleep 两下"碰运气。
 */
/**
 * 等到条件成立为止，**按墙上时间算预算，不按"轮询次数"**。
 *
 * 这条是修 flaky 的：一次点击「立即同步」背后是十几个 await + 一次 gzip（`CompressionStream`
 * 在别的线程上跑）。按"80 个宏任务"当预算时，冷启动那一轮（模块要 transform、Wasm 要预热）
 * 就是会输 —— 实测同一个文件第一次跑红、第二次跑绿。改成时间预算之后，慢只是慢，不会假红。
 */
async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 12_000,
  diagnose?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  // 超时时把现场打出来。没有这一段，"等不到"只能告诉我有东西没到，
  // 而全量跑下偶发的那种红需要知道**当时**端口收到过几个请求、屏幕上挂着哪句结果。
  throw new Error(`等不到：${label}（${timeoutMs}ms 内）${diagnose ? ` — ${diagnose()}` : ''}`);
}

/**
 * notice 那一行是 `v-if` 的，元素不存在时 `wrapper.find(...).text()` **直接抛**
 * （"Cannot call text on an empty DOMWrapper"），而不是返回空串。
 * 轮询里必须走这个函数，否则"等文案出现"的循环第一轮就把测试弄炸。
 */
function noticeText(wrapper: VueWrapper): string {
  const line = wrapper.find('[data-testid="sync-notice"]');
  return line.exists() ? line.text() : '';
}

let storage: StoragePort;

function fake(faults: FakeWebDavFault[] = []): FakeWebDavPort {
  return createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL, faults });
}

function mountPanel(webdav: FakeWebDavPort = fake()): VueWrapper {
  const wrapper = mount(SyncPanel, { props: { webdav } });
  mounted.push(wrapper);
  return wrapper;
}

/**
 * 挂过但没有卸载的面板 = 串台的主要来源。
 *
 * 每条用例结束时会有一次同步还挂在半空（`until` 只看"端口收到过请求"，不看"这一轮跑完没跑完"），
 * 下一条用例的 `storage.local.clear()` 就发生在它中间 —— 那条陈链会把 `syncMeta` 写成 error，
 * 于是新用例一点「立即同步」就被**退避**挡在本地，`calls=[]` + "Sync failed"。
 * 全量并行跑时命中，单跑一个文件就看不到。所以每条用例结束前：等到没有按钮在转圈，再卸载。
 */
const mounted: VueWrapper[] = [];

async function quiet(wrapper: VueWrapper): Promise<void> {
  const spinning = () => wrapper.find('[aria-busy="true"]').exists();
  const deadline = Date.now() + 8_000;
  while (spinning() && Date.now() < deadline) await flush();
}

async function settleAll(): Promise<void> {
  for (const wrapper of mounted.splice(0)) {
    await quiet(wrapper);
    wrapper.unmount();
  }
}

async function seedConfig(overrides: Partial<Awaited<ReturnType<StoragePort['getWebDavConfig']>>> = {}) {
  await storage.setWebDavConfig({
    enabled: true,
    baseUrl: BASE,
    username: FAKE_CREDENTIAL.username,
    allowInsecureHttp: false,
    // 真实连接过的那份配置一定有 `lastTestedAt`，而"摘要 vs 表单"就是靠它分的
    // （填了但第一次没连上的必须留在表单，见 SyncPanel 里 configured 的注释）。
    lastTestedAt: 1_700_000_000_000,
    ...overrides,
  });
  await storage.setSyncCredential(FAKE_CREDENTIAL.password);
  return storage;
}

async function seedBlank() {
  await storage.setWebDavConfig({ enabled: false, baseUrl: '', username: '', allowInsecureHttp: false });
}

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  storage = createStoragePort();
  await storage.heal();
});

afterEach(async () => {
  await settleAll();
});

describe('未连接：三字段一颗按钮', () => {
  it('没配过时只有一颗「连接并同步」，没有「立即同步」也没有同步开关', async () => {
    await seedBlank();
    const wrapper = mountPanel();
    await flush();

    expect(wrapper.find('[data-testid="sync-connect"]').text()).toBe('Connect & sync');
    // 「立即同步」与「同步」开关属于已连接那一屏；这里出现就是两屏叠在一起了
    expect(wrapper.find('[data-testid="sync-now"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="sync-switch"]').exists()).toBe(false);
    // 「测试连接」也不再和主按钮并列（它降到展开区，见下面那组用例）
    expect(wrapper.find('[data-testid="sync-test"]').exists()).toBe(false);
  });

  it('控件数：1 颗按钮 + 3 个输入 + 0 颗常驻勾选', async () => {
    await seedBlank();
    const wrapper = mountPanel();
    await flush();

    expect(wrapper.findAll('button')).toHaveLength(1);
    expect(wrapper.findAll('input')).toHaveLength(3);
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('那句权限承诺是用户看得见的字，钉住它（改了措辞就要当轮改这条）', async () => {
    await seedBlank();
    const wrapper = mountPanel();
    await flush();

    expect(wrapper.text()).toContain('used only to reach the WebDAV address you type above');
    expect(wrapper.text()).toContain('not used to read the content of ordinary web pages');
  });

  it('凭据那一格上方写着"要应用密码"：连不上的头号原因就是拿登录密码填这里', async () => {
    await seedBlank();
    const wrapper = mountPanel();
    await flush();

    const hint = wrapper.find('[data-testid="sync-credential-hint"]');
    expect(hint.exists(), '这条说明不见了 ⇒ 用户只能撞 401 才知道坚果云要的是应用密码').toBe(true);
    expect(hint.text()).toContain('app password');
    expect(hint.text()).toContain('account email');
    // 它是一行说明，不是第四颗输入框、也不是第二颗按钮（上面那条控件数用例钉的是同一件事）
    expect(wrapper.findAll('input')).toHaveLength(3);
    expect(wrapper.findAll('button')).toHaveLength(1);
  });

  /** 这是"点一次 = 五件事"的那一条：配置落盘**并且**远端真的收到一份快照 + 一份 manifest。 */
  it('点「连接并同步」⇒ 存配置、要权限、真的推一份上去（不需要第二次点击）', async () => {
    await seedBlank();
    await storage.putGroup(groupFixture('会话一', [savedTabFixture('g1', 't1', 0)], { id: 'g1' }));
    const request = stubPermissions(true);
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('input[type="url"]').setValue(BASE);
    await wrapper.find('input[type="text"]').setValue(FAKE_CREDENTIAL.username);
    await wrapper.find('input[type="password"]').setValue(FAKE_CREDENTIAL.password);
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await until(() => remote.files.size > 0, '远端收到第一份快照');

    const saved = await storage.getWebDavConfig();
    expect(saved.enabled).toBe(true);
    expect(saved.baseUrl).toBe(BASE);
    expect(saved.lastTestedAt).toBeTypeOf('number');
    expect(request).toHaveBeenCalledTimes(1);
    // 正向对照：少了这两行，"点了连接但根本没同步"也能全绿（配置那半确实是好的）
    expect([...remote.files.keys()].filter((url) => url.includes('/snapshots/'))).toHaveLength(1);
    expect([...remote.files.keys()].filter((url) => url.includes('/manifests/'))).toHaveLength(1);
    // 20s 而不是默认 5s：整条链（要权限 → 落盘 → 读远端 → gzip → PUT×2）在 28 个文件并行时
    // 就是要好几秒。第一次全量跑我就是被这个超时报成"产品坏了"，其实是测试自己饿死。
  }, 20_000);

  /** 顺序是平台钉死的：先要权限，拿到了才落盘。 */
  it('权限被拒 ⇒ 配置与密码都不写盘，也没往远端发任何东西', async () => {
    await seedBlank();
    const request = stubPermissions(false);
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('input[type="url"]').setValue(BASE);
    await wrapper.find('input[type="password"]').setValue(FAKE_CREDENTIAL.password);
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await flush();

    expect((await storage.getWebDavConfig()).enabled).toBe(false);
    expect((await storage.getWebDavConfig()).baseUrl).toBe('');
    expect(await storage.getSyncCredential()).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(remote.calls).toHaveLength(0);
  });

  it('密码永远不回显：存过之后框是空的，占位符说的是"留空则不改动"', async () => {
    // lastTestedAt 清空 = "填过但从没连成功"，这种状态必须停在表单上（见 configured 的注释）
    await seedConfig({ enabled: false, lastTestedAt: undefined });
    const wrapper = mountPanel();
    await flush();

    const pwd = wrapper.find('input[type="password"]').element as HTMLInputElement;
    expect(pwd.value).toBe('');
    expect(pwd.placeholder).toBe('Saved — leave blank to keep it');
  });

  /**
   * 明文确认改成**渐进披露**：填 https 的人永远不该再看见那颗勾
   * （真机抱怨的"两个打勾分不清"里的一条）。
   */
  it('填 https 时屏幕上没有任何勾选框；改成 http 才出现明文确认', async () => {
    await seedBlank();
    stubPermissions(true);
    const wrapper = mountPanel();
    await flush();

    await wrapper.find('input[type="url"]').setValue(BASE);
    expect(wrapper.find('[data-testid="sync-http-disclose"]').exists()).toBe(false);
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);

    await wrapper.find('input[type="url"]').setValue('http://192.0.2.10:5005/dav');
    expect(wrapper.find('[data-testid="sync-http-disclose"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('plain text');
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(1);
  });

  it('http 地址没勾明文确认 ⇒ 拒绝连接，且一次权限都不申请', async () => {
    await seedBlank();
    const request = stubPermissions(true);
    const wrapper = mountPanel();
    await flush();

    await wrapper.find('input[type="url"]').setValue('http://192.0.2.10:5005/dav');
    await wrapper.find('input[type="password"]').setValue('p');
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await flush();

    expect((await storage.getWebDavConfig()).baseUrl).toBe('');
    expect(request).not.toHaveBeenCalled();
    // 真文案是「plain http」（sync_err_insecure），披露框里那句才是「plain text」
    expect(wrapper.find('[data-testid="sync-notice"]').text()).toContain('plain http');
  });

  it('勾上之后同一个 http 地址就能连（判据是那个勾，不是地址本身）', async () => {
    await seedBlank();
    stubPermissions(true);
    const wrapper = mountPanel();
    await flush();

    await wrapper.find('input[type="url"]').setValue('http://192.0.2.10:5005/dav');
    await wrapper.find('input[type="password"]').setValue('p');
    await wrapper.find('[data-testid="sync-http-disclose"] input[type="checkbox"]').setValue(true);
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await flush();

    expect((await storage.getWebDavConfig()).baseUrl).toBe('http://192.0.2.10:5005/dav');
  });

  /** 空密码 + 从没存过 ⇒ 拒。放行会造出"配好了但永远 401"，那是用户最难自己诊断的形状。 */
  it('从没存过密码却留空 ⇒ 拒绝连接，屏幕上说的是"要填密码"', async () => {
    await seedBlank();
    stubPermissions(true);
    const wrapper = mountPanel();
    await flush();

    await wrapper.find('input[type="url"]').setValue(BASE);
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await flush();

    expect((await storage.getWebDavConfig()).baseUrl).toBe('');
    expect(wrapper.find('[data-testid="sync-notice"]').text()).toContain('password');
  });

  it('留空表示"不改密码"，前提是之前存过（否则改个 URL 就得重打密码）', async () => {
    await seedConfig({ enabled: false, lastTestedAt: undefined, baseUrl: 'https://old.example/dav' });
    stubPermissions(true);
    const wrapper = mountPanel();
    await flush();

    await wrapper.find('input[type="url"]').setValue('https://new.example/dav');
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await flush();

    expect((await storage.getWebDavConfig()).baseUrl).toBe('https://new.example/dav');
    expect(await storage.getSyncCredential()).toEqual({ password: FAKE_CREDENTIAL.password });
  });
});

describe('已连接：一行摘要，不是一张表单', () => {
  it('默认收起：1 颗主按钮 + 1 颗同步开关 + 1 个展开入口，输入框为 0', async () => {
    await seedConfig();
    const wrapper = mountPanel();
    await flush();

    expect(wrapper.find('[data-testid="sync-now"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sync-switch"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sync-expand"]').exists()).toBe(true);
    expect(wrapper.findAll('input')).toHaveLength(0);
    // 「连接并同步」不该在已连接时还杵在那
    expect(wrapper.find('[data-testid="sync-connect"]').exists()).toBe(false);
    // 摘要行要看得见主机名、状态与落点，否则"连着哪台"变成要点开才知道
    expect(wrapper.text()).toContain('dav.example.com');
    expect(wrapper.text()).toContain('Connected');
    expect(wrapper.text()).toContain(LAND);
  });

  it('点「改设置」才出现三字段与「只测连接」（这颗按钮不该和「立即同步」平级）', async () => {
    await seedConfig();
    const wrapper = mountPanel();
    await flush();

    expect(wrapper.find('[data-testid="sync-test"]').exists()).toBe(false);
    await wrapper.find('[data-testid="sync-expand"]').trigger('click');

    expect(wrapper.findAll('input[type="url"], input[type="text"], input[type="password"]')).toHaveLength(3);
    expect(wrapper.find('[data-testid="sync-test"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sync-test"]').text()).toBe('Test connection only');
    expect(wrapper.find('[data-testid="sync-connect"]').text()).toBe('Apply & reconnect');
  });

  /** 关掉同步的语义必须写在脸前，并且是真的什么都没删。 */
  it('关掉「同步」开关 ⇒ 摘要留在原地、标成已暂停，远端与密码都还在', async () => {
    await seedConfig();
    // 先放一条会话：本地全空时 runSync 会走 `no-changes` 早退，"远端收到东西"这件事
    // 就根本不会发生 —— 那会让这条用例变成"看引擎心情"的 flaky（实测过）。
    await storage.putGroup(groupFixture('会话一', [savedTabFixture('g1', 't1', 0)], { id: 'g1' }));
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();
    // 正向对照：先真的推一份，"关掉之后远端还在"这句话才有内容
    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(
      () => [...remote.files.keys()].some((url) => url.includes('/snapshots/')),
      '第一份快照落上远端',
      12_000,
      () =>
        `calls=${JSON.stringify(remote.calls.map((call) => call.method))} notice="${noticeText(wrapper)}" enabled=${String(
          wrapper.find('[data-testid="sync-switch"]').exists(),
        )}`,
    );
    const pushed = [...remote.files.keys()];
    expect(pushed.some((url) => url.includes('/snapshots/'))).toBe(true);

    await wrapper.find('[data-testid="sync-switch"]').trigger('click');
    // 轮询的是**这句新文案**，不是"notice 存在"：上一轮同步的文案还挂在那儿，
    // 用"存在"当条件会立刻成立，然后断到旧文案。
    await until(
      () => noticeText(wrapper).includes('Nothing was deleted'),
      '关掉之后那句"什么都没删"',
    );

    expect((await storage.getWebDavConfig()).enabled).toBe(false);
    expect([...remote.files.keys()]).toEqual(pushed);
    expect(await storage.getSyncCredential()).toEqual({ password: FAKE_CREDENTIAL.password });
    // 开关不能跟着消失：退回表单就等于"关掉之后打不开自己"（真做错过一次，用例钉住）
    expect(wrapper.find('[data-testid="sync-switch"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sync-paused"]').text()).toBe('Paused');
    // 暂停时不给「立即同步」：关了还让你点，点完只能报错
    expect(wrapper.find('[data-testid="sync-now"]').exists()).toBe(false);
  }, 20_000);

  it('关掉的后果那一行在已连接时就看得见，不用等出事', async () => {
    await seedConfig();
    const wrapper = mountPanel();
    await flush();
    expect(wrapper.find('[data-testid="sync-off-hint"]').text()).toContain('never deleted on its own');
  });

  /**
   * 停在「检测到异常变化」时那句提示要给出**四个数**（本机/服务器 × 标签组/记录）。
   *
   * 只说"少得多"用户没法判断这是误报还是真删了（2026-10-06 真机反馈），而条数是他唯一能
   * 自己核对的东西。所以这条断言盯的是**渲染出来的那句人话**，不是 outcome 里的字段 ——
   * 字段有值但没上屏，用户看到的还是原来那句话。
   *
   * 走真塌陷那一档：先推 25 条，再带墓碑删光 ⇒ 合并结果仍比云端少 ⇒ 闸停住。
   * （不带墓碑的那种"本机少"已经不会停在这里了，见 既有约定。）
   */
  it('停在异常变化时，那句提示给出本机与服务器的条数', async () => {
    await seedConfig();
    for (let index = 0; index < 25; index += 1) {
      const id = `g${index}`;
      await storage.putGroup(
        groupFixture(`会话 ${index}`, [savedTabFixture(id, `${id}-t0`, 0)], { id, sortOrder: index, updatedAt: 1_700_000_000_000 }),
      );
    }
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(() => [...remote.files.keys()].some((url) => url.includes('/snapshots/')), '第一份快照落上远端', 20_000);

    for (let index = 0; index < 25; index += 1) {
      await softDeleteGroup({ storage }, { groupId: `g${index}`, reason: 'user-delete', at: Date.now() });
    }
    // 「立即同步」也要过 60 秒拉取间隔（既有约定 用户拍的 Q2b）：不清节拍第二次只会拿到"本轮未发起"
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({ ...meta, lastSyncAt: undefined, nextAttemptAt: undefined, dirtySinceAt: undefined });

    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(() => noticeText(wrapper).includes('Unusual change detected'), '异常变化那句提示', 20_000);

    const line = noticeText(wrapper);
    expect(line).toContain('0 sessions and 0 records');
    expect(line).toContain('25 sessions and 25 records');
    // 占位符漏在屏幕上就是这次改动自己的失败形状：消息里有 `__x__`，UI 忘了传数字就会原样印出来
    expect(line).not.toContain('__');
  }, 40_000);

  it('开着「同步」再点一次 ⇒ 真的又走一轮，而不是只改配置', async () => {
    await seedConfig();
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();
    await wrapper.find('[data-testid="sync-switch"]').trigger('click');
    await flush();
    const offCalls = remote.calls.length;

    await wrapper.find('[data-testid="sync-switch"]').trigger('click');
    await until(() => remote.calls.length > offCalls, '重新打开后真的又走了一轮');

    expect((await storage.getWebDavConfig()).enabled).toBe(true);
    expect(remote.calls.length).toBeGreaterThan(offCalls);
  }, 20_000);

  /**
   * 连接成功但同步失败时说的是"已连接，这次同步没完成"，不是"地址错了"。
   * 绑成一个错误会让人去查重抄一遍的地址，而真因可能只是网盘那边 503。
   */
  it('配置存下了、同步那一步失败 ⇒ 文案分开，且配置不回滚', async () => {
    await seedBlank();
    stubPermissions(true);
    const remote = fake([{ status: 503, method: 'PUT' }]);
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('input[type="url"]').setValue(BASE);
    await wrapper.find('input[type="password"]').setValue(FAKE_CREDENTIAL.password);
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await until(
      () => noticeText(wrapper).includes('Connected — but this sync did not finish'),
      '已连接但同步失败的那句文案',
    );
    // 配置不回滚：这一步没断言的话，"失败就当作什么都没发生"的实现也能全绿
    expect((await storage.getWebDavConfig()).baseUrl).toBe(BASE);
  }, 20_000);

  it('状态那一行不印内部判别值（idle / suspicious_change 都不许上屏）', async () => {
    await seedConfig();
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({ ...meta, status: 'suspicious_change' });
    const wrapper = mountPanel();
    await flush();

    expect(wrapper.text()).toContain('Unusual change detected');
    for (const literal of ['suspicious_change', 'idle']) expect(wrapper.text()).not.toContain(literal);
  });
});

/**
 * 把假端口的某几个方法挂住，用来观察"请求还在飞"那一瞬间的界面。
 *
 * 这一轮改的就是这个瞬间：一次 WebDAV 往返要 2–8 秒，而屏幕上原来既没有转圈也不换文案，
 * 用户只能反复点或者以为坏了。没有挂起的端口，测试就只能看到"点完以后"，
 * 而那正好是这次要修的那半段。
 */
function gatedFake(methods: Array<'propfind' | 'testConnection'> = ['propfind', 'testConnection']) {
  const port = fake();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const method of methods) {
    const original = port[method] as unknown as (...args: unknown[]) => Promise<unknown>;
    (port[method] as unknown) = async (...args: unknown[]) => {
      await gate;
      return original(...args);
    };
  }
  return { port, release };
}

/**
 * 进行中状态与结果语气。
 *
 * 断的都是"看不看得见"：转圈、被点的那颗换文案、上一次的结果被清掉、成功与失败不是一种颜色。
 * 每一条都配了跑完之后的对照，否则"spinner 一直在"这种反向 bug 也能全绿。
 */
describe('进行中：看得见的转圈与结果语气', () => {
  it('点「立即同步」⇒ 这颗 aria-busy + 转圈 + 换成「同步中…」，跑完三样都退回去', async () => {
    await seedConfig();
    await storage.putGroup(groupFixture('会话一', [savedTabFixture('g1', 't1', 0)], { id: 'g1' }));
    const { port, release } = gatedFake(['propfind']);
    const wrapper = mountPanel(port);
    await flush();

    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await flush();

    const spinning = wrapper.find('[data-testid="sync-now"]');
    expect(spinning.attributes('aria-busy')).toBe('true');
    expect(spinning.find('[data-testid="action-spinner"]').exists()).toBe(true);
    // 屏幕上跑的是 en（test/setup.ts 读的是 public/_locales/en），所以断英文原文案
    expect(spinning.text()).toBe('Syncing…');
    expect((spinning.element as HTMLButtonElement).disabled).toBe(true);
    // 进行中不许挂着上一次的结果
    expect(wrapper.find('[data-testid="sync-notice"]').exists()).toBe(false);

    release();
    await until(
      () => wrapper.find('[data-testid="sync-now"]').attributes('aria-busy') === 'false',
      '转圈停下来',
    );
    const done = wrapper.find('[data-testid="sync-now"]');
    expect(done.find('[data-testid="action-spinner"]').exists()).toBe(false);
    expect(done.text()).toBe('Sync now');
  }, 20_000);

  it('同一时刻只有被点的那颗在转：点「只测连接」时「应用并重连」是禁用、但不转圈', async () => {
    await seedConfig();
    stubPermissions(true);
    const { port, release } = gatedFake();
    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('[data-testid="sync-expand"]').trigger('click');

    await wrapper.find('[data-testid="sync-test"]').trigger('click');
    await flush();

    const test = wrapper.find('[data-testid="sync-test"]');
    expect(test.find('[data-testid="action-spinner"]').exists()).toBe(true);
    expect(test.text()).toBe('Testing…');
    const apply = wrapper.find('[data-testid="sync-connect"]');
    expect(apply.find('[data-testid="action-spinner"]').exists()).toBe(false);
    expect((apply.element as HTMLButtonElement).disabled).toBe(true);
    expect(apply.text()).toBe('Apply & reconnect');

    release();
    await until(() => wrapper.find('[data-testid="sync-test"]').text() === 'Test connection only', '测试按钮回到原文案');
  }, 20_000);

  /** 挂着上一次的结果 = 让人以为这次也成了。全程同一个面板，两次点击之间不重载。 */
  it('新动作一开始就把上一行的旧结果清掉', async () => {
    // 用"从没存过密码"造一条留下的错误：留空会被当成"不改密码"而不是失败（另一条用例钉着）
    await seedBlank();
    stubPermissions(true);
    const { port, release } = gatedFake(['propfind']);
    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('input[type="url"]').setValue(BASE);
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await until(() => noticeText(wrapper).includes('password'), '第一次的"要填密码"');

    // 第二次：填上密码再点。这一次会卡在网络上（propfind 被挂住），
    // 于是能看见"动作进行中"那一瞬 —— 旧结果必须已经不在了。
    await wrapper.find('input[type="password"]').setValue(FAKE_CREDENTIAL.password);
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await flush();
    expect(noticeText(wrapper)).toBe('');
    /**
     * 转圈要跟着屏幕走。`save()` 一落盘 `configured` 就变真、面板当场折成摘要，
     * 而连接还剩"推第一版"没跑完 —— 这时转圈必须出现在摘要那颗「立即同步」上。
     * 少了这一条，"屏幕换了、事情还在跑、但没有任何东西在动"就正好是这轮要修的现象。
     */
    expect(wrapper.find('[data-testid="sync-connect"]').exists()).toBe(false);
    const carried = wrapper.find('[data-testid="sync-now"]');
    expect(carried.exists()).toBe(true);
    expect(carried.find('[data-testid="action-spinner"]').exists()).toBe(true);
    expect(carried.attributes('aria-busy')).toBe('true');
    release();
    await until(
      () => wrapper.find('[data-testid="sync-now"]').attributes('aria-busy') === 'false',
      '转圈交还给空闲态',
    );
    expect(noticeText(wrapper)).not.toBe('');
  }, 20_000);

  it('结果行有语气：成功 ✓ 绿、失败 ✕ 红，而且符号与颜色同时在（不只靠颜色）', async () => {
    await seedConfig();
    await storage.putGroup(groupFixture('会话二', [savedTabFixture('g2', 't2', 0)], { id: 'g2' }));
    const okWrapper = mountPanel();
    await flush();
    await okWrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(() => noticeText(okWrapper) !== '', '成功那行的结果文案');
    const ok = okWrapper.find('[data-testid="sync-notice"]');
    expect(ok.classes()).toContain('text-brand');
    expect(ok.text()).toContain('✓');
    expect(ok.attributes('role')).toBe('status');

    await seedBlank();
    stubPermissions(true);
    const badWrapper = mountPanel();
    await flush();
    await badWrapper.find('input[type="url"]').setValue(BASE);
    await badWrapper.find('[data-testid="sync-connect"]').trigger('click');
    await until(() => noticeText(badWrapper) !== '', '失败那行的结果文案');
    const bad = badWrapper.find('[data-testid="sync-notice"]');
    expect(bad.classes()).toContain('text-danger');
    expect(bad.text()).toContain('✕');
  }, 20_000);
});

/**
 * 落点那一行（既有约定 的验收面）。断的是**真 URL**：屏幕上拼错一个目录，
 * 代价是"多出一个没人认得的空库"，而那要好几轮同步才看得出来。
 *
 * ⚠ 这一组全部用 `enabled: false` 挂 —— 已连接时面板是收起的摘要，那一行本来就不在表单位置上，
 * 拿它做"整行不出现"的断言会变成假绿（上一版就是这么绿的）。
 */
describe('落点显示：地址怎么填都指向同一条路径', () => {
  async function mountFormWith(base: string) {
    await storage.setWebDavConfig({
      enabled: false,
      baseUrl: base,
      username: FAKE_CREDENTIAL.username,
      allowInsecureHttp: false,
    });
    const wrapper = mountPanel();
    await flush();
    return wrapper;
  }

  it('地址只写到 /dav ⇒ 补上归属目录与应用目录', async () => {
    const wrapper = await mountFormWith(BASE);
    const line = wrapper.find('[data-testid="sync-remote-path"]');
    expect(line.exists()).toBe(true);
    expect(line.text()).toBe(`Data will be stored at：${LAND}`);
  });

  it('地址已经带了 ShiXiongZhiDao ⇒ 还是同一条路径，屏幕上不许出现双拼', async () => {
    const wrapper = await mountFormWith(`${BASE}/ShiXiongZhiDao`);
    expect(wrapper.find('[data-testid="sync-remote-path"]').text()).toContain(LAND);
    expect(wrapper.text()).not.toContain('ShiXiongZhiDao/ShiXiongZhiDao');
  });

  it('地址一路写到 ShiTab ⇒ 一个字都不再补', async () => {
    const wrapper = await mountFormWith(`${BASE}/ShiXiongZhiDao/ShiTab`);
    expect(wrapper.find('[data-testid="sync-remote-path"]').text()).toContain(LAND);
  });

  it('改输入框就跟着重算（这行的价值在"边打边看"，不是挂载时定死）', async () => {
    const wrapper = await mountFormWith('https://other.host/remote.php/dav/files/me');
    expect(wrapper.find('[data-testid="sync-remote-path"]').text()).toContain(
      'https://other.host/remote.php/dav/files/me/ShiXiongZhiDao/ShiTab/',
    );
    await wrapper.find('input[type="url"]').setValue('https://other.host/nextcloud');
    await flush();
    expect(wrapper.find('[data-testid="sync-remote-path"]').text()).toContain(
      'https://other.host/nextcloud/ShiXiongZhiDao/ShiTab/',
    );
  });

  /** 这条否定断言由上面四条正向撑着：收起成摘要时它同样"不出现"，那时就是假绿。 */
  it('地址还不合法时整行不出现：给一个空路径比给一个错的有用', async () => {
    const wrapper = await mountFormWith('');
    expect(wrapper.find('[data-testid="sync-remote-path"]').exists()).toBe(false);
  });
});

/**
 * 「立即同步」会被拒之后的那一屏（既有约定 的 Q2b：manual 也过判据，用户自己拍的）。
 *
 * 这个取舍的界面义务全在这里。判据拒一次，屏幕上就必须说清两件事：**这次没发起**（不是失败，
 * 没发过的请求不能报错）与**那什么时候才会发起**。少了第二句，那颗按钮和一颗坏掉的按钮
 * 长得一模一样 —— 用户这轮报的两条真机问题，本质都是"什么都没发生而没人告诉我为什么"。
 *
 * ⚠ 每条否定断言都配了正向对照，而且对照用的是**同一个 wrapper、同一颗按钮**：
 * 面板里"不发消息"最容易是 setup 没摆对（按钮根本没接上）造成的假绿。
 */
describe('被判据拒掉的那一轮：说什么、不说什么（既有约定 Q2b）', () => {
  async function setMeta(patch: Partial<Awaited<ReturnType<StoragePort['getSyncMeta']>>>): Promise<void> {
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({ ...meta, ...patch });
    await flush();
  }

  it('刚检查过就再点 ⇒ 「本轮未发起」+ 一行下一次的时刻 + 一个请求都不发', async () => {
    await seedConfig();
    await setMeta({ status: 'idle', lastSyncAt: Date.now() });
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(() => noticeText(wrapper) !== '', '被拒那一行的文案');

    expect(noticeText(wrapper)).toContain('No check this time');
    expect(noticeText(wrapper)).not.toContain('Sync failed');
    const hint = wrapper.find('[data-testid="sync-next-check"]');
    expect(hint.exists(), '只说"没发起"不说"那什么时候发起" ⇒ 这看起来就是坏了').toBe(true);
    expect(hint.text()).toContain('Next automatic check about');
    expect(/\d/.test(hint.text()), '那一行没带任何时刻').toBe(true);
    expect(remote.calls, '没到点还是敲了服务器').toHaveLength(0);

    // 正向对照：把上一次检查挪到两分钟前，同一颗按钮就该真的发请求
    await setMeta({ status: 'idle', lastSyncAt: Date.now() - 120_000 });
    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(() => remote.calls.length > 0, '到点之后真的发请求');
    /**
     * ⚠ 这里必须等**这一轮跑完**（`quiet` 等的是转圈消失），不能等"请求发出去了"。
     * `skipHint` 是在 `runNow` 的最后一行才清的，而第一个 PROPFIND 早就落地了 ——
     * 按请求数当条件的话，读到的仍是上一轮的界面，我第一次就是这么红的（而且红得像个真 bug）。
     */
    await quiet(wrapper);
    expect(remote.calls.length).toBeGreaterThan(0);
    // 上一次的时刻到了 ⇒ 那一行解释该收掉，不该常驻在屏上
    expect(wrapper.find('[data-testid="sync-next-check"]').exists()).toBe(false);
  }, 20_000);

  it('另一处已经有一轮在飞 ⇒ 说的是"已经有一次在跑"，不是失败', async () => {
    await seedConfig();
    await setMeta({ status: 'idle', lastSyncAt: Date.now() - 120_000, syncClaimedAt: Date.now() });
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(() => noticeText(wrapper) !== '', '并发那一行的文案');

    expect(noticeText(wrapper)).toContain('A sync is already running');
    expect(wrapper.find('[data-testid="sync-notice"]').classes()).not.toContain('text-danger');
    expect(remote.calls).toHaveLength(0);
  }, 20_000);

  it('有冲突等你裁决 ⇒ 说的那句是冲突，且不发请求', async () => {
    await seedConfig();
    await setMeta({
      status: 'conflict',
      lastSyncAt: Date.now() - 120_000,
      pendingConflicts: [
        { groupId: 'g1', deletedAt: 1, editedAt: 2, deletedByDeviceId: 'dev-2', deleteReason: 'user-delete' },
      ],
    });
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(() => noticeText(wrapper) !== '', '冲突那一行的文案');

    expect(noticeText(wrapper)).toContain('needs your choice');
    expect(remote.calls).toHaveLength(0);
  }, 20_000);

  /**
   * Q2b 的代价在这一条上：把 manual 收进判据之后，"换了配置"必须能自己把闸打开，
   * 否则用户重填一个地址、点下连接，看到的是"本轮没发起"。
   * `save()` 里那一次 `resetSyncCadence` 就是为这一条存在的。
   */
  it('换配置那一次点的「连接并同步」不被旧账的 60 秒闸挡住', async () => {
    await seedBlank();
    // 上一次"成功检查过"的时刻就在刚才：这是最常见的场景（他刚在别的机器上同步完）
    await setMeta({ status: 'idle', lastSyncAt: Date.now(), lastSeenSnapshotId: 'stale-from-other-server' });
    stubPermissions(true);
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('input[type="url"]').setValue(BASE);
    await wrapper.find('input[type="password"]').setValue(FAKE_CREDENTIAL.password);
    await wrapper.find('[data-testid="sync-connect"]').trigger('click');
    await until(() => remote.calls.length > 0, '换配置那一次真的去连了');
    await quiet(wrapper);

    expect(remote.calls.length).toBeGreaterThan(0);
    expect(noticeText(wrapper), '换配置那一次被旧账的 60 秒闸挡住了').not.toContain('No check this time');
    /**
     * `resetSyncCadence` 里清 `lastSeenSnapshotId` 那半**在这条用例里验不到**，如实记下：
     * 留着旧指纹只在"新服务器上恰好有同内容的那一版"时才跳过下载，而那种情况跳过本来就是对的。
     * 所以它是保险，不是判据的一环 —— 这条断言留给下一轮的引擎用例，别在这里写一句
     * "读一下 meta 断言它是 undefined"：那一格会被这一轮的 push 重新填上，绿不绿全看时序。
     */
  }, 20_000);

  /** 开关那一半同样要能开门：用户的期望是"开了就会同步"，不是"开了等一分钟"。 */
  it('跑完一轮之后再关掉、打开 ⇒ 这一次打开真的走了一轮（不是等 60 秒）', async () => {
    await seedConfig();
    const remote = fake();
    const wrapper = mountPanel(remote);
    await flush();

    await wrapper.find('[data-testid="sync-now"]').trigger('click');
    await until(() => remote.calls.length > 0, '第一轮真的发了请求');
    // 等第一轮真的跑完再取基线：`afterFirst` 若在半途取，第一轮的余下几个请求会被
    // 当成"重新打开后又走了一轮"的证据 ⇒ 这条用例就变成永远绿。
    await quiet(wrapper);
    const afterFirst = remote.calls.length;
    expect((await storage.getSyncMeta()).lastSyncAt, '跑完该落下一次检查时刻').toBeTypeOf('number');

    await wrapper.find('[data-testid="sync-switch"]').trigger('click');
    await until(() => noticeText(wrapper).includes('Nothing was deleted'), '关掉那句');
    await wrapper.find('[data-testid="sync-switch"]').trigger('click');
    await until(
      () => remote.calls.length > afterFirst,
      '重新打开后真的又走了一轮',
      12_000,
      () => `calls=${remote.calls.length} notice="${noticeText(wrapper)}"`,
    );
  }, 20_000);

  it('展开之后看得见「上一次运行是谁叫醒的」，用的是真文案不是 trigger 标识', async () => {
    await seedConfig();
    await setMeta({ status: 'idle', lastSyncAt: Date.now() - 120_000, lastTrigger: 'heartbeat' });
    const wrapper = mountPanel();
    await flush();
    await wrapper.find('[data-testid="sync-expand"]').trigger('click');

    const line = wrapper.find('[data-testid="sync-last-trigger"]');
    expect(line.exists()).toBe(true);
    expect(line.text()).toContain('Last run was woken by');
    expect(line.text()).toContain('an open ShiTab page');
    expect(line.text()).not.toContain('heartbeat');
  }, 20_000);

  /** 关掉同步之后状态行不该还挂着上一次失败的「同步失败」。 */
  it('开关关掉 ⇒ 状态行跟着变成已禁用，哪怕账上还留着上一次的错误', async () => {
    await seedConfig();
    await setMeta({
      status: 'error',
      lastSyncAt: Date.now() - 120_000,
      lastError: { kind: 'network', message: '503', at: Date.now() },
    });
    const wrapper = mountPanel();
    await flush();

    expect(wrapper.text()).toContain('Sync failed');
    await wrapper.find('[data-testid="sync-switch"]').trigger('click');
    await until(() => noticeText(wrapper).includes('Nothing was deleted'), '关掉那句');

    expect(wrapper.text()).toContain('· Off');
    expect(wrapper.text(), '关掉之后还挂着上一次的失败 ⇒ 看起来像"关掉反而更坏了"').not.toContain('Sync failed');
  }, 20_000);
});
