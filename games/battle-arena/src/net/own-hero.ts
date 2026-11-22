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
const REANCHOR_MS = 15;
const SENT_MEMORY_MS = 2000;
const SAME_MOTION_MS = 150;
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

export const noActions: () => PendingActions = () => ({
  attackEdge: false,
  casts: [],
  dash: null,
  items: [],
  jump: false,
});

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

const readBody = (u: Unit) => ({
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

const writeBody = (u: Unit, b: Body) => {
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
  private readonly scratch = emptyGuestWorld();
  private body: Body | null = null;
  private heroId = "";
  private acc = 0;
  private localAt = 0;
  private simAt = 0;
  private tick = 0;
  private seq = 0;
  private readonly sentAt = new Map<number, number>();
  private readonly sentSim = new Map<number, number>();
  private last: InputPacket | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lead = 0;
  private readonly cooling = new Map<AbilityKey, number>();
  private queued: QueuedMotion | null = null;
  private hostAlive = true;

  /** The error still being eased out, for diagnostics. */
  get correction() {
    const { x, y } = this.reconciler.pending;

    return Math.hypot(x, y);
  }

  /** Forget the body (a new match, a new host): the next advance starts from
   *  the hero as the host has it. Counters keep running, so seq and tick never
   *  go backwards for a host that keeps its buffer. */
  reset() {
    this.body = null;
    this.reconciler.clear();
    this.acc = 0;
    this.last = null;
    this.queued = null;
    this.cooling.clear();
    this.pending = noActions();
  }

  /** Send the held input on the next tick even if unchanged (a new host). */
  resend() {
    this.last = null;
  }

  /** What the host says about the hero; call for every frame received. */
  hostUpdate(report: OwnReport) {
    const { body } = this;

    if (!body) {
      return;
    }

    if (!report.alive || !this.hostAlive) {
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
  ) {
    if (!this.body || this.heroId !== me.id) {
      this.start(me, localNow, simNow);
    }

    this.acc += elapsedMs;
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
  render(me: Unit, props: ReadonlyMap<string, Unit>, held: HeldInput) {
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
      me.aimX = held.ax;
      me.aimY = held.ay;
    }
  }

  /** This client now hosts: hand its sim the hero as prediction drew it this
   *  frame — inputs the old host never applied included — with the predicted
   *  hop, dash and the DASH/JUMP cooldowns they spent moved from the predicted
   *  clock onto `hostNow`, the world's clock from here on. */
  handover(me: Unit, props: ReadonlyMap<string, Unit>, held: HeldInput, hostNow: number) {
    if (!this.body || this.heroId !== me.id) {
      return;
    }

    const drawnAt = this.simAt + this.acc;
    this.render(me, props, held);
    const shift = hostNow - drawnAt;
    me.jumpUntil += shift;
    me.dashUntil += shift;

    for (const [key, until] of this.cooling) {
      const slot = me.abilities[key];
      slot.readyAt = Math.max(slot.readyAt, until + shift);
    }
  }

  private start(me: Unit, localNow: number, simNow: number) {
    this.reset();
    this.heroId = me.id;
    this.body = readBody(me);
    this.hostAlive = me.alive;
    this.localAt = localNow;
    this.simAt = simNow;
  }

  private teleport(x: number, y: number) {
    const { body } = this;

    if (!body) {
      return;
    }

    Object.assign(body, { dashUntil: 0, jumpUntil: 0, steerVx: 0, steerVy: 0, vx: 0, vy: 0, x, y });
    this.queued = null;
    this.reconciler.clear();
  }

  private shift(by: number) {
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

  private adoptHostMotion(body: Body, report: OwnReport) {
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
  ) {
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
    this.scratch.now = this.simAt;
    const live = me.alive && this.hostAlive;

    if (live) {
      for (const cast of packet.casts) {
        if (cast.key === "JUMP") {
          this.pressMotion(me, "JUMP", cast.dir);
        } else {
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

  private transmit(packet: InputPacket, send: (p: InputPacket) => void) {
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

  private pressMotion(me: Unit, key: "DASH" | "JUMP", dir: Vec2) {
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

  private fireQueued(me: Unit) {
    const { queued } = this;

    if (!queued) {
      return;
    }

    if (this.simAt > queued.until || this.tryMotion(me, queued.key, queued.dir)) {
      this.queued = null;
    }
  }

  private tryMotion(me: Unit, key: "DASH" | "JUMP", dir: Vec2) {
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
