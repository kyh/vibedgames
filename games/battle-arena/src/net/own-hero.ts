// Client-side prediction of a guest's own hero. The guest moves its body with
// the sim's own movement code (stepBody, tryJump, predictMotion) on the host's
// fixed tick, starting the frame input changes, and sends that tick's input to
// the host stamped with a sequence number and the tick. The host reports per
// hero the newest input it applied and since when (ack/ackAt); that pins the
// host's position to the instant of this guest's trajectory it corresponds
// to, and Reconciler eases out a real difference (a shove, a knockback, a stun
// learned of late) or snaps a large one (a blink).
import { Reconciler } from "@vibedgames/multiplayer";
import { INPUT_KEEPALIVE_MS, MAX_CATCH_UP_TICKS, SIM_DT } from "../data/config";
import { castableDef, predictMotion } from "../sim/abilities";
import type { Vec2 } from "../sim/math";
import { expireStatuses } from "../sim/stats";
import type { AbilityKey, Unit } from "../sim/types";
import { setHeroInput, stepBody, tryJump } from "../sim/world";
import { hasActions, sameHeld } from "./input";
import type { CastAction, InputPacket, ItemAction } from "./input";
import type { OwnReport } from "./mirror";
import { emptyGuestWorld } from "./snapshot";

const TICK_MS = SIM_DT * 1000;
/** Predicted and mirrored sim clocks further apart than this re-anchor (ms):
 *  under a frame, so a predicted hop's arc never visibly runs early or late. */
const REANCHOR_MS = 15;
/** Sent inputs remembered for alignment (ms) — beyond any round trip. */
const SENT_MEMORY_MS = 2000;
/** A host dash or hop ending this far from the predicted one is a different move (ms). */
const SAME_MOTION_MS = 150;
/** The sim's cast buffer: a press this early queues, and the queue lives this long (ms). */
const CAST_BUFFER_LEAD = 350;
const CAST_BUFFER_MS = 300;

/** Held controls this frame (world-space move, aim, attack). */
export interface HeldInput {
  mx: number;
  my: number;
  ax: number;
  ay: number;
  attack: boolean;
}

/** Presses waiting for the next tick. */
export interface PendingActions {
  jump: boolean;
  attackEdge: boolean;
  dash: Vec2 | null;
  casts: CastAction[];
  items: ItemAction[];
}

export const noActions = (): PendingActions => ({
  attackEdge: false,
  casts: [],
  dash: null,
  items: [],
  jump: false,
});

/** The fields prediction owns on the guest's copy of its hero. */
interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  steerVx: number;
  steerVy: number;
  facing: number;
  aimX: number;
  aimY: number;
  moveX: number;
  moveY: number;
  attackHeld: boolean;
  jumpUntil: number;
  dashUntil: number;
  dashVx: number;
  dashVy: number;
}

const readBody = (u: Unit): Body => ({
  aimX: u.aimX,
  aimY: u.aimY,
  attackHeld: u.attackHeld,
  dashUntil: u.dashUntil,
  dashVx: u.dashVx,
  dashVy: u.dashVy,
  facing: u.facing,
  jumpUntil: u.jumpUntil,
  moveX: u.moveX,
  moveY: u.moveY,
  steerVx: u.steerVx,
  steerVy: u.steerVy,
  vx: u.vx,
  vy: u.vy,
  x: u.x,
  y: u.y,
});

/** Load the body into the unit. Knockback is the host's: prediction leaves it
 *  out and lets reconciliation bring it in. */
const writeBody = (u: Unit, b: Body): void => {
  Object.assign(u, b);
  u.kbUntil = 0;
};

interface QueuedMotion {
  key: "DASH" | "JUMP";
  dir: Vec2;
  until: number;
}

export class OwnHeroPredictor {
  /** Presses since the last tick; the scene adds to it, the next tick takes it. */
  pending = noActions();
  private readonly reconciler = new Reconciler({
    deadZone: 0.08,
    historyMs: SENT_MEMORY_MS,
    smoothingMs: 100,
    snapDistance: 3,
  });
  /** Clock and fx sink for the sim calls: a predicted blink must not flash twice. */
  private readonly scratch = emptyGuestWorld();
  private body: Body | null = null;
  private heroId = "";
  private acc = 0;
  /** Local logical time of the last tick (ms) — the Reconciler's axis. */
  private localAt = 0;
  /** Predicted World.now at the last tick (ms), kept on the mirror's clock. */
  private simAt = 0;
  private tick = 0;
  private seq = 0;
  private readonly sentAt = new Map<number, number>();
  private readonly sentSim = new Map<number, number>();
  private last: InputPacket | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  /** How far the host's clock runs ahead of the predicted one when it applies
   *  an input (ms): a round trip plus its jitter buffer. */
  private lead = 0;
  private readonly cooling = new Map<AbilityKey, number>();
  private queued: QueuedMotion | null = null;
  private hostAlive = true;

  /** The error still being eased out, for diagnostics. */
  get correction(): number {
    const { x, y } = this.reconciler.pending;
    return Math.hypot(x, y);
  }

  /** Forget the body (a new match, a new host): the next advance starts from
   *  the hero as the host has it. Counters keep running, so seq and tick never
   *  go backwards for a host that keeps its buffer. */
  reset(): void {
    this.body = null;
    this.reconciler.clear();
    this.acc = 0;
    this.last = null;
    this.queued = null;
    this.cooling.clear();
    this.pending = noActions();
  }

  /** Send the held input on the next tick even if unchanged (a new host). */
  resend(): void {
    this.last = null;
  }

  /** What the host says about the hero; call for every frame received. */
  hostUpdate(report: OwnReport): void {
    const { body } = this;
    if (!body) {
      return;
    }
    if (!report.alive || !this.hostAlive) {
      // dead: the corpse lies where the host has it; respawning: drop in there
      this.hostAlive = report.alive;
      this.teleport(report.x, report.y);
      return;
    }
    if (report.ack !== null && report.ackAt !== null) {
      const sentSim = this.sentSim.get(report.ack);
      if (sentSim !== undefined) {
        this.lead = report.ackAt - sentSim;
      }
    }
    this.adoptHostMotion(body, report);
    const sent = report.ack === null ? undefined : this.sentAt.get(report.ack);
    const at =
      sent === undefined || report.ackAt === null ? undefined : sent + (report.n - report.ackAt);
    this.reconciler.reconcile(report.x, report.y, at);
  }

  /** Run the ticks due this frame: sample input, send it, predict, reconcile.
   *  `simNow` is the mirror's World.now; `localNow` the local clock (ms). */
  advance(
    me: Unit,
    props: ReadonlyMap<string, Unit>,
    elapsedMs: number,
    localNow: number,
    simNow: number,
    held: HeldInput,
    send: (p: InputPacket) => void,
  ): void {
    if (!this.body || this.heroId !== me.id) {
      this.start(me, localNow, simNow);
    }
    this.acc += elapsedMs;
    // One timebase for the predicted hop/dash timers and the host's own timers
    // on this hero: slew the predicted clock onto the mirror's when they part.
    const drift = simNow - (this.simAt + this.acc);
    if (Math.abs(drift) > REANCHOR_MS) {
      this.shift(drift);
    }
    let ticks = 0;
    while (this.acc >= TICK_MS && ticks < MAX_CATCH_UP_TICKS) {
      this.acc -= TICK_MS;
      ticks += 1;
      this.runTick(me, props, held, send);
    }
    if (this.acc >= TICK_MS) {
      // A stall: skip the backlog rather than fast-forward through it, but
      // keep the tick count on real time — the host schedules input by it,
      // and a count that fell behind would shift every input after the stall.
      const skipped = Math.floor(this.acc / TICK_MS);
      this.acc -= skipped * TICK_MS;
      this.tick += skipped;
      this.localAt += skipped * TICK_MS;
      this.simAt += skipped * TICK_MS;
    }
  }

  /** Put the pose to draw this frame on `me`: the last tick advanced by the
   *  part of the next one already elapsed, on the input held right now — so the
   *  body answers a key the frame it goes down, and meets the next tick exactly. */
  render(me: Unit, props: ReadonlyMap<string, Unit>, held: HeldInput): void {
    const { body } = this;
    if (!body) {
      return;
    }
    writeBody(me, body);
    if (me.alive && this.hostAlive && this.acc > 0) {
      setHeroInput(me, held.mx, held.my, held.ax, held.ay, held.attack);
      this.scratch.now = this.simAt + this.acc;
      stepBody(this.scratch, me, this.acc / 1000, props);
    } else if (held.ax !== 0 || held.ay !== 0) {
      // aim stays live while dead or between ticks
      me.aimX = held.ax;
      me.aimY = held.ay;
    }
  }

  private start(me: Unit, localNow: number, simNow: number): void {
    this.reset();
    this.heroId = me.id;
    this.body = readBody(me);
    this.hostAlive = me.alive;
    this.localAt = localNow;
    this.simAt = simNow;
  }

  private teleport(x: number, y: number): void {
    const { body } = this;
    if (!body) {
      return;
    }
    Object.assign(body, { dashUntil: 0, jumpUntil: 0, steerVx: 0, steerVy: 0, vx: 0, vy: 0, x, y });
    this.queued = null;
    this.reconciler.clear();
  }

  private shift(by: number): void {
    this.simAt += by;
    const { body } = this;
    if (body) {
      body.jumpUntil += by;
      body.dashUntil += by;
    }
    for (const [key, until] of this.cooling) {
      this.cooling.set(key, until + by);
    }
    if (this.queued) {
      this.queued.until += by;
    }
  }

  /** A dash or hop the host started that prediction did not (an ability
   *  lunge, a cast the host's buffer fired late): carry on with the rest of
   *  it. Host time maps to predicted time `lead` earlier. */
  private adoptHostMotion(body: Body, report: OwnReport): void {
    const dashEnd = report.dashUntil - this.lead;
    if (dashEnd > this.simAt && dashEnd > body.dashUntil + SAME_MOTION_MS) {
      body.dashUntil = dashEnd;
      body.dashVx = report.dashVx;
      body.dashVy = report.dashVy;
    }
    const jumpEnd = report.jumpUntil - this.lead;
    if (jumpEnd > this.simAt && jumpEnd > body.jumpUntil + SAME_MOTION_MS) {
      body.jumpUntil = jumpEnd;
    }
  }

  private runTick(
    me: Unit,
    props: ReadonlyMap<string, Unit>,
    held: HeldInput,
    send: (p: InputPacket) => void,
  ): void {
    const { pending } = this;
    this.pending = noActions();
    const packet: InputPacket = {
      atk: held.attack || pending.attackEdge,
      ax: held.ax,
      ay: held.ay,
      casts: pending.casts,
      dash: pending.dash,
      items: pending.items,
      jump: pending.jump,
      mx: held.mx,
      my: held.my,
      seq: 0,
      tick: this.tick,
    };
    this.transmit(packet, send);

    const body = this.body ?? readBody(me);
    writeBody(me, body);
    // The host applies an input before its tick's step; so does prediction.
    this.scratch.now = this.simAt;
    const live = me.alive && this.hostAlive;
    if (live) {
      for (const cast of packet.casts) {
        if (cast.key === "JUMP") {
          this.pressMotion(me, "JUMP", cast.dir);
        } else {
          // another cast takes the host's one-slot cast buffer
          this.queued = null;
        }
      }
      setHeroInput(me, packet.mx, packet.my, packet.ax, packet.ay, packet.atk);
      if (packet.jump) {
        tryJump(this.scratch, me);
      }
      if (packet.dash) {
        this.pressMotion(me, "DASH", packet.dash);
      }
    }
    this.tick += 1;
    this.simAt += TICK_MS;
    this.localAt += TICK_MS;
    this.scratch.now = this.simAt;
    if (live) {
      expireStatuses(me, this.simAt);
      this.fireQueued(me);
      stepBody(this.scratch, me, SIM_DT, props);
    }
    const next = readBody(me);
    const fix = this.reconciler.step(next.x, next.y, TICK_MS, this.localAt);
    next.x += fix.x;
    next.y += fix.y;
    this.body = next;
  }

  private transmit(packet: InputPacket, send: (p: InputPacket) => void): void {
    const { last } = this;
    const due =
      !last ||
      !sameHeld(packet, last) ||
      hasActions(packet) ||
      this.localAt - this.lastSentAt >= INPUT_KEEPALIVE_MS;
    if (!due) {
      return;
    }
    this.seq += 1;
    packet.seq = this.seq;
    this.sentAt.set(this.seq, this.localAt);
    this.sentSim.set(this.seq, this.simAt);
    for (const [seq, at] of this.sentAt) {
      if (this.localAt - at <= SENT_MEMORY_MS) {
        break;
      }
      this.sentAt.delete(seq);
      this.sentSim.delete(seq);
    }
    this.last = packet;
    this.lastSentAt = this.localAt;
    send(packet);
  }

  /** A DASH/JUMP press: move now if the host will accept it when the press
   *  reaches it, queue it like the host's cast buffer if it is almost ready. */
  private pressMotion(me: Unit, key: "DASH" | "JUMP", dir: Vec2): void {
    if (this.tryMotion(me, key, dir)) {
      this.queued = null;
      return;
    }
    const slot = me.abilities[key];
    const hostNow = this.simAt + this.lead;
    const soon =
      slot.rank >= 1 &&
      (Math.max(slot.readyAt, this.cooling.get(key) ?? 0) - hostNow <= CAST_BUFFER_LEAD ||
        this.simAt < me.dashUntil ||
        me.statuses.some((s) => s.kind === "stun"));
    this.queued = soon ? { dir, key, until: this.simAt + CAST_BUFFER_MS } : null;
  }

  private fireQueued(me: Unit): void {
    const { queued } = this;
    if (!queued) {
      return;
    }
    if (this.simAt > queued.until || this.tryMotion(me, queued.key, queued.dir)) {
      this.queued = null;
    }
  }

  /** Start the move when the host would: its cooldown read at the host's
   *  clock for the moment this press arrives, and not before a cooldown this
   *  prediction already spent. */
  private tryMotion(me: Unit, key: "DASH" | "JUMP", dir: Vec2): boolean {
    if (this.simAt < (this.cooling.get(key) ?? Number.NEGATIVE_INFINITY)) {
      return false;
    }
    this.scratch.now = this.simAt + this.lead;
    const def = castableDef(this.scratch, me, key);
    this.scratch.now = this.simAt;
    if (!def) {
      return false;
    }
    const cooldownMs = predictMotion(this.scratch, me, def, key, dir);
    this.cooling.set(key, this.simAt + cooldownMs);
    return true;
  }
}
