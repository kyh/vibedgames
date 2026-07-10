// Touch-first device detection, decided ONCE at boot so hint copy ("tap" vs
// "click") is correct from the first frame — not after the first touch.
export const COARSE_INPUT: boolean =
  (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) ||
  "ontouchstart" in window;
