import { attachDomGamepad, type DomGamepad } from "@vibedgames/gamepad/dom";

import type { InputState } from "../input/keyboard";

type Btn = "gas" | "brake" | "boost";

// No gas pedal on touch: a finger on the screen IS the throttle (see update()).
const MAP: Record<string, Btn> = {
  "t-brake": "brake",
  "t-boost": "boost",
};

/** Drag distance that maps to full lock. Matches the stick's own radius. */
const STICK_RADIUS = 62;
/** Stick pulled down past this = the pedal. Well below the steering band so a
 *  thumb sagging through a corner never drags the brake. */
const STICK_BRAKE_PX = STICK_RADIUS * 0.55;

export type TouchControls = {
  /** Coarse-pointer device — drives the touch copy on the landing screen. */
  readonly isTouch: boolean;
  /** Pump once per frame: publishes stick state into the shared InputState. */
  update(): void;
  /** Swap the pedal cap between BRAKE and REVERSE (call with the car's
   *  reverse-gate state each frame; only touches the DOM on change). */
  setReverseHint(canReverse: boolean): void;
};

/** Boot-time input mode for controls and instruction copy. */
export function isTouchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

// Wire the on-screen pedals + the shared virtual stick to the input state.
// Pedals are plain DOM (they need pedal shapes, not the pad's round buttons);
// steering is the gamepad package's floating stick, so a thumb anywhere on the
// open canvas anchors it. `[data-gamepad-ignore]` on #touch/#banner keeps taps
// on the pedals and the landing CTA from anchoring a stick underneath them.
export function setupTouch(input: InputState, onChat?: () => void): TouchControls {
  const isTouch = isTouchDevice();
  const container = document.getElementById("touch");
  if (!container) return { isTouch: false, update: () => {}, setReverseHint: () => {} };
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
  if (onChat) document.getElementById("t-chat")?.addEventListener("click", onChat);

  // Steering only — no pad buttons, and only on touch devices (the adapter
  // already ignores mouse pointers, so desktop never sees it).
  const gamepad: DomGamepad = attachDomGamepad({
    stick: { radius: STICK_RADIUS, deadZone: 7, knobRadius: 26 },
    render: { tint: "#ffd147", zIndex: 6 },
  });

  const cap = document.querySelector("#t-brake .cap");
  let reverseHint = false;

  return {
    isTouch,
    update(): void {
      gamepad.update();
      const stick = gamepad.getStick();
      // Horizontal drag alone steers: this is a wheel, not a heading joystick.
      input.setTouchSteer(stick.active && !stick.inDeadZone ? stick.dx / STICK_RADIUS : 0);
      // Stick pulled DOWN is the pedal — brake while rolling, reverse from a
      // stop — mirroring ↓ on keyboard. It also lifts the gas so the brake
      // bites at full ramp instead of fighting a pinned throttle.
      const stickBrake = stick.active && stick.dy > STICK_BRAKE_PX;
      input.setTouch("stickBrake", stickBrake);
      // A finger on the screen IS the gas — held through braking, so brake +
      // steer still power-drifts. The car resolves the conflict: the brake only
      // outranks the gas below 0.5 u/s, which is exactly the reverse gear.
      input.setTouch("gas", stick.active && !stickBrake);
    },
    setReverseHint(canReverse: boolean): void {
      if (canReverse === reverseHint || !cap) return;
      reverseHint = canReverse;
      cap.textContent = canReverse ? "REVERSE" : "BRAKE";
    },
  };
}

// Buttons belong over the live run only, never floating on the title/gameover
// banner. Display needs both `.on` (touch device) and `.play` (active run).
export function setTouchPlaying(active: boolean): void {
  document.getElementById("touch")?.classList.toggle("play", active);
}
