import { Reconciler } from "@vibedgames/multiplayer";

import { STEP } from "../config";
import type { BodyInput, PlayerBody, PlayerBodyCheckpoint } from "../entities/player-body";
import type { GuestEdge } from "./snapshot";
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
const HISTORY = 90;
const DEAD_ZONE = 0.5;
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
  private applied: number | null = null;

  /** A fresh authority: the body was just restored from its checkpoint, and
   * nothing predicted before it is worth sending. */
  admit() {
    this.reset();
    this.outbox = [];
    this.presses = 0;
    this.applied = null;
  }

  /** The body teleported (room build, respawn): forget its trajectory. On a
   * room change, flush first — unsent ticks belong to the room it left. */
  reset() {
    this.ticks.length = 0;
    this.reconciler.clear();
    this.correction.x = 0;
    this.correction.y = 0;
  }

  /** Per frame, before stepping: the local sample, and whether the body is
   * held still (versus countdown / match end). Presses accumulate until a
   * step consumes them, so a high-refresh frame with no step loses none. */
  sample(input: BodyInput, frozen: boolean) {
    this.held = heldBits(input) + (frozen ? FROZEN : 0);
    this.presses = mergePresses(this.presses, pressBits(input));
  }

  /** Drop queued input before the next tick (pause, reconnect) — the host's
   * copy does the same when it reaches that tick. */
  dropQueued(body: PlayerBody) {
    body.clearInput();
    this.presses = 0;
    this.clearing = true;
  }

  /** One fixed step of the predicted body; `stomps` judges a co-op stomp. */
  step(body: PlayerBody, stomps?: (body: PlayerBody) => boolean) {
    this.seq += 1;
    let bits = this.held + this.presses + (this.clearing ? CLEAR : 0);
    this.presses = 0;
    this.clearing = false;
    advanceTick(body, bits);

    if (stomps?.(body) === true) {
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
  flush(room: number, t: number, force = false) {
    if (this.outbox.length === 0 || (!force && this.outbox.length < 2)) {
      return null;
    }

    const msg = { room, seq: this.seq, t, ticks: this.outbox };
    this.outbox = [];

    return msg;
  }

  /** The host's copy stood at (x, y) after applying tick `ack`, then coasted
   * `age` more steps without input. */
  reconcile(x: number, y: number, ack: number, age: number) {
    const [first] = this.ticks;

    if (!first || ack < first.seq || ack > this.seq) {
      return;
    }

    this.reconciler.reconcile(x, y, (ack + age) * STEP_MS);
  }

  /** Apply the host's edges newer than the last applied, each at the tick it
   * happened, and re-simulate the inputs since. Null when nothing was new. */
  replay(body: PlayerBody, edges: GuestEdge[]) {
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
      body.silently(() => {
        for (const e of ordered) {
          if (e.edge) {
            body.applyEdge(e.edge);
          }
        }
      });
      this.ticks.length = 0;
    } else {
      body.silently(() => {
        this.rewrite(body, from, ordered);
      });

      for (const t of this.ticks) {
        this.reconciler.step(t.state.x, t.state.y, 0, t.seq * STEP_MS);
      }
    }

    body.pendingShot = null;
    body.pendingHeal = 0;

    return {
      dx: x0 - body.x,
      dy: y0 - body.y,
      hurt: ordered.some((e) => e.edge?.kind === "hurt"),
      teleport: ordered.some((e) => e.edge?.kind === "spawn"),
    };
  }

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
          for (const later of this.ticks.slice(i + 1)) {
            later.bits = frozenBits(later.bits);
          }
        }
      }

      tick.state = body.checkpoint();
    }
  }
}
