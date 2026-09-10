/** Narrow away `undefined`/`null` in tests without a non-null assertion. */
export const must = <T>(value: T | null | undefined, what = "value"): T => {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
};
