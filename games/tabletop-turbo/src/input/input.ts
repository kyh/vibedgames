import { isCoarsePointer } from "@repo/embed";
import { PhysicalGamepad, attachDomGamepad } from "@vibedgames/gamepad/dom";
import type { DomGamepad } from "@vibedgames/gamepad/dom";

export const IS_TOUCH = isCoarsePointer();

const LEFT = ["KeyA", "ArrowLeft"];
const RIGHT = ["KeyD", "ArrowRight"];
const UP = ["KeyW", "ArrowUp"];
const DOWN = ["KeyS", "ArrowDown"];
const ATTACK = new Set(["Space", "KeyJ", "KeyX"]);
const SPECIAL = new Set(["KeyE", "KeyL", "KeyC"]);
const BOOST = ["ShiftLeft", "ShiftRight", "KeyK", "KeyZ"];
const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...UP, ...DOWN, ...ATTACK, ...SPECIAL, ...BOOST]);

export class Input {
  private readonly keys = new Set<string>();
  private readonly touch: DomGamepad;
  private readonly pad = new PhysicalGamepad({
    bindings: { attack: ["a", "x", "rt"], boost: ["b", "rb", "lt"], special: ["y", "lb"] },
  });
  private attackQueued = false;
  private specialQueued = false;

  constructor(tint: string) {
    window.addEventListener("keydown", (event) => {
      if (GAME_KEYS.has(event.code)) {
        event.preventDefault();
      }

      if (ATTACK.has(event.code) && !event.repeat) {
        this.attackQueued = true;
      }

      if (SPECIAL.has(event.code) && !event.repeat) {
        this.specialQueued = true;
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
          id: "attack",
          label: "HIT",
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
        {
          id: "special",
          label: "ITEM",
          position: (v) => ({
            x: v.width - 172 - v.inset.right,
            y: v.height - 160 - v.inset.bottom,
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
    this.attackQueued = false;
    this.specialQueued = false;
  }

  /** The touch overlay in the player's colour. */
  setTint(css: string) {
    this.touch.setTint(css);
  }

  /** Hide the touch overlay behind the title and results cards. */
  setTouchVisible(visible: boolean) {
    this.touch.setVisible(visible);
  }

  /** True on the frame a pad asks to start from the title. */
  anyStart() {
    return this.pad.justPressed("attack") || this.pad.justPressed("start");
  }

  /** The title's picker on a pad: -1, 0 or 1 across (car type) and down (colour), once a press. */
  pick() {
    const { pad } = this;
    const across = (pad.justPressed("right") ? 1 : 0) - (pad.justPressed("left") ? 1 : 0);
    const down = (pad.justPressed("down") ? 1 : 0) - (pad.justPressed("up") ? 1 : 0);

    return { across, down };
  }

  /**
   * The stick as the driver sees it, the car's nose up the screen (`sx` right,
   * `sy` ahead, length 0–1), the attack and the special as one press each, and
   * boost while held.
   */
  read() {
    const down = (codes: readonly string[]) => codes.some((code) => this.keys.has(code));
    let sx = (down(RIGHT) ? 1 : 0) - (down(LEFT) ? 1 : 0);
    let sy = (down(UP) ? 1 : 0) - (down(DOWN) ? 1 : 0);
    const keyed = Math.hypot(sx, sy);

    if (keyed > 1) {
      sx /= keyed;
      sy /= keyed;
    }

    for (const stick of [this.touch.getStick(), this.pad.getStick()]) {
      if (stick.active && !stick.inDeadZone) {
        const size = Math.min(1, stick.magnitude * 1.15);
        sx = Math.cos(stick.angle) * size;
        sy = -Math.sin(stick.angle) * size;
      }
    }

    const attack =
      this.attackQueued || this.pad.justPressed("attack") || this.touch.justPressed("attack");

    const special =
      this.specialQueued || this.pad.justPressed("special") || this.touch.justPressed("special");

    this.attackQueued = false;
    this.specialQueued = false;

    return {
      attack,
      boost: down(BOOST) || this.pad.isButtonDown("boost") || this.touch.isButtonDown("boost"),
      special,
      sx,
      sy,
    };
  }
}
