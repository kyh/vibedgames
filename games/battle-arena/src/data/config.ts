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
// first to this many kills wins
export const KILL_GOAL_FFA = 25;
// seconds; top score wins at timer, ties → sudden death
export const MATCH_TIME = 480;
// per room
export const MAX_PLAYERS = 6;
// bots fill the rest
export const MIN_PLAYERS_TO_START = 1;
// total combatants the host keeps populated (humans + bots)
export const ARENA_BOT_FILL = 4;

// ── Sim timing ───────────────────────────────────────────────────────────────
export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
export const SNAPSHOT_HZ = 15;

// ── Throne (the magnet at center) ────────────────────────────────────────────
// world units
export const THRONE_RADIUS = 11;
// +30% gold while inside
export const THRONE_GOLD_MULT = 0.3;
// +30% xp while inside
export const THRONE_XP_MULT = 0.3;

// ── Economy rewards ──────────────────────────────────────────────────────────
export const STARTING_GOLD = 600;
export const PASSIVE_GOLD_PER_SEC = 2;
export const KILL_GOLD = 150;
export const KILL_XP = 120;
export const ASSIST_FRACTION = 0.55;
// seconds a damager stays eligible for an assist
export const ASSIST_WINDOW = 6;
// Over Boss coin pickup
export const COIN_GOLD = 300;
// boss throw cadence (s)
export const COIN_INTERVAL = 12;
// how long a coin sits before despawning (s)
export const COIN_LIFETIME = 9;
// bonus for killing the current leader
export const LEADER_BOUNTY = 650;
// catch-up drop cadence (s)
export const DELIVERY_INTERVAL = 20;
// how long a delivery stays claimable (s)
export const DELIVERY_LIFETIME = 30;

// ── Levels ───────────────────────────────────────────────────────────────────
export const LEVEL_CAP = 12;
const buildXpCurve = (): number[] => {
  const curve = [0];
  let total = 0;
  for (let lvl = 1; lvl < LEVEL_CAP; lvl += 1) {
    // cost L→L+1
    total += 100 + 45 * lvl;
    curve.push(total);
  }
  return curve;
};
/** Cumulative XP needed to *reach* each level (index = level-1). Gentle curve so
 *  fed players are strong but not unkillable — catch-up systems assume this. */
export const XP_CURVE: number[] = buildXpCurve();

// ── Respawn ──────────────────────────────────────────────────────────────────
export const RESPAWN_BASE = 2.5;
export const RESPAWN_PER_LVL = 0.55;
export const RESPAWN_CAP = 9;

// ── Combat ───────────────────────────────────────────────────────────────────
// base magic mitigation
export const HERO_MAGIC_RESIST = 0.3;
// ±12% basic-attack damage roll
export const ATTACK_VARIANCE = 0.12;
// fraction of maxHp/s while on home fountain
export const FOUNTAIN_HEAL_PER_SEC = 0.18;
export const FOUNTAIN_RADIUS = 5.5;
// how close to your base spawn the shop is usable
export const SHOP_RADIUS = 6.5;
// enemies inside an enemy fountain get knocked + burned
export const SPAWN_GUARD_RADIUS = 7;
export const SPAWN_GUARD_DPS = 120;

// ── Curves / helpers (pure) ──────────────────────────────────────────────────

/** Dota-style armor → physical damage multiplier. Negative armor amplifies. */
export const physicalMultiplier = (armor: number): number => {
  const k = 0.06 * armor;
  return 1 - k / (1 + Math.abs(k));
};

/** Magic mitigation multiplier (heroes only; bosses take full). */
export const magicMultiplier = (isHero: boolean): number => (isHero ? 1 - HERO_MAGIC_RESIST : 1);

/** Basic-attack interval (ms) from attacks-per-second. */
export const attackIntervalMs = (attackSpeed: number): number => 1000 / Math.max(0.1, attackSpeed);

/** Highest level whose cumulative XP threshold is satisfied. */
export const levelForXp = (xp: number): number => {
  let lvl = 1;
  for (let i = 1; i < XP_CURVE.length; i += 1) {
    const threshold = XP_CURVE[i];
    if (threshold === undefined || xp < threshold) {
      break;
    }
    lvl = i + 1;
  }
  return Math.min(lvl, LEVEL_CAP);
};

/** Respawn delay (s) scaling with level, capped. */
export const respawnTime = (level: number): number =>
  Math.min(RESPAWN_CAP, RESPAWN_BASE + RESPAWN_PER_LVL * level);

// Jump timing (shared by sim/world tryJump + sim/abilities JUMP-attack gating,
// so it lives here to avoid a world↔abilities import cycle).
// airborne window (drives the render hop arc + Jump clip); high floaty jump
export const JUMP_MS = 880;
// landing recovery before you can hop again
export const JUMP_RECOVER = 460;
/** Peak lift of the hop arc (world units). The renderer lifts the model by this
 *  much, and an AERIAL ability's volley + FX fire from up here — so it's one
 *  constant, not a render number the sim guesses at. */
export const HOP_HEIGHT = 2.8;
