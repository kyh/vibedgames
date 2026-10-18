// What a driver reads off the minimap and the street ahead, as numbers: the
// route to the current objective, how far off it the nose points, and how fast
// the next corner allows. Computed on read (memoised per frame), so a session
// nobody is playtesting pays nothing.
import type { FareTier } from "../game/fare-tier";
import type { FareManager } from "../game/fares";
import type { GameState } from "../game/state";
import type { Traffic } from "../game/traffic";
import { CAR } from "../shared/constants";
import type { GameMode } from "../shared/types";
import type { Car } from "../vehicle/car";
import { bearingAt, locate, planRoute, pointAt } from "./route";
import type { Route, RouteFix, RoutePoint, RouteWorld } from "./route";

export interface PlaytestView {
  readonly frame: number;
  readonly phase: GameMode["kind"];
  readonly car: Car;
  readonly fares: FareManager;
  readonly state: GameState;
  readonly world: RouteWorld;
  readonly traffic: Traffic | null;
}

export type PickupIntent = "nearest" | "richest";

export interface FareOption {
  readonly tier: FareTier;
  /** Straight-line distance, world units. */
  readonly distance: number;
  readonly x: number;
  readonly z: number;
}

export interface NavReadout {
  readonly objective: "pickup" | "dropoff" | "destination";
  /** The fare's tier; null for a destination picked on the map. */
  readonly tier: FareTier | null;
  /** Objective relative to the car, world units (+dx east, +dz south). */
  readonly dx: number;
  readonly dz: number;
  /** Distance left along the streets, world units. */
  readonly routeDistance: number;
  /** Degrees the nose must swing to face the route ahead: + = steer LEFT, − = steer RIGHT. */
  readonly headingErrorDeg: number;
  /** Sharpest bend in the next 45 units of route, degrees. */
  readonly turnAheadDeg: number;
  /** Speed the route ahead allows right now (corners + the stop), units/s. */
  readonly targetSpeed: number;
  /** How far the car has strayed from the route, world units. */
  readonly offRoute: number;
  /** Nearest traffic car in the way; the autopilot is already steering round it. */
  readonly blocker: {
    readonly distance: number;
    readonly side: "left" | "right" | "centre";
  } | null;
}

interface SpeedPlan {
  readonly speed: number;
  /** Radians. */
  readonly bend: number;
}

interface Blocker {
  readonly ahead: number;
  readonly x: number;
  readonly z: number;
}

const TIER_RANK: Record<FareTier, number> = { long: 2, medium: 1, short: 0 };
const REPLAN_FRAMES = 120;
const OFF_ROUTE = 22;
const FACING_AWAY = 1.9;
const STUCK_SPEED = 1.5;
// Longest gap between two reads that still counts towards being stuck, seconds.
const MAX_STUCK_STEP = 0.25;
// Deceleration the speed plan assumes: a coast, so a corner can be met without the brake.
const PLAN_DECEL = 22;
const CORNER_SPEED_MIN = 9;
// Be down to corner speed this far before the bend: turn-in starts there.
const CORNER_ENTRY = 12;
const BLOCKER_RANGE = 26;
// Half a lane either side of the nose: wider and oncoming traffic counts.
const BLOCKER_HALF_WIDTH = 2.2;
const PASS_CLEARANCE = 3;
const PASS_SPEED = 14;
const GENTLE_BEND = 0.2;
const HARD_BEND = 1.2;
// A destination is a stop, not a drive-through: brake to rest this far short of it,
// on a profile about half the brake (26 u/s², built over 0.35 s) so the ramp,
// a downhill and the pilot's reaction all fit inside it.
const STOP_AT = 2;
const STOP_DECEL = 12;

const wrap = (a: number): number => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Route-left unit vector: heading grows anticlockwise seen from above. */
const leftOf = (bearing: number): RoutePoint => ({ x: Math.cos(bearing), z: -Math.sin(bearing) });

const cornerSpeed = (bend: number): number => {
  const t = Math.min(1, Math.max(0, (bend - GENTLE_BEND) / (HARD_BEND - GENTLE_BEND)));
  return CAR.maxSpeed + (CORNER_SPEED_MIN - CAR.maxSpeed) * t;
};

/** What the corners ahead of arclength `s` allow now, and the sharpest of the near ones. */
const speedPlan = (route: Route, s: number): SpeedPlan => {
  let speed: number = CAR.maxSpeed;
  let sharpest = 0;
  for (let d = 0; d <= 90 && s + d <= route.length; d += 6) {
    const bend = Math.abs(wrap(bearingAt(route, s + d + 10) - bearingAt(route, s + d - 4)));
    if (d <= 45) {
      sharpest = Math.max(sharpest, bend);
    }
    const corner = cornerSpeed(bend);
    speed = Math.min(
      speed,
      Math.sqrt(corner * corner + 2 * PLAN_DECEL * Math.max(0, d - CORNER_ENTRY)),
    );
  }
  return { bend: sharpest, speed };
};

/** The nearest traffic car the nose is about to meet. */
const findBlocker = (v: PlaytestView): Blocker | null => {
  const { car } = v;
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  let best: Blocker | null = null;
  for (const other of v.traffic?.cars ?? []) {
    const dx = other.position.x - car.position.x;
    const dz = other.position.z - car.position.z;
    const ahead = dx * fx + dz * fz;
    const lateral = dx * fz - dz * fx;
    const inPath = ahead > 1.5 && ahead < BLOCKER_RANGE && Math.abs(lateral) < BLOCKER_HALF_WIDTH;
    if (inPath && (!best || ahead < best.ahead)) {
      best = { ahead, x: other.position.x, z: other.position.z };
    }
  }
  return best;
};

interface Pass {
  /** Lateral shift of the driving line, + = route-left. */
  readonly offset: number;
  readonly blockerSide: "left" | "right" | "centre";
}

/**
 * How far to shift the driving line to get round a blocker: a car's width
 * towards the centreline — the kerb side is where the parked cars are.
 */
const planPass = (route: Route, from: number, blocker: Blocker): Pass | null => {
  const at = locate(route, blocker.x, blocker.z, from);
  if (at.offset > 8 || at.s < from - 2) {
    return null;
  }
  const centre = pointAt(route, at.s);
  const left = leftOf(bearingAt(route, at.s));
  const offset = (blocker.x - centre.x) * left.x + (blocker.z - centre.z) * left.z;
  let blockerSide: Pass["blockerSide"] = "centre";
  if (Math.abs(offset) > 0.5) {
    blockerSide = offset > 0 ? "left" : "right";
  }
  return {
    blockerSide,
    offset: offset > 0.5 ? offset - PASS_CLEARANCE : offset + PASS_CLEARANCE,
  };
};

interface Target {
  readonly kind: NavReadout["objective"];
  readonly tier: FareTier | null;
  readonly x: number;
  readonly z: number;
}

export class Navigator {
  pickupIntent: PickupIntent = "nearest";
  /** A street point to drive to instead of the fares (the map's click-to-drive). */
  destination: RoutePoint | null = null;
  private readonly view: () => PlaytestView | null;
  private route: Route | null = null;
  private routeKey = "";
  private routeS = 0;
  private trimmed: {
    readonly route: Route;
    readonly s: number;
    readonly pts: Float64Array;
  } | null = null;
  private plannedAt = 0;
  private memoFrame = -1;
  private memo: NavReadout | null = null;
  private lastRead = 0;
  private stuckFor = 0;

  constructor(view: () => PlaytestView | null) {
    this.view = view;
  }

  /** What is left of the route, from the car's spot on it: [x0,z0, x1,z1, ...] for drawing. */
  get remainingRoute(): Float64Array | null {
    const { route } = this;
    if (!route) {
      return null;
    }
    if (this.trimmed?.route !== route || this.trimmed.s !== this.routeS) {
      const s = this.routeS;
      const from = pointAt(route, s);
      const flat = [from.x, from.z];
      for (let k = 0; k < route.cum.length; k += 1) {
        if ((route.cum[k] ?? 0) > s) {
          flat.push(route.pts[k * 2] ?? 0, route.pts[k * 2 + 1] ?? 0);
        }
      }
      this.trimmed = { pts: new Float64Array(flat), route, s };
    }
    return this.trimmed.pts;
  }

  /** Seconds the car has sat at ~0 speed during live play. */
  get stuckSeconds(): number {
    this.read();
    return this.stuckFor;
  }

  fareOptions(): { nearest: FareOption; richest: FareOption } | null {
    const v = this.view();
    if (!v) {
      return null;
    }
    let nearest: FareOption | null = null;
    let richest: FareOption | null = null;
    for (const w of v.fares.waitingList()) {
      const option: FareOption = {
        distance: Math.hypot(w.x - v.car.position.x, w.z - v.car.position.z),
        tier: w.tier,
        x: w.x,
        z: w.z,
      };
      if (!nearest || option.distance < nearest.distance) {
        nearest = option;
      }
      const better =
        !richest ||
        TIER_RANK[option.tier] > TIER_RANK[richest.tier] ||
        (option.tier === richest.tier && option.distance < richest.distance);
      if (better) {
        richest = option;
      }
    }
    return nearest && richest ? { nearest, richest } : null;
  }

  read(): NavReadout | null {
    const v = this.view();
    if (!v) {
      return null;
    }
    if (v.frame === this.memoFrame) {
      return this.memo;
    }
    this.memoFrame = v.frame;
    this.trackStuck(v);
    this.memo = this.compute(v);
    return this.memo;
  }

  private trackStuck(v: PlaytestView): void {
    const now = performance.now();
    // Counted in read-to-read steps, each capped: a pause (or a hidden tab)
    // between two reads is not time spent wedged.
    const step = Math.min(MAX_STUCK_STEP, (now - this.lastRead) / 1000);
    this.lastRead = now;
    if (v.phase !== "playing" || Math.abs(v.car.forwardSpeed) > STUCK_SPEED) {
      this.stuckFor = 0;
      return;
    }
    this.stuckFor += step;
  }

  private target(v: PlaytestView): Target | null {
    if (this.destination) {
      return { kind: "destination", tier: null, ...this.destination };
    }
    const carrying = v.fares.carryingInfo();
    if (carrying) {
      return { kind: "dropoff", tier: carrying.tier, x: carrying.pos.x, z: carrying.pos.z };
    }
    const options = this.fareOptions();
    if (!options) {
      return null;
    }
    const { tier, x, z } = options[this.pickupIntent];
    return { kind: "pickup", tier, x, z };
  }

  /** The route to `fare` and where the car is on it, replanned only when it must be. */
  private follow(v: PlaytestView, key: string, fare: RoutePoint): RouteFix | null {
    const { x, z } = v.car.position;
    let fix = this.route ? locate(this.route, x, z, this.routeS) : null;
    // A route is kept while the car can still follow it. Replanning on a
    // timer flips between two near-equal routes as the nose swings; replanning
    // only once the car has been spun round lets the planner start from the
    // way it now faces.
    const facingAway =
      this.route !== null &&
      fix !== null &&
      v.frame - this.plannedAt > REPLAN_FRAMES &&
      Math.abs(wrap(bearingAt(this.route, fix.s) - v.car.heading)) > FACING_AWAY;
    if (key !== this.routeKey || !fix || fix.offset > OFF_ROUTE || facingAway) {
      this.route = planRoute(v.world, x, z, v.car.heading, fare.x, fare.z);
      this.routeKey = key;
      this.plannedAt = v.frame;
      fix = this.route ? locate(this.route, x, z, 0) : null;
    }
    this.routeS = fix?.s ?? 0;
    return fix;
  }

  private compute(v: PlaytestView): NavReadout | null {
    const target = this.target(v);
    if (!target) {
      return null;
    }
    const { x, z } = v.car.position;
    const fare = target;
    const fix = this.follow(v, `${target.kind}:${Math.round(fare.x)}:${Math.round(fare.z)}`, fare);
    const { route } = this;
    if (!route || !fix) {
      return null;
    }

    const speed = Math.abs(v.car.forwardSpeed);
    const lookahead = Math.min(20, Math.max(8, 7 + speed * 0.45));
    const blocker = findBlocker(v);
    const pass = blocker ? planPass(route, fix.s, blocker) : null;
    const onLine = pointAt(route, fix.s + lookahead);
    const left = leftOf(bearingAt(route, fix.s + lookahead));
    const shift = pass?.offset ?? 0;
    const headingError = wrap(
      Math.atan2(onLine.x + left.x * shift - x, onLine.z + left.z * shift - z) - v.car.heading,
    );
    const ahead = speedPlan(route, fix.s);
    const remaining = route.length - fix.s;
    const cruise =
      target.kind === "destination"
        ? Math.min(ahead.speed, Math.sqrt(2 * STOP_DECEL * Math.max(0, remaining - STOP_AT)))
        : ahead.speed;

    return {
      blocker:
        blocker && pass ? { distance: Math.round(blocker.ahead), side: pass.blockerSide } : null,
      dx: round1(fare.x - x),
      dz: round1(fare.z - z),
      headingErrorDeg: Math.round((headingError * 180) / Math.PI),
      objective: target.kind,
      offRoute: round1(fix.offset),
      routeDistance: Math.round(remaining),
      targetSpeed: round1(blocker && blocker.ahead < 14 ? Math.min(PASS_SPEED, cruise) : cruise),
      tier: target.tier,
      turnAheadDeg: Math.round((ahead.bend * 180) / Math.PI),
    };
  }
}
