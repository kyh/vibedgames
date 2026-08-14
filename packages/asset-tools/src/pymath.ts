/**
 * Arithmetic helpers that reproduce Python semantics.
 *
 * The asset scripts were written in Python and their outputs are baked into
 * existing sprite sheets, so the ports have to round the way Python rounds.
 */

/**
 * Python's built-in `round`: half-way values go to the nearest *even*
 * integer, not upward. `round(0.5) == 0` and `round(1.5) == 2`, where
 * JavaScript's `Math.round` gives 1 and 2.
 *
 * This is not a nitpick — a sprite centred on a half pixel hits the halfway
 * case on every frame, so using `Math.round` shifts entire sheets by one
 * column relative to the art they were aligned against.
 */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
