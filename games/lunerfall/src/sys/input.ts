import Phaser from "phaser";

import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";

// One frame's worth of intent. `*Pressed` are edge-triggered (true only the
// frame the key went down); the rest are held state. Buffering happens in the
// controller so a fixed-step loop consumes edges exactly once.
export type InputState = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jumpHeld: boolean;
  jumpPressed: boolean;
  dashPressed: boolean;
  attackPressed: boolean;
  specialPressed: boolean;
};

const K = Phaser.Input.Keyboard.KeyCodes;

// Stick → held-direction thresholds (on the 0–1 magnitude components).
// Horizontal is forgiving for run feel; vertical is deliberate so a diagonal
// thumb never drops through a platform (down) or re-aims a special (up) by
// accident. Stick-up is NOT jump — jump is its own button.
const STICK_X = 0.25;
const STICK_Y = 0.55;

export class Input {
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private pad?: PhaserGamepad;

  constructor(scene: Phaser.Scene, pad?: PhaserGamepad) {
    this.pad = pad;
    const kb = scene.input.keyboard;
    if (!kb) return;
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

  private held(name: string): boolean {
    const k = this.keys[name];
    return k ? k.isDown : false;
  }

  private justDown(name: string): boolean {
    const k = this.keys[name];
    return k ? Phaser.Input.Keyboard.JustDown(k) : false;
  }

  // Merge keyboard + virtual gamepad. The gamepad's edges are published by its
  // per-frame update() (called by the scene before sampling), and reading them
  // is idempotent within a frame — only Phaser's JustDown is consume-on-read.
  sample(): InputState {
    const gp = this.pad;
    let sx = 0;
    let sy = 0;
    const stick = gp?.getStick();
    if (stick && stick.active && !stick.inDeadZone) {
      sx = Math.cos(stick.angle) * stick.magnitude;
      sy = Math.sin(stick.angle) * stick.magnitude; // screen-space: +y is down
    }
    const left = this.held("a") || this.held("left") || sx < -STICK_X;
    const right = this.held("d") || this.held("right") || sx > STICK_X;
    const up = this.held("w") || this.held("up") || sy < -STICK_Y;
    const down = this.held("s") || this.held("down") || sy > STICK_Y;
    return {
      left,
      right,
      up,
      down,
      jumpHeld:
        this.held("space") ||
        this.held("w") ||
        this.held("up") ||
        (gp?.isButtonDown("jump") ?? false),
      jumpPressed:
        this.justDown("space") ||
        this.justDown("w") ||
        this.justDown("up") ||
        (gp?.justPressed("jump") ?? false),
      dashPressed:
        this.justDown("shift") || this.justDown("l") || (gp?.justPressed("dash") ?? false),
      attackPressed: this.justDown("j") || this.justDown("x") || (gp?.justPressed("atk") ?? false),
      specialPressed: this.justDown("k") || (gp?.justPressed("sp") ?? false),
    };
  }
}
