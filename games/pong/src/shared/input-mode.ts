export const COARSE_INPUT: boolean =
  ("matchMedia" in window && window.matchMedia("(pointer: coarse)").matches) ||
  "ontouchstart" in window;
