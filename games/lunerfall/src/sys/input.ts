import { Input as PhaserInput } from "phaser";

import { PhysicalGamepad } from "@vibedgames/gamepad/phaser";
import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";

export interface InputState {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jumpHeld: boolean;
  jumpPressed: boolean;
  dashPressed: boolean;
  attackPressed: boolean;
  specialPressed: boolean;
}

export const NEUTRAL_INPUT: InputState = {
  attackPressed: false,
  dashPressed: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  left: false,
  right: false,
  specialPressed: false,
  up: false,
};

const K = PhaserInput.Keyboard.KeyCodes;

const STICK_X = 0.25;
const STICK_Y = 0.55;

export class Input {
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private pad?: PhaserGamepad;
  private phys = new PhysicalGamepad();

  constructor(scene: Phaser.Scene, pad?: PhaserGamepad) {
    this.pad = pad;
    this.phys.update();
    const kb = scene.input.keyboard;

    if (!kb) {
      return;
    }

    const add = (name: string, code: number) => {
      this.keys[name] = kb.addKey(code, true, false);
    };

    add("a", K.A);
    add("d", K.D);
    add("w", K.W);
    add("s", K.S);
    add("left", K.LEFT);
    add("right", K.RIGHT);
    add("up", K.UP);
    add("down", K.DOWN);
    add("space", K.SPACE);
    add("shift", K.SHIFT);
    add("l", K.L);
    add("j", K.J);
    add("x", K.X);
    add("k", K.K);
  }

  /** Clear pause/transport input without manufacturing a fresh pad edge. */
  reset() {
    for (const key of Object.values(this.keys)) {
      key.reset();
    }

    this.pad?.pad.reset();
    this.pad?.pad.nextFrame();
    this.pad?.pad.nextFrame();
    this.phys.update();
    this.phys.update();
  }

  destroy() {
    this.phys.destroy();
  }

  private held(name: string) {
    const k = this.keys[name];

    return k ? k.isDown : false;
  }

  private justDown(name: string) {
    const k = this.keys[name];

    return k ? PhaserInput.Keyboard.JustDown(k) : false;
  }

  update() {
    this.phys.update();
  }

  sample() {
    const { down, left, right, up } = this.heldDirs();
    const { attackPressed, dashPressed } = this.attackDashEdges();
    const { jumpHeld, jumpPressed } = this.jumpButtons();

    const specialPressed =
      this.justDown("k") || (this.pad?.justPressed("sp") ?? false) || this.phys.justPressed("y");

    return {
      attackPressed,
      dashPressed,
      down,
      jumpHeld,
      jumpPressed,
      left,
      right,
      specialPressed,
      up,
    };
  }

  private axes() {
    let sx = 0;
    let sy = 0;
    const stick = this.pad?.getStick();

    if (stick && stick.active && !stick.inDeadZone) {
      sx = Math.cos(stick.angle) * stick.magnitude;
      sy = Math.sin(stick.angle) * stick.magnitude;
    }

    const ps = this.phys.getStick();

    return { px: ps.inDeadZone ? 0 : ps.dx, py: ps.inDeadZone ? 0 : ps.dy, sx, sy };
  }

  private heldDirs() {
    const { sx, sy, px, py } = this.axes();

    return {
      down:
        this.held("s") ||
        this.held("down") ||
        sy > STICK_Y ||
        py > STICK_Y ||
        this.phys.isButtonDown("down"),
      left:
        this.held("a") ||
        this.held("left") ||
        sx < -STICK_X ||
        px < -STICK_X ||
        this.phys.isButtonDown("left"),
      right:
        this.held("d") ||
        this.held("right") ||
        sx > STICK_X ||
        px > STICK_X ||
        this.phys.isButtonDown("right"),
      up:
        this.held("w") ||
        this.held("up") ||
        sy < -STICK_Y ||
        py < -STICK_Y ||
        this.phys.isButtonDown("up"),
    };
  }

  private attackDashEdges() {
    const gp = this.pad;

    return {
      attackPressed:
        this.justDown("j") ||
        this.justDown("x") ||
        (gp?.justPressed("atk") ?? false) ||
        this.phys.justPressed("x"),
      dashPressed:
        this.justDown("shift") ||
        this.justDown("l") ||
        (gp?.justPressed("dash") ?? false) ||
        this.phys.justPressed("b"),
    };
  }

  private jumpButtons() {
    const gp = this.pad;

    return {
      jumpHeld:
        this.held("space") ||
        this.held("w") ||
        this.held("up") ||
        (gp?.isButtonDown("jump") ?? false) ||
        this.phys.isButtonDown("a"),
      jumpPressed:
        this.justDown("space") ||
        this.justDown("w") ||
        this.justDown("up") ||
        (gp?.justPressed("jump") ?? false) ||
        this.phys.justPressed("a"),
    };
  }
}
