import type { Inset, VisibilityPolicy } from "./types.js";

const ZERO: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

let probe: HTMLElement | null = null;

/**
 * Read the device safe-area insets (`env(safe-area-inset-*)`) via a hidden
 * probe element, for feeding `VirtualGamepad.setViewport`. Returns zeros when
 * there is no DOM or no notch. Requires `viewport-fit=cover` in the page's
 * viewport meta tag to report non-zero values on iOS.
 */
export function safeAreaInset(): Inset {
  if (typeof document === "undefined" || !document.body) return ZERO;
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) " +
      "env(safe-area-inset-bottom) env(safe-area-inset-left);";
    document.body.appendChild(probe);
  }
  const s = getComputedStyle(probe);
  return {
    top: Number.parseFloat(s.paddingTop) || 0,
    right: Number.parseFloat(s.paddingRight) || 0,
    bottom: Number.parseFloat(s.paddingBottom) || 0,
    left: Number.parseFloat(s.paddingLeft) || 0,
  };
}

/** Whether the overlay should render before any touch has been seen. */
export function preShow(policy: VisibilityPolicy): boolean {
  if (policy === "always") return true;
  if (policy !== "coarse") return false;
  return (
    typeof window !== "undefined" &&
    (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window)
  );
}
