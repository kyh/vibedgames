// Neutral creep stat table + the reward a kill pays. Its own module so the
// economy can price a creep kill without importing the tick loop back.

export interface CreepStat {
  model: string;
  attackType: "melee" | "ranged";
  attackDamageType: "physical" | "magic";
  attackKind: string;
  hp: number;
  damage: number;
  armor: number;
  attackRange: number;
  attackSpeed: number;
  moveSpeed: number;
  projectileSpeed: number;
  radius: number;
  bounty: number;
  xp: number;
  // display name (default "Skeleton")
  name?: string;
  // hp/s (default 6; the golem regens hard between fights)
  hpRegen?: number;
}

const CREEP_STATS = new Map<string, CreepStat>(
  Object.entries({
    frostgolem: {
      armor: 8,
      attackDamageType: "physical",
      attackKind: "melee",
      attackRange: 3.2,
      attackSpeed: 0.6,
      attackType: "melee",
      bounty: 500,
      damage: 95,
      hp: 2400,
      hpRegen: 20,
      model: "FrostGolem",
      moveSpeed: 4.4,
      name: "Frost Golem",
      projectileSpeed: 0,
      radius: 1.25,
      xp: 350,
    },
    skmage: {
      armor: 1,
      attackDamageType: "magic",
      attackKind: "bolt",
      attackRange: 8,
      attackSpeed: 0.7,
      attackType: "ranged",
      bounty: 70,
      damage: 30,
      hp: 230,
      model: "Skeleton_Mage",
      moveSpeed: 4.6,
      projectileSpeed: 16,
      radius: 0.55,
      xp: 60,
    },
    skminion: {
      armor: 1,
      attackDamageType: "physical",
      attackKind: "melee",
      attackRange: 2,
      attackSpeed: 0.95,
      attackType: "melee",
      bounty: 35,
      damage: 24,
      hp: 200,
      model: "Skeleton_Minion",
      moveSpeed: 5.4,
      projectileSpeed: 0,
      radius: 0.52,
      xp: 32,
    },
    skwarrior: {
      armor: 3,
      attackDamageType: "physical",
      attackKind: "melee",
      attackRange: 2.2,
      attackSpeed: 0.8,
      attackType: "melee",
      bounty: 55,
      damage: 34,
      hp: 340,
      model: "Skeleton_Warrior",
      moveSpeed: 5,
      projectileSpeed: 0,
      radius: 0.6,
      xp: 50,
    },
  } satisfies Record<string, CreepStat>),
);

const mustGetCreep = (id: string): CreepStat => {
  const stat = CREEP_STATS.get(id);
  if (!stat) {
    throw new Error(`unknown creep: ${id}`);
  }
  return stat;
};

// Fallback for unknown creep types.
const DEFAULT_CREEP = mustGetCreep("skwarrior");

/** Stats for a creep type; unknown types fall back to the warrior. */
export const creepStat = (type: string): CreepStat => CREEP_STATS.get(type) ?? DEFAULT_CREEP;

/** Look up a creep's bounty/xp for the economy on kill. */
export const creepReward = (type: string) => {
  const s = creepStat(type);
  return { bounty: s.bounty, xp: s.xp };
};
