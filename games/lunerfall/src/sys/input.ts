import { Input as PhaserInput } from "phaser";

import { PhysicalGamepad } from "@vibedgames/gamepad/phaser";
import type { PhaserGamepad } from "@vibedgames/gamepad/phaser";

// One frame's worth of intent. `*Pressed` are edge-triggered (true only the
// frame the key went down); the rest are held state. Buffering happens in the
// controller so a fixed-step loop consumes edges exactly once.
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

const K = PhaserInput.Keyboard.KeyCodes;

// Stick → held-direction thresholds (on the 0–1 magnitude components).
// Horizontal is forgiving for run feel; vertical is deliberate so a diagonal
// thumb never drops through a platform (down) or re-aims a special (up) by
// accident. Stick-up is NOT jump — jump is its own button.
const STICK_X = 0.25;
const STICK_Y = 0.55;

export class Input {
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private pad?: PhaserGamepad;
  // Physical controller — same read API as the virtual pad, polled explicitly.
  private phys = new PhysicalGamepad();

  constructor(scene: Phaser.Scene, pad?: PhaserGamepad) {
    this.pad = pad;
    // Prime the pad state so a button held across a scene change (A just
    // confirmed the hub's "descend") doesn't read as a fresh press on frame 1.
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
  reset(): void {
    for (const key of Object.values(this.keys)) {
      key.reset();
    }
    this.pad?.pad.reset();
    this.pad?.pad.nextFrame();
    this.pad?.pad.nextFrame();
    this.phys.update();
    this.phys.update();
  }

  destroy(): void {
    this.phys.destroy();
  }

  private held(name: string): boolean {
    const k = this.keys[name];
    return k ? k.isDown : false;
  }

  private justDown(name: string): boolean {
    const k = this.keys[name];
    return k ? PhaserInput.Keyboard.JustDown(k) : false;
  }

  // Poll the physical pad and publish its press edges. The scene loop calls
  // this exactly once per frame (next to the virtual pad's update()), before
  // any sample() — never from sample() itself, so a second sample in a frame
  // could never eat an edge.
  update(): void {
    this.phys.update();
  }

  // Merge keyboard + virtual gamepad + physical controller. Both pads publish
  // edges from their per-frame update() (called by the scene before sampling),
  // and reading them is idempotent within a frame — only Phaser's JustDown is
  // consume-on-read.
  sample(): InputState {
    const { down, left, right, up } = this.heldDirs();
    // Fixed read order: Phaser's JustDown is consume-on-read.
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

  // Virtual stick (polar) + physical left stick (raw axes), both in screen space.
  private axes() {
    let sx = 0;
    let sy = 0;
    const stick = this.pad?.getStick();
    if (stick && stick.active && !stick.inDeadZone) {
      sx = Math.cos(stick.angle) * stick.magnitude;
      // screen-space: +y is down
      sy = Math.sin(stick.angle) * stick.magnitude;
    }
    const ps = this.phys.getStick();
    return { px: ps.inDeadZone ? 0 : ps.dx, py: ps.inDeadZone ? 0 : ps.dy, sx, sy };
  }

  // Held directions: keys, either stick past STICK_X/STICK_Y, or the d-pad.
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
