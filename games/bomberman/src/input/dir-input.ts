// Which way the next grid step goes, from every direction input at once.
//
// Held keys are ranked by when they went down, newest first, so holding right
// and then pressing up turns up — and if up is a wall, right carries on
// instead of stopping dead. A press also lingers as a buffered turn: tapped
// just before a junction, it is kept through one step taken another way and
// spent at the opening, instead of being thrown away against the pillar.

import { stickDirection4, stickDirection8 } from "@vibedgames/gamepad";
import type { StickState } from "@vibedgames/gamepad";
import type { Dir } from "../shared/constants";

const isDir = (value: string | undefined): value is Dir =>
  value === "up" || value === "down" || value === "left" || value === "right";

/** A stick's direction, then — pushed off-axis, towards a diagonal — the other axis as a fallback. */
export const stickDirs = (stick: StickState): Dir[] => {
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
  /** Directions held down, most recent last. */
  private readonly held: Dir[] = [];
  /** The latest press, until it is walked, refused twice, or refused standing still. */
  private turn: { dir: Dir; deferred: boolean } | null = null;

  /** A direction's press edge (keyboard keydown, d-pad button). */
  press(dir: Dir): void {
    this.release(dir);
    this.held.push(dir);
    this.turn = { deferred: false, dir };
  }

  /** Drop every direction no source holds any more — a keyup can be lost to a pause or a focus change. */
  sync(isHeld: (dir: Dir) => boolean): void {
    for (const dir of this.held.filter((held) => !isHeld(held))) {
      this.release(dir);
    }
  }

  /**
   * The direction of the next step: the buffered turn, then the held
   * directions newest first, then `fallback` (analog sticks) — the first one
   * `open` lets through. Call once per step decision.
   */
  choose(open: (dir: Dir) => boolean, fallback: readonly Dir[] = []): Dir | null {
    const { turn } = this;
    const wanted = turn ? [turn.dir, ...this.held.toReversed()] : this.held.toReversed();
    const dir = [...wanted, ...fallback].find(open) ?? null;
    // A turn that was blocked survives exactly one step taken another way.
    this.turn =
      turn && dir !== null && dir !== turn.dir && !turn.deferred
        ? { ...turn, deferred: true }
        : null;
    return dir;
  }

  reset(): void {
    this.held.length = 0;
    this.turn = null;
  }

  private release(dir: Dir): void {
    const index = this.held.indexOf(dir);
    if (index !== -1) {
      this.held.splice(index, 1);
    }
  }
}
