import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createArena, readArena } from "../src/shared/arena";
import type { Arena } from "../src/shared/arena";
import { GRID_COLS, GRID_ROWS, SPAWN_POINTS } from "../src/shared/constants";

function seeded(arena: Arena, seed: number) {
  const original = Math.random;
  let state = seed;
  const trace: number[] = [];
  Math.random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const value = state / 4_294_967_296;
    trace.push(value);
    return value;
  };
  try {
    return { grid: createArena(arena), trace };
  } finally {
    Math.random = original;
  }
}

test("Classic preserves pre-variation grid hashes and all 161 random draws", () => {
  // Captured from the original newGrid before adding arena selection.
  const goldens: [number, string][] = [
    [1, "c04cc25d48e9009147d93b171e86ca338219524bffaccae8eed2fe16292b0b6d"],
    [7331, "e42006b8a0530f68991af304aa71cfe76554146a96c48e9d4a81f36e1d6b79d8"],
    [987_654_321, "ba0c7f1702c526d5f00214c1ccda5303c8702aae084177de034d2a293b726c6d"],
  ];
  for (const [seed, hash] of goldens) {
    const { grid, trace } = seeded("classic", seed);
    assert.equal(createHash("sha256").update(JSON.stringify(grid)).digest("hex"), hash);
    assert.equal(trace.length, 161);
  }
});

test("Crossroads only clears central-lane crates; walls, escapes and RNG stay identical", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const classic = seeded("classic", seed);
    const crossroads = seeded("crossroads", seed);
    assert.deepEqual(crossroads.trace, classic.trace);
    assert.equal(crossroads.grid.length, GRID_ROWS);
    let cleared = 0;
    for (const [r, row] of classic.grid.entries()) {
      assert.equal(crossroads.grid[r]?.length, GRID_COLS);
      for (const [c, cell] of row.entries()) {
        const next = crossroads.grid[r]?.[c];
        if (cell.kind === "crate" && (r === 7 || c === 9)) {
          assert.deepEqual(next, { kind: "empty" });
          cleared++;
        } else {
          assert.deepEqual(next, cell);
        }
      }
    }
    assert.ok(cleared > 0);
    for (const grid of [classic.grid, crossroads.grid]) {
      for (const spawn of SPAWN_POINTS) {
        assert.equal(grid[spawn.row]?.[spawn.col]?.kind, "empty");
        const horizontal = spawn.col === 1 ? 2 : GRID_COLS - 3;
        const vertical = spawn.row === 1 ? 2 : GRID_ROWS - 3;
        assert.equal(grid[spawn.row]?.[horizontal]?.kind, "empty");
        assert.equal(grid[vertical]?.[spawn.col]?.kind, "empty");
      }
    }
  }
});

test("arena wire boundary: only explicit Crossroads; legacy rooms are Classic", () => {
  assert.equal(readArena("crossroads"), "crossroads");
  assert.equal(readArena("classic"), "classic");
  assert.equal(readArena(), "classic");
});
