import type Phaser from "phaser";

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
  const dx = p.x - p.downX;
  const dy = p.y - p.downY;
  return p.getDuration() < 250 && Math.hypot(dx, dy) < 12;
}
