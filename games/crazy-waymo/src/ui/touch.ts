import { attachDomGamepad } from "@vibedgames/gamepad/dom";
import type { DomGamepad } from "@vibedgames/gamepad/dom";

import type { InputState } from "../input/keyboard";

type Btn = "gas" | "brake" | "boost";

const MAP = {
  "t-boost": "boost",
  "t-brake": "brake",
} satisfies Record<string, Btn>;

const STICK_RADIUS = 62;
const STICK_BRAKE_PX = STICK_RADIUS * 0.55;

export interface TouchControls {
  /** Coarse-pointer device — drives the touch copy on the landing screen. */
  readonly isTouch: boolean;
  /** Pump once per frame: publishes stick state into the shared InputState. */
  update: () => void;
  /** Swap the pedal cap between BRAKE and REVERSE (call with the car's
   *  reverse-gate state each frame; only touches the DOM on change). */
  setReverseHint: (canReverse: boolean) => void;
}

/** Boot-time input mode for controls and instruction copy. */
export const isTouchDevice = () =>
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

export const setupTouch = (input: InputState, onChat?: () => void) => {
  const isTouch = isTouchDevice();
  const container = document.querySelector("#touch");

  if (!container) {
    return {
      isTouch: false,
      setReverseHint: () => null,
      update: () => null,
    };
  }

  if (isTouch) {
    container.classList.add("on");
  }

  for (const [id, btn] of Object.entries(MAP)) {
    const node = document.querySelector(`#${id}`);

    if (!node) {
      continue;
    }

    const down = (e: Event) => {
      e.preventDefault();
      input.setTouch(btn, true);
    };

    const up = (e: Event) => {
      e.preventDefault();
      input.setTouch(btn, false);
    };

    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    node.addEventListener("pointerleave", up);
  }

  if (onChat) {
    document.querySelector("#t-chat")?.addEventListener("click", onChat);
  }

  const gamepad: DomGamepad = attachDomGamepad({
    render: { tint: "#ffd147", zIndex: 6 },
    stick: { deadZone: 7, knobRadius: 26, radius: STICK_RADIUS },
  });

  const cap = document.querySelector("#t-brake .cap");
  let reverseHint = false;

  return {
    isTouch,
    setReverseHint(canReverse: boolean) {
      if (canReverse === reverseHint || !cap) {
        return;
      }

      reverseHint = canReverse;
      cap.textContent = canReverse ? "REVERSE" : "BRAKE";
    },
    update() {
      gamepad.update();
      const stick = gamepad.getStick();
      input.setTouchSteer(stick.active && !stick.inDeadZone ? stick.dx / STICK_RADIUS : 0);
      const stickBrake = stick.active && stick.dy > STICK_BRAKE_PX;
      input.setTouch("stickBrake", stickBrake);
      input.setTouch("gas", stick.active && !stickBrake);
    },
  };
};

export const setTouchPlaying = (active: boolean) => {
  const controls = document.querySelector("#touch");

  if (!controls) {
    return;
  }

  controls.classList.toggle("play", active);
  controls.setAttribute("aria-hidden", String(!active));
};
