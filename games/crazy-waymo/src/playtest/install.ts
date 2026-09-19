// The playtest contract for `vg playtest run`: diagnostics a model can decide
// from, the hooks that stage a solo run, and the manifest whose moves are all
// reflexes — steering a car is 60 fps work that a ~200 ms-stale decision
// cannot do, so the model picks the errand and the reflex drives it.
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { Diagnostics, ReflexInputs } from "@vibedgames/playtest";

import type { GameScene } from "../scenes/game-scene";
import { Navigator } from "./navigator";
import type { FareOption, NavReadout, PickupIntent, PlaytestView } from "./navigator";

interface FareSummary {
  tier: FareOption["tier"];
  distance: number;
}

interface WaymoDiagnostics extends Diagnostics {
  phase: PlaytestView["phase"];
  /** Live cash: what `score` has earned, minus traffic-hit penalties. */
  cash: number;
  faresDelivered: number;
  combo: number;
  /** Signed forward speed, units/s (top speed 30, boost 44; negative = reversing). */
  speed: number;
  boostReady: boolean;
  hasPassenger: boolean;
  /** 1 = fresh, 0 = the passenger bails unpaid. */
  passengerPatience: number;
  stuck: boolean;
  stuckSeconds: number;
  nav: NavReadout | null;
  pickups: { nearest: FareSummary; richest: FareSummary; sameFare: boolean } | null;
}

const STUCK_AFTER = 1;
const REVERSE_MS = 1300;
const STEER_DEADBAND_DEG = 3;
const STEER_FULL_DEG = 14;
const BOOST_MIN = 30;
// Lifting off only sheds 22 u/s²; on a descent gravity adds more than that.
const BRAKE_MARGIN = 3;
const DRIFT_MIN_SPEED = 9;

const summary = (fare: FareOption): FareSummary => ({
  distance: Math.round(fare.distance),
  tier: fare.tier,
});

/** Digital keys as an analogue wheel: hold the steer key for a share of frames. */
const makeSteer = (): ((errorDeg: number, reversing: boolean) => string[]) => {
  let credit = 0;
  return (errorDeg, reversing) => {
    const size = Math.abs(errorDeg);
    if (size < STEER_DEADBAND_DEG) {
      credit = 0;
      return [];
    }
    credit += Math.min(1, size / STEER_FULL_DEG);
    if (credit < 1) {
      return [];
    }
    credit -= 1;
    // Reversing swaps which way the nose swings for a given key.
    const left = errorDeg > 0 !== reversing;
    return [left ? "ArrowLeft" : "ArrowRight"];
  };
};

export const installPlaytest = (game: GameScene): void => {
  const navigator = new Navigator(() => game.playtestView());

  publishDiagnostics((): WaymoDiagnostics => {
    const view = game.playtestView();
    if (!view) {
      return {
        boostReady: false,
        cash: 0,
        combo: 1,
        complete: false,
        faresDelivered: 0,
        frame: 0,
        hasPassenger: false,
        nav: null,
        passengerPatience: 1,
        phase: "loading",
        pickups: null,
        score: 0,
        speed: 0,
        stuck: false,
        stuckSeconds: 0,
      };
    }
    const { car, fares, state } = view;
    const hasPassenger = fares.carryingInfo() !== null;
    const options = hasPassenger ? null : navigator.fareOptions();
    const { stuckSeconds } = navigator;
    return {
      boostReady: car.boostMeter >= BOOST_MIN,
      cash: state.displayScore,
      combo: state.combo,
      // Endless: no run clock and nothing kills the car.
      complete: false,
      entities: view.traffic?.cars.length ?? 0,
      faresDelivered: state.fares,
      frame: view.frame,
      hasPassenger,
      nav: navigator.read(),
      passengerPatience: Math.round(fares.patienceFrac() * 100) / 100,
      phase: view.phase,
      pickups: options
        ? {
            nearest: summary(options.nearest),
            richest: summary(options.richest),
            sameFare:
              options.nearest.x === options.richest.x && options.nearest.z === options.richest.z,
          }
        : null,
      player: {
        x: Math.round(car.position.x * 10) / 10,
        y: Math.round(car.position.y * 10) / 10,
        z: Math.round(car.position.z * 10) / 10,
      },
      score: state.earned,
      speed: Math.round(car.forwardSpeed * 10) / 10,
      stuck: stuckSeconds >= STUCK_AFTER,
      stuckSeconds: Math.round(stuckSeconds * 10) / 10,
    };
  });

  if (!import.meta.env.DEV && !isPlaytestRequested()) {
    return;
  }

  publishTestHooks({
    seed: (seed) => game.playtestSeed(seed),
    setPausedForScreenshot: (paused) => (paused ? game.requestPause() : game.requestResume()),
    setState: (name) =>
      name === "active-play" && game.playtestStart() ? { state: name } : undefined,
  });

  const steer = makeSteer();
  let reverseUntil = 0;
  let reverseFrom = 0;
  let lockLeft = false;

  // Backing out, and when that goes nowhere (a wall ahead, a hill behind) full
  // lock forwards instead: the nose slides along the wall until it clears.
  // The lock swaps side each attempt — the route's side may be the wall's.
  const reverseOut = (diag: WaymoDiagnostics): ReflexInputs => {
    const error = diag.nav?.headingErrorDeg ?? 0;
    const now = performance.now();
    if (reverseFrom === 0 || now - reverseFrom > REVERSE_MS * 2) {
      reverseFrom = now;
      lockLeft = !lockLeft;
    }
    const backing = now - reverseFrom < REVERSE_MS * 0.6 || diag.speed < -1;
    if (backing) {
      return { keys: ["ArrowDown", ...steer(error, true)] };
    }
    return { keys: ["ArrowUp", lockLeft ? "ArrowLeft" : "ArrowRight"] };
  };

  const pedals = (diag: WaymoDiagnostics, nav: NavReadout): string[] => {
    // Facing the wrong way: crawl round rather than power into the far kerb.
    const limit =
      Math.abs(nav.headingErrorDeg) > 60 ? Math.min(nav.targetSpeed, 10) : nav.targetSpeed;
    // Brake + steer is this game's drift: the tail steps out and the line is
    // gone. The brake sheds 82 u/s², so the pilot straightens for the instant
    // it takes, then steers again.
    const braking = diag.speed > limit + BRAKE_MARGIN;
    if (braking && diag.speed > DRIFT_MIN_SPEED) {
      return ["ArrowDown"];
    }
    const keys = steer(nav.headingErrorDeg, diag.speed < -0.5);
    if (braking) {
      keys.push("ArrowDown");
    } else if (diag.speed < limit) {
      keys.push("ArrowUp");
    }
    return keys;
  };

  const drive = (
    diag: WaymoDiagnostics | null,
    intent: PickupIntent,
    boost: boolean,
  ): ReflexInputs => {
    navigator.pickupIntent = intent;
    const nav = diag?.nav;
    if (!diag || !nav || diag.phase !== "playing") {
      return { keys: [] };
    }
    const now = performance.now();
    if (diag.stuckSeconds >= STUCK_AFTER && now > reverseUntil + REVERSE_MS) {
      reverseUntil = now + REVERSE_MS;
    }
    if (now < reverseUntil) {
      return reverseOut(diag);
    }
    const keys = pedals(diag, nav);
    const open =
      nav.turnAheadDeg < 12 && Math.abs(nav.headingErrorDeg) < 8 && nav.routeDistance > 120;
    if (boost && open && diag.boostReady && nav.blocker === null) {
      keys.push("ShiftLeft");
    }
    return { keys };
  };

  publishPlaytest<WaymoDiagnostics>({
    goal: [
      "You drive a robotaxi in San Francisco. Earn cash: pick up a waiting fare, then deliver them to their drop-off. game.score is cash earned and only a completed drop-off raises it meaningfully. The run is endless and nothing kills the car; the only way to lose is to waste time — a passenger whose game.passengerPatience reaches 0 bails without paying.",
      "You do not steer. Each move is an autopilot that follows the street route (game.nav) to the current objective, slows for corners and backs out of a wall by itself. You choose the errand.",
      'game.hasPassenger false → choose a pickup: `pickup_nearest` is the quick fare; `pickup_richest` is the best-paying tier (game.pickups.richest.tier: "long" pays most, then "medium", then "short") and is worth it when game.pickups.richest.distance is under about twice game.pickups.nearest.distance. If game.pickups.sameFare is true they are the same fare — choose `pickup_nearest`.',
      "game.hasPassenger true → `deliver`. Choose `deliver_fast` instead when game.boostReady is true and game.nav.turnAheadDeg is under 12 (a straight street ahead) — boost gets the tip for a fast ride.",
      "game.nav: objective (pickup|dropoff), routeDistance = street distance left in world units (a block is ~100; top speed covers 30 a second), headingErrorDeg = how far the nose is off the route, turnAheadDeg = sharpest bend coming, targetSpeed = what the corners allow. game.speed is signed units/s.",
      "game.stuck true (speed ~0 for over a second — wedged on a wall, a parked car or traffic) and it stays true across decisions → `reverse_out` for one decision, then go back to the errand.",
    ].join(" "),
    // World units: a 180 ms hold at cruise covers ~5, but a corner or a launch far less.
    minDisplacement: 0.5,
    move: {
      deliver: {
        description:
          "Carrying a passenger: drive the street route to their drop-off at a safe pace (if the car is empty this heads for the nearest fare instead)",
        reflex: (diag) => drive(diag, "nearest", false),
      },
      deliver_fast: {
        description:
          "Carrying a passenger on an open straight with boost ready: same route to the drop-off, boosting on the straights for a bigger tip",
        reflex: (diag) => drive(diag, "nearest", true),
      },
      pickup_nearest: {
        description:
          "Car is empty: drive the street route to the NEAREST waiting fare (if a passenger is aboard this delivers them instead)",
        reflex: (diag) => drive(diag, "nearest", false),
      },
      pickup_richest: {
        description:
          "Car is empty: drive the street route to the BEST-PAYING waiting fare, even if it is further",
        reflex: (diag) => drive(diag, "richest", false),
      },
      reverse_out: {
        description:
          "Only when game.stuck is true: back away from whatever the car is wedged against, swinging the nose towards the route",
        reflex: (diag) => (diag && diag.phase === "playing" ? reverseOut(diag) : { keys: [] }),
      },
    },
  });
};
