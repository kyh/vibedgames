import type { JsonRecord } from "@vibedgames/multiplayer";

import { BOOST_SPEED, RAM_DAMAGE, RAM_THROW, SPEED_THROW } from "../shared/constants";
import type { Hit, HitHow } from "../sim/car";
import { CAR_KINDS, KINDS, SCOOP_LIFT } from "../sim/kinds";
import type { AttackKind } from "../sim/kinds";
import {
  GIANT_POWER,
  MAGNET_DAMAGE,
  MAGNET_RADIUS,
  MAGNET_STOP,
  MINE_DAMAGE,
  MINE_THROW,
  ROCKET_DAMAGE,
  ROCKET_THROW,
  SEEKER_DAMAGE,
  SEEKER_THROW,
  SHOCK_DAMAGE,
  SHOCK_THROW,
  STOMP_DAMAGE,
  STOMP_THROW,
  TURBO_SPEED,
  ZAP_DAMAGE,
  ZAP_STUN,
} from "../sim/specials";
import { HOWS } from "./pose";
import { isJsonNumber, isJsonObject, isJsonString, numberOr } from "./wire";
import type { WireField } from "./wire";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

const TOP_SPEED = BOOST_SPEED * TURBO_SPEED * Math.max(...CAR_KINDS.map((k) => KINDS[k].speed));
const SLACK = 1.05;

const attackLimit = (attack: AttackKind) => {
  let reach = 0;
  let damage = 0;

  for (const kind of CAR_KINDS) {
    const def = KINDS[kind];

    if (def.attack === attack) {
      reach = Math.max(reach, (def.throw + TOP_SPEED * SPEED_THROW) * def.power * GIANT_POWER);
      damage = Math.max(damage, def.damage * 1.2);
    }
  }

  return { damage, lift: attack === "scoop" ? SCOOP_LIFT : 1, reach, stun: 0 };
};

const plain = (reach: number, damage: number) => ({ damage, lift: 1, reach, stun: 0 });

const LIMITS: Partial<Record<HitHow, ReturnType<typeof plain>>> = {
  dash: attackLimit("dash"),
  land: plain(2.6, 0),
  magnet: { damage: MAGNET_DAMAGE, lift: 1, reach: MAGNET_RADIUS + MAGNET_STOP, stun: 0 },
  mine: plain(MINE_THROW, MINE_DAMAGE),
  punch: attackLimit("punch"),
  ram: plain(RAM_THROW, RAM_DAMAGE),
  rocket: plain(ROCKET_THROW, ROCKET_DAMAGE),
  scoop: attackLimit("scoop"),
  seeker: plain(SEEKER_THROW, SEEKER_DAMAGE),
  shock: plain(SHOCK_THROW, SHOCK_DAMAGE),
  shot: attackLimit("shot"),
  slam: attackLimit("slam"),
  spin: attackLimit("spin"),
  stomp: plain(STOMP_THROW, STOMP_DAMAGE),
  zap: { damage: ZAP_DAMAGE, lift: 1, reach: 0, stun: ZAP_STUN },
};

/** A blow on its way to the client that simulates its victim. */
export const encodeHit: (hit: Hit) => JsonRecord = (hit) => ({
  b: hit.by,
  d: round2(hit.damage),
  i: hit.id,
  l: round2(hit.lift),
  n: HOWS.indexOf(hit.how),
  r: round2(hit.reach),
  s: round2(hit.stun),
  x: round2(hit.dx),
  z: round2(hit.dz),
});

/**
 * A blow somebody else dealt, or null if it is not one. Every number is held to
 * what the hardest real blow of its kind could carry, so a made-up one can do
 * no more than a real one.
 */
export const readHit: (value: WireField) => Hit | null = (value) => {
  if (!isJsonObject(value)) {
    return null;
  }

  const { b, i, r, x, z } = value;
  const how = HOWS[numberOr(value.n, -1)];
  const limit = how ? LIMITS[how] : undefined;

  if (!isJsonString(i) || !isJsonString(b) || !how || !limit) {
    return null;
  }

  if (!isJsonNumber(x) || !isJsonNumber(z) || !isJsonNumber(r)) {
    return null;
  }

  const length = Math.hypot(x, z) || 1;

  return {
    by: b,
    damage: clamp(numberOr(value.d, 0), 0, limit.damage * SLACK),
    dx: x / length,
    dz: z / length,
    how,
    id: i,
    lift: clamp(numberOr(value.l, 1), 0, limit.lift),
    reach: clamp(r, 0, limit.reach * SLACK),
    stun: clamp(numberOr(value.s, 0), 0, limit.stun),
  };
};
