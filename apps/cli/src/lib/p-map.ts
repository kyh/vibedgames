/**
 * Bounded-concurrency map. Runs `mapper(item, index)` for each input with
 * at most `concurrency` promises in flight at once, preserving result order.
 *
 * If `mapper` rejects, `pMap` rejects with the first error and refuses to
 * dispatch any remaining work. Workers that are already mid-await when the
 * abort happens still finish their current item (we can't pre-empt them
 * without an AbortSignal contract on `mapper`), but they will not claim a
 * new index after that. This avoids the typical Promise.all footgun where
 * siblings keep firing API calls after the function has already rejected.
 */
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  { concurrency = 4 }: { concurrency?: number } = {},
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  // Workers race on `cursor` to claim the next index. JS's single-threaded
  // event loop guarantees `cursor++` and the bounds check execute as one
  // synchronous step, so each index is claimed by exactly one worker
  // without explicit locking.
  let cursor = 0;
  let aborted = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!aborted) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await mapper(items[i]!, i);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  if (aborted) throw firstError;
  return results;
}
