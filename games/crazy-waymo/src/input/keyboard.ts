import type { CarInput } from "../vehicle/car";

const THREE_clamp = (v: number): number => Math.max(-1, Math.min(1, v));

// Keyboard + touch-button input, merged into a single CarInput each frame.
export class InputState {
  private keys = new Set<string>();
  private touch = { gas: false, brake: false, left: false, right: false, drift: false };
  startPressed = false;
  restartPressed = false;
  pausePressed = false;
  mutePressed = false;
  blurred = false; // window lost focus (auto-pause)
  typing = false; // chat input focused — game keys suspended

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.blurred = true;
    });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.typing) return; // the chat input owns the keyboard
    const k = e.key.toLowerCase();
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) e.preventDefault();
    if (k === "enter") this.startPressed = true;
    if (k === "r") this.restartPressed = true;
    if (k === "p" || k === "escape") this.pausePressed = true;
    if (k === "m") this.mutePressed = true;
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
    let throttle = (gas ? 1 : 0) - (brake ? 1 : 0);
    let steer = (right ? 1 : 0) - (left ? 1 : 0);
    let drift = this.has(" ") || this.touch.drift;
    let boost = this.has("shift") || (gas && this.touch.drift);
    // Gamepad (reference parity): left stick steers, RT gas, LT brake,
    // A jump/handbrake, B or RB boost.
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.12) steer = THREE_clamp(ax);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      const dpadUp = pad.buttons[12]?.pressed ?? false;
      const dpadDown = pad.buttons[13]?.pressed ?? false;
      if (rt > 0.05 || dpadUp) throttle = Math.max(throttle, rt || 1);
      if (lt > 0.05 || dpadDown) throttle = Math.min(throttle, -(lt || 1));
      if ((pad.buttons[0]?.pressed ?? false) || (pad.buttons[2]?.pressed ?? false)) drift = true; // A/X = handbrake
      if ((pad.buttons[1]?.pressed ?? false) || (pad.buttons[5]?.pressed ?? false)) boost = true;
      break; // first connected pad wins
    }
    return { throttle, steer, drift, boost };
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
  consumePause(): boolean {
    const v = this.pausePressed;
    this.pausePressed = false;
    return v;
  }
  consumeMute(): boolean {
    const v = this.mutePressed;
    this.mutePressed = false;
    return v;
  }
  setTyping(on: boolean): void {
    this.typing = on;
    if (on) this.keys.clear();
  }
  consumeBlur(): boolean {
    const v = this.blurred;
    this.blurred = false;
    return v;
  }
}
