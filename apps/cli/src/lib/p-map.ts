/**
 * Bounded-concurrency map. Runs `mapper(item, index)` for each input with
 * at most `concurrency` promises in flight at once, preserving result order.
 */
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  { concurrency = 4 }: { concurrency?: number } = {},
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i]!, i);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
