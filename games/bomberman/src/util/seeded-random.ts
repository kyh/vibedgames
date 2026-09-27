const MODULUS = 2_147_483_647;

/** Park–Miller: a seedable PRNG whose products stay inside a double's exact
 *  integers — enough for crate layouts and bot dice. */
export const seededRandom = (seed: number): (() => number) => {
  let state = (Math.abs(Math.trunc(seed)) % (MODULUS - 1)) + 1;
  return () => {
    state = (state * 48_271) % MODULUS;
    return (state - 1) / (MODULUS - 1);
  };
};
