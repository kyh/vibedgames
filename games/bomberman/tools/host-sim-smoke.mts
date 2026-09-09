import assert from "node:assert/strict";
import { test } from "node:test";
import { hostTick, placeBomb } from "../src/sim/host-sim";
import { BOT_MOVE_MS, FUSE_MS, newGrid } from "../src/shared/constants";
import type { Bot, Cell, SharedState } from "../src/shared/constants";

/** The courtyard with every crate removed, plus the crates a case pins. */
const openGrid = (crates: [col: number, row: number][]): Cell[][] => {
  const grid = newGrid().map((row) =>
    row.map((cell) => (cell.kind === "crate" ? { kind: "empty" as const } : cell)),
  );
  for (const [col, row] of crates) {
    const line = grid[row];
    if (line) {
      line[col] = { kind: "crate" };
    }
  }
  return grid;
};

const world = (grid: Cell[][], patch: Partial<SharedState> = {}): SharedState => ({
  blasts: {},
  bombs: {},
  bots: {},
  deaths: {},
  grid,
  powerups: {},
  startedAt: 1,
  stats: {},
  winner: null,
  ...patch,
});

const bot = (id: string, col: number, row: number): Bot => ({
  col,
  colorIdx: 1,
  dir: "down",
  id,
  moving: false,
  nextMoveAt: 0,
  row,
});

test("bomb placement: stock, tile occupancy and death gate the request", () => {
  const s = world(openGrid([]));
  const first = placeBomb(s, "h", 1, 1, 1000);
  assert.ok(first);
  const [bomb] = Object.values(first);
  assert.deepEqual(bomb, { col: 1, id: bomb?.id, ownerId: "h", placedAt: 1000, range: 2, row: 1 });
  const stocked = world(openGrid([]), { bombs: first });
  assert.equal(placeBomb(stocked, "h", 1, 1, 1001), null, "tile already holds a bomb");
  assert.equal(placeBomb(stocked, "h", 2, 1, 1001), null, "base stock is one bomb");
  assert.equal(placeBomb(stocked, "g", 1, 1, 1001), null, "another owner, same tile");
  assert.ok(placeBomb(stocked, "g", 2, 1, 1001));
  assert.equal(placeBomb(world(openGrid([]), { deaths: { h: 1 } }), "h", 1, 1, 1), null);
  assert.equal(placeBomb(s, "h", 0, 0, 1), null, "never inside a wall");
  assert.equal(placeBomb(world(openGrid([[3, 1]])), "h", 3, 1, 1), null, "never inside a crate");
});

test("blast propagation: walls stop, crates absorb, chains cascade, fighters die", () => {
  const now = 10_000;
  const s = world(openGrid([[3, 1]]), {
    bombs: {
      a: { col: 1, id: "a", ownerId: "h", placedAt: now - FUSE_MS, range: 2, row: 1 },
      b: { col: 1, id: "b", ownerId: "g", placedAt: now - 100, range: 1, row: 3 },
    },
  });
  const humans = [
    { id: "h", pos: { col: 1, row: 2 } },
    { id: "g", pos: { col: 17, row: 13 } },
  ];
  const { patch, pickups } = hostTick(s, humans, now, () => 1);
  assert.ok(patch);
  assert.deepEqual(pickups, []);
  assert.deepEqual(patch.bombs, {}, "the chained bomb detonates in the same tick");
  const keys = (blast: string) =>
    (patch.blasts?.[blast]?.tiles ?? []).map((t) => `${t.col},${t.row}`).toSorted();
  assert.deepEqual(keys("x-a"), ["1,1", "1,2", "1,3", "2,1", "3,1"]);
  assert.deepEqual(keys("x-b"), ["1,2", "1,3", "1,4", "2,3"]);
  assert.equal(patch.grid?.[1]?.[3]?.kind, "empty", "crate cleared");
  assert.equal(s.grid[1]?.[3]?.kind, "crate", "input state untouched");
  assert.equal(patch.powerups, undefined, "no drop at random()=1");
  assert.deepEqual(Object.keys(patch.deaths ?? {}), ["h"]);
  assert.deepEqual(
    Object.keys(patch.bots ?? {}).toSorted(),
    ["bot-2", "bot-3"],
    "free corners filled",
  );
  const spent = hostTick(
    world(patch.grid ?? [], { blasts: patch.blasts, bots: patch.bots, deaths: patch.deaths }),
    humans,
    now + 1000,
    () => 1,
  );
  assert.deepEqual(spent.patch?.blasts, {}, "blasts expire");
});

test("bots flee live danger and only wander onto safe tiles", () => {
  const fleeing = world(openGrid([[3, 2]]), {
    bombs: { a: { col: 5, id: "a", ownerId: "h", placedAt: 0, range: 2, row: 1 } },
    bots: { "bot-1": bot("bot-1", 3, 1) },
  });
  const fled = hostTick(fleeing, [{ id: "h", pos: null }], 500, () => 0);
  assert.deepEqual(
    fled.patch?.bots?.["bot-1"],
    { ...bot("bot-1", 2, 1), dir: "left", moving: true, nextMoveAt: 500 + BOT_MOVE_MS },
    "steps out of the blast line",
  );
  const wandering = world(openGrid([]), {
    bombs: { a: { col: 4, id: "a", ownerId: "h", placedAt: 0, range: 1, row: 1 } },
    bots: { "bot-1": bot("bot-1", 2, 1) },
  });
  const wandered = hostTick(wandering, [{ id: "h", pos: null }], 500, () => 0);
  const moved = wandered.patch?.bots?.["bot-1"];
  assert.equal(`${moved?.col},${moved?.row}`, "1,1", "the only safe neighbour");
  assert.deepEqual(Object.keys(wandered.patch?.bombs ?? {}), ["a"], "no bomb without a target");
  const waiting = world(openGrid([]), {
    bots: { "bot-1": { ...bot("bot-1", 2, 1), nextMoveAt: 900 } },
  });
  const idle = hostTick(waiting, [{ id: "h", pos: null }], 500, () => 0);
  assert.equal(idle.patch?.bots?.["bot-1"]?.col, 2, "cadence gate holds the bot");
});
