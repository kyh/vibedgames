import assert from "node:assert/strict";
import { test } from "node:test";

import { ServerClock } from "@vibedgames/multiplayer";
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

/** Deterministic jitter in [0, 1), so the tests never flake. */
const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

const FRAME_MS = 1000 / 60;
/** Server time minus this tab's local clock: an epoch timestamp against `performance.now()`. */
const OFFSET_MS = 1_700_000_000_000;
/** The room's server clock as this tab measured it (one ideal probe). */
const serverClock = (offset = OFFSET_MS): ServerClock => {
  const clock = new ServerClock();
  clock.sample(0, offset, 0);
  return clock;
};
/** Server time `t` on this tab's local clock. */
const local = (t: number): number => t - OFFSET_MS;
/** Local arrival of a report stamped `t`: the relay is two one-way trips of 25–75 ms. */
const arrival = (t: number, i = 0): number => local(t) + 50 + noise(i) * 100;

const T0 = OFFSET_MS + 10_000;

/** A rival walking along a row at pac speed (5 cells/s), reporting every 50 ms. */
const walk = (count: number, from: { x: number; z: number; t: number }): PacSample[] =>
  Array.from({ length: count }, (_, i) => ({
    spawn: 1,
    t: from.t + i * 50,
    x: from.x + i * 0.25,
    z: from.z,
  }));

/**
 * The party server's claims, first come first served, delivered the way the
 * SDK does: a grant to everyone, a refusal to the claimer alone (naming the
 * holder), and each client's map replaced on every change.
 */
class ClaimRoom {
  private held: ClaimMap = {};
  readonly views = new Map<string, ClaimMap>();

  join(id: string): ClaimMap {
    this.views.set(id, { ...this.held });
    return this.view(id);
  }

  view(id: string): ClaimMap {
    return this.views.get(id) ?? {};
  }

  claim(from: string, key: string): void {
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

  /** Host only, on a new round. */
  clear(prefix: string): void {
    const keep = (map: ClaimMap): ClaimMap =>
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
  // Row-major: (1,1) is the first pellet; (0,0) is a wall.
  assert.equal(pelletClaimKey(3, "1,1"), "pellet:3:0");
  assert.equal(pelletClaimKey(3, "0,0"), null);
  assert.ok(pelletClaimKey(3, "1,1")?.startsWith(PELLET_CLAIM_PREFIX));
  for (const cell of PELLET_CELLS) {
    assert.equal(claimedCell(pelletClaimKey(7, cell) ?? "", 7), cell);
  }
  // Another round's claim is a different key, never this round's cell.
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
  // Both eat (14,1) at once and score it at once.
  const hostKey = host.eat(1, "14,1", { points: 10 }, 0);
  const guestKey = guest.eat(1, "14,1", { points: 10 }, 0);
  assert.ok(hostKey !== null && hostKey === guestKey);
  // The pellet is gone from both mazes before any answer.
  assert.deepEqual([...host.eaten(room.view("host"), 1)], ["14,1"]);
  assert.deepEqual([...guest.eaten(room.view("guest"), 1)], ["14,1"]);
  // The guest's claim reaches the server first.
  room.claim("guest", guestKey);
  room.claim("host", hostKey);
  assert.deepEqual(guest.settle(room.view("guest"), "guest"), []);
  assert.deepEqual(host.settle(room.view("host"), "host"), [
    { cell: "14,1", undo: { points: 10 } },
  ]);
  assert.equal(host.inFlight + guest.inFlight, 0);
  // Settled once: a later look takes nothing back again.
  assert.deepEqual(host.settle(room.view("host"), "host"), []);
  // The pellet stays gone everywhere — it is the guest's.
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
  // Joining now: nothing of its own in flight, just the sync's claims.
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
  // The host clears every pellet claim, then announces round 2 …
  room.clear(PELLET_CLAIM_PREFIX);
  // … while a guest still on round 1 claims another pellet of it.
  const late = guest.eat(1, "2,1", { points: 10 }, 0) ?? "";
  room.claim("guest", late);
  assert.equal(room.view("host")[late]?.owner, "guest", "the server grants it");
  assert.deepEqual(
    [...new PelletClaims<Undo>().eaten(room.view("host"), 2)],
    [],
    "round 2 is whole",
  );
  // The guest sees round 2 and drops what was in flight for round 1.
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
  // Our score was reset (a new run in the same maze) before the answer came.
  mine.forgive();
  room.claim("rival", key);
  room.claim("me", key);
  assert.deepEqual(mine.settle(room.view("me"), "me"), []);
  assert.equal(mine.inFlight, 0);
  // A cell with no pellet is never claimed.
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
  // Past the grid on any side is out.
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

test("a rival walking the maze renders as steady motion from jittery 20 Hz reports", () => {
  const track = new PacTrack(serverClock());
  const reports = walk(80, { t: T0, x: 1, z: 1 });
  let next = 0;
  let prev: number | null = null;
  const expected = 5 * (FRAME_MS / 1000);
  // Past the first few reports, which only fill the buffer.
  const settled = arrival(T0) + 300;
  const end = arrival(T0 + 79 * 50) - 300;
  for (let at = arrival(T0); at < end; at += FRAME_MS) {
    while (next < reports.length && arrival(reports[next]?.t ?? Infinity, next) <= at) {
      next += 1;
    }
    // As the game does: each frame feeds the newest report that has arrived
    // (reports bunched into one frame collapse to the last; a repeat is ignored).
    const newest = reports[next - 1];
    if (newest) {
      track.push(newest, at);
    }
    const pose = track.sample(at);
    assert.ok(pose);
    assert.equal(pose.z, 1);
    if (prev !== null && at >= settled) {
      const step = pose.x - prev;
      // Within 15% of the true per-frame motion: no surges, stalls or reversals.
      assert.ok(Math.abs(step - expected) < expected * 0.15, `frame step ${step} vs ${expected}`);
    }
    prev = pose.x;
  }
});

test("every tab draws a rival where it was RIVAL_DELAY_MS ago by the server clock", () => {
  // Two tabs whose own clocks share nothing: each measured the server once.
  const here = new PacTrack(serverClock());
  const there = new PacTrack(serverClock(OFFSET_MS + 37_000));
  for (const [i, report] of walk(10, { t: T0, x: 1, z: 1 }).entries()) {
    here.push(report, arrival(report.t, i));
    there.push(report, arrival(report.t, i + 50) - 37_000);
  }
  // Server time T0 + 400 lies between the reports stamped T0 + 350 and T0 + 400.
  const at = T0 + 400 + RIVAL_DELAY_MS;
  assert.deepEqual(here.sample(local(at)), { x: 3, z: 1 });
  assert.deepEqual(there.sample(local(at) - 37_000), { x: 3, z: 1 });
  // Halfway between two reports, both blend the same way.
  assert.deepEqual(here.sample(local(at) - 25), { x: 2.875, z: 1 });
  assert.deepEqual(there.sample(local(at) - 25 - 37_000), { x: 2.875, z: 1 });
});

test("a respawn snaps the pac home instead of gliding it back through the walls", () => {
  const track = new PacTrack(serverClock());
  // Caught a step from home: too close for the jump rule, so the spawn bump must do it.
  const reports = walk(3, { t: T0, x: 1.5, z: 1 });
  for (const report of reports) {
    track.push(report, arrival(report.t));
  }
  const home = { spawn: 2, t: T0 + 3 * 50, x: 1, z: 1 };
  track.push(home, arrival(home.t));
  assert.deepEqual(track.sample(arrival(home.t)), { x: 1, z: 1 });
  // Later reports from home blend from home, never from the old corridor.
  const after = { ...home, t: home.t + 50, x: 1.25 };
  track.push(after, arrival(after.t));
  const pose = track.sample(local(after.t) + RIVAL_DELAY_MS - 25);
  assert.ok(pose && pose.x >= 1 && pose.x <= 1.25 && pose.z === 1, JSON.stringify(pose));
});

test("a jump past the neighbouring cell snaps; a step into it blends", () => {
  const jumped = new PacTrack(serverClock());
  for (const report of walk(6, { t: T0, x: 7, z: 1 })) {
    jumped.push(report, arrival(report.t));
  }
  // Same spawn, five cells away: a teleport, not motion.
  const far = { spawn: 1, t: T0 + 300, x: 3, z: 5 };
  jumped.push(far, arrival(far.t));
  assert.deepEqual(jumped.sample(arrival(far.t)), { x: 3, z: 5 });

  const stepped = new PacTrack(serverClock());
  for (let i = 0; i < 5; i += 1) {
    const still = { spawn: 1, t: T0 + i * 50, x: 3, z: 1 };
    stepped.push(still, arrival(still.t));
  }
  // Bunched behind a stall, the next report already reaches the next cell.
  const late = { spawn: 1, t: T0 + 300, x: 3.75, z: 1 };
  stepped.push(late, arrival(late.t));
  // Drawn at server time T0 + 250: halfway between T0 + 200 (x 3) and T0 + 300.
  const mid = stepped.sample(local(T0 + 250) + RIVAL_DELAY_MS)?.x ?? Number.NaN;
  assert.ok(mid > 3 && mid < 3.75, `blends across the step (${mid})`);
});

test("a late report carries the pac on to the next cell centre and no further", () => {
  assert.deepEqual(lerpPose({ x: 2.5, z: 1 }, { x: 2.75, z: 1 }, 0.5), { x: 2.625, z: 1 });
  // Plain extrapolation would reach 3.25 — past the centre it stops on.
  assert.deepEqual(lerpPose({ x: 2.5, z: 1 }, { x: 2.75, z: 1 }, 3), { x: 3, z: 1 });
  assert.deepEqual(lerpPose({ x: 4, z: 6.5 }, { x: 4, z: 6.25 }, 3), { x: 4, z: 6 });
  // Already on a centre: nothing to carry on to.
  assert.deepEqual(lerpPose({ x: 2.75, z: 1 }, { x: 3, z: 1 }, 2), { x: 3, z: 1 });

  const track = new PacTrack(serverClock());
  for (const report of walk(4, { t: T0, x: 2, z: 1 })) {
    track.push(report, arrival(report.t));
  }
  // The newest report (x 2.75) is overdue by far more than the extrapolation window.
  assert.deepEqual(track.sample(arrival(T0 + 150) + 1000), { x: 3, z: 1 });
});
