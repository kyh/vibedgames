// The orchestrator: owns the Three.js scene, the camera rig, the well + cube
// renderers, the fx, the engine, and the input router that merges keyboard +
// pose into camera-relative moves (DAS/ARR, pose-freshness ownership). main.ts
// just boots it and renders scene + camera each frame.

import {
  createTouchControls,
  notifyGameStarted,
  pauseGame,
  watchControlContext,
} from "@repo/embed";
import { PhysicalGamepad, stickDirection4 } from "@vibedgames/gamepad";
import { Color, Scene } from "three";

import { titleSubText } from "../controls";
import type { Cell } from "../game/board";
import { screenToWorld } from "../game/camera-correction";
import type { ScreenDir } from "../game/camera-correction";
import { Engine } from "../game/engine";
import type { LockEvent } from "../game/engine";
import type { Status } from "../game/state";
import { ParticlePool } from "../fx/particles";
import { resetSound, sfx, toggleMute } from "../fx/sfx";
import { WellFx } from "../fx/well-fx";
import { Keyboard } from "../input/keyboard";
import type { KeyboardHandlers } from "../input/keyboard";
import type { PoseActions, PoseControls } from "../input/pose-control";
import { isCoarsePointer, TouchControls } from "../input/touch";
import type { TouchHandlers } from "../input/touch";
import { Collapse } from "../physics/collapse";
import { CameraRig } from "../render/camera-rig";
import { CubeField } from "../render/cube-field";
import { Hud, hideBanner, renderLegend, showBanner, showResults } from "../render/hud";
import type { InputOwner } from "../render/hud";
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

const BEST_SCORE_KEY = "tetris-best-score";

const readBestScore = (): number => {
  try {
    const value = Number(localStorage.getItem(BEST_SCORE_KEY));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
};

interface Steer {
  horiz: -1 | 0 | 1;
  depth: -1 | 0 | 1;
}

/** Read-only telemetry for headless playtests (`window.__GAME_DIAGNOSTICS__`). */
export interface TetrisDiagnostics {
  frame: number;
  phase: Status;
  score: number;
  lines: number;
  complete: boolean;
  player: Cell | null;
  entities: number;
}

const screenDirOf = (dir: -1 | 1, depthAxis: boolean): ScreenDir => {
  if (depthAxis) {
    return dir < 0 ? "away" : "near";
  }
  return dir < 0 ? "left" : "right";
};

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
  private readonly wellFx: WellFx;
  private readonly collapse = new Collapse();
  private readonly engine = new Engine();
  private readonly keyboard: Keyboard;
  private readonly touch: TouchControls;
  private readonly hud: Hud;
  private readonly pad = new PhysicalGamepad();
  private readonly coarse = isCoarsePointer();
  private poseControls: PoseControls | null = null;
  /** A pad stick/trigger held across a pause must be released before it acts again. */
  private padSteerBlocked = false;
  private padSoftBlocked = false;
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
  private frame = 0;
  private maxHeight = -1;
  private piecesPlaced = 0;
  private rescues = 0;
  private largestClear = 0;
  private orbitTaught = false;
  private bestScore = readBestScore();

  constructor(aspect: number) {
    this.scene.background = new Color(BG);
    this.rig = new CameraRig(aspect);
    this.well = new Well(this.scene);
    this.cubes = new CubeField(this.scene);
    this.particles = new ParticlePool(this.scene);
    this.wellFx = new WellFx(this.scene);
    this.keyboard = new Keyboard(this.keyboardHandlers());
    this.touch = new TouchControls(this.touchHandlers());
    // P is keyboard-only: without this a phone cannot pause. No-op on a fine
    // pointer.
    createTouchControls({
      className: "tetris-touch-controls",
      css: TOUCH_CONTROLS_CSS,
      styleId: "tetris-touch-controls-css",
    });
    document.body.classList.toggle("touch", this.coarse);
    this.hud = new Hud(this.coarse, () => this.startIfIdle());
    renderLegend();
    this.showBanner("TETRIS", titleSubText());
    // Plugging in a pad on the title adds its legend row + start hint.
    this.unwatchControls = watchControlContext(() => {
      if (this.engine.state.status !== "title") {
        return;
      }
      renderLegend();
      this.showBanner("TETRIS", titleSubText());
    });
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

  diagnostics(): TetrisDiagnostics {
    let entities = 0;
    for (const _cube of this.engine.board.cubes()) {
      entities += 1;
    }
    const active = this.engine.activeCells();
    return {
      complete: this.engine.state.status === "gameOver",
      entities,
      frame: this.frame,
      lines: this.engine.state.lines,
      phase: this.engine.state.status,
      player: active.length > 0 ? centroid(active) : null,
      score: this.engine.state.score,
    };
  }

  /** Wrapper pause ended: shift the collapse catch-window deadline (and the
   *  camera swing) so the paused gap doesn't count against them. Pose-freshness
   *  stamps deliberately stay unshifted — stale pose reading as old is the safe
   *  direction. */
  shiftWallClock(pausedMs: number): void {
    this.collapseStartedAt += pausedMs;
    this.rig.shiftWallClock(pausedMs);
  }

  /** Pause and resume both drop every held input: a key or finger held across
   *  the pause never gets its release event, so it would otherwise stay held. */
  releaseInputs(): void {
    this.keyboard.releaseHeld();
    this.touch.release();
    this.kbHoriz = 0;
    this.kbDepth = 0;
    this.poseHoriz = 0;
    this.poseHorizAt = -1e9;
    this.lastPoseAt = -1e9;
    this.lastPadAt = -1e9;
    this.hMove.dir = 0;
    this.hMove.das = 0;
    this.hMove.arr = 0;
    this.dMove.dir = 0;
    this.dMove.das = 0;
    this.dMove.arr = 0;
    this.engine.setSoftDrop(false);
    this.padSoftDrop = false;
    this.padSteerBlocked = true;
    this.padSoftBlocked = true;
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
      muteToggle: () => toggleMute(),
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
    if (!this.orbitTaught) {
      this.orbitTaught = true;
      this.wellFx.orbitHint();
    }
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
    let lowest = this.engine.board.height;
    const footprint: Cell[] = [];
    for (const { x, y, z } of this.engine.board.cubes()) {
      if (y < lowest) {
        lowest = y;
        footprint.length = 0;
      }
      if (y === lowest) {
        footprint.push({ x, y, z });
      }
    }
    const removed = this.engine.power();
    if (removed <= 0) {
      return;
    }
    this.wellFx.power(footprint);
    this.boardDirty = true;
    sfx.power();
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
      y: lowest + 0.2,
      yKick: 4,
      z: WELL_CENTER_Z,
    });
  }

  private onHardDrop(): void {
    const { status } = this.engine.state;
    if (status === "playing") {
      const start = this.engine.activeCells();
      const landing = this.engine.ghostCells();
      const color = PIECES[this.engine.activePieceIndex()]?.color ?? 0xff_ff_ff;
      const ev = this.engine.hardDrop();
      sfx.hardDrop();
      this.rig.addTrauma(TRAUMA_HARD_DROP);
      if (ev) {
        this.wellFx.hardDrop(start, landing, color);
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
    this.well.setCorner(this.rig.corner);
    this.rig.resetTrauma();
    this.particles.reset();
    this.wellFx.reset();
    resetSound();
    this.piecesPlaced = 0;
    this.rescues = 0;
    this.largestClear = 0;
    this.orbitTaught = false;
    this.engine.startGame();
    this.boardDirty = true;
    this.needSnap = true;
    this.hMove.dir = 0;
    this.dMove.dir = 0;
    this.hideBanner();
  }

  // ---- lock / clear / collapse ------------------------------------------------

  private handleLock(ev: LockEvent): void {
    this.piecesPlaced += 1;
    this.largestClear = Math.max(this.largestClear, ev.clear.lines);
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
      const crossed = ev.clear.xColumns > 0 && ev.clear.zRows > 0;
      this.wellFx.clear(ev.clear.clearedCells, ev.clear.lines, crossed);
      sfx.clear(ev.clear.lines, crossed);
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
      this.rescues += 1;
      sfx.catchCollapse();
      this.wellFx.rescue();
      this.hideBanner();
    }
  }

  private finalizeGameOver(): void {
    this.engine.state.status = "gameOver";
    this.well.setAllWallsVisible(true);
    sfx.gameOver();
    const previous = this.bestScore;
    const newBest = this.engine.state.score > previous;
    const runBest = Math.max(previous, this.engine.state.score);
    this.bestScore = runBest;
    if (newBest) {
      try {
        localStorage.setItem(BEST_SCORE_KEY, String(runBest));
      } catch {
        // A blocked store must never block the retry path; keep this visit's best.
      }
    }
    showResults({
      best: runBest,
      largestClear: this.largestClear,
      lines: this.engine.state.lines,
      newBest,
      pieces: this.piecesPlaced,
      rescues: this.rescues,
      score: this.engine.state.score,
    });
    this.showBanner(
      "GAME OVER",
      `${this.coarse ? "Tap" : "Enter / Space"} to retry · a fresh stack awaits`,
      false,
    );
  }

  // ---- main update ------------------------------------------------------------

  update(dt: number): void {
    this.frame += 1;
    const now = performance.now();
    const dtMs = dt * 1000;
    // Poll the gamepad before the sim tick.
    this.touch.update(dtMs);
    this.updatePad(now);
    const { status } = this.engine.state;

    if (status === "playing") {
      this.routeSteering(dtMs);
      // Gravity pauses during the swing.
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
      this.maxHeight = -1;
      for (const { y } of this.engine.board.cubes()) {
        this.maxHeight = Math.max(this.maxHeight, y);
      }
      this.boardDirty = false;
    }
    this.wellFx.setHeight(this.maxHeight, this.engine.state.status === "playing");
    const active = this.engine.activeCells();
    this.cubes.setActive(active, this.engine.activePieceIndex(), this.needSnap);
    this.cubes.setGhost(this.engine.ghostCells());
    this.needSnap = false;

    this.cubes.update(dt);
    this.particles.update(dt);
    this.wellFx.update(dt);
    this.rig.update(dt, now);
    this.updateHud(now);
  }

  private routeSteering(dtMs: number): void {
    const poseFresh = performance.now() - this.poseHorizAt < POSE_TIMEOUT_MS;
    const pad = this.padSteer();
    const horiz = this.heldHoriz(pad.horiz, poseFresh);
    const depth: -1 | 0 | 1 = this.kbDepth === 0 ? pad.depth : this.kbDepth;
    this.repeat(this.hMove, horiz, dtMs, false);
    this.repeat(this.dMove, depth, dtMs, true);
  }

  /** Keyboard wins, then the pad, then a fresh pose steer. */
  private heldHoriz(padHoriz: -1 | 0 | 1, poseFresh: boolean): -1 | 0 | 1 {
    if (this.kbHoriz !== 0) {
      return this.kbHoriz;
    }
    if (padHoriz !== 0) {
      return padHoriz;
    }
    return poseFresh ? this.poseHoriz : 0;
  }

  private dpadAxis(negative: string, positive: string): -1 | 0 | 1 {
    if (this.pad.isButtonDown(negative)) {
      return -1;
    }
    if (this.pad.isButtonDown(positive)) {
      return 1;
    }
    return 0;
  }

  /** Held pad steer (d-pad first, then left stick) on the same screen-relative
   *  axes as the keyboard, so it feeds the shared DAS/ARR repeat state. */
  private padSteer(): Steer {
    if (!this.pad.connected) {
      return { depth: 0, horiz: 0 };
    }
    let horiz = this.dpadAxis("left", "right");
    let depth = this.dpadAxis("up", "down");
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
    if (this.padSteerBlocked) {
      if (horiz === 0 && depth === 0) {
        this.padSteerBlocked = false;
      }
      return { depth: 0, horiz: 0 };
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
      // Space semantics: hard drop, or catch while collapsing.
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
    const heldSoft = this.pad.isButtonDown("lt") || this.pad.isButtonDown("rt");
    if (!heldSoft) {
      this.padSoftBlocked = false;
    }
    const soft = heldSoft && !this.padSoftBlocked;
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
    this.stepScreen(screenDirOf(dir, depthAxis), initial);
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

  private catchRemaining(now: number): number | null {
    if (this.engine.state.status !== "collapsing") {
      return null;
    }
    return Math.max(0, CATCH_WINDOW_MS - (now - this.collapseStartedAt));
  }

  private updateHud(now: number): void {
    const s = this.engine.state;
    this.hud.setCatchMeter(this.catchRemaining(now));
    const poseFresh = now - this.lastPoseAt < POSE_TIMEOUT_MS;
    const padFresh = now - this.lastPadAt < POSE_TIMEOUT_MS;
    // The idle owner is whatever the player falls back to: a phone has no keys.
    const idle: InputOwner = this.coarse ? "TOUCH" : "KEYS";
    let owner: InputOwner = idle;
    if (poseFresh && this.lastPoseAt >= this.lastPadAt) {
      owner = "POSE";
    } else if (padFresh) {
      owner = "PAD";
    }
    this.hud.update({
      charge: this.engine.charge,
      holdIndex: this.engine.holdIndex,
      holdSpent: this.engine.holdSpent,
      lines: s.lines,
      nextIndex: this.engine.nextIndex,
      owner,
      score: s.score,
    });
  }

  /** Show the centre banner. When `withLegend`, also reveal the full control
   *  reference centred under it and hide the in-play hotkey bar. The button
   *  cluster exists only in play; title and results own their taps. */
  private showBanner(title: string, sub: string, withLegend = true): void {
    const { status } = this.engine.state;
    showBanner(status, title, sub, withLegend ? "legend" : "none");
    this.touch.setActive(status !== "title" && status !== "gameOver");
    this.hud.setCatchMeter(this.catchRemaining(performance.now()));
  }

  private hideBanner(): void {
    const { status } = this.engine.state;
    hideBanner(status);
    this.touch.setActive(status !== "title" && status !== "gameOver");
    this.hud.setCatchMeter(this.catchRemaining(performance.now()));
  }
}
