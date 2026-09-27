import { definePlaytest } from "@vibedgames/playtest";
import type { Diagnostics, ReflexInputs } from "@vibedgames/playtest";
import type { Dir } from "./shared/constants";
import type { PlanStep, PlaytestView } from "./sim/playtest-view";

export type BombermanDiagnostics = Diagnostics &
  Partial<PlaytestView> & {
    phase: "connecting" | "start-screen" | "playing" | "dead" | "round-over";
    /** The step cooldown has elapsed: a direction pressed now moves one cell. */
    canStep: boolean;
    kills: number;
    cratesOpened: number;
    rivalsAlive: number;
    bombs: number;
    blasts: number;
  };

const DIR_KEY = {
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
} satisfies Record<Dir, string>;

// An empty hold, not null: a reflex that returns null leaves the previous
// frame's keys down, and a stale direction walks back into the blast.
const RELEASE: ReflexInputs = { keys: [] };

const isDir = (step: PlanStep): step is Dir => step in DIR_KEY;

// Directions go down only once the step cooldown has elapsed. The game queues
// a direction on its keydown edge, so a key pressed mid-step is taken a cell
// later — by which time the plan may have changed.
const press = (diag: BombermanDiagnostics, step: PlanStep): ReflexInputs => {
  if (step === "bomb") {
    return { keys: ["Space"] };
  }
  return isDir(step) && diag.canStep ? { keys: [DIR_KEY[step]] } : RELEASE;
};

type Intent = "crate" | "bot" | "powerup" | "bombHere";

/** Cover first, then the intent's next step, then the fallbacks' — so a move with no target still plays. */
const pursue =
  (...intents: Intent[]) =>
  (diag: BombermanDiagnostics | null): ReflexInputs => {
    const plan = diag?.plan;
    if (!diag || !plan) {
      return RELEASE;
    }
    if (diag.inDanger) {
      return press(diag, plan.cover);
    }
    const step = intents.map((intent) => plan[intent]).find((next) => next !== "none");
    return press(diag, step ?? "wait");
  };

const walk =
  (dir: Dir) =>
  (diag: BombermanDiagnostics | null): ReflexInputs => {
    const ahead = diag?.around?.[dir];
    if (!diag || ahead === undefined) {
      return RELEASE;
    }
    // A free step while a fuse burns is how a player walks into a dead end
    // beside their own bomb; cover outranks the direction, as in every move.
    if (diag.inDanger) {
      return press(diag, diag.plan?.cover ?? "wait");
    }
    return ahead === "open" ? press(diag, dir) : RELEASE;
  };

export const playtestManifest = definePlaytest<BombermanDiagnostics>({
  goal: [
    "Bomberman on a grid: you against 3 bots, last fighter standing wins.",
    "A bomb explodes about 2 seconds after it drops, in a + shape `blastRange` cells long. The fire kills anyone in it — you included — and opens crates; walls never break.",
    "`score` = crates your bombs opened + 10 per rival caught in your fire. `complete` turns true when you die or the round ends.",
    "Offsets (dx, dy) are in grid cells from you: +dx is right, +dy is down.",
    "`around` is the cell on each side of you: open, wall, crate, bomb, danger (a lit bomb will burn it), fire (burning now).",
    "`inDanger` means your own cell is about to burn.",
    "`plan` is the next input each move would make: a direction, bomb, wait, or none (nothing reachable — pick another move).",
    "Usual loop: break_crates to open the board and free powerups; grab_powerup when nearestPowerup is a few cells away (more bombs, longer fire, faster feet); hunt_rival once nearestBot is within about 6 cells or no crates are left.",
    "Every move runs out of a blast line on its own before doing anything else, so you never have to time a retreat.",
  ].join(" "),
  move: {
    bomb_here: {
      description:
        "Drop a bomb on this cell right now and run to cover — only when plan.bombHere is bomb (an escape exists); best when nearestBot.inBlastLine is true",
      reflex: pursue("bombHere"),
    },
    break_crates: {
      description:
        "Walk to the nearest crate, bomb it, take cover, repeat — scores 1 per crate and opens paths (the default while crates block the way)",
      reflex: pursue("crate"),
    },
    down: {
      description: "Step down (+dy), one cell at a time — only moves while around.down is open",
      reflex: walk("down"),
    },
    grab_powerup: {
      description:
        "Walk to the nearest powerup and pick it up (only when nearestPowerup is not null)",
      reflex: pursue("powerup", "crate"),
    },
    hunt_rival: {
      description:
        "Chase the nearest bot, bomb it when it is in the blast line, take cover — scores 10 per kill; breaks crates towards it when no path is open",
      reflex: pursue("bot", "crate"),
    },
    left: {
      description: "Step left (-dx), one cell at a time — only moves while around.left is open",
      reflex: walk("left"),
    },
    right: {
      description: "Step right (+dx), one cell at a time — only moves while around.right is open",
      reflex: walk("right"),
    },
    take_cover: {
      description:
        "Run to the nearest cell no bomb will burn and wait there (when inDanger is true)",
      reflex: pursue(),
    },
    up: {
      description: "Step up (-dy), one cell at a time — only moves while around.up is open",
      reflex: walk("up"),
    },
  },
});
