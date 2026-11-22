import { createWorld, spawnHero, step } from "../src/sim/world.ts";
import { castAbility } from "../src/sim/abilities.ts";
import { strikeMs, castStrikeMs, swingClip } from "../src/data/clip-timing.ts";
import { attackIntervalMs } from "../src/data/config.ts";
import { CAMPS } from "../src/data/map.ts";
import { PLATEAU_H, PLATEAU_R, STAIR_RUN, groundHeight, onPlateau } from "../src/sim/elevation.ts";
import type { FxEvent, Unit, World } from "../src/sim/types.ts";

let pass = 0;
let fail = 0;

const check = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
};

const setup = (champA: string, champB: string, dist = 2) => {
  const w = createWorld(42);

  for (const c of CAMPS) {
    w.campRespawnAt[c.id] = 9e8;
  }

  const a = spawnHero(w, {
    champId: champA,
    id: "A",
    isBot: false,
    name: "A",
    ownerId: "A",
    slot: 0,
    team: "A",
  });

  const b = spawnHero(w, {
    champId: champB,
    id: "B",
    isBot: false,
    name: "B",
    ownerId: "B",
    slot: 1,
    team: "B",
  });

  a.x = 0;
  a.y = 16;
  b.x = dist;
  b.y = 16;
  a.aimX = 1;
  a.aimY = 0;
  a.facing = 0;

  return { a, b, w };
};

const runUntil = (w: World, fxLog: FxEvent[], pred: () => boolean, maxMs = 4000) => {
  const start = w.now;

  while (w.now - start < maxMs) {
    step(w);
    fxLog.push(...w.fx);
    w.fx.length = 0;

    if (pred()) {
      return w.now - start;
    }
  }

  return -1;
};

{
  const { w, a, b } = setup("knight", "blackknight");
  const fx: FxEvent[] = [];
  a.attackHeld = true;
  const hp0 = b.hp;
  const t = runUntil(w, fx, () => b.hp < hp0);
  const interval = attackIntervalMs(a.attackSpeed);
  const expect = strikeMs(swingClip("knight", 1), interval);
  const sinceSwing = w.now - a.lastAttackAt;
  check(
    "knight basic #1 lands at chop contact",
    t >= 0 && Math.abs(sinceSwing - expect) < 67,
    `sinceSwing=${sinceSwing.toFixed(0)}ms expect≈${expect.toFixed(0)}ms`,
  );
  const hitFx = fx.find((e) => e.t === "hit");
  check("hit event carries amount", hitFx !== undefined && hitFx.t === "hit" && hitFx.amount > 0);
}

{
  const { w, a, b } = setup("knight", "blackknight", 3);
  const fx: FxEvent[] = [];
  a.attackHeld = true;
  let { hp } = b;
  runUntil(w, fx, () => b.hp < hp);
  ({ hp } = b);
  runUntil(w, fx, () => b.hp < hp);
  ({ hp } = b);
  fx.length = 0;
  const t3 = runUntil(w, fx, () => b.hp < hp);
  check("spin swing dealt damage", t3 >= 0);
  const interval = attackIntervalMs(a.attackSpeed) * 1.92;
  const expect = strikeMs("Melee_2H_Attack_Spin", interval);
  const sinceSwing = w.now - a.lastAttackAt;
  check(
    "spin damage lands mid-whirl",
    Math.abs(sinceSwing - expect) < 67,
    `sinceSwing=${sinceSwing.toFixed(0)}ms expect≈${expect.toFixed(0)}ms`,
  );
  check(
    "spin emits strike fx",
    fx.some((e) => e.t === "strike" && e.tag === "spin"),
  );
  check("swingCount is 3", a.swingCount === 3);
}

{
  const { w, a, b } = setup("knight", "blackknight", 2.5);
  const fx: FxEvent[] = [];
  const hp0 = b.hp;
  check("knight:Q cast ok", castAbility(w, a, "Q", { dir: { x: 1, y: 0 } }));
  check("no instant damage on cast tick", b.hp === hp0);
  const t = runUntil(w, fx, () => b.hp < hp0);
  const expect = castStrikeMs("knight", "Q");
  check(
    "knight:Q lands at contact",
    t >= 0 && Math.abs(t - expect) < 67,
    `t=${t?.toFixed(0)}ms expect≈${expect.toFixed(0)}ms`,
  );
  check(
    "victim stunned on strike (not before)",
    b.statuses.some((s) => s.kind === "stun"),
  );
  check(
    "strike fx emitted",
    fx.some((e) => e.t === "strike" && e.tag === "knight:Q"),
  );
}

{
  const { w, a, b } = setup("knight", "ranger", 3);
  const hp0 = b.hp;
  castAbility(w, a, "Q", { dir: { x: 1, y: 0 } });
  b.moveX = 1;
  b.moveY = 0;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => w.now > 900, 1000);
  check("knight:Q dodged by moving out", b.hp === hp0, `hp ${hp0.toFixed(0)}→${b.hp.toFixed(0)}`);
}

{
  const { w, a, b } = setup("knight", "blackknight", 4);
  const fx: FxEvent[] = [];
  const hp0 = b.hp;
  check("knight JUMP cast ok", castAbility(w, a, "JUMP", { dir: { x: 1, y: 0 } }));
  check("JUMP: no damage at cast", b.hp === hp0);
  const t = runUntil(w, fx, () => b.hp < hp0);
  const expectLeap = (5 / 20) * 1000;
  check(
    "JUMP slam lands at touchdown",
    t >= 0 && Math.abs(t - expectLeap) < 67,
    `t=${t.toFixed(0)}ms expect≈${expectLeap.toFixed(0)}ms`,
  );
  check(
    "JUMP strike fx at landing point",
    fx.some((e) => e.t === "strike" && e.tag === "knight:JUMP" && Math.abs(e.x - 5) < 0.01),
  );
}

{
  const { w, a, b } = setup("knight", "blackknight", 2.5);
  const hp0 = b.hp;
  castAbility(w, a, "Q", { dir: { x: 1, y: 0 } });
  a.statuses.push({ id: "test", kind: "stun", until: w.now + 2000 });
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => w.now > 900, 1000);
  check("stunned mid-windup → strike cancelled", b.hp === hp0);
}

{
  const { w, a, b } = setup("blackknight", "knight", 5);
  const fx: FxEvent[] = [];
  const hp0 = b.hp;
  castAbility(w, a, "W", { point: { x: b.x, y: b.y } });
  check(
    "smite arms a telegraph zone",
    w.grounds.some((g) => g.effect === "smite" && g.telegraph === true),
  );
  check("smite: no damage at cast", b.hp === hp0);
  const t = runUntil(w, fx, () => b.hp < hp0);
  check("smite detonates ≈450ms", t >= 0 && Math.abs(t - 450) < 67, `t=${t.toFixed(0)}ms`);
  check(
    "smite stuns on detonate",
    b.statuses.some((s) => s.kind === "stun"),
  );
  check(
    "smite explosion fx",
    fx.some((e) => e.t === "explosion" && e.kind === "smite"),
  );
}

{
  const { w, a, b } = setup("witch", "knight", 5);
  const fx: FxEvent[] = [];
  a.abilities.R.rank = 1;
  castAbility(w, a, "R", { point: { x: b.x, y: b.y } });
  check(
    "hexring zone armed",
    w.grounds.some((g) => g.effect === "hexring"),
  );
  const t = runUntil(w, fx, () => b.statuses.some((s) => s.kind === "hex"));
  check("hex applies on seal ≈500ms", t >= 0 && Math.abs(t - 500) < 67, `t=${t.toFixed(0)}ms`);
}

{
  const { w, a, b } = setup("ranger", "knight", 8);
  const fx: FxEvent[] = [];
  a.attackHeld = true;
  b.y = 16 + 1.35;
  const hp0 = b.hp;
  const t = runUntil(w, fx, () => b.hp < hp0, 3000);
  check("ranged basic connects with grazing offset", t >= 0, `t=${t.toFixed(0)}ms`);
  const swingAt = fx.findIndex((e) => e.t === "swing");
  check("muzzle flash fires at release", swingAt !== -1);
}

{
  const { w, a, b } = setup("rogue", "knight", 5);
  const fx: FxEvent[] = [];
  a.abilities.R.rank = 1;
  b.hp = b.maxHp * 0.3;
  const hp0 = b.hp;
  check("rogue:R cast ok", castAbility(w, a, "R", { dir: { x: 1, y: 0 } }));
  check("rogue:R no damage at cast", b.hp === hp0);
  const t = runUntil(w, fx, () => b.hp < hp0);
  check("rogue:R lands on arrival", t >= 0 && t < 400, `t=${t.toFixed(0)}ms`);
}

{
  const { w, a } = setup("knight", "ranger", 30);
  const props = [...w.units.values()].filter((u) => u.kind === "prop");
  check("props spawned", props.length >= 10, `${props.length} props`);
  const kegs = props.filter((p) => p.champId.includes("keg"));
  check("kegs exist", kegs.length >= 2);

  const [keg, other] = kegs;

  if (!keg || !other) {
    throw new Error("need two kegs");
  }

  a.x = keg.x - 1.6;
  a.y = keg.y;
  a.aimX = 1;
  a.aimY = 0;
  a.attackHeld = true;
  const fx: FxEvent[] = [];
  const t = runUntil(w, fx, () => !keg.alive, 6000);
  check("keg breaks under basics", t >= 0);
  check(
    "propBreak fx emitted",
    fx.some((e) => e.t === "propBreak" && e.model.includes("keg")),
  );
  check(
    "keg blast explosion fx",
    fx.some((e) => e.t === "explosion" && e.kind === "keg"),
  );
  check("keg respawn scheduled", keg.respawnAt > w.now);
  const chained = Math.hypot(other.x - keg.x, other.y - keg.y) < 3.5 ? !other.alive : true;
  check("neighbor keg chain-detonates", chained);
}

{
  const { w, a } = setup("knight", "ranger", 30);
  const crate = [...w.units.values()].find((u) => u.kind === "prop" && u.champId === "crate_large");

  if (!crate) {
    throw new Error("crate_large prop missing");
  }

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

{
  const { w, a, b } = setup("ranger", "knight", 5);

  const c2 = spawnHero(w, {
    champId: "blackknight",
    id: "C",
    isBot: false,
    name: "C",
    ownerId: "C",
    slot: 2,
    team: "C",
  });

  c2.x = 7.5;
  c2.y = 16;
  a.attackHeld = true;
  const hpB = b.hp;
  const hpC = c2.hp;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => b.hp < hpB && c2.hp < hpC, 4000);
  check(
    "ranger arrow pierces both targets",
    b.hp < hpB && c2.hp < hpC,
    `b ${hpB.toFixed(0)}→${b.hp.toFixed(0)} c ${hpC.toFixed(0)}→${c2.hp.toFixed(0)}`,
  );
}

{
  const { w, a, b } = setup("mage", "knight", 7);

  const c2 = spawnHero(w, {
    champId: "blackknight",
    id: "C",
    isBot: false,
    name: "C",
    ownerId: "C",
    slot: 2,
    team: "C",
  });

  c2.x = 7;
  c2.y = 17.2;
  a.attackHeld = true;
  const hpB = b.hp;
  const hpC = c2.hp;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => b.hp < hpB, 4000);
  check("mage bolt splashes the neighbor", c2.hp < hpC, `c ${hpC.toFixed(0)}→${c2.hp.toFixed(0)}`);
  check(
    "bolt splash explosion fx",
    fx.some((e) => e.t === "explosion" && e.kind === "bolt"),
  );
}

{
  const { w, a } = setup("mage", "knight", 25);
  const fx: FxEvent[] = [];
  check(
    "fireball cast ok",
    castAbility(w, a, "Q", { dir: { x: 1, y: 0 }, point: { x: 6, y: 16 } }),
  );
  runUntil(w, fx, () => fx.some((e) => e.t === "explosion" && e.kind === "fireball"), 2500);
  const boom = fx.find((e) => e.t === "explosion" && e.kind === "fireball");
  check(
    "fireball airbursts AT the aim point",
    boom !== undefined &&
      boom.t === "explosion" &&
      Math.abs(boom.x - 6) < 1.2 &&
      Math.abs(boom.y - 16) < 0.5,
    boom && boom.t === "explosion" ? `at (${boom.x.toFixed(1)},${boom.y.toFixed(1)})` : "no burst",
  );
}

{
  const { w, a } = setup("ranger", "knight", 40);
  a.attackHeld = true;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => fx.some((e) => e.t === "fizzle" && e.kind === "arrow"), 4000);
  check(
    "arrow fizzles at max range",
    fx.some((e) => e.t === "fizzle" && e.kind === "arrow"),
  );
}

{
  const { w, a, b } = setup("rogue", "blackknight", 1.8);
  castAbility(w, a, "E", {});
  a.attackHeld = true;
  const hp0 = b.hp;
  const fx: FxEvent[] = [];
  runUntil(w, fx, () => b.hp < hp0);
  const hit = fx.find((e) => e.t === "hit" && e.by === "A");
  const dealt = hp0 - b.hp;
  check("ambush strike doubles damage", dealt > 55, `dealt=${dealt.toFixed(0)}`);
  check("ambush strike reads as a CRIT", hit !== undefined && hit.t === "hit" && hit.crit === true);
  const hp1 = b.hp;
  const fx2: FxEvent[] = [];
  runUntil(w, fx2, () => b.hp < hp1);
  check("second swing is normal damage", hp1 - b.hp < 55, `dealt=${(hp1 - b.hp).toFixed(0)}`);
}

const walk = (w: World, u: Unit, mx: number, my: number, ms: number) => {
  const until = w.now + ms;
  let everOn = false;
  let everOff = false;

  while (w.now < until) {
    u.moveX = mx;
    u.moveY = my;
    step(w);

    if (onPlateau(u.x, u.y)) {
      everOn = true;
    } else {
      everOff = true;
    }
  }

  return { everOff, everOn };
};

{
  let escaped = 0;

  for (let k = 0; k < 12; k += 1) {
    const a2 = (k / 12) * Math.PI * 2;
    const { w, a } = setup("knight", "ranger", 30);
    a.x = 0;
    a.y = 0;

    if (walk(w, a, Math.cos(a2), Math.sin(a2), 6000).everOff) {
      escaped += 1;
    }
  }

  check("every heading off the throne finds a stair", escaped === 12, `${escaped}/12`);

  let climbed = 0;

  for (let k = 0; k < 12; k += 1) {
    const a2 = (k / 12) * Math.PI * 2;
    const { w, a } = setup("knight", "ranger", 30);
    a.x = Math.cos(a2) * 18;
    a.y = Math.sin(a2) * 18;

    if (walk(w, a, -Math.cos(a2), -Math.sin(a2), 6000).everOn) {
      climbed += 1;
    }
  }

  check("every heading into the throne finds a stair", climbed === 12, `${climbed}/12`);

  let worst = 0;
  const stair = Math.PI / 4;

  for (let r = PLATEAU_R + STAIR_RUN; r > PLATEAU_R - 1; r -= 0.1) {
    const h1 = groundHeight(Math.cos(stair) * r, Math.sin(stair) * r);
    const h2 = groundHeight(Math.cos(stair) * (r - 0.1), Math.sin(stair) * (r - 0.1));
    worst = Math.max(worst, Math.abs(h2 - h1));
  }

  check("stairs ramp, never teleport", worst < 0.12, `max lift ${worst.toFixed(3)}u per 0.1u`);
  check(
    "the plateau top is a real level",
    groundHeight(0, 0) === PLATEAU_H && groundHeight(20, 0) === 0,
  );
}

for (const [champ, shots] of [
  ["ranger", 9],
  ["mage", 7],
] as const) {
  const { w, a, b } = setup(champ, "knight", 4);
  const x0 = a.x;
  const y0 = a.y;
  check(`${champ} aerial cast ok`, castAbility(w, a, "JUMP", { dir: { x: 1, y: 0 } }));
  step(w);
  const airborne = a.statuses.some((s2) => s2.kind === "untargetable");
  check(`${champ} is untargetable in the air`, airborne);
  b.attackHeld = true;
  const hp0 = a.hp;
  let maxDrift = 0;
  let volley = 0;
  const until = w.now + 900;

  while (w.now < until) {
    step(w);
    maxDrift = Math.max(maxDrift, Math.hypot(a.x - x0, a.y - y0));
    volley = Math.max(volley, w.projectiles.size);
  }

  check(`${champ} takes no damage while airborne`, a.hp === hp0, `hp ${hp0}→${a.hp}`);
  check(`${champ} hovers (no travel)`, maxDrift < 0.3, `drift ${maxDrift.toFixed(2)}u`);
  check(`${champ} looses ${shots} shots at the apex`, volley >= shots, `saw ${volley}`);
}

console.log(`\n${pass} passed, ${fail} failed`);

process.exit(fail > 0 ? 1 : 0);
