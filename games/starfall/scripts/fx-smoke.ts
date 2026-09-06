import assert from "node:assert/strict";

import {
  enemyChargeDuration,
  enemyChargeProgress,
  usesLockedAim,
} from "../src/render/charge-progress";
import { admitFx, type FxImportance } from "../src/render/fx-priority";
import {
  burstLifetime,
  burstStage,
  contactPoint,
  weaponLook,
  type WeaponLook,
} from "../src/render/combat-visuals";
import { spawnEnemyState, WEAPONS_SPECIAL, type EnemyKind } from "../src/shared/constants";

for (const capacity of [6, 8, 12, 20, 24, 36]) {
  const entries: { importance: FxImportance; id: number }[] = [];
  const major = { importance: "important", id: -1 } satisfies {
    importance: FxImportance;
    id: number;
  };
  entries.push(major);
  for (let id = 0; id < 100; id++) {
    if (admitFx(entries, capacity, "common")) entries.push({ importance: "common", id });
    assert(entries.includes(major), "common traffic must retain the major effect");
    assert(entries.length <= capacity - Math.ceil(capacity / 4), "common traffic leaves a reserve");
  }
  for (let id = 100; id < 200; id++) {
    if (admitFx(entries, capacity, "important")) entries.push({ importance: "important", id });
  }
  assert.equal(entries.length, capacity);
  assert(entries.includes(major), "later major traffic cannot destroy an earlier major beat");
  assert(entries.every((entry) => entry.importance === "important"));
  assert.equal(admitFx(entries, capacity, "common"), false);
  assert.equal(admitFx(entries, capacity, "important"), false);
}
console.log("PASS: ring, shatter and converge pressure retain major effects and hard bounds");

const durations: { kind: EnemyKind; ms: number }[] = [
  { kind: "drone", ms: 400 },
  { kind: "wasp", ms: 350 },
  { kind: "lancer", ms: 600 },
  { kind: "warden", ms: 700 },
  { kind: "sniper", ms: 900 },
  { kind: "spawner", ms: 650 },
];
for (const { kind, ms } of durations) {
  const enemy = spawnEnemyState(kind, 40, 80);
  enemy.angle = 1.2;
  enemy.lances = [{ x: 600, y: 700 }];
  enemy.telegraphUntil = 5000;
  const before = JSON.stringify(enemy);
  const duration = enemyChargeDuration(enemy);
  assert.equal(enemyChargeProgress(enemy.telegraphUntil, 5000 - ms, duration), 0);
  assert.equal(enemyChargeProgress(enemy.telegraphUntil, 5000 - ms / 2, duration), 0.5);
  assert.equal(enemyChargeProgress(enemy.telegraphUntil, 5000, duration), 1);
  assert.equal(enemyChargeProgress(enemy.telegraphUntil, 5001, duration), 1);
  assert.equal(enemyChargeProgress(enemy.telegraphUntil, 2000, duration), 0);
  assert.equal(JSON.stringify(enemy), before, "drawing must preserve aim, stats and deadline");
}
console.log("PASS: six enemy windups are monotonic, clamped and preserve host state");

const boss = spawnEnemyState("dreadnought", 0, 0);
boss.telegraphUntil = 5000;
boss.maxHp = 14000;
boss.hp = 14000;
assert.equal(enemyChargeProgress(boss.telegraphUntil, 4700, enemyChargeDuration(boss)), 0.5);
boss.hp = 7000;
boss.lances = [{ x: 300, y: 400 }];
assert.equal(
  enemyChargeProgress(boss.telegraphUntil, 4450, enemyChargeDuration(boss)),
  0.5,
  "phase 2 uses its 1100ms locked-aim window",
);
const lockedDuration = enemyChargeDuration(boss);
assert.equal(usesLockedAim(boss), true);
boss.hp = 1000;
assert.equal(
  usesLockedAim(boss),
  false,
  "current phase changes the actual shot to a nova immediately",
);
assert.equal(
  enemyChargeProgress(boss.telegraphUntil, 4450, lockedDuration),
  0.5,
  "HP phase changes cannot rewind an existing warning",
);
// Phase 2 leaves its locked targets behind; the next nova is still 700ms.
assert.equal(boss.lances.length, 1);
assert.equal(
  enemyChargeProgress(boss.telegraphUntil, 4650, enemyChargeDuration(boss)),
  0.5,
  "phase 3 uses its 700ms window",
);
console.log("PASS: all three boss charge durations match their existing attack windows");

const tail = { x: 0, y: 0 },
  head = { x: 1000, y: 0 },
  target = { x: 200, y: 0 };
const geometry = JSON.stringify({ tail, head, target });
assert.deepEqual(
  contactPoint(tail, head, target, 20, false),
  { x: 180, y: 0 },
  "piercing impacts land at the victim, not the distant beam head",
);
assert.deepEqual(
  contactPoint(tail, tail, target, 20, true),
  { x: 180, y: 0 },
  "AoE contacts belong to each victim's near surface",
);
assert.deepEqual(
  contactPoint(tail, { x: 1000, y: 21 }, target, 0, false),
  { x: 199.91183887905433, y: 4.198148616460141 },
  "width-only graze projects onto the real segment",
);
assert.deepEqual(
  contactPoint(tail, tail, target, 20, false),
  tail,
  "zero-length segment stays finite",
);
assert.equal(
  JSON.stringify({ tail, head, target }),
  geometry,
  "render contacts cannot mutate collision geometry",
);
console.log(
  "PASS: piercing, radial, padded and zero-length visual contacts preserve collision geometry",
);

assert.equal(burstStage(139, 140, 1000), 0, "secondary detonation cannot start before its stage");
assert.equal(burstStage(140, 140, 1000), 1);
assert.equal(burstStage(640, 140, 1000), 0.5);
assert.equal(burstStage(1140, 140, 1000), 0);
for (const delay of [0, 140, 280])
  assert.equal(
    burstStage(burstLifetime("boss"), delay, 1000),
    0,
    "every boss substage ends inside the owner's bounded life",
  );
const families = new Set(WEAPONS_SPECIAL.map(weaponLook));
const expectedFamilies: WeaponLook[] = [
  "rapid",
  "heavy",
  "laser",
  "rail",
  "scatter",
  "missile",
  "plasma",
  "drill",
  "glaive",
  "arc",
  "orb",
  "nova",
  "mine",
  "bolt",
];
for (const look of expectedFamilies)
  assert(families.has(look), `weapon family ${look} remains represented`);
console.log(
  "PASS: staged blasts have finite boundaries and all special weapon families map to a presentation",
);
