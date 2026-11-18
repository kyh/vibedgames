import { stickDirection4, stickDirection8 } from "@vibedgames/gamepad";
import type { StickState } from "@vibedgames/gamepad";
import type { Dir } from "../shared/constants";

const isDir = (value: string | undefined): value is Dir =>
  value === "up" || value === "down" || value === "left" || value === "right";

/** A stick's direction, then — pushed off-axis, towards a diagonal — the other axis as a fallback. */
export const stickDirs: (stick: StickState) => Dir[] = (stick) => {
  const primary = stickDirection4(stick);

  if (!primary) {
    return [];
  }

  const secondary = stickDirection8(stick)
    ?.split("-")
    .find((part) => part !== primary);

  return isDir(secondary) ? [primary, secondary] : [primary];
};

export class DirInput {
  private readonly held: Dir[] = [];
  private turn: { dir: Dir; deferred: boolean } | null = null;

  /** A direction's press edge (keyboard keydown, d-pad button). */
  press(dir: Dir) {
    this.release(dir);
    this.held.push(dir);
    this.turn = { deferred: false, dir };
  }

  /** Drop every direction no source holds any more — a keyup can be lost to a pause or a focus change. */
  sync(isHeld: (dir: Dir) => boolean) {
    for (const dir of this.held.filter((held) => !isHeld(held))) {
      this.release(dir);
    }
  }

  /**
   * The direction of the next step: the buffered turn, then the held
   * directions newest first, then `fallback` (analog sticks) — the first one
   * `open` lets through. Call once per step decision.
   */
  choose(open: (dir: Dir) => boolean, fallback: readonly Dir[] = []) {
    const { turn } = this;
    const wanted = turn ? [turn.dir, ...this.held.toReversed()] : this.held.toReversed();
    const dir = [...wanted, ...fallback].find(open) ?? null;
    this.turn =
      turn && dir !== null && dir !== turn.dir && !turn.deferred
        ? { ...turn, deferred: true }
        : null;

    return dir;
  }

  reset() {
    this.held.length = 0;
    this.turn = null;
  }

  private release(dir: Dir) {
    const index = this.held.indexOf(dir);

    if (index !== -1) {
      this.held.splice(index, 1);
    }
  }
}
