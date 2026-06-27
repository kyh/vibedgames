import type { CarInput } from "../vehicle/car";

// Keyboard + touch-button input, merged into a single CarInput each frame.
export class InputState {
  private keys = new Set<string>();
  private touch = { gas: false, brake: false, left: false, right: false, drift: false };
  startPressed = false;
  restartPressed = false;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", () => this.keys.clear());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) e.preventDefault();
    if (k === "enter") this.startPressed = true;
    if (k === "r") this.restartPressed = true;
    this.keys.add(k);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  setTouch(btn: keyof InputState["touch"], down: boolean): void {
    this.touch[btn] = down;
  }

  private has(...ks: string[]): boolean {
    return ks.some((k) => this.keys.has(k));
  }

  carInput(): CarInput {
    const gas = this.has("arrowup", "w") || this.touch.gas;
    const brake = this.has("arrowdown", "s") || this.touch.brake;
    const left = this.has("arrowleft", "a") || this.touch.left;
    const right = this.has("arrowright", "d") || this.touch.right;
    return {
      throttle: (gas ? 1 : 0) - (brake ? 1 : 0),
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      drift: this.has(" ") || this.touch.drift,
      boost: this.has("shift") || (gas && this.touch.drift),
    };
  }

  // Consume one-shot edges so they fire once per press.
  consumeStart(): boolean {
    const v = this.startPressed;
    this.startPressed = false;
    return v;
  }
  consumeRestart(): boolean {
    const v = this.restartPressed;
    this.restartPressed = false;
    return v;
  }
}
