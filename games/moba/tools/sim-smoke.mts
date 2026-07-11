// Headless smoke test for the moba simulation. The sim (`src/sim/*`) is pure data
// with no Phaser/DOM deps, so a full match can be driven from Node via tsx. Run
// with `pnpm test`. Covers: a long match runs without crashing, plus the specific
// correctness fixes (Hunter's Mark scoping, channel-breaks-on-death, self-aura
// dedup, bot shopping through buyItem).

import { SIM_DT } from "../src/data/config.ts";
import { castAbility } from "../src/sim/abilities.ts";
import { dealDamage } from "../src/sim/combat.ts";
import { effectiveAttackSpeed } from "../src/sim/stats.ts";
import type { Unit } from "../src/sim/types.ts";
import { createWorld, spawnHero, step } from "../src/sim/world.ts";

// Hunter's Mark bonus for `u` vs `target` — mirrors combat.attackSpeedVsTarget's
// exact, target-scoped id match.
function markBonus(u: Unit, target: Unit): number {
  let b = 0;
  for (const st of u.statuses)
    if (st.kind === "attackSpeed" && st.id === "markAS:" + target.id) b += st.amount;
  return b;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

// ---- 1. a full match runs without crashing --------------------------------
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
    for (; steps < 240 * 30; steps++) step(w, SIM_DT); // ~240s of game time at 30Hz
  } catch (e) {
    crashed = String(e);
  }
  check("240s match steps without throwing", crashed === "", crashed);
  check("world advanced gameTime", w.gameTime > 100, `gameTime=${w.gameTime.toFixed(1)}`);
  check("units still present", w.units.size > 0, `units=${w.units.size}`);
  check("no NaN in player position", Number.isFinite(me.x) && Number.isFinite(me.y));
  console.log(`  (ran ${steps} steps, ${w.units.size} units, phase=${w.phase})`);
}

// ---- 2. Hunter's Mark: bonus attack speed applies ONLY vs the marked hero --
{
  const w = createWorld(1);
  const storm = spawnHero(w, "stormcaller", "radiant", "s", false, 0);
  const marked = spawnHero(w, "ironvow", "dire", "m", false, 0);
  const other = spawnHero(w, "duskblade", "dire", "o", false, 1);
  // put both targets next to the caster so the unit-targeted cast is in range
  marked.x = storm.x + 40;
  marked.y = storm.y;
  other.x = storm.x - 40;
  other.y = storm.y;
  const stormHero = storm.hero;
  if (!stormHero) throw new Error("stormcaller has no hero state");
  stormHero.abilities.W.rank = 1; // W = Hunter's Mark
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
}

// ---- 3. a channel breaks (zone removed) when the caster dies ---------------
{
  const w = createWorld(2);
  const brew = spawnHero(w, "brewkeeper", "radiant", "b", false, 0);
  const brewHero = brew.hero;
  if (!brewHero) throw new Error("brewkeeper has no hero state");
  brewHero.abilities.R.rank = 1; // Last Call = channel + heal zone
  brew.mp = brew.maxMp;
  const cast = castAbility(w, brew, { key: "R", point: { x: brew.x, y: brew.y } });
  check("Last Call channel cast", cast, `channel=${!!brewHero.channel}`);
  const groundsBefore = w.groundEffects.filter((g) => g.channel && g.ownerId === brew.id).length;
  check("channel spawned a ground zone", groundsBefore >= 1);
  dealDamage(w, null, brew, 1e9, "pure", {}); // kill the channeler outright
  check("caster is dead", !brew.alive);
  check("channel cleared on death", brewHero.channel === null);
  const groundsAfter = w.groundEffects.filter((g) => g.channel && g.ownerId === brew.id).length;
  check(
    "channel ground zone removed on death (no ticking from corpse)",
    groundsAfter === 0,
    `after=${groundsAfter}`,
  );
}

// ---- 4. a self-following aura does not stack on recast ---------------------
{
  const w = createWorld(3);
  const ember = spawnHero(w, "emberhex", "radiant", "e", false, 0);
  const emberHero = ember.hero;
  if (!emberHero) throw new Error("emberhex has no hero state");
  emberHero.abilities.E.rank = 1; // Flashfire = followOwner burn aura
  ember.mp = ember.maxMp;
  castAbility(w, ember, { key: "E", point: { x: ember.x, y: ember.y } });
  const after1 = w.groundEffects.filter((g) => g.ownerId === ember.id && g.followOwner).length;
  ember.mp = ember.maxMp;
  emberHero.abilities.E.readyAt = 0; // force off cooldown
  castAbility(w, ember, { key: "E", point: { x: ember.x, y: ember.y } });
  const after2 = w.groundEffects.filter((g) => g.ownerId === ember.id && g.followOwner).length;
  check("Flashfire aura present after first cast", after1 === 1, `after1=${after1}`);
  check("recast replaces rather than stacking the aura", after2 === 1, `after2=${after2}`);
}

// ---- 5. bots buy items over a match (tryShop -> buyItem path) --------------
{
  const w = createWorld(7);
  const bots = [
    spawnHero(w, "ironvow", "radiant", "botR0", true, 0),
    spawnHero(w, "stormcaller", "dire", "botD0", true, 0),
  ];
  for (let i = 0; i < 300 * 30; i++) step(w, SIM_DT);
  const totalItems = bots.reduce((n, b) => n + (w.units.get(b.id)?.hero?.items.length ?? 0), 0);
  check("bots purchased items via buyItem", totalItems > 0, `total=${totalItems}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
