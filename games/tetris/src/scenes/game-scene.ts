// The orchestrator: owns the Three.js scene, the camera rig, the well + cube
// renderers, the fx, the engine, and the input router that merges keyboard +
// pose into camera-relative moves (DAS/ARR, pose-freshness ownership). main.ts
// just boots it and renders scene + camera each frame.

import {
  controlGroups,
  createTouchControls,
  notifyGameStarted,
  pauseGame,
  watchControlContext,
} from "@repo/embed";
import type { TouchControls as EmbedTouchControls } from "@repo/embed";
import { PhysicalGamepad, stickDirection4 } from "@vibedgames/gamepad";
import { Color, Scene } from "three";

import { CONTROLS, titleSubText } from "../controls";
import { groupRow } from "../pause-overlay";
import type { Cell } from "../game/board";
import { screenToWorld } from "../game/camera-correction";
import type { ScreenDir } from "../game/camera-correction";
import { Engine } from "../game/engine";
import type { LockEvent } from "../game/engine";
import { ParticlePool } from "../fx/particles";
import { isMuted, setMuted, sfx, toggleMute } from "../fx/sfx";
import { Keyboard } from "../input/keyboard";
import type { KeyboardHandlers } from "../input/keyboard";
import type { PoseActions, PoseControls } from "../input/pose-control";
import { isCoarsePointer, TouchControls } from "../input/touch";
import type { TouchHandlers } from "../input/touch";
import { Collapse } from "../physics/collapse";
import { CameraRig } from "../render/camera-rig";
import { CubeField } from "../render/cube-field";
import { drawPiecePreview } from "../render/piece-preview";
import { Well } from "../render/well";
import {
  ARR_MS,
  BG,
  CATCH_WINDOW_MS,
  CLEAR_BURST_COUNT,
  DAS_MS,
  LOCK_DUST_COUNT,
  PIECES,
  POSE_TIMEOUT_MS,
  TRAUMA_CLEAR,
  TRAUMA_GAME_OVER,
  TRAUMA_HARD_DROP,
  TRAUMA_LOCK,
  WELL_CENTER_X,
  WELL_CENTER_Z,
} from "../shared/constants";

interface Repeat {
  dir: -1 | 0 | 1;
  das: number;
  arr: number;
}

/** Themes the shared pause/mute cluster into the HUD's glass pills, and stacks
 *  it so it occupies one 44px column — the top-right strip the HUD reserves. */
const TOUCH_CONTROLS_CSS = `
.tetris-touch-controls {
  flex-direction: column;
  --vg-touch-fg: #d7dcf0;
  --vg-touch-bg: rgba(20, 22, 36, 0.66);
  --vg-touch-bg-active: rgba(142, 162, 255, 0.28);
  --vg-touch-border: 1px solid rgba(120, 134, 200, 0.28);
  --vg-touch-radius: 10px;
}
`;

const el = (id: string): HTMLElement | null => document.querySelector(`#${id}`);

interface Steer {
  horiz: -1 | 0 | 1;
  depth: -1 | 0 | 1;
}

const centroid = (cells: Cell[]) => {
  if (cells.length === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  let x = 0;
  let y = 0;
  let z = 0;
  for (const c of cells) {
    x += c.x;
    y += c.y;
    z += c.z;
  }
  return { x: x / cells.length, y: y / cells.length, z: z / cells.length };
};
export class GameScene {
  readonly scene = new Scene();
  private readonly rig: CameraRig;
  private readonly well: Well;
  private readonly cubes: CubeField;
  private readonly particles: ParticlePool;
  private readonly collapse = new Collapse();
  private readonly engine = new Engine();
  private readonly keyboard: Keyboard;
  private readonly touch: TouchControls;
  private readonly touchControls: EmbedTouchControls;
  private readonly pad = new PhysicalGamepad();
  private readonly coarse = isCoarsePointer();
  private poseControls: PoseControls | null = null;
  private unwatchControls: (() => void) | null = null;

  // input state (screen-relative)
  private kbHoriz: -1 | 0 | 1 = 0;
  private kbDepth: -1 | 0 | 1 = 0;
  private poseHoriz: -1 | 0 | 1 = 0;
  private poseHorizAt = -1e9;
  private padSoftDrop = false;
  private lastPadAt = -1e9;
  private readonly hMove: Repeat = { arr: 0, das: 0, dir: 0 };
  private readonly dMove: Repeat = { arr: 0, das: 0, dir: 0 };

  private needSnap = false;
  /** Locked-board changed since the last sync (lock / power sweep / catch / reset). */
  private boardDirty = true;
  private collapseStartedAt = 0;
  private lastPoseAt = -1e9;

  // HUD cache (avoid touching the DOM unless a value changed)
  private hudScore = -1;
  private hudLines = -1;
  private hudOwner = "";
  private hudNextIdx = -2;
  private hudHoldIdx: number | null = -2;
  private hudCharge = -1;

  constructor(aspect: number) {
    this.scene.background = new Color(BG);
    this.rig = new CameraRig(aspect);
    this.well = new Well(this.scene);
    this.cubes = new CubeField(this.scene);
    this.particles = new ParticlePool(this.scene);
    this.keyboard = new Keyboard(this.keyboardHandlers());
    this.touch = new TouchControls(this.touchHandlers());
    // M and P are keyboard-only: without this a phone plays permanently silent
    // and cannot pause. No-ops on a fine pointer.
    this.touchControls = createTouchControls({
      className: "tetris-touch-controls",
      css: TOUCH_CONTROLS_CSS,
      mute: { get: isMuted, set: setMuted },
      styleId: "tetris-touch-controls-css",
    });
    document.body.classList.toggle("touch", this.coarse);
    GameScene.renderLegend();
    this.showBanner("TETRIS", titleSubText());
    // Plugging in a pad on the title adds its legend row + start hint.
    this.unwatchControls = watchControlContext(() => {
      if (this.engine.state.status !== "title") {
        return;
      }
      GameScene.renderLegend();
      this.showBanner("TETRIS", titleSubText());
    });
  }

  /** Rebuild the banner legend from the controls manifest, one row per
   *  visible input method (boot-time, not on first touch — the copy must be
   *  right before the player ever taps). Rows are the pause overlay's own
   *  method-label + keycap-chip rows, so title and pause teach with one UI. */
  private static renderLegend(): void {
    const legend = el("legend");
    if (!legend) {
      return;
    }
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    legend.replaceChildren(...controlGroups(CONTROLS).map((group) => groupRow(group, coarse)));
  }

  get camera() {
    return this.rig.camera;
  }

  attachPoseControls(controls: PoseControls): void {
    this.poseControls = controls;
  }

  resize(aspect: number): void {
    this.rig.resize(aspect);
  }

  /** Wrapper pause ended: shift the collapse catch-window deadline so the
   *  paused gap doesn't count against it. Pose-freshness stamps deliberately
   *  stay unshifted — stale pose input reading as old is the safe direction. */
  shiftWallClock(pausedMs: number): void {
    this.collapseStartedAt += pausedMs;
  }

  // ---- input wiring -----------------------------------------------------------

  /** Bound intent handlers handed to PoseControls (main.ts wires the camera). */
  readonly poseActions: PoseActions = {
    catchCollapse: () => {
      // Throw-hands-up: catches the collapse mid-tumble, and starts the game
      // from the title / game-over screen — so play begins hands-free too.
      const { status } = this.engine.state;
      if (status === "collapsing") {
        this.tryCatch();
      } else if (status === "title" || status === "gameOver") {
        this.startGame();
      }
    },
    hold: () => {
      this.lastPoseAt = performance.now();
      this.doHold();
    },
    orbit: (dir) => {
      this.lastPoseAt = performance.now();
      this.doOrbit(dir);
    },
    power: () => {
      this.lastPoseAt = performance.now();
      this.doPower();
    },
    rotate: () => this.doRotate(),
    steer: (dir) => {
      this.poseHoriz = dir;
      this.poseHorizAt = performance.now();
      this.lastPoseAt = this.poseHorizAt;
    },
  };

  private keyboardHandlers(): KeyboardHandlers {
    return {
      hardDrop: () => this.onHardDrop(),
      hold: () => this.doHold(),
      muteToggle: () => {
        toggleMute();
        this.touchControls.sync();
      },
      orbit: (dir) => this.doOrbit(dir),
      pause: () => this.requestPause(),
      power: () => this.doPower(),
      recenter: () => this.poseControls?.recenter(),
      rotate: () => {
        this.doRotate();
      },
      setDepth: (dir) => {
        this.kbDepth = dir;
      },
      setHoriz: (dir) => {
        this.kbHoriz = dir;
      },
      setSoftDrop: (on) => this.engine.setSoftDrop(on),
      start: () => this.startIfIdle(),
    };
  }

  private touchHandlers(): TouchHandlers {
    return {
      drop: () => this.onHardDrop(),
      hold: () => this.doHold(),
      orbit: (dir) => this.doOrbit(dir),
      power: () => this.doPower(),
      rotate: () => {
        this.doRotate();
      },
      setSoftDrop: (on) => this.engine.setSoftDrop(on),
      step: (dir, initial) => this.stepScreen(dir, initial),
      tap: () => this.onFreeTap(),
    };
  }

  /** A free touch (not on a button): the touch mirror of hands-up / Enter.
   *  While paused the wrapper overlay covers the screen and owns the tap. */
  private onFreeTap(): void {
    const s = this.engine.state.status;
    if (s === "title" || s === "gameOver") {
      this.startGame();
    } else if (s === "collapsing") {
      this.tryCatch();
    }
  }

  // ---- verbs ------------------------------------------------------------------

  private doRotate(): boolean {
    if (this.engine.state.status !== "playing") {
      return false;
    }
    const ok = this.engine.rotate();
    if (ok) {
      sfx.rotate();
    }
    return ok;
  }

  private doOrbit(dir: -1 | 1): void {
    if (this.engine.state.status !== "playing") {
      return;
    }
    const corner = this.rig.orbit(dir, performance.now());
    this.well.setCorner(corner);
    sfx.orbit();
  }

  private doHold(): void {
    if (this.engine.hold()) {
      this.needSnap = true;
      sfx.rotate();
    }
  }

  private doPower(): void {
    if (!this.engine.canPower()) {
      return;
    }
    const removed = this.engine.power();
    if (removed <= 0) {
      return;
    }
    this.boardDirty = true;
    sfx.clear(removed);
    this.rig.addTrauma(TRAUMA_CLEAR);
    this.particles.burst({
      color: 0xff_ff_ff,
      count: CLEAR_BURST_COUNT,
      gravity: 3,
      life: 0.7,
      size: 0.18,
      speedMax: 9,
      speedMin: 4,
      x: WELL_CENTER_X,
      y: 0.2,
      yKick: 4,
      z: WELL_CENTER_Z,
    });
  }

  private onHardDrop(): void {
    const { status } = this.engine.state;
    if (status === "playing") {
      const ev = this.engine.hardDrop();
      sfx.hardDrop();
      this.rig.addTrauma(TRAUMA_HARD_DROP);
      if (ev) {
        this.handleLock(ev);
      }
    } else if (status === "collapsing") {
      this.tryCatch();
    } else if (status === "title" || status === "gameOver") {
      this.startGame();
    }
  }

  /** P / pad START: route into the wrapper pause (@repo/embed) — the bespoke
   *  overlay is the game's ONLY pause surface, and main.ts's onPause/onResume
   *  handlers own the freeze (update-skip + shiftWallClock). While paused the
   *  overlay's own resume paths (pointerup / keyup / fresh pad press) apply. */
  private requestPause(): void {
    if (this.engine.state.status !== "playing") {
      return;
    }
    pauseGame();
  }

  private startIfIdle(): void {
    const s = this.engine.state.status;
    if (s === "title" || s === "gameOver") {
      this.startGame();
    }
  }

  private startGame(): void {
    this.unwatchControls?.();
    this.unwatchControls = null;
    notifyGameStarted();
    this.collapse.dispose();
    this.cubes.frozen = false;
    this.cubes.clearLocked();
    this.well.setCorner(0);
    this.rig.resetTrauma();
    this.engine.startGame();
    this.boardDirty = true;
    this.needSnap = true;
    this.hMove.dir = 0;
    this.dMove.dir = 0;
    this.hideBanner();
  }

  // ---- lock / clear / collapse ------------------------------------------------

  private handleLock(ev: LockEvent): void {
    this.boardDirty = true;
    const colorHex = PIECES[ev.colorIndex - 1]?.color ?? 0xff_ff_ff;
    const c = centroid(ev.lockedCells);
    sfx.lock();
    this.rig.addTrauma(TRAUMA_LOCK);
    this.particles.burst({
      color: colorHex,
      count: LOCK_DUST_COUNT,
      gravity: 6,
      life: 0.4,
      size: 0.12,
      speedMax: 3,
      speedMin: 1,
      x: c.x,
      y: c.y,
      yKick: 1,
      z: c.z,
    });

    if (ev.clear.lines > 0) {
      sfx.clear(ev.clear.lines);
      this.rig.addTrauma(TRAUMA_CLEAR);
      this.particles.burst({
        color: 0xff_ff_ff,
        count: CLEAR_BURST_COUNT,
        gravity: 4,
        life: 0.6,
        size: 0.16,
        speedMax: 8,
        speedMin: 3,
        x: c.x,
        y: ev.layer,
        yKick: 3,
        z: c.z,
      });
    }

    if (ev.gameOver) {
      this.enterCollapse();
    } else {
      this.needSnap = true;
    }
  }

  private enterCollapse(): void {
    this.cubes.frozen = true;
    this.collapse.attach(this.cubes.lockedMeshes());
    this.well.setAllWallsVisible(false);
    this.rig.addTrauma(TRAUMA_GAME_OVER);
    this.collapseStartedAt = performance.now();
    this.showBanner(
      "CATCH IT!",
      this.coarse
        ? "throw your hands UP (or tap) to save the stack"
        : "throw your hands UP (or Space) to save the stack",
      false,
    );
  }

  private tryCatch(): void {
    if (this.engine.state.status !== "collapsing") {
      return;
    }
    this.collapse.dispose();
    this.cubes.frozen = false;
    this.cubes.clearLocked();
    this.well.setCorner(this.rig.corner);
    const stillDead = this.engine.resumeAfterCatch();
    this.rig.resetTrauma();
    this.boardDirty = true;
    this.needSnap = true;
    if (stillDead) {
      this.finalizeGameOver();
    } else {
      sfx.catchCollapse();
      this.hideBanner();
    }
  }

  private finalizeGameOver(): void {
    this.engine.state.status = "gameOver";
    this.well.setAllWallsVisible(true);
    sfx.gameOver();
    this.showBanner(
      "GAME OVER",
      `score ${this.engine.state.score} · ${this.coarse ? "tap" : "Enter"} to retry`,
    );
  }

  // ---- main update ------------------------------------------------------------

  update(dt: number): void {
    const now = performance.now();
    const dtMs = dt * 1000;
    // poll the gamepad before the sim tick
    this.touch.update(dtMs);
    this.updatePad(now);
    const { status } = this.engine.state;

    if (status === "playing") {
      this.routeSteering(dtMs);
      // gravity pauses during the swing
      const paused = this.rig.isInMotion(now);
      const ev = this.engine.tick(dtMs, paused);
      if (ev) {
        this.handleLock(ev);
      }
    } else if (status === "collapsing") {
      this.collapse.step(dt);
      if (now - this.collapseStartedAt > CATCH_WINDOW_MS) {
        this.finalizeGameOver();
      }
    }

    // sync renderers from the logical state (locked layer only when it changed;
    // syncLocked itself still no-ops while frozen, so keep the flag until thawed)
    if (this.boardDirty && !this.cubes.frozen) {
      this.cubes.syncLocked(this.engine.board);
      this.boardDirty = false;
    }
    const active = this.engine.activeCells();
    this.cubes.setActive(active, this.engine.activePieceIndex(), this.needSnap);
    this.cubes.setGhost(this.engine.ghostCells());
    this.needSnap = false;

    this.cubes.update(dt);
    this.particles.update(dt);
    this.rig.update(dt, now);
    this.updateHud(now);
  }

  private routeSteering(dtMs: number): void {
    const poseFresh = performance.now() - this.poseHorizAt < POSE_TIMEOUT_MS;
    const { horiz: padHoriz, depth: padDepth } = this.padSteer();
    let horiz: -1 | 0 | 1 = this.kbHoriz;
    if (this.kbHoriz === 0) {
      horiz = padHoriz;
      if (padHoriz === 0) {
        horiz = poseFresh ? this.poseHoriz : 0;
      }
    }
    const depth: -1 | 0 | 1 = this.kbDepth === 0 ? padDepth : this.kbDepth;
    this.repeat(this.hMove, horiz, dtMs, false);
    this.repeat(this.dMove, depth, dtMs, true);
  }

  /** Held pad steer (d-pad first, then left stick) on the same screen-relative
   *  axes as the keyboard, so it feeds the shared DAS/ARR repeat state. */
  private padSteer(): Steer {
    if (!this.pad.connected) {
      return { depth: 0, horiz: 0 };
    }
    let horiz: -1 | 0 | 1 = 0;
    if (this.pad.isButtonDown("left")) {
      horiz = -1;
    } else if (this.pad.isButtonDown("right")) {
      horiz = 1;
    }
    let depth: -1 | 0 | 1 = 0;
    if (this.pad.isButtonDown("up")) {
      depth = -1;
    } else if (this.pad.isButtonDown("down")) {
      depth = 1;
    }
    if (horiz === 0 && depth === 0) {
      const dir = stickDirection4(this.pad.getStick());
      if (dir === "left") {
        horiz = -1;
      } else if (dir === "right") {
        horiz = 1;
      } else if (dir === "up") {
        depth = -1;
      } else if (dir === "down") {
        depth = 1;
      }
    }
    if (horiz !== 0 || depth !== 0) {
      this.lastPadAt = performance.now();
    }
    return { depth, horiz };
  }

  /** Physical controller: poll once per frame and drive the same verbs as the
   *  keyboard (steering merges into routeSteering's DAS/ARR while playing). */
  private updatePad(now: number): void {
    this.pad.update();
    if (!this.pad.connected) {
      return;
    }
    const { status } = this.engine.state;
    if (status === "title" || status === "gameOver") {
      // Any face button starts, mirroring Enter / the free tap.
      if (["a", "b", "x", "y"].some((b) => this.pad.justPressed(b))) {
        this.lastPadAt = now;
        this.startGame();
      }
      return;
    }
    let acted = false;
    if (this.pad.justPressed("start")) {
      this.requestPause();
      acted = true;
    }
    if (this.pad.justPressed("a")) {
      this.doRotate();
      acted = true;
    }
    if (this.pad.justPressed("b")) {
      // Space semantics: hard drop, or catch while collapsing
      this.onHardDrop();
      acted = true;
    }
    if (this.pad.justPressed("x")) {
      this.doHold();
      acted = true;
    }
    if (this.pad.justPressed("y")) {
      this.doPower();
      acted = true;
    }
    if (this.pad.justPressed("lb")) {
      this.doOrbit(-1);
      acted = true;
    }
    if (this.pad.justPressed("rb")) {
      this.doOrbit(1);
      acted = true;
    }
    const soft = this.pad.isButtonDown("lt") || this.pad.isButtonDown("rt");
    if (soft !== this.padSoftDrop) {
      this.padSoftDrop = soft;
      this.engine.setSoftDrop(soft);
      acted = true;
    }
    if (acted) {
      this.lastPadAt = now;
    }
  }

  private repeat(state: Repeat, dir: -1 | 0 | 1, dtMs: number, depthAxis: boolean): void {
    if (dir === 0) {
      state.dir = 0;
      return;
    }
    if (dir !== state.dir) {
      state.dir = dir;
      state.das = 0;
      state.arr = 0;
      this.applyMove(dir, depthAxis, true);
      return;
    }
    state.das += dtMs;
    if (state.das >= DAS_MS) {
      state.arr += dtMs;
      while (state.arr >= ARR_MS) {
        state.arr -= ARR_MS;
        this.applyMove(dir, depthAxis, false);
      }
    }
  }

  private applyMove(dir: -1 | 1, depthAxis: boolean, initial: boolean): void {
    let screenDir: ScreenDir = dir < 0 ? "left" : "right";
    if (depthAxis) {
      screenDir = dir < 0 ? "away" : "near";
    }
    this.stepScreen(screenDir, initial);
  }

  /** One camera-corrected move step (shared by keyboard DAS/ARR and touch). */
  private stepScreen(dir: ScreenDir, initial: boolean): void {
    const m = screenToWorld(this.rig.corner, dir);
    const moved = this.engine.move(m.dx, m.dz);
    if (moved && initial) {
      sfx.move();
    }
  }

  // ---- HUD --------------------------------------------------------------------

  /** Next / hold piece previews, redrawn only when their piece changes. */
  private updatePreviewHud(): void {
    if (this.engine.nextIndex !== this.hudNextIdx) {
      this.hudNextIdx = this.engine.nextIndex;
      const cv = el("next-canvas");
      const def = PIECES[this.engine.nextIndex];
      if (cv instanceof HTMLCanvasElement && def) {
        drawPiecePreview(cv, def.footprint, def.color);
      }
    }
    if (this.engine.holdIndex !== this.hudHoldIdx) {
      this.hudHoldIdx = this.engine.holdIndex;
      const cv = el("hold-canvas");
      if (cv instanceof HTMLCanvasElement) {
        const def = this.engine.holdIndex === null ? null : PIECES[this.engine.holdIndex];
        drawPiecePreview(cv, def?.footprint ?? null, def?.color ?? 0);
      }
    }
  }

  private updateChargeHud(): void {
    const charge = Math.round(this.engine.charge * 100);
    if (charge === this.hudCharge) {
      return;
    }
    this.hudCharge = charge;
    const node = el("charge");
    if (node) {
      const full = this.coarse ? "✦ POWER (T-pose / PWR)" : "✦ POWER (T-pose / F)";
      node.textContent = charge >= 100 ? full : `POWER ${charge}%`;
    }
  }

  private updateHud(now: number): void {
    const s = this.engine.state;
    if (s.score !== this.hudScore) {
      this.hudScore = s.score;
      const node = el("score");
      if (node) {
        node.textContent = `SCORE ${s.score}`;
      }
    }
    if (s.lines !== this.hudLines) {
      this.hudLines = s.lines;
      const node = el("lines");
      if (node) {
        node.textContent = `LINES ${s.lines}`;
      }
    }
    this.updatePreviewHud();
    this.updateChargeHud();
    const poseFresh = now - this.lastPoseAt < POSE_TIMEOUT_MS;
    const padFresh = now - this.lastPadAt < POSE_TIMEOUT_MS;
    // The idle owner is whatever the player falls back to: a phone has no keys.
    const idle = this.coarse ? "TOUCH" : "KEYS";
    let owner = idle;
    if (poseFresh && this.lastPoseAt >= this.lastPadAt) {
      owner = "POSE";
    } else if (padFresh) {
      owner = "PAD";
    }
    if (owner !== this.hudOwner) {
      this.hudOwner = owner;
      const node = el("input-owner");
      if (node) {
        node.textContent = owner === "POSE" || owner === "PAD" ? `● ${owner}` : `○ ${owner}`;
      }
    }
  }

  /** Show the centre banner. When `withLegend`, also reveal the full control
   *  reference centred under it and hide the in-play hotkey bar. */
  private showBanner(title: string, sub: string, withLegend = true): void {
    const t = el("banner-title");
    const s = el("banner-sub");
    const b = el("banner");
    if (t) {
      t.textContent = title;
    }
    if (s) {
      s.textContent = sub;
    }
    if (b) {
      b.style.opacity = "1";
    }
    this.setHudMode(withLegend ? "legend" : "none");
  }

  /** Hide the banner. In play the quiet hotkey bar carries the reference; the
   *  full legend lives on the title and game-over banners (and the wrapper
   *  pause overlay renders its own copy from the same manifest). */
  private hideBanner(): void {
    const b = el("banner");
    if (b) {
      b.style.opacity = "0";
    }
    this.setHudMode("hotkeys");
  }

  private setHudMode(mode: "legend" | "hotkeys" | "none"): void {
    const legend = el("legend");
    if (legend) {
      legend.style.display = mode === "legend" ? "flex" : "none";
    }
    const hotkeys = el("hotkeys");
    // Touch has no keyboard to reference and the bar lands on the DROP/HOLD
    // buttons; an inline display would beat the stylesheet's `body.touch` rule.
    if (hotkeys) {
      hotkeys.style.display = mode === "hotkeys" && !this.coarse ? "flex" : "none";
    }
  }
}
