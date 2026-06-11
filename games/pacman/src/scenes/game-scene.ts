// 3D first-person Pac-Man, restored from the legacy r3f build on plain three.js.
// Step-per-chomp movement: each mouth-open transition (or SPACE) advances one
// grid cell; head turns / arrow keys rotate the heading relative to the current
// facing. Chase camera trails the yellow sphere; SHIFT flips to a selfie view.

import * as THREE from "three";

import type { Dir } from "../shared/constants";
import {
  AMBIENT_INTENSITY,
  BEST_KEY,
  CAM_BACK,
  CAM_HEIGHT,
  CAM_LOOK_AHEAD,
  CAM_SELFIE_LOOK_BACK,
  CAMERA_SMOOTHING,
  CHASE_CHANCE,
  COLORS,
  DIR_VECT,
  DIRS,
  GHOST_BOB_AMP,
  GHOST_BOB_BASE,
  GHOST_BOB_FREQ,
  GHOST_COLORS,
  GHOST_RADIUS,
  GHOST_RESPAWN,
  GHOST_SCARED_SPEED,
  GHOST_SPAWNS,
  GHOST_SPEED,
  GRID_COLS,
  GRID_ROWS,
  MAP,
  MOUTH_LERP_RATE,
  MOUTH_OPEN_ANGLE,
  MOUTH_PHI_LENGTH,
  MOUTH_PHI_START,
  MOUTH_RADIUS,
  OPPOSITE,
  PAC_RADIUS,
  PACMAN_SPAWN,
  PACMAN_STEP_SPEED,
  PELLET_RADIUS,
  PELLET_SPIN,
  POWER_PELLET_RADIUS,
  READY_MS,
  SCARED_MS,
  SCORE_GHOST,
  SCORE_PELLET,
  SCORE_POWER,
  SPAWN_GRACE_MS,
  START_LIVES,
  TURN_LEFT,
  TURN_RIGHT,
  WALL_OPACITY,
  cellKey,
  isOpen,
} from "../shared/constants";

type Phase = "title" | "ready" | "playing" | "win" | "gameover";

type Ghost = {
  x: number;
  z: number;
  dir: Dir;
  skin: number;
  group: THREE.Group;
  bob: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
};

const SWIPE_MIN_PX = 24;
const EPS = 1e-4;

export class GameScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  // ---- simulation state ------------------------------------------------------
  private phase: Phase = "title";
  private pac: {
    x: number;
    z: number;
    dir: Dir;
    isMoving: boolean;
    target: { x: number; z: number };
  } = {
    x: PACMAN_SPAWN.col,
    z: PACMAN_SPAWN.row,
    dir: "right",
    isMoving: false,
    target: { x: PACMAN_SPAWN.col, z: PACMAN_SPAWN.row },
  };
  private ghosts: Ghost[] = [];
  private pellets = new Map<string, THREE.Mesh>();
  private score = 0;
  private best = 0;
  private lives = START_LIVES;
  private scaredMs = 0;
  private graceMs = 0;
  private readyMs = 0;

  // ---- input state -------------------------------------------------------------
  private stepRequested = false;
  private prevMouthOpen = false;
  private shiftHeld = false;
  private swipeOrigin: { x: number; y: number } | null = null;
  private swiped = false;

  // ---- display objects -----------------------------------------------------------
  private pacGroup: THREE.Group;
  private mouthMesh: THREE.Mesh;
  private mouthAngle = 0;
  private mouthBuiltAngle = -1;
  private pelletGeo = new THREE.SphereGeometry(PELLET_RADIUS, 8, 8);
  private powerGeo = new THREE.SphereGeometry(POWER_PELLET_RADIUS, 8, 8);
  private pelletMat = new THREE.MeshStandardMaterial({ color: COLORS.pellet });
  private powerMat = new THREE.MeshStandardMaterial({ color: COLORS.power });

  // ---- chase camera (legacy PacmanCamera lerp state) -------------------------------
  private camInit = false;
  private camCur = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private lookCur = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();

  // ---- HUD ----------------------------------------------------------------------
  private scoreEl = el("score");
  private bestEl = el("best");
  private statsEl = el("stats");
  private bannerEl = el("banner");
  private bannerTitleEl = el("banner-title");
  private bannerSubEl = el("banner-sub");

  constructor() {
    this.scene.background = new THREE.Color(COLORS.bg);
    // r3f default camera the legacy build rendered through.
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );

    // Legacy lighting: a single ambient light, intensity 1.0.
    this.scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));

    this.buildMaze();
    this.resetBoard();

    this.pacGroup = buildPacman();
    const mouth = this.pacGroup.getObjectByName("mouth");
    if (!(mouth instanceof THREE.Mesh)) throw new Error("pacman mouth missing");
    this.mouthMesh = mouth;
    this.scene.add(this.pacGroup);

    this.ghosts = GHOST_SPAWNS.map((spawn, i) => {
      const skin = i % GHOST_COLORS.length;
      const { group, bob, bodyMat } = buildGhost(GHOST_COLORS[skin]!);
      group.position.set(spawn.col, 0, spawn.row);
      this.scene.add(group);
      return { x: spawn.col, z: spawn.row, dir: spawn.dir, skin, group, bob, bodyMat };
    });

    this.best = loadBest();
    this.bindInput();
    this.setPhase("title");
    this.updateHud();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  // ---- per-frame update ---------------------------------------------------------

  update(dt: number): void {
    const dtMs = dt * 1000;

    if (this.phase === "ready") {
      this.readyMs -= dtMs;
      if (this.readyMs <= 0) this.setPhase("playing");
    } else if (this.phase === "playing") {
      // Legacy semantics: a chomp during the step animation is dropped, not queued.
      if (this.stepRequested) {
        this.stepRequested = false;
        this.takeStep();
      }
      // Legacy quirk kept: pellet collection AND ghost contact only run on
      // movement frames — a stationary Pacman can't be caught.
      if (this.movePacman(dt)) {
        this.collectPellet();
        if (this.phase === "playing") this.checkGhostContact();
      }
      if (this.phase === "playing") {
        this.scaredMs = Math.max(0, this.scaredMs - dtMs);
        this.graceMs = Math.max(0, this.graceMs - dtMs);
        this.moveGhosts(dt);
      }
    }

    this.renderActors(dt);
    this.updateCamera();
  }

  // ---- board ---------------------------------------------------------------

  private buildMaze(): void {
    // Floor: legacy plane was offset half a cell from the maze — kept verbatim.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID_COLS, GRID_ROWS),
      new THREE.MeshStandardMaterial({ color: COLORS.floor }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(GRID_COLS / 2, -0.5, GRID_ROWS / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Walls: translucent blue 1x1x1 boxes, centers at y=0.5.
    const wallGeo = new THREE.BoxGeometry(1, 1, 1);
    const wallMat = new THREE.MeshStandardMaterial({
      color: COLORS.wall,
      transparent: true,
      opacity: WALL_OPACITY,
    });
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        if (MAP[row]![col]! !== 1) continue;
        const wall = new THREE.Mesh(wallGeo, wallMat);
        wall.position.set(col, 0.5, row);
        wall.castShadow = true;
        wall.receiveShadow = true;
        this.scene.add(wall);
      }
    }
  }

  private resetBoard(): void {
    for (const mesh of this.pellets.values()) this.scene.remove(mesh);
    this.pellets.clear();
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const cell = MAP[row]![col]!;
        if (cell !== 2 && cell !== 3) continue;
        const mesh =
          cell === 3
            ? new THREE.Mesh(this.powerGeo, this.powerMat)
            : new THREE.Mesh(this.pelletGeo, this.pelletMat);
        mesh.position.set(col, 0, row);
        this.scene.add(mesh);
        this.pellets.set(cellKey(col, row), mesh);
      }
    }
  }

  // ---- input ---------------------------------------------------------------

  private bindInput(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Shift") {
      this.shiftHeld = true;
      return;
    }
    if (this.phase === "title") {
      this.resetGame();
      return;
    }
    if (e.code === "KeyR") {
      if (this.phase === "playing" || this.phase === "win" || this.phase === "gameover") {
        this.resetGame();
      }
      return;
    }
    switch (e.code) {
      // Legacy keyboard semantics: arrows are RELATIVE to the current heading
      // and apply instantly without wall validation. ArrowUp re-sets the
      // current heading (effectively a no-op).
      case "ArrowUp":
        e.preventDefault();
        break;
      case "ArrowDown":
        e.preventDefault();
        this.steer("reverse");
        break;
      case "ArrowLeft":
        e.preventDefault();
        this.steer("left");
        break;
      case "ArrowRight":
        e.preventDefault();
        this.steer("right");
        break;
      // Keyboard fallback for the chomp (legacy couldn't move without a webcam).
      case "Space":
        e.preventDefault();
        this.stepRequested = true;
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.shiftHeld = false;
  };

  private onBlur = (): void => {
    this.shiftHeld = false;
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.swipeOrigin = { x: e.clientX, y: e.clientY };
    this.swiped = false;
  };

  // Touch fallback: horizontal swipe = relative turn, swipe up = step forward,
  // swipe down = reverse. Tap = start/restart.
  private onPointerMove = (e: PointerEvent): void => {
    if (!this.swipeOrigin || this.swiped) return;
    const dx = e.clientX - this.swipeOrigin.x;
    const dy = e.clientY - this.swipeOrigin.y;
    if (dx * dx + dy * dy < SWIPE_MIN_PX * SWIPE_MIN_PX) return;
    this.swiped = true;
    if (Math.abs(dx) > Math.abs(dy)) this.steer(dx > 0 ? "right" : "left");
    else if (dy > 0) this.steer("reverse");
    else this.stepRequested = true;
  };

  private onPointerUp = (): void => {
    const tappable = this.phase === "title" || this.phase === "win" || this.phase === "gameover";
    if (!this.swiped && this.swipeOrigin && tappable) this.resetGame();
    this.swipeOrigin = null;
  };

  /** Heading change — instant, unvalidated, relative to current facing (legacy). */
  private steer(action: "left" | "right" | "reverse"): void {
    if (this.phase !== "playing" && this.phase !== "ready") return;
    if (action === "reverse") this.pac.dir = OPPOSITE[this.pac.dir];
    else if (action === "left") this.pac.dir = TURN_LEFT[this.pac.dir];
    else this.pac.dir = TURN_RIGHT[this.pac.dir];
  }

  // ---- face-gesture entry points (wired by main.ts to FaceCamera) -------------

  /** Raw per-frame mouth state; a closed→open transition = one step (legacy). */
  onMouthChange(open: boolean): void {
    const wasOpen = this.prevMouthOpen;
    this.prevMouthOpen = open;
    if (!open || wasOpen) return;
    if (this.phase === "title" || this.phase === "win" || this.phase === "gameover") {
      this.resetGame();
      return;
    }
    this.stepRequested = true;
  }

  /** Legacy fired a synthetic ArrowLeft on head-turn-left. */
  onHeadTurnLeft(): void {
    if (this.phase === "title" || this.phase === "win" || this.phase === "gameover") {
      this.resetGame();
      return;
    }
    this.steer("left");
  }

  onHeadTurnRight(): void {
    if (this.phase === "title" || this.phase === "win" || this.phase === "gameover") {
      this.resetGame();
      return;
    }
    this.steer("right");
  }

  // ---- simulation ----------------------------------------------------------

  /** One grid step in the current heading, if the next cell is open (legacy takeStep). */
  private takeStep(): void {
    if (this.pac.isMoving) return;
    const [dx, dz] = DIR_VECT[this.pac.dir];
    const col = Math.round(this.pac.x) + dx;
    const row = Math.round(this.pac.z) + dz;
    if (!isOpen(col, row)) return;
    this.pac.target = { x: col, z: row };
    this.pac.isMoving = true;
  }

  /** Advances the step animation; returns true if this was a movement frame. */
  private movePacman(dt: number): boolean {
    const p = this.pac;
    if (!p.isMoving) return false;
    const step = PACMAN_STEP_SPEED * dt;
    const dx = p.target.x - p.x;
    const dz = p.target.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (step >= dist || dist < EPS) {
      p.x = p.target.x;
      p.z = p.target.z;
      p.isMoving = false;
    } else {
      p.x += (dx / dist) * step;
      p.z += (dz / dist) * step;
    }
    return true;
  }

  private collectPellet(): void {
    const col = Math.round(this.pac.x);
    const row = Math.round(this.pac.z);
    const mesh = this.pellets.get(cellKey(col, row));
    if (!mesh) return;
    this.scene.remove(mesh);
    this.pellets.delete(cellKey(col, row));
    const isPower = MAP[row]![col]! === 3;
    this.addScore(isPower ? SCORE_POWER : SCORE_PELLET);
    if (isPower) {
      // A second power pellet RESETS the clock (the legacy timer didn't —
      // a flagged bug; kept fixed per the rebuild).
      this.scaredMs = SCARED_MS;
    }
    this.updateHud();
    if (this.pellets.size === 0) this.setPhase("win");
  }

  private moveGhosts(dt: number): void {
    for (const g of this.ghosts) {
      const speed = this.scaredMs > 0 ? GHOST_SCARED_SPEED : GHOST_SPEED;
      stepGhost(g, speed * dt, (col, row) =>
        // Legacy snapped Pacman to his grid cell before the chase compare.
        chooseGhostDir(
          col,
          row,
          g.dir,
          this.scaredMs > 0,
          Math.round(this.pac.x),
          Math.round(this.pac.z),
        ),
      );
    }
  }

  /** Ghost contact = grid-cell equality after snapping both positions (legacy). */
  private checkGhostContact(): void {
    const pc = Math.round(this.pac.x);
    const pr = Math.round(this.pac.z);
    for (const g of this.ghosts) {
      if (Math.round(g.x) !== pc || Math.round(g.z) !== pr) continue;
      if (this.scaredMs > 0) {
        this.eatGhost(g);
      } else if (this.graceMs <= 0) {
        this.caught();
        return;
      }
    }
  }

  /** Eaten scared ghost: +200, respawn at center, heading kept (legacy). */
  private eatGhost(g: Ghost): void {
    this.addScore(SCORE_GHOST);
    g.x = GHOST_RESPAWN.col;
    g.z = GHOST_RESPAWN.row;
  }

  /**
   * Caught by a normal ghost: Pacman resets to (1,1) facing right, score kept,
   * ghosts keep roaming where they are (legacy). Lives + game over are the
   * rebuild's additions, kept.
   */
  private caught(): void {
    this.lives -= 1;
    this.updateHud();
    if (this.lives <= 0) {
      this.setPhase("gameover");
      return;
    }
    this.resetPacman();
    this.graceMs = SPAWN_GRACE_MS;
    this.beginReady();
  }

  // ---- round lifecycle -------------------------------------------------------

  private resetPacman(): void {
    this.pac.x = PACMAN_SPAWN.col;
    this.pac.z = PACMAN_SPAWN.row;
    this.pac.dir = "right";
    this.pac.isMoving = false;
    this.pac.target = { x: PACMAN_SPAWN.col, z: PACMAN_SPAWN.row };
    this.stepRequested = false;
    this.mouthAngle = 0;
  }

  private resetGame(): void {
    this.score = 0;
    this.lives = START_LIVES;
    this.scaredMs = 0;
    this.graceMs = 0;
    this.resetBoard();
    this.resetPacman();
    this.ghosts.forEach((g, i) => {
      const spawn = GHOST_SPAWNS[i % GHOST_SPAWNS.length]!;
      g.x = spawn.col;
      g.z = spawn.row;
      g.dir = spawn.dir;
    });
    this.updateHud();
    this.beginReady();
  }

  private beginReady(): void {
    this.readyMs = READY_MS;
    this.setPhase("ready");
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    const texts: Record<Phase, readonly [string, string]> = {
      title: [
        "PAC-MAN",
        "open mouth (or SPACE) to step · turn head (or ←/→) to turn · ↓ reverse · hold SHIFT selfie cam · any key or tap to start",
      ],
      ready: ["READY!", ""],
      playing: ["", ""],
      win: ["YOU WIN!", "chomp, press R, or tap to play again"],
      gameover: ["GAME OVER", "chomp, press R, or tap to play again"],
    };
    const [title, sub] = texts[phase];
    this.bannerTitleEl.textContent = title;
    this.bannerSubEl.textContent = sub;
    this.bannerEl.style.opacity = title === "" ? "0" : "1";
  }

  // ---- rendering ---------------------------------------------------------------

  private renderActors(dt: number): void {
    // Pacman: position + legacy orientation (rotation reset, then one axis).
    const g = this.pacGroup;
    g.position.set(this.pac.x, 0, this.pac.z);
    g.rotation.set(0, 0, 0);
    if (this.pac.dir === "up") g.rotation.x = -Math.PI / 2;
    else if (this.pac.dir === "down") g.rotation.x = Math.PI / 2;
    else if (this.pac.dir === "left") g.rotation.y = Math.PI;
    // right is the default orientation

    // Mouth wedge: lerp toward PI/4 while moving (legacy rate delta*10), and
    // hard-shut when stopped (legacy passed thetaLength 0 while idle).
    const target = this.pac.isMoving ? MOUTH_OPEN_ANGLE : 0;
    this.mouthAngle += (target - this.mouthAngle) * Math.min(dt * MOUTH_LERP_RATE, 1);
    this.syncMouth(this.pac.isMoving ? this.mouthAngle : 0);

    // Ghosts: bob in unison (legacy used one shared Date.now() phase) and
    // turn gray while scared.
    const bobY = Math.sin(Date.now() * GHOST_BOB_FREQ) * GHOST_BOB_AMP + GHOST_BOB_BASE;
    const scared = this.scaredMs > 0;
    for (const ghost of this.ghosts) {
      ghost.group.position.set(ghost.x, 0, ghost.z);
      ghost.bob.position.y = bobY;
      ghost.bodyMat.color.setHex(scared ? COLORS.scared : GHOST_COLORS[ghost.skin]!);
    }

    // Pellets spin in place (legacy 0.01 rad per frame).
    for (const mesh of this.pellets.values()) mesh.rotation.y += PELLET_SPIN;
  }

  private syncMouth(angle: number): void {
    this.mouthMesh.visible = angle > 0.002;
    if (!this.mouthMesh.visible) return;
    if (Math.abs(angle - this.mouthBuiltAngle) < 0.004) return;
    this.mouthMesh.geometry.dispose();
    this.mouthMesh.geometry = new THREE.SphereGeometry(
      MOUTH_RADIUS,
      32,
      32,
      MOUTH_PHI_START,
      MOUTH_PHI_LENGTH,
      0,
      angle,
    );
    this.mouthBuiltAngle = angle;
  }

  /**
   * Chase camera (legacy PacmanCamera): behind Pacman at -facing*2.5, y=2,
   * looking at pos+facing*2; while SHIFT is held, flip to the front at
   * +facing*2.5 looking back at pos-facing. Both position and look-at lerp
   * at 0.1 per frame, initialized to their targets on the first frame.
   */
  private updateCamera(): void {
    const [dx, dz] = DIR_VECT[this.pac.dir];
    const back = this.shiftHeld ? CAM_BACK : -CAM_BACK;
    this.camTarget.set(this.pac.x + dx * back, CAM_HEIGHT, this.pac.z + dz * back);
    const ahead = this.shiftHeld ? -CAM_SELFIE_LOOK_BACK : CAM_LOOK_AHEAD;
    this.lookTarget.set(this.pac.x + dx * ahead, 0, this.pac.z + dz * ahead);

    if (!this.camInit) {
      this.camCur.copy(this.camTarget);
      this.lookCur.copy(this.lookTarget);
      this.camInit = true;
    }
    this.camCur.lerp(this.camTarget, CAMERA_SMOOTHING);
    this.lookCur.lerp(this.lookTarget, CAMERA_SMOOTHING);
    this.camera.position.copy(this.camCur);
    this.camera.lookAt(this.lookCur);
  }

  // ---- hud -----------------------------------------------------------------

  private addScore(n: number): void {
    this.score += n;
    if (this.score > this.best) {
      this.best = this.score;
      saveBest(this.best);
    }
    this.updateHud();
  }

  private updateHud(): void {
    this.scoreEl.textContent = `SCORE ${this.score}`;
    this.bestEl.textContent = `BEST ${this.best}`;
    const hearts = this.lives > 0 ? "♥".repeat(this.lives) : "×";
    this.statsEl.textContent = `${hearts}  ·  ${this.pellets.size} left`;
  }
}

// ---- pure helpers ---------------------------------------------------------------

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

/** Yellow sphere with the animated black mouth wedge (legacy PacMan component). */
function buildPacman(): THREE.Group {
  const group = new THREE.Group();
  group.name = "pacman";
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(PAC_RADIUS, 32, 32),
    new THREE.MeshStandardMaterial({ color: COLORS.pacman }),
  );
  group.add(body);
  const mouth = new THREE.Mesh(
    new THREE.SphereGeometry(MOUTH_RADIUS, 32, 32, MOUTH_PHI_START, MOUTH_PHI_LENGTH, 0, 0.001),
    new THREE.MeshStandardMaterial({ color: COLORS.mouth, side: THREE.BackSide }),
  );
  mouth.name = "mouth";
  mouth.visible = false;
  group.add(mouth);
  return group;
}

/**
 * Ghost: sphere body (legacy args verbatim) + white eyes with black pupils
 * facing -z; the inner "bob" group floats at y = sin(t)*0.1 + 0.5.
 */
function buildGhost(color: number): {
  group: THREE.Group;
  bob: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
} {
  const group = new THREE.Group();
  const bob = new THREE.Group();
  group.add(bob);

  const bodyMat = new THREE.MeshStandardMaterial({ color });
  bob.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(GHOST_RADIUS, 32, 16, 0, Math.PI * 2, 0, Math.PI),
      bodyMat,
    ),
  );

  for (const side of [1, -1]) {
    const eye = new THREE.Group();
    eye.position.set(0.2 * side, 0.1, -0.3);
    eye.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 16, 16),
        new THREE.MeshStandardMaterial({ color: COLORS.eye }),
      ),
    );
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 16, 16),
      new THREE.MeshStandardMaterial({ color: COLORS.pupil }),
    );
    pupil.position.set(0, 0, -0.08);
    eye.add(pupil);
    bob.add(eye);
  }

  return { group, bob, bodyMat };
}

/**
 * Advance a ghost `dist` cells along its dir, re-deciding at every grid
 * center via `decide` (null = stop). Movement is broken at cell boundaries so
 * decisions land exactly on centers; no wraparound (out-of-bounds is wall).
 */
function stepGhost(
  g: { x: number; z: number; dir: Dir },
  dist: number,
  decide: (col: number, row: number) => Dir | null,
): void {
  let guard = 16;
  while (dist > EPS && guard-- > 0) {
    const col = Math.round(g.x);
    const row = Math.round(g.z);
    if (Math.abs(g.x - col) < EPS && Math.abs(g.z - row) < EPS) {
      g.x = col;
      g.z = row;
      const next = decide(col, row);
      if (next === null) break;
      g.dir = next;
    }
    const [dx, dz] = DIR_VECT[g.dir];
    let step: number;
    if (dx !== 0) {
      const target = dx > 0 ? Math.floor(g.x + EPS) + 1 : Math.ceil(g.x - EPS) - 1;
      step = Math.min(dist, Math.abs(target - g.x));
      g.x += dx * step;
    } else {
      const target = dz > 0 ? Math.floor(g.z + EPS) + 1 : Math.ceil(g.z - EPS) - 1;
      step = Math.min(dist, Math.abs(target - g.z));
      g.z += dz * step;
    }
    dist -= step;
  }
}

/**
 * Ghost AI, evaluated at each grid center (legacy moveGhostsOnGrid): never
 * reverse unless dead-ended; scared = uniform random; otherwise 70% greedy
 * (random among strictly distance-reducing options, falling back to random)
 * / 30% pure random.
 */
function chooseGhostDir(
  col: number,
  row: number,
  dir: Dir,
  scared: boolean,
  pacX: number,
  pacZ: number,
): Dir | null {
  const open = DIRS.filter((d) => {
    const [dx, dz] = DIR_VECT[d];
    return isOpen(col + dx, row + dz);
  });
  if (open.length === 0) return null;
  const ahead = open.filter((d) => d !== OPPOSITE[dir]);
  const options = ahead.length > 0 ? ahead : open;
  if (scared) return pick(options);
  if (Math.random() < CHASE_CHANCE) {
    const here = (col - pacX) ** 2 + (row - pacZ) ** 2;
    const closer = options.filter((d) => {
      const [dx, dz] = DIR_VECT[d];
      return (col + dx - pacX) ** 2 + (row + dz - pacZ) ** 2 < here;
    });
    if (closer.length > 0) return pick(closer);
  }
  return pick(options);
}

function pick<T>(arr: ReadonlyArray<T>): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function loadBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveBest(best: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {
    // storage unavailable (private mode) — best just won't persist
  }
}
