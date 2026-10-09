/**
 * Shared-state bandwidth audit: what the host puts on the wire for a round.
 *
 * The world is run the way the scene runs it — the host sim on its fixed
 * step, power-ups claimed and settled through an offline room, a new round
 * whenever one is decided — and every step's write is sized the way the SDK
 * sends it: the leaves that changed (`diffState` against the room's copy),
 * in the `state_patch` envelope the party server relays to each guest.
 *
 * Two encodings of the same writes:
 *
 * - opened: the board rides once per round as its starting layout, and the
 *   crates opened since as a string of two-character tile codes (the old
 *   net/grid-wire, inlined); the sim clock goes only when it changed.
 * - board: the board as it is, `clock` on every write. Path ops send each
 *   opened crate as one leaf, and an unchanged clock as nothing.
 *
 * Run: node --import tsx tools/wire-audit.mts
 */

import { applyPatch, diffState, MultiplayerClient } from "@vibedgames/multiplayer";
import type { JsonRecord } from "@vibedgames/multiplayer";

import { PickupClaims } from "../src/net/pickup-claims";
import { createArena } from "../src/shared/arena";
import { GRID_COLS, HOST_STEP_MS } from "../src/shared/constants";
import type { Cell, SharedState } from "../src/shared/constants";
import { hostTick } from "../src/sim/host-sim";
import { seededRandom } from "../src/util/seeded-random";

const ROUNDS = 12;
const ROUND_CAP_MS = 90_000;
const CLOCK = { kind: "running", offset: 0 } as const;

const bytes = <T,>(value: T): number => Buffer.byteLength(JSON.stringify(value));

/** The old wire's crate list: two base-36 characters per tile index opened since the layout. */
const encodeOpened = (base: Cell[][], current: Cell[][]): string => {
  let out = "";
  for (const [row, cells] of base.entries()) {
    for (const [col, cell] of cells.entries()) {
      if (cell.kind === "crate" && current[row]?.[col]?.kind === "empty") {
        out += (row * GRID_COLS + col).toString(36).padStart(2, "0");
      }
    }
  }
  return out;
};

/** The SDK's sender: the room's copy, and the bytes each write's diff costs. */
class Wire {
  room: JsonRecord = {};
  state: JsonRecord = {};
  sent = 0;
  messages = 0;

  write(patch: JsonRecord): void {
    this.state = { ...this.state, ...patch };
    const ops = diffState(this.room, this.state, Object.keys(patch));
    if (ops.length === 0) {
      return;
    }
    this.room = applyPatch(this.room, structuredClone(ops));
    this.sent += bytes({ data: ops, type: "state_patch" });
    this.messages += 1;
  }
}

const emptyWorld = (random: () => number, startedAt: number): SharedState => ({
  arena: "classic",
  blasts: {},
  bombs: {},
  bots: {},
  deaths: {},
  grid: createArena("classic", random),
  powerups: {},
  startedAt,
  stats: {},
  winner: null,
});

const opened = new Wire();
const board = new Wire();
const claims = new PickupClaims();
// A solo host's room: offline, so every claim is granted at once.
const room = new MultiplayerClient({
  host: "http://127.0.0.1:9",
  offline: true,
  party: "vg-server",
  room: "wire-audit",
});
const human = { id: "h", pos: { col: 1, row: 1 } };

let simMs = 0;
let roundStart = { board: 0, opened: 0 };
/** The largest room copy a late joiner's `sync` carried. */
const lateJoin = { board: 0, opened: 0 };
for (let round = 0; round < ROUNDS; round += 1) {
  const random = seededRandom(round + 1);
  const t0 = 1_000_000 + round * ROUND_CAP_MS * 2;
  let s = emptyWorld(random, t0);
  const layout = s.grid;
  // A new round goes out whole, with the clock.
  const sentBefore = { board: board.sent, opened: opened.sent };
  opened.write({ ...s, clock: CLOCK, opened: "" });
  board.write({ ...s, clock: CLOCK });
  roundStart = { board: board.sent - sentBefore.board, opened: opened.sent - sentBefore.opened };
  claims.clear();
  let now = t0;
  for (; now <= t0 + ROUND_CAP_MS && !s.winner; now += HOST_STEP_MS) {
    const { patch } = hostTick(s, [human], now, random);
    let merged: Partial<SharedState> = patch ?? {};
    s = patch ? { ...s, ...patch } : s;
    for (const bot of Object.values(s.bots)) {
      if (!s.deaths[bot.id]) {
        claims.reach(room, s, bot.id, bot);
      }
    }
    const granted = claims.settle(room, s, room.playerId ?? "");
    if (granted) {
      s = { ...s, ...granted };
      merged = { ...merged, ...granted };
    }
    if (Object.keys(merged).length === 0) {
      continue;
    }
    const { grid, ...rest } = merged;
    opened.write(grid ? { ...rest, opened: encodeOpened(layout, grid) } : rest);
    board.write({ ...merged, clock: CLOCK });
    lateJoin.board = Math.max(lateJoin.board, bytes(board.room));
    lateJoin.opened = Math.max(lateJoin.opened, bytes(opened.room));
  }
  simMs += now - t0;
}
room.destroy();

const perSecond = (wire: Wire): string => `${((wire.sent * 1000) / simMs).toFixed(0)} B/s`;
const row = (label: string, a: string, b: string): void => {
  console.log(`  ${label.padEnd(34)} ${a.padStart(12)} ${b.padStart(12)}`);
};
console.log(`\n${ROUNDS} bot rounds, ${(simMs / 1000).toFixed(0)} s of play, per guest:\n`);
row("", "opened", "board");
row("state_patch bytes/s", perSecond(opened), perSecond(board));
row(
  "messages/s",
  ((opened.messages * 1000) / simMs).toFixed(1),
  ((board.messages * 1000) / simMs).toFixed(1),
);
row(
  "bytes per message",
  (opened.sent / opened.messages).toFixed(0),
  (board.sent / board.messages).toFixed(0),
);
row("a new round's write", `${roundStart.opened} B`, `${roundStart.board} B`);
row("largest late-join sync", `${lateJoin.opened} B`, `${lateJoin.board} B`);
console.log();
