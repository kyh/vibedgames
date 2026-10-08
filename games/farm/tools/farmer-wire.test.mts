import assert from "node:assert/strict";
import { test } from "node:test";
import { Interpolator } from "@vibedgames/multiplayer";
import { WALK_SPEED } from "../src/config";
import type { JsonObject, JsonValue } from "../src/json";
import { FarmerSender, blendFarmer, readFarmer } from "../src/net/farmer-wire";
import type { FarmerBody, FarmerSample } from "../src/net/farmer-wire";

/** Deterministic jitter in [0, 1), so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

const isPrimitive = (v: JsonValue | undefined): boolean => !(v instanceof Object);

/** The keys of `patch` the SDK would put on the wire: changed primitives,
 *  and any object or array whole. */
const delta = (prev: JsonObject, patch: JsonObject): JsonObject => {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(isPrimitive(value) && Object.is(prev[key], value))) {
      out[key] = value;
    }
  }
  return out;
};

const body = (x: number, clip: string): FarmerBody => ({
  anims: {
    accumulator: 20,
    currentAnim: { key: `p-${clip}` },
    currentFrame: { index: 3 },
    isPlaying: true,
  },
  flipX: false,
  x,
  y: 200,
});

const FRAME_MS = 1000 / 60;
const STEP = WALK_SPEED / 60;

interface Sent {
  at: number;
  state: JsonObject;
}

/** A 60 fps sender that walks on the frames `walking` picks; returns each
 *  update's merged player state (as peers hold it) and where it ended up. */
const walkRoute = (frames: number, walking: (frame: number) => boolean) => {
  const sender = new FarmerSender();
  const sent: Sent[] = [];
  const mine: JsonObject = {};
  let x = 100;
  let revision = 0;
  let clip = "";
  for (let frame = 0; frame < frames; frame += 1) {
    const moving = walking(frame);
    if (moving) {
      x += STEP;
    }
    const want = moving ? "walk" : "idle";
    if (want !== clip) {
      clip = want;
      revision += 1;
    }
    const patch = sender.tick(body(x, clip), moving, revision, frame * FRAME_MS);
    if (patch) {
      Object.assign(mine, delta(mine, patch));
      sent.push({ at: frame * FRAME_MS, state: { ...mine } });
    }
  }
  return { sent, x };
};

/** Deliver `sent` 60–105 ms late, in order (one TCP stream), to a receiver
 *  whose clock runs `skew` ms ahead; returns what it draws each 60 fps frame. */
const playBack = (sent: Sent[], skew: number, ms: number) => {
  let lastArrival = 0;
  const arrivals = sent.map(({ at, state }, i) => {
    lastArrival = Math.max(lastArrival, at + skew + 60 + noise(i) * 45);
    return { arrival: lastArrival, state };
  });
  const track = new Interpolator<FarmerSample>({ lerp: blendFarmer });
  const shown: FarmerSample[] = [];
  let next = 0;
  for (let local = skew; local < skew + ms; local += FRAME_MS) {
    for (let a = arrivals[next]; a && a.arrival <= local; a = arrivals[next]) {
      const read = readFarmer(a.state);
      assert.ok(read && read.t !== null);
      track.push(read.t, read.sample, a.arrival);
      next += 1;
    }
    const s = track.sample(local);
    if (s) {
      shown.push(s);
    }
  }
  return shown;
};

test("a farmer sends primitives at 20 Hz on any frame rate; standing still costs the stamp", () => {
  for (const fps of [30, 60, 144]) {
    const sender = new FarmerSender();
    let sends = 0;
    for (let now = 0; now <= 2000; now += 1000 / fps) {
      if (sender.tick(body(100, "idle"), false, 1, now)) {
        sends += 1;
      }
    }
    assert.ok(Math.abs(sends - 40) <= 1, `${fps} fps sent ${sends}/40`);
  }

  const sender = new FarmerSender();
  const mine: JsonObject = {};
  const wire: JsonObject[] = [];
  let x = 100;
  for (let frame = 0; frame < 120; frame += 1) {
    const walking = frame < 60;
    if (walking) {
      x += STEP;
    }
    const clip = walking ? "walk" : "idle";
    const patch = sender.tick(body(x, clip), walking, walking ? 2 : 3, frame * FRAME_MS);
    if (patch) {
      assert.ok(Object.values(patch).every(isPrimitive), "primitives only");
      wire.push(delta(mine, patch));
      Object.assign(mine, patch);
    }
  }
  const [first] = wire;
  assert.ok(first && "k" in first && "e" in first, "a new clip says where it stands");
  assert.ok(
    wire.slice(1, 15).every((d) => !("k" in d) && !("e" in d)),
    "the same clip is not re-sent",
  );
  const stopped = wire.findIndex((d) => d["m"] === false);
  assert.ok(stopped > 0);
  assert.equal(wire[stopped]?.["a"], "idle");
  for (const d of wire.slice(stopped + 1)) {
    assert.deepEqual(Object.keys(d), ["t"], "standing still sends only the stamp");
  }
});

test("a new clip, or a pause, carries where the clip stands", () => {
  const sender = new FarmerSender();
  const walk = body(100, "walk");
  const first = sender.tick(walk, true, 1, 0) ?? sender.tick(walk, true, 1, 60);
  assert.ok(first && "k" in first && "e" in first);
  assert.equal(sender.tick(walk, true, 1, 120)?.["k"], undefined);
  const paused = body(100, "casting");
  paused.anims.isPlaying = false;
  const held = sender.tick(paused, false, 1, 180);
  assert.equal(held?.["p"], false);
  assert.ok(held && "k" in held, "a pause re-sends the frame it holds");
  assert.deepEqual(sender.away(200), { h: true, t: 200 });
  assert.equal(sender.away(200)["t"], 201, "stamps never repeat");
  // Gone stays gone: the scene's last update before it stops sends nothing.
  for (let now = 250; now < 1000; now += 50) {
    assert.equal(sender.tick(walk, true, 2, now), null);
  }
  sender.arrive();
  assert.equal(sender.tick(walk, true, 3, 1100)?.["h"], false, "back on the farm, drawn again");
});

test("a remote farmer walks at a steady pace, and its pose belongs to its body", () => {
  // The sender stands 0.5 s, walks 1.5 s, stands 0.6 s and walks 0.6 s more.
  const { sent, x } = walkRoute(192, (f) => (f >= 30 && f < 120) || f >= 156);
  const shown = playBack(sent, 7000, 3400);
  let offPace = 0;
  let outOfPose = 0;
  for (const [i, cur] of shown.entries()) {
    const moved = cur.x - (shown[i - 1] ?? cur).x;
    assert.ok(moved > -1e-9, "never steps backwards");
    // A frame walks at the sender's pace or stands, except inside the one
    // update interval where the sender started or stopped.
    if (moved > 1e-6 && Math.abs(moved - STEP) > STEP * 0.15) {
      offPace += 1;
    }
    // Walking in place, or sliding in the idle pose: the moonwalk. Only the
    // frame that arrives at the stop (moved to it, standing in it) may differ.
    if (i > 0 && moved > 1e-6 !== (cur.clip === "walk")) {
      outOfPose += 1;
    }
  }
  assert.ok(offPace <= 12, `${offPace} frames off pace`);
  assert.ok(outOfPose <= 1, `${outOfPose} frames out of pose`);
  assert.ok(shown.some((s) => s.clip === "idle"));
  const last = shown.at(-1);
  assert.ok(last && last.x > x - 8, "keeps up: ~100 ms behind, not drifting");
});

test("malformed farmer state degrades to a plain walk/stand, never to a bad frame", () => {
  assert.equal(readFarmer({ y: 1 }), null);
  assert.equal(readFarmer("x"), null);
  const base = { a: "dig", e: 10, k: 3, r: 4, t: 5, x: 1, y: 2 };
  assert.equal(readFarmer(base)?.sample.clip, "dig");
  for (const bad of [{ a: "fly" }, { k: 13 }, { k: 1.5 }, { e: 5000 }, { r: -1 }]) {
    const read = readFarmer({ ...base, ...bad });
    assert.equal(read?.sample.clip, null, JSON.stringify(bad));
    assert.equal(read?.sample.x, 1);
  }
  assert.equal(readFarmer({ x: 1, y: 2 })?.t, null, "an unstamped sender is still drawn");
});
