// On-screen touch controls built on @vibedgames/gamepad's DOM adapter. A
// floating stick steers the slab in screen-relative directions (the scene
// applies camera-corner correction, same path as the keyboard) and a fixed
// bottom-right button cluster covers every keyboard verb — including the
// camera orbit, which is gameplay, not chrome. Touch is purely additive:
// the adapter ignores the mouse, so keyboard + pose keep working untouched.

import { attachDomGamepad, stickDirection4 } from "@vibedgames/gamepad/dom";
import type { Dir4, DomGamepad, Viewport } from "@vibedgames/gamepad/dom";

import type { ScreenDir } from "../game/camera-correction";
import { DROP_TAP_MS, TOUCH_ARR_MS, TOUCH_DAS_MS } from "../shared/constants";

/** Game verbs the touch layer drives (a thin mirror of KeyboardHandlers). */
export type TouchHandlers = {
  /** One screen-relative move step; `initial` = first step of a hold (sfx). */
  step(dir: ScreenDir, initial: boolean): void;
  rotate(): void;
  orbit(dir: -1 | 1): void;
  /** Space semantics: hard drop while playing, catch/start otherwise. */
  drop(): void;
  setSoftDrop(on: boolean): void;
  hold(): void;
  power(): void;
  /** A free touch (stick grab, not a button): start / catch / resume. */
  tap(): void;
};

/** Touch-first copy must be decided AT BOOT, not after the first touch. */
export function isCoarsePointer(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
}

/** Stick dir4 (screen-space, +y down) → the game's screen-relative steer. */
const SCREEN_DIR: Record<Dir4, ScreenDir> = {
  up: "away",
  down: "near",
  left: "left",
  right: "right",
};

/** Right-thumb cluster anchored to the bottom-right safe area. col 0 is the
 *  edge column (primary verbs), col 1 sits inboard; rows stack upward and
 *  compress on short (landscape phone) screens to clear the HUD pills. */
function cluster(v: Viewport, col: 0 | 1, row: 0 | 1 | 2): { x: number; y: number } {
  const gap = v.height < 500 ? 80 : 96;
  return {
    x: v.width - v.inset.right - (col === 0 ? 58 : 152),
    y: v.height - v.inset.bottom - 60 - row * gap,
  };
}

export class TouchControls {
  private readonly gamepad: DomGamepad;
  private readonly handlers: TouchHandlers;
  private dir: Dir4 | null = null;
  private das = 0;
  private arr = 0;
  private dropHeldMs = 0;

  /** Free-touch tap → start/catch/resume. Fired straight off pointerdown (not
   *  frame polling) so a tap shorter than one frame still lands; touches on
   *  HUD controls or inside a fixed button's circle don't count as free. */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") return;
    if (
      e.target instanceof Element &&
      e.target.closest("button, a, input, select, textarea, [data-gamepad-ignore]") !== null
    ) {
      return;
    }
    for (const b of this.gamepad.pad.getButtonLayout()) {
      if (!b.rest && Math.hypot(e.clientX - b.x, e.clientY - b.y) <= b.radius) return;
    }
    this.handlers.tap();
  };

  constructor(handlers: TouchHandlers) {
    this.handlers = handlers;
    this.gamepad = attachDomGamepad({
      visible: "coarse", // fixed buttons are discoverable before the first touch
      stick: { radius: 56, deadZone: 10 },
      buttons: [
        { id: "drop", label: "DROP", radius: 46, position: (v) => cluster(v, 0, 0) },
        { id: "rotate", label: "ROT", radius: 40, position: (v) => cluster(v, 0, 1) },
        { id: "hold", label: "HOLD", radius: 34, position: (v) => cluster(v, 1, 0) },
        { id: "power", label: "PWR", radius: 34, position: (v) => cluster(v, 1, 1) },
        { id: "orbit-right", label: "⟳", radius: 32, position: (v) => cluster(v, 0, 2) },
        { id: "orbit-left", label: "⟲", radius: 32, position: (v) => cluster(v, 1, 2) },
      ],
      render: { tint: "#8ea2ff" },
    });
    window.addEventListener("pointerdown", this.onPointerDown);
  }

  /** Call once per frame, before the sim tick, with the frame's dt in ms. */
  update(dtMs: number): void {
    this.gamepad.update(); // reconcile lost touches + publish edges + redraw

    this.repeatStick(dtMs);

    if (this.gamepad.justPressed("rotate")) this.handlers.rotate();
    if (this.gamepad.justPressed("orbit-left")) this.handlers.orbit(-1);
    if (this.gamepad.justPressed("orbit-right")) this.handlers.orbit(1);
    if (this.gamepad.justPressed("hold")) this.handlers.hold();
    if (this.gamepad.justPressed("power")) this.handlers.power();

    // DROP mirrors the keyboard pair: a quick tap = hard drop (Space); a held
    // press = soft drop (Shift) that never hard-drops on release.
    if (this.gamepad.justPressed("drop")) {
      this.dropHeldMs = 0;
      this.handlers.setSoftDrop(true);
    } else if (this.gamepad.isButtonDown("drop")) {
      this.dropHeldMs += dtMs;
    }
    if (this.gamepad.justReleased("drop")) {
      this.handlers.setSoftDrop(false);
      if (this.dropHeldMs < DROP_TAP_MS) this.handlers.drop();
    }
  }

  destroy(): void {
    window.removeEventListener("pointerdown", this.onPointerDown);
    this.gamepad.destroy();
  }

  /** Stick → repeated screen-relative steps: step on grab/direction change,
   *  then DAS/ARR while held (own timing, gentler than the keyboard's). */
  private repeatStick(dtMs: number): void {
    const dir = stickDirection4(this.gamepad.getStick());
    if (dir !== this.dir) {
      this.dir = dir;
      this.das = 0;
      this.arr = 0;
      if (dir) this.handlers.step(SCREEN_DIR[dir], true);
      return;
    }
    if (!dir) return;
    this.das += dtMs;
    if (this.das < TOUCH_DAS_MS) return;
    this.arr += dtMs;
    while (this.arr >= TOUCH_ARR_MS) {
      this.arr -= TOUCH_ARR_MS;
      this.handlers.step(SCREEN_DIR[dir], false);
    }
  }
}
