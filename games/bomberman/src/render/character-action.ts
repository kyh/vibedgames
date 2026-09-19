import type { Dir } from "../shared/constants";

interface SheetFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  feetX: number;
  feetY: number;
}

interface ActionSheet {
  key: string;
  url: string;
  scale: number;
  frames: readonly [SheetFrame, SheetFrame, SheetFrame, SheetFrame];
}

// Sheets were generated as 2x2 edits of the original walk sheets and shipped
// untouched, so cells are unequal and padding is uneven: explicit cuts plus
// measured foot pivots keep the ground anchor, and one scale per sheet keeps
// the authored crouch depth.
const DOWN: ActionSheet = {
  frames: [
    { feetX: 344, feetY: 572, height: 586, width: 670, x: 0, y: 0 },
    { feetX: 327, feetY: 573, height: 586, width: 671, x: 670, y: 0 },
    { feetX: 346, feetY: 554, height: 587, width: 670, x: 0, y: 586 },
    { feetX: 326, feetY: 553, height: 587, width: 671, x: 670, y: 586 },
  ],
  key: "player-place-down",
  scale: 54 / 563,
  url: "assets/player-place-down-v2.png",
};
const UP: ActionSheet = {
  frames: [
    { feetX: 320, feetY: 494, height: 627, width: 627, x: 0, y: 0 },
    { feetX: 282, feetY: 484, height: 627, width: 627, x: 627, y: 0 },
    { feetX: 319, feetY: 482, height: 627, width: 627, x: 0, y: 627 },
    { feetX: 291, feetY: 475, height: 627, width: 627, x: 627, y: 627 },
  ],
  key: "player-place-up",
  scale: 54 / 408,
  url: "assets/player-place-up-v2.png",
};
const SIDE: ActionSheet = {
  frames: [
    { feetX: 300, feetY: 589, height: 627, width: 627, x: 0, y: 0 },
    { feetX: 281, feetY: 589, height: 627, width: 627, x: 627, y: 0 },
    { feetX: 322, feetY: 557, height: 627, width: 627, x: 0, y: 627 },
    { feetX: 320, feetY: 561, height: 627, width: 627, x: 627, y: 627 },
  ],
  key: "player-place-side",
  scale: 54 / 530,
  url: "assets/player-place-side-v2.png",
};
const VICTORY: ActionSheet = {
  frames: [
    { feetX: 350, feetY: 517, height: 560, width: 661, x: 0, y: 0 },
    { feetX: 310, feetY: 516, height: 560, width: 661, x: 661, y: 0 },
    { feetX: 350, feetY: 577, height: 630, width: 661, x: 0, y: 560 },
    { feetX: 303, feetY: 577, height: 630, width: 661, x: 661, y: 560 },
  ],
  key: "player-victory",
  scale: 54 / 497,
  url: "assets/player-victory-v2.png",
};

export const ACTION_SHEETS: readonly ActionSheet[] = [DOWN, UP, SIDE, VICTORY];

/** Left and right share one sheet; the render flips it. */
const walkSheet = (dir: Dir): ActionSheet => {
  if (dir === "up") {
    return UP;
  }
  if (dir === "down") {
    return DOWN;
  }
  return SIDE;
};
export const PLACE_ACTION_MS = 280;
export const VICTORY_ACTION_MS = 720;

export interface CharacterPose {
  dir: Dir;
  moving: boolean;
  col: number;
  row: number;
}

type Action =
  | { kind: "idle" }
  | { kind: "place"; at: number; pose: CharacterPose }
  | { kind: "victory"; at: number; pose: CharacterPose; moving: boolean };

export interface ActionFrame {
  key: string;
  frame: number;
  scale: number;
  flip: boolean;
}

/** One visual owner, never a movement/collision owner. Accepted bomb timestamps
 * are consumed even when too late or moving, so later snapshots cannot replay. */
export class CharacterAction {
  private action: Action = { kind: "idle" };
  private lastPlacement: { id: string; at: number } | null = null;

  place(
    bomb: { id: string; placedAt: number; col: number; row: number },
    simNow: number,
    sceneNow: number,
    pose: CharacterPose,
  ): boolean {
    if (
      this.lastPlacement &&
      (bomb.id === this.lastPlacement.id || bomb.placedAt <= this.lastPlacement.at)
    ) {
      return false;
    }
    this.lastPlacement = { at: bomb.placedAt, id: bomb.id };
    const age = simNow - bomb.placedAt;
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age >= PLACE_ACTION_MS ||
      pose.moving ||
      pose.col !== bomb.col ||
      pose.row !== bomb.row ||
      this.action.kind === "victory"
    ) {
      return false;
    }
    this.action = { at: sceneNow - age, kind: "place", pose: { ...pose } };
    return true;
  }

  victory(at: number, pose: CharacterPose): void {
    this.action = { at, kind: "victory", moving: pose.moving, pose: { ...pose } };
  }

  sample(now: number, pose: CharacterPose, alive: boolean): ActionFrame | null {
    const { action } = this;
    if (action.kind === "idle") {
      return null;
    }
    if (
      !alive ||
      pose.col !== action.pose.col ||
      pose.row !== action.pose.row ||
      pose.dir !== action.pose.dir ||
      (action.kind === "place" ? pose.moving : pose.moving && !action.moving)
    ) {
      this.interrupt();
      return null;
    }
    if (action.kind === "victory") {
      action.moving = pose.moving;
    }
    const age = Math.max(0, now - action.at);
    if (action.kind === "place" && age >= PLACE_ACTION_MS) {
      this.interrupt();
      return null;
    }
    const sheet = action.kind === "victory" ? VICTORY : walkSheet(pose.dir);
    const duration = action.kind === "place" ? PLACE_ACTION_MS : VICTORY_ACTION_MS;
    return {
      flip: action.kind === "place" && pose.dir === "left",
      frame: Math.min(3, Math.floor((age / duration) * 4)),
      key: sheet.key,
      scale: sheet.scale,
    };
  }

  interrupt(): void {
    this.action = { kind: "idle" };
  }

  reset(): void {
    this.interrupt();
    this.lastPlacement = null;
  }
}
