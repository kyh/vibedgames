import type { Inset, VisibilityPolicy } from "./types.js";

const ZERO: Inset = { bottom: 0, left: 0, right: 0, top: 0 };

let probe: HTMLElement | null = null;

// oxlint-disable-next-line unicorn/prefer-number-coercion -- computed style is a CSS length like "34px"; Number() gives NaN
const px = (length: string): number => Number.parseFloat(length) || 0;

/**
 * Read the device safe-area insets (`env(safe-area-inset-*)`) via a hidden
 * probe element, for feeding `VirtualGamepad.setViewport`. Returns zeros when
 * there is no DOM or no notch. Requires `viewport-fit=cover` in the page's
 * viewport meta tag to report non-zero values on iOS.
 */
export const safeAreaInset = (): Inset => {
  if (typeof document === "undefined" || !document.body) {
    return ZERO;
  }
  if (!probe || !probe.isConnected) {
    probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) " +
      "env(safe-area-inset-bottom) env(safe-area-inset-left);";
    document.body.append(probe);
  }
  const s = getComputedStyle(probe);
  return {
    bottom: px(s.paddingBottom),
    left: px(s.paddingLeft),
    right: px(s.paddingRight),
    top: px(s.paddingTop),
  };
};

/** Whether the overlay should render before any touch has been seen. */
export const preShow = (policy: VisibilityPolicy): boolean => {
  if (policy === "always") {
    return true;
  }
  if (policy !== "coarse") {
    return false;
  }
  return (
    typeof window !== "undefined" &&
    (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window)
  );
};
