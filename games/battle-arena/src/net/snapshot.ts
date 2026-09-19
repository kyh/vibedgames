// World ↔ wire snapshot. The World is plain data except its two Maps, so
// encoding is just Map→record. rngState travels so a guest that takes over
// hosting continues the exact deterministic stream. fx is broadcast separately
// (fx/fxSeq), not in the snapshot.
import type { JsonValue } from "../data/json";
import { KILL_GOAL_FFA, MATCH_TIME } from "../data/config";
import { BOSS_POS } from "../data/map";
import type {
  BossState,
  Coin,
  Delivery,
  GroundEffect,
  PendingStrike,
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
  strikes: PendingStrike[];
  coins: Coin[];
  deliveries: Delivery[];
  boss: BossState;
};

export const encodeWorld = (w: World): Snapshot => ({
  boss: w.boss,
  campRespawnAt: w.campRespawnAt,
  coins: w.coins,
  deliveries: w.deliveries,
  gameTime: w.gameTime,
  grounds: w.grounds,
  killGoal: w.killGoal,
  leaderId: w.leaderId,
  matchTime: w.matchTime,
  nextCoinAt: w.nextCoinAt,
  nextDeliveryAt: w.nextDeliveryAt,
  now: w.now,
  phase: w.phase,
  projectiles: Object.fromEntries(w.projectiles),
  rngState: w.rngState,
  seq: w.seq,
  strikes: w.strikes,
  suddenDeath: w.suddenDeath,
  units: Object.fromEntries(w.units),
  winner: w.winner,
});

export const emptyGuestWorld = (): World => ({
  boss: { alive: true, hp: 4000, maxHp: 4000, x: BOSS_POS.x, y: BOSS_POS.y },
  campRespawnAt: {},
  coins: [],
  deliveries: [],
  fx: [],
  gameTime: 0,
  grounds: [],
  killGoal: KILL_GOAL_FFA,
  leaderId: null,
  matchTime: MATCH_TIME,
  nextCoinAt: 0,
  nextDeliveryAt: 0,
  now: 0,
  phase: "playing",
  projectiles: new Map(),
  rngState: 1,
  seq: 0,
  strikes: [],
  suddenDeath: false,
  units: new Map(),
  winner: null,
});

const rebuildMap = <T>(map: Map<string, T>, rec: Record<string, T>): void => {
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(rec)) {
    seen.add(k);
    map.set(k, v);
  }
  for (const k of map.keys()) {
    if (!seen.has(k)) {
      map.delete(k);
    }
  }
};

/** Apply a snapshot onto a guest's World in place (preserves object identity). */
export const applySnapshot = (w: World, s: Snapshot): void => {
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
  w.strikes = s.strikes ?? [];
  w.coins = s.coins ?? [];
  w.deliveries = s.deliveries ?? [];
  w.boss = s.boss ?? w.boss;
};

export const isSnapshot = (v: Snapshot | JsonValue | undefined): v is Snapshot =>
  v instanceof Object && !Array.isArray(v) && "units" in v && "gameTime" in v;
