import assert from "node:assert/strict";
import { test } from "node:test";
import type { StickState } from "@vibedgames/gamepad";
import { DirInput, stickDirs } from "../src/input/dir-input";
import { BombPrediction, PREDICTION_TIMEOUT_MS } from "../src/net/bomb-prediction";
import { applyOpened, encodeOpened } from "../src/net/grid-wire";
import { StepTrack, WALK_GRACE_MS } from "../src/net/step-track";
import type { GridTile, StepPose } from "../src/net/step-track";
import { createArena } from "../src/shared/arena";
import {
  BASE_MOVE_MS,
  BOT_MOVE_MS,
  HOST_STEP_MS,
  MIN_MOVE_MS,
  newGrid,
} from "../src/shared/constants";
import type { Cell, Dir, SharedState } from "../src/shared/constants";
import { FixedStep } from "../src/sim/fixed-step";
import { bombId, hostTick, placeBomb } from "../src/sim/host-sim";
import { seededRandom } from "../src/util/seeded-random";

const FRAME_MS = 1000 / 60;
const STRIDE_MS = BASE_MOVE_MS;
const DELAY_MS = 100;
/** Receiver clock minus sender clock: two machines' performance.now() share no epoch. */
const SKEW_MS = 7000;
const EPSILON = 1e-9;

/** Deterministic jitter in [0, 1) so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

/** One-way trips: a walk's ordinary spread, a steadier one, and a tight one for bunching. */
const walkLatency = (i: number): number => 40 + noise(i) * 60;
const steadyLatency = (i: number): number => 40 + noise(i) * 20;
const tightLatency = (i: number): number => 40 + noise(i) * 10;

const open =
  (...dirs: Dir[]) =>
  (dir: Dir): boolean =>
    dirs.includes(dir);

// ---- input -------------------------------------------------------------------

test("direction stack: the newest held key wins, and a blocked one yields to the next held", () => {
  const input = new DirInput();
  input.press("right");
  input.press("up");
  assert.equal(input.choose(open("up", "right", "left")), "up", "newest press first");
  assert.equal(input.choose(open("right", "left")), "right", "up walled: right still held");
  input.press("left");
  input.sync((dir) => dir === "left" || dir === "right");
  assert.equal(input.choose(open("up", "left", "right")), "left", "released up is gone");
  input.sync((dir) => dir === "right");
  assert.equal(input.choose(open("up", "left", "right")), "right");
  input.sync(() => false);
  assert.equal(input.choose(open("up", "left", "right")), null, "nothing held, nothing buffered");
  assert.equal(input.choose(open("down"), ["down"]), "down", "a stick fills in last");
});

test("a turn tapped before a junction survives one step and is taken there", () => {
  const input = new DirInput();
  input.press("right");
  // Up is tapped and released mid-step, a tile before the opening.
  input.press("up");
  input.sync((dir) => dir === "right");
  assert.equal(input.choose(open("right")), "right", "walled: keep walking");
  assert.equal(input.choose(open("up", "right")), "up", "the opening takes the buffered turn");
  assert.equal(input.choose(open("up", "right")), "right", "spent once taken");

  input.press("up");
  input.sync((dir) => dir === "right");
  input.choose(open("right"));
  input.choose(open("right"));
  assert.equal(input.choose(open("up", "right")), "right", "two blocked steps: dropped");

  input.press("up");
  input.sync(() => false);
  assert.equal(input.choose(open("right")), null, "blocked standing still");
  assert.equal(input.choose(open("up")), null, "and not replayed later");
});

const stick = (degrees: number): StickState => ({
  active: true,
  anchorX: 0,
  anchorY: 0,
  angle: (degrees * Math.PI) / 180,
  curX: 0,
  curY: 0,
  distance: 40,
  dx: 0,
  dy: 0,
  inDeadZone: false,
  magnitude: 1,
});

test("a stick pushed towards a diagonal offers the other axis as a fallback", () => {
  assert.deepEqual(stickDirs(stick(5)), ["right"]);
  assert.deepEqual(stickDirs(stick(30)), ["right", "down"]);
  assert.deepEqual(stickDirs(stick(-120)), ["up", "left"]);
  assert.deepEqual(stickDirs({ ...stick(30), inDeadZone: true }), []);
});

// ---- remote step tracks ------------------------------------------------------

interface Packet {
  at: number;
  t: number;
  stride: number;
  to: GridTile;
}

/** A loop around the pillar at (2, 2): a diagonal glide would cut through it. */
const LOOP: GridTile[] = [
  { col: 1, row: 1 },
  { col: 2, row: 1 },
  { col: 3, row: 1 },
  { col: 3, row: 2 },
  { col: 3, row: 3 },
  { col: 2, row: 3 },
  { col: 1, row: 3 },
  { col: 1, row: 2 },
];
const pathTile = (i: number): GridTile => LOOP[i % LOOP.length] ?? { col: 1, row: 1 };

/**
 * A sender walking the loop flat out; `latency(i)` is step i's one-way trip.
 * One socket delivers in order, so a late step holds back the ones behind it.
 */
const walk = (steps: number, latency: (i: number) => number, stride = STRIDE_MS): Packet[] => {
  let previous = Number.NEGATIVE_INFINITY;
  return Array.from({ length: steps }, (_, i) => {
    const t = 1000 + i * stride;
    previous = Math.max(previous, t + SKEW_MS + latency(i));
    return { at: previous, stride, t, to: pathTile(i + 1) };
  });
};

/** Steps i and i+1 land together, as TCP bunches them: i waits for i+1. */
const bunched =
  (latency: (i: number) => number, stride: number) =>
  (i: number): number =>
    i % 5 === 2 ? Math.max(latency(i), latency(i + 1) + stride) : latency(i);

/** Where along the loop a pose sits, in steps from the start (searching forward from `from`). */
const progressOf = (pose: StepPose, from: number, limit: number): number | null => {
  for (let i = Math.floor(from); i < limit; i += 1) {
    const a = pathTile(i);
    const b = pathTile(i + 1);
    const along =
      a.col === b.col ? (pose.y - a.row) / (b.row - a.row) : (pose.x - a.col) / (b.col - a.col);
    const onLine =
      a.col === b.col ? Math.abs(pose.x - a.col) < EPSILON : Math.abs(pose.y - a.row) < EPSILON;
    if (onLine && along >= -EPSILON && along <= 1 + EPSILON) {
      return i + Math.min(1, Math.max(0, along));
    }
  }
  return null;
};

interface Run {
  frames: { at: number; pose: StepPose; progress: number; delivered: number }[];
}

/** Deliver `packets` to a track in arrival order and draw it at 60 fps. */
const play = (packets: readonly Packet[], until: number): Run => {
  const track = new StepTrack({ delayMs: DELAY_MS });
  track.snap(pathTile(0));
  const queue = packets.toSorted((a, b) => a.at - b.at);
  const frames: Run["frames"] = [];
  let delivered = 0;
  let progress = 0;
  for (let now = SKEW_MS + 1000; now <= until; now += FRAME_MS) {
    while ((queue[0]?.at ?? Number.POSITIVE_INFINITY) <= now) {
      const packet = queue.shift();
      if (packet) {
        track.clock.observe(packet.t, packet.at);
        track.step(packet.to, packet.t, packet.stride);
        delivered += 1;
      }
    }
    const pose = track.sample(now);
    assert.ok(pose);
    const at = progressOf(pose, progress, delivered + 1);
    assert.ok(at !== null, `off the path at ${pose.x},${pose.y} (progress ${progress})`);
    progress = at;
    frames.push({ at: now, delivered, pose, progress });
  }
  return { frames };
};

/** Every frame of a walk: on the path, never past the newest tile, never backwards. */
const assertWalk = (frames: Run["frames"]): void => {
  let last = 0;
  for (const { pose, progress, delivered } of frames) {
    assert.ok(progress <= delivered + EPSILON, `overshot: ${progress} of ${delivered} received`);
    assert.ok(progress >= last - EPSILON, "never backwards");
    const inside = Math.abs(pose.x - 2) < 0.5 && Math.abs(pose.y - 2) < 0.5;
    assert.ok(!inside, "never inside the pillar");
    last = progress;
  }
};

test("step track: no stalls while jitter stays inside the delay, bunched steps included", () => {
  const steps = 24;
  for (const stride of [STRIDE_MS, MIN_MOVE_MS]) {
    // 40–100 ms one-way at a walk. At the fastest stride every fifth step
    // also waits for the next and both land in one frame, still inside the
    // delay; the old once-a-frame read turned such a pair into one diagonal
    // slide.
    const latency = stride === MIN_MOVE_MS ? bunched(tightLatency, stride) : walkLatency;
    const end = 1000 + steps * stride;
    const { frames } = play(walk(steps, latency, stride), SKEW_MS + end + 600);
    assertWalk(frames);
    let walking = 0;
    for (const [i, frame] of frames.entries()) {
      if (frame.progress > 0 && frame.progress < steps) {
        // On the sender's cadence: about one frame's share of a stride, every frame.
        const gained = frame.progress - (frames[i - 1]?.progress ?? 0);
        assert.ok(gained > 0, `stride ${stride}: stalled at ${frame.progress}`);
        assert.ok(gained < (FRAME_MS / stride) * 1.2, `stride ${stride}: surged ${gained}`);
        assert.ok(frame.pose.moving, "the walk cycle runs between tiles");
        walking += 1;
      }
    }
    assert.ok(walking > ((steps * stride) / FRAME_MS) * 0.9, `walked ${walking} frames`);
    const finished = frames.find((frame) => frame.progress >= steps - EPSILON);
    assert.ok(finished);
    // Drawn the delay plus the fastest trip behind the sender's own screen.
    const behind = finished.at - SKEW_MS - end;
    assert.ok(behind >= DELAY_MS && behind <= DELAY_MS + 60, `trails by ${behind} ms`);
    assert.equal(frames.at(-1)?.pose.moving, false, "the walk cycle stops with the steps");
  }
});

test("steps bunched a whole stride late still walk the corner in order, without a jump", () => {
  const steps = 24;
  const until = SKEW_MS + 1000 + steps * STRIDE_MS + 800;
  const { frames } = play(walk(steps, bunched(walkLatency, STRIDE_MS)), until);
  assertWalk(frames);
  for (const [i, frame] of frames.entries()) {
    const gained = frame.progress - (frames[i - 1]?.progress ?? 0);
    assert.ok(gained < (FRAME_MS / STRIDE_MS) * 1.6, `jumped ${gained} at frame ${i}`);
  }
  assert.equal(frames.at(-1)?.progress, steps);
});

test("a step that arrives late is walked from where the body waited, then caught up", () => {
  const steps = 12;
  // Step 5 is held up 400 ms: far past the delay, so the body runs dry and waits.
  const late = (i: number): number => (i === 5 ? 440 : steadyLatency(i));
  const until = SKEW_MS + 1000 + steps * STRIDE_MS + 800;
  const smooth = play(walk(steps, steadyLatency), until).frames;
  const stalled = play(walk(steps, late), until).frames;
  let waited = 0;
  for (const [i, frame] of stalled.entries()) {
    const gained = frame.progress - (stalled[i - 1]?.progress ?? 0);
    // Catching up runs at most half again as fast: never a jump.
    assert.ok(gained < (FRAME_MS / STRIDE_MS) * 1.6, `jumped ${gained} at frame ${i}`);
    if (frame.progress > 0 && gained === 0 && frame.progress < steps) {
      waited += 1;
      assert.equal(frame.progress % 1, 0, "it waits on a tile, not between two");
    }
  }
  assert.ok(waited > 5, `held while the step was missing (${waited} frames)`);
  const caughtUp = stalled.findIndex(
    (frame, i) => i > 0 && Math.abs(frame.progress - (smooth[i]?.progress ?? 0)) < EPSILON,
  );
  assert.ok(caughtUp > 0);
  assert.ok(stalled.at(-1)?.progress === steps, "and finishes where it should");
});

test("a teleport snaps, a respawn snaps, and a resting body stops walking", () => {
  const track = new StepTrack({ delayMs: 0 });
  track.snap({ col: 1, row: 1 });
  track.clock.observe(0, 0);
  track.step({ col: 2, row: 1 }, 0, STRIDE_MS);
  assert.equal(track.sample(STRIDE_MS / 2)?.x, 1.5);
  track.step({ col: 9, row: 9 }, STRIDE_MS, STRIDE_MS);
  assert.deepEqual(track.latest, { col: 9, row: 9 });
  const snapped = track.sample(STRIDE_MS);
  assert.equal(snapped?.x, 9, "non-adjacent: placed, not walked");
  assert.equal(snapped?.moving, false);
  track.step({ col: 9, row: 10 }, 400, 0);
  assert.equal(track.sample(401)?.y, 10, "a zero-length step is a spawn");
  track.step({ col: 10, row: 10 }, 500, STRIDE_MS);
  assert.equal(track.sample(500 + STRIDE_MS + WALK_GRACE_MS / 2)?.moving, true, "between steps");
  assert.equal(track.sample(500 + STRIDE_MS + WALK_GRACE_MS + 1)?.moving, false, "at rest");
});

test("bots on the fixed host step stride exactly BOT_MOVE_MS, drawn on time by the host", () => {
  const humans = ["a", "b", "c"].map((id) => ({ id, pos: null }));
  const empty = newGrid().map((cells) => cells.map((): Cell => ({ kind: "empty" })));
  const grid = newGrid().map((cells, row) =>
    cells.map((cell, col) => (cell.kind === "crate" ? (empty[row]?.[col] ?? cell) : cell)),
  );
  let s: SharedState = {
    blasts: {},
    bombs: {},
    bots: {},
    deaths: {},
    grid,
    powerups: {},
    startedAt: 1,
    stats: {},
    winner: null,
  };
  const step = new FixedStep(HOST_STEP_MS, 250);
  const track = new StepTrack({ delayMs: 0 });
  const moves: number[] = [];
  let at: GridTile | null = null;
  // A 144 Hz display: steps still land every 50 ms of sim time.
  for (let frame = 0; frame < 144 * 4; frame += 1) {
    const now = 10_000 + Math.floor((frame * 1000) / 144);
    for (const tick of step.due(now)) {
      const { patch } = hostTick(s, humans, tick, () => 0);
      s = patch ? { ...s, ...patch } : s;
      const bot = s.bots["bot-3"];
      if (bot && (at?.col !== bot.col || at.row !== bot.row)) {
        if (at) {
          moves.push(tick);
        }
        track.clock.observe(tick, tick);
        track.step(bot, bot.nextMoveAt - BOT_MOVE_MS, BOT_MOVE_MS);
        at = { col: bot.col, row: bot.row };
      }
    }
    const pose = track.sample(now);
    const bot = s.bots["bot-3"];
    if (pose && bot && moves.length > 0) {
      const into = (now - (bot.nextMoveAt - BOT_MOVE_MS)) / BOT_MOVE_MS;
      const expected = Math.min(1, into);
      const done = Math.abs(pose.x - bot.col) + Math.abs(pose.y - bot.row);
      assert.ok(Math.abs(1 - done - expected) < 1e-6, "the host draws its bot exactly mid-stride");
    }
  }
  assert.ok(moves.length > 10, `bot moved ${moves.length} times`);
  for (let i = 1; i < moves.length; i += 1) {
    assert.equal((moves[i] ?? 0) - (moves[i - 1] ?? 0), BOT_MOVE_MS);
  }
});

// ---- the host step -----------------------------------------------------------

test("fixed host step: an exact 50 ms grid at any frame rate, a bounded catch-up after a stall", () => {
  for (const fps of [30, 60, 75, 144]) {
    const step = new FixedStep(HOST_STEP_MS, 250);
    const ticks: number[] = [];
    for (let t = 0; t <= 2000; t += 1000 / fps) {
      ticks.push(...step.due(10_000 + Math.floor(t)));
    }
    assert.ok(Math.abs(ticks.length - 41) <= 1, `${fps} fps ran ${ticks.length} steps`);
    for (let i = 1; i < ticks.length; i += 1) {
      assert.equal((ticks[i] ?? 0) - (ticks[i - 1] ?? 0), HOST_STEP_MS, `${fps} fps`);
    }
  }
  const step = new FixedStep(HOST_STEP_MS, 250);
  assert.deepEqual(step.due(0), [0], "the first call steps at once");
  assert.equal(step.due(3000).length, 5, "a 3 s stall replays 250 ms, not 3 s");
  assert.deepEqual(step.due(3010), [], "and the grid holds");
  step.reset();
  assert.deepEqual(step.due(5000), [5000]);
});

// ---- bombs ------------------------------------------------------------------

const openWorld = (patch: Partial<SharedState> = {}): SharedState => ({
  blasts: {},
  bombs: {},
  bots: {},
  deaths: {},
  grid: newGrid().map((cells) =>
    cells.map((cell): Cell => (cell.kind === "crate" ? { kind: "empty" } : cell)),
  ),
  powerups: {},
  startedAt: 1,
  stats: {},
  winner: null,
  ...patch,
});

test("a guest's bomb shows on the press under the id the host gives it, and is adopted silently", () => {
  const state = openWorld();
  const prediction = new BombPrediction();
  const view = (): SharedState => ({ ...state, bombs: prediction.visible(state.bombs) });
  const ghost = placeBomb(view(), "g", 1, 1, 1000, 7)?.[bombId("g", 7)];
  assert.ok(ghost, "the guest runs the host's rule on its own view");
  prediction.add(ghost, 0);
  assert.equal(
    placeBomb(view(), "g", 2, 1, 1010, 8),
    null,
    "its stock counts the unconfirmed bomb",
  );
  assert.equal(placeBomb(view(), "h", 1, 1, 1010), null, "and the tile is solid");
  // A round trip later the host places the same press under the same id.
  const hosted = placeBomb(state, "g", 1, 1, 1120, 7);
  assert.ok(hosted);
  assert.deepEqual(Object.keys(hosted), [ghost.id], "one bomb, one id: the sprite carries over");
  assert.equal(prediction.visible(hosted)[ghost.id]?.placedAt, 1120, "the host's copy wins");
  assert.equal(prediction.settle(hosted, 140), false, "adopted, not refused");
  assert.deepEqual(prediction.visible({}), {}, "and retired");
  // A replayed press never overwrites the bomb it placed.
  const stocked = openWorld({ bombs: hosted, stats: { g: { bombs: 3, range: 2, speed: 175 } } });
  assert.equal(placeBomb(stocked, "g", 3, 1, 1300, 7), null);
  // Scoring and the bot soak read a blast's owner off the id prefix.
  assert.ok(`x-${bombId("g", 7)}`.startsWith("x-b-g-"));
});

test("a prediction the host refuses comes off the board after the timeout", () => {
  const prediction = new BombPrediction();
  const ghost = placeBomb(openWorld(), "g", 1, 1, 1000, 1)?.[bombId("g", 1)];
  assert.ok(ghost);
  prediction.add(ghost, 0);
  assert.equal(prediction.settle({}, PREDICTION_TIMEOUT_MS - 1), false);
  assert.ok(prediction.visible({})[ghost.id], "still waiting on the host");
  assert.equal(prediction.settle({}, PREDICTION_TIMEOUT_MS), true, "refused");
  assert.deepEqual(prediction.visible({}), {});
  // On a route whose confirmations take 450 ms, a prediction gets twice that.
  const slow = placeBomb(openWorld(), "g", 1, 1, 2000, 2)?.[bombId("g", 2)];
  assert.ok(slow);
  prediction.add(slow, 1000);
  assert.equal(prediction.settle({ [slow.id]: slow }, 1450), false);
  assert.equal(prediction.timeoutMs, 900);
  prediction.add({ ...slow, id: bombId("g", 3) }, 2000);
  assert.equal(prediction.settle({}, 2000 + PREDICTION_TIMEOUT_MS), false, "still in time");
  assert.equal(prediction.settle({}, 2900), true);
});

// ---- wire -------------------------------------------------------------------

test("grid wire: each opened crate rides as two characters and decodes to the same board", () => {
  const base = createArena("classic", seededRandom(3));
  const current = base.map((cells) => [...cells]);
  let opened = 0;
  for (const [row, cells] of current.entries()) {
    for (const [col, cell] of cells.entries()) {
      if (cell.kind === "crate" && (row + col) % 3 === 0) {
        cells[col] = { kind: "empty" };
        opened += 1;
      }
    }
  }
  const wire = encodeOpened(base, current);
  assert.ok(opened > 10);
  assert.equal(wire.length, opened * 2);
  assert.deepEqual(applyOpened(base, wire), current);
  assert.equal(applyOpened(base, ""), base, "nothing opened: the round's own layout");
  assert.ok(JSON.stringify(base).length > 4000, "what every crate break used to resend");
  assert.deepEqual(applyOpened(base, `${wire}zz!`), current, "junk codes open nothing");
});
