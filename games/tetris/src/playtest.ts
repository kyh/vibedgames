// What `vg playtest run` may do to this game, in the words the decision model
// chooses between. The model has no eyes and answers a few times a second, so
// it never taps a slab along cell by cell: it names the 2x2 patch of floor to
// build on, and a per-frame reflex taps the arrows until the slab is over it,
// then hard-drops. The taps are edge-triggered in the game (DAS would turn a
// long hold into a slide), which is why they are a reflex and not held keys.

import type { PlaytestManifest, ReflexInputs } from "@vibedgames/playtest";

import { screenToWorld } from "./game/camera-correction";
import type { ScreenDir } from "./game/camera-correction";
import { ZONES } from "./game/placement";
import type { Zone } from "./game/placement";
import type { TetrisDiagnostics } from "./scenes/game-scene";

export type PlaytestDiagnostics = TetrisDiagnostics & { paused: boolean };

const ARROWS: [ScreenDir, string][] = [
  ["left", "ArrowLeft"],
  ["right", "ArrowRight"],
  ["away", "ArrowUp"],
  ["near", "ArrowDown"],
];

// A press has to span a game frame to be read and a release has to span one
// to re-arm the edge; three frames each survives the two loops interleaving.
const TAP_PERIOD_FRAMES = 6;
const TAP_DOWN_FRAMES = 3;
// A decision is made from a state up to ~250 ms old and lands ~250 ms later:
// a younger slab is still being steered by a choice made for the previous one.
const DECIDED_AGE_MS = 650;

const RELEASED: ReflexInputs = { keys: [] };

/** The arrow that pushes the slab one world step along (dx, dz) from this camera corner. */
const arrowFor = (corner: number, dx: number, dz: number): string | null => {
  for (const [dir, code] of ARROWS) {
    const move = screenToWorld(corner, dir);
    if (move.dx === dx && move.dz === dz) {
      return code;
    }
  }
  return null;
};

const placeOver =
  (zone: Zone) =>
  (diag: PlaytestDiagnostics | null): ReflexInputs => {
    if (!diag || diag.phase !== "playing" || !diag.piece) {
      return RELEASED;
    }
    if (diag.frame % TAP_PERIOD_FRAMES >= TAP_DOWN_FRAMES) {
      return RELEASED;
    }
    const plan = diag.zones[zone.name];
    const keys: string[] = [];
    if (plan && plan.dx !== 0) {
      keys.push(arrowFor(diag.corner, Math.sign(plan.dx), 0) ?? "");
    }
    if (plan && plan.dz !== 0) {
      keys.push(arrowFor(diag.corner, 0, Math.sign(plan.dz)) ?? "");
    }
    const steering = keys.filter((code) => code !== "");
    if (steering.length > 0) {
      return { keys: steering };
    }
    return diag.piece.ageMs >= DECIDED_AGE_MS ? { keys: ["Space"] } : RELEASED;
  };

const catchStack = (diag: PlaytestDiagnostics | null): ReflexInputs =>
  diag?.phase === "collapsing" && diag.frame % TAP_PERIOD_FRAMES < TAP_DOWN_FRAMES
    ? { keys: ["Space"] }
    : RELEASED;

type Moves = PlaytestManifest<PlaytestDiagnostics>["move"];

const zoneMoves = (): Moves => {
  const moves: Moves = {};
  for (const zone of ZONES) {
    moves[zone.name] = {
      description: `Drop the slab over columns x${zone.x}-${zone.x + 1}, rows z${zone.z}-${zone.z + 1} (see game.zones.${zone.name} for where it lands)`,
      reflex: placeOver(zone),
    };
  }
  return moves;
};

export const playtestManifest: PlaytestManifest<PlaytestDiagnostics> = {
  actions: {
    power: {
      description:
        "fire the power sweep, which deletes the whole bottom layer — only when game.powerReady is true and game.maxHeight is 5 or more",
      keys: ["KeyF"],
    },
    rotate: {
      description:
        "turn the slab a quarter turn — only when game.bestIfRotated beats game.best: more clears, else a smaller land + gaps",
      keys: ["KeyR"],
    },
  },
  goal: [
    "3D Tetris in an 8x8 well, 12 layers tall. Flat one-layer slabs (game.piece, then game.next) fall one at a time; you choose the 2x2 floor zone to drop each over and it is steered there and hard-dropped for you.",
    "A line clears when all 8 cells along x, or all 8 along z, of one layer are filled; clears and drops raise game.score. The run ends when a slab locks on layer game.deathHeight or higher, so keep game.maxHeight low and the stack flat.",
    "game.heights[z][x] is how many layers are stacked on each pillar (one base-36 digit each). game.zones[name] says what dropping there does: `land` is the layer it rests on, `gaps` the empty cells it would bury, `clears` the lines it completes. The slab is snugged up to a cell either way to the best fit in the zone. game.bestZones names the zones worth choosing, best first — a line clear if one is on offer, else the lowest fit that buries the fewest cells; choose the first unless you would rather build elsewhere. A zone missing from game.zones cannot be reached any more.",
    "The answer changes with every slab: never keep choosing a zone whose `land` is climbing. If game.phase is `collapsing` the stack is toppling and game.catchMsLeft is counting down: choose catch_stack at once to save the run.",
  ].join(" "),
  // One tap moves the slab one cell.
  minDisplacement: 0.5,
  move: {
    ...zoneMoves(),
    catch_stack: {
      description:
        "Catch the toppling stack — the only useful choice while game.phase is `collapsing`, useless otherwise",
      reflex: catchStack,
    },
  },
};
