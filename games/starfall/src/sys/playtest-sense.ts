import { ENEMY_SPECS, SHIP_RADIUS, UFO_RADIUS } from "../shared/constants";
import type { SharedState } from "../shared/constants";
import type { Contact, Diagnostics, Target, Threat } from "../shared/diag";
import type { Pilot } from "../state/pilot";

/** What a player reads off the screen, as vectors from the ship — the part of the diagnostics a decision model steers by (shared/diag.ts). */

/** An enemy this close outranks a nearer rock: it shoots back and pays more. */
const ENEMY_PRIORITY_RANGE = 520;
/** Past this a hazard is off-screen noise. */
const THREAT_RANGE = 480;
const MAX_THREATS = 4;
const MAX_PICKUPS = 2;
/** Enemy shots have no hull worth modelling next to the ship's own. */
const SHOT_RADIUS = 3;

interface Body {
  kind: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export interface SenseInput {
  world: SharedState;
  pilot: Pilot;
  now: number;
}

const contact = (kind: string, dx: number, dy: number): Contact => ({
  dist: Math.round(Math.hypot(dx, dy)),
  dx: Math.round(dx),
  dy: Math.round(dy),
  kind,
});

const nearest = <T extends Contact>(list: T[], count: number, key: (c: T) => number): T[] =>
  list.toSorted((a, b) => key(a) - key(b)).slice(0, count);

const shootables = (world: SharedState, now: number): Body[] => {
  const out: Body[] = [];
  for (const e of world.enemies) {
    // flashing in: can't be hurt yet
    if (e.graceUntil <= now) {
      out.push({ ...e, radius: ENEMY_SPECS[e.kind].hitRadius });
    }
  }
  if (world.ufo) {
    out.push({ ...world.ufo, kind: "ufo", radius: UFO_RADIUS, vx: 0, vy: 0 });
  }
  return out;
};

const toTarget = (b: Body, pilot: Pilot): Target => {
  const dx = b.x - pilot.shipX;
  const dy = b.y - pilot.shipY;
  const { speed } = pilot.weapon;
  // hitscan weapons (speed 0) need no lead
  const flight = speed > 0 ? Math.hypot(dx, dy) / speed : 0;
  return {
    ...contact(b.kind, dx, dy),
    aimDx: Math.round(dx + b.vx * flight),
    aimDy: Math.round(dy + b.vy * flight),
    radius: Math.round(b.radius),
  };
};

const toThreat = (b: Body, pilot: Pilot): Threat => {
  const dx = b.x - pilot.shipX;
  const dy = b.y - pilot.shipY;
  const dist = Math.hypot(dx, dy) || 1;
  const rvx = b.vx - pilot.shipVX;
  const rvy = b.vy - pilot.shipVY;
  return {
    ...contact(b.kind, dx, dy),
    closing: Math.round(-(rvx * dx + rvy * dy) / dist),
    gap: Math.round(dist - b.radius - SHIP_RADIUS),
  };
};

const byDist = (t: Target): number => t.dist;

const pickTarget = (enemies: Body[], rocks: Body[], pilot: Pilot): Target | null => {
  const [enemy] = nearest(
    enemies.map((b) => toTarget(b, pilot)),
    1,
    byDist,
  );
  if (enemy && enemy.dist <= ENEMY_PRIORITY_RANGE) {
    return enemy;
  }
  const [rock] = nearest(
    rocks.map((b) => toTarget(b, pilot)),
    1,
    byDist,
  );
  return rock ?? enemy ?? null;
};

const aimError = (target: Target | null, shipAngle: number): number => {
  if (!target) {
    return 0;
  }
  const want = Math.atan2(target.aimDy, target.aimDx);
  const err = Math.atan2(Math.sin(want - shipAngle), Math.cos(want - shipAngle));
  return Math.round(Math.abs(err) * (180 / Math.PI));
};

export const senseSurroundings = (diag: Diagnostics, { world, pilot, now }: SenseInput): void => {
  const enemies = shootables(world, now);
  const rocks: Body[] = world.asteroids.map((a) => ({ ...a, kind: "asteroid" }));
  const shots: Body[] = world.enemyShots.map((s) => ({ ...s, kind: "shot", radius: SHOT_RADIUS }));

  diag.target = pickTarget(enemies, rocks, pilot);
  diag.aimErrorDeg = aimError(diag.target, pilot.shipAngle);
  diag.threats = nearest(
    [...enemies, ...rocks, ...shots]
      .map((b) => toThreat(b, pilot))
      .filter((t) => t.gap <= THREAT_RANGE),
    MAX_THREATS,
    (t) => t.gap,
  );
  diag.pickups = nearest(
    [
      ...world.shards.map((s) => contact("orb", s.x - pilot.shipX, s.y - pilot.shipY)),
      ...world.items.map((i) => contact(i.kind, i.x - pilot.shipX, i.y - pilot.shipY)),
    ],
    MAX_PICKUPS,
    (c) => c.dist,
  );
  diag.walls.left = Math.round(pilot.shipX);
  diag.walls.right = Math.round(world.playW - pilot.shipX);
  diag.walls.up = Math.round(pilot.shipY);
  diag.walls.down = Math.round(world.playH - pilot.shipY);
};
