// One match on the tick room. The room's tick stream is confirmed into the
// rollback engine as it arrives; each frame this client predicts up to a
// horizon a little ahead of the server's clock — its lead — and sends its
// own input for the tick at that horizon. An input sent `lead` ms early
// reaches the room before the room reaches its tick, so this player's paddle
// answers at once and lands on the same tick everywhere; the rival's
// inputs, a lead plus a trip behind, are predicted and rolled back. The
// rival's paddle is drawn from confirmed ticks only, through an
// Interpolator on the tick stream's own clock: never a guess, and smooth
// however the ticks bunch on the way.

import { Interpolator, RemoteClock, lerp } from "@vibedgames/multiplayer";
import type { JsonValue, TickClock } from "@vibedgames/multiplayer";

import { TICK_MS } from "../shared/constants";
import { encodeInput, readInput, sameInput } from "../shared/input";
import type { SlotInput } from "../shared/input";
import { newMatch, paddleOf } from "../shared/sim";
import type { Slot } from "../shared/sim";
import type { MatchRecord } from "./match-record";
import { Rollback } from "./rollback";
import type { SlotInputs } from "./rollback";

/** What a match needs from the tick room: NetSession in the game, a simulated room in the tests. */
export interface TickRoom {
  readonly clockSynced: boolean;
  /** Fastest recent round trip (ms); NaN until measured. */
  readonly rtt: number;
  readonly tickClock: TickClock | null;
  serverNow: () => number;
  sendInput: (input: JsonValue, n?: number) => void;
  tickInputs: (n?: number) => Record<string, JsonValue> | null;
}

/** The lead at first: half the round trip plus the jitter a link adds on
 *  top of its fastest trip and a frame. */
const START_MARGIN_MS = 40;
/** Half a round trip, before one is measured. */
const DEFAULT_HALF_RTT_MS = 50;
/** The lead's bounds. The floor is a frame and the clock's error; the
 *  ceiling keeps the rival's predicted stretch (the lead plus a trip) well
 *  inside MAX_PREDICT_TICKS, past which the picture would stall. */
const MIN_LEAD_MS = 20;
const MAX_LEAD_MS = 250;
/** Each tick an own input lands late on lengthens the lead this much at
 *  once; each own change that lands on time shortens it a little. The lead
 *  settles where about one change in twenty lands a tick late — a one-tick
 *  rewind of a paddle the player sees from the input anyway — and it follows
 *  what actually reaches the room in time, whatever the measured round trip
 *  or the clock's offset error say. */
const LATE_STEP_MS = 8;
const ON_TIME_STEP_MS = 0.4;
/** A clock that jumps back further than this (ticks) moves the horizon back too. */
const SNAP_TICKS = 30;
/** The least the rival's paddle is drawn behind the newest confirmed tick
 *  (ms): three ticks. Its clock lengthens that to what the stream needs. */
const RIVAL_DELAY_MS = 50;

/** Every slot's input on a tick, from the room's per-player inputs. */
const slotInputs = (record: MatchRecord, inputs: Record<string, JsonValue> | null): SlotInputs => [
  readInput(inputs?.[record.a]),
  readInput(inputs?.[record.b]),
];

export class TickDriver {
  readonly kind = "tick";
  readonly record: MatchRecord;
  readonly mySlot: Slot;
  readonly engine: Rollback;
  /** The rival's paddle as the room confirms it, drawn a little behind the
   *  newest confirmed tick so a gap or a burst in the stream never shows. */
  readonly rival: Interpolator<number>;
  private readonly room: TickRoom;
  private readonly rivalSlot: Slot;
  /** The tick stream's clock: how late ticks reach this client, and how far behind them to draw. */
  private readonly ticks = new RemoteClock();
  /** The stream skipped ticks this match cannot replay: it needs a re-base. */
  private brokenTimeline = false;
  /** The fractional tick this client predicts to, where its own input lands. */
  private horizon: number;
  /** How far ahead of the server's clock this client runs (ms). */
  private leadMs: number;
  private lastSent: SlotInput | null = null;
  /** The newest tick this player's input was sampled for. */
  private sampled = Number.NEGATIVE_INFINITY;

  constructor(room: TickRoom, record: MatchRecord, mySlot: Slot) {
    this.room = room;
    this.record = record;
    this.mySlot = mySlot;
    this.rivalSlot = mySlot === 0 ? 1 : 0;
    this.rival = new Interpolator({ clock: this.ticks, delayMs: RIVAL_DELAY_MS, lerp });
    const base = newMatch({
      autoServe: true,
      scoreA: record.scoreA,
      scoreB: record.scoreB,
      seed: record.seed,
      tick: record.start - 1,
    });
    const clock = room.tickClock;
    const known = clock === null ? record.start - 1 : Math.min(record.start - 1, clock.n);
    this.engine = new Rollback(base, mySlot, slotInputs(record, room.tickInputs(known)));
    this.horizon = base.tick;
    const { rtt } = room;
    const half = Number.isFinite(rtt) ? rtt / 2 : DEFAULT_HALF_RTT_MS;
    this.leadMs = Math.min(MAX_LEAD_MS, half + START_MARGIN_MS);
    this.catchUp();
  }

  /** The timeline broke (a gap, or the room restarted): this match needs a re-base. */
  get broken(): boolean {
    return this.brokenTimeline;
  }

  /** How far ahead of the server this client runs (ms). */
  get lead(): number {
    return this.leadMs;
  }

  /** A tick from the room, received at local time `receivedAt`. */
  onTick(n: number, inputs: Record<string, JsonValue>, receivedAt?: number): void {
    if (this.brokenTimeline) {
      return;
    }
    const clock = this.room.tickClock;
    if (clock !== null && clock.epoch !== this.record.epoch) {
      this.brokenTimeline = true;
      return;
    }
    // Before the match, or already folded in when the driver caught up.
    if (n <= this.engine.confirmedTick) {
      return;
    }
    if (!this.confirm(n, slotInputs(this.record, inputs), receivedAt)) {
      this.brokenTimeline = true;
    }
  }

  /** The fractional tick the rival's paddle is drawn at, local time
   *  `localNow`: the horizon until the stream has been heard from. */
  rivalTick(localNow?: number): number {
    if (!this.ticks.synced) {
      return this.horizon;
    }
    // The state after tick n stands at the end of tick n, a tick after the room sent it.
    return (this.rival.renderTime(localNow) - this.record.epoch) / TICK_MS + 1;
  }

  /** Back from a drop, the ticks missed meanwhile came in one burst, which
   *  says nothing about how the stream arrives: measure it afresh. */
  relearn(): void {
    this.ticks.relearn();
  }

  /**
   * Each frame: move the horizon with the server's clock, send this player's
   * input for the newest tick when it changed, and predict up to it. Returns
   * the horizon.
   */
  frame(input: SlotInput): number {
    const clock = this.room.tickClock;
    if (clock !== null && clock.epoch !== this.record.epoch) {
      this.brokenTimeline = true;
    }
    if (this.brokenTimeline || clock === null || !this.room.clockSynced) {
      return this.horizon;
    }
    if (this.engine.takeResend()) {
      this.lastSent = null;
    }
    this.adaptLead();
    const target = (this.room.serverNow() - clock.epoch + this.leadMs) / clock.ms;
    this.horizon = target < this.horizon - SNAP_TICKS ? target : Math.max(this.horizon, target);
    const tick = Math.floor(this.horizon);
    if (tick > this.sampled) {
      this.sampled = tick;
      if (!sameInput(input, this.lastSent)) {
        const at = Math.max(tick, this.engine.confirmedTick + 1);
        this.engine.setLocal(at, input);
        this.room.sendInput(encodeInput(input), at);
        this.lastSent = input;
      }
    }
    this.engine.predictTo(tick);
    return this.horizon;
  }

  /** Replay the ticks the room already streamed past the match's start. */
  private catchUp(): void {
    const clock = this.room.tickClock;
    if (clock === null) {
      return;
    }
    // History, not arrivals: the interpolator learns the live stream only.
    for (let n = this.engine.confirmedTick + 1; n <= clock.n; n += 1) {
      const inputs = this.room.tickInputs(n);
      if (inputs === null || !this.engine.confirm(n, slotInputs(this.record, inputs))) {
        this.brokenTimeline = true;
        return;
      }
    }
  }

  /** Confirm a tick as it arrives, and hand the rival's paddle on it to the
   *  interpolator, stamped when the room sent it. */
  private confirm(n: number, inputs: SlotInputs, receivedAt?: number): boolean {
    if (!this.engine.confirm(n, inputs)) {
      return false;
    }
    const { x } = paddleOf(this.engine.confirmed, this.rivalSlot);
    this.rival.push(this.record.epoch + n * TICK_MS, x, receivedAt);
    return true;
  }

  /** Lengthen the lead at once when own inputs land late, shorten it slowly while they land on time. */
  private adaptLead(): void {
    const late = this.engine.takeOwnLate();
    const onTime = this.engine.takeOwnOnTime();
    const next = this.leadMs + late * LATE_STEP_MS - onTime * ON_TIME_STEP_MS;
    this.leadMs = Math.min(MAX_LEAD_MS, Math.max(MIN_LEAD_MS, next));
  }
}
