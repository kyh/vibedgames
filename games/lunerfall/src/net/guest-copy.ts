import { RemoteClock } from "@vibedgames/multiplayer";

import { STEP } from "../config";
import type { BodyEdge, PlayerBody } from "../entities/player-body";
import { encodeEdge } from "./snapshot";
import type { NetEdge, NetInputs } from "./snapshot";
import { advanceTick, frozenBits, isFrozen, isStomp, unpackInput } from "./uplink";

const TICK_MS = STEP * 1000;
const DELAY_MS = 2 * TICK_MS;
const BACKLOG = 2;
const COAST_AFTER = 30;
const EDGE_KEEP = 120;

interface Waiting {
  seq: number;
  bits: number;
  at: number;
}

export class GuestCopy {
  /** Newest guest tick applied to the copy in this room; -1 before the first. */
  ack = -1;
  /** Host steps the copy has coasted past `ack` without input. */
  age = 0;
  private readonly clock = new RemoteClock();
  private readonly waiting: Waiting[] = [];
  private newest = -1;
  private room = -1;
  private starved = 0;
  private neutralising = false;
  private rematch = false;
  private stomps = 0;
  private n = 0;
  private steps = 0;
  private readonly log: { at: number; row: NetEdge }[] = [];

  /** The guest's sends reach this tab by a new route (the guest back from a
   * drop, or this tab back from its own): measure it afresh. The playback
   * eases onto the new route rather than jumping. */
  relearn() {
    this.clock.relearn();
  }

  /** The copy was placed in room `room`: ticks the guest sent for any other no longer apply. */
  enter(room: number) {
    if (room === this.room) {
      return;
    }

    this.room = room;
    this.waiting.length = 0;
    this.ack = -1;
    this.age = 0;
    this.starved = 0;
  }

  /** An `in` message from the guest, landed at `receivedAt` (this tab's
   * clock), while the copy is in `room`. */
  receive(msg: NetInputs, room: number, receivedAt: number) {
    this.enter(room);
    this.clock.observe(msg.t, receivedAt);

    if (msg.room !== room) {
      return;
    }

    const first = msg.seq - msg.ticks.length + 1;

    for (const [i, bits] of msg.ticks.entries()) {
      const seq = first + i;

      if (seq > this.newest) {
        this.waiting.push({ at: msg.t - (msg.seq - seq) * TICK_MS, bits, seq });
        this.newest = seq;
      }
    }
  }

  /**
   * One host sim step, ending at `now` on this tab's clock: advance the copy
   * by the ticks due by then. `frozen`: the host is holding input (versus
   * countdown / match end); a tick the guest sent before it saw that is
   * neutralised, and the guest told to do the same. Returns whether the copy
   * moved.
   */
  step(body: PlayerBody, frozen: boolean, now: number) {
    body.journal ??= [];
    this.steps += 1;
    const playAt = this.clock.now(now) - Math.max(DELAY_MS, this.clock.hold(now, DELAY_MS));
    let due = 0;

    while ((this.waiting[due]?.at ?? Number.POSITIVE_INFINITY) <= playAt) {
      due += 1;
    }

    if (due === 0) {
      this.starved = this.waiting.length > 0 ? 0 : this.starved + 1;

      if (this.starved <= COAST_AFTER) {
        return false;
      }

      advanceTick(body, 0);
      this.age += 1;

      return true;
    }

    this.starved = 0;
    const count = due > BACKLOG ? Math.max(BACKLOG, Math.ceil(due / 4)) : due;

    for (const tick of this.waiting.splice(0, count)) {
      let { bits } = tick;

      if (frozen && !isFrozen(bits)) {
        if (!this.neutralising) {
          this.record(null);
        }

        this.neutralising = true;
        bits = frozenBits(bits);
      } else if (!frozen) {
        this.neutralising = false;
      }

      this.rematch ||= unpackInput(tick.bits).attackPressed;
      this.stomps += isStomp(bits) ? 1 : 0;
      advanceTick(body, bits);
      this.ack = tick.seq;
      this.age = 0;
    }

    return true;
  }

  /** After the host's sim step: log what combat did to the copy. */
  drain(body: PlayerBody) {
    for (const edge of body.journal?.splice(0) ?? []) {
      this.record(edge);
    }
  }

  /** A stomp the guest judged on its screen landed in a tick just applied —
   * the copy already bounced; the host owes the damage. One per call. */
  takeStomp() {
    if (this.stomps === 0) {
      return false;
    }

    this.stomps -= 1;

    return true;
  }

  /** Whether the guest pressed attack since the last ask (versus rematch). */
  takeRematch() {
    const pressed = this.rematch;
    this.rematch = false;

    return pressed;
  }

  /** The copy's line in a snapshot: its player row index, ack and live edges. */
  report(row: number) {
    while (this.log.length > 0 && this.steps - (this.log[0]?.at ?? this.steps) > EDGE_KEEP) {
      this.log.shift();
    }

    return { ack: this.ack, age: this.age, edges: this.log.map((e) => e.row), row };
  }

  private record(edge: BodyEdge | null) {
    this.n += 1;
    this.log.push({ at: this.steps, row: encodeEdge(this.n, this.ack, edge) });
  }
}
