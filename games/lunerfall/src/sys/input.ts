import Phaser from "phaser";

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

export class Input {
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};

  constructor(scene: Phaser.Scene) {
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

  sample(): InputState {
    const left = this.held("a") || this.held("left");
    const right = this.held("d") || this.held("right");
    const up = this.held("w") || this.held("up");
    const down = this.held("s") || this.held("down");
    return {
      left,
      right,
      up,
      down,
      jumpHeld: this.held("space") || this.held("w") || this.held("up"),
      jumpPressed: this.justDown("space") || this.justDown("w") || this.justDown("up"),
      dashPressed: this.justDown("shift") || this.justDown("l"),
      attackPressed: this.justDown("j") || this.justDown("x"),
      specialPressed: this.justDown("k"),
    };
  }
}
