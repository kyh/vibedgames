// Host side of a guest's body (pure — no Phaser, sim-testable).
//
// The host's copy of a guest's body advances once per guest input tick, with
// exactly the packed input the guest's own prediction consumed for that tick
// (net/uplink.ts), never once per host frame on whatever input arrived last.
// That is what keeps the guest's prediction right: the host repeats the
// guest's sim instead of approximating it, so a bunched or late packet delays
// the copy without bending its path, and the copy keeps moving through the
// host's hit-stop exactly as the guest's body never stopped.
//
// A short jitter buffer smooths arrival: the copy starts consuming once a few
// ticks wait, sheds a backlog several ticks a step, and — starved for long (a
// hidden tab, a stalled link) — coasts on neutral input so it falls and stops
// rather than hanging mid-air.
//
// A co-op stomp is the guest's call — judged on its screen, flagged on the
// tick (net/uplink.ts STOMP) — so the copy bounces on that very tick and the
// host only owes the damage. Everything else the host does to the copy (a
// hit, a duel stomp, a downed or revived body, a duel death or respawn) is
// journaled by PlayerBody and logged here against the newest tick applied, so
// the guest can replay it at the same point in its own history.

import type { BodyEdge, PlayerBody } from "../entities/player-body";
import { encodeEdge } from "./snapshot";
import type { NetAck, NetEdge, NetInputs } from "./snapshot";
import { advanceTick, frozenBits, isFrozen, isStomp, unpackInput } from "./uplink";

// ticks waiting before the copy starts (or restarts, after starving) — two
// 30 Hz sends' worth, which covers ~±15 ms of arrival jitter
const TARGET = 2;
// waiting past this, the copy takes extra ticks a step until it is back in
// range — two for ordinary bunching, more for a host whose frames run longer
// than its step cap allows (it would otherwise fall ever further behind)
const BACKLOG = TARGET + 2;
// host steps without input before the copy coasts (500 ms): long enough that
// a guest's frame hitch never reads as a hidden tab
const COAST_AFTER = 30;
// host ms an edge stays in the log; every snapshot repeats it, so one sent
// in a snapshot the guest never read still lands
const EDGE_KEEP_MS = 2000;

interface Waiting {
  seq: number;
  bits: number;
}

export class GuestCopy {
  /** Newest guest tick applied to the copy in this room; -1 before the first. */
  ack = -1;
  /** Host steps the copy has coasted past `ack` without input. */
  age = 0;
  private readonly waiting: Waiting[] = [];
  private newest = -1;
  private room = -1;
  private primed = false;
  private starved = 0;
  private neutralising = false;
  private rematch = false;
  private stomps = 0;
  private n = 0;
  private readonly log: { at: number; row: NetEdge }[] = [];

  /** The copy was placed in room `room`: ticks the guest sent for any other no longer apply. */
  enter(room: number): void {
    if (room === this.room) {
      return;
    }
    this.room = room;
    this.waiting.length = 0;
    this.ack = -1;
    this.age = 0;
    this.primed = false;
    this.starved = 0;
  }

  /** An `in` message from the guest, while the copy is in `room`. */
  receive(msg: NetInputs, room: number): void {
    this.enter(room);
    if (msg.room !== room) {
      return;
    }
    const first = msg.seq - msg.ticks.length + 1;
    for (const [i, bits] of msg.ticks.entries()) {
      const seq = first + i;
      if (seq > this.newest) {
        this.waiting.push({ bits, seq });
        this.newest = seq;
      }
    }
  }

  /**
   * One host sim step: advance the copy by the ticks due now. `frozen`: the
   * host is holding input (versus countdown / match end); a tick the guest
   * sent before it saw that is neutralised, and the guest told to do the same.
   * `now` is the host clock (ms). Returns whether the copy moved.
   */
  step(body: PlayerBody, frozen: boolean, now: number): boolean {
    body.journal ??= [];
    if (this.waiting.length >= TARGET) {
      this.primed = true;
    }
    if (!this.primed || this.waiting.length === 0) {
      this.primed = false;
      this.starved += 1;
      if (this.starved <= COAST_AFTER) {
        return false;
      }
      advanceTick(body, 0);
      this.age += 1;
      return true;
    }
    this.starved = 0;
    const behind = this.waiting.length;
    const count = behind > BACKLOG ? Math.max(2, Math.ceil((behind - TARGET) / 4)) : 1;
    for (const tick of this.waiting.splice(0, count)) {
      let { bits } = tick;
      if (frozen && !isFrozen(bits)) {
        if (!this.neutralising) {
          this.record(null, now);
        }
        this.neutralising = true;
        bits = frozenBits(bits);
      } else if (!frozen) {
        this.neutralising = false;
      }
      // Raw keys survive a freeze: a press during match end asks for a rematch.
      this.rematch ||= unpackInput(tick.bits).attackPressed;
      this.stomps += isStomp(bits) ? 1 : 0;
      advanceTick(body, bits);
      this.ack = tick.seq;
      this.age = 0;
    }
    return true;
  }

  /** After the host's sim step: log what combat did to the copy. */
  drain(body: PlayerBody, now: number): void {
    for (const edge of body.journal?.splice(0) ?? []) {
      this.record(edge, now);
    }
  }

  /** A stomp the guest judged on its screen landed in a tick just applied —
   * the copy already bounced; the host owes the damage. One per call. */
  takeStomp(): boolean {
    if (this.stomps === 0) {
      return false;
    }
    this.stomps -= 1;
    return true;
  }

  /** Whether the guest pressed attack since the last ask (versus rematch). */
  takeRematch(): boolean {
    const pressed = this.rematch;
    this.rematch = false;
    return pressed;
  }

  /** The copy's line in a snapshot: its player row index, ack and live edges. */
  report(row: number, now: number): NetAck {
    while (this.log.length > 0 && now - (this.log[0]?.at ?? now) > EDGE_KEEP_MS) {
      this.log.shift();
    }
    return { ack: this.ack, age: this.age, edges: this.log.map((e) => e.row), row };
  }

  private record(edge: BodyEdge | null, now: number) {
    this.n += 1;
    this.log.push({ at: now, row: encodeEdge(this.n, this.ack, edge) });
  }
}
