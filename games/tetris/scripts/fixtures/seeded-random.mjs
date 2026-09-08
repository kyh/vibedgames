/** Repeatable test bags without changing ordinary gameplay or cosmetic randomness. */
export function createSeededRandom() {
  let word = 0x54455431;
  return () => {
    word = (word + 0x6d2b79f5) | 0;
    let value = Math.imul(word ^ (word >>> 15), 1 | word);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
