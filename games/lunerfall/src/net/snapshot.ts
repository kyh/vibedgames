// Host → guest wire format. The host runs the authoritative sim and broadcasts a
// compact snapshot each network tick (sharedState["snap"]); the room layout is
// sent separately (sharedState["room"]) only when it changes, since it's larger
// and static per-room. Guests drive their view puppets from these — except a
// guest's OWN player, which is locally predicted and reconciled against its
// snapshot copy (net/predict.ts). Everything here is plain JSON.

import { isJsonObject } from "./json";
import type { JsonValue } from "./json";

// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type NetPlayer = {
  id: string;
  hero: string;
  x: number;
  y: number;
  facing: number;
  vy: number;
  vx: number;
  grounded: boolean;
  dashing: boolean;
  hurting: boolean;
  dead: boolean;
  // co-op last stand: frozen awaiting a revive
  downed: boolean;
  iframes: number;
  attackStep: number;
  swingId: number;
  specialActive: boolean;
  specialId: number;
};

// Enemies/boss travel as the clip the host is already playing (read after its
// render) so the guest just re-plays it — no state-enum re-derivation, no drift.
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type NetEnemy = {
  id: number;
  name: string;
  clip: string;
  x: number;
  y: number;
  flip: boolean;
  dead: boolean;
  flash: boolean;
};
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type NetBoss = {
  clip: string;
  x: number;
  y: number;
  flip: boolean;
  hpFrac: number;
  flash: boolean;
  telegraph: boolean;
  dead: boolean;
};

// Guest → host input. Held state travels as booleans; each action carries a
// monotonic counter so a press is never lost even if the net tick is slower than
// the frame rate (the host derives an edge when a counter increments).
// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
export type NetInput = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jumpHeld: boolean;
  j: number;
  d: number;
  a: number;
  s: number;
};
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type NetProj = {
  k: "arrow" | "shot" | "hazard";
  x: number;
  y: number;
  vx: number;
};

// Co-op last stand: broadcast while a player is downed. bleed = seconds left on
// the bleed-out clock; rev = 0..1 revive-hold progress. Which player is downed
// travels on NetPlayer.downed; both clients render the marker from these.
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type NetLastStand = {
  bleed: number;
  rev: number;
};

// Online versus: the match state, broadcast every snapshot while in versus mode.
// Sides are fixed (host = left duelist, guest = right) so hearts/scores never
// need a player-id mapping on either client.
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type NetVersus = {
  phase: "waiting" | "countdown" | "fighting" | "roundEnd" | "matchEnd";
  // 1-based; 0 while waiting for the challenger
  round: number;
  // seconds left in the current timed phase
  t: number;
  hostHp: number;
  guestHp: number;
  hostScore: number;
  guestScore: number;
  // round winner in roundEnd, match in matchEnd
  winner: "host" | "guest" | null;
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
export type Snapshot = {
  // host frame counter — interpolation + stall detection
  t: number;
  // room seq; guest rebuilds its room when this changes
  room: number;
  players: NetPlayer[];
  enemies: NetEnemy[];
  boss: NetBoss | null;
  proj: NetProj[];
  hearts: number;
  maxHearts: number;
  gold: number;
  biome: number;
  depth: number;
  cleared: boolean;
  lastStand: NetLastStand | null;
  // versus mode only; null in co-op
  vs: NetVersus | null;
  banner: string;
};

// Full room layout — sent once per room (not per frame).
// oxlint-disable-next-line typescript/consistent-type-definitions -- type alias keeps the implicit index signature JsonValue needs
export type NetDoor = {
  index: number;
  x: number;
  y: number;
  type: string;
  label: string;
  danger: boolean;
};
// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
export type NetRoom = {
  seq: number;
  // "coop" | "vs" — versus arenas mirror the guest spawn, no doors
  mode: string;
  type: string;
  cols: number;
  rows: number;
  cells: number[];
  spawnX: number;
  spawnY: number;
  doors: NetDoor[];
  propKey: string;
  mustClear: boolean;
};

export const isSnapshot = (v: JsonValue | undefined): v is Snapshot =>
  isJsonObject(v) && "players" in v && "t" in v && Array.isArray(v.players);

export const isRoom = (v: JsonValue | undefined): v is NetRoom =>
  isJsonObject(v) && "cells" in v && "seq" in v && Array.isArray(v.cells);
