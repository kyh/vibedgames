import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOOST_TIERS,
  LAPS,
  MAX_SPEED,
  PAINT_CELL,
  PAINT_LIFE,
  PAINT_SIZE,
} from "../src/shared/constants.ts";
import { botInput, makeBrain } from "../src/sim/bot.ts";
import { boostTier, kartSpeed, raceLength, spawnKart, stepKart } from "../src/sim/kart.ts";
import type { KartInput } from "../src/sim/kart.ts";
import { PaintGrid } from "../src/sim/paint.ts";
import { formatTime, ordinal, rank } from "../src/sim/race.ts";
import { TRACKS, locate } from "../src/sim/track.ts";

const DT = 1 / 60;

test("every circuit fits the paint grid and never doubles back on itself", () => {
  const half = (PAINT_SIZE * PAINT_CELL) / 2;

  for (const track of TRACKS) {
    for (let i = 0; i < track.n; i += 1) {
      const x = track.xs[i] ?? 0;
      const z = track.zs[i] ?? 0;
      assert.ok(Math.abs(x) + track.rail < half, `${track.def.id} x in grid at ${i}`);
      assert.ok(Math.abs(z) + track.rail < half, `${track.def.id} z in grid at ${i}`);

      for (let j = i + 60; j < track.n - 60 + i && j < track.n; j += 4) {
        const d = Math.hypot(x - (track.xs[j] ?? 0), z - (track.zs[j] ?? 0));
        assert.ok(
          d > track.rail * 2 + 1,
          `${track.def.id}: ${i} and ${j} are ${d.toFixed(1)} apart`,
        );
      }
    }
  }
});

test("a bot finishes every circuit", () => {
  for (const track of TRACKS) {
    const kart = spawnKart(track, 0);
    const brain = makeBrain(0);
    let t = 0;
    let railHits = 0;

    while (kart.prog < raceLength(track) && t < 240) {
      const events = stepKart(kart, botInput(kart, track, brain, t, 1), track, DT, 0, 1);

      if (events.railHit > 4) {
        railHits += 1;
      }

      t += DT;
    }

    const lap = t / LAPS;
    console.log(
      `${track.def.id}: ${track.n} samples, ${lap.toFixed(1)} s/lap, ${railHits} hard rail hits`,
    );
    assert.ok(kart.prog >= raceLength(track), `${track.def.id}: bot stuck at ${kart.prog}`);
    assert.ok(lap > 12 && lap < 45, `${track.def.id}: lap of ${lap.toFixed(1)} s`);
    assert.ok(railHits < 12, `${track.def.id}: ${railHits} rail hits`);
  }
});

test("grid slots are distinct, behind the line and on the road", () => {
  for (const track of TRACKS) {
    const karts = Array.from({ length: 6 }, (_, slot) => spawnKart(track, slot));

    for (const [i, kart] of karts.entries()) {
      assert.ok(kart.prog < 0);
      assert.ok(Math.abs(locate(track, kart.x, kart.z, -1).lat) < track.halfWidth);

      for (const other of karts.slice(i + 1)) {
        assert.ok(Math.hypot(kart.x - other.x, kart.z - other.z) > 3);
      }
    }
  }
});

test("own paint is faster than bare road, rival paint slower", () => {
  const [track] = TRACKS;
  assert.ok(track);
  const flatOut: KartInput = { brake: 0, drift: false, steer: 0, throttle: 1 };

  const topSpeed = (owner: number) => {
    const kart = spawnKart(track, 0);
    kart.lat = 0;
    let top = 0;

    for (let i = 0; i < 600; i += 1) {
      const fresh = spawnKart(track, 0);
      kart.x = fresh.x;
      kart.z = fresh.z;
      kart.a = fresh.a;
      kart.idx = fresh.idx;
      kart.s = fresh.s;
      stepKart(kart, flatOut, track, DT, owner, 1);
      top = Math.max(top, kartSpeed(kart));
    }

    return top;
  };

  const bare = topSpeed(0);
  assert.ok(Math.abs(bare - MAX_SPEED) < 0.5, `bare top speed ${bare}`);
  assert.ok(topSpeed(1) > bare + 3);
  assert.ok(topSpeed(2) < bare - 1);
});

test("a held drift charges through the tiers and releases as boost", () => {
  assert.equal(boostTier(0), 0);
  assert.equal(boostTier(BOOST_TIERS[0]), 1);
  assert.equal(boostTier(BOOST_TIERS[2] + 1), 3);
  const [track] = TRACKS;
  assert.ok(track);
  const kart = spawnKart(track, 0);
  kart.vx = Math.cos(kart.a) * 25;
  kart.vz = Math.sin(kart.a) * 25;
  const drifting: KartInput = { brake: 0, drift: true, steer: 1, throttle: 1 };
  let started = false;

  for (let i = 0; i < 50; i += 1) {
    started ||= stepKart(kart, drifting, track, DT, 0, 1).driftStarted;
  }

  assert.ok(started);
  assert.equal(kart.drift, 1);
  const [, tierTwo] = BOOST_TIERS;
  kart.charge = tierTwo;
  const release = stepKart(kart, { ...drifting, drift: false }, track, DT, 0, 1);
  assert.equal(release.boosted, 2);
  assert.ok(kart.boost > 0);
});

test("paint: newest coat wins, fades out, and is ignored off the grid", () => {
  const grid = new PaintGrid();
  grid.stamp(10, 10, 2, 1);
  assert.equal(grid.ownerAt(10, 10), 1);
  grid.stamp(10, 10, 1, 2);
  assert.equal(grid.ownerAt(10, 10), 2);
  assert.equal(grid.ownerAt(11.6, 10), 1);
  assert.equal(grid.ownerAt(9999, 0), 0);
  grid.decay(PAINT_LIFE + 1);
  assert.equal(grid.ownerAt(10, 10), 0);
  assert.equal(grid.ownerAt(11.6, 10), 0);
});

test("standings: finishers by time, then by distance", () => {
  const order = rank([
    { finishMs: 0, key: "a", prog: 900 },
    { finishMs: 5200, key: "b", prog: 1200 },
    { finishMs: 0, key: "c", prog: 950 },
    { finishMs: 5100, key: "d", prog: 1200 },
  ]).map((entry) => entry.key);

  assert.deepEqual(order, ["d", "b", "c", "a"]);
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal), [
    "1st",
    "2nd",
    "3rd",
    "4th",
    "11th",
    "12th",
    "13th",
    "21st",
  ]);
  assert.equal(formatTime(83_450), "1:23.4");
});
