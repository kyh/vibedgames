// Client-side prediction for a guest's own hero. The guest runs the host's own
// movement code (stepBody) on a private copy of its hero the frame an input
// happens, and draws that copy; the host's copy — a round trip old by the time
// it arrives — only corrects it. Every input carries a seq, the host reports
// the newest seq it has applied and for how long, and the Reconciler compares
// the host's position with where the prediction was at that same moment, so a
// running hero is never dragged back by the latency itself.

import { Reconciler } from "@vibedgames/multiplayer";

import { SIM_DT } from "../data/config";
import type { Vec2 } from "../sim/math";
import type { Order, Unit, World } from "../sim/types";
import { dashHero, issueOrder, settleBody, stepBody } from "../sim/world";
import type { Intent } from "./protocol";
import { emptyGuestWorld } from "./snapshot";

/** Disagreements under this (px) are left alone: a crowd's nudge on the host,
 *  a step of timing between two clocks. */
const DEAD_ZONE = 16;
/** Disagreements over this are snapped at once — a blink, a knockback, a
 *  rejected dash: the jump is the feedback. In between they ease out. */
const SNAP_DISTANCE = 96;
/** How long the host must have been running our newest input before an order
 *  it still disagrees on is taken as the truth (ms) — it refused ours, or
 *  ended it differently (an arrival, a target lost). */
const ADOPT_AFTER_MS = 250;
/** A frame longer than this (a hidden tab) is not simulated in full; the host
 *  kept the hero moving meanwhile and the next correction snaps to it. */
const MAX_FRAME_MS = 250;
/** Input send times kept for lining acks up (a few seconds of play). */
const SENT_KEPT = 256;
const STEP_MS = SIM_DT * 1000;

const sameOrder = (a: Order, b: Order): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Everything but motion is the host's: copy it over the predicted body,
 *  keeping its own position, velocity, facing, order, path and dash. */
const syncFromHost = (body: Unit, host: Unit): void => {
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
  /** Where the sim helpers look: the host's units to target and collide
   *  with, a clock of our own (dash and repath timers), an fx list nobody
   *  plays — the host's effects arrive with its ticks. */
  private readonly ctx: World = emptyGuestWorld();
  private body: Unit | null = null;
  private wasAlive = false;
  private lastFrameAt: number | null = null;
  private seq = 0;
  private readonly sentAt = new Map<number, number>();

  /** The predicted body, for diagnostics and tests. */
  get hero(): Unit | null {
    return this.body;
  }

  /** The correction still being eased in (px), for diagnostics and tests. */
  get correction(): Vec2 {
    return this.reconciler.pending;
  }

  /** The order the prediction is running, to restate to a new host. */
  get order(): Order | null {
    return this.body ? structuredClone(this.body.order) : null;
  }

  /**
   * Number an outgoing intent and play it on the predicted body now — orders
   * and dashes move it this frame; casts, buys and level-ups wait for the host.
   * Returns the seq to send with it.
   */
  input(intent: Intent, now: number): number {
    this.seq += 1;
    // The first predicted step to run under this input is the one from the
    // last predicted frame, so that is where its effect starts on our path.
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
  frame(host: Unit | undefined, world: World | null, now: number): void {
    const elapsed = this.lastFrameAt === null ? 0 : Math.min(now - this.lastFrameAt, MAX_FRAME_MS);
    this.lastFrameAt = now;
    if (!host || !world) {
      // Between hosts (or before the first keyframe) the body holds still.
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
  reconcile(host: Unit, ack: [number, number] | null): void {
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
  draw(view: World): void {
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
  reset(): void {
    this.body = null;
    this.reconciler.clear();
  }

  /** Take the host's copy whole: spawn, respawn, a new match. */
  private start(host: Unit, world: World): void {
    const body = structuredClone(host);
    body.path = [];
    body.pathIdx = 0;
    body.repathAt = 0;
    const { hero } = body;
    if (hero) {
      // Dash timers are on the host's clock; restate them on ours.
      hero.dashUntil = 0;
      hero.dashReadyAt = this.ctx.now + Math.max(0, hero.dashReadyAt - world.now);
    }
    this.body = body;
    this.reconciler.clear();
  }
}
