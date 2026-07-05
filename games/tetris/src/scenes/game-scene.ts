// The orchestrator: owns the Three.js scene, the camera rig, the well + cube
// renderers, the fx, the engine, and the input router that merges keyboard +
// pose into camera-relative moves (DAS/ARR, pose-freshness ownership). main.ts
// just boots it and renders scene + camera each frame.

import { Color, Scene } from "three";

import type { Cell } from "../game/board";
import { screenToWorld } from "../game/camera-correction";
import { Engine, type LockEvent } from "../game/engine";
import { ParticlePool } from "../fx/particles";
import { isMuted, sfx, toggleMute } from "../fx/sfx";
import { Keyboard, type KeyboardHandlers } from "../input/keyboard";
import type { PoseActions, PoseControls } from "../input/pose-control";
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

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export class GameScene {
  readonly scene = new Scene();
  private readonly rig: CameraRig;
  private readonly well: Well;
  private readonly cubes: CubeField;
  private readonly particles: ParticlePool;
  private readonly collapse = new Collapse();
  private readonly engine = new Engine();
  private readonly keyboard: Keyboard;
  private poseControls: PoseControls | null = null;

  // input state (screen-relative)
  private kbHoriz: -1 | 0 | 1 = 0;
  private kbDepth: -1 | 0 | 1 = 0;
  private poseHoriz: -1 | 0 | 1 = 0;
  private poseHorizAt = -1e9;
  private readonly hMove: Repeat = { dir: 0, das: 0, arr: 0 };
  private readonly dMove: Repeat = { dir: 0, das: 0, arr: 0 };

  private needSnap = false;
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
    this.updateSoundPill(isMuted());
    this.showBanner("TETRIS", "lean to orbit · turn to rotate · Enter / Space to start");
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

  // ---- input wiring -----------------------------------------------------------

  /** Bound intent handlers handed to PoseControls (main.ts wires the camera). */
  readonly poseActions: PoseActions = {
    steer: (dir) => {
      this.poseHoriz = dir;
      this.poseHorizAt = performance.now();
      this.lastPoseAt = this.poseHorizAt;
    },
    rotate: () => this.doRotate(),
    orbit: (dir) => {
      this.lastPoseAt = performance.now();
      this.doOrbit(dir);
    },
    hold: () => {
      this.lastPoseAt = performance.now();
      this.doHold();
    },
    power: () => {
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
        this.kbHoriz = dir;
      },
      setDepth: (dir) => {
        this.kbDepth = dir;
      },
      rotate: () => {
        this.doRotate();
      },
      hardDrop: () => this.onHardDrop(),
      setSoftDrop: (on) => this.engine.setSoftDrop(on),
      orbit: (dir) => this.doOrbit(dir),
      hold: () => this.doHold(),
      power: () => this.doPower(),
      pauseToggle: () => this.togglePause(),
      start: () => this.startIfIdle(),
      recenter: () => this.poseControls?.recenter(),
      muteToggle: () => this.updateSoundPill(toggleMute()),
    };
  }

  // ---- verbs ------------------------------------------------------------------

  private doRotate(): boolean {
    if (this.engine.state.status !== "playing") return false;
    const ok = this.engine.rotate();
    if (ok) sfx.rotate();
    return ok;
  }

  private doOrbit(dir: -1 | 1): void {
    if (this.engine.state.status !== "playing") return;
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
    if (!this.engine.canPower()) return;
    const removed = this.engine.power();
    if (removed <= 0) return;
    sfx.clear(removed);
    this.rig.addTrauma(TRAUMA_CLEAR);
    this.particles.burst({
      x: WELL_CENTER_X,
      y: 0.2,
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
    const status = this.engine.state.status;
    if (status === "playing") {
      const ev = this.engine.hardDrop();
      sfx.hardDrop();
      this.rig.addTrauma(TRAUMA_HARD_DROP);
      if (ev) this.handleLock(ev);
    } else if (status === "collapsing") {
      this.tryCatch();
    } else if (status === "title" || status === "gameOver") {
      this.startGame();
    }
  }

  private togglePause(): void {
    const s = this.engine.state;
    if (s.status === "playing") {
      s.status = "paused";
      this.showBanner("PAUSED", "P to resume");
    } else if (s.status === "paused") {
      s.status = "playing";
      this.hideBanner();
    }
  }

  private startIfIdle(): void {
    const s = this.engine.state.status;
    if (s === "title" || s === "gameOver") this.startGame();
  }

  private startGame(): void {
    this.collapse.dispose();
    this.cubes.frozen = false;
    this.cubes.clearLocked();
    this.well.setCorner(0);
    this.rig.resetTrauma();
    this.engine.startGame();
    this.needSnap = true;
    this.hMove.dir = 0;
    this.dMove.dir = 0;
    this.hideBanner();
  }

  // ---- lock / clear / collapse ------------------------------------------------

  private handleLock(ev: LockEvent): void {
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
      sfx.clear(ev.clear.lines);
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
    this.showBanner("CATCH IT!", "throw your hands UP (or Space) to save the stack", false);
  }

  private tryCatch(): void {
    if (this.engine.state.status !== "collapsing") return;
    this.collapse.dispose();
    this.cubes.frozen = false;
    this.cubes.clearLocked();
    this.well.setCorner(this.rig.corner);
    const stillDead = this.engine.resumeAfterCatch();
    this.rig.resetTrauma();
    this.needSnap = true;
    if (stillDead) {
      this.finalizeGameOver();
    } else {
      sfx.catch();
      this.hideBanner();
    }
  }

  private finalizeGameOver(): void {
    this.engine.state.status = "gameOver";
    this.well.setAllWallsVisible(true);
    sfx.gameOver();
    this.showBanner("GAME OVER", `score ${this.engine.state.score} · Enter to retry`);
  }

  // ---- main update ------------------------------------------------------------

  update(dt: number): void {
    const now = performance.now();
    const dtMs = dt * 1000;
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

    // sync renderers from the logical state
    this.cubes.syncLocked(this.engine.board);
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
    const horiz: -1 | 0 | 1 = this.kbHoriz !== 0 ? this.kbHoriz : poseFresh ? this.poseHoriz : 0;
    this.repeat(this.hMove, horiz, dtMs, false);
    this.repeat(this.dMove, this.kbDepth, dtMs, true);
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
    const screenDir = depthAxis ? (dir < 0 ? "away" : "near") : dir < 0 ? "left" : "right";
    const m = screenToWorld(this.rig.corner, screenDir);
    const moved = this.engine.move(m.dx, m.dz);
    if (moved && initial) sfx.move();
  }

  // ---- HUD --------------------------------------------------------------------

  private updateHud(now: number): void {
    const s = this.engine.state;
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
      if (cv instanceof HTMLCanvasElement && def) drawPiecePreview(cv, def.shape, def.color);
    }
    if (this.engine.holdIndex !== this.hudHoldIdx) {
      this.hudHoldIdx = this.engine.holdIndex;
      const cv = el("hold-canvas");
      if (cv instanceof HTMLCanvasElement) {
        const def = this.engine.holdIndex === null ? null : PIECES[this.engine.holdIndex];
        drawPiecePreview(cv, def?.shape ?? null, def?.color ?? 0);
      }
    }
    const charge = Math.round(this.engine.charge * 100);
    if (charge !== this.hudCharge) {
      this.hudCharge = charge;
      const node = el("charge");
      if (node) node.textContent = charge >= 100 ? "✦ POWER (T-pose / F)" : `POWER ${charge}%`;
    }
    const owner = now - this.lastPoseAt < POSE_TIMEOUT_MS ? "POSE" : "KEYS";
    if (owner !== this.hudOwner) {
      this.hudOwner = owner;
      const node = el("input-owner");
      if (node) node.textContent = owner === "POSE" ? "● POSE" : "○ KEYS";
    }
  }

  private updateSoundPill(muted: boolean): void {
    const node = el("sound");
    if (node) node.textContent = muted ? "🔇" : "🔊";
  }

  /** Show the centre banner. When `withLegend`, also reveal the full control
   *  reference and hide the in-play bar (the screen is idle — title/pause/over). */
  private showBanner(title: string, sub: string, withLegend = true): void {
    const t = el("banner-title");
    const s = el("banner-sub");
    const b = el("banner");
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
    if (b) b.style.opacity = "1";
    this.setHudMode(withLegend ? "legend" : "none");
  }

  /** Hide the banner and show the short in-play control bar. */
  private hideBanner(): void {
    const b = el("banner");
    if (b) b.style.opacity = "0";
    this.setHudMode("bar");
  }

  private setHudMode(mode: "legend" | "bar" | "none"): void {
    const legend = el("legend");
    const controls = el("controls");
    if (legend) legend.style.display = mode === "legend" ? "block" : "none";
    if (controls) controls.style.display = mode === "bar" ? "block" : "none";
  }
}

function centroid(cells: Cell[]): { x: number; y: number; z: number } {
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
