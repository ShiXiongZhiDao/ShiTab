/**
 * 远端历史面板的界面用例（既有约定：加载态与结果语气）。
 *
 * 这一层以前**完全没有界面用例** —— 模型层（`test/snapshot-history.spec.ts`）有 14 条，
 * 但"点下去有没有反馈"这件事只在模型层测不到。用户真机报的正是这一层：
 * 「读取远端历史」点下去几秒内屏幕一动不动。
 *
 * 端口是注入的（`props.webdav` / `props.admin`），并且用一道闸把请求挂住，
 * 才看得见"进行中"那一瞬 —— 不挂住就只能断言"点完之后"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import SnapshotHistoryPanel from '@/components/SnapshotHistoryPanel.vue';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { createFakeWebDav, FAKE_CREDENTIAL } from '@/infrastructure/testing/fake-webdav';
import type { FakeWebDavPort } from '@/infrastructure/testing/fake-webdav';
import type { StoragePort } from '@/core/ports/storage';
import { runSync } from '@/core/application/sync-engine';
import { groupFixture, savedTabFixture } from './fixtures';

const BASE = 'https://host/dav';
const AT = 1_700_000_000_000;

let storage: StoragePort;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(predicate: () => boolean, label: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`等不到：${label}（${timeoutMs}ms 内）`);
}

/**
 * 把 `propfind` 换成"等一道闸"的版本。**必须在种子数据推完之后才挂**——
 * `runSync` 自己第一步就是 propfind，先挂再推等于把播种也一起卡死（我第一版就是这么写的）。
 */
function gatePropfind(port: FakeWebDavPort): () => void {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = port.propfind.bind(port) as unknown as (...args: unknown[]) => Promise<unknown>;
  (port.propfind as unknown) = async (...args: unknown[]) => {
    await gate;
    return original(...args);
  };
  return () => release();
}

/** 先真推 N 版，让"服务器上有历史"这件事是用例的前提而不是假设。 */
async function pushVersions(port: FakeWebDavPort, count: number): Promise<void> {
  await storage.setWebDavConfig({
    enabled: true,
    baseUrl: BASE,
    username: FAKE_CREDENTIAL.username,
    allowInsecureHttp: false,
    lastTestedAt: AT,
  });
  await storage.setSyncCredential(FAKE_CREDENTIAL.password);
  for (let index = 0; index < count; index += 1) {
    await storage.putGroup(
      groupFixture(`会话 v${index}`, [savedTabFixture(`v${index}`, `v${index}-t0`, 0)], {
        id: `v${index}`,
        sortOrder: index,
        updatedAt: AT + index * 1000,
      }),
    );
    await runSync({ storage, webdav: port }, AT + index * 1000);
  }
}

/**
 * 每条用例结束前等到没有按钮在转圈，再卸载。
 * 面板的异步链不会随用例结束而停下，下一条的 `storage.local.clear()` 就落在它中间 ——
 * 同类串台在同步面板那边已经实测到过（`calls=[]` + "Sync failed"，只在多文件并行时命中）。
 */
const mounted: VueWrapper[] = [];

function mountPanel(port: FakeWebDavPort): VueWrapper {
  const wrapper = mount(SnapshotHistoryPanel, { props: { webdav: port, admin: port } });
  mounted.push(wrapper);
  return wrapper;
}

async function settleAll(): Promise<void> {
  for (const wrapper of mounted.splice(0)) {
    const deadline = Date.now() + 8_000;
    while (wrapper.find('[aria-busy="true"]').exists() && Date.now() < deadline) await flush();
    wrapper.unmount();
  }
}

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  storage = createStoragePort();
  await storage.heal();
});

afterEach(async () => {
  await settleAll();
});

describe('远端历史面板的进行中状态', () => {
  it('点「读取远端历史」⇒ 这颗转圈并换成 Reading…，跑完才停、列表才出来', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 2);
    const release = gatePropfind(port);
    const wrapper = mountPanel(port);
    await flush();

    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await flush();

    const button = wrapper.find('[data-testid="history-load"]');
    expect(button.attributes('aria-busy')).toBe('true');
    expect(button.find('[data-testid="action-spinner"]').exists()).toBe(true);
    expect(button.text()).toBe('Reading…');
    expect((button.element as HTMLButtonElement).disabled).toBe(true);

    release();
    await until(
      () => wrapper.find('[data-testid="history-load"]').attributes('aria-busy') === 'false',
      '读取结束、转圈停下',
    );
    const done = wrapper.find('[data-testid="history-load"]');
    expect(done.find('[data-testid="action-spinner"]').exists()).toBe(false);
    expect(done.text()).toBe('Load remote history');
    expect(wrapper.findAll('[data-testid="history-row"]').length).toBeGreaterThan(0);
  }, 20_000);

  /**
   * 这一条钉的是 ActionButton 存在的第二个理由：
   * 这三颗按钮以前**没有任何禁用样式**（`disabled:` 计数是 0），
   * 没勾确认时的「清理远端历史」和能点的按钮长得一模一样。
   */
  it('没勾确认时「清理远端历史」既禁用、又看得出来禁用', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 2);
    const wrapper = mountPanel(port);
    await flush();

    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => wrapper.findAll('[data-testid="history-row"]').length > 0, '列表出来');

    const prune = wrapper.find('[data-testid="history-prune"]');
    expect((prune.element as HTMLButtonElement).disabled).toBe(true);
    expect(prune.classes()).toContain('disabled:opacity-40');
    expect(prune.classes()).toContain('disabled:cursor-not-allowed');

    await wrapper.find('[data-testid="history-confirm"]').setValue(true);
    expect((wrapper.find('[data-testid="history-prune"]').element as HTMLButtonElement).disabled).toBe(false);
  }, 20_000);

  it('恢复只让被点那一行转圈，别的行只禁用', async () => {
    const port = createFakeWebDav({ expectedCredential: FAKE_CREDENTIAL });
    await pushVersions(port, 2);
    const wrapper = mountPanel(port);
    await flush();
    await wrapper.find('[data-testid="history-load"]').trigger('click');
    await until(() => wrapper.findAll('[data-testid="history-row"]').length >= 2, '两版历史都列出来');

    const rows = wrapper.findAll('[data-testid^="history-restore-"]');
    expect(rows.length).toBe(2);
    await rows[1]!.trigger('click');
    await flush();

    expect(rows[1]!.find('[data-testid="action-spinner"]').exists()).toBe(true);
    expect(rows[1]!.attributes('aria-busy')).toBe('true');
    // 另一行：禁用但不转 —— 两个动作同时在飞也没有意义
    expect(rows[0]!.find('[data-testid="action-spinner"]').exists()).toBe(false);
    expect((rows[0]!.element as HTMLButtonElement).disabled).toBe(true);

    await until(
      () => wrapper.find('[data-testid="history-message"]').exists(),
      '恢复之后那行结果落下来',
    );
    const message = wrapper.find('[data-testid="history-message"]');
    expect(message.text()).toContain('✓');
    expect(message.classes()).toContain('text-brand');
    expect(message.attributes('role')).toBe('status');
  }, 20_000);
});
