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

const ONE_SHOT = new Map<string, (h: KeyboardHandlers) => void>([
  [
    " ",
    (h) => {
      h.hardDrop();
    },
  ],
  [
    "Enter",
    (h) => {
      h.start();
    },
  ],
  [
    "c",
    (h) => {
      h.hold();
    },
  ],
  [
    "e",
    (h) => {
      h.orbit(1);
    },
  ],
  [
    "f",
    (h) => {
      h.power();
    },
  ],
  [
    "m",
    (h) => {
      h.muteToggle();
    },
  ],
  [
    "q",
    (h) => {
      h.orbit(-1);
    },
  ],
  [
    "r",
    (h) => {
      h.rotate();
    },
  ],
  [
    "v",
    (h) => {
      h.recenter();
    },
  ],
]);

const activatesControl = (e: KeyboardEvent) =>
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

  destroy() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }

  /** Forget held keys: a pause swallows their keyup, so they would stay held. */
  releaseHeld() {
    this.onBlur();
  }

  private horiz() {
    if (this.left === this.right) {
      return 0;
    }

    return this.left ? -1 : 1;
  }
  private depth() {
    if (this.away === this.near) {
      return 0;
    }

    return this.away ? -1 : 1;
  }

  private axisKey(k: string, down: boolean) {
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

  private readonly onKeyDown = (e: KeyboardEvent) => {
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

  private readonly onKeyUp = (e: KeyboardEvent) => {
    const k = e.key;

    if (this.axisKey(k, false)) {
      return;
    }

    if (k === "Shift") {
      this.softDrop = false;
      this.handlers.setSoftDrop(false);
    } else if (k === "p" || k === "P") {
      this.handlers.pause();
    }
  };

  private readonly onBlur = () => {
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
