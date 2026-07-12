// ──────────────────────────────────────────────────────────────────────────
// ALL tunable constants live here (the build-doc §15 table). Pure data + a few
// pure helper curves. No engine, no DOM, no Math.random — safe for the sim.
// ──────────────────────────────────────────────────────────────────────────

/** A "team" is a player id in FFA, or a fixed team id in team modes. "neutral"
 *  is enemy to everyone (the Over Boss). */
export type Team = string;
export const NEUTRAL_TEAM = "neutral";

export type DamageType = "physical" | "magic" | "pure";

export type Mode = "ffa" | "teams";

// ── Match ──────────────────────────────────────────────────────────────────
export const MODE: Mode = "ffa";
export const KILL_GOAL_FFA = 25; // first to this many kills wins
export const MATCH_TIME = 480; // seconds; top score wins at timer, ties → sudden death
export const MAX_PLAYERS = 6; // per room
export const MIN_PLAYERS_TO_START = 1; // bots fill the rest
export const ARENA_BOT_FILL = 4; // total combatants the host keeps populated (humans + bots)

// ── Sim timing ───────────────────────────────────────────────────────────────
export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
export const SNAPSHOT_HZ = 15;

// ── Throne (the magnet at center) ────────────────────────────────────────────
export const THRONE_RADIUS = 11; // world units
export const THRONE_GOLD_MULT = 0.3; // +30% gold while inside
export const THRONE_XP_MULT = 0.3; // +30% xp while inside

// ── Economy rewards ──────────────────────────────────────────────────────────
export const STARTING_GOLD = 600;
export const PASSIVE_GOLD_PER_SEC = 2;
export const KILL_GOLD = 150;
export const KILL_XP = 120;
export const ASSIST_FRACTION = 0.55;
export const ASSIST_WINDOW = 6; // seconds a damager stays eligible for an assist
export const COIN_GOLD = 300; // Over Boss coin pickup
export const COIN_INTERVAL = 12; // boss throw cadence (s)
export const COIN_LIFETIME = 9; // how long a coin sits before despawning (s)
export const LEADER_BOUNTY = 650; // bonus for killing the current leader
export const DELIVERY_INTERVAL = 20; // catch-up drop cadence (s)
export const DELIVERY_LIFETIME = 30; // how long a delivery stays claimable (s)

// ── Levels ───────────────────────────────────────────────────────────────────
export const LEVEL_CAP = 12;
/** Cumulative XP needed to *reach* each level (index = level-1). Gentle curve so
 *  fed players are strong but not unkillable — catch-up systems assume this. */
export const XP_CURVE: number[] = buildXpCurve();
function buildXpCurve(): number[] {
  const curve = [0];
  let total = 0;
  for (let lvl = 1; lvl < LEVEL_CAP; lvl++) {
    total += 100 + 45 * lvl; // cost L→L+1
    curve.push(total);
  }
  return curve;
}

// ── Respawn ──────────────────────────────────────────────────────────────────
export const RESPAWN_BASE = 2.5;
export const RESPAWN_PER_LVL = 0.55;
export const RESPAWN_CAP = 9;

// ── Combat ───────────────────────────────────────────────────────────────────
export const HERO_MAGIC_RESIST = 0.3; // base magic mitigation
export const ATTACK_VARIANCE = 0.12; // ±12% basic-attack damage roll
export const FOUNTAIN_HEAL_PER_SEC = 0.18; // fraction of maxHp/s while on home fountain
export const FOUNTAIN_RADIUS = 5.5;
export const SHOP_RADIUS = 6.5; // how close to your base spawn the shop is usable
export const SPAWN_GUARD_RADIUS = 7; // enemies inside an enemy fountain get knocked + burned
export const SPAWN_GUARD_DPS = 120;

// ── Curves / helpers (pure) ──────────────────────────────────────────────────

/** Dota-style armor → physical damage multiplier. Negative armor amplifies. */
export function physicalMultiplier(armor: number): number {
  const k = 0.06 * armor;
  return 1 - k / (1 + Math.abs(k));
}

/** Magic mitigation multiplier (heroes only; bosses take full). */
export function magicMultiplier(isHero: boolean): number {
  return isHero ? 1 - HERO_MAGIC_RESIST : 1;
}

/** Basic-attack interval (ms) from attacks-per-second. */
export function attackIntervalMs(attackSpeed: number): number {
  return 1000 / Math.max(0.1, attackSpeed);
}

/** Highest level whose cumulative XP threshold is satisfied. */
export function levelForXp(xp: number): number {
  let lvl = 1;
  for (let i = 1; i < XP_CURVE.length; i++) {
    if (xp >= XP_CURVE[i]!) lvl = i + 1;
    else break;
  }
  return Math.min(lvl, LEVEL_CAP);
}

/** Respawn delay (s) scaling with level, capped. */
export function respawnTime(level: number): number {
  return Math.min(RESPAWN_CAP, RESPAWN_BASE + RESPAWN_PER_LVL * level);
}

// Jump timing (shared by sim/world tryJump + sim/abilities JUMP-attack gating,
// so it lives here to avoid a world↔abilities import cycle).
export const JUMP_MS = 880; // airborne window (drives the render hop arc + Jump clip); high floaty jump
export const JUMP_RECOVER = 460; // landing recovery before you can hop again
/** Peak lift of the hop arc (world units). The renderer lifts the model by this
 *  much, and an AERIAL ability's volley + FX fire from up here — so it's one
 *  constant, not a render number the sim guesses at. */
export const HOP_HEIGHT = 2.8;
