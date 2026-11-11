// The deathmatch rules, as the host runs them. Pure apart from mutating the
// state it is handed: no DOM, no three.js, no network, so
// tools/rules.test.mts can play whole matches in milliseconds. Times are
// server-clock milliseconds.
//
// Every player for themselves. A death comes back after respawnMs; first to
// `kills`, or the most kills when matchMs runs out, takes it. Then overMs of
// results and a fresh match. Alone, the room sits in warmup (free play).
//
// Every fighter has a `life` that goes up each time the host brings it back.
// A client places its body when the life it sees moves, and its own health
// reports count only for the life it is playing.

export type Phase = "warmup" | "live" | "over";

export const RULES = {
  /** Kills that win a match. */
  kills: 25,
  /** How long a match runs before the most kills wins. */
  matchMs: 600_000,
  /** The most one reported hit may deal (a rifle headshot). */
  maxHit: 120,
  maxHp: 100,
  /** Results between one match and the next. */
  overMs: 10_000,
  /** How long a death lasts. */
  respawnMs: 3000,
} as const;

export interface Fighter {
  alive: boolean;
  hp: number;
  kills: number;
  deaths: number;
  /** When a dead fighter comes back (0: not scheduled). */
  back: number;
  /** Goes up each time the host brings this fighter back. */
  life: number;
}

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface MatchState {
  phase: Phase;
  /** Matches started in this room; a new one is a fresh dock. */
  round: number;
  /** When the current phase ends (0: never). */
  ends: number;
  roster: Map<string, Fighter>;
  /** Who took the last match ("" before any). */
  champ: string;
}

export type MatchEvent =
  | { kind: "kill"; killer: string; victim: string; head: boolean }
  | { kind: "start"; round: number }
  | { kind: "end"; champ: string };

export const newMatch = (): MatchState => ({
  champ: "",
  ends: 0,
  phase: "warmup",
  roster: new Map(),
  round: 0,
});

/** Seat newcomers (straight in), drop leavers. */
export const syncRoster = (state: MatchState, ids: readonly string[]): void => {
  const present = new Set(ids);
  for (const id of state.roster.keys()) {
    if (!present.has(id)) {
      state.roster.delete(id);
    }
  }
  for (const id of ids) {
    if (!state.roster.has(id)) {
      state.roster.set(id, { alive: true, back: 0, deaths: 0, hp: RULES.maxHp, kills: 0, life: 1 });
    }
  }
};

/** Bring a fighter back: full health, and a new life the client will place. */
const revive = (fighter: Fighter): void => {
  fighter.alive = true;
  fighter.hp = RULES.maxHp;
  fighter.back = 0;
  fighter.life += 1;
};

/** A fresh match: kills cleared, everyone up on a new life. */
const start = (state: MatchState, now: number): MatchEvent[] => {
  state.phase = "live";
  state.round += 1;
  state.ends = now + RULES.matchMs;
  for (const fighter of state.roster.values()) {
    fighter.kills = 0;
    fighter.deaths = 0;
    revive(fighter);
  }
  return [{ kind: "start", round: state.round }];
};

/** Everyone by kills, then fewest deaths, then who sat first: the HUD and the winner agree. */
export const standings = (state: MatchState): [string, Fighter][] =>
  [...state.roster].toSorted(([, a], [, b]) => b.kills - a.kills || a.deaths - b.deaths);

/** Advance the clock: respawns, the kill limit, the time limit, the next match. */
export const tick = (state: MatchState, now: number): MatchEvent[] => {
  const crowd = state.roster.size >= 2;
  if (state.phase === "over") {
    if (now < state.ends) {
      return [];
    }
    if (crowd) {
      return start(state, now);
    }
    state.phase = "warmup";
    state.ends = 0;
    return [];
  }
  for (const fighter of state.roster.values()) {
    if (!fighter.alive && fighter.back > 0 && now >= fighter.back) {
      revive(fighter);
    }
  }
  if (state.phase === "warmup") {
    return crowd ? start(state, now) : [];
  }
  if (!crowd) {
    state.phase = "warmup";
    state.ends = 0;
    return [];
  }
  const [leader] = standings(state);
  if (!leader) {
    return [];
  }
  const [champ, best] = leader;
  if (best.kills >= RULES.kills || now >= state.ends) {
    state.phase = "over";
    state.ends = now + RULES.overMs;
    state.champ = champ;
    return [{ champ, kind: "end" }];
  }
  return [];
};

const fighting = (state: MatchState): boolean => state.phase !== "over";

const kill = (
  state: MatchState,
  victim: string,
  killer: string,
  head: boolean,
  now: number,
): MatchEvent[] => {
  const f = state.roster.get(victim);
  if (!f) {
    return [];
  }
  f.alive = false;
  f.hp = 0;
  f.deaths += 1;
  f.back = now + RULES.respawnMs;
  const by = state.roster.get(killer);
  if (by && killer !== victim) {
    by.kills += 1;
  }
  return [{ head, killer, kind: "kill", victim }];
};

/** A shooter's client says it hit `victim`. Returns the victim's hp left, or null if refused. */
export const applyHit = (
  state: MatchState,
  shooter: string,
  victim: string,
  damage: number,
  head: boolean,
  now: number,
): { hp: number; events: MatchEvent[] } | null => {
  const from = state.roster.get(shooter);
  const to = state.roster.get(victim);
  if (!from || !to || !from.alive || !to.alive || shooter === victim || !fighting(state)) {
    return null;
  }
  const dealt = Math.max(0, Math.min(RULES.maxHit, damage));
  to.hp = Math.max(0, to.hp - dealt);
  const events = to.hp <= 0 ? kill(state, victim, shooter, head, now) : [];
  return { events, hp: to.hp };
};

/**
 * A client reports its own health (barrels, falls): the host trusts it only
 * downward, and only for the life the client is playing — a report sent
 * before a revive reached it says nothing about the new life.
 */
export const applySelfReport = (
  state: MatchState,
  id: string,
  hp: number,
  life: number,
  now: number,
): MatchEvent[] => {
  const f = state.roster.get(id);
  if (!f || !f.alive || life !== f.life || !fighting(state) || hp >= f.hp) {
    return [];
  }
  f.hp = Math.max(0, hp);
  return f.hp <= 0 ? kill(state, id, "", false, now) : [];
};
