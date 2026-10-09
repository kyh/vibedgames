// Guest-side client prediction (pure — no Phaser, sim-testable).
//
// Online, the guest runs its OWN PlayerBody through the real fixed-step sim on
// local input, so movement responds the frame a key goes down instead of after
// a host round trip. Every sim tick it records the input it consumed (packed,
// net/uplink.ts) and the body state that resulted, and ships the inputs to the
// host, which steps its copy of the body once per tick with the same values
// (net/guest-copy.ts) — the two sims agree by construction.
//
// The host stays authoritative, and reaches into its copy in two ways:
//   edges   a hit, a stomp bounce, a last-stand down/revive, a duel death or
//           respawn, a versus freeze. Each arrives tagged with the input tick
//           after which the host applied it; the guest rewinds its history to
//           that tick, applies the same edge and re-simulates its inputs to
//           now. The result is where the host's copy will be once it has
//           caught up — the caller eases the visible jump out on the sprite.
//   drift   anything else (a starved host coasting the copy, an admission from
//           a stale checkpoint). Each snapshot carries the copy's position and
//           the newest tick it applied (`ack`); the Reconciler compares it with
//           where this body was after that same tick — never with where it is
//           now, which would read a whole round trip of motion as error — and
//           eases the difference into the body.

import { Reconciler } from "@vibedgames/multiplayer";

import { STEP } from "../config";
import type { BodyInput, PlayerBody, PlayerBodyCheckpoint } from "../entities/player-body";
import type { GuestEdge, NetInputs } from "./snapshot";
import {
  advanceTick,
  CLEAR,
  FROZEN,
  frozenBits,
  heldBits,
  mergePresses,
  pressBits,
  STOMP,
} from "./uplink";

/** One sim tick in ms — the reconciler's clock is `tick × STEP_MS`. */
export const STEP_MS = STEP * 1000;
// Ticks of history kept (1.5 s): a round trip, the host's input buffer and a
// snapshot interval, with room to spare.
const HISTORY = 90;
// px. Positions cross the wire at 0.1 px and the sims agree exactly, so
// anything past this is a real divergence.
const DEAD_ZONE = 0.5;
// px. A drift this large is a teleport no edge explained — apply it at once.
const SNAP_DISTANCE = 64;

interface Tick {
  seq: number;
  bits: number;
  state: PlayerBodyCheckpoint;
}

/** What an edge replay did to the body: the visible jump (old − new
 * position), and whether it carried a hit or a teleport. */
export interface Replayed {
  dx: number;
  dy: number;
  hurt: boolean;
  teleport: boolean;
}

export class Prediction {
  /** The newest predicted tick. */
  seq = 0;
  /** The drift correction applied on the latest step (diagnostics, the sim harness). */
  readonly correction = { x: 0, y: 0 };
  private held = 0;
  private presses = 0;
  private clearing = false;
  private outbox: number[] = [];
  private readonly ticks: Tick[] = [];
  private readonly reconciler = new Reconciler({
    deadZone: DEAD_ZONE,
    historyMs: HISTORY * STEP_MS,
    snapDistance: SNAP_DISTANCE,
  });
  // newest edge applied; null takes the next snapshot's edges as already in
  // the body (admission restored it from a checkpoint)
  private applied: number | null = null;

  /** A fresh authority: the body was just restored from its checkpoint, and
   * nothing predicted before it is worth sending. */
  admit(): void {
    this.reset();
    this.outbox = [];
    this.presses = 0;
    this.applied = null;
  }

  /** The body teleported (room build, respawn): forget its trajectory. On a
   * room change, flush first — unsent ticks belong to the room it left. */
  reset(): void {
    this.ticks.length = 0;
    this.reconciler.clear();
    this.correction.x = 0;
    this.correction.y = 0;
  }

  /** Per frame, before stepping: the local sample, and whether the body is
   * held still (versus countdown / match end). Presses accumulate until a
   * step consumes them, so a high-refresh frame with no step loses none. */
  sample(input: BodyInput, frozen: boolean): void {
    this.held = heldBits(input) + (frozen ? FROZEN : 0);
    this.presses = mergePresses(this.presses, pressBits(input));
  }

  /** Drop queued input before the next tick (pause, reconnect) — the host's
   * copy does the same when it reaches that tick. */
  dropQueued(body: PlayerBody): void {
    body.clearInput();
    this.presses = 0;
    this.clearing = true;
  }

  /** One fixed step of the predicted body; `stomps` judges a co-op stomp. */
  step(body: PlayerBody, stomps?: (body: PlayerBody) => boolean): void {
    this.seq += 1;
    let bits = this.held + this.presses + (this.clearing ? CLEAR : 0);
    this.presses = 0;
    this.clearing = false;
    advanceTick(body, bits);
    // `stomps` judges the feet against the heads this screen shows. A hit
    // bounces now and rides the tick, so the host's copy bounces on it too.
    if (stomps?.(body)) {
      body.applyEdge({ kind: "bounce" });
      bits += STOMP;
    }
    const fix = this.reconciler.step(body.x, body.y, STEP_MS, this.seq * STEP_MS);
    if (fix.x !== 0 || fix.y !== 0) {
      body.shift(fix.x, fix.y);
    }
    this.correction.x = fix.x;
    this.correction.y = fix.y;
    this.ticks.push({ bits, seq: this.seq, state: body.checkpoint() });
    if (this.ticks.length > HISTORY) {
      this.ticks.shift();
    }
    this.outbox.push(bits);
  }

  /** The ticks not yet sent, as one `in` message stamped `t` (the room's
   * server time the newest one's step ended at) — once two are waiting (30 Hz
   * at the 60 Hz sim), or now when forced (leaving a room). */
  flush(room: number, t: number, force = false): NetInputs | null {
    if (this.outbox.length === 0 || (!force && this.outbox.length < 2)) {
      return null;
    }
    const msg = { room, seq: this.seq, t, ticks: this.outbox };
    this.outbox = [];
    return msg;
  }

  /** The host's copy stood at (x, y) after applying tick `ack`, then coasted
   * `age` more steps without input. */
  reconcile(x: number, y: number, ack: number, age: number): void {
    const [first] = this.ticks;
    // Ticks from before a room change or a replay have no history to compare.
    if (!first || ack < first.seq || ack > this.seq) {
      return;
    }
    this.reconciler.reconcile(x, y, (ack + age) * STEP_MS);
  }

  /** Apply the host's edges newer than the last applied, each at the tick it
   * happened, and re-simulate the inputs since. Null when nothing was new. */
  replay(body: PlayerBody, edges: GuestEdge[]): Replayed | null {
    let newest = this.applied ?? -1;
    const fresh: GuestEdge[] = [];
    for (const e of edges) {
      if (this.applied !== null && e.n > this.applied) {
        fresh.push(e);
      }
      newest = Math.max(newest, e.n);
    }
    this.applied = newest;
    if (fresh.length === 0) {
      return null;
    }
    const ordered = fresh.toSorted((a, b) => a.n - b.n);
    const x0 = body.x;
    const y0 = body.y;
    const [first] = ordered;
    const from = first ? this.ticks.findIndex((t) => t.seq === first.tick) : -1;
    this.reconciler.clear();
    if (from === -1) {
      // Older than the history (a stall, an admission): there is no tick to
      // rewind to, so apply them now and compare only what happens next.
      body.silently(() => {
        for (const e of ordered) {
          if (e.edge) {
            body.applyEdge(e.edge);
          }
        }
      });
      this.ticks.length = 0;
    } else {
      body.silently(() => this.rewrite(body, from, ordered));
      // The trajectory changed: later acks are compared with the new one.
      for (const t of this.ticks) {
        this.reconciler.step(t.state.x, t.state.y, 0, t.seq * STEP_MS);
      }
    }
    // Prediction is movement only: combat intents resolve on the host.
    body.pendingShot = null;
    body.pendingHeal = 0;
    return {
      dx: x0 - body.x,
      dy: y0 - body.y,
      hurt: ordered.some((e) => e.edge?.kind === "hurt"),
      teleport: ordered.some((e) => e.edge?.kind === "spawn"),
    };
  }

  // Rewind to tick `from`, then re-simulate forward, applying each edge right
  // after the tick it is tagged with — the order the host applied them in.
  private rewrite(body: PlayerBody, from: number, edges: GuestEdge[]) {
    let next = 0;
    for (let i = from; i < this.ticks.length; i += 1) {
      const tick = this.ticks[i];
      if (!tick) {
        continue;
      }
      if (i === from) {
        body.restore(tick.state);
      } else {
        advanceTick(body, tick.bits);
      }
      for (let e = edges[next]; e && e.tick <= tick.seq; e = edges[next]) {
        next += 1;
        if (e.edge) {
          body.applyEdge(e.edge);
        } else {
          // The host neutralised the ticks it consumed after this one (a
          // versus freeze the guest had not seen yet).
          for (const later of this.ticks.slice(i + 1)) {
            later.bits = frozenBits(later.bits);
          }
        }
      }
      tick.state = body.checkpoint();
    }
  }
}
