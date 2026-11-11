// The match rules, as the host runs them. Pure apart from mutating the state
// it is handed: no DOM, no three.js, no network, so tools/rules.test.mts can
// play whole matches in milliseconds. Times are server-clock milliseconds.
//
// Two teams, Gold (0) and Steel (1). Each round one attacks: the attackers
// carry a charge to site A or B and plant it; the defenders hold the sites or
// defuse it. No respawns inside a round. First to WIN_ROUNDS takes the match;
// the sides swap after HALF rounds.

export type Team = 0 | 1;
export type Phase = "warmup" | "freeze" | "live" | "planted" | "post" | "over";
export type ChargeState = "none" | "carried" | "dropped" | "planted" | "defused" | "detonated";
export type RoundEnd = "eliminated" | "time" | "detonated" | "defused";

export const RULES = {
  /** Metres from a detonation that kill outright; damage fades to nothing at twice this. */
  blastRadius: 9,
  chargeMs: 40_000,
  defuseMs: 5000,
  /** Metres from the charge a defender can defuse. */
  defuseRadius: 1.8,
  freezeMs: 5000,
  /** Sides swap after this many rounds. */
  half: 4,
  /** The most one reported hit may deal (a rifle headshot). */
  maxHit: 120,
  maxHp: 100,
  overMs: 10_000,
  /** Metres an attacker must come within to pick a dropped charge up. */
  pickupRadius: 1.4,
  plantMs: 3000,
  postMs: 5000,
  roundMs: 115_000,
  /** Metres from a site's centre a charge can be planted. */
  siteRadius: 3.2,
  /** Most players a side holds. */
  teamSize: 8,
  /** Warmup deaths come back after this long. */
  warmupRespawnMs: 3000,
  winRounds: 5,
} as const;

export interface Fighter {
  team: Team;
  alive: boolean;
  hp: number;
  kills: number;
  deaths: number;
  /** Spawn slot on the team's side, 0-based. */
  slot: number;
  /** Warmup only: when a dead fighter comes back. */
  back: number;
}

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface Charge extends Point {
  state: ChargeState;
  carrier: string;
  /** 0 = A, 1 = B; -1 while unplanted. */
  site: number;
}

export interface MatchState {
  phase: Phase;
  round: number;
  /** When the current phase ends (0: never). */
  ends: number;
  score: [number, number];
  attack: Team;
  roster: Map<string, Fighter>;
  charge: Charge;
  last: { winner: Team; why: RoundEnd } | null;
}

export type MatchEvent =
  | { kind: "kill"; killer: string; victim: string; head: boolean }
  | { kind: "round-start"; round: number }
  | { kind: "round-end"; winner: Team; why: RoundEnd }
  | { kind: "planted"; site: number; by: string }
  | { kind: "half" }
  | { kind: "match-end"; winner: Team };

/** Where every client's body is, as its own reports say. */
export type Bodies = Record<string, Point | undefined>;

export const defender = (state: MatchState): Team => (state.attack === 0 ? 1 : 0);

const noCharge = (): Charge => ({ carrier: "", site: -1, state: "none", x: 0, y: 0, z: 0 });

export const newMatch = (): MatchState => ({
  attack: 0,
  charge: noCharge(),
  ends: 0,
  last: null,
  phase: "warmup",
  roster: new Map(),
  round: 0,
  score: [0, 0],
});

const teamOf = (state: MatchState, team: Team): [string, Fighter][] =>
  [...state.roster].filter(([, f]) => f.team === team);

const aliveOn = (state: MatchState, team: Team): number =>
  teamOf(state, team).filter(([, f]) => f.alive).length;

const dist2 = (a: Point, b: Point): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

/** Seat newcomers on the smaller side, drop leavers (their charge falls where they stood). */
export const syncRoster = (state: MatchState, ids: readonly string[], bodies: Bodies): void => {
  const present = new Set(ids);
  for (const id of state.roster.keys()) {
    if (present.has(id)) {
      continue;
    }
    if (state.charge.state === "carried" && state.charge.carrier === id) {
      dropCharge(state, bodies[id]);
    }
    state.roster.delete(id);
  }
  for (const id of ids) {
    if (state.roster.has(id)) {
      continue;
    }
    const gold = teamOf(state, 0).length;
    const steel = teamOf(state, 1).length;
    const team: Team = steel < gold ? 1 : 0;
    // Mid-round joiners watch until the next round; warmup puts them straight in.
    const live = state.phase === "warmup";
    state.roster.set(id, {
      alive: live,
      back: 0,
      deaths: 0,
      hp: live ? RULES.maxHp : 0,
      kills: 0,
      slot: Math.min(gold, steel),
      team,
    });
  }
};

const dropCharge = (state: MatchState, at: Point | undefined): void => {
  state.charge.state = "dropped";
  state.charge.carrier = "";
  if (at) {
    Object.assign(state.charge, { x: at.x, y: at.y, z: at.z });
  }
};

const startRound = (state: MatchState, now: number, rng: () => number): MatchEvent[] => {
  const events: MatchEvent[] = [];
  if (state.round === RULES.half && state.phase !== "over") {
    state.attack = defender(state);
    events.push({ kind: "half" });
  }
  state.round += 1;
  state.phase = "freeze";
  state.ends = now + RULES.freezeMs;
  state.last = null;
  const slots: [number, number] = [0, 0];
  for (const fighter of state.roster.values()) {
    fighter.alive = true;
    fighter.hp = RULES.maxHp;
    fighter.back = 0;
    fighter.slot = slots[fighter.team];
    slots[fighter.team] += 1;
  }
  const attackers = teamOf(state, state.attack);
  const carrier = attackers[Math.floor(rng() * attackers.length)]?.[0] ?? "";
  state.charge = { ...noCharge(), carrier, state: carrier ? "carried" : "none" };
  events.push({ kind: "round-start", round: state.round });
  return events;
};

const endRound = (state: MatchState, winner: Team, why: RoundEnd, now: number): MatchEvent[] => {
  state.score[winner] += 1;
  state.last = { why, winner };
  state.phase = "post";
  state.ends = now + RULES.postMs;
  const events: MatchEvent[] = [{ kind: "round-end", why, winner }];
  if (state.score[winner] >= RULES.winRounds) {
    state.phase = "over";
    state.ends = now + RULES.overMs;
    events.push({ kind: "match-end", winner });
  }
  return events;
};

const resetMatch = (state: MatchState): void => {
  state.score = [0, 0];
  state.round = 0;
  state.attack = 0;
  state.phase = "warmup";
  for (const fighter of state.roster.values()) {
    fighter.kills = 0;
    fighter.deaths = 0;
  }
};

const checkRoundOver = (state: MatchState, now: number): MatchEvent[] => {
  const atk = state.attack;
  const def = defender(state);
  if (state.phase === "live") {
    if (aliveOn(state, atk) === 0) {
      return endRound(state, def, "eliminated", now);
    }
    if (aliveOn(state, def) === 0) {
      return endRound(state, atk, "eliminated", now);
    }
    if (now >= state.ends) {
      return endRound(state, def, "time", now);
    }
  } else if (state.phase === "planted") {
    if (now >= state.ends) {
      state.charge.state = "detonated";
      return endRound(state, atk, "detonated", now);
    }
    if (aliveOn(state, def) === 0) {
      return endRound(state, atk, "eliminated", now);
    }
  }
  return [];
};

const bothSidesManned = (state: MatchState): boolean =>
  teamOf(state, 0).length > 0 && teamOf(state, 1).length > 0;

const warmupRespawns = (state: MatchState, now: number): void => {
  for (const fighter of state.roster.values()) {
    if (!fighter.alive && fighter.back > 0 && now >= fighter.back) {
      Object.assign(fighter, { alive: true, back: 0, hp: RULES.maxHp });
    }
  }
};

const pickUpCharge = (state: MatchState, bodies: Bodies): void => {
  if (state.charge.state !== "dropped") {
    return;
  }
  for (const [id, f] of teamOf(state, state.attack)) {
    const at = bodies[id];
    if (f.alive && at && dist2(at, state.charge) <= RULES.pickupRadius ** 2) {
      state.charge.state = "carried";
      state.charge.carrier = id;
      return;
    }
  }
};

/** Advance the clock: phase changes, warmup respawns, charge pickups, round ends. */
export const tick = (
  state: MatchState,
  now: number,
  bodies: Bodies,
  rng: () => number,
): MatchEvent[] => {
  if (state.phase !== "warmup" && state.phase !== "over" && !bothSidesManned(state)) {
    // A side emptied out: back to warmup, everyone up.
    resetMatch(state);
    for (const fighter of state.roster.values()) {
      Object.assign(fighter, { alive: true, hp: RULES.maxHp });
    }
    return [];
  }
  if (state.phase === "warmup") {
    warmupRespawns(state, now);
    return bothSidesManned(state) ? startRound(state, now, rng) : [];
  }
  if (state.phase === "freeze") {
    if (now >= state.ends) {
      state.phase = "live";
      state.ends = now + RULES.roundMs;
    }
    return [];
  }
  if (state.phase === "post") {
    return now >= state.ends ? startRound(state, now, rng) : [];
  }
  if (state.phase === "over") {
    if (now < state.ends) {
      return [];
    }
    resetMatch(state);
    return bothSidesManned(state) ? startRound(state, now, rng) : [];
  }
  pickUpCharge(state, bodies);
  return checkRoundOver(state, now);
};

const fighting = (state: MatchState): boolean =>
  state.phase === "warmup" || state.phase === "live" || state.phase === "planted";

const kill = (
  state: MatchState,
  victim: string,
  killer: string,
  head: boolean,
  now: number,
  bodies: Bodies,
): MatchEvent[] => {
  const f = state.roster.get(victim);
  if (!f) {
    return [];
  }
  f.alive = false;
  f.hp = 0;
  f.deaths += 1;
  if (state.phase === "warmup") {
    f.back = now + RULES.warmupRespawnMs;
  }
  const by = state.roster.get(killer);
  if (by && killer !== victim) {
    by.kills += 1;
  }
  if (state.charge.state === "carried" && state.charge.carrier === victim) {
    dropCharge(state, bodies[victim]);
  }
  return [{ head, killer, kind: "kill", victim }];
};

/** A shooter's client says it hit `victim`. Friendly fire is off. Returns the victim's hp left, or null if refused. */
export const applyHit = (
  state: MatchState,
  shooter: string,
  victim: string,
  damage: number,
  head: boolean,
  now: number,
  bodies: Bodies,
): { hp: number; events: MatchEvent[] } | null => {
  const from = state.roster.get(shooter);
  const to = state.roster.get(victim);
  if (!from || !to || !from.alive || !to.alive || from.team === to.team || !fighting(state)) {
    return null;
  }
  const dealt = Math.max(0, Math.min(RULES.maxHit, damage));
  to.hp = Math.max(0, to.hp - dealt);
  const events = to.hp <= 0 ? kill(state, victim, shooter, head, now, bodies) : [];
  return { events, hp: to.hp };
};

/**
 * A client reports its own health (barrels, falls, the blast): the host trusts
 * it only downward and only for the round it belongs to.
 */
export const applySelfReport = (
  state: MatchState,
  id: string,
  hp: number,
  round: number,
  now: number,
  bodies: Bodies,
): MatchEvent[] => {
  const f = state.roster.get(id);
  if (!f || !f.alive || round !== state.round || !fighting(state) || hp >= f.hp) {
    return [];
  }
  f.hp = Math.max(0, hp);
  return f.hp <= 0 ? kill(state, id, "", false, now, bodies) : [];
};

/** The carrier asks to plant at `site` (0 = A, 1 = B) where it stands. */
export const applyPlant = (
  state: MatchState,
  id: string,
  site: number,
  sites: readonly Point[],
  bodies: Bodies,
  now: number,
): MatchEvent[] => {
  const at = bodies[id];
  const target = sites[site];
  const f = state.roster.get(id);
  if (
    state.phase !== "live" ||
    state.charge.state !== "carried" ||
    state.charge.carrier !== id ||
    !f?.alive ||
    !at ||
    !target ||
    dist2(at, target) > RULES.siteRadius ** 2
  ) {
    return [];
  }
  state.charge = { carrier: "", site, state: "planted", x: at.x, y: at.y, z: at.z };
  state.phase = "planted";
  state.ends = now + RULES.chargeMs;
  return [{ by: id, kind: "planted", site }];
};

/** A defender asks to defuse, standing over the charge. */
export const applyDefuse = (
  state: MatchState,
  id: string,
  bodies: Bodies,
  now: number,
): MatchEvent[] => {
  const at = bodies[id];
  const f = state.roster.get(id);
  if (
    state.phase !== "planted" ||
    !f?.alive ||
    f.team !== defender(state) ||
    !at ||
    dist2(at, state.charge) > RULES.defuseRadius ** 2
  ) {
    return [];
  }
  state.charge.state = "defused";
  return endRound(state, defender(state), "defused", now);
};
