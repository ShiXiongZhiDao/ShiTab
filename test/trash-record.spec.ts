/**
 * 记录级 barrier 的判据—— 纯函数层。
 *
 * 为什么单独一层测：`merge.ts` 那边测的是"两台设备合完看得见的结果"，而这一层要钉的是
 * **代数性质**（可交换 / 可结合 / 幂等 / 确定性总序）。可交换性一旦破了，
 * 症状不是"数据错"而是"每轮同步都产生一个新快照"（两台机器各推一版谁都不认谁），
 * 那种漂移在端到端用例里要跑很多轮才看得见，所以钉在纯函数上。
 */
import { describe, expect, it } from 'vitest';
import {
  arrivedState,
  barrierSuppresses,
  compareBarriers,
  dominantReason,
  latestBarrier,
  mergeRecordLedgers,
  mergeRecordStates,
  recordsOf,
  withBarrier,
} from '@/core/domain/trash-record';
import { groupFixture, savedTabFixture } from './fixtures';
import type { DeleteReason, TrashEntry, TrashRecordBarrier, TrashRecordState } from '@/shared/types';

const AT = 1_700_000_000_000;
const at = (offset: number): number => AT + offset;

const barrier = (
  action: TrashRecordBarrier['action'],
  when: number,
  deviceId = 'dev-A',
): TrashRecordBarrier => ({ action, at: when, deviceId });

const state = (arrivedAt: number, override?: Partial<TrashRecordState>): TrashRecordState => ({
  reason: 'user-delete',
  arrivedAt,
  ...override,
});

function row(tabs: string[], input: Partial<TrashEntry> = {}): TrashEntry {
  return {
    group: groupFixture(
      '会话 g1',
      tabs.map((id, index) => savedTabFixture('g1', id, index)),
      { id: 'g1' },
    ),
    deletedAt: at(100),
    expiresAt: at(100) + 7 * 86_400_000,
    reason: 'user-delete',
    ...input,
  };
}

describe('barrier 压制判据', () => {
  it('凭证时刻 >= 这一次入站时刻才压得住', () => {
    expect(barrierSuppresses(state(at(100), { barrier: barrier('purge', at(200)) }))).toBe(true);
    // 同一毫秒：压得住（用户连点两下的真实序），且与整行那条规则同形（`>=`）
    expect(barrierSuppresses(state(at(200), { barrier: barrier('purge', at(200)) }))).toBe(true);
    // 更晚的入站穿透它（Case C）：不然就是静默丢一条可恢复记录
    expect(barrierSuppresses(state(at(300), { barrier: barrier('purge', at(200)) }))).toBe(false);
  });

  it('没有凭证 = 不压；这是"老数据一条都不该被误杀"的那一半', () => {
    expect(barrierSuppresses(state(at(100)))).toBe(false);
    expect(barrierSuppresses(undefined)).toBe(false);
  });

  it('重新入站要把 arrivedAt 盖成新的时刻，凭证本身留着（穿透靠的是时刻，不是抹掉凭证）', () => {
    const held = state(at(100), { barrier: barrier('purge', at(200)) });
    const reArrived = mergeRecordStates(held, arrivedState('user-delete', at(500)));
    expect(reArrived.arrivedAt).toBe(at(500));
    expect(reArrived.barrier).toEqual(barrier('purge', at(200)));
    expect(barrierSuppresses(reArrived)).toBe(false);

    // 再删一次出去 ⇒ 新 barrier 压住新的一次入站
    expect(barrierSuppresses(withBarrier(reArrived, barrier('purge', at(600))))).toBe(true);
  });
});

describe('barrier 的确定性总序', () => {
  it('at → deviceId → action：每一级都比到分出胜负为止', () => {
    expect(Math.sign(compareBarriers(barrier('purge', 10), barrier('purge', 11)))).toBe(-1);
    expect(Math.sign(compareBarriers(barrier('purge', 10, 'dev-B'), barrier('purge', 10, 'dev-A')))).toBe(1);
    expect(Math.sign(compareBarriers(barrier('restore', 10), barrier('purge', 10)))).toBe(1);
    expect(compareBarriers(barrier('purge', 10), barrier('purge', 10))).toBe(0);
  });

  it('同一毫秒两台设备各写一条：两边必须选出同一个 winner（可交换性的根）', () => {
    const a = barrier('purge', 10, 'dev-A');
    const b = barrier('restore', 10, 'dev-B');
    expect(latestBarrier(a, b)).toBe(latestBarrier(b, a));
    expect(latestBarrier(a, b)).toBeDefined();
  });
});

describe('ledger 合并的代数性质', () => {
  const cases: Array<[string, TrashRecordState, TrashRecordState]> = [
    ['入站时刻与凭证都不同', state(at(100), { barrier: barrier('purge', at(9)) }), state(at(200))],
    [
      '同一毫秒、不同设备',
      state(at(100), { barrier: barrier('purge', at(50), 'dev-A') }),
      state(at(100), { barrier: barrier('restore', at(50), 'dev-B') }),
    ],
    ['来历不同', state(at(100), { reason: 'consumed' }), state(at(120), { reason: 'user-delete' })],
    ['完全一样（幂等）', state(at(100)), state(at(100))],
  ];

  for (const [name, a, b] of cases) {
    it(`${name}：可交换`, () => {
      expect(mergeRecordStates(a, b)).toEqual(mergeRecordStates(b, a));
    });
  }

  it('可结合（三台设备先后合与一次合到一块，结果必须一致）', () => {
    const a = state(at(100), { barrier: barrier('purge', at(150), 'dev-A') });
    const b = state(at(120), { reason: 'consumed' });
    const c = state(at(110), { barrier: barrier('restore', at(160), 'dev-B') });
    expect(mergeRecordStates(mergeRecordStates(a, b), c)).toEqual(mergeRecordStates(a, mergeRecordStates(b, c)));
  });

  it('整张 ledger 合并也满足交换与幂等', () => {
    const left = { 'g1-a': state(at(100)), 'g1-b': state(at(100), { barrier: barrier('purge', at(200)) }) };
    const right = { 'g1-b': state(at(300)), 'g1-c': arrivedState('consumed', at(400)) };
    expect(mergeRecordLedgers(left, right)).toEqual(mergeRecordLedgers(right, left));
    expect(mergeRecordLedgers(left, left)).toEqual(left);
    expect(Object.keys(mergeRecordLedgers(left, right))).toEqual(['g1-a', 'g1-b', 'g1-c']);
  });

  it('ledger 里的 arrivedAt 取较晚那一次，reason 取"最像用户删除"那个', () => {
    const merged = mergeRecordStates(
      state(at(100), { reason: 'consumed' }),
      state(at(300), { reason: 'user-delete' }),
    );
    expect(merged.arrivedAt).toBe(at(300));
    expect(merged.reason).toBe('user-delete');
  });
});

describe('读时兜底（老行与还没升级的产物）', () => {
  it('只有 recordReasons 的老行：按整行的 deletedAt 当入站时刻，一条不丢', () => {
    const legacy = row(['g1-a', 'g1-b'], { recordReasons: { 'g1-a': 'consumed' } });
    const ledger = recordsOf(legacy);
    expect(Object.keys(ledger).sort()).toEqual(['g1-a', 'g1-b']);
    expect(ledger['g1-a']).toEqual({ reason: 'consumed', arrivedAt: at(100) });
    // 没写来历的那一条跟行走（既有约定 的原口径）
    expect(ledger['g1-b']?.reason).toBe('user-delete');
    expect(barrierSuppresses(ledger['g1-a'])).toBe(false);
  });

  it('新形状优先，且壳行的凭证读得到（tabs 空了不代表 ledger 空）', () => {
    const shell = row([], {
      records: { 'g1-a': state(at(100), { barrier: barrier('restore', at(200), 'dev-A') }) },
      recordReasons: { 'g1-a': 'consumed' },
    });
    expect(recordsOf(shell)['g1-a']?.reason).toBe('user-delete');
    expect(recordsOf(shell)['g1-a']?.barrier?.action).toBe('restore');
  });
});

describe('dominantReason（判据只有一份，既有约定 之后住在这一层）', () => {
  const order: DeleteReason[] = ['user-delete', 'consumed', 'undone'];

  it('混着来历的一行取"最像用户删除"那个', () => {
    expect(dominantReason(['consumed', 'user-delete'])).toBe('user-delete');
    expect(dominantReason(['undone', 'consumed'])).toBe('consumed');
  });

  it('全是恢复掉的那一行必须还是 consumed（这条曾经把初始值写成 user-delete 而静默撒谎）', () => {
    expect(dominantReason(['consumed'])).toBe('consumed');
    expect(dominantReason(order.filter((item) => item !== 'user-delete'))).toBe('consumed');
  });
});
