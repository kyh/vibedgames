import assert from "node:assert/strict";
import { test } from "node:test";

import type { ClaimMap } from "@vibedgames/multiplayer";

import { PacTrack, lerpPose, readPacSample } from "../src/net/pac-track";
import type { PacSample } from "../src/net/pac-track";
import {
  PELLET_CELLS,
  PELLET_CLAIM_PREFIX,
  PelletClaims,
  claimedCell,
  pelletClaimKey,
} from "../src/net/pellet-claims";
import {
  CLAIM_RETRY_MS,
  GRID_COLS,
  GRID_ROWS,
  MAP,
  PAC_LIMITS,
  RIVAL_DELAY_MS,
  isOpen,
} from "../src/shared/constants";

const noise = (i: number) => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;

  return s - Math.floor(s);
};

const FRAME_MS = 1000 / 60;
const OFFSET_MS = 1_700_000_000_000;
const local = (t: number) => t - OFFSET_MS;
const relay = (i: number) => 50 + noise(i) * 100;
const arrival = (t: number, i = 0) => local(t) + relay(i);

const T0 = OFFSET_MS + 10_000;

const walk = (count: number, from: { x: number; z: number; t: number }) =>
  Array.from({ length: count }, (_, i) => ({
    spawn: 1,
    t: from.t + i * 50,
    x: from.x + i * 0.25,
    z: from.z,
  }));

class ClaimRoom {
  private held: ClaimMap = {};
  readonly views = new Map<string, ClaimMap>();

  join(id: string) {
    this.views.set(id, { ...this.held });

    return this.view(id);
  }

  view(id: string) {
    return this.views.get(id) ?? {};
  }

  claim(from: string, key: string) {
    const holder = this.held[key];

    if (holder !== undefined && holder.owner !== from) {
      this.views.set(from, { ...this.view(from), [key]: holder });

      return;
    }

    this.held = { ...this.held, [key]: { owner: from } };

    for (const id of this.views.keys()) {
      this.views.set(id, { ...this.view(id), [key]: { owner: from } });
    }
  }

  clear(prefix: string) {
    const keep = (map: ClaimMap) =>
      Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith(prefix)));

    this.held = keep(this.held);

    for (const [id, map] of this.views) {
      this.views.set(id, keep(map));
    }
  }
}

interface Undo {
  points: number;
}

test("pellet claims are round-scoped and name only pellet cells", () => {
  const pellets = MAP.flat().filter((type) => type === 2 || type === 3).length;
  assert.equal(PELLET_CELLS.length, pellets);
  assert.equal(pelletClaimKey(3, "1,1"), "pellet:3:0");
  assert.equal(pelletClaimKey(3, "0,0"), null);
  assert.ok(pelletClaimKey(3, "1,1")?.startsWith(PELLET_CLAIM_PREFIX));

  for (const cell of PELLET_CELLS) {
    assert.equal(claimedCell(pelletClaimKey(7, cell) ?? "", 7), cell);
  }

  assert.equal(claimedCell("pellet:3:0", 4), null);
  assert.equal(claimedCell("pellet:31:0", 3), null);

  for (const junk of ["pellet:3:07", "pellet:3:1e2", "pellet:3: 3", "pellet:3:-0", "pellet:3:"]) {
    assert.equal(claimedCell(junk, 3), null, junk);
  }

  assert.equal(claimedCell(`pellet:3:${PELLET_CELLS.length}`, 3), null, "past the pellet list");
  assert.equal(claimedCell("door", 3), null);
});

test("two pacs racing for a pellet: the first claim wins on every screen, the host has no edge", () => {
  const room = new ClaimRoom();
  room.join("host");
  room.join("guest");
  const host = new PelletClaims<Undo>();
  const guest = new PelletClaims<Undo>();
  const hostKey = host.eat(1, "14,1", { points: 10 }, 0);
  const guestKey = guest.eat(1, "14,1", { points: 10 }, 0);
  assert.ok(hostKey !== null && hostKey === guestKey);
  assert.deepEqual([...host.eaten(room.view("host"), 1)], ["14,1"]);
  assert.deepEqual([...guest.eaten(room.view("guest"), 1)], ["14,1"]);
  room.claim("guest", guestKey);
  room.claim("host", hostKey);
  assert.deepEqual(guest.settle(room.view("guest"), "guest"), []);
  assert.deepEqual(host.settle(room.view("host"), "host"), [
    { cell: "14,1", undo: { points: 10 } },
  ]);
  assert.equal(host.inFlight + guest.inFlight, 0);
  assert.deepEqual(host.settle(room.view("host"), "host"), []);
  assert.deepEqual([...host.eaten(room.view("host"), 1)], ["14,1"]);
  assert.deepEqual([...guest.eaten(room.view("guest"), 1)], ["14,1"]);
});

test("a late joiner reads the same board from the claims alone", () => {
  const room = new ClaimRoom();
  room.join("a");
  room.join("b");
  const a = new PelletClaims<Undo>();
  const b = new PelletClaims<Undo>();

  for (const [player, claims, cell] of [
    ["a", a, "1,1"],
    ["a", a, "2,1"],
    ["b", b, "1,2"],
    ["b", b, "2,1"],
  ] as const) {
    room.claim(player, claims.eat(1, cell, { points: 10 }, 0) ?? "");
  }

  a.settle(room.view("a"), "a");
  b.settle(room.view("b"), "b");
  const late = new PelletClaims<Undo>().eaten(room.join("late"), 1);
  assert.deepEqual([...late].toSorted(), ["1,1", "1,2", "2,1"]);
  assert.deepEqual([...a.eaten(room.view("a"), 1)].toSorted(), [...late].toSorted());
  assert.deepEqual([...b.eaten(room.view("b"), 1)].toSorted(), [...late].toSorted());
});

test("a claim that reaches the server after the host moved on cannot touch the new maze", () => {
  const room = new ClaimRoom();
  room.join("host");
  room.join("guest");
  const guest = new PelletClaims<Undo>();
  room.claim("guest", guest.eat(1, "1,1", { points: 10 }, 0) ?? "");
  room.clear(PELLET_CLAIM_PREFIX);
  const late = guest.eat(1, "2,1", { points: 10 }, 0) ?? "";
  room.claim("guest", late);
  assert.equal(room.view("host")[late]?.owner, "guest", "the server grants it");
  assert.deepEqual(
    [...new PelletClaims<Undo>().eaten(room.view("host"), 2)],
    [],
    "round 2 is whole",
  );
  guest.clear();
  assert.deepEqual([...guest.eaten(room.view("guest"), 2)], []);
});

test("an unanswered claim is asked again; a reset score takes nothing back", () => {
  const room = new ClaimRoom();
  room.join("me");
  room.join("rival");
  const mine = new PelletClaims<Undo>();
  const key = mine.eat(1, "1,1", { points: 10 }, 1000) ?? "";
  assert.equal(mine.eat(1, "1,1", { points: 10 }, 1000), key, "one claim per cell");
  assert.deepEqual(mine.overdue(1000 + CLAIM_RETRY_MS - 1, CLAIM_RETRY_MS), []);
  assert.deepEqual(mine.overdue(1000 + CLAIM_RETRY_MS, CLAIM_RETRY_MS), [key]);
  assert.deepEqual(mine.overdue(1000 + CLAIM_RETRY_MS + 1, CLAIM_RETRY_MS), [], "re-armed");
  mine.forgive();
  room.claim("rival", key);
  room.claim("me", key);
  assert.deepEqual(mine.settle(room.view("me"), "me"), []);
  assert.equal(mine.inFlight, 0);
  assert.equal(mine.eat(1, "0,0", { points: 10 }, 0), null);
  assert.equal(mine.inFlight, 0);
});

test("the room's position limits hold every cell a pac can stand on", () => {
  let open = 0;

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      if (isOpen(col, row)) {
        open += 1;
        assert.ok(col >= PAC_LIMITS.x.min && col <= PAC_LIMITS.x.max, `col ${col}`);
        assert.ok(row >= PAC_LIMITS.z.min && row <= PAC_LIMITS.z.max, `row ${row}`);
      }
    }
  }

  assert.ok(open > 0);
  assert.ok(GRID_COLS > PAC_LIMITS.x.max && GRID_ROWS > PAC_LIMITS.z.max);
});

test("only a player in the round with a position is a rival", () => {
  assert.equal(readPacSample({}), null);
  assert.equal(readPacSample({ active: false, score: 40, t: 5, x: 1, z: 1 }), null);
  assert.equal(readPacSample({ score: 40, t: 5, x: 1, z: 1 }), null, "no flag: not in the round");
  assert.equal(readPacSample({ active: true, t: 5 }), null, "no position yet");
  assert.equal(readPacSample({ active: true, t: "5", x: 1, z: 1 }), null);
  assert.deepEqual(readPacSample({ active: true, t: 5, x: 2, z: 3 }), {
    spawn: 0,
    t: 5,
    x: 2,
    z: 3,
  });
  assert.deepEqual(readPacSample({ active: true, score: 30, spawn: 4, t: 5, x: 2, z: 3 }), {
    spawn: 4,
    t: 5,
    x: 2,
    z: 3,
  });
});

interface Playback {
  lags: number[];
  steps: number[];
}

const playWalk = (transit: (i: number) => number) => {
  const track = new PacTrack();
  const reports = walk(80, { t: T0, x: 1, z: 1 });
  const landed = (i: number) => local(reports[i]?.t ?? Infinity) + transit(i);
  const playback: Playback = { lags: [], steps: [] };
  let next = 0;
  let prev: number | null = null;
  const settled = landed(0) + 1000;
  const end = landed(79) - 300;

  for (let at = landed(0); at < end; at += FRAME_MS) {
    while (next < reports.length && landed(next) <= at) {
      next += 1;
    }

    const newest = reports[next - 1];

    if (newest) {
      track.push(newest, at);
    }

    const pose = track.sample(at);
    assert.ok(pose);
    assert.equal(pose.z, 1);

    if (prev !== null && at >= settled) {
      playback.steps.push(pose.x - prev);
      playback.lags.push(at + OFFSET_MS - (T0 + ((pose.x - 1) / 0.25) * 50));
    }

    prev = pose.x;
  }

  return playback;
};

const assertSteady = (steps: readonly number[]) => {
  const expected = 5 * (FRAME_MS / 1000);
  assert.ok(steps.length > 100);

  for (const step of steps) {
    assert.ok(Math.abs(step - expected) < expected * 0.15, `frame step ${step} vs ${expected}`);
  }
};

test("a rival walking the maze renders as steady motion from jittery 20 Hz reports", () => {
  assertSteady(playWalk(relay).steps);
});

test("each rival's clock learns its own route: a slow one walks as steadily, only later", () => {
  const fast = playWalk(relay);
  const slow = playWalk((i) => 250 + noise(i) * 100);
  assertSteady(slow.steps);
  assert.equal(slow.lags.length, fast.lags.length);

  for (const [i, lag] of slow.lags.entries()) {
    const fastLag = fast.lags[i] ?? Number.NaN;
    assert.ok(Math.abs(lag - fastLag - 200) < 1, `frame ${i}: ${lag} vs ${fastLag}`);
  }
});

test("a calm route draws a rival RIVAL_DELAY_MS behind; a jittery one only as far as it needs", () => {
  const calm = playWalk((i) => 40 + noise(i) * 20);
  assertSteady(calm.steps);

  for (const lag of calm.lags) {
    const behind = lag - 40 - RIVAL_DELAY_MS;
    assert.ok(behind > -1 && behind < FRAME_MS + 1, `lag ${lag} on the calm route`);
  }

  for (const lag of playWalk(relay).lags) {
    const delay = lag - 50;
    assert.ok(delay > RIVAL_DELAY_MS - 1 && delay < 50 + 100 + FRAME_MS + 1, `delay ${delay}`);
  }
});

interface Delivery {
  at: number;
  report: PacSample;
}

const acrossDrop = () => {
  const deliveries: Delivery[] = [];
  let last = Number.NEGATIVE_INFINITY;

  for (const [i, report] of walk(200, { t: T0, x: 1, z: 1 }).entries()) {
    if (i < 60 || i >= 80) {
      last = Math.max(last, local(report.t) + (i < 60 ? 50 : 450) + noise(i) * 20);
      deliveries.push({ at: last, report });
    }
  }

  return deliveries;
};

test("back from our own drop onto a much slower route, a rival plays on at once", () => {
  const deliveries = acrossDrop();
  const back = deliveries[60]?.at ?? Number.NaN;
  const end = (deliveries.at(-1)?.at ?? 0) - 300;
  const track = new PacTrack();
  const steps: number[] = [];
  let relearned = false;
  let prev = Number.NaN;

  for (let at = deliveries[0]?.at ?? 0; at < end; at += FRAME_MS) {
    if (!relearned && at >= back) {
      relearned = true;
      track.relearn();
    }

    const newest = deliveries.findLast((delivery) => delivery.at <= at)?.report;
    assert.ok(newest);
    track.push(newest, at);
    const x = track.sample(at)?.x ?? Number.NaN;

    if (at >= back) {
      assert.ok(x <= newest.x + 1e-9, `${(at - back).toFixed(0)} ms back: ${x}`);
    }

    if (at >= back + 200) {
      steps.push(x - prev);
    }

    prev = x;
  }

  assertSteady(steps);
});

test("a respawn snaps the pac home instead of gliding it back through the walls", () => {
  const track = new PacTrack();
  const reports = walk(3, { t: T0, x: 1.5, z: 1 });

  for (const report of reports) {
    track.push(report, arrival(report.t));
  }

  const home = { spawn: 2, t: T0 + 3 * 50, x: 1, z: 1 };
  track.push(home, arrival(home.t));
  assert.deepEqual(track.sample(arrival(home.t)), { x: 1, z: 1 });
  const after = { ...home, t: home.t + 50, x: 1.25 };
  track.push(after, arrival(after.t));
  const pose = track.sample(arrival(after.t) + RIVAL_DELAY_MS - 25);
  assert.ok(pose && pose.x >= 1 && pose.x <= 1.25 && pose.z === 1, JSON.stringify(pose));
});

test("a jump past the neighbouring cell snaps; a step into it blends", () => {
  const jumped = new PacTrack();

  for (const report of walk(6, { t: T0, x: 7, z: 1 })) {
    jumped.push(report, arrival(report.t));
  }

  const far = { spawn: 1, t: T0 + 300, x: 3, z: 5 };
  jumped.push(far, arrival(far.t));
  assert.deepEqual(jumped.sample(arrival(far.t)), { x: 3, z: 5 });

  const stepped = new PacTrack();

  for (let i = 0; i < 5; i += 1) {
    const still = { spawn: 1, t: T0 + i * 50, x: 3, z: 1 };
    stepped.push(still, arrival(still.t));
  }

  const late = { spawn: 1, t: T0 + 300, x: 3.75, z: 1 };
  stepped.push(late, arrival(late.t));
  const mid = stepped.sample(arrival(T0 + 250) + RIVAL_DELAY_MS)?.x ?? Number.NaN;
  assert.ok(mid > 3 && mid < 3.75, `blends across the step (${mid})`);
});

test("a late report carries the pac on to the next cell centre and no further", () => {
  assert.deepEqual(lerpPose({ x: 2.5, z: 1 }, { x: 2.75, z: 1 }, 0.5), { x: 2.625, z: 1 });
  assert.deepEqual(lerpPose({ x: 2.5, z: 1 }, { x: 2.75, z: 1 }, 3), { x: 3, z: 1 });
  assert.deepEqual(lerpPose({ x: 4, z: 6.5 }, { x: 4, z: 6.25 }, 3), { x: 4, z: 6 });
  assert.deepEqual(lerpPose({ x: 2.75, z: 1 }, { x: 3, z: 1 }, 2), { x: 3, z: 1 });

  const track = new PacTrack();

  for (const report of walk(4, { t: T0, x: 2, z: 1 })) {
    track.push(report, arrival(report.t));
  }

  assert.deepEqual(track.sample(arrival(T0 + 150) + 1000), { x: 3, z: 1 });
});
