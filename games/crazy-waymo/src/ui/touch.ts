import type { InputState } from "../input/keyboard";

type Btn = "gas" | "brake" | "left" | "right" | "boost";

const MAP: Record<string, Btn> = {
  "t-gas": "gas",
  "t-brake": "brake",
  "t-left": "left",
  "t-right": "right",
  "t-boost": "boost",
};

// Wire on-screen buttons to the shared input state. Shown only on touch devices.
export function setupTouch(input: InputState): boolean {
  const isTouch = window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const container = document.getElementById("touch");
  if (!container) return false;
  if (isTouch) container.classList.add("on");

  for (const [id, btn] of Object.entries(MAP)) {
    const node = document.getElementById(id);
    if (!node) continue;
    const down = (e: Event): void => {
      e.preventDefault();
      input.setTouch(btn, true);
    };
    const up = (e: Event): void => {
      e.preventDefault();
      input.setTouch(btn, false);
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    node.addEventListener("pointerleave", up);
  }
  return isTouch;
}
