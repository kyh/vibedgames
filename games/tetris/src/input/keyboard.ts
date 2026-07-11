// Keyboard fallback — a full-featured mirror of every pose verb, always
// available. Held arrows/WASD report a screen-relative steer direction (the
// scene applies camera correction + DAS/ARR); discrete keys fire once
// (key-repeat suppressed). The webcam is the headline input; this is the
// always-present ground truth, never a wall.

export type KeyboardHandlers = {
  /** Held screen-horizontal steer: -1 left, 0, +1 right. */
  setHoriz(dir: -1 | 0 | 1): void;
  /** Held screen-depth steer: -1 away, 0, +1 near. */
  setDepth(dir: -1 | 0 | 1): void;
  rotate(): void;
  hardDrop(): void;
  setSoftDrop(on: boolean): void;
  orbit(dir: -1 | 1): void;
  hold(): void;
  power(): void;
  pause(): void;
  start(): void;
  recenter(): void;
  muteToggle(): void;
};

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

  private horiz(): -1 | 0 | 1 {
    return this.left === this.right ? 0 : this.left ? -1 : 1;
  }
  private depth(): -1 | 0 | 1 {
    return this.away === this.near ? 0 : this.away ? -1 : 1;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") {
      this.left = true;
      this.handlers.setHoriz(this.horiz());
    } else if (k === "ArrowRight" || k === "d" || k === "D") {
      this.right = true;
      this.handlers.setHoriz(this.horiz());
    } else if (k === "ArrowUp" || k === "w" || k === "W") {
      this.away = true;
      this.handlers.setDepth(this.depth());
    } else if (k === "ArrowDown" || k === "s" || k === "S") {
      this.near = true;
      this.handlers.setDepth(this.depth());
    } else if (k === "Shift") {
      if (!this.softDrop) {
        this.softDrop = true;
        this.handlers.setSoftDrop(true);
      }
    } else if (k === " ") {
      e.preventDefault();
      if (!e.repeat) this.handlers.hardDrop();
    } else if (k === "r" || k === "R") {
      if (!e.repeat) this.handlers.rotate();
    } else if (k === "q" || k === "Q") {
      if (!e.repeat) this.handlers.orbit(-1);
    } else if (k === "e" || k === "E") {
      if (!e.repeat) this.handlers.orbit(1);
    } else if (k === "c" || k === "C") {
      if (!e.repeat) this.handlers.hold();
    } else if (k === "f" || k === "F") {
      if (!e.repeat) this.handlers.power();
    } else if (k === "Enter") {
      if (!e.repeat) this.handlers.start();
    } else if (k === "v" || k === "V") {
      if (!e.repeat) this.handlers.recenter();
    } else if (k === "m" || k === "M") {
      if (!e.repeat) this.handlers.muteToggle();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") {
      this.left = false;
      this.handlers.setHoriz(this.horiz());
    } else if (k === "ArrowRight" || k === "d" || k === "D") {
      this.right = false;
      this.handlers.setHoriz(this.horiz());
    } else if (k === "ArrowUp" || k === "w" || k === "W") {
      this.away = false;
      this.handlers.setDepth(this.depth());
    } else if (k === "ArrowDown" || k === "s" || k === "S") {
      this.near = false;
      this.handlers.setDepth(this.depth());
    } else if (k === "Shift") {
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
    this.left = this.right = this.away = this.near = false;
    this.softDrop = false;
    this.handlers.setHoriz(0);
    this.handlers.setDepth(0);
    this.handlers.setSoftDrop(false);
  };
}
