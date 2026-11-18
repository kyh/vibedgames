export const PLATEAU_R = 11;
export const PLATEAU_H = 2;
export const STAIR_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];

/** Walkable stair-gap half-width (radians). 0.26 rad ≈ 15° → a ~5.7u-wide gap at
 *  the plateau edge: two bodies abreast. (Was 0.18 — only 8 of 36 approach
 *  headings could find a gap, which read as "the throne is walled off".) */
export const STAIR_HALF = 0.26;

/** Radial length of the stair run, measured OUTWARD from the plateau edge. The
 *  ramp climbs 0 → PLATEAU_H across this band. */
export const STAIR_RUN = 3.2;
const STAIR_FEATHER = 0.07;
const WALL_SLIDE = 1.25;
const DEPENETRATE = 0.06;

export const onPlateau = (x: number, y: number) => x * x + y * y < PLATEAU_R * PLATEAU_R;

const smoothstep = (t: number) => {
  const c = Math.min(1, Math.max(0, t));

  return c * c * (3 - 2 * c);
};

const nearestStairAngle = (ang: number) => {
  let center = STAIR_ANGLES[0] ?? 0;
  let delta = Infinity;

  for (const s of STAIR_ANGLES) {
    const d = Math.atan2(Math.sin(ang - s), Math.cos(ang - s));

    if (Math.abs(d) < Math.abs(delta)) {
      center = s;
      delta = d;
    }
  }

  return { center, delta: delta === Infinity ? 0 : delta };
};

const inStairGap = (ang: number) => Math.abs(nearestStairAngle(ang).delta) < STAIR_HALF;

/** Walkable ground height at (x, y) — the ONE height function. Flat plaza at 0,
 *  flat platform top at PLATEAU_H, and a real ramp up each stair run between
 *  them. Renderer reads this for unit feet, camera, and the stair mesh fit. */
export const groundHeight = (x: number, y: number) => {
  const r = Math.hypot(x, y);

  if (r <= PLATEAU_R) {
    return PLATEAU_H;
  }

  if (r >= PLATEAU_R + STAIR_RUN) {
    return 0;
  }

  const { delta } = nearestStairAngle(Math.atan2(y, x));
  const lateral = 1 - smoothstep((Math.abs(delta) - STAIR_HALF) / STAIR_FEATHER);

  if (lateral <= 0) {
    return 0;
  }

  const climb = 1 - (r - PLATEAU_R) / STAIR_RUN;

  return PLATEAU_H * climb * lateral;
};

/** Block a move that crosses the plateau edge unless it's through a stair gap.
 *  A blocked move keeps its tangential speed AND is nudged around the wall
 *  toward the nearest stair, so holding "forward" into the wall walks you to the
 *  way up instead of pinning you. */
export const resolveElevation = (
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
) => {
  if (inStairGap(Math.atan2(toY, toX))) {
    return { x: toX, y: toY };
  }

  const fromIn = onPlateau(fromX, fromY);
  const limit = fromIn ? PLATEAU_R - radius - 0.06 : PLATEAU_R + radius + 0.06;
  const rNow = Math.hypot(fromX, fromY) || 1;
  const rTo = Math.hypot(toX, toY);
  const legal = fromIn ? rTo <= Math.max(limit, rNow) : rTo >= Math.min(limit, rNow);

  if (legal) {
    return { x: toX, y: toY };
  }

  const push = fromIn ? -DEPENETRATE : DEPENETRATE;

  const wall = fromIn
    ? Math.min(rNow, Math.max(limit, rNow + push))
    : Math.max(rNow, Math.min(limit, rNow + push));

  const toAng = Math.atan2(toY, toX);
  const fromAng = Math.atan2(fromY, fromX);
  const tangential = Math.atan2(Math.sin(toAng - fromAng), Math.cos(toAng - fromAng));

  const into = ((toX - fromX) * fromX + (toY - fromY) * fromY) / rNow;
  const radialKilled = Math.max(0, fromIn ? into : -into);
  const { delta } = nearestStairAngle(fromAng);
  const toward = delta > 0 ? -1 : 1;
  const swing = Math.min((radialKilled * WALL_SLIDE) / wall, Math.abs(delta));
  const slide = toward * swing;

  const ang = fromAng + tangential + slide;

  return { x: Math.cos(ang) * wall, y: Math.sin(ang) * wall };
};

/** A waypoint just outside the nearest stair gap — bots steer here to reach the
 *  plateau instead of grinding the wall. */
export const nearestStair = (x: number, y: number) => {
  const { center } = nearestStairAngle(Math.atan2(y, x));

  return {
    x: Math.cos(center) * (PLATEAU_R + STAIR_RUN * 0.5),
    y: Math.sin(center) * (PLATEAU_R + STAIR_RUN * 0.5),
  };
};
