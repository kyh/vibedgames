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
import type { CarInput } from "../vehicle/car";
import { Autopilot, STUCK_AFTER } from "./autopilot";
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

const BOOST_MIN = 30;

const summary = (fare: FareOption): FareSummary => ({
  distance: Math.round(fare.distance),
  tier: fare.tier,
});

/** Digital keys as an analogue wheel: hold the steer key for a share of frames. */
const makeKeys = (): ((input: CarInput) => string[]) => {
  let credit = 0;
  return (input) => {
    const keys: string[] = [];
    if (input.throttle > 0) {
      keys.push("ArrowUp");
    }
    if (input.brake > 0) {
      keys.push("ArrowDown");
    }
    if (input.boost) {
      keys.push("ShiftLeft");
    }
    if (input.steer === 0) {
      credit = 0;
      return keys;
    }
    credit += Math.abs(input.steer);
    if (credit >= 1) {
      credit -= 1;
      keys.push(input.steer < 0 ? "ArrowLeft" : "ArrowRight");
    }
    return keys;
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

  const pilot = new Autopilot();
  const toKeys = makeKeys();

  const drive = (
    diag: WaymoDiagnostics | null,
    intent: PickupIntent,
    boost: boolean,
  ): ReflexInputs => {
    navigator.pickupIntent = intent;
    return { keys: diag ? toKeys(pilot.drive(diag, boost)) : [] };
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
        reflex: (diag) => ({ keys: diag ? toKeys(pilot.reverseOut(diag)) : [] }),
      },
    },
  });
};
