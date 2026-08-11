import type Phaser from "phaser";

/** How far a press may travel and still count as a press, in screen px. */
const SLOP = 12;
/** How long a *touch* may last and still count as a tap. */
const TAP_MS = 250;

/** Touch-first device, decided at boot (NOT after the first touch) so hint
 *  copy and touch-only HUD controls are right from the first frame. */
export function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window)
  );
}

/** A quick press that never dragged. The floating stick claims every touch on
 *  pointerdown, so tile taps are only recognisable at pointerup — short-lived
 *  and still within the stick's dead zone. */
export function isTap(p: Phaser.Input.Pointer): boolean {
  return p.getDuration() < TAP_MS && Math.hypot(p.x - p.downX, p.y - p.downY) < SLOP;
}

/** A press that picked the thing under it: a tap for a finger, and for a mouse
 *  any click that stayed put — a slow deliberate click is still a click, and a
 *  mouse never feeds the stick. */
export function isPick(p: Phaser.Input.Pointer): boolean {
  return p.wasTouch ? isTap(p) : Math.hypot(p.x - p.downX, p.y - p.downY) < SLOP;
}
