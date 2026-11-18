export const IS_TOUCH: boolean =
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
