import { Reconciler } from "@vibedgames/multiplayer";

import { SIM_DT } from "../data/config";
import type { Order, Unit, World } from "../sim/types";
import { dashHero, issueOrder, settleBody, stepBody } from "../sim/world";
import type { Intent } from "./protocol";
import { emptyGuestWorld } from "./snapshot";

const DEAD_ZONE = 16;
const SNAP_DISTANCE = 96;
const ADOPT_AFTER_MS = 250;
const MAX_FRAME_MS = 250;
const SENT_KEPT = 256;
const STEP_MS = SIM_DT * 1000;

const sameOrder = (a: Order, b: Order) => JSON.stringify(a) === JSON.stringify(b);

const syncFromHost = (body: Unit, host: Unit) => {
  const { x, y, vx, vy, facing, order, path, pathIdx, repathAt, hero } = body;
  Object.assign(body, host);
  body.x = x;
  body.y = y;
  body.vx = vx;
  body.vy = vy;
  body.facing = facing;
  body.order = order;
  body.path = path;
  body.pathIdx = pathIdx;
  body.repathAt = repathAt;
  body.statuses = [...host.statuses];
  body.hero = host.hero && {
    ...host.hero,
    dashReadyAt: hero?.dashReadyAt ?? 0,
    dashUntil: hero?.dashUntil ?? 0,
    dashX: hero?.dashX ?? 1,
    dashY: hero?.dashY ?? 0,
  };
};

export class HeroPredictor {
  private readonly reconciler = new Reconciler({
    deadZone: DEAD_ZONE,
    snapDistance: SNAP_DISTANCE,
  });
  private readonly ctx: World = emptyGuestWorld();
  private body: Unit | null = null;
  private wasAlive = false;
  private lastFrameAt: number | null = null;
  private seq = 0;
  private readonly sentAt = new Map<number, number>();

  /** The predicted body, for diagnostics and tests. */
  get hero() {
    return this.body;
  }

  /** The correction still being eased in (px), for diagnostics and tests. */
  get correction() {
    return this.reconciler.pending;
  }

  /** The order the prediction is running, to restate to a new host. */
  get order() {
    return this.body ? structuredClone(this.body.order) : null;
  }

  /**
   * Number an outgoing intent and play it on the predicted body now — orders
   * and dashes move it this frame; casts, buys and level-ups wait for the host.
   * Returns the seq to send with it.
   */
  input(intent: Intent, now: number) {
    this.seq += 1;
    this.sentAt.set(this.seq, this.lastFrameAt ?? now);
    this.sentAt.delete(this.seq - SENT_KEPT);
    const { body } = this;

    if (body?.alive) {
      if (intent.kind === "order") {
        issueOrder(this.ctx, body, structuredClone(intent.order));
      } else if (intent.kind === "dash") {
        dashHero(this.ctx, body, intent.dx, intent.dy);
      }

      this.ctx.fx.length = 0;
      this.ctx.groundEffects = [];
    }

    return this.seq;
  }

  /**
   * Advance the prediction to `now`. `host` is the host's newest copy of our
   * hero and `world` the host's newest world (the guest's replica): they
   * supply everything prediction does not own — statuses, stats, life — and
   * the units to chase and collide with.
   */
  frame(host: Unit | undefined, world: World | null, now: number) {
    const elapsed = this.lastFrameAt === null ? 0 : Math.min(now - this.lastFrameAt, MAX_FRAME_MS);
    this.lastFrameAt = now;

    if (!host || !world) {
      return;
    }

    if (!this.body || this.body.id !== host.id || (host.alive && !this.wasAlive)) {
      this.start(host, world);
    }

    this.wasAlive = host.alive;
    const { body, ctx } = this;

    if (!body) {
      return;
    }

    syncFromHost(body, host);
    ctx.units = world.units;

    for (let left = elapsed; left > 0; left -= STEP_MS) {
      const dt = Math.min(left, STEP_MS);
      ctx.now += dt;

      if (body.alive) {
        stepBody(ctx, body, dt / 1000);
        settleBody(ctx, body);
      }
    }

    const fix = this.reconciler.step(body.x, body.y, elapsed, now);
    body.x += fix.x;
    body.y += fix.y;
  }

  /**
   * The host's copy of our hero after a tick, with the tick's ack for us —
   * [seq, ms the host has run it] — or null when this host has none yet.
   */
  reconcile(host: Unit, ack: [number, number] | null) {
    const { body } = this;

    if (!body || body.id !== host.id || !host.alive || !body.alive) {
      return;
    }

    const sent = ack ? this.sentAt.get(ack[0]) : undefined;
    this.reconciler.reconcile(
      host.x,
      host.y,
      ack && sent !== undefined ? sent + ack[1] : undefined,
    );

    if (
      ack &&
      ack[0] === this.seq &&
      ack[1] >= ADOPT_AFTER_MS &&
      !sameOrder(host.order, body.order)
    ) {
      body.order = structuredClone(host.order);
      body.path = [];
      body.pathIdx = 0;
      body.repathAt = 0;
    }
  }

  /** Draw the prediction: write its motion onto our hero in the rendered world. */
  draw(view: World) {
    const { body } = this;
    const u = body ? view.units.get(body.id) : undefined;

    if (!body || !u) {
      return;
    }

    u.x = body.x;
    u.y = body.y;
    u.vx = body.vx;
    u.vy = body.vy;
    u.facing = body.facing;
    u.order = body.order;
  }

  /** Drop the body — a new match or a new host's world; the next frame starts
   *  again from the host's copy. Input numbering carries on. */
  reset() {
    this.body = null;
    this.reconciler.clear();
  }

  private start(host: Unit, world: World) {
    const body = structuredClone(host);
    body.path = [];
    body.pathIdx = 0;
    body.repathAt = 0;
    const { hero } = body;

    if (hero) {
      hero.dashUntil = 0;
      hero.dashReadyAt = this.ctx.now + Math.max(0, hero.dashReadyAt - world.now);
    }

    this.body = body;
    this.reconciler.clear();
  }
}
