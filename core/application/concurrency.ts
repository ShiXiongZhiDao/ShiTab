/** 有限并发执行，保留每条的成败（ARCHITECTURE §7）。 */

export type Settled<T, E> = { status: 'fulfilled'; value: T } | { status: 'rejected'; error: E };

/**
 * 以 limit 个并发跑 items。
 *
 * 用简单的指针式 worker 池而不是第三方 p-limit：一条 20 行的循环，
 * 不引依赖，且失败不会中断其余任务（这是 §7 的硬要求）。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Settled<R, unknown>[]> {
  const results = new Array<Settled<R, unknown>>(items.length);
  let cursor = 0;

  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(item, index) };
      } catch (error) {
        results[index] = { status: 'rejected', error };
      }
    }
  });

  await Promise.all(lanes);
  // 极端情况下某条 lane 提前 return 会留下空洞，统一补成 rejected 而不是 undefined
  return results.map(
    (result, index): Settled<R, unknown> =>
      result ?? { status: 'rejected', error: new Error(`任务 ${index} 未执行`) },
  );
}
