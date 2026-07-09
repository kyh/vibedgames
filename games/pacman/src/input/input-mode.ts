// Decided once at boot so hint copy is input-aware immediately — waiting for
// the first touch would show keyboard instructions on every phone title screen.
export const IS_TOUCH: boolean =
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
