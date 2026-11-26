/**
 * Runs `step` on each item, each one after the last has settled, and resolves
 * to the results in order: a loop whose iterations must not overlap.
 */
export const runInOrder = async <T, R>(
  items: Iterable<T>,
  step: (item: T, index: number) => Promise<R>,
) => {
  const iterator = items[Symbol.iterator]();
  const results: R[] = [];

  const advance: () => Promise<R[]> = async () => {
    const current = iterator.next();

    if (current.done === true) {
      return results;
    }

    results.push(await step(current.value, results.length));

    return await advance();
  };

  return await advance();
};

/**
 * Calls `step` until it answers `false`, each call after the last has settled:
 * a loop that runs while a condition read inside it holds.
 */
export const repeatWhile = async (step: (round: number) => Promise<boolean>) => {
  const advance: (round: number) => Promise<void> = async (round) => {
    if (await step(round)) {
      await advance(round + 1);
    }
  };

  await advance(0);
};
