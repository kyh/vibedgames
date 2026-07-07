// Elite-room affixes. Every enemy in an elite room rolls one, recolouring it and
// bending its EnemyBody multipliers so the pack fights differently: a wall you
// grind down, a swarm you outrun, or hits you can't facetank. Applied host-side
// at spawn (see spawnEnemies); the tint reads the threat at a glance.
export type Affix = {
  id: string;
  name: string;
  tint: number; // enemy recolour
  hpMult: number;
  speedMult: number;
  dmgTakenMult: number; // <1 = tanky
  dmgOutMult: number; // >1 = hits harder
};

const ARMORED: Affix = {
  id: "armored",
  name: "Armored",
  tint: 0x9fb4d8,
  hpMult: 1.5,
  speedMult: 1,
  dmgTakenMult: 0.45,
  dmgOutMult: 1,
};

export const AFFIXES: readonly Affix[] = [
  ARMORED,
  { id: "swift", name: "Swift", tint: 0xffe14a, hpMult: 0.9, speedMult: 1.7, dmgTakenMult: 1, dmgOutMult: 1 },
  { id: "brutal", name: "Brutal", tint: 0xff5a5a, hpMult: 1.3, speedMult: 1.1, dmgTakenMult: 1, dmgOutMult: 1.5 },
];

export const rollAffix = (): Affix =>
  AFFIXES[Math.floor(Math.random() * AFFIXES.length)] ?? ARMORED;
