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
import { BufferGeometry, Color, InstancedMesh, LineSegments, Material, Mesh, Scene } from "three";

import { CONTROLS, titleSubText } from "../controls";
import { groupRow } from "../pause-overlay";
import type { Cell } from "../game/board";
import { screenToWorld, type ScreenDir } from "../game/camera-correction";
import { Engine, type LockEvent } from "../game/engine";
import {
  createFixedRandom,
  FIXED_RUN_NAME,
  readFixedBest,
  storeFixedBest,
  type RunMode,
} from "../game/fixed-run";
import { RuleTeaching } from "../game/rule-teaching";
import { ParticlePool } from "../fx/particles";
import { WellFx, type WellFxState } from "../fx/well-fx";
import type { Status } from "../game/state";
import { isMuted, resetSound, setMuted, sfx, toggleMute } from "../fx/sfx";
import { Keyboard, type KeyboardHandlers } from "../input/keyboard";
import type { PoseActions, PoseControls } from "../input/pose-control";
import { isCoarsePointer, TouchControls, type TouchHandlers } from "../input/touch";
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

type Repeat = { dir: -1 | 0 | 1; das: number; arr: number };

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

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

const BEST_SCORE_KEY = "tetris-best-score";

function readBestScore(): number {
  try {
    const value = Number(localStorage.getItem(BEST_SCORE_KEY));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

type Steer = { horiz: -1 | 0 | 1; depth: -1 | 0 | 1 };

export type TetrisDiagnostics = {
  frame: number;
  phase: Status;
  score: number;
  mode: RunMode["kind"];
  complete: boolean;
  player: Cell | null;
  entities: number;
  lines: number;
  charge: number;
  corner: number;
  run: { pieces: number; rescues: number; largestClear: number; bestScore: number };
  catchRemainingMs: number | null;
  fx: WellFxState & { particles: number };
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
  private readonly touchControls: EmbedTouchControls;
  private readonly pad = new PhysicalGamepad();
  private readonly coarse = isCoarsePointer();
  private poseControls: PoseControls | null = null;
  private presentationPaused = false;
  private disposed = false;
  private padSteerBlocked = false;
  private padSoftBlocked = false;
  private readonly onCompactStart = () => this.startIfIdle();
  private unwatchControls: (() => void) | null = null;

  // input state (screen-relative)
  private kbHoriz: -1 | 0 | 1 = 0;
  private kbDepth: -1 | 0 | 1 = 0;
  private poseHoriz: -1 | 0 | 1 = 0;
  private poseHorizAt = -1e9;
  private padSoftDrop = false;
  private lastPadAt = -1e9;
  private readonly hMove: Repeat = { dir: 0, das: 0, arr: 0 };
  private readonly dMove: Repeat = { dir: 0, das: 0, arr: 0 };

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
  private fixedBest = readFixedBest();
  private mode: RunMode = { kind: "normal" };
  private readonly teaching: RuleTeaching;
  private readonly onFixedEnter = () => this.startMode({ kind: "fixed" });
  private readonly onFixedRetry = () => this.startIfIdle();
  private readonly onFixedNormal = () => this.startMode({ kind: "normal" });
  private readonly sealRunPointer = (event: Event) => event.stopPropagation();
  private readonly sealRunKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  };
  // Sampled alongside the displayed meter, so diagnostics also freeze on pause.
  private catchRemainingMs: number | null = null;
  private catchTenths = -1;

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
    this.wellFx = new WellFx(this.scene);
    this.keyboard = new Keyboard(this.keyboardHandlers());
    this.touch = new TouchControls(this.touchHandlers());
    // M and P are keyboard-only: without this a phone plays permanently silent
    // and cannot pause. No-ops on a fine pointer.
    this.touchControls = createTouchControls({
      mute: { get: isMuted, set: setMuted },
      className: "tetris-touch-controls",
      css: TOUCH_CONTROLS_CSS,
      styleId: "tetris-touch-controls-css",
    });
    document.body.classList.toggle("touch", this.coarse);
    el("compact-start")?.addEventListener("click", this.onCompactStart);
    this.teaching = new RuleTeaching(el("spatial-rule"));
    el("fixed-run-enter")?.addEventListener("click", this.onFixedEnter);
    el("fixed-run-retry")?.addEventListener("click", this.onFixedRetry);
    el("fixed-run-normal")?.addEventListener("click", this.onFixedNormal);
    el("run-actions")?.addEventListener("keydown", this.sealRunKey);
    el("run-actions")?.addEventListener("keyup", this.sealRunKey);
    el("run-actions")?.addEventListener("pointerdown", this.sealRunPointer);
    el("run-actions")?.addEventListener("pointerup", this.sealRunPointer);
    this.renderLegend();
    this.showBanner("TETRIS", titleSubText());
    // Plugging in a pad on the title adds its legend row + start hint.
    this.unwatchControls = watchControlContext(() => {
      if (this.disposed || this.engine.state.status !== "title") return;
      this.renderLegend();
      this.showBanner("TETRIS", titleSubText());
    });
  }

  /** Rebuild the banner legend from the controls manifest, one row per
   *  visible input method (boot-time, not on first touch — the copy must be
   *  right before the player ever taps). Rows are the pause overlay's own
   *  method-label + keycap-chip rows, so title and pause teach with one UI. */
  private renderLegend(): void {
    const legend = el("legend");
    if (!legend) return;
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
    if (this.disposed) return;
    this.rig.resize(aspect);
  }

  diagnostics(): TetrisDiagnostics {
    let entities = 0;
    this.engine.board.forEachCube(() => {
      entities += 1;
    });
    const active = this.engine.activeCells();
    return {
      frame: this.frame,
      phase: this.engine.state.status,
      score: this.engine.state.score,
      mode: this.mode.kind,
      complete: this.engine.state.status === "gameOver",
      player: active.length > 0 ? centroid(active) : null,
      entities,
      lines: this.engine.state.lines,
      charge: this.engine.charge,
      corner: this.rig.corner,
      run: {
        pieces: this.piecesPlaced,
        rescues: this.rescues,
        largestClear: this.largestClear,
        bestScore: this.mode.kind === "fixed" ? this.fixedBest : this.bestScore,
      },
      catchRemainingMs: this.catchRemainingMs,
      fx: { ...this.wellFx.counts(), particles: this.particles.count },
    };
  }

  /** Wrapper pause ended: shift the collapse catch-window deadline so the
   *  paused gap doesn't count against it. Pose-freshness stamps deliberately
   *  stay unshifted — stale pose input reading as old is the safe direction. */
  shiftWallClock(pausedMs: number): void {
    if (this.disposed) return;
    this.collapseStartedAt += pausedMs;
    this.rig.shiftWallClock(pausedMs);
  }

  /** Freeze asynchronous intent sources as well as the frame-driven engine. */
  setPresentationPaused(paused: boolean): void {
    if (this.disposed) return;
    this.presentationPaused = paused;
    this.keyboard.setPaused(paused);
    this.touch.setPaused(paused);
    this.kbHoriz = this.kbDepth = this.poseHoriz = 0;
    this.poseHorizAt = this.lastPoseAt = this.lastPadAt = -1e9;
    this.hMove.dir = this.dMove.dir = 0;
    this.hMove.das = this.hMove.arr = this.dMove.das = this.dMove.arr = 0;
    this.engine.setSoftDrop(false);
    this.padSoftDrop = false;
    this.pad.update();
    this.pad.update();
    this.padSteerBlocked = true;
    this.padSoftBlocked = true;
  }

  /** Final scene owner. Reset/retry keeps these resources; final teardown releases each once. */
  dispose(): void {
    if (this.disposed) return;
    this.setPresentationPaused(true);
    this.disposed = true;
    this.keyboard.destroy();
    this.touch.destroy();
    this.touchControls.destroy();
    this.pad.destroy();
    this.unwatchControls?.();
    this.unwatchControls = null;
    el("compact-start")?.removeEventListener("click", this.onCompactStart);
    this.teaching.dispose();
    el("fixed-run-enter")?.removeEventListener("click", this.onFixedEnter);
    el("fixed-run-retry")?.removeEventListener("click", this.onFixedRetry);
    el("fixed-run-normal")?.removeEventListener("click", this.onFixedNormal);
    el("run-actions")?.removeEventListener("keydown", this.sealRunKey);
    el("run-actions")?.removeEventListener("keyup", this.sealRunKey);
    el("run-actions")?.removeEventListener("pointerdown", this.sealRunPointer);
    el("run-actions")?.removeEventListener("pointerup", this.sealRunPointer);
    this.collapse.dispose();
    this.cubes.clearLocked();
    this.particles.reset();
    this.wellFx.reset();
    this.poseControls = null;
    this.hideBanner();
    this.setHudMode("none");
    const meter = el("catch-meter");
    if (meter) meter.hidden = true;
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    this.scene.traverse((object) => {
      if (object instanceof Mesh || object instanceof LineSegments) {
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          materials.add(material);
        }
      }
      if (object instanceof InstancedMesh) object.dispose();
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.scene.clear();
  }

  // ---- input wiring -----------------------------------------------------------

  /** Bound intent handlers handed to PoseControls (main.ts wires the camera). */
  readonly poseActions: PoseActions = {
    steer: (dir) => {
      if (this.presentationPaused || this.disposed) return;
      this.poseHoriz = dir;
      this.poseHorizAt = performance.now();
      this.lastPoseAt = this.poseHorizAt;
    },
    rotate: () => this.doRotate(),
    orbit: (dir) => {
      if (this.presentationPaused || this.disposed) return;
      this.lastPoseAt = performance.now();
      this.doOrbit(dir);
    },
    hold: () => {
      if (this.presentationPaused || this.disposed) return;
      this.lastPoseAt = performance.now();
      this.doHold();
    },
    power: () => {
      if (this.presentationPaused || this.disposed) return;
      this.lastPoseAt = performance.now();
      this.doPower();
    },
    catchCollapse: () => {
      // Throw-hands-up: catches the collapse mid-tumble, and starts the game
      // from the title / game-over screen — so play begins hands-free too.
      const status = this.engine.state.status;
      if (status === "collapsing") this.tryCatch();
      else if (status === "title" || status === "gameOver") this.startGame();
    },
  };

  private keyboardHandlers(): KeyboardHandlers {
    return {
      setHoriz: (dir) => {
        if (!this.presentationPaused && !this.disposed) this.kbHoriz = dir;
      },
      setDepth: (dir) => {
        if (!this.presentationPaused && !this.disposed) this.kbDepth = dir;
      },
      rotate: () => {
        this.doRotate();
      },
      hardDrop: () => this.onHardDrop(),
      setSoftDrop: (on) => {
        if (!this.presentationPaused && !this.disposed) this.engine.setSoftDrop(on);
      },
      orbit: (dir) => this.doOrbit(dir),
      hold: () => this.doHold(),
      power: () => this.doPower(),
      pause: () => this.requestPause(),
      start: () => this.startIfIdle(),
      recenter: () => {
        if (!this.disposed) this.poseControls?.recenter();
      },
      muteToggle: () => {
        if (this.disposed) return;
        toggleMute();
        this.touchControls.sync();
      },
    };
  }

  private touchHandlers(): TouchHandlers {
    return {
      step: (dir, initial) => this.stepScreen(dir, initial),
      rotate: () => {
        this.doRotate();
      },
      orbit: (dir) => this.doOrbit(dir),
      drop: () => this.onHardDrop(),
      setSoftDrop: (on) => {
        if (!this.presentationPaused && !this.disposed) this.engine.setSoftDrop(on);
      },
      hold: () => this.doHold(),
      power: () => this.doPower(),
      tap: () => this.onFreeTap(),
    };
  }

  /** A free touch (not on a button): the touch mirror of hands-up / Enter.
   *  While paused the wrapper overlay covers the screen and owns the tap. */
  private onFreeTap(): void {
    if (this.presentationPaused || this.disposed) return;
    const s = this.engine.state.status;
    if (s === "title" || s === "gameOver") this.startGame();
    else if (s === "collapsing") this.tryCatch();
  }

  // ---- verbs ------------------------------------------------------------------

  private doRotate(): boolean {
    if (this.presentationPaused || this.disposed) return false;
    if (this.engine.state.status !== "playing") return false;
    const ok = this.engine.rotate();
    if (ok) sfx.rotate();
    return ok;
  }

  private doOrbit(dir: -1 | 1): void {
    if (this.presentationPaused || this.disposed) return;
    if (this.engine.state.status !== "playing") return;
    const corner = this.rig.orbit(dir, performance.now());
    this.well.setCorner(corner);
    if (!this.orbitTaught) {
      this.orbitTaught = true;
      this.wellFx.orbitHint();
    }
    sfx.orbit();
  }

  private doHold(): void {
    if (this.presentationPaused || this.disposed) return;
    if (this.engine.hold()) {
      this.needSnap = true;
      sfx.rotate();
    }
  }

  private doPower(): void {
    if (this.presentationPaused || this.disposed) return;
    if (!this.engine.canPower()) return;
    let lowest = this.engine.board.height;
    const footprint: Cell[] = [];
    this.engine.board.forEachCube((x, y, z) => {
      if (y < lowest) {
        lowest = y;
        footprint.length = 0;
      }
      if (y === lowest) footprint.push({ x, y, z });
    });
    const removed = this.engine.power();
    if (removed <= 0) return;
    this.wellFx.power(footprint);
    this.boardDirty = true;
    sfx.power();
    this.rig.addTrauma(TRAUMA_CLEAR);
    this.particles.burst({
      x: WELL_CENTER_X,
      y: lowest + 0.2,
      z: WELL_CENTER_Z,
      color: 0xffffff,
      count: CLEAR_BURST_COUNT,
      speedMin: 4,
      speedMax: 9,
      yKick: 4,
      gravity: 3,
      life: 0.7,
      size: 0.18,
    });
  }

  private onHardDrop(): void {
    if (this.presentationPaused || this.disposed) return;
    const status = this.engine.state.status;
    if (status === "playing") {
      const start = this.engine.activeCells();
      const landing = this.engine.ghostCells();
      const color = PIECES[this.engine.activePieceIndex()]?.color ?? 0xffffff;
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
    if (this.presentationPaused || this.disposed) return;
    if (this.engine.state.status !== "playing") return;
    pauseGame();
  }

  private startIfIdle(): void {
    if (this.presentationPaused || this.disposed) return;
    const s = this.engine.state.status;
    if (s === "title" || s === "gameOver") this.startGame();
  }

  private startMode(mode: RunMode): void {
    if (this.presentationPaused || this.disposed) return;
    const phase = this.engine.state.status;
    if (phase !== "title" && phase !== "gameOver") return;
    this.mode = mode;
    this.startGame();
  }

  private refreshRunActions(): void {
    const phase = this.engine.state.status;
    const idle = !this.disposed && (phase === "title" || phase === "gameOver");
    const fixed = this.mode.kind === "fixed";
    this.touch.setActive(!this.disposed && (phase === "playing" || phase === "collapsing"));
    const actions = el("run-actions");
    if (actions) actions.hidden = !idle;
    const fixedActions = el("fixed-run-actions");
    if (fixedActions) fixedActions.hidden = !idle;
    const start = el("compact-start");
    if (start) start.hidden = fixed;
    const enter = el("fixed-run-enter");
    if (enter) enter.hidden = fixed;
    const retry = el("fixed-run-retry");
    if (retry) retry.hidden = !fixed;
    const normal = el("fixed-run-normal");
    if (normal) normal.hidden = !fixed;
    const badge = el("run-mode");
    if (badge) {
      badge.hidden = !fixed || this.disposed || phase !== "playing";
      badge.textContent = `${FIXED_RUN_NAME} · best ${this.fixedBest}`;
    }
  }

  private startGame(): void {
    if (this.presentationPaused || this.disposed) return;
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
    this.engine.startGame(this.mode.kind === "fixed" ? createFixedRandom() : null);
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
    const colorHex = PIECES[ev.colorIndex - 1]?.color ?? 0xffffff;
    const c = centroid(ev.lockedCells);
    sfx.lock();
    this.rig.addTrauma(TRAUMA_LOCK);
    this.particles.burst({
      x: c.x,
      y: c.y,
      z: c.z,
      color: colorHex,
      count: LOCK_DUST_COUNT,
      speedMin: 1,
      speedMax: 3,
      yKick: 1,
      gravity: 6,
      life: 0.4,
      size: 0.12,
    });

    if (ev.clear.lines > 0) {
      this.wellFx.clear(
        ev.clear.clearedCells,
        ev.clear.lines,
        ev.clear.xColumns > 0 && ev.clear.zRows > 0,
      );
      sfx.clear(ev.clear.lines, ev.clear.xColumns > 0 && ev.clear.zRows > 0);
      this.rig.addTrauma(TRAUMA_CLEAR);
      this.particles.burst({
        x: c.x,
        y: ev.layer,
        z: c.z,
        color: 0xffffff,
        count: CLEAR_BURST_COUNT,
        speedMin: 3,
        speedMax: 8,
        yKick: 3,
        gravity: 4,
        life: 0.6,
        size: 0.16,
      });
    }

    if (ev.gameOver) this.enterCollapse();
    else this.needSnap = true;
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
    if (this.presentationPaused || this.disposed) return;
    if (this.engine.state.status !== "collapsing") return;
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
      sfx.catch();
      this.wellFx.rescue();
      this.hideBanner();
    }
  }

  private finalizeGameOver(): void {
    this.engine.state.status = "gameOver";
    this.well.setAllWallsVisible(true);
    sfx.gameOver();
    const previous = this.mode.kind === "fixed" ? this.fixedBest : this.bestScore;
    const newBest = this.engine.state.score > previous;
    const runBest = Math.max(previous, this.engine.state.score);
    if (this.mode.kind === "fixed") {
      this.fixedBest = runBest;
      if (newBest) storeFixedBest(runBest);
    } else {
      this.bestScore = runBest;
      if (newBest) {
        try {
          localStorage.setItem(BEST_SCORE_KEY, String(runBest));
        } catch {
          // A blocked store must never block the retry path; keep this visit's best.
        }
      }
    }
    const score = el("result-score");
    const best = el("result-best");
    const stats = el("result-stats");
    if (score) score.textContent = String(this.engine.state.score);
    if (best) best.textContent = `${newBest ? "NEW BEST" : "BEST"} ${runBest}`;
    if (stats) {
      const lines = this.engine.state.lines;
      stats.textContent = `${lines} ${lines === 1 ? "line" : "lines"} · ${this.piecesPlaced} ${this.piecesPlaced === 1 ? "piece" : "pieces"} placed\n${this.rescues} ${this.rescues === 1 ? "rescue" : "rescues"} · largest clear ${this.largestClear}`;
    }
    this.showBanner(
      this.mode.kind === "fixed" ? "FIXED SEQUENCE" : "GAME OVER",
      this.mode.kind === "fixed"
        ? "Same pieces. New possibilities. Beat your sequence best."
        : `${this.coarse ? "Tap" : "Enter / Space"} to retry · a fresh stack awaits`,
      false,
    );
  }

  // ---- main update ------------------------------------------------------------

  update(dt: number): void {
    if (this.presentationPaused || this.disposed) return;
    this.frame += 1;
    const now = performance.now();
    const dtMs = dt * 1000;
    this.touch.update(dtMs); // poll the gamepad before the sim tick
    this.updatePad(now);
    if (this.presentationPaused || this.disposed) return;
    const status = this.engine.state.status;

    if (status === "playing") {
      this.routeSteering(dtMs);
      const paused = this.rig.isInMotion(now); // gravity pauses during the swing
      const ev = this.engine.tick(dtMs, paused);
      if (ev) this.handleLock(ev);
    } else if (status === "collapsing") {
      this.collapse.step(dt);
      if (now - this.collapseStartedAt > CATCH_WINDOW_MS) this.finalizeGameOver();
    }

    // sync renderers from the logical state (locked layer only when it changed;
    // syncLocked itself still no-ops while frozen, so keep the flag until thawed)
    if (this.boardDirty && !this.cubes.frozen) {
      this.cubes.syncLocked(this.engine.board);
      this.maxHeight = -1;
      this.engine.board.forEachCube((_x, y) => {
        this.maxHeight = Math.max(this.maxHeight, y);
      });
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
    const horiz: -1 | 0 | 1 =
      this.kbHoriz !== 0
        ? this.kbHoriz
        : pad.horiz !== 0
          ? pad.horiz
          : poseFresh
            ? this.poseHoriz
            : 0;
    const depth: -1 | 0 | 1 = this.kbDepth !== 0 ? this.kbDepth : pad.depth;
    this.repeat(this.hMove, horiz, dtMs, false);
    this.repeat(this.dMove, depth, dtMs, true);
  }

  /** Held pad steer (d-pad first, then left stick) on the same screen-relative
   *  axes as the keyboard, so it feeds the shared DAS/ARR repeat state. */
  private padSteer(): Steer {
    if (!this.pad.connected) return { horiz: 0, depth: 0 };
    let horiz: -1 | 0 | 1 = this.pad.isButtonDown("left")
      ? -1
      : this.pad.isButtonDown("right")
        ? 1
        : 0;
    let depth: -1 | 0 | 1 = this.pad.isButtonDown("up")
      ? -1
      : this.pad.isButtonDown("down")
        ? 1
        : 0;
    if (horiz === 0 && depth === 0) {
      const dir = stickDirection4(this.pad.getStick());
      if (dir === "left") horiz = -1;
      else if (dir === "right") horiz = 1;
      else if (dir === "up") depth = -1;
      else if (dir === "down") depth = 1;
    }
    if (this.padSteerBlocked) {
      if (horiz === 0 && depth === 0) this.padSteerBlocked = false;
      return { horiz: 0, depth: 0 };
    }
    if (horiz !== 0 || depth !== 0) this.lastPadAt = performance.now();
    return { horiz, depth };
  }

  /** Physical controller: poll once per frame and drive the same verbs as the
   *  keyboard (steering merges into routeSteering's DAS/ARR while playing). */
  private updatePad(now: number): void {
    this.pad.update();
    if (!this.pad.connected) return;
    const status = this.engine.state.status;
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
      if (this.presentationPaused || this.disposed) return;
      acted = true;
    }
    if (this.pad.justPressed("a")) {
      this.doRotate();
      acted = true;
    }
    if (this.pad.justPressed("b")) {
      this.onHardDrop(); // Space semantics: hard drop, or catch while collapsing
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
    if (!heldSoft) this.padSoftBlocked = false;
    const soft = heldSoft && !this.padSoftBlocked;
    if (soft !== this.padSoftDrop) {
      this.padSoftDrop = soft;
      this.engine.setSoftDrop(soft);
      acted = true;
    }
    if (acted) this.lastPadAt = now;
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
    const screenDir: ScreenDir = depthAxis
      ? dir < 0
        ? "away"
        : "near"
      : dir < 0
        ? "left"
        : "right";
    this.stepScreen(screenDir, initial);
  }

  /** One camera-corrected move step (shared by keyboard DAS/ARR and touch). */
  private stepScreen(dir: ScreenDir, initial: boolean): void {
    if (this.presentationPaused || this.disposed) return;
    const m = screenToWorld(this.rig.corner, dir);
    const moved = this.engine.move(m.dx, m.dz);
    if (moved && initial) sfx.move();
  }

  // ---- HUD --------------------------------------------------------------------

  private updateHud(now: number): void {
    const s = this.engine.state;
    this.updateCatchMeter(now);
    if (s.score !== this.hudScore) {
      this.hudScore = s.score;
      const node = el("score");
      if (node) node.textContent = `SCORE ${s.score}`;
    }
    if (s.lines !== this.hudLines) {
      this.hudLines = s.lines;
      const node = el("lines");
      if (node) node.textContent = `LINES ${s.lines}`;
    }
    if (this.engine.nextIndex !== this.hudNextIdx) {
      this.hudNextIdx = this.engine.nextIndex;
      const cv = el("next-canvas");
      const def = PIECES[this.engine.nextIndex];
      if (cv instanceof HTMLCanvasElement && def) drawPiecePreview(cv, def.footprint, def.color);
    }
    if (this.engine.holdIndex !== this.hudHoldIdx) {
      this.hudHoldIdx = this.engine.holdIndex;
      const cv = el("hold-canvas");
      if (cv instanceof HTMLCanvasElement) {
        const def = this.engine.holdIndex === null ? null : PIECES[this.engine.holdIndex];
        drawPiecePreview(cv, def?.footprint ?? null, def?.color ?? 0);
      }
    }
    const charge = Math.round(this.engine.charge * 100);
    if (charge !== this.hudCharge) {
      this.hudCharge = charge;
      const node = el("charge");
      if (node) {
        const full = this.coarse ? "✦ POWER (T-pose / PWR)" : "✦ POWER (T-pose / F)";
        node.textContent = charge >= 100 ? full : `POWER ${charge}%`;
      }
    }
    const poseFresh = now - this.lastPoseAt < POSE_TIMEOUT_MS;
    const padFresh = now - this.lastPadAt < POSE_TIMEOUT_MS;
    // The idle owner is whatever the player falls back to: a phone has no keys.
    const idle = this.coarse ? "TOUCH" : "KEYS";
    const owner = poseFresh && this.lastPoseAt >= this.lastPadAt ? "POSE" : padFresh ? "PAD" : idle;
    if (owner !== this.hudOwner) {
      this.hudOwner = owner;
      const node = el("input-owner");
      if (node) {
        node.textContent = owner === "POSE" || owner === "PAD" ? `● ${owner}` : `○ ${owner}`;
      }
    }
  }

  private updateCatchMeter(now: number): void {
    const meter = el("catch-meter");
    const catching = this.engine.state.status === "collapsing";
    if (meter) meter.hidden = !catching;
    if (!catching) {
      this.catchRemainingMs = null;
      this.catchTenths = -1;
      return;
    }
    const remaining = Math.max(0, CATCH_WINDOW_MS - (now - this.collapseStartedAt));
    this.catchRemainingMs = remaining;
    if (meter) meter.setAttribute("aria-valuenow", (remaining / CATCH_WINDOW_MS).toFixed(3));
    const fill = el("catch-fill");
    if (fill) fill.style.transform = `scaleX(${remaining / CATCH_WINDOW_MS})`;
    const tenths = Math.ceil(remaining / 100);
    if (tenths !== this.catchTenths) {
      this.catchTenths = tenths;
      const label = el("catch-time");
      if (label) label.textContent = `${(tenths / 10).toFixed(1)}s to catch`;
      if (meter)
        meter.setAttribute("aria-valuetext", `${(tenths / 10).toFixed(1)} seconds to catch`);
    }
  }

  /** Show the centre banner. When `withLegend`, also reveal the full control
   *  reference centred under it and hide the in-play hotkey bar. */
  private showBanner(title: string, sub: string, withLegend = true): void {
    const t = el("banner-title");
    const s = el("banner-sub");
    const b = el("banner");
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
    if (b) {
      b.style.opacity = "1";
      b.dataset.phase = this.engine.state.status;
      b.setAttribute("aria-hidden", "false");
    }
    const teaching = el("spatial-rule");
    const summary = el("run-summary");
    const start = el("compact-start");
    if (teaching) teaching.hidden = this.engine.state.status !== "title";
    if (summary) summary.hidden = this.engine.state.status !== "gameOver";
    if (start) start.textContent = this.engine.state.status === "gameOver" ? "Play again" : "Play";
    this.refreshRunActions();
    this.updateCatchMeter(performance.now());
    this.setHudMode(withLegend ? "legend" : "none");
  }

  /** Hide the banner. In play the quiet hotkey bar carries the reference; the
   *  full legend lives on the title banner (and the wrapper
   *  pause overlay renders its own copy from the same manifest). */
  private hideBanner(): void {
    const b = el("banner");
    if (b) {
      b.style.opacity = "0";
      b.dataset.phase = this.engine.state.status;
      b.setAttribute("aria-hidden", "true");
    }
    const teaching = el("spatial-rule");
    const summary = el("run-summary");
    if (teaching) teaching.hidden = true;
    if (summary) summary.hidden = true;
    this.refreshRunActions();
    this.updateCatchMeter(performance.now());
    this.setHudMode("hotkeys");
  }

  private setHudMode(mode: "legend" | "hotkeys" | "none"): void {
    const legend = el("legend");
    if (legend) legend.style.display = mode === "legend" ? "flex" : "none";
    const hotkeys = el("hotkeys");
    // Touch has no keyboard to reference and the bar lands on the DROP/HOLD
    // buttons; an inline display would beat the stylesheet's `body.touch` rule.
    if (hotkeys) hotkeys.style.display = mode === "hotkeys" && !this.coarse ? "flex" : "none";
  }
}

function centroid(cells: Cell[]) {
  if (cells.length === 0) return { x: 0, y: 0, z: 0 };
  let x = 0;
  let y = 0;
  let z = 0;
  for (const c of cells) {
    x += c.x;
    y += c.y;
    z += c.z;
  }
  return { x: x / cells.length, y: y / cells.length, z: z / cells.length };
}
