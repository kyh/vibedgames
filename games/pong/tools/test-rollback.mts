// Two rollback clients over jittery, delayed links, fed by one tick stream.
// The party server's tick room is modelled (an input lands on the tick it
// asks for, or the next one if that has passed; every tick is broadcast in
// order; a dropped player's input clears on the next tick), and so is the
// SDK's side of it (held inputs, history, missed ticks replayed after a
// reconnect). The clients run the game's own TickDriver and Rollback on a
// discrete-event clock, each with a scripted player steering from what its
// own client shows — so the rival's paddle is mispredicted all the time.
// Every confirmed tick must be identical on both clients and equal to the
// plain lockstep result of the server's stream: through mispredictions, a
// late join, a latency spike that lands inputs late, and a transport blip.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_INPUT_LEAD_TICKS } from "@vibedgames/multiplayer";
import type { JsonValue, TickClock } from "@vibedgames/multiplayer";

import type { MatchRecord } from "../src/net/match-record.ts";
import { TickDriver } from "../src/net/tick-driver.ts";
import type { TickRoom } from "../src/net/tick-driver.ts";
import { TICK_MS } from "../src/shared/constants.ts";
import { bump, paddleStep, readInput } from "../src/shared/input.ts";
import type { SlotInput } from "../src/shared/input.ts";
import { newMatch, paddleOf, simChecksum, stepSim } from "../src/shared/sim.ts";
import type { SimEvent, SimState, Slot } from "../src/shared/sim.ts";

/** Park–Miller, so every run of the test is the same run. */
const generator = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state * 48_271) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

// ---- discrete-event clock -----------------------------------------------------

interface Scheduled {
  at: number;
  run: () => void;
  seq: number;
}

/** Callbacks in time order (first scheduled first among equal times). */
const createClock = () => {
  const queue: Scheduled[] = [];
  let now = 0;
  let seq = 0;
  const at = (time: number, run: () => void): void => {
    const item = { at: Math.max(time, now), run, seq };
    seq += 1;
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const other = queue[mid];
      if (
        other !== undefined &&
        (other.at < item.at || (other.at === item.at && other.seq < item.seq))
      ) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    queue.splice(lo, 0, item);
  };
  const runUntil = (end: number): void => {
    let [next] = queue;
    while (next !== undefined && next.at <= end) {
      queue.shift();
      now = next.at;
      next.run();
      [next] = queue;
    }
    now = end;
  };
  return { at, now: () => now, runUntil };
};

type Clock = ReturnType<typeof createClock>;

/** A one-way link: each message waits LATENCY + U[0, JITTER) ms, never
 *  overtaking an earlier one (a WebSocket is a TCP stream). `extra` adds a
 *  spike; a cut link loses whatever was in flight. */
const createLink = (clock: Clock, roll: () => number, deliver: (message: Wire) => void) => {
  let last = 0;
  let generation = 0;
  let extra = 0;
  return {
    cut: (): void => {
      generation += 1;
    },
    send: (message: Wire): void => {
      const sent = generation;
      const arrival = Math.max(last, clock.now() + 50 + roll() * 25 + extra);
      last = arrival;
      clock.at(arrival, () => {
        if (sent === generation) {
          deliver(message);
        }
      });
    },
    spike: (ms: number): void => {
      extra = ms;
    },
  };
};

// ---- the tick room ------------------------------------------------------------

interface TickWire {
  kind: "tick";
  changes: Record<string, JsonValue>;
  n: number;
}
interface SyncWire {
  kind: "sync";
  log: [number, Record<string, JsonValue>][];
  n: number;
}
interface InputWire {
  from: string;
  input: JsonValue;
  kind: "input";
  n: number | undefined;
}
type Wire = TickWire | SyncWire | InputWire;

/** The party server's tick room, as apps/party runs it. */
const createServer = (clock: Clock) => {
  let n = 0;
  const held = new Map<string, JsonValue>();
  const pending = new Map<number, Map<string, JsonValue | null>>();
  /** Every tick's changes (the real room keeps the last MAX_TICK_HISTORY). */
  const log: [number, Record<string, JsonValue>][] = [];
  /** Held inputs after each tick, for the reference run. */
  const stream = new Map<number, Map<string, JsonValue>>();
  const downlinks = new Map<string, (message: Wire) => void>();

  const schedule = (id: string, input: JsonValue | null, at?: number): void => {
    const next = n + 1;
    const tick = at === undefined ? next : Math.min(Math.max(at, next), n + MAX_INPUT_LEAD_TICKS);
    const changes = pending.get(tick) ?? new Map<string, JsonValue | null>();
    pending.set(tick, changes);
    changes.set(id, input);
  };

  const runTicks = (): void => {
    const due = Math.floor(clock.now() / TICK_MS);
    while (n < due) {
      n += 1;
      const changes: Record<string, JsonValue> = {};
      for (const [id, input] of pending.get(n) ?? []) {
        if (input === null) {
          held.delete(id);
        } else {
          held.set(id, input);
        }
        changes[id] = input;
      }
      pending.delete(n);
      if (Object.keys(changes).length > 0) {
        log.push([n, changes]);
      }
      stream.set(n, new Map(held));
      for (const send of downlinks.values()) {
        send({ changes, kind: "tick", n });
      }
    }
    // Checked twice a tick, like the real room's interval.
    clock.at(clock.now() + TICK_MS / 2, runTicks);
  };
  clock.at(0, runTicks);

  return {
    /** A player admitted: from now on it hears every tick, after a sync. */
    admit: (id: string, send: (message: Wire) => void): void => {
      downlinks.set(id, send);
      send({ kind: "sync", log: [...log], n });
    },
    /** A transport drop: the seat is held, the input clears on the next tick. */
    drop: (id: string): void => {
      downlinks.delete(id);
      schedule(id, null);
    },
    receive: (message: InputWire): void => {
      schedule(message.from, message.input, message.n);
    },
    stream,
  };
};

type Server = ReturnType<typeof createServer>;

// ---- a client: the SDK's tick handling under a TickRoom -----------------------

interface ClientOptions {
  /** How far this client's server clock reads off the real one (ms). */
  clockError: number;
  fps: number;
  id: string;
}

const applyChanges = (held: Map<string, JsonValue>, changes: Record<string, JsonValue>): void => {
  for (const [id, input] of Object.entries(changes)) {
    if (input === null) {
      held.delete(id);
    } else {
      held.set(id, input);
    }
  }
};

const createClient = (clock: Clock, server: Server, roll: () => number, opts: ClientOptions) => {
  let n = -1;
  const held = new Map<string, JsonValue>();
  let log: [number, Record<string, JsonValue>][] = [];
  let heldInput: JsonValue | null = null;
  /** Sends made while disconnected, flushed when the socket is back (PartySocket queues them). */
  let queued: InputWire[] = [];
  let driver: TickDriver | null = null;
  /** Checksum of the confirmed state after each tick this client confirmed. */
  const confirmed = new Map<number, number>();
  let connected = true;

  const record = (): void => {
    if (driver === null) {
      return;
    }
    const { engine } = driver;
    for (let t = engine.confirmedTick; !confirmed.has(t); t -= 1) {
      const state = engine.stateAt(t);
      if (state === undefined) {
        break;
      }
      confirmed.set(t, simChecksum(state));
    }
  };

  const applyTick = (tick: number, changes: Record<string, JsonValue>): void => {
    if (tick <= n) {
      return;
    }
    applyChanges(held, changes);
    n = tick;
    if (Object.keys(changes).length > 0) {
      log.push([tick, changes]);
    }
    driver?.onTick(tick, Object.fromEntries(held));
    record();
  };

  const uplink = createLink(clock, roll, (message) => {
    if (message.kind === "input") {
      server.receive(message);
    }
  });

  const deliver = (message: Wire): void => {
    if (message.kind === "tick") {
      applyTick(message.n, message.changes);
    } else if (message.kind === "sync") {
      // As the SDK: back on the same timeline, the missed ticks replay in
      // order; then the held input goes out again (the room cleared it).
      const missed = new Map(message.log);
      if (n < 0) {
        log = [...message.log];
        for (const [, changes] of message.log) {
          applyChanges(held, changes);
        }
        ({ n } = message);
      } else {
        for (let tick = n + 1; tick <= message.n; tick += 1) {
          applyTick(tick, missed.get(tick) ?? {});
        }
      }
      if (heldInput !== null) {
        uplink.send({ from: opts.id, input: heldInput, kind: "input", n: undefined });
      }
    }
  };
  let downlink = createLink(clock, roll, deliver);

  const room: TickRoom = {
    clockSynced: true,
    rtt: 110,
    sendInput: (input, at) => {
      heldInput = input;
      const message: InputWire = { from: opts.id, input, kind: "input", n: at };
      if (connected) {
        uplink.send(message);
      } else {
        queued.push(message);
      }
    },
    serverNow: () => clock.now() + opts.clockError,
    get tickClock(): TickClock | null {
      return n < 0 ? null : { epoch: 0, ms: TICK_MS, n };
    },
    tickInputs: (at) => {
      const tick = at ?? n;
      if (tick < 0 || tick > n) {
        return null;
      }
      const state = new Map<string, JsonValue>();
      for (const [logged, changes] of log) {
        if (logged > tick) {
          break;
        }
        applyChanges(state, changes);
      }
      return Object.fromEntries(state);
    },
  };

  server.admit(opts.id, downlink.send);

  return {
    confirmed,
    get driver(): TickDriver | null {
      return driver;
    },
    /** Disconnect: in-flight ticks are lost; sends queue until reconnect. */
    drop: (): void => {
      connected = false;
      downlink.cut();
      server.drop(opts.id);
    },
    /** Each frame, steered by `pilot` from what this client shows. */
    play: (pilot: (view: SimState, now: number) => SlotInput): void => {
      let horizon = 0;
      const frame = (): void => {
        if (driver !== null) {
          const view = driver.engine.stateAt(Math.floor(horizon)) ?? driver.engine.confirmed;
          horizon = driver.frame(pilot(view, clock.now()));
        }
        clock.at(clock.now() + 1000 / opts.fps + (roll() - 0.5) * 2, frame);
      };
      clock.at(clock.now(), frame);
    },
    /** The socket is back: the room admits the player again, with a sync. */
    reconnect: (): void => {
      clock.at(clock.now() + 60, () => {
        connected = true;
        downlink = createLink(clock, roll, deliver);
        server.admit(opts.id, downlink.send);
        for (const message of queued) {
          uplink.send(message);
        }
        queued = [];
      });
    },
    seat: (match: MatchRecord, slot: Slot): void => {
      driver = new TickDriver(room, match, slot);
      record();
    },
    spikeUplink: (ms: number): void => {
      uplink.spike(ms);
    },
  };
};

// ---- players -------------------------------------------------------------------

/**
 * A scripted player for `slot`, steering from the state its own client
 * shows: under the ball with a wandering aim (angled returns), now and then
 * a lazy spell parked away (points get scored), serves early, power shots
 * armed when ready and sometimes cancelled.
 */
const pilotFor = (slot: Slot, roll: () => number) => {
  let aim = 0;
  let c = 0;
  let k = 0;
  let lazyUntil = 0;
  let park = 0;
  return (view: SimState, now: number): SlotInput => {
    const paddle = paddleOf(view, slot);
    if (roll() < 0.01) {
      aim = (roll() * 2 - 1) * 0.6;
    }
    if (roll() < 0.001) {
      lazyUntil = now + 2000;
      park = roll() < 0.5 ? -4 : 4;
    }
    if (view.phase !== "rally" && roll() < 0.01) {
      c = bump(c);
    }
    if (view.phase === "rally" && paddle.charge.kind === "ready" && roll() < 0.05) {
      c = bump(c);
    }
    if (paddle.charge.kind === "armed" && roll() < 0.003) {
      k = bump(k);
    }
    const target = now < lazyUntil ? park : view.ball.x + aim;
    return { c, k, x: paddleStep(target) };
  };
};

// ---- the match -------------------------------------------------------------------

const MATCH: MatchRecord = {
  a: "A",
  b: "B",
  epoch: 0,
  id: 1,
  scoreA: 0,
  scoreB: 0,
  seed: 20_241,
  start: 30,
};

/** The plain lockstep result: the server's stream stepped once, no prediction. */
const reference = (server: Server, last: number) => {
  const state = newMatch({
    autoServe: true,
    scoreA: MATCH.scoreA,
    scoreB: MATCH.scoreB,
    seed: MATCH.seed,
    tick: MATCH.start - 1,
  });
  const sums = new Map<number, number>();
  const events: SimEvent[] = [];
  const absentB: number[] = [];
  for (let tick = MATCH.start; tick <= last; tick += 1) {
    const held = server.stream.get(tick) ?? new Map<string, JsonValue>();
    stepSim(state, readInput(held.get(MATCH.a)), readInput(held.get(MATCH.b)));
    sums.set(tick, simChecksum(state));
    events.push(...state.events);
    if (!state.b.human) {
      absentB.push(tick);
    }
  }
  return { absentB, events, sums };
};

type Client = ReturnType<typeof createClient>;

/** The client that joins later, once it exists. */
interface LateJoiner {
  b: Client | null;
}

interface Run {
  a: Client;
  b: Client;
  server: Server;
  last: number;
  /** A's lead (ms) just before its uplink spikes, and as the spike ends. */
  leadBefore: number;
  leadSpiked: number;
}

/**
 * 60 s of match: A at 60 fps, B at 144 fps, clocks a few ms off the
 * server's. B joins late (it replays the ticks it missed), drops for 2 s
 * mid-match (its paddle is the AI's meanwhile, the missed ticks replay on
 * return) and A's uplink spikes by 120 ms for 1.5 s (its inputs land late).
 */
const playMatch = (seed: number): Run => {
  const clock = createClock();
  const roll = generator(seed);
  const server = createServer(clock);
  const a = createClient(clock, server, roll, { clockError: 6, fps: 60, id: MATCH.a });
  a.seat(MATCH, 0);
  a.play(pilotFor(0, roll));
  const late: LateJoiner = { b: null };
  clock.at(1500, () => {
    late.b = createClient(clock, server, roll, { clockError: -7, fps: 144, id: MATCH.b });
  });
  clock.at(1700, () => {
    late.b?.seat(MATCH, 1);
    late.b?.play(pilotFor(1, roll));
  });
  clock.at(20_000, () => late.b?.drop());
  clock.at(22_000, () => late.b?.reconnect());
  let leadBefore = 0;
  let leadSpiked = 0;
  clock.at(35_000, () => {
    leadBefore = a.driver?.lead ?? 0;
    a.spikeUplink(120);
  });
  clock.at(36_500, () => {
    leadSpiked = a.driver?.lead ?? 0;
    a.spikeUplink(0);
  });
  clock.runUntil(60_000);
  const { b } = late;
  assert.ok(b !== null);
  const last = Math.min(a.driver?.engine.confirmedTick ?? 0, b.driver?.engine.confirmedTick ?? 0);
  return { a, b, last, leadBefore, leadSpiked, server };
};

const run = playMatch(7);

test("both clients hold the same confirmed state on every tick, and it is the lockstep result", (t) => {
  const { a, b, last, server } = run;
  const truth = reference(server, last);
  let compared = 0;
  for (let tick = MATCH.start; tick <= last; tick += 1) {
    const sumA = a.confirmed.get(tick);
    const sumB = b.confirmed.get(tick);
    const want = truth.sums.get(tick);
    assert.equal(sumA, want, `client A, tick ${tick}`);
    if (sumB !== undefined) {
      assert.equal(sumB, want, `client B, tick ${tick}`);
      compared += 1;
    }
  }
  // B confirmed every tick from its late join on, replays included (the
  // first few it caught up on had left its history before they were read).
  assert.ok(compared > last - MATCH.start - 20, `compared ${compared} ticks`);
  t.diagnostic(`${last - MATCH.start + 1} ticks; ${compared} compared across both clients`);
  assert.equal(a.driver?.broken, false);
  assert.equal(b.driver?.broken, false);
});

test("the rival's paddle was mispredicted throughout, and rollback repaired every guess", (t) => {
  for (const client of [run.a, run.b]) {
    const stats = client.driver?.engine.stats;
    assert.ok(stats !== undefined);
    t.diagnostic(
      `mispredicted ${stats.mispredicted}, resimulated ${stats.resimulated}, deepest ${stats.deepest}, own late ${stats.ownLate}`,
    );
    assert.ok(stats.mispredicted > 500, `mispredicted ${stats.mispredicted}`);
    assert.ok(stats.resimulated > 2000, `resimulated ${stats.resimulated}`);
    assert.ok(stats.deepest >= 6, `deepest ${stats.deepest}`);
  }
});

test("inputs that land late are rolled back too, and the lead grows to cover the spike", (t) => {
  const driverA = run.a.driver;
  assert.ok(driverA !== null);
  assert.ok(driverA.engine.stats.ownLate > 0, `own late ${driverA.engine.stats.ownLate}`);
  assert.ok(run.leadSpiked > run.leadBefore + 40, `lead ${run.leadBefore} → ${run.leadSpiked} ms`);
  t.diagnostic(`A's lead ${Math.round(run.leadBefore)} → ${Math.round(run.leadSpiked)} ms`);
});

test("a dropped player's paddle is the AI's until the stream carries them again", () => {
  const truth = reference(run.server, run.last);
  const dropTick = Math.floor(20_000 / TICK_MS);
  const backTick = Math.floor(22_500 / TICK_MS);
  const absent = truth.absentB.filter((tick) => tick > dropTick);
  assert.ok(absent.length > 60, `AI held B for ${absent.length} ticks`);
  assert.ok(
    absent.every((tick) => tick < backTick + 30),
    "B steers again after the blip",
  );
});

test("the match was played: returns from both paddles, angled shots, points", () => {
  const { events } = reference(run.server, run.last);
  const hits = events.filter((e) => e.kind === "hit");
  assert.ok(hits.some((e) => e.slot === 0) && hits.some((e) => e.slot === 1));
  assert.ok(hits.length > 15, `${hits.length} returns`);
  assert.ok(
    hits.some((e) => e.shot !== "flat"),
    "no angled shot",
  );
  assert.ok(events.filter((e) => e.kind === "point").length >= 3, "too few points");
});

test("a gap in the tick stream breaks the timeline instead of guessing past it", () => {
  const clock = createClock();
  const server = createServer(clock);
  const client = createClient(clock, server, generator(3), { clockError: 0, fps: 60, id: MATCH.a });
  clock.runUntil(700);
  client.seat(MATCH, 0);
  const { driver } = client;
  assert.ok(driver !== null);
  const next = driver.engine.confirmedTick + 1;
  driver.onTick(next + 1, {});
  assert.equal(driver.broken, true);
});
