import assert from "node:assert/strict";
import { test } from "node:test";
import { netStats, RemoteClock } from "@vibedgames/multiplayer";
import type { NetStats, SenderClock } from "@vibedgames/multiplayer";
import { TURN_DELAY_MS, TurnTrack } from "../src/net/bot-track";
import { STEP_DELAY_MS, StepTrack, WALK_GRACE_MS } from "../src/net/step-track";
import type { GridTile, StepPose } from "../src/net/step-track";
import { BotStride } from "../src/render/bot-stride";
import {
  BASE_MOVE_MS,
  BOT_MOVE_MS,
  HOST_STEP_MS,
  MIN_MOVE_MS,
  newGrid,
  PLAYER_BEAT_HZ,
} from "../src/shared/constants";
import type { Cell, SharedState } from "../src/shared/constants";
import { FixedStep } from "../src/sim/fixed-step";
import { hostTick } from "../src/sim/host-sim";

const FRAME_MS = 1000 / 60;
const STRIDE_MS = BASE_MOVE_MS;
const BEAT_MS = 1000 / PLAYER_BEAT_HZ;
/** The quickest trip from sender to receiver. */
const ROUTE_MS = 40;
/** Receiver's local clock minus the room's: performance.now() and server time share no epoch. */
const SKEW_MS = 7000;
const EPSILON = 1e-9;

/** Deterministic jitter in [0, 1) so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

/** A message's trip here, by its place `k` in the stream (and its step number, if a step). */
type Latency = (k: number, step: number | null) => number;
/** A walk's ordinary spread, and a tight one for bunching. */
const walkLatency: Latency = (k) => ROUTE_MS + noise(k) * 60;
const tightLatency: Latency = (k) => ROUTE_MS + noise(k) * 10;

/** Every fifth step is held until the next goes out, as TCP bunches them. */
const bunched =
  (latency: Latency, stride: number): Latency =>
  (k, step) =>
    step !== null && step % 5 === 2 ? latency(k, step) + stride : latency(k, step);

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

/** One message from a player: a step, or a heartbeat; it lands here at `at`. */
interface Packet {
  at: number;
  t: number;
  step?: { index: number; stride: number; to: GridTile };
}

/** When the walks in these tests set off, on the room's clock. */
const START = 1000;

/** A player's messages, and when its last step ends. */
interface Walk {
  packets: Packet[];
  end: number;
}

/**
 * A player that spawns on the loop, beats from then on, and walks `steps`
 * round it flat out from START (one step `pauses(i)` ms after the last,
 * when given). One socket delivers in order, so a late message holds back
 * the ones behind it.
 */
const walk = (
  steps: number,
  latency: Latency,
  { stride = STRIDE_MS, warmup = 1000, pauses = (_i: number) => 0 } = {},
): Walk => {
  const sends: Omit<Packet, "at">[] = [
    { step: { index: -1, stride: 0, to: pathTile(0) }, t: START - warmup },
  ];
  let t = START;
  for (let i = 0; i < steps; i += 1) {
    t += pauses(i);
    sends.push({ step: { index: i, stride, to: pathTile(i + 1) }, t });
    t += stride;
  }
  const end = t;
  for (let beat = START - warmup; beat <= end + 1000; beat += BEAT_MS) {
    sends.push({ t: Math.round(beat) });
  }
  // A step and a beat in one frame leave together, step first.
  sends.sort((a, b) => a.t - b.t || (a.step ? -1 : 1));
  let previous = Number.NEGATIVE_INFINITY;
  const packets = sends.map((send, k) => {
    previous = Math.max(previous, send.t + SKEW_MS + latency(k, send.step?.index ?? null));
    return { ...send, at: previous };
  });
  return { end, packets };
};

/** Where along the loop a pose sits, in steps from the start (searching forward from `from`). */
const progressOf = (pose: StepPose, from: number, limit: number): number | null => {
  for (let i = Math.max(0, Math.floor(from)); i < limit; i += 1) {
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

interface Frame {
  at: number;
  pose: StepPose;
  /** Steps along the loop the body is drawn at. */
  progress: number;
  /** Steps of the loop received so far. */
  delivered: number;
}

/** Deliver `packets` to a fresh track in arrival order and draw it at 60 fps from START on. */
const play = (packets: readonly Packet[], until: number): Frame[] => {
  const track = new StepTrack();
  const queue = packets.toSorted((a, b) => a.at - b.at);
  const frames: Frame[] = [];
  let delivered = 0;
  let progress = 0;
  for (let now = queue[0]?.at ?? 0; now <= until; now += FRAME_MS) {
    while ((queue[0]?.at ?? Number.POSITIVE_INFINITY) <= now) {
      const packet = queue.shift();
      if (packet?.step) {
        track.step(packet.step.to, packet.t, packet.step.stride, packet.at);
        delivered = packet.step.index + 1;
      } else if (packet) {
        track.beat(packet.t, packet.at);
      }
    }
    const pose = track.sample(now);
    if (now < SKEW_MS + START) {
      continue;
    }
    assert.ok(pose);
    const at = progressOf(pose, progress, delivered + 1);
    assert.ok(at !== null, `off the path at ${pose.x},${pose.y} (progress ${progress})`);
    progress = at;
    frames.push({ at: now, delivered, pose, progress });
  }
  return frames;
};

/** Every frame of a walk: on the path, never past the newest tile, never backwards. */
const assertWalk = (frames: readonly Frame[]): void => {
  let last = 0;
  for (const { pose, progress, delivered } of frames) {
    assert.ok(progress <= delivered + EPSILON, `overshot: ${progress} of ${delivered} received`);
    assert.ok(progress >= last - EPSILON, "never backwards");
    const inside = Math.abs(pose.x - 2) < 0.5 && Math.abs(pose.y - 2) < 0.5;
    assert.ok(!inside, "never inside the pillar");
    last = progress;
  }
};

/** Frames drawn while the body walked, as a share of a stride gained each frame. */
const gains = (frames: readonly Frame[], steps: number): number[] =>
  frames
    .map((frame, i) => ({ frame, gained: frame.progress - (frames[i - 1]?.progress ?? 0) }))
    .filter(({ frame }, i) => i > 0 && frame.progress > 0 && frame.progress < steps)
    .map(({ gained }) => gained);

/**
 * How far playback may run off the sender's speed: the clock's offset and its
 * measured hold each slew at most 10% of elapsed time, so changes bend the
 * walk a little rather than jump it.
 */
const SLEW_BEND = 0.2;

/**
 * Walking frames drawn off the sender's speed, past the slew's bend. A frame
 * a walk starts or stops in (a rest beside it) covers part of a stride, so it
 * is left out.
 */
const offCadence = (list: readonly number[], nominal: number): number[] =>
  list.filter((gained, i) => {
    const boundary = !(list[i - 1] ?? 0) || !(list[i + 1] ?? 0);
    return gained > 0 && !boundary && Math.abs(gained - nominal) > nominal * SLEW_BEND + EPSILON;
  });

/** What share of the Interpolator frames `run` draws are past the newest sample. */
const starvedDuring = (run: () => void): number => {
  const before = netStats();
  run();
  const after = netStats();
  return (after.starved - before.starved) / Math.max(1, after.frames - before.frames);
};

// ---- players ------------------------------------------------------------------

test("a player's walk is drawn on its own cadence, corners in order, a short delay behind", () => {
  const steps = 24;
  for (const stride of [STRIDE_MS, MIN_MOVE_MS]) {
    // 40–100 ms here at a walk: 60 ms of jitter over the fastest trip. At the
    // fastest stride every fifth step also waits for the next and both land
    // together; the delay grows to cover that.
    const latency = stride === MIN_MOVE_MS ? bunched(tightLatency, stride) : walkLatency;
    const { end, packets } = walk(steps, latency, { stride, warmup: 3000 });
    const frames = play(packets, SKEW_MS + end + 800);
    assertWalk(frames);
    const nominal = FRAME_MS / stride;
    for (const gained of gains(frames, steps)) {
      assert.ok(gained > 0, `stride ${stride}: stalled`);
      assert.ok(gained < nominal * 1.2, `stride ${stride}: surged ${gained}`);
    }
    const walking = frames.filter((frame) => frame.progress > 0 && frame.progress < steps);
    assert.ok(
      walking.every((frame) => frame.pose.moving),
      "the walk cycle runs between tiles",
    );
    assert.ok(walking.length > ((steps * stride) / FRAME_MS) * 0.9, `walked ${walking.length}`);
    const finished = frames.find((frame) => frame.progress >= steps - EPSILON);
    assert.ok(finished);
    // Drawn the fastest trip plus the delay behind the sender: the least delay,
    // or as much as a beat and the trips' spread take, whichever is more.
    const behind = finished.at - SKEW_MS - end;
    assert.ok(behind >= ROUTE_MS + STEP_DELAY_MS - FRAME_MS, `trails by ${behind} ms`);
    assert.ok(behind <= ROUTE_MS + BEAT_MS + 60 + stride + FRAME_MS, `trails by ${behind} ms`);
    assert.equal(frames.at(-1)?.pose.moving, false, "the walk cycle stops with the steps");
  }
});

test("a pause between steps is drawn as a pause, and the next step at full speed", () => {
  const steps = 16;
  // A stride's rest after every fourth step, and a long one after the ninth.
  const pauses = (i: number): number => {
    if (i === 9) {
      return 600;
    }
    return i % 4 === 0 ? STRIDE_MS : 0;
  };
  const { end, packets } = walk(steps, walkLatency, { pauses, warmup: 3000 });
  const frames = play(packets, SKEW_MS + end + 800);
  assertWalk(frames);
  // Each frame either stands or walks at the sender's speed: never a glide.
  const glides = offCadence(gains(frames, steps), FRAME_MS / STRIDE_MS);
  assert.deepEqual(glides, [], "a rest is never drawn as a slow walk");
  const rests = frames.filter((frame, i) => {
    const gained = frame.progress - (frames[i - 1]?.progress ?? 0);
    return i > 0 && gained === 0 && frame.progress > 0 && frame.progress < steps;
  });
  assert.ok(rests.length > 0, "the pauses were drawn");
  assert.ok(
    rests.every((frame) => frame.progress % 1 === 0),
    "a body rests on a tile, never between two",
  );
});

/** Step 5 is held up 400 ms, and everything behind it on the socket. */
const lateFifth: Latency = (k, step) => (step === 5 ? ROUTE_MS + 400 : walkLatency(k, step));

test("a step that lands past the delay holds the body on its tile, then the walk goes on", () => {
  const steps = 16;
  // Far past the delay: the body runs out of steps.
  const { end, packets } = walk(steps, lateFifth, { warmup: 3000 });
  const frames = play(packets, SKEW_MS + end + 2000);
  assertWalk(frames);
  const nominal = FRAME_MS / STRIDE_MS;
  const list = gains(frames, steps);
  let waited = 0;
  for (const [i, frame] of frames.entries()) {
    const gained = frame.progress - (frames[i - 1]?.progress ?? 0);
    if (i > 0 && frame.progress > 0 && frame.progress < steps && gained === 0) {
      waited += 1;
      assert.equal(frame.progress % 1, 0, "it waits on a tile, not between two");
    }
  }
  assert.ok(waited > 5, `held while the step was missing (${waited} frames)`);
  // The SDK draws the sender's timeline: the late step lands, and the body
  // moves to where the sender is by then, in one move. The delay then grows
  // to cover a route that runs this late, so the rest is walked on cadence.
  const moves = list.filter((gained) => gained > nominal * (1 + SLEW_BEND) + EPSILON);
  assert.equal(moves.length, 1, `back on the sender's timeline in one move: ${moves.join(", ")}`);
  const after = list.slice(list.indexOf(moves[0] ?? 0) + 1);
  assert.deepEqual(offCadence(after, nominal), [], "and on cadence from there");
  assert.equal(frames.at(-1)?.progress, steps, "and finishes where it should");
});

/** One hop to or from the server, as on the dev server that simulates latency: 50 ± 25 ms. */
const hop = (k: number): number => 25 + noise(k) * 50;

/** How a client reads the room clock: its fastest of eight probes sets the round trip, and that trip's asymmetry is its error. */
const probed = (seed: number): number => {
  let best = { error: 0, rtt: Number.POSITIVE_INFINITY };
  for (let probe = 0; probe < 8; probe += 1) {
    const up = hop(seed + probe * 2);
    const down = hop(seed + probe * 2 + 1);
    if (up + down < best.rtt) {
      best = { error: (down - up) / 2, rtt: up + down };
    }
  }
  return best.error;
};

test("each player is drawn on its own clock of them, which learns their relay", () => {
  const steps = 60;
  for (const error of [probed(1000), probed(7000)]) {
    // Each message goes up to the server and down to us: 50–150 ms, and the
    // sender reads the room's clock with its own error.
    const { end, packets } = walk(steps, (k) => hop(10_000 + k * 2) + hop(10_001 + k * 2), {
      warmup: 3000,
    });
    const shifted = packets.map((packet) => ({ ...packet, t: Math.round(packet.t + error) }));
    let frames: Frame[] = [];
    const starved = starvedDuring(() => {
      frames = play(shifted, SKEW_MS + end + 800);
    });
    assertWalk(frames);
    // The hold covers 95% of what a route does: a rarer late message runs the
    // body past its newest sample for a frame or two, which counts as a stall.
    assert.ok(starved < 0.02, `drawn past the newest sample: ${starved}`);
    const off = offCadence(gains(frames, steps), FRAME_MS / STRIDE_MS);
    assert.deepEqual(off, [], "the walk keeps the sender's cadence, bent only by the slew");
  }
});

/** Three seconds of a body standing on one tile, drawn at 60 fps; its beats, if any, land 40–70 ms late. */
const standStill = (beats: boolean): number =>
  starvedDuring(() => {
    const track = new StepTrack();
    track.step({ col: 1, row: 1 }, 0, 0, SKEW_MS + ROUTE_MS);
    for (let now = SKEW_MS; now < SKEW_MS + 3000; now += FRAME_MS) {
      const beat = Math.floor((now - SKEW_MS) / BEAT_MS) * BEAT_MS;
      if (beats) {
        track.beat(beat - ROUTE_MS - noise(beat) * 30, now);
      }
      track.sample(now);
    }
  });

test("a body at rest stays drawn on fresh beats; without them every frame runs past the newest", () => {
  const fed = standStill(true);
  const starved = standStill(false);
  assert.ok(fed < 0.02, `with beats, starved ${fed}`);
  assert.ok(starved > 0.9, `without, starved ${starved}`);
});

test("a teleport places, a respawn places, and a resting body stops walking", () => {
  // Every message lands the moment it is stamped, so render time is the
  // least delay behind it until the clock has measured a hold.
  const track = new StepTrack();
  const at = (stamp: number): StepPose | undefined => track.sample(stamp + STEP_DELAY_MS);
  track.step({ col: 1, row: 1 }, 0, 0, 0);
  track.step({ col: 2, row: 1 }, 10, STRIDE_MS, 10);
  assert.equal(at(10 + STRIDE_MS / 2)?.x, 1.5);
  track.step({ col: 9, row: 9 }, 10 + STRIDE_MS, STRIDE_MS, 10 + STRIDE_MS);
  assert.deepEqual(track.latest, { col: 9, row: 9 });
  const placed = at(10 + STRIDE_MS);
  assert.equal(placed?.x, 9, "not a neighbour: placed, not walked");
  assert.equal(placed?.moving, false);
  track.step({ col: 9, row: 10 }, 400, 0, 400);
  assert.equal(at(401)?.y, 10, "a zero-length step is a spawn");
  track.step({ col: 10, row: 10 }, 500, STRIDE_MS, 500);
  track.beat(500 + STRIDE_MS + WALK_GRACE_MS * 2, 500 + STRIDE_MS + WALK_GRACE_MS * 2);
  assert.equal(at(500 + STRIDE_MS + WALK_GRACE_MS / 2)?.moving, true, "between steps");
  assert.equal(at(500 + STRIDE_MS + WALK_GRACE_MS + 1)?.moving, false, "at rest");
});

// ---- bots ---------------------------------------------------------------------

/** A clock that reads `now` as given: the host's sim clock, in a test that runs it. */
const roomClock = (skew = 0): SenderClock => ({
  now: (localNow = 0) => localNow - skew,
  synced: true,
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
  const stride = new BotStride(roomClock());
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
        stride.turn(bot, bot.nextMoveAt - BOT_MOVE_MS, bot.dir);
        at = { col: bot.col, row: bot.row };
      }
    }
    const pose = stride.sample(now);
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

interface Turn {
  at: number;
  tau: number;
  tile: GridTile;
  bot: string;
}

/**
 * Bots turning every BOT_MOVE_MS round the loop, each `phase` ms into the
 * stride (one that joined mid-round turns out of step), holding every fourth
 * turn; every turn rides the host's one socket here, in order.
 */
const turns = (phases: Record<string, number>, count: number, latency: Latency): Turn[] => {
  const sends: Omit<Turn, "at">[] = [];
  for (const [bot, phase] of Object.entries(phases)) {
    let tile = 0;
    for (let k = 0; k < count; k += 1) {
      tile += k % 4 === 3 ? 0 : 1;
      sends.push({ bot, tau: START + phase + k * BOT_MOVE_MS, tile: pathTile(tile) });
    }
  }
  sends.sort((a, b) => a.tau - b.tau);
  let previous = Number.NEGATIVE_INFINITY;
  return sends.map((send, k) => {
    previous = Math.max(previous, send.tau + SKEW_MS + latency(k, null));
    return { ...send, at: previous };
  });
};

/**
 * One bot as a guest drew it, and what share of every bot's frames ran past
 * the newest turn once the clocks had settled.
 */
interface BotRun {
  frames: { at: number; pose: StepPose }[];
  starved: number;
}

/**
 * How long a bot's clock takes to learn a route: eight turns before it
 * measures a hold, which then eases in from nothing at the slew. Until then
 * the least delay alone stands in.
 */
const SETTLE_MS = 5000;

/** Draw `bot` from its turns at 60 fps; `clockOf` gives each bot its clock. */
const drawBots = (
  list: readonly Turn[],
  bot: string,
  clockOf: (bot: string) => RemoteClock,
): BotRun => {
  const frames: BotRun["frames"] = [];
  const tracks = new Map<string, TurnTrack>();
  const queue = list.toSorted((a, b) => a.at - b.at);
  const settled = (queue[0]?.at ?? 0) + SETTLE_MS;
  let before: NetStats | null = null;
  for (let now = queue[0]?.at ?? 0; now <= (queue.at(-1)?.at ?? 0) + 500; now += FRAME_MS) {
    if (!before && now >= settled) {
      before = netStats();
    }
    while ((queue[0]?.at ?? Number.POSITIVE_INFINITY) <= now) {
      const turn = queue.shift();
      if (turn) {
        const track = tracks.get(turn.bot) ?? new TurnTrack(clockOf(turn.bot));
        tracks.set(turn.bot, track);
        track.turn(turn.tile, turn.tau, "down", turn.at);
      }
    }
    for (const [id, track] of tracks) {
      const pose = track.sample(now);
      if (pose && id === bot) {
        frames.push({ at: now, pose });
      }
    }
  }
  const after = netStats();
  const from = before ?? after;
  return {
    frames,
    starved: (after.starved - from.starved) / Math.max(1, after.frames - from.frames),
  };
};

test("a guest draws a bot's turns a stride behind: every stride even, corners in order", () => {
  const list = turns({ "bot-1": 0 }, 60, walkLatency);
  const { frames, starved } = drawBots(list, "bot-1", () => new RemoteClock());
  let progress = 0;
  const learnt: number[] = [];
  for (const { at: now, pose } of frames) {
    const at = progressOf(pose, progress, 64);
    assert.ok(at !== null, `off the path at ${pose.x},${pose.y}`);
    assert.ok(Math.abs(pose.x - 2) >= 0.5 || Math.abs(pose.y - 2) >= 0.5, "never in the pillar");
    assert.ok(at >= progress - EPSILON, "never backwards");
    // Past the first strides, while the clock learns the route.
    if (now > (frames[0]?.at ?? 0) + 2000) {
      learnt.push(at - progress);
    }
    progress = at;
  }
  assert.ok(learnt.filter((gained) => gained > 0).length > 300, "walked");
  assert.deepEqual(offCadence(learnt, FRAME_MS / BOT_MOVE_MS), [], "every stride drawn evenly");
  assert.ok(starved < 0.05, `starved ${starved}`);
});

/** A route that scatters messages over 100 ms. */
const wideLatency: Latency = (k) => ROUTE_MS + noise(k + 77) * 100;

test("each bot learns its own clock: one turning out of step with the rest stays fed", () => {
  // Two bots a half stride apart.
  const list = turns({ "bot-1": 0, "bot-2": BOT_MOVE_MS / 2 }, 60, wideLatency);
  const own = new Map<string, RemoteClock>();
  const each = drawBots(list, "bot-2", (bot) => {
    const clock = own.get(bot) ?? new RemoteClock();
    own.set(bot, clock);
    return clock;
  });
  const shared = new RemoteClock();
  const one = drawBots(list, "bot-2", () => shared);
  // One clock sees both bots' turns: half-stride gaps, so it measures half the
  // hold each bot's own stride needs, and the floor alone stands in.
  assert.ok(each.starved < 0.05, `own clocks starved ${each.starved}`);
  assert.ok(one.starved > each.starved * 3, `one shared clock starved ${one.starved}`);
  assert.ok(TURN_DELAY_MS < BOT_MOVE_MS + 100, "the floor alone can't cover this route");
});
