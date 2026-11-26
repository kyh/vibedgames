const after = async <T>(pause: () => Promise<void>, item: T) => {
  await pause();

  return item;
};

/**
 * Paces a walk so a `for await` loop hands the thread back between items.
 *
 * @yields {T} Each item, once `pause` has settled.
 */
export const paced = async function* paced<T>(items: Iterable<T>, pause: () => Promise<void>) {
  for (const item of items) {
    yield after(pause, item);
  }
};

/**
 * Turns a walk whose steps must await one another into a `for await` loop.
 *
 * @yields {T} Each item, in order.
 */
export const inOrder = async function* inOrder<T>(items: Iterable<T>) {
  yield* items;
};

/**
 * Counts up to `end`.
 *
 * @yields {number} The integers from `start` below `end`, `step` apart.
 */
export const range = function* range(end: number, start = 0, step = 1) {
  for (let i = start; i < end; i += step) {
    yield i;
  }
};

/**
 * Walks a `width` by `depth` grid column by column.
 *
 * @yields {readonly [number, number]} Every `[gx, gz]` cell.
 */
export const gridCells = function* gridCells(width: number, depth: number) {
  for (let gx = 0; gx < width; gx += 1) {
    for (let gz = 0; gz < depth; gz += 1) {
      yield [gx, gz] as const;
    }
  }
};
