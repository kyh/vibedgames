import { PhysicalGamepad } from "@vibedgames/gamepad";

import type { CarInput } from "../vehicle/car";

const THREE_clamp = (v: number) => Math.max(-1, Math.min(1, v));

export class InputState {
  private keys = new Set<string>();
  private readonly pad = new PhysicalGamepad({ stickDeadZone: 0.12 });
  private touch = { boost: false, brake: false, gas: false, stickBrake: false };
  private touchSteer = 0;
  startPressed = false;
  restartPressed = false;
  mutePressed = false;
  typing = false;
  private scripted: CarInput | null = null;

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", () => this.keys.clear());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.typing) {
      return;
    }

    const k = e.key.toLowerCase();

    if ((k === "enter" || k === " ") && e.target instanceof Element && e.target.closest("button")) {
      return;
    }

    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
      e.preventDefault();
    }

    if (k === "enter") {
      this.startPressed = true;
    }

    if (k === "r") {
      this.restartPressed = true;
    }

    if (k === "m") {
      this.mutePressed = true;
    }

    this.keys.add(k);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key.toLowerCase());
  };

  setTouch(btn: keyof InputState["touch"], down: boolean) {
    this.touch[btn] = down;
  }

  /** Called each frame from the on-screen stick; clamped, 0 when idle. */
  setTouchSteer(v: number) {
    this.touchSteer = THREE_clamp(v);
  }

  private has(...ks: string[]) {
    return ks.some((k) => this.keys.has(k));
  }

  /** TRAILER: carInput() returns this verbatim until cleared with null. */
  setScripted(input: CarInput | null) {
    this.scripted = input;
  }

  carInput() {
    if (this.scripted) {
      return this.scripted;
    }

    const gas = this.has("arrowup", "w") || this.touch.gas;
    const brakeHeld = this.has("arrowdown", "s", " ") || this.touch.brake || this.touch.stickBrake;
    const left = this.has("arrowleft", "a");
    const right = this.has("arrowright", "d");
    const throttle = gas ? 1 : 0;
    const brake = brakeHeld ? 1 : 0;
    const steer = this.touchSteer === 0 ? (right ? 1 : 0) - (left ? 1 : 0) : this.touchSteer;
    const boost = this.has("shift") || this.touch.boost;

    return this.padInput({ boost, brake, steer, throttle });
  }

  private padInput(human: CarInput) {
    this.pad.update();

    if (!this.pad.connected) {
      return human;
    }

    let { boost, brake, steer, throttle } = human;
    const ax = this.pad.getStick().dx;

    if (Math.abs(ax) > 0.12) {
      steer = THREE_clamp(ax);
    }

    const rt = this.pad.buttonValue("rt");
    const lt = this.pad.buttonValue("lt");

    if (rt > 0.05 || this.pad.isButtonDown("up")) {
      throttle = Math.max(throttle, rt || 1);
    }

    if (lt > 0.05 || this.pad.isButtonDown("down")) {
      brake = Math.max(brake, lt || 1);
    }

    if (this.pad.isButtonDown("a") || this.pad.isButtonDown("x")) {
      brake = 1;
    }

    if (this.pad.isButtonDown("b") || this.pad.isButtonDown("rb")) {
      boost = true;
    }

    return { boost, brake, steer, throttle };
  }

  consumeStart() {
    const v = this.startPressed;
    this.startPressed = false;

    return v;
  }
  consumeRestart() {
    const v = this.restartPressed;
    this.restartPressed = false;

    return v;
  }
  consumeMute() {
    const v = this.mutePressed;
    this.mutePressed = false;

    return v;
  }
  setTyping(on: boolean) {
    this.typing = on;

    if (on) {
      this.keys.clear();
    }
  }
}
