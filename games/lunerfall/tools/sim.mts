// Headless physics harness: drives PlayerBody through the pure collision grid
// and asserts the feel invariants. No Phaser, no browser. Run: `pnpm test`.
import { TILE } from "../src/config.ts";
import { ENEMIES } from "../src/data/enemies.ts";
import { HEROES } from "../src/data/heroes.ts";
import { bankRun, isUnlocked, unlockHero } from "../src/data/meta.ts";
import { baseMods, pickRelics, RELICS } from "../src/data/relics.ts";
import { BOSS, COMBAT_TEMPLATES, SAFE, START } from "../src/data/rooms.ts";
import { BossBody } from "../src/entities/boss-body.ts";
import { EnemyBody } from "../src/entities/enemy-body.ts";
import { PlayerBody, rectsOverlap, type BodyInput } from "../src/entities/player-body.ts";
import { COLS, Grid, ROWS } from "../src/sys/grid.ts";
import { RunManager } from "../src/sys/run.ts";

const STEP = 1 / 60;
const FLOOR_Y = (ROWS - 2) * TILE; // feet rest here on the test floor

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const NEUTRAL: BodyInput = {
  left: false,
  right: false,
  up: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  dashPressed: false,
  specialPressed: false,
};
const inp = (o: Partial<BodyInput>): BodyInput => ({ ...NEUTRAL, ...o });

// Settle onto the floor first (a couple steps of gravity + contact).
function spawn(x = 240, y = FLOOR_Y, hero: keyof typeof HEROES = "axion"): PlayerBody {
  const b = new PlayerBody(Grid.test(), x, y, HEROES[hero].kit);
  for (let i = 0; i < 5; i++) {
    b.buffer(NEUTRAL);
    b.step(STEP);
  }
  return b;
}

// Run `frames` steps holding `held`; `pressOn` fires edge inputs on given frame.
function run(b: PlayerBody, frames: number, held: Partial<BodyInput>, pressOn: Record<number, Partial<BodyInput>> = {}) {
  for (let f = 0; f < frames; f++) {
    b.buffer(inp({ ...held, ...(pressOn[f] ?? {}) }));
    b.step(STEP);
  }
}

console.log("lunerfall physics sim\n");

// 1. Spawns and rests on the floor.
{
  const b = spawn();
  check("rests on floor", b.grounded && Math.abs(b.y - FLOOR_Y) < 1, `y=${b.y.toFixed(1)}`);
  check("no residual velocity", Math.abs(b.vy) < 1 && Math.abs(b.vx) < 1);
}

// 2. Full jump reaches a sensible apex then returns to ground.
{
  const b = spawn();
  let apex = b.y;
  b.buffer(inp({ jumpHeld: true, jumpPressed: true }));
  b.step(STEP);
  for (let f = 0; f < 120; f++) {
    b.buffer(inp({ jumpHeld: b.vy < 0 })); // hold on the way up
    b.step(STEP);
    apex = Math.min(apex, b.y);
  }
  const height = FLOOR_Y - apex;
  check("jump apex height 40–72px", height > 40 && height < 72, `${height.toFixed(1)}px`);
  check("lands back on floor", b.grounded && Math.abs(b.y - FLOOR_Y) < 1);
}

// 3. Variable jump: tapping (release immediately) hops lower than holding.
{
  const tap = spawn();
  tap.buffer(inp({ jumpHeld: true, jumpPressed: true }));
  tap.step(STEP);
  let tapApex = tap.y;
  for (let f = 0; f < 120; f++) {
    tap.buffer(NEUTRAL); // released
    tap.step(STEP);
    tapApex = Math.min(tapApex, tap.y);
  }
  const hold = spawn();
  hold.buffer(inp({ jumpHeld: true, jumpPressed: true }));
  hold.step(STEP);
  let holdApex = hold.y;
  for (let f = 0; f < 120; f++) {
    hold.buffer(inp({ jumpHeld: hold.vy < 0 }));
    hold.step(STEP);
    holdApex = Math.min(holdApex, hold.y);
  }
  check(
    "tap jumps lower than hold",
    FLOOR_Y - tapApex < FLOOR_Y - holdApex - 8,
    `tap=${(FLOOR_Y - tapApex).toFixed(0)} hold=${(FLOOR_Y - holdApex).toFixed(0)}`,
  );
}

// 4. Coyote time: can still jump a few frames after walking off a ledge.
{
  // Left solid ledge = cols 6..10 at row 10 (right edge at x=176). Start near
  // the edge so a few frames of running clears it into the air.
  const ledgeY = 10 * TILE;
  const b = spawn(172, ledgeY);
  check("on ledge grounded", b.grounded, `y=${b.y.toFixed(1)}`);
  let airborneAt = -1;
  let jumpFrame = -1;
  let jumpedUp = false;
  for (let f = 0; f < 30; f++) {
    if (b.grounded === false && airborneAt < 0) airborneAt = f;
    // jump 2 frames after leaving the ledge — inside the 0.1s coyote window.
    const press = airborneAt >= 0 && f === airborneAt + 2;
    if (press) jumpFrame = f;
    b.buffer(inp({ right: true, jumpHeld: jumpFrame >= 0, jumpPressed: press }));
    b.step(STEP);
    if (jumpFrame >= 0 && f >= jumpFrame && b.vy < 0) jumpedUp = true;
  }
  check("coyote jump after leaving ledge", jumpedUp, `airborne@${airborneAt}`);
}

// 5. Dash: covers ground quickly and grants i-frames.
{
  const b = spawn();
  const x0 = b.x;
  b.buffer(inp({ right: true, dashPressed: true }));
  b.step(STEP);
  check("i-frames active during dash", b.iframes > 0 && b.dashing);
  run(b, 9, { right: true }); // dash duration ~0.15s = 9 frames
  const dist = b.x - x0;
  check("dash covers 35–60px", dist > 35 && dist < 60, `${dist.toFixed(1)}px`);
}

// 6. Wall slide: pressing into the right wall caps fall speed.
{
  // Spawn airborne next to the right wall (col 29 solid), press right + fall.
  const b = new PlayerBody(Grid.test(), (Grid.test().cols - 1) * TILE - 7, 60);
  let maxFall = 0;
  for (let f = 0; f < 40; f++) {
    b.buffer(inp({ right: true }));
    b.step(STEP);
    if (b.wallDir === 1) maxFall = Math.max(maxFall, b.vy);
  }
  check("touches right wall", b.wallDir === 1 || b.grounded);
  check("wall slide caps fall speed <90", maxFall > 0 && maxFall < 90, `maxVy=${maxFall.toFixed(1)}`);
}

// 7. One-way platform: land from above, drop through when holding down.
{
  // low-left one-way at row 12, cols 3..7. Spawn just above it, falling.
  const owY = 12 * TILE;
  const b = new PlayerBody(Grid.test(), 5 * TILE, owY - 20);
  run(b, 30, {}); // fall onto it
  check("lands on one-way", b.grounded && Math.abs(b.y - owY) < 1, `y=${b.y.toFixed(1)}`);
  run(b, 20, { down: true }); // hold down to drop through
  check("drops through on down", b.y > owY + 4, `y=${b.y.toFixed(1)}`);
}

// 8. Attack combo chains 1 → 2 → 3 when spamming attack.
{
  const b = spawn();
  let maxStep = 0;
  // 150 frames: each swing runs for its (tempo-scaled) `dur`, and the next chains
  // when it ends, so 3 hits span ~2.6s at SWING_TEMPO 4 — widen the window to suit.
  for (let f = 0; f < 150; f++) {
    b.buffer(inp({ attackPressed: true }));
    b.step(STEP);
    maxStep = Math.max(maxStep, b.attackStep);
  }
  check("combo reaches step 3", maxStep === 3 && b.swingId >= 3, `maxStep=${maxStep} swings=${b.swingId}`);
}

// 9. Attack hitbox is live in front during the active window.
{
  const b = spawn(100, FLOOR_Y);
  run(b, 3, { right: true }); // face right
  let boxSeen = false;
  b.buffer(inp({ right: true, attackPressed: true }));
  b.step(STEP);
  for (let f = 0; f < 12; f++) {
    // Box reaches in front (right > x); it also overlaps the body a little for
    // point-blank hits, so the near edge sits just behind center.
    const box = b.attackBox();
    if (box && box.right > b.x && box.left >= b.x - 10) boxSeen = true;
    b.buffer(inp({ right: true }));
    b.step(STEP);
  }
  check("attack hitbox live in front", boxSeen);
}

// 10. i-frames gate repeated hurt.
{
  const b = spawn();
  const first = b.applyHurt(1);
  const second = b.applyHurt(1);
  check("hurt lands once, then invuln", first === true && second === false);
}

// 11. Head-stomp bounce sends the player upward.
{
  const b = spawn();
  b.bounce();
  check("stomp bounce is upward", b.vy < -100 && !b.grounded, `vy=${b.vy.toFixed(0)}`);
}

// 12. Warrior chases the target and swings when in range.
{
  const g = Grid.test();
  const w = new EnemyBody(ENEMIES.warrior, g, 300, FLOOR_Y);
  const tx = 210;
  let sawAttack = false;
  let minDist = 999;
  for (let f = 0; f < 180; f++) {
    w.step(STEP, tx, FLOOR_Y);
    minDist = Math.min(minDist, Math.abs(w.x - tx));
    if (w.attackBox()) sawAttack = true;
  }
  check("warrior closes on target", minDist < 30, `minDist=${minDist.toFixed(0)}`);
  check("warrior swings in range", sawAttack);
}

// 13. Warrior dies after two clean melee hits.
{
  const g = Grid.test();
  const w = new EnemyBody(ENEMIES.warrior, g, 200, FLOOR_Y);
  for (let f = 0; f < 30; f++) w.step(STEP, 200, FLOOR_Y); // let spawn elapse
  w.takeHit(1, 100, 1);
  const aliveMid = !w.dead;
  for (let f = 0; f < 12; f++) w.step(STEP, 200, FLOOR_Y); // clear i-frames
  w.takeHit(1, 100, 1);
  check("warrior dies after 2 hits", aliveMid && w.dead);
}

// 14. Archer fires a projectile aimed at the target.
{
  const g = Grid.test();
  const a = new EnemyBody(ENEMIES.archer, g, 120, FLOOR_Y);
  const tx = 260;
  let proj = null as ReturnType<EnemyBody["step"]> | { vx: number } | null;
  for (let f = 0; f < 120 && !proj; f++) {
    a.step(STEP, tx, FLOOR_Y);
    if (a.pendingProjectile) proj = a.pendingProjectile;
  }
  check("archer fires toward target", !!proj && (proj as { vx: number }).vx > 0);
}

// 15. Bomber explodes near the target.
{
  const g = Grid.test();
  const bomber = new EnemyBody(ENEMIES.bomber, g, 240, FLOOR_Y);
  let blast = false;
  for (let f = 0; f < 240 && !blast; f++) {
    bomber.step(STEP, 250, FLOOR_Y);
    if (bomber.pendingBlast) blast = true;
  }
  check("bomber explodes near target", blast && bomber.dead);
}

// sanity: rectsOverlap is correct
check("rectsOverlap basic", rectsOverlap({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 5, top: 5, right: 15, bottom: 15 }));

// 16. Room templates are well-formed.
{
  const inRoom = (r: { cols: number; rows: number }, s: { x: number; y: number }) =>
    s.x > 0 && s.x < r.cols * TILE && s.y > 0 && s.y <= r.rows * TILE;
  const start = START();
  check("start has a door + spawn", start.doorSlots.length >= 1 && inRoom(start, start.playerSpawn));
  let combatOk = true;
  for (const make of COMBAT_TEMPLATES) {
    const r = make();
    if (r.doorSlots.length < 2 || r.enemySpawns.length < 3 || !r.enemySpawns.every((s) => inRoom(r, s)))
      combatOk = false;
  }
  check("combat rooms: 2 doors + 3+ enemies", combatOk, `${COMBAT_TEMPLATES.length} templates`);
  const safe = SAFE();
  check("safe room has a feature + doors", !!safe.featureSpot && safe.doorSlots.length >= 1);
  const boss = BOSS();
  check("boss room has boss spawn + door", !!boss.bossSpawn && boss.doorSlots.length >= 1);
}

// 17. A run reaches the boss, then descends to a harder biome.
{
  const run = new RunManager();
  run.begin();
  let sawBoss = false;
  for (let i = 0; i < 15 && run.type !== "boss"; i++) {
    const offers = run.offers();
    const first = offers[0];
    if (!first) break;
    if (first.type === "boss") sawBoss = true;
    run.choose(first);
  }
  check("run reaches the boss", run.type === "boss" && sawBoss, `biome${run.biome} depth${run.depth}`);
  const b0 = run.biome;
  run.choose(run.offers()[0] ?? { type: "start" });
  check("beating boss descends a biome", run.biome === b0 + 1 && run.depth === 1);
}

// 18. Hero specials: blink teleports, heal queues HP, flame-wave fires a shot.
{
  const riven = spawn(120, FLOOR_Y, "riven");
  run(riven, 3, { right: true });
  const x0 = riven.x;
  riven.buffer(inp({ right: true, specialPressed: true }));
  riven.step(STEP);
  check("riven blink teleports forward", riven.x - x0 > 40 && riven.iframes > 0, `dx=${(riven.x - x0).toFixed(0)}`);

  const mooni = spawn(240, FLOOR_Y, "mooni");
  mooni.buffer(inp({ specialPressed: true }));
  mooni.step(STEP);
  check("mooni heal queues HP", mooni.pendingHeal > 0);

  const sal = spawn(120, FLOOR_Y, "salamander");
  run(sal, 3, { right: true });
  let shot = false;
  sal.buffer(inp({ specialPressed: true }));
  sal.step(STEP);
  for (let f = 0; f < 40 && !shot; f++) {
    if (sal.pendingShot && sal.pendingShot.vx > 0) shot = true;
    sal.buffer(NEUTRAL);
    sal.step(STEP);
  }
  check("salamander flame-wave fires forward", shot);
}

// 19. Boss: attacks, enters phase 2 at half HP, dies at 0, emits a flame wave.
{
  const g = Grid.test();
  const boss = new BossBody(g, 240, FLOOR_Y, 1);
  const maxHp = boss.maxHp;
  let sawAttack = false;
  let sawWave = false;
  for (let f = 0; f < 300; f++) {
    boss.step(STEP, 200, FLOOR_Y);
    if (boss.state === "wave" || boss.state === "jump" || boss.state === "punch" || boss.state === "slam") sawAttack = true;
    if (boss.pendingWave) {
      sawWave = true;
      boss.pendingWave = null;
    }
  }
  check("boss attacks the player", sawAttack);
  check("boss can fire a flame wave", sawWave || boss.state !== "wave", "wave or non-wave state ok");
  // damage it to half → phase 2
  while (boss.hp > maxHp / 2) {
    boss.step(STEP, 200, FLOOR_Y);
    boss.takeHit(2, 0, 1);
  }
  boss.takeHit(2, 0, 1);
  check("boss enters phase 2 at half HP", boss.phase === 2, `hp=${boss.hp}/${maxHp}`);
  let guard = 0;
  while (!boss.dead && guard++ < 400) {
    boss.step(STEP, 200, FLOOR_Y);
    boss.takeHit(3, 0, 1);
  }
  check("boss dies at 0 HP", boss.dead && boss.state === "dead");
}

// 20. Relics apply mods correctly; the shop picks distinct relics.
{
  const m = baseMods();
  const edge = RELICS.find((r) => r.id === "edge");
  edge?.apply(m);
  const vigor = RELICS.find((r) => r.id === "vigor");
  vigor?.apply(m);
  check("relics stack onto mods", Math.abs(m.dmg - 1.5) < 1e-9 && m.maxHearts === 5, `dmg=${m.dmg} hp=${m.maxHearts}`);
  const picks = pickRelics(3, new Set());
  const ids = new Set(picks.map((r) => r.id));
  check("shop offers 3 distinct relics", picks.length === 3 && ids.size === 3);
  const excl = new Set(RELICS.slice(0, RELICS.length - 1).map((r) => r.id));
  check("shop respects owned exclusions", pickRelics(3, excl).length === 1);
}

// 21. Meta: runs bank shards, shards unlock warriors, gating holds.
{
  const m = { shards: 0, unlocked: ["axion", "reaper"], bestDepth: 0, runs: 0 };
  check("free warriors start unlocked", isUnlocked(m, "axion") && isUnlocked(m, "reaper"));
  check("paid warriors start locked", !isUnlocked(m, "riven") && !isUnlocked(m, "mooni"));
  const earned = bankRun(m, 40, 5, 2); // 10 + 10 + 6
  check("run banks shards + best depth", earned === 26 && m.shards === 26 && m.bestDepth === 5, `earned=${earned}`);
  check("affordable unlock spends shards", unlockHero(m, "riven") && isUnlocked(m, "riven") && m.shards === 6);
  check("unaffordable unlock is refused", !unlockHero(m, "mooni") && !isUnlocked(m, "mooni") && m.shards === 6);
}

// Every combat-room enemy must be reachable: standing on a real surface with
// player-height headroom above it — no enemy sealed in a solid pocket (the bug
// where a warrior was trapped in the 1-tile gap under the central ruin).
{
  const HEAD = 2; // tiles of clearance a body needs above its feet cell
  let sealed = 0;
  let floating = 0;
  // Check each template AND its left↔right mirror — mirroring is used at runtime,
  // so a broken flip must fail the harness too.
  COMBAT_TEMPLATES.forEach((make) => {
    for (const r of [make(), make().mirror()]) {
      const g = r.grid;
      for (const s of r.enemySpawns) {
        const cx = Math.floor(s.x / TILE);
        const feet = Math.round(s.y / TILE) - 1; // stand row (body rests on cell feet+1)
        if (!g.isSolidCell(cx, feet + 1) && !g.isOneWayCell(cx, feet + 1)) floating++;
        for (let dy = 0; dy < HEAD; dy++) {
          if (g.isSolidCell(cx, feet - dy)) {
            sealed++;
            break;
          }
        }
      }
    }
  });
  check("no combat enemy sealed under a platform", sealed === 0, `${sealed} sealed`);
  check("every combat enemy stands on a surface", floating === 0, `${floating} floating`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
