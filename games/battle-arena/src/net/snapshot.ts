// World ↔ wire snapshot. The World is plain data except its two Maps, so
// encoding is just Map→record. rngState travels so a guest that takes over
// hosting continues the exact deterministic stream. fx is broadcast separately
// (fx/fxSeq), not in the snapshot.
import { KILL_GOAL_FFA, MATCH_TIME } from "../data/config";
import { BOSS_POS } from "../data/map";
import type {
  BossState,
  Coin,
  Delivery,
  GroundEffect,
  Projectile,
  Unit,
  World,
} from "../sim/types";

export type Snapshot = {
  now: number;
  gameTime: number;
  phase: World["phase"];
  winner: World["winner"];
  killGoal: number;
  matchTime: number;
  suddenDeath: boolean;
  leaderId: World["leaderId"];
  nextCoinAt: number;
  nextDeliveryAt: number;
  campRespawnAt: Record<string, number>;
  seq: number;
  rngState: number;
  units: Record<string, Unit>;
  projectiles: Record<string, Projectile>;
  grounds: GroundEffect[];
  coins: Coin[];
  deliveries: Delivery[];
  boss: BossState;
};

export function encodeWorld(w: World): Snapshot {
  return {
    now: w.now,
    gameTime: w.gameTime,
    phase: w.phase,
    winner: w.winner,
    killGoal: w.killGoal,
    matchTime: w.matchTime,
    suddenDeath: w.suddenDeath,
    leaderId: w.leaderId,
    nextCoinAt: w.nextCoinAt,
    nextDeliveryAt: w.nextDeliveryAt,
    campRespawnAt: w.campRespawnAt,
    seq: w.seq,
    rngState: w.rngState,
    units: Object.fromEntries(w.units),
    projectiles: Object.fromEntries(w.projectiles),
    grounds: w.grounds,
    coins: w.coins,
    deliveries: w.deliveries,
    boss: w.boss,
  };
}

export function emptyGuestWorld(): World {
  return {
    now: 0,
    gameTime: 0,
    phase: "playing",
    winner: null,
    killGoal: KILL_GOAL_FFA,
    matchTime: MATCH_TIME,
    suddenDeath: false,
    units: new Map(),
    projectiles: new Map(),
    grounds: [],
    coins: [],
    deliveries: [],
    boss: { x: BOSS_POS.x, y: BOSS_POS.y, hp: 4000, maxHp: 4000, alive: true },
    leaderId: null,
    nextCoinAt: 0,
    nextDeliveryAt: 0,
    campRespawnAt: {},
    fx: [],
    seq: 0,
    rngState: 1,
  };
}

function rebuildMap<T>(map: Map<string, T>, rec: Record<string, T>): void {
  const seen = new Set<string>();
  for (const k of Object.keys(rec)) {
    seen.add(k);
    map.set(k, rec[k]!);
  }
  for (const k of [...map.keys()]) if (!seen.has(k)) map.delete(k);
}

/** Apply a snapshot onto a guest's World in place (preserves object identity). */
export function applySnapshot(w: World, s: Snapshot): void {
  w.now = s.now;
  w.gameTime = s.gameTime;
  w.phase = s.phase;
  w.winner = s.winner;
  w.killGoal = s.killGoal;
  w.matchTime = s.matchTime;
  w.suddenDeath = s.suddenDeath;
  w.leaderId = s.leaderId;
  w.nextCoinAt = s.nextCoinAt;
  w.nextDeliveryAt = s.nextDeliveryAt;
  w.campRespawnAt = s.campRespawnAt ?? {};
  w.seq = s.seq;
  w.rngState = s.rngState ?? w.rngState;
  rebuildMap(w.units, s.units);
  rebuildMap(w.projectiles, s.projectiles);
  w.grounds = s.grounds ?? [];
  w.coins = s.coins ?? [];
  w.deliveries = s.deliveries ?? [];
  w.boss = s.boss ?? w.boss;
}

export function isSnapshot(v: unknown): v is Snapshot {
  return typeof v === "object" && v !== null && "units" in v && "gameTime" in v;
}
