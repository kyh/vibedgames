// A sideways stroke adds a brief curve; ordinary returns keep their old angle
// and speed. Sample intent, not smoothing catch-up, so reacquiring a hand never
// turns a paddle teleport into a trick shot. Times are monotonic seconds.
export const SPIN_LIFE = 0.5;
export const SPIN_RATE = 1.35;
const SPIN_DECAY = 3.5;
export const STROKE_TIMEOUT = 0.13;
const MIN_SPEED = 6;
const FULL_SPEED = 22;
const MAX_SAMPLE_SPEED = 70;
const STROKE_WINDOW = 0.08;

export type Spin = { strength: number; left: number } | null;
export type SteeringSource = "pointer" | "hand" | "pad";
type Sample = { x: number; at: number; source: SteeringSource };

export class PaddleStroke {
  private previous: Sample | null = null;
  private distance = 0;
  private duration = 0;
  private strength = 0;
  private steps: { distance: number; duration: number }[] = [];

  reset(): void {
    this.previous = null;
    this.distance = 0;
    this.duration = 0;
    this.strength = 0;
    this.steps.length = 0;
  }

  sample(x: number, at: number, source: SteeringSource): void {
    if (!Number.isFinite(x) || !Number.isFinite(at)) {
      this.reset();
      return;
    }
    const previous = this.previous;
    if (!previous || previous.source !== source || at - previous.at > STROKE_TIMEOUT) {
      this.reset();
      this.previous = { x, at, source };
      return;
    }
    const dt = at - previous.at;
    // Aggregate high-frequency pointer events into a usable velocity sample.
    if (dt < 0.008) return;
    const dx = x - previous.x;
    const speed = dx / dt;
    this.previous = { x, at, source };
    if (Math.abs(speed) < MIN_SPEED || Math.abs(speed) > MAX_SAMPLE_SPEED) {
      this.distance = 0;
      this.duration = 0;
      this.strength = 0;
      this.steps.length = 0;
      return;
    }
    if (Math.sign(dx) !== Math.sign(this.distance)) {
      this.distance = 0;
      this.duration = 0;
      this.steps.length = 0;
    }
    this.distance += dx;
    this.duration += dt;
    this.steps.push({ distance: dx, duration: dt });
    // Only recent motion matters. Slow tracking earlier in the rally must not
    // dilute a deliberate flick at contact.
    while (this.duration > STROKE_WINDOW) {
      const oldest = this.steps[0];
      if (!oldest) break;
      const removedTime = Math.min(oldest.duration, this.duration - STROKE_WINDOW);
      const removedDistance = oldest.distance * (removedTime / oldest.duration);
      this.duration -= removedTime;
      this.distance -= removedDistance;
      oldest.duration -= removedTime;
      oldest.distance -= removedDistance;
      if (oldest.duration <= 1e-8) this.steps.shift();
    }
    // Two or more coherent samples, at least a third of a hoop's width.
    this.strength =
      this.steps.length >= 2 && this.duration >= 0.025 && Math.abs(this.distance) >= 0.35
        ? Math.sign(dx) *
          Math.min(
            1,
            (Math.abs(this.distance) / this.duration - MIN_SPEED) / (FULL_SPEED - MIN_SPEED),
          )
        : 0;
  }

  read(at: number): number {
    const sample = this.previous;
    return sample && at >= sample.at && at - sample.at <= STROKE_TIMEOUT ? this.strength : 0;
  }

  age(at: number): number {
    return this.previous ? at - this.previous.at : STROKE_TIMEOUT;
  }
}

/** Peer paddle input is trusted like its position, but never allowed to exceed
 * local shot power. The host also requires a fresh sequence with a short TTL. */
export function validatedRemoteStroke(intent: number): number {
  return Number.isFinite(intent) ? Math.max(-1, Math.min(1, intent)) : 0;
}

/** Mutate a velocity using the exact integrated spin angle for this step.
 * Its magnitude and toward-opponent sign stay invariant, including edge hits.
 * Both host simulation and guest extrapolation run this same small function. */
export function curveVelocity(
  velocity: { x: number; y: number },
  spin: Spin,
  dt: number,
  minForwardFraction: number,
): Spin {
  if (!spin || dt <= 0) return spin;
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed === 0 || spin.left <= 0) return null;
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
}
