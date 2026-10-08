// The match as a deterministic fixed-step simulation: both paddles, the ball,
// serves, power charges, scoring, and the AI that holds a paddle nobody is
// steering. Every client of a tick room steps it from the same seed, with the
// same inputs on the same ticks, and lands on bit-identical states — which is
// all lockstep rollback asks. So one step is one tick (TICK_S), never a
// frame's dt; the only randomness is the seeded generator inside the state;
// and the only arithmetic is +, −, ×, ÷ and sqrt (see exact-math): no
// Math.random, no Math.sin, nothing two engines could round apart.
//
// Canonical frame: slot A (0) defends −y, slot B (1) defends +y. Stepping
// mutates the state in place; the rollback layer clones before it steps.

import { flyTick, hitsPaddle, reflectOffPaddle } from "./ball";
import type { Ball } from "./ball";
import {
  AI_SPEED_FRAC,
  ARC_LAND_MAX,
  ARC_LAND_MIN,
  AUTO_SERVE_S,
  GOAL_Y,
  HIT_HALF_X,
  HIT_STOP_GOAL,
  HIT_STOP_PADDLE,
  HIT_STOP_WIN,
  PADDLE_X_MAX,
  PADDLE_Y,
  RALLY_SPEED_BASE,
  RALLY_SPEED_MAX,
  RALLY_SPEED_STEP,
  SERVE_SPREAD,
  TICK_RATE,
  TICK_S,
  WALL_X,
  WIN_SCORE,
} from "./constants";
import type { Phase } from "./constants";
import { acceptReturn, armCharge, cancelCharge, contactShot } from "./contact-shot";
import type { ContactKind, ShotCharge } from "./contact-shot";
import { exactSin } from "./exact-math";
import { PADDLE_STEPS } from "./input";
import type { SlotInput } from "./input";

/** 0 = slot A (defends −y), 1 = slot B (defends +y). */
export type Slot = 0 | 1;

const ticksOf = (seconds: number): number => Math.round(seconds * TICK_RATE);
/** Dead air between a point and the auto-serve. */
export const SERVE_DELAY_TICKS = ticksOf(AUTO_SERVE_S);
const STOP_PADDLE = ticksOf(HIT_STOP_PADDLE);
const STOP_GOAL = ticksOf(HIT_STOP_GOAL);
const STOP_WIN = ticksOf(HIT_STOP_WIN);
/** A serve leaves at most this far (sin of SERVE_SPREAD) off straight. */
const SERVE_LATERAL = exactSin(SERVE_SPREAD);

const RNG_MOD = 2_147_483_647;
const RNG_MUL = 48_271;

export interface Paddle {
  /** Paddle x (world units, canonical frame). */
  x: number;
  /** A player steered it this tick; false while the AI holds it. */
  human: boolean;
  charge: ShotCharge;
  /** The press counters last seen (null before the first input): a change is a press. */
  c: number | null;
  k: number | null;
}

/** Cosmetic hop from the hit point to a landing y — visual only, but kept in
 *  the sim so both players see the same arcs. Never mutated once made. */
export interface Arc {
  readonly fromY: number;
  readonly toY: number;
}

export interface ServeEvent {
  key: string;
  kind: "serve";
  receiver: Slot;
}
export interface WallEvent {
  key: string;
  kind: "wall";
  x: number;
  y: number;
}
export interface HitEvent {
  hits: number;
  key: string;
  kind: "hit";
  powered: boolean;
  shot: ContactKind;
  slot: Slot;
  spin: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}
export interface LandEvent {
  key: string;
  kind: "land";
}
export interface PointEvent {
  key: string;
  kind: "point";
  scorer: Slot;
  won: boolean;
  x: number;
  y: number;
}
/** Something that happened on a tick, for sound and effects. `key` names it
 *  across re-simulation: the same hit keeps its key when a rollback replays
 *  it, so it plays once. */
export type SimEvent = ServeEvent | WallEvent | HitEvent | LandEvent | PointEvent;

export interface SimState {
  /** The last tick applied. */
  tick: number;
  /** Park–Miller generator state. */
  rng: number;
  phase: Phase;
  ball: Ball;
  /** Ball resting at the goal line it crossed, until the goal hit-stop ends. */
  parked: boolean;
  arc: Arc | null;
  /** Topspin dips the visual hop. */
  lift: number;
  /** Rally pace: every return adds RALLY_SPEED_STEP. */
  speed: number;
  /** Returns this rally, and the most in any rally this match. */
  hits: number;
  longest: number;
  /** Rallies served this match (names each rally's events). */
  serves: number;
  /** Rail banks since the last contact (names each bank's event). */
  bounces: number;
  scoreA: number;
  scoreB: number;
  /** Tick of the auto-serve; null while a confirm has to serve. */
  serveAt: number | null;
  /** Who the next serve goes to: whoever conceded the last point. */
  receiver: Slot;
  /** Hit-stop ticks left: the ball holds, paddles keep moving. */
  freeze: number;
  a: Paddle;
  b: Paddle;
  /** What happened on this tick. */
  events: SimEvent[];
}

export interface MatchSetup {
  /** The tick the state stands at; the first step is tick + 1. */
  tick: number;
  seed: number;
  /** Serve on a countdown, or wait for a confirm. */
  autoServe: boolean;
  scoreA: number;
  scoreB: number;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** A generator state for any seed — exact in doubles, no bit operations. */
const seedRng = (seed: number): number =>
  Number.isFinite(seed) ? 1 + (Math.floor(Math.abs(seed)) % (RNG_MOD - 1)) : 1;

/** Uniform in [0, 1) from the state's generator. */
const random = (s: SimState): number => {
  s.rng = (s.rng * RNG_MUL) % RNG_MOD;
  return (s.rng - 1) / (RNG_MOD - 1);
};

const newPaddle = (): Paddle => ({
  c: null,
  charge: { hits: 0, kind: "charging" },
  human: false,
  k: null,
  x: 0,
});

const restingBall = (): Ball => ({ spin: 0, spinAge: 0, vx: 0, vy: 0, x: 0, y: 0 });

export const newMatch = (setup: MatchSetup): SimState => {
  const over = Math.max(setup.scoreA, setup.scoreB) >= WIN_SCORE;
  return {
    a: newPaddle(),
    arc: null,
    b: newPaddle(),
    ball: restingBall(),
    bounces: 0,
    events: [],
    freeze: 0,
    hits: 0,
    lift: 1,
    longest: 0,
    parked: false,
    phase: over ? "won" : "serving",
    receiver: 0,
    rng: seedRng(setup.seed),
    scoreA: setup.scoreA,
    scoreB: setup.scoreB,
    serveAt: setup.autoServe && !over ? setup.tick + 1 + SERVE_DELAY_TICKS : null,
    serves: 0,
    speed: RALLY_SPEED_BASE,
    tick: setup.tick,
  };
};

/** A detached copy to step forward. Charges, the arc and the event list are
 *  never mutated once made, so they are shared. */
export const cloneSim = (s: SimState): SimState => ({
  ...s,
  a: { ...s.a },
  b: { ...s.b },
  ball: { ...s.ball },
});

export const paddleOf = (s: SimState, slot: Slot): Paddle => (slot === 0 ? s.a : s.b);

/** A cheap fingerprint of the whole state, to compare two clients' copies. */
export const simChecksum = (s: SimState): number => {
  const text = JSON.stringify(s);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + (text.codePointAt(i) ?? 0)) % 4_294_967_296;
  }
  return hash;
};

/** Seat this tick's input: a player's paddle sits on its target; without an
 *  input the AI holds it. */
const seat = (p: Paddle, input: SlotInput | null): void => {
  p.human = input !== null;
  if (input !== null) {
    p.x = input.x / PADDLE_STEPS;
  }
};

/** A confirm press on this tick: the counter moved since the last input. */
const pressed = (p: Paddle, input: SlotInput | null): boolean => {
  if (input === null) {
    return false;
  }
  const edge = p.c !== null && p.c !== input.c;
  p.c = input.c;
  return edge;
};

/** A power-shot cancel on this tick. */
const cancelled = (p: Paddle, input: SlotInput | null): boolean => {
  if (input === null) {
    return false;
  }
  const edge = p.k !== null && p.k !== input.k;
  p.k = input.k;
  return edge;
};

const settleCharges = (s: SimState): void => {
  s.a.charge = cancelCharge(s.a.charge);
  s.b.charge = cancelCharge(s.b.charge);
};

/** Serve toward the receiver, a seeded touch off straight. */
const serve = (s: SimState): void => {
  const { ball } = s;
  const towardY = s.receiver === 0 ? -1 : 1;
  const lateral = (random(s) * 2 - 1) * SERVE_LATERAL;
  s.serves += 1;
  s.phase = "rally";
  s.serveAt = null;
  s.speed = RALLY_SPEED_BASE;
  s.hits = 0;
  s.bounces = 0;
  s.lift = 1;
  s.arc = null;
  s.parked = false;
  settleCharges(s);
  ball.x = 0;
  ball.y = 0;
  ball.vx = lateral * s.speed;
  ball.vy = towardY * Math.sqrt(s.speed * s.speed - ball.vx * ball.vx);
  ball.spin = 0;
  ball.spinAge = 0;
  s.events.push({ key: `serve:${s.serves}`, kind: "serve", receiver: s.receiver });
};

/** A finished match starts over: 0–0, no charge, the first serve to slot A. */
const rematch = (s: SimState): void => {
  s.scoreA = 0;
  s.scoreB = 0;
  s.longest = 0;
  s.receiver = 0;
  s.a.charge = { hits: 0, kind: "charging" };
  s.b.charge = { hits: 0, kind: "charging" };
};

/** The AI: chase the ball's x at a fixed fraction of the rally pace, never past it. */
const chase = (s: SimState, p: Paddle): void => {
  const reach = s.speed * AI_SPEED_FRAC * TICK_S;
  const step = clamp(s.ball.x - p.x, -reach, reach);
  p.x = clamp(p.x + step, -PADDLE_X_MAX, PADDLE_X_MAX);
};

/** A paddle returns the ball: the pace ramp, the charge, the shot and its hop. */
const contact = (s: SimState, slot: Slot): void => {
  const p = paddleOf(s, slot);
  const towardY = slot === 0 ? 1 : -1;
  const { ball } = s;
  s.hits += 1;
  s.longest = Math.max(s.longest, s.hits);
  s.speed = Math.min(RALLY_SPEED_MAX, s.speed + RALLY_SPEED_STEP);
  s.bounces = 0;
  const accepted = acceptReturn(p.charge);
  p.charge = accepted.charge;
  const shot = contactShot((ball.x - p.x) / HIT_HALF_X, towardY, s.speed, accepted.powered);
  const out = reflectOffPaddle(ball.x, p.x, towardY, shot.speed);
  ball.vx = out.x;
  ball.vy = out.y;
  ball.spin = shot.spin;
  ball.spinAge = 0;
  s.lift = shot.lift;
  const landing = ARC_LAND_MIN + random(s) * (ARC_LAND_MAX - ARC_LAND_MIN);
  s.arc = { fromY: ball.y, toY: towardY * landing };
  s.freeze = STOP_PADDLE;
  s.events.push({
    hits: s.hits,
    key: `hit:${s.serves}:${s.hits}`,
    kind: "hit",
    powered: accepted.powered,
    shot: shot.kind,
    slot,
    spin: shot.spin,
    vx: ball.vx,
    vy: ball.vy,
    x: ball.x,
    y: ball.y,
  });
};

/** The ball crossed a goal line: score, park it there through the goal beat,
 *  and set the next serve's clock. */
const point = (s: SimState, scorer: Slot): void => {
  const { ball } = s;
  if (scorer === 0) {
    s.scoreA += 1;
  } else {
    s.scoreB += 1;
  }
  const won = s.scoreA >= WIN_SCORE || s.scoreB >= WIN_SCORE;
  ball.x = clamp(ball.x, -WALL_X, WALL_X);
  ball.y = scorer === 0 ? GOAL_Y : -GOAL_Y;
  ball.vx = 0;
  ball.vy = 0;
  ball.spin = 0;
  ball.spinAge = 0;
  s.parked = true;
  s.arc = null;
  settleCharges(s);
  s.phase = won ? "won" : "serving";
  s.freeze = won ? STOP_WIN : STOP_GOAL;
  s.serveAt = won ? null : s.tick + SERVE_DELAY_TICKS;
  s.receiver = scorer === 0 ? 1 : 0;
  s.events.push({ key: `point:${s.serves}`, kind: "point", scorer, won, x: ball.x, y: ball.y });
};

/** The cosmetic hop touches down. */
const landArc = (s: SimState): void => {
  const { arc } = s;
  if (arc !== null && (s.ball.y - arc.fromY) / (arc.toY - arc.fromY) >= 1) {
    s.arc = null;
    s.events.push({ key: `land:${s.serves}:${s.hits}`, kind: "land" });
  }
};

/** One tick of a live rally: AI paddles, flight, rails, contacts, goals. */
const rally = (s: SimState): void => {
  if (!s.a.human) {
    chase(s, s.a);
  }
  if (!s.b.human) {
    chase(s, s.b);
  }
  const { ball } = s;
  if (flyTick(ball)) {
    s.bounces += 1;
    s.events.push({
      key: `wall:${s.serves}:${s.hits}:${s.bounces}`,
      kind: "wall",
      x: Math.sign(ball.x) * WALL_X,
      y: ball.y,
    });
  }
  // A paddle only meets a ball moving toward it.
  if (ball.vy < 0 && hitsPaddle(ball, s.a.x, -PADDLE_Y)) {
    contact(s, 0);
  } else if (ball.vy > 0 && hitsPaddle(ball, s.b.x, PADDLE_Y)) {
    contact(s, 1);
  }
  landArc(s);
  if (ball.y > GOAL_Y) {
    point(s, 0);
  } else if (ball.y < -GOAL_Y) {
    point(s, 1);
  }
};

/** Power arms and cancels, mid-rally. */
const chargeIntents = (p: Paddle, press: boolean, cancel: boolean): void => {
  if (press) {
    p.charge = armCharge(p.charge);
  }
  if (cancel) {
    p.charge = cancelCharge(p.charge);
  }
};

/**
 * Advance one tick on slot A's and slot B's inputs (null: nobody steers that
 * paddle, so the AI does). Presses act whatever the hit-stop: between rallies
 * either player's confirm serves or rematches, mid-rally it arms that
 * player's charged return.
 */
export const stepSim = (s: SimState, inA: SlotInput | null, inB: SlotInput | null): void => {
  s.tick += 1;
  s.events = [];
  seat(s.a, inA);
  seat(s.b, inB);
  const pressA = pressed(s.a, inA);
  const pressB = pressed(s.b, inB);
  const cancelA = cancelled(s.a, inA);
  const cancelB = cancelled(s.b, inB);
  if (s.phase === "rally") {
    chargeIntents(s.a, pressA, cancelA);
    chargeIntents(s.b, pressB, cancelB);
  } else if (pressA || pressB) {
    if (s.phase === "won") {
      rematch(s);
    }
    serve(s);
  }
  if (s.freeze > 0) {
    s.freeze -= 1;
    if (s.freeze === 0 && s.parked) {
      s.parked = false;
      s.ball.x = 0;
      s.ball.y = 0;
    }
    return;
  }
  if (s.phase === "serving" && s.serveAt !== null && s.tick >= s.serveAt) {
    serve(s);
  }
  if (s.phase === "rally") {
    rally(s);
  }
};

/** Start the rally now (playtest states and the solo serve). */
export const serveNow = (s: SimState): void => {
  s.events = [];
  serve(s);
};
