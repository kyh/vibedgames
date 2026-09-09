import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { blastFrame, fireCells, freshCue } from "../src/render/blast-frame";
import {
  ACTION_SHEETS,
  CharacterAction,
  PLACE_ACTION_MS,
  VICTORY_ACTION_MS,
} from "../src/render/character-action";
import type { CharacterPose } from "../src/render/character-action";
import { bombStock } from "../src/render/round-hud";
import { RoundScore, scoreNotes } from "../src/fx/round-score";
import { EXPLOSION_MS, FUSE_MS } from "../src/shared/constants";
import type { Bomb } from "../src/shared/constants";
import {
  adoptClock,
  CLOCK_SLACK_MS,
  now,
  pauseClock,
  readClock,
  resumeClock,
} from "../src/util/clock";

const pose: CharacterPose = { col: 1, dir: "down", moving: false, row: 1 };
const bomb = { col: 1, id: "accepted", placedAt: 1000, row: 1 };
const mine = (id: string, placedAt: number): Bomb => ({
  col: 1,
  id,
  ownerId: "me",
  placedAt,
  range: 2,
  row: 1,
});

test("placement plays from the accepted stamp, per direction, and interrupts on any change", () => {
  for (const dir of ["up", "down", "left", "right"] as const) {
    for (const age of [0, 100, 279, 280]) {
      const action = new CharacterAction();
      const current = { ...pose, dir };
      assert.equal(action.place(bomb, 1000 + age, 500, current), age < PLACE_ACTION_MS);
      const frame = action.sample(500, current, true);
      if (age < PLACE_ACTION_MS) {
        assert.equal(frame?.frame, Math.floor(age / 70));
        assert.equal(frame?.flip, dir === "left");
        assert.equal(
          frame?.key,
          `player-place-${dir === "left" || dir === "right" ? "side" : dir}`,
        );
      } else {
        assert.equal(frame, null);
      }
      assert.equal(action.place(bomb, 1000 + age, 550, current), false, "stamp consumed");
      assert.equal(action.sample(500 + PLACE_ACTION_MS, current, true), null);
    }
  }
  const changes: CharacterPose[] = [
    { ...pose, moving: true },
    { ...pose, dir: "left" },
    { ...pose, col: 2 },
  ];
  for (const changed of changes) {
    const action = new CharacterAction();
    action.place(bomb, 1000, 0, pose);
    assert.equal(action.sample(1, changed, true), null);
    assert.equal(action.sample(2, pose, true), null, "interrupted action never resumes");
  }
});

test("moving, distant and future placements are consumed; reset accepts the next round", () => {
  const action = new CharacterAction();
  assert.equal(action.place(bomb, 1000, 0, { ...pose, moving: true }), false);
  assert.equal(action.place(bomb, 1000, 1, pose), false);
  action.reset();
  assert.equal(action.place(bomb, 1000, 2, pose), true);
  assert.equal(action.place({ ...bomb, id: "older", placedAt: 990 }, 1000, 3, pose), false);
  assert.equal(action.place({ ...bomb, id: "new", placedAt: 1050 }, 1050, 50, pose), true);
  assert.equal(action.sample(2, pose, false), null, "dead fighters never act");
});

test("victory holds the salute until a fresh movement edge or death", () => {
  const action = new CharacterAction();
  const finalStep = { ...pose, moving: true };
  action.victory(100, finalStep);
  assert.equal(action.place(bomb, 1000, 100, pose), false, "placement cannot replace victory");
  assert.equal(action.sample(100, finalStep, true)?.frame, 0);
  assert.equal(action.sample(100 + VICTORY_ACTION_MS, pose, true)?.frame, 3);
  assert.equal(action.sample(100_000, pose, true)?.frame, 3);
  assert.equal(action.sample(100_001, finalStep, true), null);
});

test("action sheet cuts tile each PNG exactly and pivots lie inside their cell", () => {
  for (const sheet of ACTION_SHEETS) {
    const bytes = readFileSync(new URL(`../public/${sheet.url}`, import.meta.url));
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    let area = 0;
    for (const cut of sheet.frames) {
      assert.ok(cut.x + cut.width <= width && cut.y + cut.height <= height, sheet.key);
      assert.ok(cut.feetX > 0 && cut.feetX < cut.width && cut.feetY > 0 && cut.feetY < cut.height);
      area += cut.width * cut.height;
    }
    assert.equal(area, width * height, `${sheet.key} cuts cover the whole raster`);
  }
});

test("blast frames seek by age; overlapping blasts share the newest cell", () => {
  for (const [age, frame] of [
    [-1, null],
    [0, 0],
    [31, 0],
    [32, 1],
    [EXPLOSION_MS - 1, 15],
    [EXPLOSION_MS, null],
  ] as const) {
    assert.equal(blastFrame(1000, 1000 + age), frame);
  }
  assert.equal(freshCue(1000, 999), false);
  assert.equal(freshCue(1000, 1140), true);
  assert.equal(freshCue(1000, 1141), false);
  const row = Array.from({ length: 5 }, (_, col) => ({ col: col + 2, row: 4 }));
  const column = Array.from({ length: 5 }, (_, r) => ({ col: 4, row: r + 2 }));
  const cells = fireCells(
    [
      { id: "a", placedAt: 800, tiles: row },
      { id: "b", placedAt: 1000, tiles: column },
    ],
    1000,
  );
  assert.equal(cells.size, 9, "the crossing tile is one visual");
  assert.equal(cells.get("4,4")?.placedAt, 1000);
  assert.equal(fireCells([{ id: "old", placedAt: 0, tiles: row }], 1000).size, 0);
});

test("bomb stock counts only accepted bombs and never frees a slot early", () => {
  const bombs = {
    a: mine("a", 2000),
    b: { ...mine("b", 0), ownerId: "other" },
    c: mine("c", 1000),
  };
  const stock = bombStock(bombs, "me", 3, 2100);
  assert.deepEqual(stock, {
    available: 1,
    capacity: 3,
    next: { progress: 1 - (1000 + FUSE_MS - 2100) / FUSE_MS, remaining: 1000 + FUSE_MS - 2100 },
  });
  assert.equal(bombStock({ a: mine("a", 1000) }, "me", 1, 1000 + FUSE_MS + 500).available, 0);
  assert.deepEqual(bombStock({}, "me", 1, 1500), { available: 1, capacity: 1, next: null });
  assert.equal(bombStock({ a: mine("a", 1000) }, "me", 1, 900).next?.progress, 0);
});

test("round score emits one beat per step and rebases on gaps, mode changes and silence", () => {
  const score = new RoundScore();
  assert.deepEqual(score.observe("playing", 0), { kind: "rebase" });
  assert.equal(score.observe("playing", 100), null);
  assert.deepEqual(score.observe("playing", 400), {
    beat: { mode: "playing", step: 1 },
    kind: "beat",
  });
  assert.deepEqual(score.observe("playing", 1300), { kind: "rebase" }, "skipped steps rebase");
  assert.deepEqual(score.observe("playing", 2200), { kind: "rebase" }, "transport gap rebases");
  assert.deepEqual(score.observe("duel", 2300), { kind: "rebase" }, "mode change rebases");
  assert.deepEqual(score.observe("silent", 2400), { kind: "rebase" });
  assert.deepEqual(scoreNotes({ mode: "playing", step: 0 }), [146.83, 293.66]);
  assert.deepEqual(scoreNotes({ mode: "playing", step: 2 }), []);
  assert.deepEqual(scoreNotes({ mode: "duel", step: 2 }), [220]);
});

test("sim clock freezes while paused, calibrates to host sim time, ignores jitter", () => {
  adoptClock({ at: Date.now(), kind: "running" });
  assert.equal(readClock(), null, "legacy rooms keep the local clock");
  assert.deepEqual(readClock({ kind: "paused", now: 42 }), { kind: "paused", now: 42 });
  assert.equal(readClock({ at: Number.NaN, kind: "running" }), null);
  // A host whose wall clock runs 5s ahead: sim time follows the host, not Date.now().
  const received = Date.now();
  adoptClock({ at: received + 5000, kind: "running" }, received);
  const skew = now() - Date.now();
  assert.ok(skew > 4900 && skew <= 5000, `skew ${skew}`);
  // Snapshot latency jitter within CLOCK_SLACK_MS never re-calibrates.
  adoptClock({ at: received + 5000 + CLOCK_SLACK_MS, kind: "running" }, received + 10);
  assert.ok(now() - Date.now() <= 5000);
  // Re-reading the same stamp seconds later (promotion) must not jump backwards.
  adoptClock({ at: received + 5000 + CLOCK_SLACK_MS, kind: "running" }, received + 6000);
  assert.ok(now() - Date.now() > 4900);
  pauseClock();
  const frozen = now();
  for (let i = 0; i < 1000; i++) {
    assert.equal(now(), frozen);
  }
  resumeClock();
  assert.ok(now() >= frozen);
  adoptClock({ kind: "paused", now: 42 });
  assert.equal(now(), 42);
  adoptClock({ at: 1000, kind: "running" }, 1000);
  assert.ok(now() - Date.now() >= -1 && now() - Date.now() <= 0, "back on wall time");
});
