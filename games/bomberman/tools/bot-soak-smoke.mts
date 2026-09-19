import assert from "node:assert/strict";
import { test } from "node:test";
import { hostTick } from "../src/sim/host-sim";
import { createArena } from "../src/shared/arena";
import { FUSE_MS, newGrid } from "../src/shared/constants";
import type { Bot, Cell, SharedState } from "../src/shared/constants";
import { seededRandom } from "../src/util/seeded-random";

const TICK_MS = 70;

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

const bot = (id: string, col: number, row: number): Bot => ({
  col,
  colorIdx: 1,
  dir: "down",
  id,
  moving: false,
  nextMoveAt: 0,
  row,
});

/** Two humans hold corners 0 and 1, so the pinned bot must be bot-2. */
const bystanders = [
  { id: "h", pos: null },
  { id: "g", pos: null },
];

const merged = (s: SharedState, patch: Partial<SharedState> | null): SharedState =>
  patch ? { ...s, ...patch } : s;

/** Run host ticks at the scene's cadence; every bot die rolls "bomb now". */
const run = (start: SharedState, from: number, ms: number): SharedState => {
  let s = start;
  for (let now = from; now <= from + ms; now += TICK_MS) {
    const { patch } = hostTick(s, bystanders, now, () => 0);
    s = merged(s, patch);
  }
  return s;
};

test("a bot whose only way out is on fire neither bombs nor walks into it", () => {
  const now = 10_000;
  const s = world(openGrid([[15, 13]]), {
    blasts: {
      x: {
        id: "x",
        placedAt: now - 10,
        tiles: [
          { col: 17, row: 13 },
          { col: 17, row: 12 },
        ],
      },
    },
    bots: { "bot-2": bot("bot-2", 16, 13) },
  });
  const { patch } = hostTick(s, bystanders, now, () => 0);
  assert.deepEqual(patch?.bombs ?? {}, {}, "no bomb without a walkable escape");
  assert.equal(patch?.bots?.["bot-2"]?.col, 16, "holds rather than step into the blast");
  assert.equal(patch?.deaths?.["bot-2"], undefined);
});

test("a bot does not bomb when a lit fuse burns its escape route first", () => {
  const now = 10_000;
  const s = world(openGrid([[1, 2]]), {
    bombs: {
      a: { col: 5, id: "a", ownerId: "h", placedAt: now - (FUSE_MS - 300), range: 2, row: 1 },
    },
    bots: { "bot-2": bot("bot-2", 1, 1) },
  });
  const { patch } = hostTick(s, bystanders, now, () => 0);
  assert.deepEqual(Object.keys(patch?.bombs ?? s.bombs), ["a"], "the crate can wait");
  const later = run(s, now, 3000);
  assert.equal(later.deaths["bot-2"], undefined, "and it outlives the blast");
  assert.equal(run(s, now, 15_000).grid[2]?.[1]?.kind, "empty", "then it opens the crate");
});

type Cause = "own" | "trapped" | "rival";

interface Round {
  winner: string | null;
  botDeaths: Cause[];
  humanDiedAt: number | null;
  cratesOpened: number;
}

const crateCount = (grid: Cell[][]): number =>
  grid.flat().filter((cell) => cell.kind === "crate").length;

/** One solo round against an idle human parked on their spawn. */
const soak = (seed: number, ms: number): Round => {
  const random = seededRandom(seed);
  const human = { id: "h", pos: { col: 1, row: 1 } };
  let s = world(createArena("classic", random));
  const crates = crateCount(s.grid);
  const round: Round = { botDeaths: [], cratesOpened: 0, humanDiedAt: null, winner: null };
  for (let now = 1000; now <= 1000 + ms && !s.winner; now += TICK_MS) {
    const { patch } = hostTick(s, [human], now, random);
    if (!patch) {
      continue;
    }
    const before = s;
    s = merged(s, patch);
    for (const id of Object.keys(s.deaths)) {
      if (before.deaths[id]) {
        continue;
      }
      const victim = s.bots[id];
      if (!victim) {
        round.humanDiedAt = now - 1000;
        continue;
      }
      const owners = Object.values(s.blasts)
        .filter((blast) => blast.tiles.some((t) => t.col === victim.col && t.row === victim.row))
        .map((blast) => blast.id);
      const own = owners.some((blastId) => blastId.startsWith(`x-b-${id}-`));
      const boxedIn = Object.values(s.bombs).some(
        (bomb) =>
          bomb.ownerId !== id &&
          Math.abs(bomb.col - victim.col) + Math.abs(bomb.row - victim.row) <= 2,
      );
      const selfInflicted: Cause = boxedIn ? "trapped" : "own";
      round.botDeaths.push(own ? selfInflicted : "rival");
    }
  }
  round.winner = s.winner;
  round.cratesOpened = crates - crateCount(s.grid);
  return round;
};

test("soak: bots outlive their own bombs and still hunt an idle player", () => {
  const seeds = Array.from({ length: 12 }, (_, i) => i + 1);
  const rounds = seeds.map((seed) => soak(seed, 60_000));
  const selfKills = rounds.flatMap((r) => r.botDeaths).filter((cause) => cause === "own").length;
  const report = JSON.stringify(rounds);
  assert.ok(selfKills <= 2, `self-kills stay rare, saw ${selfKills}: ${report}`);
  assert.ok(
    rounds.every((r) => r.winner !== "h"),
    `an idle player never wins inside a minute: ${report}`,
  );
  const hunted = rounds.filter((r) => r.humanDiedAt !== null).length;
  assert.ok(hunted >= 8, `bots reach and kill an idle player, did in ${hunted}/12: ${report}`);
  const opened = rounds.reduce((sum, r) => sum + r.cratesOpened, 0) / rounds.length;
  assert.ok(opened >= 25, `bots keep opening crates, averaged ${opened.toFixed(1)}`);
});
