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
// The copy plays the ticks back on the guest's own timeline, the way an
// Interpolator draws a puppet: the guest stamps each send with the room's
// server time its newest tick's step ended at, a tick after the one before
// (scenes/guest-sync.ts); a RemoteClock learns from the arrivals how late
// they land; and each host step applies the ticks the guest had stepped by
// the moment it stands for, as far behind the stamps as the stream needs
// (RemoteClock.hold: each send interval plus how late the next one lands).
// So the copy moves a tick a host step, as evenly as the guest moved, and a
// jittery route costs a little delay instead of stalls and double steps.
// Ticks that fall due together (a stalled link or host) are taken a few a
// step until the copy is back on time; starved for long (a hidden tab, a
// stalled link), it coasts on neutral input so it falls and stops rather than
// hanging mid-air.
//
// A co-op stomp is the guest's call — judged on its screen, flagged on the
// tick (net/uplink.ts STOMP) — so the copy bounces on that very tick and the
// host only owes the damage. Everything else the host does to the copy (a
// hit, a duel stomp, a downed or revived body, a duel death or respawn) is
// journaled by PlayerBody and logged here against the newest tick applied, so
// the guest can replay it at the same point in its own history.

import { RemoteClock } from "@vibedgames/multiplayer";

import { STEP } from "../config";
import type { BodyEdge, PlayerBody } from "../entities/player-body";
import { encodeEdge } from "./snapshot";
import type { NetAck, NetEdge, NetInputs } from "./snapshot";
import { advanceTick, frozenBits, isFrozen, isStomp, unpackInput } from "./uplink";

// ms of the guest's sim per input tick
const TICK_MS = STEP * 1000;
// the least the copy trails the guest's stamps: one 30 Hz send's worth of
// ticks, what a quiet link needs while the clock has yet to measure it
const DELAY_MS = 2 * TICK_MS;
// more ticks due than this at once is a backlog: the copy takes a quarter of
// it a step (at least this many) until it is back on time, not all in one jump
const BACKLOG = 2;
// host steps without input before the copy coasts (500 ms): long enough that
// a guest's frame hitch never reads as a hidden tab
const COAST_AFTER = 30;
// host steps (2 s) an edge stays in the log; every snapshot repeats it, so one
// sent in a snapshot the guest never read still lands
const EDGE_KEEP = 120;

interface Waiting {
  seq: number;
  bits: number;
  // when the guest stepped it, in its stamps' server time
  at: number;
}

export class GuestCopy {
  /** Newest guest tick applied to the copy in this room; -1 before the first. */
  ack = -1;
  /** Host steps the copy has coasted past `ack` without input. */
  age = 0;
  // the guest's sends as they reach this tab: how long they take, and how
  // late they land (one stream, whichever room the copy is in)
  private readonly clock = new RemoteClock();
  private readonly waiting: Waiting[] = [];
  private newest = -1;
  private room = -1;
  private starved = 0;
  private neutralising = false;
  private rematch = false;
  private stomps = 0;
  private n = 0;
  // host steps taken: the edge log's clock
  private steps = 0;
  private readonly log: { at: number; row: NetEdge }[] = [];

  /** The guest's sends reach this tab by a new route (the guest back from a
   * drop, or this tab back from its own): measure it afresh. The playback
   * eases onto the new route rather than jumping. */
  relearn(): void {
    this.clock.relearn();
  }

  /** The copy was placed in room `room`: ticks the guest sent for any other no longer apply. */
  enter(room: number): void {
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
  receive(msg: NetInputs, room: number, receivedAt: number): void {
    this.enter(room);
    this.clock.observe(msg.t, receivedAt);
    if (msg.room !== room) {
      return;
    }
    const first = msg.seq - msg.ticks.length + 1;
    for (const [i, bits] of msg.ticks.entries()) {
      const seq = first + i;
      if (seq > this.newest) {
        // The stamp is the newest tick's; each earlier one ended a tick before.
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
  step(body: PlayerBody, frozen: boolean, now: number): boolean {
    body.journal ??= [];
    this.steps += 1;
    const playAt = this.clock.now(now) - Math.max(DELAY_MS, this.clock.hold(now, DELAY_MS));
    let due = 0;
    while ((this.waiting[due]?.at ?? Number.POSITIVE_INFINITY) <= playAt) {
      due += 1;
    }
    if (due === 0) {
      // Ticks in hand are on their way in; only an empty stream starves.
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
  drain(body: PlayerBody): void {
    for (const edge of body.journal?.splice(0) ?? []) {
      this.record(edge);
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
  report(row: number): NetAck {
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
