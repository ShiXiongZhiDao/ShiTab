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

async function seedConflict(
  reason: StoredConflict['deleteReason'] = 'user-delete',
  extra: Partial<StoredConflict> = {},
): Promise<void> {
  await storage.putGroup(
    groupFixture('读了一半的东西', [savedTabFixture('c1', 'c1-t0', 0), savedTabFixture('c1', 'c1-t1', 1)], { id: 'c1' }),
  );
  const meta = await storage.getSyncMeta();
  await storage.setSyncMeta({
    ...meta,
    status: 'conflict',
    pendingConflicts: [
      { groupId: 'c1', groupTitle: '读了一半的东西', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: '0123456789abcdef-other', deleteReason: reason, ...extra },
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

  /**
   * 删除方那台设备**叫什么**，两个方向成对钉：
   * 解析得到名字就显示名字，解析不到回退 UUID 前 8 位 —— 既不是一整串十六进制，也不是空白。
   * 名字与 id 各钉一半是必要的：只钉一边时"永远显示 id"和"永远显示名字"都能绿。
   */
  it('账上有 deletedByName ⇒ 那一行显示的是它自己的名字，不是 UUID 片段', async () => {
    await seedConflict('user-delete', { deletedByName: '办公室那台 Edge' });
    const wrapper = mount(ConflictPanel);
    await flush();

    const row = wrapper.find('[data-testid="conflict-row"]');
    expect(row.exists(), '前置：这一条冲突确实上了屏').toBe(true);
    expect(row.text()).toContain('Other device: 办公室那台 Edge');
    // 反向：有名字时不该再把机器身份塞到用户眼前（那 8 位是 id 的头 8 个字符）
    expect(row.text()).not.toContain('01234567');
  });

  it('账上没有名字 ⇒ 回退 UUID 前 8 位（不是整串 id，也不是空白）', async () => {
    await seedConflict();
    const wrapper = mount(ConflictPanel);
    await flush();

    const row = wrapper.find('[data-testid="conflict-row"]');
    expect(row.exists(), '前置：这一条冲突确实上了屏').toBe(true);
    expect(row.text()).toContain('Other device: 01234567');
    expect(row.text(), '整串 id 上屏 ⇒ 用户读到的是十六进制噪声').not.toContain('0123456789abcdef-other');
  });

  /**
   * ★ 默认名会撞：两台 Windows + Chrome 拿到的都是 `Chrome · Windows`，而浏览器不给扩展任何
   * 主机名 API，所以没法用计算机名区分。修法是**不改名字**、只在这一行永远叠一个 id 前 4 位。
   *
   * 为什么还要单独一条：上面那条断的是 `toContain('Other device: 办公室那台 Edge')` ——
   * 那是**前缀**匹配，加不加后缀都绿，所以它钉不住这 4 位。这里断完整成形的那串
   * （含 locale 给的括号），去掉后缀当场就红。
   */
  it('名字后面永远带 id 前 4 位 —— 默认名撞车时这才是唯一可核对的东西', async () => {
    await seedConflict('user-delete', { deletedByName: 'Chrome · Windows' });
    const wrapper = mount(ConflictPanel);
    await flush();

    const row = wrapper.find('[data-testid="conflict-row"]');
    expect(row.exists(), '前置：这一条冲突确实上了屏').toBe(true);
    expect(row.text()).toContain('Other device: Chrome · Windows (0123)');
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
        { groupId: 'c2', groupTitle: '会话 c2', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: 'other', deleteReason: 'consumed' },
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

/**
 * ★ 卡片标题不许印成裸 UUID（既有约定，真机 2026-10-08 第二张截图）。
 *
 * 他恢复两次之后撞出 19 条冲突，屏幕上 19 张卡片每张的标题都是一串十六进制
 * （`e4541b10-77e0-…`）—— 那等于让他从十六进制里猜"哪一条是哪个会话"。
 * 来路是面板以前只问 `getGroup(groupId)`，而**停在冲突那一轮引擎不写本机**
 * （不写、不推，等他裁决），所以对面那台设备本地根本没有这条会话。
 */
describe('冲突卡片的标题', () => {
  it('本机没有那条会话时，标题读账上那一份，不印裸 id', async () => {
    await seedConflict('reverted', { groupId: 'ghost-0001', groupTitle: '登录 · accounts.woozooo.com' });
    const wrapper = mount(ConflictPanel);
    await flush();

    const title = wrapper.find('[data-testid="conflict-title"]');
    expect(title.text()).toBe('登录 · accounts.woozooo.com');
    expect(title.text(), '一串十六进制答不了"哪一条是哪个会话"').not.toContain('ghost-0001');
    // 正向对照：这条会话**确实**不在本机存储里（否则上面那条是在测 getGroup 那条老路）
    expect(await storage.getGroup('ghost-0001')).toBeUndefined();
  });

  /**
   * 老账本（改动之前落的那笔）没有 `groupTitle` ⇒ 仍走本机那一条；
   * 本机也没有时才回退到 id。这一格是**唯一**允许印出裸 id 的出口。
   */
  it('账上没有标题、本机也没有 ⇒ 才允许回退到裸 id', async () => {
    const meta = await storage.getSyncMeta();
    await storage.setSyncMeta({
      ...meta,
      status: 'conflict',
      pendingConflicts: [
        // 刻意不写 groupTitle：模拟升级之前落账的那一笔
        { groupId: 'gone-9999', deletedAt: AT + 1000, editedAt: AT + 2000, deletedByDeviceId: 'dev-2', deleteReason: 'user-delete' } as unknown as StoredConflict,
      ],
    });
    const wrapper = mount(ConflictPanel);
    await flush();
    expect(wrapper.find('[data-testid="conflict-title"]').text()).toBe('gone-9999');

    // 正向对照：同一笔账，本机有那条会话时读得到标题（回退链没有把本机那一条也堵死）
    await storage.putGroup(groupFixture('本机还在的那条', [savedTabFixture('gone-9999', 'x', 0)], { id: 'gone-9999' }));
    const second = mount(ConflictPanel);
    await flush();
    expect(second.find('[data-testid="conflict-title"]').text()).toBe('本机还在的那条');
  });
});
