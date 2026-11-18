/** A "team" is a player id in FFA, or a fixed team id in team modes. "neutral"
 *  is enemy to everyone (the Over Boss). */
export type Team = string;

export const NEUTRAL_TEAM = "neutral";

export type DamageType = "physical" | "magic" | "pure";

export type Mode = "ffa" | "teams";

export const MODE: Mode = "ffa";
export const KILL_GOAL_FFA = 25;
export const MATCH_TIME = 480;
export const MAX_PLAYERS = 6;
export const MIN_PLAYERS_TO_START = 1;
export const ARENA_BOT_FILL = 4;

export const SIM_HZ = 30;
export const SIM_DT = 1 / SIM_HZ;
export const MAX_CATCH_UP_TICKS = 5;

export const FULL_SNAPSHOT_TICKS = 30;
export const INTERP_DELAY_MS = 100;
export const INPUT_KEEPALIVE_MS = 200;
export const INPUT_JITTER_TICKS = 2;
export const ONLINE_FALLBACK_MS = 8000;

export const THRONE_RADIUS = 11;
export const THRONE_GOLD_MULT = 0.3;
export const THRONE_XP_MULT = 0.3;

export const STARTING_GOLD = 600;
export const PASSIVE_GOLD_PER_SEC = 2;
export const KILL_GOLD = 150;
export const KILL_XP = 120;
export const ASSIST_FRACTION = 0.55;
export const ASSIST_WINDOW = 6;
export const COIN_GOLD = 300;
export const COIN_INTERVAL = 12;
export const COIN_LIFETIME = 9;
export const LEADER_BOUNTY = 650;
export const DELIVERY_INTERVAL = 20;
export const DELIVERY_LIFETIME = 30;

export const LEVEL_CAP = 12;

const buildXpCurve = () => {
  const curve = [0];
  let total = 0;

  for (let lvl = 1; lvl < LEVEL_CAP; lvl += 1) {
    total += 100 + 45 * lvl;
    curve.push(total);
  }

  return curve;
};

/** Cumulative XP needed to *reach* each level (index = level-1). Gentle curve so
 *  fed players are strong but not unkillable — catch-up systems assume this. */
export const XP_CURVE: number[] = buildXpCurve();

export const RESPAWN_BASE = 2.5;
export const RESPAWN_PER_LVL = 0.55;
export const RESPAWN_CAP = 9;

export const HERO_MAGIC_RESIST = 0.3;
export const ATTACK_VARIANCE = 0.12;
export const FOUNTAIN_HEAL_PER_SEC = 0.18;
export const FOUNTAIN_RADIUS = 5.5;
export const SHOP_RADIUS = 6.5;
export const SPAWN_GUARD_RADIUS = 7;
export const SPAWN_GUARD_DPS = 120;

/** Dota-style armor → physical damage multiplier. Negative armor amplifies. */
export const physicalMultiplier = (armor: number) => {
  const k = 0.06 * armor;

  return 1 - k / (1 + Math.abs(k));
};

/** Magic mitigation multiplier (heroes only; bosses take full). */
export const magicMultiplier = (isHero: boolean) => (isHero ? 1 - HERO_MAGIC_RESIST : 1);

/** Basic-attack interval (ms) from attacks-per-second. */
export const attackIntervalMs = (attackSpeed: number) => 1000 / Math.max(0.1, attackSpeed);

/** Highest level whose cumulative XP threshold is satisfied. */
export const levelForXp = (xp: number) => {
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
export const respawnTime = (level: number) =>
  Math.min(RESPAWN_CAP, RESPAWN_BASE + RESPAWN_PER_LVL * level);

export const JUMP_MS = 880;
export const JUMP_RECOVER = 460;

/** Peak lift of the hop arc (world units). The renderer lifts the model by this
 *  much, and an AERIAL ability's volley + FX fire from up here — so it's one
 *  constant, not a render number the sim guesses at. */
export const HOP_HEIGHT = 2.8;
