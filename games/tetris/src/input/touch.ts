// On-screen touch controls built on @vibedgames/gamepad's DOM adapter. A
// floating stick steers the slab in screen-relative directions (the scene
// applies camera-corner correction, same path as the keyboard) and a fixed
// bottom-right button cluster covers every keyboard verb — including the
// camera orbit, which is gameplay, not chrome. Touch is purely additive:
// the adapter ignores the mouse, so keyboard + pose keep working untouched.
//
// Orbit is labelled ↺ ↻ (U+21BA/BB), not ⟲ ⟳ (U+27F2/F3): at the adapter's
// label size (radius × 0.42 ≈ 13px) the gapped-arrow pair measures 6px of ink
// against 10.9px, and reads as a dot.

import { attachDomGamepad, stickDirection4 } from "@vibedgames/gamepad/dom";
import type { Dir4, DomGamepad, Viewport } from "@vibedgames/gamepad/dom";

import type { ScreenDir } from "../game/camera-correction";
import { DROP_TAP_MS, TOUCH_ARR_MS, TOUCH_DAS_MS, TOUCH_TAP_SLOP_PX } from "../shared/constants";

/** Game verbs the touch layer drives (a thin mirror of KeyboardHandlers). */
export interface TouchHandlers {
  /** One screen-relative move step; `initial` = first step of a hold (sfx). */
  step: (dir: ScreenDir, initial: boolean) => void;
  rotate: () => void;
  orbit: (dir: -1 | 1) => void;
  /** Space semantics: hard drop while playing, catch/start otherwise. */
  drop: () => void;
  setSoftDrop: (on: boolean) => void;
  hold: () => void;
  power: () => void;
  /** A free touch (stick grab, not a button): start / catch / resume. */
  tap: () => void;
}

/** Touch-first copy must be decided AT BOOT, not after the first touch. */
export const isCoarsePointer = (): boolean =>
  window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;

/** Stick dir4 (screen-space, +y down) → the game's screen-relative steer. */
const SCREEN_DIR = {
  down: "near",
  left: "left",
  right: "right",
  up: "away",
} satisfies Record<Dir4, ScreenDir>;

/** Slot → grid cell, counted from the bottom-right safe-area corner: column 0
 *  is the screen edge (primary verbs), rows stack upward. Six buttons are two
 *  columns of three on a tall screen; a landscape phone folds them into three
 *  columns of two, because a third row runs up into the webcam thumbnail
 *  pinned above the cluster (and forces the rows closer than their radii). */
type Slot = 0 | 1 | 2 | 3 | 4 | 5;

const TALL_GRID = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
  [0, 2],
  [1, 2],
] as const;
const SHORT_GRID = [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 1],
  [2, 0],
  [2, 1],
] as const;

const cluster = (v: Viewport, slot: Slot) => {
  const [col, row] = (v.height < 500 ? SHORT_GRID : TALL_GRID)[slot];
  return {
    x: v.width - v.inset.right - 58 - col * 94,
    y: v.height - v.inset.bottom - 60 - row * 96,
  };
};

/** HUD controls (and anything opted out with `data-gamepad-ignore`, e.g. the
 *  webcam panel and the pause/mute cluster) own their own touches. */
const ownsTouch = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest("button, a, input, select, textarea, [data-gamepad-ignore]") !== null;

export class TouchControls {
  private readonly gamepad: DomGamepad;
  private readonly root: HTMLDivElement;
  private readonly handlers: TouchHandlers;
  private dir: Dir4 | null = null;
  private das = 0;
  private arr = 0;
  private dropHeldMs = 0;
  private active = false;
  /** Idle free touch awaiting its lift: title / results start on a completed tap. */
  private pendingTap: { id: number; x: number; y: number } | null = null;

  /** Free touch → catch (in play) or start (idle). The catch fires straight
   *  off pointerdown (not frame polling) so a tap shorter than one frame still
   *  lands; a touch inside a fixed button's circle isn't free. Idle waits for
   *  the lift instead: the banner scrolls on small screens, and a pan that
   *  starts on its text must not launch a run (the browser cancels the pointer
   *  once it takes the scroll). */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== "touch" || ownsTouch(e.target)) {
      return;
    }
    if (!this.active) {
      this.pendingTap = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    for (const b of this.gamepad.pad.getButtonLayout()) {
      if (!b.rest && Math.hypot(e.clientX - b.x, e.clientY - b.y) <= b.radius) {
        return;
      }
    }
    this.handlers.tap();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const tap = this.pendingTap;
    if (!tap || tap.id !== e.pointerId) {
      return;
    }
    this.pendingTap = null;
    if (!this.active && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= TOUCH_TAP_SLOP_PX) {
      this.handlers.tap();
    }
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.pendingTap?.id === e.pointerId) {
      this.pendingTap = null;
    }
  };

  constructor(handlers: TouchHandlers) {
    this.handlers = handlers;
    this.root = document.createElement("div");
    this.root.className = "tetris-gamepad";
    this.root.hidden = true;
    document.body.append(this.root);
    this.gamepad = attachDomGamepad({
      buttons: [
        { id: "drop", label: "DROP", position: (v) => cluster(v, 0), radius: 46 },
        { id: "rotate", label: "ROT", position: (v) => cluster(v, 1), radius: 40 },
        { id: "hold", label: "HOLD", position: (v) => cluster(v, 2), radius: 34 },
        { id: "power", label: "PWR", position: (v) => cluster(v, 3), radius: 34 },
        { id: "orbit-right", label: "↻", position: (v) => cluster(v, 4), radius: 32 },
        { id: "orbit-left", label: "↺", position: (v) => cluster(v, 5), radius: 32 },
      ],
      render: { tint: "#8ea2ff" },
      root: this.root,
      stick: { deadZone: 10, radius: 56 },
      // Fixed buttons are discoverable before the first touch.
      visible: "coarse",
    });
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);
  }

  /** Call once per frame, before the sim tick, with the frame's dt in ms. */
  update(dtMs: number): void {
    if (!this.active) {
      this.gamepad.pad.reset();
      this.gamepad.update();
      return;
    }
    // Reconcile lost touches + publish edges + redraw.
    this.gamepad.update();

    this.repeatStick(dtMs);

    if (this.gamepad.justPressed("rotate")) {
      this.handlers.rotate();
    }
    if (this.gamepad.justPressed("orbit-left")) {
      this.handlers.orbit(-1);
    }
    if (this.gamepad.justPressed("orbit-right")) {
      this.handlers.orbit(1);
    }
    if (this.gamepad.justPressed("hold")) {
      this.handlers.hold();
    }
    if (this.gamepad.justPressed("power")) {
      this.handlers.power();
    }

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
      if (this.dropHeldMs < DROP_TAP_MS) {
        this.handlers.drop();
      }
    }
  }

  destroy(): void {
    window.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    this.gamepad.destroy();
    this.root.remove();
  }

  /** The button cluster exists only in play; title and results own their taps. */
  setActive(active: boolean): void {
    if (this.active === active) {
      return;
    }
    this.active = active;
    this.root.hidden = !active;
    this.release();
  }

  /** Forget every pointer and pending press edge (pause, resume, phase change). */
  release(): void {
    this.pendingTap = null;
    this.gamepad.pad.reset();
    // Twice: the first update publishes the reset as release edges, the second clears them.
    this.gamepad.update();
    this.gamepad.update();
    this.dir = null;
    this.das = 0;
    this.arr = 0;
    this.dropHeldMs = 0;
    this.handlers.setSoftDrop(false);
  }

  /** Stick → repeated screen-relative steps: step on grab/direction change,
   *  then DAS/ARR while held (own timing, gentler than the keyboard's). */
  private repeatStick(dtMs: number): void {
    const dir = stickDirection4(this.gamepad.getStick());
    if (dir !== this.dir) {
      this.dir = dir;
      this.das = 0;
      this.arr = 0;
      if (dir) {
        this.handlers.step(SCREEN_DIR[dir], true);
      }
      return;
    }
    if (!dir) {
      return;
    }
    this.das += dtMs;
    if (this.das < TOUCH_DAS_MS) {
      return;
    }
    this.arr += dtMs;
    while (this.arr >= TOUCH_ARR_MS) {
      this.arr -= TOUCH_ARR_MS;
      this.handlers.step(SCREEN_DIR[dir], false);
    }
  }
}
