import type { Dir } from "../shared/constants";

type SheetFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
  feetX: number;
  feetY: number;
};

type ActionSheet = {
  key: string;
  url: string;
  scale: number;
  frames: readonly [SheetFrame, SheetFrame, SheetFrame, SheetFrame];
};

// Raw generated PNGs stay intact. Unequal cuts and authored foot pivots keep
// the existing ground anchor; one scale per sheet preserves its actual crouch.
const DOWN: ActionSheet = {
  key: "player-place-down",
  url: "assets/player-place-down-v2.png",
  scale: 54 / 563,
  frames: [
    { x: 0, y: 0, width: 670, height: 586, feetX: 344, feetY: 572 },
    { x: 670, y: 0, width: 671, height: 586, feetX: 327, feetY: 573 },
    { x: 0, y: 586, width: 670, height: 587, feetX: 346, feetY: 554 },
    { x: 670, y: 586, width: 671, height: 587, feetX: 326, feetY: 553 },
  ],
};
const UP: ActionSheet = {
  key: "player-place-up",
  url: "assets/player-place-up-v2.png",
  scale: 54 / 408,
  frames: [
    { x: 0, y: 0, width: 627, height: 627, feetX: 320, feetY: 494 },
    { x: 627, y: 0, width: 627, height: 627, feetX: 282, feetY: 484 },
    { x: 0, y: 627, width: 627, height: 627, feetX: 319, feetY: 482 },
    { x: 627, y: 627, width: 627, height: 627, feetX: 291, feetY: 475 },
  ],
};
const SIDE: ActionSheet = {
  key: "player-place-side",
  url: "assets/player-place-side-v2.png",
  scale: 54 / 530,
  frames: [
    { x: 0, y: 0, width: 627, height: 627, feetX: 300, feetY: 589 },
    { x: 627, y: 0, width: 627, height: 627, feetX: 281, feetY: 589 },
    { x: 0, y: 627, width: 627, height: 627, feetX: 322, feetY: 557 },
    { x: 627, y: 627, width: 627, height: 627, feetX: 320, feetY: 561 },
  ],
};
const VICTORY: ActionSheet = {
  key: "player-victory",
  url: "assets/player-victory-v2.png",
  scale: 54 / 497,
  frames: [
    { x: 0, y: 0, width: 661, height: 560, feetX: 350, feetY: 517 },
    { x: 661, y: 0, width: 661, height: 560, feetX: 310, feetY: 516 },
    { x: 0, y: 560, width: 661, height: 630, feetX: 350, feetY: 577 },
    { x: 661, y: 560, width: 661, height: 630, feetX: 303, feetY: 577 },
  ],
};

export const ACTION_SHEETS: readonly ActionSheet[] = [DOWN, UP, SIDE, VICTORY];
export const PLACE_ACTION_MS = 280;
export const VICTORY_ACTION_MS = 720;

export type CharacterPose = {
  dir: Dir;
  moving: boolean;
  col: number;
  row: number;
};

type Action =
  | { kind: "idle" }
  | { kind: "place"; at: number; pose: CharacterPose }
  | { kind: "victory"; at: number; pose: CharacterPose; moving: boolean };

export type ActionFrame = {
  key: string;
  frame: number;
  scale: number;
  flip: boolean;
};

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
    )
      return false;
    this.lastPlacement = { id: bomb.id, at: bomb.placedAt };
    const age = simNow - bomb.placedAt;
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age >= PLACE_ACTION_MS ||
      pose.moving ||
      pose.col !== bomb.col ||
      pose.row !== bomb.row ||
      this.action.kind === "victory"
    )
      return false;
    this.action = { kind: "place", at: sceneNow - age, pose: { ...pose } };
    return true;
  }

  victory(at: number, pose: CharacterPose): void {
    this.action = { kind: "victory", at, pose: { ...pose }, moving: pose.moving };
  }

  sample(now: number, pose: CharacterPose, alive: boolean): ActionFrame | null {
    const action = this.action;
    if (action.kind === "idle") return null;
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
    if (action.kind === "victory") action.moving = pose.moving;
    const age = Math.max(0, now - action.at);
    if (action.kind === "place" && age >= PLACE_ACTION_MS) {
      this.interrupt();
      return null;
    }
    const sheet =
      action.kind === "victory"
        ? VICTORY
        : pose.dir === "up"
          ? UP
          : pose.dir === "down"
            ? DOWN
            : SIDE;
    const duration = action.kind === "place" ? PLACE_ACTION_MS : VICTORY_ACTION_MS;
    return {
      key: sheet.key,
      frame: Math.min(3, Math.floor((age / duration) * 4)),
      scale: sheet.scale,
      flip: action.kind === "place" && pose.dir === "left",
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
