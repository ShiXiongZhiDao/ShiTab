import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import ConflictPanel from '@/components/ConflictPanel.vue';
import { createStoragePort } from '@/infrastructure/storage/wxt-storage';
import { storagePort } from '@/shared/services';
import type { StoragePort } from '@/core/ports/storage';
import { groupFixture, savedTabFixture } from './fixtures';
import type { StoredConflict } from '@/shared/types';

const AT = 1_700_000_000_000;

let storage: StoragePort;

async function seedConflict(reason: StoredConflict['deleteReason'] = 'user-delete'): Promise<void> {
  await storage.putGroup(
    groupFixture('读了一半的东西', [savedTabFixture('c1', 'c1-t0', 0), savedTabFixture('c1', 'c1-t1', 1)], { id: 'c1' }),
  );
  const meta = await storage.getSyncMeta();
  await storage.setSyncMeta({
    ...meta,
    status: 'conflict',
    pendingConflicts: [
      { groupId: 'c1', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: '0123456789abcdef-other', deleteReason: reason },
    ],
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  await fakeBrowser.storage.local.clear();
  storage = createStoragePort();
  await storage.heal();
});

describe('冲突裁决面板', () => {
  /**
   * 没有冲突时整段不该出现。
   * 这条不是洁癖：这面板挂在设置页上，一直显示"等你裁决"会让用户以为同步坏了。
   */
  it('没有冲突时整段不渲染', async () => {
    const wrapper = mount(ConflictPanel);
    await flush();
    expect(wrapper.find('[data-testid="conflict-section"]').exists()).toBe(false);
  });

  it('有冲突时列出本机那一条会话的**真实标题**，而不是 groupId', async () => {
    await seedConflict();
    const wrapper = mount(ConflictPanel);
    await flush();
    const rows = wrapper.findAll('[data-testid="conflict-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('读了一半的东西');
    // 标题取得到就不该露出内部 id —— 面板有 `group?.title || conflict.groupId` 这条兜底，
    // 只断言"标题在文字里"抓不到它走的是兜底那一支。
    expect(rows[0]!.text()).not.toContain('c1');
  });

  /**
   * 墓碑的 `reason` 是代码判别值，印到界面上就是错误码。
   *
   * 判据只钉"整串枚举值不许出现在用户看得见的文字里"这一件事。
   * 我第一版写成"文字里不许有 consumed / undone 这些子串"，那是自我矛盾：
   * 英文那三句人类文案本身就说 "consumed by a restore" 和 "cannot be undone"，
   * 于是三条用例一起红，红的还是我写错的判据。
   */
  it.each([
    ['user-delete', 'deleted on the other device'],
    ['consumed', 'consumed by a restore on the other device'],
    ['undone', 'removed by an undo on the other device'],
  ] as const)('reason=%s 显示成人类文案', async (reason, expected) => {
    await seedConflict(reason);
    const wrapper = mount(ConflictPanel);
    await flush();
    const text = wrapper.text();
    expect(text).toContain(expected);
    // 只有带连字符的整串枚举值是"漏了映射"的确凿证据，也不会撞上正常英文
    expect(text).not.toContain('user-delete');
  });

  it('选「保留」⇒ 会话还在本机，账上不再挂冲突，状态转成等待同步', async () => {
    await seedConflict();
    const wrapper = mount(ConflictPanel);
    await flush();

    await wrapper.find('[data-testid="conflict-keep"]').trigger('click');
    await flush();

    expect(await storage.getGroup('c1')).toBeDefined();
    const meta = await storage.getSyncMeta();
    expect(meta.pendingConflicts).toBeUndefined();
    expect(meta.status).toBe('pending');
    expect(wrapper.find('[data-testid="conflict-section"]').exists()).toBe(false);
  });

  /** 确认删除复用软删除那条路：进回收站、留墓碑，下一轮同步把删除传播出去。 */
  it('选「确认删除」⇒ 会话进回收站并留下墓碑，裁决从账上摘掉', async () => {
    await seedConflict();
    const wrapper = mount(ConflictPanel);
    await flush();

    await wrapper.find('[data-testid="conflict-delete"]').trigger('click');
    await flush();

    expect(await storage.getGroup('c1')).toBeUndefined();
    expect((await storage.listTrash()).map((item) => item.group.id)).toEqual(['c1']);
    expect((await storage.listTombstones()).map((tomb) => tomb.entityId)).toEqual(['c1']);
    expect((await storage.getSyncMeta()).pendingConflicts).toBeUndefined();
  });

  /**
   * 冲突是 **background 的同步**落下来的，而工作台可能早就开着。
   * 只靠挂载时读一次，用户会看见同步状态变了却这里空着，非得刷新页面才长出裁决入口 ——
   * 那正是 Q9 把冲突放在工作台的理由的反面。
   */
  it('面板已经开着时后台才落下冲突 ⇒ 不刷新页面就长出裁决入口', async () => {
    const wrapper = mount(ConflictPanel);
    await flush();
    expect(wrapper.find('[data-testid="conflict-section"]').exists()).toBe(false);

    await seedConflict(); // 直接写 sync_meta，模拟 background 那一次同步落地
    await flush();
    await flush();

    expect(wrapper.find('[data-testid="conflict-section"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="conflict-row"]')).toHaveLength(1);
  });

  it('两条冲突时裁完一条还留一条，状态仍是 conflict（不假装已经干净）', async () => {
    await seedConflict();
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({
      ...meta,
      pendingConflicts: [
        ...(meta.pendingConflicts ?? []),
        { groupId: 'c2', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: 'other', deleteReason: 'consumed' },
      ],
    });

    const wrapper = mount(ConflictPanel);
    await flush();
    expect(wrapper.findAll('[data-testid="conflict-row"]')).toHaveLength(2);

    await wrapper.findAll('[data-testid="conflict-keep"]')[0]!.trigger('click');
    await flush();

    const after = await storage.getSyncMeta();
    expect(after.pendingConflicts?.map((item) => item.groupId)).toEqual(['c2']);
    expect(after.status).toBe('conflict');
    expect(wrapper.findAll('[data-testid="conflict-row"]')).toHaveLength(1);
  });
});

/**
 * 裁决在飞时的禁用态（既有约定，补 既有约定 欠的最后一处）。
 *
 * 这条不是观感：`choose()` 里 await 期间两颗按钮原来都能点，
 * 同一行先点「保留会话」再点「确认删除」，第二次会走 `softDeleteGroup`
 * —— 用户刚保留下来的会话就这么没了，屏幕上还不给任何解释。
 */
describe('冲突裁决的禁用态与并发点击', () => {
  /** 把第一次落账挂住，好观察"在飞"那一瞬（不挂住的话这条链在 jsdom 里同步就跑完了）。 */
  function gateSetMeta() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const real = storagePort.setSyncMeta.bind(storagePort);
    vi.spyOn(storagePort, 'setSyncMeta').mockImplementation(async (meta) => {
      calls += 1;
      await gate;
      return real(meta);
    });
    return {
      release: () => release(),
      calls: () => calls,
    };
  }

  it('空闲时两颗按钮都可用（正向对照：不然"点了才灰"这条永远测不到）', async () => {
    await seedConflict();
    const wrapper = mount(ConflictPanel);
    await flush();

    for (const id of ['conflict-keep', 'conflict-delete']) {
      const button = wrapper.find(`[data-testid="${id}"]`);
      expect((button.element as HTMLButtonElement).disabled).toBe(false);
      expect(button.attributes('aria-busy')).toBeUndefined();
    }
    wrapper.unmount();
  });

  it('点下去 ⇒ 两颗都禁用、被点那颗说「处理中…」，在飞期间的第二次点击不再裁一遍', async () => {
    await seedConflict();
    const gate = gateSetMeta();
    const wrapper = mount(ConflictPanel);
    await flush();

    await wrapper.find('[data-testid="conflict-keep"]').trigger('click');
    await flush();

    const keep = wrapper.find('[data-testid="conflict-keep"]');
    expect((keep.element as HTMLButtonElement).disabled, '禁用了却没变灰 ⇒ 用户不知道能不能再点').toBe(true);
    expect(keep.classes()).toContain('disabled:opacity-50');
    expect(keep.attributes('aria-busy')).toBe('true');
    expect(keep.text()).toBe('Applying…');
    expect((wrapper.find('[data-testid="conflict-delete"]').element as HTMLButtonElement).disabled).toBe(true);

    // 在飞期间再点另一颗：原来这一击会把刚保留的会话删掉
    await wrapper.find('[data-testid="conflict-delete"]').trigger('click');
    expect(gate.calls(), '第二次裁决也起飞了 ⇒ 两辆车在抢同一块墓碑数组').toBe(1);

    gate.release();
    await flush();
    await flush();

    expect(await storage.getGroup('c1'), '「保留会话」的结果被第二击覆盖掉了').toBeDefined();
    expect((await storage.getSyncMeta()).pendingConflicts ?? []).toHaveLength(0);
    wrapper.unmount();
  });
});
