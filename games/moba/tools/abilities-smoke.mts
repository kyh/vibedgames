// Every hero kit casts end to end from the pure sim. Each non-passive ability at
// rank 1 goes through castAbility against a live enemy (or a wounded ally for the
// heal), must spend mana, start its cooldown, emit its cast cue, and — after the
// world runs on for a moment — leave a footprint: damage, a status, a projectile,
// a ground zone, a mine, or a blink. Run with `pnpm test`.

import { SIM_DT } from "../src/data/config.ts";
import { HEROES } from "../src/data/heroes.ts";
import type { AbilityKey } from "../src/data/heroes.ts";
import { castAbility } from "../src/sim/abilities.ts";
import type { Unit, World } from "../src/sim/types.ts";
import { createWorld, spawnHero, step } from "../src/sim/world.ts";

const KEYS: AbilityKey[] = ["Q", "W", "E", "R"];
const SETTLE_S = 2.5;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

interface Footprint {
  enemyHp: number;
  allyHp: number;
  enemyStatuses: number;
  allyStatuses: number;
  casterStatuses: number;
  projectiles: number;
  grounds: number;
  mines: number;
  casterX: number;
  casterY: number;
}

const footprint = (w: World, caster: Unit, enemy: Unit, ally: Unit): Footprint => ({
  allyHp: ally.hp,
  allyStatuses: ally.statuses.length,
  casterStatuses: caster.statuses.length,
  casterX: caster.x,
  casterY: caster.y,
  enemyHp: enemy.hp,
  enemyStatuses: enemy.statuses.length,
  grounds: w.groundEffects.length,
  mines: w.mines.size,
  projectiles: w.projectiles.size,
});

const changed = (before: Footprint, after: Footprint): string[] => {
  const out: string[] = [];
  if (after.enemyHp < before.enemyHp) {
    out.push("enemy damaged");
  }
  if (after.allyHp > before.allyHp) {
    out.push("ally healed");
  }
  if (after.enemyStatuses > before.enemyStatuses) {
    out.push("enemy status");
  }
  if (after.allyStatuses > before.allyStatuses) {
    out.push("ally status");
  }
  if (after.casterStatuses > before.casterStatuses) {
    out.push("self status");
  }
  if (after.projectiles > before.projectiles) {
    out.push("projectile");
  }
  if (after.grounds > before.grounds) {
    out.push("ground zone");
  }
  if (after.mines > before.mines) {
    out.push("mine");
  }
  if (Math.hypot(after.casterX - before.casterX, after.casterY - before.casterY) > 20) {
    out.push("blink");
  }
  return out;
};

const runFor = (w: World, seconds: number): void => {
  for (let t = 0; t < seconds; t += SIM_DT) {
    step(w, SIM_DT);
  }
};

for (const def of HEROES) {
  console.log(def.name);
  for (const key of KEYS) {
    const ability = def.abilities[key];
    if (ability.targeting === "passive") {
      continue;
    }
    const w = createWorld(41);
    const caster = spawnHero(w, def.id, "radiant", "c", false, 0);
    const enemy = spawnHero(w, "ironvow", "dire", "e", false, 0);
    const ally = spawnHero(w, "ironvow", "radiant", "a", false, 1);
    const { hero } = caster;
    if (!hero) {
      throw new Error(`${def.id} has no hero state`);
    }
    // A wide-open stage: nothing else in reach, the enemy inside every cast
    // range, the ally close and hurt enough for a heal to register.
    caster.x = 2600;
    caster.y = 1500;
    enemy.x = caster.x + 120;
    enemy.y = caster.y;
    ally.x = caster.x - 80;
    ally.y = caster.y;
    ally.hp = Math.floor(ally.maxHp * 0.5);
    // Only the cast may move the numbers: no natural regen, no auto-attacks.
    for (const u of [caster, enemy, ally]) {
      u.hpRegen = 0;
      u.attackRange = 0;
      u.baseDamage = 0;
    }
    hero.abilities[key].rank = 1;
    hero.abilities[key].readyAt = 0;
    caster.mp = caster.maxMp;
    w.fx.length = 0;

    const before = footprint(w, caster, enemy, ally);
    const mpBefore = caster.mp;
    let ok = false;
    if (ability.targeting === "unit") {
      const target = ability.effect === "brewkeeper:Q" ? ally : enemy;
      ok = castAbility(w, caster, { key, targetId: target.id });
    } else if (ability.targeting === "point") {
      ok = castAbility(w, caster, { key, point: { x: enemy.x, y: enemy.y } });
    } else {
      ok = castAbility(w, caster, { key });
    }
    const label = `${def.id}:${key} ${ability.name}`;
    check(`${label} casts`, ok);
    check(`${label} spends mana`, caster.mp < mpBefore, `mp ${mpBefore}→${caster.mp}`);
    check(`${label} starts cooldown`, hero.abilities[key].readyAt > w.now);
    check(
      `${label} cues the cast`,
      w.fx.some((fx) => fx.t === "cast" && fx.effect === ability.effect),
    );
    const immediate = changed(before, footprint(w, caster, enemy, ally));
    runFor(w, SETTLE_S);
    const settled = changed(before, footprint(w, caster, enemy, ally));
    const marks = [...new Set([...immediate, ...settled])];
    check(`${label} lands (${marks.join(", ")})`, marks.length > 0);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
