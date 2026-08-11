// A tap that dismisses an overlay must not also act in the game underneath.
//
// ./game already states the keyboard half of this rule ("keyup, not keydown —
// a keydown dismissal leaks the paired keyup into the game"). Touch has two
// leaks of its own, and a full-screen overlay hits both:
//
//   - The gesture's own pointer/touch events bubble PAST the overlay. Phaser
//     registers its input listeners on window (`inputWindowEvents`) precisely
//     so it can see taps that miss its canvas, so a tap on an overlay still
//     reaches the scene as an ordinary pointer down.
//   - Once the overlay stops hit-testing — hidden, faded, unmounted — the
//     browser's compatibility mousedown/mouseup/click for that same touch
//     re-target to whatever is now underneath, i.e. the canvas.
//
// Measured in Chrome (emulated iPhone, CDP touch): the compatibility burst
// lands ~1ms after touchend, so no unmount delay outruns it, and calling
// preventDefault() on the pointerup does NOT suppress it. Cancelling the
// touchend does — the burst is that event's default action.

/** Every event type that can carry a tap from an overlay into the game. */
const SEALED_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "mousedown",
  "mousemove",
  "mouseup",
  "click",
] as const;

export type PointerSealOptions = {
  /**
   * Targets whose synthesized click must survive, e.g. an overlay's own "how
   * to play" button wired on `click`. Propagation into the game is stopped
   * either way. Default: none — an overlay dismissed on pointerup needs no
   * click at all.
   */
  keepClick?: (target: EventTarget | null) => boolean;
};

/**
 * Contain every pointer gesture that lands on `el`: the game never sees it,
 * and the touch that dismisses `el` produces no compatibility mouse events.
 *
 * Listeners sit on `el` in the BUBBLE phase, so the overlay's own children
 * handle their taps first, and `el`'s other listeners (the resume handler)
 * still run — stopPropagation() never affects same-node listeners.
 *
 * Returns an unseal for an element that outlives the overlay.
 */
export function sealPointerEvents(el: HTMLElement, options: PointerSealOptions = {}): () => void {
  const seal = (event: Event): void => {
    event.stopPropagation();
    if (event.type !== "touchend" || !event.cancelable) return;
    if (options.keepClick?.(event.target) ?? false) return;
    event.preventDefault();
  };
  // Non-passive: the touchend branch above cancels the event.
  for (const type of SEALED_EVENTS) el.addEventListener(type, seal, { passive: false });
  return () => {
    for (const type of SEALED_EVENTS) el.removeEventListener(type, seal);
  };
}
