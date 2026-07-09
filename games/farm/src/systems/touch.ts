/** Touch-first device, decided at boot (NOT after the first touch) so hint
 *  copy and touch-only HUD controls are right from the first frame. */
export function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window)
  );
}
