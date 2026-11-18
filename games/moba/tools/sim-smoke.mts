import { SIM_DT } from "../src/data/config.ts";
import { HEROES } from "../src/data/heroes.ts";
import { castAbility } from "../src/sim/abilities.ts";
import { dealDamage } from "../src/sim/combat.ts";
import { effectiveAttackSpeed } from "../src/sim/stats.ts";
import type { Unit } from "../src/sim/types.ts";
import { createWorld, spawnCreepAt, spawnHero, step } from "../src/sim/world.ts";

const markBonus = (u: Unit, target: Unit) => {
  let b = 0;

  for (const st of u.statuses) {
    if (st.kind === "attackSpeed" && st.id === `markAS:${target.id}`) {
      b += st.amount;
    }
  }

  return b;
};

let pass = 0;
let fail = 0;

const check = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

{
  const w = createWorld(11);
  const victim = spawnHero(w, "ironvow", "dire", "victim", false, 0);

  for (const def of HEROES) {
    const attacker = spawnHero(w, def.id, "radiant", def.id, false, 0);
    w.fx.length = 0;
    const { hp } = victim;
    dealDamage(w, attacker, victim, 10, "pure", {});
    const hit = w.fx.find((fx) => fx.t === "hit");
    check(
      `${def.id}: impact carries source identity and unchanged damage`,
      hit?.t === "hit" && hit.attackerHero === def.id && victim.hp === hp - 10 && hit.amount === 10,
    );
  }

  w.fx.length = 0;
  dealDamage(w, null, victim, 10, "pure", {});
  const hit = w.fx.find((fx) => fx.t === "hit");
  check(
    "environment impact has no invented hero identity",
    hit?.t === "hit" && hit.attackerHero === undefined,
  );
}

{
  const w = createWorld(1234);
  const me = spawnHero(w, "emberhex", "radiant", "you", false, 0);
  spawnHero(w, "ironvow", "radiant", "botR1", true, 1);
  spawnHero(w, "stormcaller", "radiant", "botR2", true, 2);
  spawnHero(w, "duskblade", "dire", "botD0", true, 0);
  spawnHero(w, "brewkeeper", "dire", "botD1", true, 1);
  spawnHero(w, "boomtinker", "dire", "botD2", true, 2);
  let steps = 0;
  let crashed = "";

  try {
    for (; steps < 240 * 30; steps += 1) {
      step(w, SIM_DT);
    }
  } catch (error) {
    crashed = String(error);
  }

  check("240s match steps without throwing", crashed === "", crashed);
  check("world advanced gameTime", w.gameTime > 100, `gameTime=${w.gameTime.toFixed(1)}`);
  check("units still present", w.units.size > 0, `units=${w.units.size}`);
  check("no NaN in player position", Number.isFinite(me.x) && Number.isFinite(me.y));
  console.log(`  (ran ${steps} steps, ${w.units.size} units, phase=${w.phase})`);
}

{
  const w = createWorld(1);
  const storm = spawnHero(w, "stormcaller", "radiant", "s", false, 0);
  const marked = spawnHero(w, "ironvow", "dire", "m", false, 0);
  const other = spawnHero(w, "duskblade", "dire", "o", false, 1);
  marked.x = storm.x + 40;
  marked.y = storm.y;
  other.x = storm.x - 40;
  other.y = storm.y;
  const stormHero = storm.hero;

  if (!stormHero) {
    throw new Error("stormcaller has no hero state");
  }

  stormHero.abilities.W.rank = 1;
  storm.mp = storm.maxMp;
  const baseAS = effectiveAttackSpeed(storm);
  const casted = castAbility(w, storm, { key: "W", targetId: marked.id });
  check("Hunter's Mark cast succeeds", casted);
  const asGlobal = effectiveAttackSpeed(storm);
  const asVsMarked = effectiveAttackSpeed(storm, markBonus(storm, marked));
  const asVsOther = effectiveAttackSpeed(storm, markBonus(storm, other));
  check(
    "mark does NOT boost global attack speed",
    Math.abs(asGlobal - baseAS) < 1e-6,
    `base=${baseAS} global=${asGlobal}`,
  );
  check(
    "mark boosts attack speed vs the marked hero",
    asVsMarked > asGlobal + 1e-6,
    `marked=${asVsMarked} global=${asGlobal}`,
  );
  check(
    "mark does NOT boost attack speed vs a different hero",
    Math.abs(asVsOther - asGlobal) < 1e-6,
    `other=${asVsOther}`,
  );
  const expected = Math.min(5, storm.attackSpeedBase * (1 + markBonus(storm, marked) / 100));
  check(
    "mark bonus applied exactly once (no double-count)",
    Math.abs(asVsMarked - expected) < 1e-6,
    `got=${asVsMarked} expected=${expected}`,
  );
  const creep = spawnCreepAt(w, "dire", "top", "melee", storm.x + 60, storm.y);
  stormHero.abilities.W.readyAt = 0;
  storm.mp = storm.maxMp;
  check(
    "Hunter's Mark refuses a creep target",
    !castAbility(w, storm, { key: "W", targetId: creep.id }),
  );
}

{
  const w = createWorld(2);
  const brew = spawnHero(w, "brewkeeper", "radiant", "b", false, 0);
  const brewHero = brew.hero;

  if (!brewHero) {
    throw new Error("brewkeeper has no hero state");
  }

  brewHero.abilities.R.rank = 1;
  brew.mp = brew.maxMp;
  const cast = castAbility(w, brew, { key: "R", point: { x: brew.x, y: brew.y } });
  check("Last Call channel cast", cast, `channel=${!!brewHero.channel}`);
  const groundsBefore = w.groundEffects.filter((g) => g.channel && g.ownerId === brew.id).length;
  check("channel spawned a ground zone", groundsBefore >= 1);
  dealDamage(w, null, brew, 1e9, "pure", {});
  check("caster is dead", !brew.alive);
  check("channel cleared on death", brewHero.channel === null);
  const groundsAfter = w.groundEffects.filter((g) => g.channel && g.ownerId === brew.id).length;
  check(
    "channel ground zone removed on death (no ticking from corpse)",
    groundsAfter === 0,
    `after=${groundsAfter}`,
  );
}

{
  const w = createWorld(3);
  const ember = spawnHero(w, "emberhex", "radiant", "e", false, 0);
  const emberHero = ember.hero;

  if (!emberHero) {
    throw new Error("emberhex has no hero state");
  }

  emberHero.abilities.E.rank = 1;
  ember.mp = ember.maxMp;
  castAbility(w, ember, { key: "E", point: { x: ember.x, y: ember.y } });
  const after1 = w.groundEffects.filter((g) => g.ownerId === ember.id && g.followOwner).length;
  ember.mp = ember.maxMp;
  emberHero.abilities.E.readyAt = 0;
  castAbility(w, ember, { key: "E", point: { x: ember.x, y: ember.y } });
  const after2 = w.groundEffects.filter((g) => g.ownerId === ember.id && g.followOwner).length;
  check("Flashfire aura present after first cast", after1 === 1, `after1=${after1}`);
  check("recast replaces rather than stacking the aura", after2 === 1, `after2=${after2}`);
}

{
  const w = createWorld(7);

  const bots = [
    spawnHero(w, "ironvow", "radiant", "botR0", true, 0),
    spawnHero(w, "stormcaller", "dire", "botD0", true, 0),
  ];

  for (let i = 0; i < 300 * 30; i += 1) {
    step(w, SIM_DT);
  }

  const totalItems = bots.reduce((n, b) => n + (w.units.get(b.id)?.hero?.items.length ?? 0), 0);
  check("bots purchased items via buyItem", totalItems > 0, `total=${totalItems}`);
}

console.log(`\n${pass} passed, ${fail} failed`);

process.exit(fail === 0 ? 0 : 1);
