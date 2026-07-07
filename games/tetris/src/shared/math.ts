// Frame-rate-independent smoothing primitives (shared by render + camera).

const LEGACY_FPS = 60;

/**
 * Convert a "lerp this fraction every 60fps frame" constant into a dt-correct
 * smoothing factor, so motion looks the same at any frame rate.
 *   next = current + (target - current) * frameLerp(perFrame, dt)
 */
export function frameLerp(perFrame: number, dt: number): number {
  return 1 - Math.pow(1 - perFrame, dt * LEGACY_FPS);
}

/**
 * Critically-damped spring (Game Programming Gems 4). Eases `current` toward
 * `target` with no overshoot; `omega` is stiffness (higher = snappier).
 * Returns the new position and velocity (caller stores vel for next frame).
 */
export function smoothDamp(
  current: number,
  target: number,
  vel: number,
  omega: number,
  dt: number,
): { pos: number; vel: number } {
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (vel + omega * change) * dt;
  const newVel = (vel - omega * temp) * exp;
  const newPos = target + (change + temp) * exp;
  return { pos: newPos, vel: newVel };
}
