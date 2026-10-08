// A guest's own body: predicted from local input the frame a key goes down,
// and reconciled against the host's copy at the moment that copy describes.
//
// Every intent a guest sends carries a sequence number, stamped here with the
// local sim time of the step it first applies to. The host reports, per guest
// body, the newest sequence it applied and for how long (`IntentAck`); their
// sum is the local time the host's position corresponds to. The host's copy
// is ~one round trip behind the prediction, so comparing against "now" would
// report a phantom error of speed × latency and drag a running player back;
// comparing at the matching time leaves an agreeing prediction untouched.
// Only durations cross the wire, so no clock sync is needed.
//
// Events the host applies that the guest cannot foresee are delivered as
// edges in the row and replayed locally. A knockback (`knockSeq`) landed on
// the host about a round trip before the guest hears of it, so the guest takes
// the shove as it stands by now — the distance already slid, eased in over a
// few frames, plus the speed still left — and drops the history from before
// it, so the shove is felt once and in step with the host's copy. An evade
// waits for its verdict at most EVADE_TIMEOUT_MS, so a request lost on the
// way (a host handover) can never lock dodging.
import { Reconciler } from "@vibedgames/multiplayer";

import type { EvasionState } from "../entities/evasion";
import { KNOCK_DECAY } from "../entities/movement";
import type { LeapArc, Planar } from "../entities/movement";

/** Errors at or under this are left alone (world units): one frame of timing slack at full speed. */
export const DEAD_ZONE = 0.12;
/** Errors at or over this are applied at once; the jerk is the feedback. */
export const SNAP_DISTANCE = 1.5;
/** An evade with no verdict after this long was lost on the way (ms). */
export const EVADE_TIMEOUT_MS = 1000;
/** Sent intents remembered for matching acknowledgments (ms of sim time). */
const SENT_MEMORY_MS = 4000;
/** Smoothing for the lag estimate: weight of each new sample. */
const LAG_SMOOTHING = 0.1;
/** A host leap is treated as rejected only once it should have been visible for this long (ms). */
const LEAP_GRACE_MS = 60;
/** Time constant for easing in the distance a shove slid before the guest heard of it (ms). */
const SHOVE_EASE_MS = 30;
/** How long after a shove the rows still describe the slide being eased in (ms). */
const SHOVE_SETTLE_MS = 120;

export type IntentKind = "input" | "attack" | "super" | "evade";

/** The fields of the host's row for this guest's body that prediction reads. */
export interface OwnRow {
  x: number;
  z: number;
  alive: boolean;
  ack: number;
  ackAge: number;
  /** Signed sequence of the last evade the host processed: negative when refused. */
  evade: number;
  evadeCooldown: number;
  knockSeq: number;
  knockX: number;
  knockZ: number;
  leap: LeapArc | null;
}

/** The guest's own body as prediction touches it. */
export interface OwnBody {
  alive: boolean;
  evasion: EvasionState | null;
  evadeCooldown: number;
  evadePending: boolean;
  readonly knock: Planar;
  leap: LeapArc | null;
}

/** What a host row changed about the predicted body, for the view to present. */
export interface OwnVerdict {
  /** Local sim time the row describes, or null when it cannot be matched to a sent intent. */
  at: number | null;
  /** The host has seen every attack / super sent: its ammo and charge are current. */
  ammoSettled: boolean;
  chargeSettled: boolean;
  /** A refused or lost evade was cancelled. */
  evadeCancelled: boolean;
  /** A new knockback was applied locally. */
  knocked: boolean;
  /** A predicted leap the host never started was cancelled. */
  leapCancelled: boolean;
}

interface PendingEvade {
  seq: number;
  since: number;
}

interface PendingLeap {
  seq: number;
  /** Local sim time the leap left the ground. */
  start: number;
  flightMs: number;
}

export class OwnPrediction {
  readonly reconciler = new Reconciler({
    deadZone: DEAD_ZONE,
    historyMs: 1500,
    smoothingMs: 100,
    snapDistance: SNAP_DISTANCE,
  });
  /** Local sim time (ms), advanced by the guest loop one step at a time. */
  clock = 0;
  /** How far the host's copy trails the prediction (ms, smoothed): about one round trip. */
  lagMs: number | null = null;
  /** Size of the last correction the host asked for (world units), for diagnostics. */
  lastError = 0;
  private stepStart = 0;
  private seq = 0;
  private readonly sentAt = new Map<number, number>();
  private lastAttack = 0;
  private lastSuper = 0;
  private lastEvade = 0;
  private evade: PendingEvade | null = null;
  private leap: PendingLeap | null = null;
  private knockSeq: number | null = null;
  /** Distance a shove slid on the host before we heard of it, still to ease in. */
  private shoveX = 0;
  private shoveZ = 0;
  /** Rows describing the host before this local time predate a teleport or shove: ignored. */
  private ignoreBefore = Number.NEGATIVE_INFINITY;

  /** Start one guest sim step; intents stamped before the next call apply from its start. */
  beginStep(dtMs: number): void {
    this.stepStart = this.clock;
    this.clock += dtMs;
  }

  /** Allocate the sequence number for an intent leaving this step. */
  stamp(kind: IntentKind): number {
    this.seq += 1;
    this.sentAt.set(this.seq, this.stepStart);
    for (const [seq, at] of this.sentAt) {
      if (this.stepStart - at <= SENT_MEMORY_MS) {
        break;
      }
      this.sentAt.delete(seq);
    }
    if (kind === "attack") {
      this.lastAttack = this.seq;
    } else if (kind === "super") {
      this.lastSuper = this.seq;
    } else if (kind === "evade") {
      this.lastEvade = this.seq;
    }
    return this.seq;
  }

  /** A predicted evade is waiting for the host's verdict. */
  evadeSent(body: OwnBody, seq: number): void {
    this.evade = { seq, since: this.clock };
    body.evadePending = true;
  }

  /** A predicted leap left the ground this step. */
  leapSent(seq: number, flightS: number): void {
    this.leap = { flightMs: flightS * 1000, seq, start: this.stepStart };
  }

  /** The local sim time the row's position describes: when its intent left, plus how long the host ran it. */
  private momentOf(row: OwnRow): number | null {
    const sent = row.ack > 0 ? this.sentAt.get(row.ack) : undefined;
    return sent === undefined ? null : sent + row.ackAge;
  }

  /** Fold in the host's row for this body. Call as rows arrive, before the step's input. */
  receive(body: OwnBody, row: OwnRow): OwnVerdict {
    const at = this.momentOf(row);
    if (at !== null) {
      const lag = Math.max(0, this.clock - at);
      this.lagMs = this.lagMs === null ? lag : this.lagMs + (lag - this.lagMs) * LAG_SMOOTHING;
    }
    const verdict: OwnVerdict = {
      ammoSettled: row.ack >= this.lastAttack,
      at,
      chargeSettled: row.ack >= this.lastSuper,
      evadeCancelled: this.settleEvade(body, row, at),
      knocked: this.settleKnock(body, row, at),
      leapCancelled: this.settleLeap(body, row, at),
    };
    if (
      at !== null &&
      at >= this.ignoreBefore &&
      row.alive &&
      body.alive &&
      row.leap === null &&
      body.leap === null
    ) {
      this.reconciler.reconcile(row.x, row.z, at);
      const { pending } = this.reconciler;
      this.lastError = Math.hypot(pending.x, pending.y);
    }
    return verdict;
  }

  private settleEvade(body: OwnBody, row: OwnRow, at: number | null): boolean {
    const pending = this.evade;
    let cancelled = false;
    if (pending !== null) {
      const answered = Math.abs(row.evade) >= pending.seq;
      const passed = row.ack >= pending.seq;
      if (answered || passed || this.clock - pending.since > EVADE_TIMEOUT_MS) {
        // Refused, or applied by a host that never saw it: the roll was not real.
        cancelled = (answered && row.evade < 0) || (!answered && passed);
        if (cancelled) {
          body.evasion = null;
        }
        if (!answered) {
          // The request never arrived, so the host's cooldown is the truth again.
          this.lastEvade = 0;
        }
        this.evade = null;
        body.evadePending = false;
      }
    }
    if (this.evade === null && row.ack >= this.lastEvade) {
      const since = at === null ? 0 : (this.clock - at) / 1000;
      body.evadeCooldown = Math.max(0, row.evadeCooldown - since);
    }
    return cancelled;
  }

  private settleKnock(body: OwnBody, row: OwnRow, at: number | null): boolean {
    const seen = this.knockSeq;
    this.knockSeq = row.knockSeq;
    if (seen === null || row.knockSeq === seen || !row.alive) {
      return false;
    }
    // The host's copy has been sliding since the moment this row describes.
    const since = Math.max(0, at === null ? (this.lagMs ?? 0) : this.clock - at) / 1000;
    const left = Math.exp(-KNOCK_DECAY * since);
    const slid = (1 - left) / KNOCK_DECAY;
    body.knock.x = row.knockX * left;
    body.knock.y = row.knockZ * left;
    this.shoveX += row.knockX * slid;
    this.shoveZ += row.knockZ * slid;
    // Rows from before the shove would count it twice; rows during the ease would see it half done.
    this.forgetHistory(SHOVE_SETTLE_MS);
    return true;
  }

  private settleLeap(body: OwnBody, row: OwnRow, at: number | null): boolean {
    const pending = this.leap;
    if (pending === null) {
      return false;
    }
    if (body.leap === null) {
      this.leap = null;
      return false;
    }
    if (row.leap !== null) {
      // The host computed its own landing from its copy's position: land where it will.
      body.leap.sx = row.leap.sx;
      body.leap.sz = row.leap.sz;
      body.leap.tx = row.leap.tx;
      body.leap.tz = row.leap.tz;
      return false;
    }
    const due = at !== null && at < pending.start + pending.flightMs - LEAP_GRACE_MS;
    if (row.ack >= pending.seq && due) {
      body.leap = null;
      this.leap = null;
      return true;
    }
    return false;
  }

  /** Record where the local sim put the body this step; returns the correction slice to add. */
  settle(x: number, z: number, dtMs: number): Planar {
    const fix = this.reconciler.step(x, z, dtMs, this.clock);
    if (this.shoveX !== 0 || this.shoveZ !== 0) {
      const k = 1 - Math.exp(-Math.max(0, dtMs) / SHOVE_EASE_MS);
      const sx = Math.abs(this.shoveX) < 1e-4 ? this.shoveX : this.shoveX * k;
      const sz = Math.abs(this.shoveZ) < 1e-4 ? this.shoveZ : this.shoveZ * k;
      this.shoveX -= sx;
      this.shoveZ -= sz;
      fix.x += sx;
      fix.y += sz;
    }
    return fix;
  }

  /** History before now (and for `holdMs` more) no longer describes the body: a shove, a landing. */
  forgetHistory(holdMs = 0): void {
    this.reconciler.clear();
    this.ignoreBefore = this.clock + holdMs;
  }

  /** A new body, a new brawl or a new host: nothing pending carries over. */
  reset(body: OwnBody | null): void {
    this.forgetHistory();
    this.evade = null;
    this.leap = null;
    this.knockSeq = null;
    this.shoveX = 0;
    this.shoveZ = 0;
    this.lastError = 0;
    if (body) {
      body.evadePending = false;
    }
  }
}
