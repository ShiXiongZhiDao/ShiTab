/**
 * 耐久快照的写入顺序与启动恢复（既有约定，WebDAV-SYNC.md §3.2 / §4）。
 *
 * 整套设计只为一句话：**先把新版本完整写进去，再切换"当前版本指针"。**
 * 指针没翻 = 这次写入在语义上没发生过，哪怕槽里留了半截数据也不影响读取方。
 *
 * 顺序里"重新读回来再校验"那一步不是仪式感：`storage.local` 的 `set` 是异步落盘，
 * 一次写入失败可能表现为"promise 成功了但盘上是旧值/半截值"。
 * 回读之后 checksum 对得上，才允许翻指针。
 */

import type { StoragePort } from '@/core/ports/storage';
import type { SlotName, StateEnvelope, StoredState } from '@/shared/types';
import { gzipToBase64 } from '@/core/domain/gzip';
import {
  emptyState,
  inactiveSlot,
  pickValidSlot,
  sealState,
  verifyEnvelope,
} from '@/core/domain/durable-state';

export interface DurableSnapshotDeps {
  storage: StoragePort;
}

export type SnapshotFailure = 'write-failed' | 'readback-missing' | 'readback-invalid';

export type SnapshotOutcome =
  | { ok: true; revision: number; slot: SlotName; envelope: StateEnvelope }
  | { ok: false; reason: SnapshotFailure; revision: number };

export interface RecoveryOutcome {
  /** 两槽都无效时为 null —— 那时"没有可恢复的快照"，不是"恢复成空"。 */
  envelope: StateEnvelope | null;
  slot: SlotName | null;
  /** 每一槽的判定结果，要能原样写进日志（`empty` 和 `checksum` 是完全不同的事故）。 */
  details: Array<{ slot: SlotName; ok: boolean; reason?: string }>;
}

/** 拍一份当前全量状态。UI 的读取路径不经过它，它是"崩溃之后还能回到哪一刻"的证据。 */
export async function captureDurableSnapshot(
  deps: DurableSnapshotDeps,
  at: number,
): Promise<SnapshotOutcome> {
  const pointer = await deps.storage.getSnapshotPointer();
  const target = inactiveSlot(pointer);
  const current = await readValidEnvelope(deps);
  const revision = (current?.revision ?? 0) + 1;

  const payload = await readStoredState(deps);
  const envelope = await sealState(payload, revision, at);
  const encoded = await gzipToBase64(JSON.stringify(envelope));

  try {
    await deps.storage.writeSnapshotSlot(target, encoded);
  } catch {
    // 写失败**不翻指针**：旧版本继续有效。这正是双槽存在的全部理由。
    return { ok: false, reason: 'write-failed', revision };
  }

  // 回读：不看 write 的 promise 结果，看盘上到底是什么。
  const readBack = await deps.storage.readSnapshotSlot(target);
  if (readBack === null) return { ok: false, reason: 'readback-missing', revision };

  const verified = await verifyEnvelope(readBack);
  if (!verified.ok) return { ok: false, reason: 'readback-invalid', revision };

  await deps.storage.commitSnapshotPointer(target);
  return { ok: true, revision, slot: target, envelope: verified.envelope };
}

/**
 * 启动恢复：两槽都验，取"最高 revision 的**有效**版本"（WebDAV-SYNC.md §3.2）。
 *
 * 注意返回的是 `envelope: null` 而不是空状态 —— "从没拍过快照"与"快照是空的"
 * 必须能区分，否则一次存储被清空会被解释成"用户把会话删光了"，然后被同步上去。
 */
export async function recoverDurableState(deps: DurableSnapshotDeps): Promise<RecoveryOutcome> {
  const entries = await Promise.all(
    (['a', 'b'] as const).map(async (slot) => ({
      slot,
      result: await verifyEnvelope(await deps.storage.readSnapshotSlot(slot)),
    })),
  );

  const details = entries.map(({ slot, result }) => ({
    slot,
    ok: result.ok,
    ...(!result.ok ? { reason: result.reason } : {}),
  }));

  const best = pickValidSlot(entries);
  return {
    envelope: best?.envelope ?? null,
    slot: best?.slot ?? null,
    details,
  };
}

/** 当前有效快照里的状态。没有可信快照时返回 null（**不是** `emptyState()`）。 */
export async function readValidEnvelope(deps: DurableSnapshotDeps): Promise<StateEnvelope | null> {
  return (await recoverDurableState(deps)).envelope;
}

/** 从分键主存储读全量状态。顺序无关：checksum 走的是规范化 JSON（键序已排序、数组按存储顺序）。 */
export async function readStoredState(deps: DurableSnapshotDeps): Promise<StoredState> {
  const [groups, categories, tombstones, trash] = await Promise.all([
    deps.storage.listAllGroups(),
    deps.storage.listCategories(),
    deps.storage.listTombstones(),
    deps.storage.listTrash(),
  ]);
  // `trash` 永远写出来（哪怕是空数组）：可选键"缺席"与"是空数组"在 canonicalJson 下
  // 是两个 checksum，只有"current build 一律带上这个键"才压得住每轮同步各造一个快照。
  return { groups, categories, tombstones, trash };
}

/** 供测试与降级路径使用：一份"什么都没有"的状态，明确区别于"读不到快照"。 */
export { emptyState };
