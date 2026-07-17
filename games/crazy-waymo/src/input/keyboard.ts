import { PhysicalGamepad } from "@vibedgames/gamepad";

import type { CarInput } from "../vehicle/car";

const THREE_clamp = (v: number): number => Math.max(-1, Math.min(1, v));

// Keyboard + touch-button + controller input, merged into a single CarInput
// each frame.
export class InputState {
  private keys = new Set<string>();
  private readonly pad = new PhysicalGamepad({ stickDeadZone: 0.12 });
  // `stickBrake` is the on-screen stick pulled DOWN — its own flag (written
  // every frame by touch.update) so it can never clobber a held BRAKE pedal.
  private touch = { gas: false, brake: false, boost: false, stickBrake: false };
  /** Analog steer from the on-screen stick, -1..1. Zero when no thumb is on it. */
  private touchSteer = 0;
  startPressed = false;
  restartPressed = false;
  mutePressed = false;
  typing = false; // chat input focused — game keys suspended
  // TRAILER (src/trailer/): scripted pedals/steer override every human source
  // while set. Null in normal play — zero gameplay impact.
  private scripted: CarInput | null = null;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    // Losing focus drops all held keys so the car doesn't drive itself.
    window.addEventListener("blur", () => this.keys.clear());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.typing) return; // the chat input owns the keyboard
    const k = e.key.toLowerCase();
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) e.preventDefault();
    if (k === "enter") this.startPressed = true;
    if (k === "r") this.restartPressed = true;
    if (k === "m") this.mutePressed = true;
    this.keys.add(k);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  setTouch(btn: keyof InputState["touch"], down: boolean): void {
    this.touch[btn] = down;
  }

  /** Called each frame from the on-screen stick; clamped, 0 when idle. */
  setTouchSteer(v: number): void {
    this.touchSteer = THREE_clamp(v);
  }

  private has(...ks: string[]): boolean {
    return ks.some((k) => this.keys.has(k));
  }

  /** TRAILER: carInput() returns this verbatim until cleared with null. */
  setScripted(input: CarInput | null): void {
    this.scripted = input;
  }

  carInput(): CarInput {
    if (this.scripted) return this.scripted;
    const gas = this.has("arrowup", "w") || this.touch.gas;
    // ONE brake pedal, racing-game style: ↓/S/Space (and the touch BRAKE
    // button) all pull it. Brake to slow, brake+steer to drift, brake from a
    // stop to reverse, gas+brake to power-drift.
    const brakeHeld = this.has("arrowdown", "s", " ") || this.touch.brake || this.touch.stickBrake;
    const left = this.has("arrowleft", "a");
    const right = this.has("arrowright", "d");
    let throttle = gas ? 1 : 0;
    let brake = brakeHeld ? 1 : 0;
    // Keys are digital; the on-screen stick is analog and wins when engaged.
    let steer = this.touchSteer !== 0 ? this.touchSteer : (right ? 1 : 0) - (left ? 1 : 0);
    let boost = this.has("shift") || this.touch.boost;
    // Gamepad (reference parity): left stick steers, RT gas, LT brake,
    // A/X also brake (handbrake habit), B or RB boost.
    this.pad.update();
    if (this.pad.connected) {
      const ax = this.pad.getStick().dx;
      if (Math.abs(ax) > 0.12) steer = THREE_clamp(ax);
      const rt = this.pad.buttonValue("rt");
      const lt = this.pad.buttonValue("lt");
      if (rt > 0.05 || this.pad.isButtonDown("up")) throttle = Math.max(throttle, rt || 1);
      if (lt > 0.05 || this.pad.isButtonDown("down")) brake = Math.max(brake, lt || 1);
      if (this.pad.isButtonDown("a") || this.pad.isButtonDown("x")) brake = 1;
      if (this.pad.isButtonDown("b") || this.pad.isButtonDown("rb")) boost = true;
    }
    return { throttle, brake, steer, boost };
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
  consumeMute(): boolean {
    const v = this.mutePressed;
    this.mutePressed = false;
    return v;
  }
  setTyping(on: boolean): void {
    this.typing = on;
    if (on) this.keys.clear();
  }
}
