/**
 * Wire quantization for a client's own state — the flat primitive record each
 * client pushes at PLAYER_NET_HZ. The host's world rows quantize in
 * net/world-wire.ts, shots in net/fire-wire.ts.
 *
 * Why: raw float64 positions JSON-stringify at up to 17 significant digits
 * ("3811.9282936758663" — 18 bytes where "3811.9" carries everything the
 * receiver can use). Primitives also matter: the SDK drops a primitive key
 * whose value did not change, so an idle player's update is just its stamp.
 *
 * Quantize ONLY at the serialization boundary: the local sim keeps full
 * precision (rounding inside the sim at 60Hz would stall slow integrations
 * below the step size).
 */

import type { PlayerNetState } from "./constants";

/** 0.1px — positions. */
export const q1 = (n: number): number => Math.round(n * 10) / 10;
/** 0.01 — remote ship headings (~0.6°) and the windup glow. */
export const q2 = (n: number): number => Math.round(n * 100) / 100;
/** 0.001 rad (~0.06°) — aim that a shot follows for hundreds of px. */
export const q3 = (n: number): number => Math.round(n * 1000) / 1000;

/** My state as it rides the wire: flat primitives only. `mod` is the shield
 *  mod kind ("" for none) — keys are merged, never deleted, so absence has to
 *  be a value. */
export const playerToWire = (s: PlayerNetState) => ({
  alive: s.alive,
  angle: q2(s.angle),
  invuln: s.invuln,
  level: s.level,
  magnet: s.magnet,
  mod: s.shieldMod?.kind ?? "",
  modOn: s.shieldMod?.active === true,
  nitro: s.nitro,
  overHp: s.overHp,
  phased: s.shieldMod?.phased === true,
  present: s.present,
  sectorScore: s.sectorScore,
  shieldHp: s.shieldHp,
  streak: s.streak,
  t: Math.round(s.t),
  tesla: s.tesla,
  twin: s.twin,
  // Whole px/s: remotes only light a trail and the host leads its aim off it.
  vx: Math.round(s.vx),
  vy: Math.round(s.vy),
  weaponName: s.weaponName,
  windup: q2(s.windup),
  x: q1(s.x),
  xp: s.xp,
  y: q1(s.y),
});
