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

export interface PointerSealOptions {
  /**
   * Targets whose synthesized click must survive, e.g. an overlay's own "how
   * to play" button wired on `click`. Propagation into the game is stopped
   * either way. Default: none — an overlay dismissed on pointerup needs no
   * click at all.
   */
  keepClick?: (target: EventTarget | null) => boolean;
}

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
export const sealPointerEvents = (el: HTMLElement, options: PointerSealOptions = {}) => {
  const seal = (event: Event) => {
    event.stopPropagation();

    if (event.type !== "touchend" || !event.cancelable) {
      return;
    }

    if (options.keepClick?.(event.target) ?? false) {
      return;
    }

    event.preventDefault();
  };

  for (const type of SEALED_EVENTS) {
    el.addEventListener(type, seal, { passive: false });
  }

  return () => {
    for (const type of SEALED_EVENTS) {
      el.removeEventListener(type, seal);
    }
  };
};
