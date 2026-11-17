// Keyboard, touch and controller folded into the one KartInput the sim reads.
// Touch drives itself: the thumb only steers, so a phone player has a free
// thumb for the drift button — the whole game is in when you let go of it.

import { isCoarsePointer } from "@repo/embed";
import { PhysicalGamepad, attachDomGamepad } from "@vibedgames/gamepad/dom";
import type { DomGamepad } from "@vibedgames/gamepad/dom";

import type { KartInput } from "../sim/kart";

export const IS_TOUCH = isCoarsePointer();

const LEFT = ["KeyA", "ArrowLeft"];
const RIGHT = ["KeyD", "ArrowRight"];
const GAS = ["KeyW", "ArrowUp"];
const BRAKE = ["KeyS", "ArrowDown"];
const DRIFT = ["Space", "ShiftLeft", "ShiftRight"];
const DRIVING_KEYS = new Set([...LEFT, ...RIGHT, ...GAS, ...BRAKE, ...DRIFT]);

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class Input {
  private readonly keys = new Set<string>();
  private readonly touch: DomGamepad;
  private readonly pad = new PhysicalGamepad({
    bindings: { brake: ["b"], drift: ["x", "rb"], gas: ["a"] },
  });

  constructor(tint: string) {
    window.addEventListener("keydown", (event) => {
      if (DRIVING_KEYS.has(event.code)) {
        // Arrows and Space would scroll a framed page.
        event.preventDefault();
      }
      this.keys.add(event.code);
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    window.addEventListener("blur", () => this.keys.clear());
    this.touch = attachDomGamepad({
      buttons: [
        {
          id: "drift",
          label: "DRIFT",
          position: (v) => ({ x: v.width - 84 - v.inset.right, y: v.height - 92 - v.inset.bottom }),
          radius: 52,
        },
        {
          id: "brake",
          label: "BRAKE",
          position: (v) => ({
            x: v.width - 190 - v.inset.right,
            y: v.height - 62 - v.inset.bottom,
          }),
          radius: 36,
        },
      ],
      render: { tint },
      // The right third belongs to the buttons: a thumb that misses one must not steer.
      stick: { deadZone: 6, radius: 56, region: (point, v) => point.x < v.width * 0.6 },
      visible: "coarse",
    });
  }

  /** Once per frame, before `read`. */
  update(): void {
    this.touch.update();
    this.pad.update();
  }

  /** Hide the touch overlay behind the title and results cards. */
  setTouchVisible(visible: boolean): void {
    this.touch.setVisible(visible);
  }

  /** True on the frame any "go" input is down — starts the race from the title. */
  anyStart(): boolean {
    return this.pad.justPressed("gas") || this.pad.justPressed("start");
  }

  read(): KartInput {
    const down = (codes: readonly string[]): boolean => codes.some((code) => this.keys.has(code));
    let steer = (down(RIGHT) ? 1 : 0) - (down(LEFT) ? 1 : 0);
    let throttle = down(GAS) ? 1 : 0;
    let brake = down(BRAKE) ? 1 : 0;
    let drift = down(DRIFT);

    const stick = this.touch.getStick();
    if (this.touch.isTouch) {
      // A touch player never holds a gas pedal.
      throttle = 1;
      if (stick.active && !stick.inDeadZone) {
        steer = clamp(Math.cos(stick.angle) * stick.magnitude * 1.25, -1, 1);
      }
      brake = Math.max(brake, this.touch.isButtonDown("brake") ? 1 : 0);
      drift ||= this.touch.isButtonDown("drift");
    }

    const padStick = this.pad.getStick();
    if (padStick.active && !padStick.inDeadZone) {
      steer = clamp(Math.cos(padStick.angle) * padStick.magnitude, -1, 1);
    }
    throttle = Math.max(throttle, this.pad.buttonValue("rt"), this.pad.isButtonDown("gas") ? 1 : 0);
    brake = Math.max(brake, this.pad.buttonValue("lt"), this.pad.isButtonDown("brake") ? 1 : 0);
    drift ||= this.pad.isButtonDown("drift");

    return { brake, drift, steer, throttle: brake > 0 ? 0 : throttle };
  }
}
