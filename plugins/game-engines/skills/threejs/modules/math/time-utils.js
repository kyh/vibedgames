export class Clock {
  constructor({ manual = false, nowMs = 0 } = {}) {
    this.manual = manual;
    this.currentMs = nowMs;
  }

  now() {
    return this.manual ? this.currentMs : Date.now();
  }

  nowSeconds() {
    return this.now() * 0.001;
  }

  useSystem() {
    this.manual = false;
    return this;
  }

  useManual(nowMs = this.currentMs) {
    this.manual = true;
    this.currentMs = nowMs;
    return this;
  }

  setMs(nowMs) {
    this.currentMs = nowMs;
    return this;
  }

  advanceMs(deltaMs) {
    this.currentMs += deltaMs;
    return this;
  }
}

export const DEFAULT_CLOCK = new Clock();
