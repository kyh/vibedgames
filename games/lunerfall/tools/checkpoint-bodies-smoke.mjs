// Split real simulations at runtime checkpoints; compare their subsequent
// observable motion, contacts, outputs and callbacks to uninterrupted runs.
// The oracle never enumerates or reimplements checkpoint/restore fields.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PlayerBody } from "../src/entities/player-body.ts";
import { EnemyBody } from "../src/entities/enemy-body.ts";
import { BossBody } from "../src/entities/boss-body.ts";
import { HEROES } from "../src/data/heroes.ts";
import { ENEMIES } from "../src/data/enemies.ts";
import { Grid, ROWS } from "../src/sys/grid.ts";
import { TILE } from "../src/config.ts";
import { VersusMatch } from "../src/sys/versus.ts";
import { RunManager } from "../src/sys/run.ts";
import { checkpointRng, restoreRng, reseed, rand, mulberry32 } from "../src/sys/rng.ts";
import { enemyPose, BossActing } from "../src/data/actor-presentation.ts";

const DT = 1 / 60;
const floor = (ROWS - 2) * TILE;
const neutral = {
  left: false,
  right: false,
  up: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  dashPressed: false,
  attackPressed: false,
  specialPressed: false,
};
const wire = (value) => JSON.parse(JSON.stringify(value));
let groups = 0,
  splits = 0,
  comparedFrames = 0;
function check(name, run) {
  run();
  groups++;
  console.log(`PASS ${name}`);
}
function freeze(value) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Recursively freeze the JSON transport fixture to detect restore aliasing.
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function spatial(body) {
  return {
    x: body.x,
    y: body.y,
    prevX: body.prevX,
    prevY: body.prevY,
    vx: body.vx,
    vy: body.vy,
    facing: body.facing,
    grounded: body.grounded,
    iframes: body.iframes,
    dead: body.dead,
    hurtBox: body.hurtBox(),
  };
}

/** Each fixture supplies existing inputs/interactions; both branches run the
 * same original methods. JSON transport plus frozen payload catches aliasing.
 * Restores use a fresh body, never the original object.
 */
function splitRun({ name, make, advance, observe, labels, frames = 720, seed = 81723 }) {
  reseed(seed);
  const live = make();
  const expected = [];
  const points = [];
  const seen = new Set();
  for (let frame = 0; frame < frames; frame++) {
    advance(live, frame);
    const observation = wire(observe(live));
    expected.push(observation);
    const next = labels(observation);
    const fresh = next.some((label) => !seen.has(label));
    next.forEach((label) => seen.add(label));
    if (fresh || [7, 26, 121, 137, 309, 357, 675].includes(frame))
      points.push({ frame, state: freeze(wire(live.body.checkpoint())), rng: checkpointRng() });
  }
  assert.ok(points.length >= 8, `${name}: meaningful split points`);
  for (const point of points) {
    const restored = make();
    const eventsBefore = wire(restored.events ?? []);
    restored.body.restore(point.state);
    restoreRng(point.rng);
    assert.deepEqual(restored.events ?? [], eventsBefore, `${name}: restore emits no callbacks`);
    // Event callbacks are edges that already happened; all other public state
    // and unconsumed outputs must agree immediately, before the next step.
    const current = wire(observe(restored));
    const past = { ...expected[point.frame] };
    delete current.events;
    delete past.events;
    assert.deepEqual(current, past, `${name}: immediate frame ${point.frame}`);
    const frozenJson = JSON.stringify(point.state);
    for (let frame = point.frame + 1; frame < frames; frame++) {
      advance(restored, frame);
      assert.deepEqual(
        wire(observe(restored)),
        expected[frame],
        `${name}: split ${point.frame}, frame ${frame}`,
      );
      comparedFrames++;
    }
    assert.equal(JSON.stringify(point.state), frozenJson, `${name}: immutable checkpoint`);
    splits++;
  }
  return { seen, points };
}

check("RNG capture takes no seeded draw; JSON-restored stream resumes the exact next value", () => {
  const native = Math.random;
  let calls = 0;
  Math.random = () => {
    calls++;
    return 0.125;
  };
  try {
    const first = checkpointRng();
    assert.equal(calls, 1);
    assert.equal(checkpointRng(), first);
    assert.equal(calls, 1);
  } finally {
    Math.random = native;
  }
  for (const seed of [0, 1, 0xffffffff, 18473]) {
    reseed(seed);
    const reference = mulberry32(seed);
    for (let i = 0; i < 137; i++) assert.equal(rand(), reference());
    const captured = wire(checkpointRng());
    assert.equal(checkpointRng(), captured);
    const future = Array.from({ length: 100 }, () => rand());
    restoreRng(captured);
    assert.deepEqual(
      Array.from({ length: 100 }, () => rand()),
      future,
    );
  }
});

const bodyEvents = [
  "onJump",
  "onWallJump",
  "onLand",
  "onDash",
  "onSwing",
  "onSpecial",
  "onHurt",
  "onSquash",
];
function playerFixture(hero) {
  const events = [];
  const callbacks = Object.fromEntries(
    bodyEvents.map((name) => [name, (...args) => events.push([name, ...args])]),
  );
  const body = new PlayerBody(Grid.test(), 120, floor, HEROES[hero].kit, callbacks);
  return { body, events };
}
function playerStep({ body, events }, i) {
  events.length = 0;
  body.pendingShot = null;
  body.pendingHeal = 0;
  if (i === 100) body.applyHurt(-1);
  if (i === 670) body.down();
  if (i === 690) body.revive();
  if (i === 710) body.dead = true;
  const jumpPressed = [12, 54, 93].includes(i),
    dashPressed = [33, 75, 180].includes(i);
  const attackPressed = [120, 134, 152, 213, 228, 252].includes(i),
    specialPressed = [300, 318, 605].includes(i);
  // Several fixed steps share a sample, as with a rendered frame backlog.
  // A restore must retain held intent and buffers until the next real sample.
  if (i % 6 === 0 || jumpPressed || dashPressed || attackPressed || specialPressed)
    body.buffer({
      ...neutral,
      right: i < 90,
      left: i >= 90 && i < 115,
      up: i === 75,
      jumpHeld: i >= 12 && i < 23,
      jumpPressed,
      dashPressed,
      attackPressed,
      specialPressed,
    });
  body.step(DT);
}
function playerObservation({ body, events }) {
  return {
    ...spatial(body),
    wallDir: body.wallDir,
    downed: body.downed,
    dashing: body.dashing,
    hurting: body.hurting,
    attackStep: body.attackStep,
    swingId: body.swingId,
    specialId: body.specialId,
    specialActive: body.specialActive,
    specialCdFrac: body.specialCdFrac,
    attack: body.attackBox(),
    special: body.specialBox(),
    shot: body.pendingShot,
    heal: body.pendingHeal,
    events,
  };
}
check(
  "all five heroes retain motion, buffered combos, special outputs/cooldowns and callback edges",
  () => {
    for (const hero of Object.keys(HEROES)) {
      const result = splitRun({
        name: hero,
        make: () => playerFixture(hero),
        advance: playerStep,
        observe: playerObservation,
        labels: (s) => [
          s.dead
            ? "dead"
            : s.downed
              ? "downed"
              : s.hurting
                ? "hurt"
                : s.dashing
                  ? "dash"
                  : s.specialActive
                    ? "special"
                    : s.attack
                      ? "contact"
                      : s.attackStep
                        ? "swing"
                        : s.grounded
                          ? "ground"
                          : "air",
          ...(s.shot ? ["shot"] : []),
          ...(s.heal ? ["heal"] : []),
          ...s.events.map((event) => event[0]),
        ],
      });
      for (const event of ["onSwing", "onSpecial", "onDash", "onJump", "onHurt", "downed", "dead"])
        assert.ok(result.seen.has(event), `${hero}: ${event}`);
      if (HEROES[hero].kit.special.kind === "projectile") assert.ok(result.seen.has("shot"));
      if (HEROES[hero].kit.special.kind === "heal") assert.ok(result.seen.has("heal"));
    }
  },
);

check(
  "four enemy FSMs retain charge direction, collision recovery, affixes and pending projectiles/blasts",
  () => {
    for (const kind of Object.values(ENEMIES)) {
      const result = splitRun({
        name: kind.name,
        frames: 500,
        make: () => {
          const body = new EnemyBody(kind, Grid.test(), 160, floor);
          body.hp = 8;
          body.speedMult = 1.35;
          body.dmgTakenMult = 0.7;
          body.dmgOutMult = 1.25;
          return { body };
        },
        advance: ({ body }, i) => {
          body.pendingProjectile = null;
          body.pendingBlast = null;
          if (i === 203) body.takeHit(1, 80, -1);
          if (i === 450) body.takeHit(99, 30, 1);
          body.step(
            DT,
            body.x +
              (i < 280 ? 1 : -1) *
                (kind.name === "archer" ? 100 : kind.name === "spearman" ? 60 : 8),
            floor,
          );
        },
        observe: ({ body }) => ({
          ...spatial(body),
          hp: body.hp,
          state: body.state,
          age: body.stateT,
          contactDamage: body.contactDamage(),
          attack: body.attackBox(),
          projectile: body.pendingProjectile,
          blast: body.pendingBlast,
          pose: enemyPose(body.kind, { state: body.state, elapsed: body.stateT }),
        }),
        labels: (s) => [
          s.state,
          ...(s.projectile ? ["projectile"] : []),
          ...(s.blast ? ["blast"] : []),
        ],
      });
      assert.ok(result.seen.has("dead"));
      assert.ok(result.seen.has("windup"));
      if (kind.name === "archer") assert.ok(result.seen.has("projectile"));
      if (kind.name === "bomber") assert.ok(result.seen.has("blast"));
    }
  },
);

check(
  "all five bosses retain real warning/action ages, RNG attack choices, phase summons and terminal state",
  () => {
    for (let biome = 1; biome <= 5; biome++) {
      const result = splitRun({
        name: `boss-${biome}`,
        make: () => ({ body: new BossBody(Grid.test(), 200, floor, biome) }),
        advance: ({ body }, i) => {
          body.pendingWaves = [];
          body.pendingBlast = null;
          body.pendingAdds = null;
          const state = { 0: "wave", 80: "punch", 140: "charge", 220: "jump", 500: "hurt" }[i];
          if (state) body.forceState(state);
          if (i === 340) body.takeHit(body.maxHp * 0.51, 0, 1);
          if (i === 660) body.takeHit(body.maxHp * 2, 0, 1);
          body.step(DT, 280, floor);
        },
        observe: ({ body }) => ({
          ...spatial(body),
          hp: body.hp,
          hpFrac: body.hpFrac,
          phase: body.phase,
          state: body.state,
          age: body.stateT,
          telegraph: body.telegraphing,
          attack: body.attackBox(),
          waves: body.pendingWaves,
          blast: body.pendingBlast,
          adds: body.pendingAdds,
          pose: new BossActing().pose({ state: body.state, elapsed: body.stateT }),
        }),
        labels: (s) => [
          s.state,
          ...(s.waves.length ? ["waves"] : []),
          ...(s.blast ? ["blast"] : []),
          ...(s.adds ? ["adds"] : []),
        ],
      });
      for (const label of [
        "wave",
        "punch",
        "charge",
        "jump",
        "slam",
        "phase",
        "hurt",
        "dead",
        "waves",
        "blast",
        "adds",
      ])
        assert.ok(result.seen.has(label), `biome ${biome}: ${label}`);
    }
  },
);

check(
  "pending nested outputs are copied both on capture and restore, without aliasing the live owner",
  () => {
    const boss = new BossBody(Grid.test(), 200, floor, 5);
    boss.forceState("wave");
    while (boss.pendingWaves.length === 0) boss.step(DT, 280, floor);
    const cp = boss.checkpoint(),
      original = wire(cp);
    assert.notEqual(cp.pendingWaves, boss.pendingWaves);
    assert.notEqual(cp.pendingWaves[0], boss.pendingWaves[0]);
    boss.pendingWaves[0].x += 99;
    assert.deepEqual(cp, original);
    const restored = new BossBody(Grid.test(), 10, 10, 5);
    restored.restore(cp);
    restored.pendingWaves[0].x -= 99;
    assert.deepEqual(cp, original);
    const player = playerFixture("salamander");
    player.body.buffer({ ...neutral, specialPressed: true });
    while (!player.body.pendingShot) player.body.step(DT);
    const shotCp = player.body.checkpoint(),
      shot = wire(shotCp.pendingShot);
    player.body.pendingShot.x += 99;
    assert.deepEqual(shotCp.pendingShot, shot);
    const adopted = playerFixture("salamander");
    adopted.body.restore(shotCp);
    adopted.body.pendingShot.x -= 99;
    assert.deepEqual(shotCp.pendingShot, shot);
    assert.deepEqual(adopted.events, []);
    const enemy = new EnemyBody(ENEMIES.archer, Grid.test(), 160, floor);
    while (!enemy.pendingProjectile) enemy.step(DT, 260, floor);
    const enemyCp = enemy.checkpoint(),
      projectile = wire(enemyCp.pendingProjectile);
    enemy.pendingProjectile.x += 99;
    assert.deepEqual(enemyCp.pendingProjectile, projectile);
    const twin = new EnemyBody(ENEMIES.archer, Grid.test(), 1, 1);
    twin.restore(enemyCp);
    twin.pendingProjectile.x -= 99;
    assert.deepEqual(enemyCp.pendingProjectile, projectile);
  },
);

check(
  "versus full-precision countdown, scores, winner and rematch hold survive every phase split",
  () => {
    const result = splitRun({
      name: "versus",
      frames: 1050,
      make: () => {
        const body = new VersusMatch();
        body.beginMatch();
        return { body, transition: null };
      },
      advance: (fixture) => {
        const body = fixture.body;
        if (body.phase === "fighting") body.damage("guest", 2);
        fixture.transition = body.step(DT);
      },
      observe: ({ body, transition }) => ({
        events: transition ? [transition] : [],
        phase: body.phase,
        t: body.t,
        round: body.round,
        hp: { ...body.hp },
        score: { ...body.score },
        winner: body.winner,
        frozen: body.frozen,
        canRematch: body.canRematch,
        wire: body.encode(),
      }),
      labels: (s) => [s.phase, `round-${s.round}`, ...(s.canRematch ? ["armed"] : [])],
    });
    for (const label of ["countdown", "fighting", "roundEnd", "matchEnd", "armed"])
      assert.ok(result.seen.has(label));
    const waiting = new VersusMatch(),
      twin = new VersusMatch();
    twin.beginMatch();
    twin.restore(waiting.checkpoint());
    assert.deepEqual(twin.encode(), waiting.encode());
  },
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
check(
  "restored public RunManager state and captured RNG reproduce actual future offers/rooms/biome descent",
  () => {
    reseed(431231);
    const run = new RunManager();
    run.begin();
    const trace = [],
      points = [];
    for (let i = 0; i < 15; i++) {
      const offers = run.offers();
      const offer = offers[i % offers.length];
      assert.ok(offer);
      const room = run.choose(offer);
      trace.push({ biome: run.biome, depth: run.depth, type: run.type, offers, room: hash(room) });
      points.push({ biome: run.biome, depth: run.depth, type: run.type, rng: checkpointRng() });
    }
    assert.ok(trace.some((row) => row.type === "boss"));
    assert.ok(trace.some((row) => row.biome === 2));
    for (const split of [0, 2, 4, 5, 6, 8, 11]) {
      const cp = wire(points[split]);
      const restored = new RunManager();
      restored.biome = cp.biome;
      restored.depth = cp.depth;
      restored.type = cp.type;
      restoreRng(cp.rng);
      for (let i = split + 1; i < 15; i++) {
        const offers = restored.offers();
        const offer = offers[i % offers.length];
        assert.ok(offer);
        const room = restored.choose(offer);
        assert.deepEqual(
          {
            biome: restored.biome,
            depth: restored.depth,
            type: restored.type,
            offers,
            room: hash(room),
          },
          trace[i],
        );
      }
    }
  },
);
console.log(
  `${groups} checkpoint groups passed; ${splits} restored traces, ${comparedFrames} subsequent frames compared`,
);
