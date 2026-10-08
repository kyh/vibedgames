// The transcendental functions the lockstep sim may use. ECMAScript leaves
// Math.sin, Math.cos, Math.exp and Math.hypot "implementation-approximated",
// and engines differ in the last bit (V8's fdlibm port against the system
// libm under JavaScriptCore). One bit is enough to tip a contact a tick later
// and fork two clients' rallies, so the sim uses only +, −, ×, ÷ and sqrt —
// each correctly rounded, so bit-identical, on every engine — and the short
// series below, built from nothing else.

/** e^x by its Taylor series. Deterministic for any x; the sim asks only |x| < 1. */
export const exactExp = (x: number): number => {
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 40; n += 1) {
    term = (term * x) / n;
    sum += term;
  }
  return sum;
};

/** sin x by its series through x¹⁵ — truncation under 1e-19 for |x| ≤ 0.5. */
export const exactSin = (x: number): number => {
  const x2 = x * x;
  const tail = 1 - (x2 / 110) * (1 - (x2 / 156) * (1 - x2 / 210));
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * tail))));
};

/** cos x by its series through x¹⁴ — truncation under 1e-18 for |x| ≤ 0.5. */
export const exactCos = (x: number): number => {
  const x2 = x * x;
  const tail = 1 - (x2 / 90) * (1 - (x2 / 132) * (1 - x2 / 182));
  return 1 - (x2 / 2) * (1 - (x2 / 12) * (1 - (x2 / 30) * (1 - (x2 / 56) * tail)));
};

/** |(x, y)|. Math.hypot is approximated per engine; sqrt is the IEEE instruction everywhere. */
export const exactLength = (x: number, y: number): number => {
  const squared = x * x + y * y;
  return Math.sqrt(squared);
};
