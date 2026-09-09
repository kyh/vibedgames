// Keyboard fallback — a full-featured mirror of every pose verb, always
// available. Held arrows/WASD report a screen-relative steer direction (the
// scene applies camera correction + DAS/ARR); discrete keys fire once
// (key-repeat suppressed). The webcam is the headline input; this is the
// always-present ground truth, never a wall.

export interface KeyboardHandlers {
  /** Held screen-horizontal steer: -1 left, 0, +1 right. */
  setHoriz: (dir: -1 | 0 | 1) => void;
  /** Held screen-depth steer: -1 away, 0, +1 near. */
  setDepth: (dir: -1 | 0 | 1) => void;
  rotate: () => void;
  hardDrop: () => void;
  setSoftDrop: (on: boolean) => void;
  orbit: (dir: -1 | 1) => void;
  hold: () => void;
  power: () => void;
  pause: () => void;
  start: () => void;
  recenter: () => void;
  muteToggle: () => void;
}

/** Discrete verbs: one fire per press, key-repeat suppressed by the caller. */
const ONE_SHOT = new Map<string, (h: KeyboardHandlers) => void>([
  [" ", (h) => h.hardDrop()],
  ["Enter", (h) => h.start()],
  ["c", (h) => h.hold()],
  ["e", (h) => h.orbit(1)],
  ["f", (h) => h.power()],
  ["m", (h) => h.muteToggle()],
  ["q", (h) => h.orbit(-1)],
  ["r", (h) => h.rotate()],
  ["v", (h) => h.recenter()],
]);

/** Space / Enter on a focused button (Play, rule cards, the camera toggle)
 *  activate that control; the game must not also read them as verbs. */
const activatesControl = (e: KeyboardEvent): boolean =>
  (e.key === " " || e.key === "Enter") &&
  e.target instanceof Element &&
  e.target.closest("button, input, select, textarea") !== null;

export class Keyboard {
  private readonly handlers: KeyboardHandlers;
  private left = false;
  private right = false;
  private away = false;
  private near = false;
  private softDrop = false;

  constructor(handlers: KeyboardHandlers) {
    this.handlers = handlers;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }

  /** Forget held keys: a pause swallows their keyup, so they would stay held. */
  releaseHeld(): void {
    this.onBlur();
  }

  private horiz(): -1 | 0 | 1 {
    if (this.left === this.right) {
      return 0;
    }
    return this.left ? -1 : 1;
  }
  private depth(): -1 | 0 | 1 {
    if (this.away === this.near) {
      return 0;
    }
    return this.away ? -1 : 1;
  }

  /** Held steer keys (arrows + WASD). Returns whether the key was one. */
  private axisKey(k: string, down: boolean): boolean {
    switch (k) {
      case "ArrowLeft":
      case "a":
      case "A": {
        this.left = down;
        this.handlers.setHoriz(this.horiz());
        return true;
      }
      case "ArrowRight":
      case "d":
      case "D": {
        this.right = down;
        this.handlers.setHoriz(this.horiz());
        return true;
      }
      case "ArrowUp":
      case "w":
      case "W": {
        this.away = down;
        this.handlers.setDepth(this.depth());
        return true;
      }
      case "ArrowDown":
      case "s":
      case "S": {
        this.near = down;
        this.handlers.setDepth(this.depth());
        return true;
      }
      default: {
        return false;
      }
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat || activatesControl(e)) {
      return;
    }
    const k = e.key;
    if (this.axisKey(k, true)) {
      return;
    }
    if (k === "Shift") {
      if (!this.softDrop) {
        this.softDrop = true;
        this.handlers.setSoftDrop(true);
      }
      return;
    }
    if (k === " ") {
      e.preventDefault();
    }
    if (e.repeat) {
      return;
    }
    ONE_SHOT.get(k.length === 1 ? k.toLowerCase() : k)?.(this.handlers);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key;
    if (this.axisKey(k, false)) {
      return;
    }
    if (k === "Shift") {
      this.softDrop = false;
      this.handlers.setSoftDrop(false);
    } else if (k === "p" || k === "P") {
      // On keyup, not keydown: pause routes into the wrapper pause overlay,
      // which resumes on any keyup — pausing on keydown would let this same
      // press's own keyup instantly resume. (A listener added mid-dispatch
      // never sees the current event, so THIS keyup can't resume.)
      this.handlers.pause();
    }
  };

  private onBlur = (): void => {
    this.left = false;
    this.right = false;
    this.away = false;
    this.near = false;
    this.softDrop = false;
    this.handlers.setHoriz(0);
    this.handlers.setDepth(0);
    this.handlers.setSoftDrop(false);
  };
}
