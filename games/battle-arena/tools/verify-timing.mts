// Headless sim harness: verifies damage lands at the animation contact moment.
import { createWorld, spawnHero, step } from "../src/sim/world.ts";
import { castAbility } from "../src/sim/abilities.ts";
import { strikeMs, castStrikeMs, swingClip } from "../src/data/clip-timing.ts";
import { attackIntervalMs } from "../src/data/config.ts";
import { CAMPS } from "../src/data/map.ts";
import type { FxEvent, World } from "../src/sim/types.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}${detail ? ` (${detail})` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
}

function setup(champA: string, champB: string, dist = 2) {
  const w = createWorld(42);
  // keep skeleton camps out of the duel (never spawn)
  for (const c of CAMPS) w.campRespawnAt[c.id] = 9e8;
  const a = spawnHero(w, { id: "A", ownerId: "A", team: "A", champId: champA, name: "A", isBot: false, slot: 0 });
  const b = spawnHero(w, { id: "B", ownerId: "B", team: "B", champId: champB, name: "B", isBot: false, slot: 1 });
  // face off at close range on open ground
  a.x = 0; a.y = 16; b.x = dist; b.y = 16;
  a.aimX = 1; a.aimY = 0; a.facing = 0;
  return { w, a, b };
}

/** Step until predicate or timeout; returns elapsed sim ms. Collects fx. */
function runUntil(w: World, fxLog: FxEvent[], pred: () => boolean, maxMs = 4000): number {
  const start = w.now;
  while (w.now - start < maxMs) {
    step(w);
    fxLog.push(...w.fx);
    w.fx.length = 0;
    if (pred()) return w.now - start;
  }
  return -1;
}

// ── 1. melee basic: damage at the chop's contact frame ──
{
  const { w, a, b } = setup("knight", "blackknight");
  const fx: FxEvent[] = [];
  a.attackHeld = true;
  const hp0 = b.hp;
  const t = runUntil(w, fx, () => b.hp < hp0);
  const interval = attackIntervalMs(a.attackSpeed);
  const expect = strikeMs(swingClip("knight", 1), interval);
  // measure from the swing's START (the gate holds the first swing one interval)
  const sinceSwing = w.now - a.lastAttackAt;
  check("knight basic #1 lands at chop contact", t >= 0 && Math.abs(sinceSwing - expect) < 67, `sinceSwing=${sinceSwing.toFixed(0)}ms expect≈${expect.toFixed(0)}ms`);
  const hitFx = fx.find((e) => e.t === "hit");
  check("hit event carries amount", hitFx !== undefined && hitFx.t === "hit" && hitFx.amount > 0);
}

// ── 2. Garran's 3rd swing (spin): damage mid-whirl + strike event ──
{
  const { w, a, b } = setup("knight", "blackknight", 3);
  const fx: FxEvent[] = [];
  a.attackHeld = true;
  // swing counter to 2 (two hits), then measure the spin
  let hp = b.hp;
  runUntil(w, fx, () => b.hp < hp);
  hp = b.hp;
  runUntil(w, fx, () => b.hp < hp);
  hp = b.hp;
  fx.length = 0;
  // third swing starts at lastAttackAt; damage should land strikeMs(spin) later
  const swingStartBefore = a.lastAttackAt;
  const t3 = runUntil(w, fx, () => b.hp < hp);
  check("spin swing dealt damage", t3 >= 0);
  const interval = attackIntervalMs(a.attackSpeed) * 1.92;
  const expect = strikeMs("Melee_2H_Attack_Spin", interval);
  const sinceSwing = w.now - a.lastAttackAt;
  check("spin damage lands mid-whirl", Math.abs(sinceSwing - expect) < 67, `sinceSwing=${sinceSwing.toFixed(0)}ms expect≈${expect.toFixed(0)}ms`);
  check("spin emits strike fx", fx.some((e) => e.t === "strike" && e.tag === "spin"));
  check("swingCount is 3", a.swingCount === 3);
}

// ── 3. knight:Q — damage waits for the cast clip's contact frame ──
{
  const { w, a, b } = setup("knight", "blackknight", 2.5);
  const fx: FxEvent[] = [];
  const hp0 = b.hp;
  check("knight:Q cast ok", castAbility(w, a, "Q", { dir: { x: 1, y: 0 } }));
  check("no instant damage on cast tick", b.hp === hp0);
  const t = runUntil(w, fx, () => b.hp < hp0);
  const expect = castStrikeMs("knight", "Q");
  check("knight:Q lands at contact", t >= 0 && Math.abs(t - expect) < 67, `t=${t?.toFixed(0)}ms expect≈${expect.toFixed(0)}ms`);
  check("victim stunned on strike (not before)", b.statuses.some((s) => s.kind === "stun"));
  check("strike fx emitted", fx.some((e) => e.t === "strike" && e.tag === "knight:Q"));
}

// ── 4. dodgeable: walk out of knight:Q before the blade lands ──
{
  const { w, a, b } = setup("knight", "ranger", 3);
  const hp0 = b.hp;
  castAbility(w, a, "Q", { dir: { x: 1, y: 0 } });
  b.moveX = 1; b.moveY = 0; // sprint away
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => w.now > 900, 1000);
  check("knight:Q dodged by moving out", b.hp === hp0, `hp ${hp0.toFixed(0)}→${b.hp.toFixed(0)}`);
}

// ── 5. JUMP attack: slam damage on touchdown, not at cast ──
{
  const { w, a, b } = setup("knight", "blackknight", 4);
  const fx: FxEvent[] = [];
  const hp0 = b.hp;
  check("knight JUMP cast ok", castAbility(w, a, "JUMP", { dir: { x: 1, y: 0 } }));
  check("JUMP: no damage at cast", b.hp === hp0);
  const t = runUntil(w, fx, () => b.hp < hp0);
  const expectLeap = (5 / 20) * 1000; // castRange / JUMP_LEAP_SPEED
  check("JUMP slam lands at touchdown", t >= 0 && Math.abs(t - expectLeap) < 67, `t=${t.toFixed(0)}ms expect≈${expectLeap.toFixed(0)}ms`);
  check("JUMP strike fx at landing point", fx.some((e) => e.t === "strike" && e.tag === "knight:JUMP" && Math.abs(e.x - 5) < 0.01));
}

// ── 6. stun cancels a scheduled strike ──
{
  const { w, a, b } = setup("knight", "blackknight", 2.5);
  const hp0 = b.hp;
  castAbility(w, a, "Q", { dir: { x: 1, y: 0 } });
  a.statuses.push({ kind: "stun", until: w.now + 2000, id: "test" });
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => w.now > 900, 1000);
  check("stunned mid-windup → strike cancelled", b.hp === hp0);
}

// ── 7. blackknight:W (smite): telegraph zone, detonates with stun ──
{
  const { w, a, b } = setup("blackknight", "knight", 5);
  const fx: FxEvent[] = [];
  const hp0 = b.hp;
  castAbility(w, a, "W", { point: { x: b.x, y: b.y } });
  check("smite arms a telegraph zone", w.grounds.some((g) => g.effect === "smite" && g.telegraph === true));
  check("smite: no damage at cast", b.hp === hp0);
  const t = runUntil(w, fx, () => b.hp < hp0);
  check("smite detonates ≈450ms", t >= 0 && Math.abs(t - 450) < 67, `t=${t.toFixed(0)}ms`);
  check("smite stuns on detonate", b.statuses.some((s) => s.kind === "stun"));
  check("smite explosion fx", fx.some((e) => e.t === "explosion" && e.kind === "smite"));
}

// ── 8. witch:R (grand hex): ring seals, victims mushroom ──
{
  const { w, a, b } = setup("witch", "knight", 5);
  const fx: FxEvent[] = [];
  a.abilities.R.rank = 1;
  castAbility(w, a, "R", { point: { x: b.x, y: b.y } });
  check("hexring zone armed", w.grounds.some((g) => g.effect === "hexring"));
  const t = runUntil(w, fx, () => b.statuses.some((s) => s.kind === "hex"));
  check("hex applies on seal ≈500ms", t >= 0 && Math.abs(t - 500) < 67, `t=${t.toFixed(0)}ms`);
}

// ── 9. ranged basic: fatter hitbox + release-frame timing ──
{
  const { w, a, b } = setup("ranger", "knight", 8);
  const fx: FxEvent[] = [];
  a.attackHeld = true;
  // perpendicular offset 1.35u: new reach 0.95+0.62=1.57 connects; the old
  // 0.55 hitRadius (reach 1.17) would sail past
  b.y = 16 + 1.35;
  const hp0 = b.hp;
  const t = runUntil(w, fx, () => b.hp < hp0, 3000);
  check("ranged basic connects with grazing offset", t >= 0, `t=${t.toFixed(0)}ms`);
  const swingAt = fx.findIndex((e) => e.t === "swing");
  check("muzzle flash fires at release", swingAt >= 0);
}

// ── 10. rogue:R execute strikes on arrival ──
{
  const { w, a, b } = setup("rogue", "knight", 5);
  const fx: FxEvent[] = [];
  a.abilities.R.rank = 1;
  b.hp = b.maxHp * 0.3; // wounded — execute bonus
  const hp0 = b.hp;
  check("rogue:R cast ok", castAbility(w, a, "R", { dir: { x: 1, y: 0 } }));
  check("rogue:R no damage at cast", b.hp === hp0);
  const t = runUntil(w, fx, () => b.hp < hp0);
  check("rogue:R lands on arrival", t >= 0 && t < 400, `t=${t.toFixed(0)}ms`);
}

// ── 11. destructible props: break, debris event, keg chain-blast, respawn ──
{
  const { w, a } = setup("knight", "ranger", 30);
  const props = [...w.units.values()].filter((u) => u.kind === "prop");
  check("props spawned", props.length >= 10, `${props.length} props`);
  const kegs = props.filter((p) => p.champId.includes("keg"));
  check("kegs exist", kegs.length >= 2);

  // park Garran next to a keg and swing
  const keg = kegs[0]!;
  a.x = keg.x - 1.6;
  a.y = keg.y;
  a.aimX = 1;
  a.aimY = 0;
  a.attackHeld = true;
  const fx: FxEvent[] = [];
  const t = runUntil(w, fx, () => !keg.alive, 6000);
  check("keg breaks under basics", t >= 0);
  check("propBreak fx emitted", fx.some((e) => e.t === "propBreak" && e.model.includes("keg")));
  check("keg blast explosion fx", fx.some((e) => e.t === "explosion" && e.kind === "keg"));
  check("keg respawn scheduled", keg.respawnAt > w.now);
  // the second keg sits within blast range in the cellar cluster — chain-pop
  const other = kegs[1]!;
  const chained = Math.hypot(other.x - keg.x, other.y - keg.y) < 3.5 ? !other.alive : true;
  check("neighbor keg chain-detonates", chained);
}

// ── 12. props block movement ──
{
  const { w, a } = setup("knight", "ranger", 30);
  const crate = [...w.units.values()].find((u) => u.kind === "prop" && u.champId === "crate_large")!;
  a.x = crate.x - 3;
  a.y = crate.y;
  a.aimX = 1;
  a.aimY = 0;
  a.moveX = 1;
  a.moveY = 0;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => w.now > 1400, 1500);
  const gap = Math.hypot(a.x - crate.x, a.y - crate.y);
  check("crate blocks the walk", gap >= (a.radius + crate.radius) * 0.9, `gap=${gap.toFixed(2)}`);
}

// ── 13. ranger basics pierce the line ──
{
  const { w, a, b } = setup("ranger", "knight", 5);
  const c2 = spawnHero(w, { id: "C", ownerId: "C", team: "C", champId: "blackknight", name: "C", isBot: false, slot: 2 });
  c2.x = 7.5;
  c2.y = 16; // directly behind b on the same line
  a.attackHeld = true;
  const hpB = b.hp;
  const hpC = c2.hp;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => b.hp < hpB && c2.hp < hpC, 4000);
  check("ranger arrow pierces both targets", b.hp < hpB && c2.hp < hpC, `b ${hpB.toFixed(0)}→${b.hp.toFixed(0)} c ${hpC.toFixed(0)}→${c2.hp.toFixed(0)}`);
}

// ── 14. mage basics splash ──
{
  const { w, a, b } = setup("mage", "knight", 7);
  const c2 = spawnHero(w, { id: "C", ownerId: "C", team: "C", champId: "blackknight", name: "C", isBot: false, slot: 2 });
  c2.x = 7;
  c2.y = 17.2; // adjacent to b, inside the 1.6 splash
  a.attackHeld = true;
  const hpB = b.hp;
  const hpC = c2.hp;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => b.hp < hpB, 4000);
  check("mage bolt splashes the neighbor", c2.hp < hpC, `c ${hpC.toFixed(0)}→${c2.hp.toFixed(0)}`);
  check("bolt splash explosion fx", fx.some((e) => e.t === "explosion" && e.kind === "bolt"));
}

// ── 15. fireball detonates at the aim point (not max range) ──
{
  const { w, a } = setup("mage", "knight", 25); // enemy far away — nothing to hit
  const fx: FxEvent[] = [];
  check("fireball cast ok", castAbility(w, a, "Q", { point: { x: 6, y: 16 }, dir: { x: 1, y: 0 } }));
  runUntil(w, fx, () => fx.some((e) => e.t === "explosion" && e.kind === "fireball"), 2500);
  const boom = fx.find((e) => e.t === "explosion" && e.kind === "fireball");
  check("fireball airbursts AT the aim point", boom !== undefined && boom.t === "explosion" && Math.abs(boom.x - 6) < 1.2 && Math.abs(boom.y - 16) < 0.5, boom && boom.t === "explosion" ? `at (${boom.x.toFixed(1)},${boom.y.toFixed(1)})` : "no burst");
}

// ── 16. spent projectiles fizzle visibly ──
{
  const { w, a } = setup("ranger", "knight", 40); // nothing in arrow range
  a.attackHeld = true;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => fx.some((e) => e.t === "fizzle" && e.kind === "arrow"), 4000);
  check("arrow fizzles at max range", fx.some((e) => e.t === "fizzle" && e.kind === "arrow"));
}

// ── 17. ambush: the strike out of stealth crits for double ──
{
  const { w, a, b } = setup("rogue", "blackknight", 1.8);
  castAbility(w, a, "E", {}); // Smoke — stealth up
  a.attackHeld = true;
  const hp0 = b.hp;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => b.hp < hp0);
  const hit = fx.find((e) => e.t === "hit" && e.by === "A");
  // base 44 ±12% → ambush 2× ≈ 77-99 after armor; non-ambush would be ~35-45
  const dealt = hp0 - b.hp;
  check("ambush strike doubles damage", dealt > 55, `dealt=${dealt.toFixed(0)}`);
  check("ambush strike reads as a CRIT", hit !== undefined && hit.t === "hit" && hit.crit === true);
  // second swing back to normal
  const hp1 = b.hp;
  const fx2: FxEvent[] = [];
  runUntil(w, fx2, () => b.hp < hp1);
  check("second swing is normal damage", hp1 - b.hp < 55, `dealt=${(hp1 - b.hp).toFixed(0)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
