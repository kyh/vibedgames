import { isCoarsePointer } from "@repo/embed";
import { PhysicalGamepad, attachDomGamepad } from "@vibedgames/gamepad/dom";
import type { DomGamepad } from "@vibedgames/gamepad/dom";

export const IS_TOUCH = isCoarsePointer();

const LEFT = ["KeyA", "ArrowLeft"];
const RIGHT = ["KeyD", "ArrowRight"];
const UP = ["KeyW", "ArrowUp"];
const DOWN = ["KeyS", "ArrowDown"];
const PUNCH = new Set(["Space", "KeyJ", "KeyX"]);
const BOOST = ["ShiftLeft", "ShiftRight", "KeyK", "KeyZ"];
const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN, ...PUNCH, ...BOOST]);

export class Input {
  private readonly keys = new Set<string>();
  private readonly touch: DomGamepad;
  private readonly pad = new PhysicalGamepad({
    bindings: { boost: ["b", "rb", "lt"], punch: ["a", "x", "rt"] },
  });
  private punchQueued = false;

  constructor(tint: string) {
    window.addEventListener("keydown", (event) => {
      if (GAME_KEYS.has(event.code)) {
        event.preventDefault();
      }

      if (PUNCH.has(event.code) && !event.repeat) {
        this.punchQueued = true;
      }

      this.keys.add(event.code);
    });
    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
    });
    this.touch = attachDomGamepad({
      buttons: [
        {
          id: "punch",
          label: "PUNCH",
          position: (v) => ({ x: v.width - 88 - v.inset.right, y: v.height - 96 - v.inset.bottom }),
          radius: 54,
        },
        {
          id: "boost",
          label: "BOOST",
          position: (v) => ({
            x: v.width - 196 - v.inset.right,
            y: v.height - 62 - v.inset.bottom,
          }),
          radius: 38,
        },
      ],
      render: { tint },
      stick: { deadZone: 6, radius: 56, region: (point, v) => point.x < v.width * 0.55 },
      visible: "coarse",
    });
  }

  /** Once per frame, before `read`. */
  update() {
    this.touch.update();
    this.pad.update();
  }

  /** Forget what is held: a pause swallows the key-up. */
  clear() {
    this.keys.clear();
    this.punchQueued = false;
  }

  /** Hide the touch overlay behind the title and results cards. */
  setTouchVisible(visible: boolean) {
    this.touch.setVisible(visible);
  }

  /** True on the frame a pad asks to start from the title. */
  anyStart() {
    return this.pad.justPressed("punch") || this.pad.justPressed("start");
  }

  /**
   * The stick as a direction on the screen (x right, z down, length 0–1), the
   * punch as one press, and boost while held.
   */
  read() {
    const down = (codes: readonly string[]) => codes.some((code) => this.keys.has(code));
    let mx = (down(RIGHT) ? 1 : 0) - (down(LEFT) ? 1 : 0);
    let mz = (down(DOWN) ? 1 : 0) - (down(UP) ? 1 : 0);
    const keyed = Math.hypot(mx, mz);

    if (keyed > 1) {
      mx /= keyed;
      mz /= keyed;
    }

    for (const stick of [this.touch.getStick(), this.pad.getStick()]) {
      if (stick.active && !stick.inDeadZone) {
        const size = Math.min(1, stick.magnitude * 1.15);
        mx = Math.cos(stick.angle) * size;
        mz = Math.sin(stick.angle) * size;
      }
    }

    const punch =
      this.punchQueued || this.pad.justPressed("punch") || this.touch.justPressed("punch");

    this.punchQueued = false;

    return {
      boost: down(BOOST) || this.pad.isButtonDown("boost") || this.touch.isButtonDown("boost"),
      mx,
      mz,
      punch,
    };
  }
}
