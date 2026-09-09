// A left-side contact adds a brief slice. No paddle-motion input is sampled.
export const SPIN_LIFE = 0.5;
export const SPIN_RATE = 1.35;
const SPIN_DECAY = 3.5;
export type Spin = { strength: number; left: number } | null;

/** Mutate a velocity using the exact integrated spin angle for this step.
 * Its magnitude and toward-opponent sign stay invariant, including edge hits.
 * Both host simulation and guest extrapolation run this same small function. */
export const curveVelocity = (
  velocity: { x: number; y: number },
  spin: Spin,
  dt: number,
  minForwardFraction: number,
): Spin => {
  if (!spin || dt <= 0) {
    return spin;
  }
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed === 0 || spin.left <= 0) {
    return null;
  }
  const step = Math.min(dt, spin.left);
  const age = SPIN_LIFE - spin.left;
  const angle =
    (spin.strength * SPIN_RATE * Math.exp(-SPIN_DECAY * age) * (1 - Math.exp(-SPIN_DECAY * step))) /
    SPIN_DECAY;
  const limit = Math.acos(minForwardFraction);
  const heading = Math.max(
    -limit,
    Math.min(limit, Math.atan2(velocity.x, Math.abs(velocity.y)) + angle),
  );
  velocity.x = Math.sin(heading) * speed;
  velocity.y = Math.sign(velocity.y) * Math.cos(heading) * speed;
  spin.left -= step;
  return spin.left <= 1e-8 ? null : spin;
};
