// The `vg playtest` surface: diagnostics, test hooks and the control manifest.
// See plugins/tooling/skills/playtest/references/autonomous-playtest.md.

import { publishDiagnostics, publishPlaytest, publishTestHooks } from "@vibedgames/playtest";
import type { ReflexInputs } from "@vibedgames/playtest";

import type { GameScene } from "./scenes/game-scene";
import { BIRD_H, FLAP_VELOCITY, GRAVITY, PIPE_GAP } from "./shared/constants";

type FlappyDiagnostics = ReturnType<GameScene["diagnostics"]>;

/** How far one flap carries the dragon up before gravity wins. */
const FLAP_RISE = FLAP_VELOCITY ** 2 / (2 * GRAVITY);
/** Clearance the pilot keeps between the dragon's body and either trunk. */
const TRUNK_MARGIN = 40;
/**
 * Flap lines, as the dragon's centre relative to the gap's centre (y down).
 * A flap at the line sweeps the band [line − FLAP_RISE, line], so the highest
 * safe line is the one whose apex still clears the upper trunk.
 */
const LINE_HIGH = -PIPE_GAP / 2 + BIRD_H / 2 + TRUNK_MARGIN + FLAP_RISE;
const LINE_LOW = PIPE_GAP / 2 - BIRD_H / 2 - TRUNK_MARGIN;
const LINE_CENTRE = (LINE_HIGH + LINE_LOW) / 2;
/**
 * Seconds of fall the pilot flaps ahead of: a key lands on the sim's next
 * frame. Any more lead flaps early, which lifts the whole band into the upper trunk.
 */
const LEAD_S = 1 / 60;
/** Frames between flaps: the key has to come up before it can go down again. */
const FLAP_COOLDOWN_FRAMES = 4;
/** Altitude held on the open runway, before the course has a gap to aim at. */
const RUNWAY_Y = 300;

const FLAP: ReflexInputs = { keys: ["Space"] };
const GLIDE: ReflexInputs = { keys: [] };

type Line = (diag: FlappyDiagnostics) => number;

const wantsFlap = (diag: FlappyDiagnostics, line: Line): boolean => {
  if (diag.phase === "ready") {
    return true;
  }
  const drop = diag.vy * LEAD_S;
  if (!diag.nextGap) {
    return diag.player.y + drop >= RUNWAY_Y;
  }
  return drop - diag.nextGap.centreDy >= line(diag);
};

/**
 * One pilot shared by every move, so switching intent mid-air never double
 * flaps. Flapping is edge-triggered and far tighter than a model's round trip:
 * the model picks which line through the gap to fly, this holds it per frame.
 */
const createPilot = (): ((line: Line) => (diag: FlappyDiagnostics | null) => ReflexInputs) => {
  let lastFlapFrame = -FLAP_COOLDOWN_FRAMES;
  return (line) => (diag) => {
    if (!diag?.canFlap) {
      return GLIDE;
    }
    // A rewound frame counter means the run restarted.
    if (diag.frame < lastFlapFrame) {
      lastFlapFrame = -FLAP_COOLDOWN_FRAMES;
    }
    if (diag.frame - lastFlapFrame < FLAP_COOLDOWN_FRAMES || !wantsFlap(diag, line)) {
      return GLIDE;
    }
    lastFlapFrame = diag.frame;
    return FLAP;
  };
};

const coinLine: Line = (diag) => {
  if (!diag.nextGap || !diag.nextCoin) {
    return LINE_CENTRE;
  }
  const coinFromCentre = diag.nextCoin.dy - diag.nextGap.centreDy;
  return Math.min(LINE_LOW, Math.max(LINE_HIGH, coinFromCentre + FLAP_RISE / 2));
};

export const publishPlaytestSurface = (scene: GameScene): void => {
  publishDiagnostics(() => scene.diagnostics());
  publishTestHooks({
    seed: (seed) => scene.testSeed(seed),
    setPausedForScreenshot: (paused) => {
      if (paused) {
        scene.game.loop.sleep();
      } else {
        scene.game.loop.wake();
      }
    },
    setState: (name) => ({ state: scene.testState(name) }),
  });

  const fly = createPilot();
  publishPlaytest<FlappyDiagnostics>({
    goal: [
      "Flappy Dragons: the dragon flies right on its own through an endless row of tree trunks, each with one gap. Gravity pulls it down; a flap kicks it up ~145 px. Touching a trunk or the ground ends the run (complete). score = gaps cleared + coins collected; every gap you survive is progress.",
      "You do not time flaps — each move is an autopilot that flaps for you every frame. You choose WHICH LINE it flies through the next gap, and you should re-choose as the state changes.",
      "Units are px, y points DOWN: a negative dy/centreDy is ABOVE the dragon. nextGap = the gap not yet cleared: dx to its trunk (<= 0 / inside:true means you are between the trunks now), centreDy to its middle, roomAbove/roomBelow = clearance to the upper/lower trunk (the gap is 350 tall, the dragon 48). gapAfter = the gap after that one, 400 px further. nextCoin = the coin inside nextGap (null when none or already taken). vy = vertical speed (+ is falling). floorDy = height above the deadly ground. phase 'ready' = hovering, the first flap launches.",
      "Default to thread_gap. Pick grab_coin whenever nextCoin is not null and nextCoin.dx > 60 — a coin is a free point. Once nextGap.dx < 150 (about one second out) prefer to keep the line you already hold. Use ride_high / ride_low only to set up for the gap after: ride_high when gapAfter.centreDy < -150, ride_low when gapAfter.centreDy > 150 and there is no coin to take.",
    ].join(" "),
    move: {
      grab_coin: {
        description:
          "Fly the line that passes through the coin in the next gap (+1 score), still clear of both trunks. Same as thread_gap when nextCoin is null",
        reflex: fly(coinLine),
      },
      ride_high: {
        description:
          "Fly through the upper part of the next gap — sets up for a following gap that is much higher (gapAfter.centreDy very negative)",
        reflex: fly(() => LINE_HIGH),
      },
      ride_low: {
        description:
          "Fly through the lower part of the next gap — sets up for a following gap that is much lower (gapAfter.centreDy very positive)",
        reflex: fly(() => LINE_LOW),
      },
      thread_gap: {
        description:
          "Fly through the middle of the next gap with the most clearance from both trunks — the safe default",
        reflex: fly(() => LINE_CENTRE),
      },
    },
  });
};
