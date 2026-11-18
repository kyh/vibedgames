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
import type { Piece } from "../game/piece";
import { pillarHeights, planZones, rankZones } from "../game/placement";
import type { ZonePlan, ZonePlans } from "../game/placement";
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
  DEATH_HEIGHT,
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

const readBestScore = () => {
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
  /** The slab's centre on the floor plane (x/z); its height is `piece.y`. Holds the last slab's spot while none is falling. */
  player: { x: number; y: number; z: number };
  entities: number;
  piece: {
    type: string;
    /** Quarter turns clockwise from spawn, 0..3. */
    rotation: number;
    y: number;
    /** Sim time since it spawned — a fresh slab has not been decided about yet. */
    ageMs: number;
    /** Floor cells it covers, as [x, z]. */
    cells: [number, number][];
  } | null;
  next: string;
  hold: string | null;
  canHold: boolean;
  powerReady: boolean;
  /** Camera corner 0..3; the arrow keys are screen-relative, so this picks the world axis they push. */
  corner: number;
  /** One base-36 digit per pillar: `heights[z][x]` layers are stacked at (x, z). */
  heights: string[];
  maxHeight: number;
  deathHeight: number;
  /** What hard-dropping the slab over each 2x2 floor zone would do, as it is turned now. */
  zones: ZonePlans;
  /** Zone names, best drop first (a clear, else the lowest snug fit). */
  bestZones: string[];
  /** The best drop on offer now, and after one more clockwise turn. */
  best: ZonePlan | null;
  bestIfRotated: ZonePlan | null;
  /** Milliseconds left to catch a toppling stack; null unless `phase` is "collapsing". */
  catchMsLeft: number | null;
}

const bestPlan = (plans: ZonePlans) => plans[rankZones(plans)[0] ?? ""] ?? null;

const pieceName = (index: number) => PIECES[index]?.name ?? "?";

const screenDirOf: (dir: -1 | 1, depthAxis: boolean) => ScreenDir = (dir, depthAxis) => {
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
  private padSteerBlocked = false;
  private padSoftBlocked = false;
  private unwatchControls: (() => void) | null = null;

  private kbHoriz: -1 | 0 | 1 = 0;
  private kbDepth: -1 | 0 | 1 = 0;
  private poseHoriz: -1 | 0 | 1 = 0;
  private poseHorizAt = -1e9;
  private padSoftDrop = false;
  private lastPadAt = -1e9;
  private readonly hMove: Repeat = { arr: 0, das: 0, dir: 0 };
  private readonly dMove: Repeat = { arr: 0, das: 0, dir: 0 };

  private needSnap = false;
  private boardDirty = true;
  private collapseStartedAt = 0;
  private lastPoseAt = -1e9;
  private frame = 0;
  private agedPiece: Piece | null = null;
  private activeAgeMs = 0;
  private lastFloorCentre = { x: WELL_CENTER_X, y: 0, z: WELL_CENTER_Z };
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
    createTouchControls({
      className: "tetris-touch-controls",
      css: TOUCH_CONTROLS_CSS,
      styleId: "tetris-touch-controls-css",
    });
    document.body.classList.toggle("touch", this.coarse);
    this.hud = new Hud(this.coarse, () => this.startIfIdle());
    renderLegend();
    this.showBanner("TETRIS", titleSubText());
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

  attachPoseControls(controls: PoseControls) {
    this.poseControls = controls;
  }

  resize(aspect: number) {
    this.rig.resize(aspect);
  }

  diagnostics() {
    let entities = 0;

    for (const _cube of this.engine.board.cubes()) {
      entities += 1;
    }

    const { board } = this.engine;
    const piece = this.engine.active;
    const active = this.engine.activeCells();
    const centre = centroid(active);
    const heights = pillarHeights(board);
    const zones = planZones(board, heights, active);
    const ranked = rankZones(zones);
    const rotated = piece?.rotatedCells(board) ?? null;

    return {
      best: zones[ranked[0] ?? ""] ?? null,
      bestIfRotated: rotated ? bestPlan(planZones(board, heights, rotated)) : null,
      bestZones: ranked.slice(0, 3),
      canHold: piece !== null && !this.engine.holdSpent,
      catchMsLeft: this.catchRemaining(performance.now()),
      complete: this.engine.state.status === "gameOver",
      corner: this.rig.corner,
      deathHeight: DEATH_HEIGHT,
      entities,
      frame: this.frame,
      heights: heights.map((row) => row.map((h) => h.toString(36)).join("")),
      hold: this.engine.holdIndex === null ? null : pieceName(this.engine.holdIndex),
      lines: this.engine.state.lines,
      maxHeight: this.maxHeight + 1,
      next: pieceName(this.engine.nextIndex),
      phase: this.engine.state.status,
      piece: piece
        ? {
            ageMs: Math.round(this.activeAgeMs),
            cells: active.map((c) => [c.x, c.z]),
            rotation: piece.rotation,
            type: pieceName(piece.index),
            y: centre.y,
          }
        : null,
      player: piece ? { x: centre.x, y: 0, z: centre.z } : this.lastFloorCentre,
      powerReady: this.engine.canPower(),
      score: this.engine.state.score,
      zones,
    } satisfies TetrisDiagnostics;
  }

  /** Playtest hook: deal a seeded sequence and restart on it. */
  seed(seed: number) {
    this.engine.seed(seed);
    this.startGame();
  }

  /** Playtest hook: `active-play` leaves the title or results for a live run. Returns whether the name was applied. */
  setTestState(name: string) {
    if (name !== "active-play") {
      return false;
    }

    this.startIfIdle();

    return this.engine.state.status === "playing";
  }

  /** Wrapper pause ended: shift the collapse catch-window deadline (and the
   *  camera swing) so the paused gap doesn't count against them. Pose-freshness
   *  stamps deliberately stay unshifted — stale pose reading as old is the safe
   *  direction. */
  shiftWallClock(pausedMs: number) {
    this.collapseStartedAt += pausedMs;
    this.rig.shiftWallClock(pausedMs);
  }

  /** Pause and resume both drop every held input: a key or finger held across
   *  the pause never gets its release event, so it would otherwise stay held. */
  releaseInputs() {
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

  /** Bound intent handlers handed to PoseControls (main.ts wires the camera). */
  readonly poseActions: PoseActions = {
    catchCollapse: () => {
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

  private keyboardHandlers() {
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
    } satisfies KeyboardHandlers;
  }

  private touchHandlers() {
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
    } satisfies TouchHandlers;
  }

  private onFreeTap() {
    const s = this.engine.state.status;

    if (s === "title" || s === "gameOver") {
      this.startGame();
    } else if (s === "collapsing") {
      this.tryCatch();
    }
  }

  private doRotate() {
    if (this.engine.state.status !== "playing") {
      return false;
    }

    const ok = this.engine.rotate();

    if (ok) {
      sfx.rotate();
    }

    return ok;
  }

  private doOrbit(dir: -1 | 1) {
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

  private doHold() {
    if (this.engine.hold()) {
      this.needSnap = true;
      sfx.rotate();
    }
  }

  private doPower() {
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

  private onHardDrop() {
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

  private requestPause() {
    if (this.engine.state.status !== "playing") {
      return;
    }

    pauseGame();
  }

  private startIfIdle() {
    const s = this.engine.state.status;

    if (s === "title" || s === "gameOver") {
      this.startGame();
    }
  }

  private startGame() {
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

  private handleLock(ev: LockEvent) {
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

  private enterCollapse() {
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

  private tryCatch() {
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

  private finalizeGameOver() {
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
      } catch {}
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

  update(dt: number) {
    this.frame += 1;
    const now = performance.now();
    const dtMs = dt * 1000;
    this.touch.update(dtMs);
    this.updatePad(now);
    const { status } = this.engine.state;

    if (this.engine.active === this.agedPiece) {
      this.activeAgeMs += dtMs;
    } else {
      this.agedPiece = this.engine.active;
      this.activeAgeMs = 0;
    }

    if (status === "playing") {
      this.routeSteering(dtMs);
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

    if (active.length > 0) {
      const { x, z } = centroid(active);
      this.lastFloorCentre = { x, y: 0, z };
    }

    this.cubes.setActive(active, this.engine.activePieceIndex(), this.needSnap);
    this.cubes.setGhost(this.engine.ghostCells());
    this.needSnap = false;

    this.cubes.update(dt);
    this.particles.update(dt);
    this.wellFx.update(dt);
    this.rig.update(dt, now);
    this.updateHud(now);
  }

  private routeSteering(dtMs: number) {
    const poseFresh = performance.now() - this.poseHorizAt < POSE_TIMEOUT_MS;
    const pad = this.padSteer();
    const horiz = this.heldHoriz(pad.horiz, poseFresh);
    const depth: -1 | 0 | 1 = this.kbDepth === 0 ? pad.depth : this.kbDepth;
    this.repeat(this.hMove, horiz, dtMs, false);
    this.repeat(this.dMove, depth, dtMs, true);
  }

  private heldHoriz(padHoriz: -1 | 0 | 1, poseFresh: boolean) {
    if (this.kbHoriz !== 0) {
      return this.kbHoriz;
    }

    if (padHoriz !== 0) {
      return padHoriz;
    }

    return poseFresh ? this.poseHoriz : (0 as const);
  }

  private dpadAxis(negative: string, positive: string) {
    if (this.pad.isButtonDown(negative)) {
      return -1 as const;
    }

    if (this.pad.isButtonDown(positive)) {
      return 1 as const;
    }

    return 0 as const;
  }

  private padSteer() {
    if (!this.pad.connected) {
      return { depth: 0, horiz: 0 } satisfies Steer;
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

      return { depth: 0, horiz: 0 } satisfies Steer;
    }

    if (horiz !== 0 || depth !== 0) {
      this.lastPadAt = performance.now();
    }

    return { depth, horiz } satisfies Steer;
  }

  private updatePad(now: number) {
    this.pad.update();

    if (!this.pad.connected) {
      return;
    }

    const { status } = this.engine.state;

    if (status === "title" || status === "gameOver") {
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

  private repeat(state: Repeat, dir: -1 | 0 | 1, dtMs: number, depthAxis: boolean) {
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

  private applyMove(dir: -1 | 1, depthAxis: boolean, initial: boolean) {
    this.stepScreen(screenDirOf(dir, depthAxis), initial);
  }

  private stepScreen(dir: ScreenDir, initial: boolean) {
    const m = screenToWorld(this.rig.corner, dir);
    const moved = this.engine.move(m.dx, m.dz);

    if (moved && initial) {
      sfx.move();
    }
  }

  private catchRemaining(now: number) {
    if (this.engine.state.status !== "collapsing") {
      return null;
    }

    return Math.max(0, CATCH_WINDOW_MS - (now - this.collapseStartedAt));
  }

  private updateHud(now: number) {
    const s = this.engine.state;
    this.hud.setCatchMeter(this.catchRemaining(now));
    const poseFresh = now - this.lastPoseAt < POSE_TIMEOUT_MS;
    const padFresh = now - this.lastPadAt < POSE_TIMEOUT_MS;
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

  private showBanner(title: string, sub: string, withLegend = true) {
    const { status } = this.engine.state;
    showBanner(status, title, sub, withLegend ? "legend" : "none");
    this.touch.setActive(status !== "title" && status !== "gameOver");
    this.hud.setCatchMeter(this.catchRemaining(performance.now()));
  }

  private hideBanner() {
    const { status } = this.engine.state;
    hideBanner(status);
    this.touch.setActive(status !== "title" && status !== "gameOver");
    this.hud.setCatchMeter(this.catchRemaining(performance.now()));
  }
}
