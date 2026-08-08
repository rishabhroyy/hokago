/**
 * Bounded-concurrency mapper — the scanner's parallelization primitive.
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result array. No dependencies, no shared state.
 * Rejects as soon as any call rejects (the remaining workers finish their
 * current item, then Promise.all surfaces the error) — same abort semantics
 * as a plain serial loop.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
