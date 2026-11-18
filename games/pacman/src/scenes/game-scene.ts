import * as THREE from "three";
import { createTouchControls, notifyGameStarted, watchControlContext } from "@repo/embed";
import { PhysicalGamepad, stickDirection4 } from "@vibedgames/gamepad";
import type { Dir4 } from "@vibedgames/gamepad";
import { FixedRate } from "@vibedgames/multiplayer";
import type { ClaimMap, JsonValue } from "@vibedgames/multiplayer";
import { isPlaytestRequested } from "@vibedgames/playtest";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { music } from "../audio/music";
import { sfx, toggleSound, unlockAudio } from "../audio/sfx";
import { restartHint } from "../controls";
import { IS_TOUCH } from "../input/input-mode";
import { buildControls, ensureStyle as ensureControlsStyle } from "../pause-overlay";
import { FxPool, REDUCED_MOTION } from "../render/fx-pool";
import { buildHeartGeometry } from "../render/heart";
import type { PelletCell } from "../render/pellet-field";
import { PelletField } from "../render/pellet-field";
import { PowerHalo } from "../render/power-halo";
import { TraumaCamera } from "../render/trauma-camera";
import { readPacSample } from "../net/pac-track";
import { PELLET_CLAIM_PREFIX, PelletClaims } from "../net/pellet-claims";
import type { LostEat } from "../net/pellet-claims";
import { RemotePacs } from "../net/remote-pacs";
import { isJsonNumber, isJsonObject, joinRoom } from "../net/session";
import type { Dir } from "../shared/constants";
import { fleeStep, flood, navTo, nearestCell, openDirs } from "../shared/maze-nav";
import type { Cell, NavTarget } from "../shared/maze-nav";
import {
  MP_ROOM,
  MP_MAX_PLAYERS,
  OFFLINE_FALLBACK_MS,
  PAC_LIMITS,
  NET_TICK_HZ,
  BASE_FOV,
  BEST_KEY,
  CAM_BACK,
  CLAIM_RETRY_MS,
  CATCH_DIST,
  CAM_HEIGHT,
  CAM_LOOK_AHEAD,
  CAM_SELFIE_LOOK_BACK,
  CAMERA_FOLLOW_RATE,
  CHASE_CHANCE,
  CHOMP_BUFFER_S,
  COLORS,
  DIR_VECT,
  DIRS,
  EAT_DIST,
  FLOOR_Y,
  FOG_FAR,
  FOG_NEAR,
  FOV_KICK_DECAY,
  FOV_KICK_POWER,
  GHOST_BOB_AMP,
  GHOST_BOB_BASE,
  GHOST_BOB_FREQ,
  GHOST_BOB_STAGGER,
  GHOST_COLORS,
  GHOST_RESPAWN,
  GHOST_SCARED_SCALE,
  GHOST_SCARED_SPEED,
  GHOST_SPAWNS,
  GHOST_SPEED,
  GHOST_TREMBLE_AMP,
  GHOST_TREMBLE_FREQ,
  GHOST_YAW_RATE,
  GRID_COLS,
  GRID_ROWS,
  HEART_PULSE_AMP,
  HEART_PULSE_FREQ,
  HEART_Y,
  HEMI_GROUND,
  HEMI_INTENSITY,
  HEMI_SKY,
  KEY_COLOR,
  KEY_INTENSITY,
  MAP,
  MOUTH_ANGLE_QUANT,
  MOUTH_LERP_RATE,
  MOUTH_OPEN_ANGLE,
  MOUTH_PHI_LENGTH,
  MOUTH_PHI_START,
  MOUTH_RADIUS,
  OPPOSITE,
  PAC_RADIUS,
  PACMAN_SPAWN,
  PACMAN_STEP_SPEED,
  PELLET_BOB_FREQ,
  POWER_PELLET_RADIUS,
  READY_MS,
  SCARED_BLINK_INTERVAL_MS,
  SCARED_MS,
  SCARED_WARN_MS,
  SCORE_GHOST,
  SCORE_PELLET,
  SCORE_POWER,
  SPAWN_GRACE_MS,
  SQUASH_RECOVER_RATE,
  START_LIVES,
  STEP_SQUASH,
  STEP_STRETCH,
  TITLE_ORBIT_HEIGHT,
  TITLE_ORBIT_RADIUS,
  TITLE_ORBIT_SPEED,
  TRAUMA_CAUGHT,
  TRAUMA_GHOST_EATEN,
  TRAUMA_POWER,
  TURN_LEFT,
  TURN_RIGHT,
  WALL_OPACITY,
  WALL_TINT_WOBBLE,
  cellKey,
  isOpen,
} from "../shared/constants";

type Phase = "title" | "ready" | "playing" | "win" | "gameover";

interface PacBody {
  x: number;
  z: number;
  dir: Dir;
  isMoving: boolean;
  target: { x: number; z: number };
}

interface Ghost {
  x: number;
  z: number;
  dir: Dir;
  color: number;
  group: THREE.Group;
  bob: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  worry: THREE.Mesh;
  yaw: number;
  spawnScale: number;
  scale: number;
}

interface Heart {
  mesh: THREE.Mesh;
  phase: number;
}

interface EatUndo {
  points: number;
  scaredBefore: number | null;
}

const COMBO_SCALE: readonly number[] = [0, 2, 4, 7, 9, 12, 14, 16, 19];
const COMBO_WINDOW_S = 0.9;

const SWIPE_MIN_PX = 24;
const EPS = 1e-4;
const ROOM = (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || MP_ROOM;
const CAPTURE_ECHO_S = 0.28;
const REAPPEAR_S = 0.24;
const RESULT_REVEAL_S = 0.16;
const SYSTEM_KEYS = new Set(["Tab", "Control", "Alt", "Meta", "Escape"]);
const MAX_FOV = 110;

const TOUCH_CONTROLS_CSS = `
.vg-touch-controls.pac-touch {
  top: calc(env(safe-area-inset-top, 0px) + 62px);
  --vg-touch-bg: rgba(255, 255, 255, 0.78);
  --vg-touch-bg-active: rgba(245, 185, 66, 0.85);
  --vg-touch-fg: #6b5e66;
  --vg-touch-border: 1.5px solid rgba(242, 126, 157, 0.25);
  --vg-touch-radius: 999px;
  --vg-touch-glyph-size: 20px;
}
.vg-touch-controls.pac-touch button {
  box-shadow: 0 6px 20px rgba(212, 150, 167, 0.25);
}
`;

/** What a sighted player reads off the maze, from the player's cell. */
export interface MazeNav {
  open: Record<Dir, boolean>;
  pellet: NavTarget | null;
  power: NavTarget | null;
  /** Nearest two ghosts by path length. */
  ghosts: (NavTarget & { frightened: boolean })[];
  /** First step towards the nearest pickup the ghosts cannot cut off, else away from them. */
  fleeStep: Dir | null;
}

export interface GameDiagnostics {
  score: number;
  complete: boolean;
  phase: Phase;
  player: { x: number; y: number };
  entities: number;
  powerMs: number;
  facing: Dir;
  moving: boolean;
  lives: number;
  pelletsLeft: number;
  /** Spawn grace: ghosts cannot catch the player yet. */
  invulnerable: boolean;
  /** Null unless a playtest asked for it — two maze floods a frame. */
  nav: MazeNav | null;
}

/* oxlint-disable no-bitwise -- mulberry32 is int32 hash arithmetic */
const seededRandom = (seed: number) => {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
/* oxlint-enable no-bitwise */

const el = (id: string) => {
  const node = document.querySelector(`#${id}`);

  if (!(node instanceof HTMLElement)) {
    throw new TypeError(`missing #${id}`);
  }

  return node;
};

const fovForAspect = (aspect: number) => {
  if (aspect >= 1) {
    return BASE_FOV;
  }

  const vertical = (Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / aspect) * 360) / Math.PI;

  return Math.min(MAX_FOV, vertical);
};

const buildPacman = () => {
  const group = new THREE.Group();
  group.name = "pacman";

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(PAC_RADIUS, 32, 32),
    new THREE.MeshStandardMaterial({ color: COLORS.pacman, roughness: 0.5 }),
  );

  body.castShadow = true;
  group.add(body);

  const mouth = new THREE.Mesh(
    new THREE.SphereGeometry(MOUTH_RADIUS, 32, 32, MOUTH_PHI_START, MOUTH_PHI_LENGTH, 0, 0.001),
    new THREE.MeshStandardMaterial({ color: COLORS.mouth, side: THREE.BackSide }),
  );

  mouth.name = "mouth";
  mouth.visible = false;
  group.add(mouth);

  const eyeMat = new THREE.MeshStandardMaterial({ color: COLORS.eye, roughness: 0.3 });

  for (const side of [1, -1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), eyeMat);
    eye.position.set(0.39, 0.2, 0.175 * side);
    group.add(eye);
  }

  const blushMat = new THREE.MeshStandardMaterial({ color: COLORS.blush, roughness: 0.8 });

  for (const side of [1, -1]) {
    const blush = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), blushMat);
    blush.position.set(0.34, 0.02, 0.34 * side);
    blush.scale.set(0.4, 0.7, 1);
    group.add(blush);
  }

  return group;
};

const buildGhost = (color: number) => {
  const group = new THREE.Group();
  const bob = new THREE.Group();
  group.add(bob);

  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.24, 6, 20), bodyMat);
  body.castShadow = true;
  bob.add(body);

  const darkMat = new THREE.MeshStandardMaterial({ color: COLORS.eye, roughness: 0.3 });

  for (const side of [1, -1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), darkMat);
    eye.position.set(0.13 * side, 0.1, -0.3);
    bob.add(eye);
  }

  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 8), darkMat);
  line.rotation.z = Math.PI / 2;
  line.position.set(0, 0.1, -0.345);
  bob.add(line);

  const blushMat = new THREE.MeshStandardMaterial({ color: COLORS.blush, roughness: 0.8 });

  for (const side of [1, -1]) {
    const blush = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), blushMat);
    blush.position.set(0.23 * side, -0.05, -0.245);
    blush.scale.set(1, 0.6, 0.4);
    bob.add(blush);
  }

  const worry = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.013, 8, 16), darkMat);
  worry.position.set(0, -0.06, -0.33);
  worry.visible = false;
  bob.add(worry);

  return { bob, bodyMat, group, worry };
};

const dirYaw = (dir: Dir) => {
  switch (dir) {
    case "up": {
      return 0;
    }

    case "down": {
      return Math.PI;
    }

    case "left": {
      return Math.PI / 2;
    }

    case "right": {
      return -Math.PI / 2;
    }
  }
};

const lerpAngle = (from: number, to: number, k: number) => {
  let delta = (to - from) % (Math.PI * 2);

  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  }

  if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }

  return from + delta * k;
};

const hash2 = (col: number, row: number) => {
  const n = Math.sin(col * 127.1 + row * 311.7) * 43_758.5453;

  return n - Math.floor(n);
};

const mapCells = (type: number) => {
  const cells: { col: number; row: number }[] = [];

  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      if (MAP[row]?.[col] === type) {
        cells.push({ col, row });
      }
    }
  }

  return cells;
};

const retrigger = (node: HTMLElement, cls: string) => {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
};

const hexCss = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

const polkaDotTexture = () => {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  if (ctx) {
    ctx.fillStyle = hexCss(COLORS.floor);
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = hexCss(COLORS.floorDot);
    const r = 11;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    ctx.fill();

    for (const [cx, cy] of [
      [0, 0],
      [size, 0],
      [0, size],
      [size, size],
    ] as const) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  return tex;
};

const stepGhost = (
  g: { x: number; z: number; dir: Dir },
  distance: number,
  decide: (col: number, row: number) => Dir | null,
) => {
  let dist = distance;
  let guard = 16;

  while (dist > EPS && guard > 0) {
    guard -= 1;
    const col = Math.round(g.x);
    const row = Math.round(g.z);

    if (Math.abs(g.x - col) < EPS && Math.abs(g.z - row) < EPS) {
      g.x = col;
      g.z = row;
      const next = decide(col, row);

      if (next === null) {
        break;
      }

      g.dir = next;
    }

    const [dx, dz] = DIR_VECT[g.dir];
    let step: number;

    if (dx === 0) {
      const target = dz > 0 ? Math.floor(g.z + EPS) + 1 : Math.ceil(g.z - EPS) - 1;
      step = Math.min(dist, Math.abs(target - g.z));
      g.z += dz * step;
    } else {
      const target = dx > 0 ? Math.floor(g.x + EPS) + 1 : Math.ceil(g.x - EPS) - 1;
      step = Math.min(dist, Math.abs(target - g.x));
      g.x += dx * step;
    }

    dist -= step;
  }
};

const pick = <T>(arr: readonly T[], random: () => number) => arr[Math.floor(random() * arr.length)];

const chooseGhostDir = (
  col: number,
  row: number,
  dir: Dir,
  scared: boolean,
  pacX: number,
  pacZ: number,
  random: () => number,
) => {
  const open = DIRS.filter((d) => {
    const [dx, dz] = DIR_VECT[d];

    return isOpen(col + dx, row + dz);
  });

  if (open.length === 0) {
    return null;
  }

  const ahead = open.filter((d) => d !== OPPOSITE[dir]);
  const options = ahead.length > 0 ? ahead : open;

  if (scared) {
    return pick(options, random) ?? null;
  }

  if (random() < CHASE_CHANCE) {
    const here = (col - pacX) ** 2 + (row - pacZ) ** 2;

    const closer = options.filter((d) => {
      const [dx, dz] = DIR_VECT[d];

      return (col + dx - pacX) ** 2 + (row + dz - pacZ) ** 2 < here;
    });

    if (closer.length > 0) {
      return pick(closer, random) ?? null;
    }
  }

  return pick(options, random) ?? null;
};

const loadBest = () => {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const n = raw === null ? 0 : Math.trunc(Number(raw));

    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
};

const saveBest = (best: number) => {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {}
};

const scaredTint = (scared: boolean, blinkOut: boolean, own: number) => {
  if (!scared) {
    return own;
  }

  return blinkOut ? COLORS.scaredBlink : COLORS.scared;
};

export class GameScene {
  private paused = false;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private phase: Phase = "title";
  private pac: PacBody = {
    dir: "right",
    isMoving: false,
    target: { x: PACMAN_SPAWN.col, z: PACMAN_SPAWN.row },
    x: PACMAN_SPAWN.col,
    z: PACMAN_SPAWN.row,
  };
  private ghosts: Ghost[] = [];
  private random: () => number = Math.random;
  private navDiagnostics = false;
  private pelletField: PelletField;
  private hearts = new Map<string, Heart>();
  private score = 0;
  private best = 0;
  private ghostsChomped = 0;

  private readonly net = joinRoom({
    fallbackMs: OFFLINE_FALLBACK_MS,
    limits: PAC_LIMITS,
    maxPlayers: MP_MAX_PLAYERS,
    offline: isPlaytestRequested(),
    onEvent: (event, payload, from) => this.handleNetEvent(event, payload, from),
    room: ROOM,
  });
  private remotePacs: RemotePacs;
  private ownDrop = false;
  private rivalIds: string[] = [];
  private readonly netRate = new FixedRate(NET_TICK_HZ);
  private spawnCount = 0;
  private boardRound = 0;
  private boardSig = "";
  private appliedEaten = new Set<string>();
  private pellets = new PelletClaims<EatUndo>();
  private claimsSeen: ClaimMap | null = null;
  private boardStale = true;
  private scaredBy: string | null = null;
  private netInfoText = "";
  private boardEl = el("board");
  private netInfoEl = el("netinfo");
  private lives = START_LIVES;
  private scaredMs = 0;
  private graceMs = 0;
  private readyMs = 0;

  private chompQueued = 0;
  private prevMouthOpen = false;
  private shiftHeld = false;
  private selfieOn = false;
  private swipeOrigin: { x: number; y: number } | null = null;
  private swiped = false;
  private readonly pad = new PhysicalGamepad();
  private padStickDir: Dir4 | null = null;
  private unwatchControls: (() => void) | null = null;
  private pacRig = new THREE.Group();
  private pacGroup: THREE.Group;
  private captureEcho: THREE.Group;
  private captureAge = CAPTURE_ECHO_S;
  private reappearAge = REAPPEAR_S;
  private resultAge = 0;
  private mouthMesh: THREE.Mesh;
  private mouthAngle = 0;
  private mouthBuiltBucket = -1;
  private mouthGeoCache = new Map<number, THREE.SphereGeometry>();
  private heartGeo = buildHeartGeometry(POWER_PELLET_RADIUS * 1.85);
  private powerMat = new THREE.MeshStandardMaterial({
    color: COLORS.power,
    emissive: COLORS.heartGlow,
    emissiveIntensity: 0.4,
    roughness: 0.5,
  });

  private fx: FxPool;
  private powerHalo: PowerHalo;
  private shaker = new TraumaCamera();
  private t = 0;
  private fovKick = 0;
  private baseFov = BASE_FOV;
  private squashKick = 0;
  private stretchAmt = 0;
  private comboIdx = 0;
  private lastPelletAt = -Infinity;
  private lastTurnTickAt = -Infinity;
  private prevScared = false;
  private winConfettiIn = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  private camInit = false;
  private camCur = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private lookCur = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();

  private scoreEl = el("score");
  private bestEl = el("best");
  private statsEl = el("stats");
  private chainEl = el("chain");
  private chainText = "";
  private bannerEl = el("banner");
  private bannerTitleEl = el("banner-title");
  private bannerSubEl = el("banner-sub");
  private bannerControlsEl = el("banner-controls");
  private flashEl = el("flash");
  private selfieBtnEl = el("btn-selfie");
  private restartBtnEl = el("btn-restart");
  private teachingEl = el("teaching");
  private teachingNoteEl = el("teaching-note");
  private teachingStepEl = el("teaching-step");
  private teachingTurnEl = el("teaching-turn");
  private taughtStep = false;
  private taughtTurn = false;
  private teachingDoneAt = -1;
  private teachingBlockedUntil = -1;
  private teachingShown = "";
  private resultEl = el("result");
  private resultModeEl = el("result-mode");
  private resultScoreEl = el("result-score");
  private resultBestEl = el("result-best");
  private resultGhostsEl = el("result-ghosts");
  private resultLeftEl = el("result-left");

  constructor() {
    createTouchControls({
      className: "pac-touch",
      css: TOUCH_CONTROLS_CSS,
      styleId: "pacman-touch-controls-style",
    });
    this.scene.background = new THREE.Color(COLORS.bg);
    this.scene.fog = new THREE.Fog(COLORS.bg, FOG_NEAR, FOG_FAR);
    const aspect = window.innerWidth / window.innerHeight;
    this.baseFov = fovForAspect(aspect);
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.1, 1000);

    this.buildLights();
    this.buildMaze();
    this.pelletField = new PelletField(this.scene, mapCells(2).length);
    this.resetBoard();

    this.pacGroup = buildPacman();
    const mouth = this.pacGroup.getObjectByName("mouth");

    if (!(mouth instanceof THREE.Mesh)) {
      throw new TypeError("pacman mouth missing");
    }

    this.mouthMesh = mouth;
    this.pacRig.add(this.pacGroup);
    this.scene.add(this.pacRig);
    this.captureEcho = this.pacGroup.clone();
    this.captureEcho.name = "capture-echo";
    this.captureEcho.visible = false;
    this.scene.add(this.captureEcho);

    this.ghosts = GHOST_SPAWNS.map((spawn, i) => {
      const color = GHOST_COLORS[i % GHOST_COLORS.length] ?? COLORS.power;
      const { group, bob, bodyMat, worry } = buildGhost(color);
      group.position.set(spawn.col, 0, spawn.row);
      this.scene.add(group);

      return {
        bob,
        bodyMat,
        color,
        dir: spawn.dir,
        group,
        scale: 1,
        spawnScale: 1,
        worry,
        x: spawn.col,
        yaw: dirYaw(spawn.dir),
        z: spawn.row,
      };
    });

    this.fx = new FxPool(this.scene);
    this.powerHalo = new PowerHalo(this.scene);
    this.remotePacs = new RemotePacs(this.scene);
    this.net.subscribe(() => this.watchOwnConnection());
    this.best = loadBest();
    this.bindInput();
    this.setPhase("title");
    this.updateHud();
  }

  private get racing() {
    return this.rivalIds.length > 0;
  }

  private get inRound() {
    return this.phase === "ready" || this.phase === "playing" || this.phase === "win";
  }

  private get netLive() {
    const status = this.net.connectionStatus;

    return status === "connected" || status === "offline";
  }

  private presentRivals() {
    const me = this.net.playerId;

    return Object.entries(this.net.players)
      .filter(([id, p]) => id !== me && p.connected !== false && readPacSample(p.state) !== null)
      .map(([id]) => id);
  }

  private watchOwnConnection() {
    const status = this.net.connectionStatus;

    if (status === "reconnecting") {
      this.ownDrop = true;
    } else if (status === "connected" && this.ownDrop) {
      this.ownDrop = false;
      this.remotePacs.relearn();
    }
  }

  private handleNetEvent(event: string, payload: JsonValue, from: string) {
    const p = isJsonObject(payload) ? payload : {};

    if (p["round"] !== this.boardRound) {
      return;
    }

    if (event === "restart" && this.net.isHost && this.onlyOneInRound(from)) {
      this.hostNewRound();
    }
  }

  private onlyOneInRound(id: string) {
    return !this.inRound && this.rivalIds.every((rival) => rival === id);
  }

  private static parseCellKey(key: string) {
    const parts = key.split(",");

    if (parts.length !== 2) {
      return null;
    }

    const col = Number(parts[0]);
    const row = Number(parts[1]);

    if (!Number.isInteger(col) || !Number.isInteger(row)) {
      return null;
    }

    if (col < 0 || row < 0 || col >= GRID_COLS || row >= GRID_ROWS) {
      return null;
    }

    return { col, row };
  }

  private claimEat(cell: string, undo: EatUndo) {
    this.appliedEaten.add(cell);
    const key = this.pellets.eat(this.boardRound, cell, undo, performance.now());

    if (key !== null) {
      this.net.claim(key);
    }
  }

  private loseEat({ cell, undo }: LostEat<EatUndo>) {
    this.addScore(-undo.points);

    if (undo.scaredBefore !== null && this.scaredBy === cell) {
      this.scaredMs = Math.max(0, undo.scaredBefore - (SCARED_MS - this.scaredMs));
      this.scaredBy = null;
    }
  }

  private reconcileBoard() {
    const round = this.readSharedRound();

    if (round !== null && round !== this.boardRound) {
      this.applyNewRound(round);
    }

    const { claims } = this.net;

    if (claims !== this.claimsSeen || this.boardStale) {
      this.claimsSeen = claims;
      this.boardStale = false;

      for (const lost of this.pellets.settle(claims, this.net.playerId)) {
        this.loseEat(lost);
      }

      if (this.showEaten(this.pellets.eaten(claims, this.boardRound))) {
        this.updateHud();
      }
    }

    if (this.netLive) {
      for (const key of this.pellets.overdue(performance.now(), CLAIM_RETRY_MS)) {
        this.net.claim(key);
      }
    }

    this.checkRaceWin();
  }

  private showEaten(eaten: ReadonlySet<string>) {
    let rebuilt = false;

    for (const cell of this.appliedEaten) {
      if (!eaten.has(cell)) {
        this.resetBoard();
        this.appliedEaten.clear();
        rebuilt = true;
        break;
      }
    }

    return this.applyEaten(eaten) || rebuilt;
  }

  private applyEaten(cells: Iterable<string>) {
    let removed = false;

    for (const cell of cells) {
      if (!this.appliedEaten.has(cell)) {
        this.appliedEaten.add(cell);
        this.removeCellVisual(cell);
        removed = true;
      }
    }

    return removed;
  }

  private checkRaceWin() {
    if (this.racing && this.phase === "playing" && this.pelletsLeft() === 0) {
      this.setPhase("win");
    }
  }

  private readSharedRound() {
    const { round } = this.net.sharedState;

    return isJsonNumber(round) ? round : null;
  }

  private removeCellVisual(key: string) {
    const heart = this.hearts.get(key);

    if (heart) {
      this.scene.remove(heart.mesh);
      this.hearts.delete(key);

      return;
    }

    const cell = GameScene.parseCellKey(key);

    if (cell) {
      this.pelletField.collect(cell.col, cell.row);
    }
  }

  private hostFreshMaze() {
    const round = this.boardRound + 1;
    this.net.clearClaims(PELLET_CLAIM_PREFIX);
    this.net.updateSharedState({ round });

    return round;
  }

  private hostNewRound() {
    this.applyNewRound(this.hostFreshMaze());
  }

  private resetMaze(round: number) {
    this.boardRound = round;
    this.pellets.clear();
    this.appliedEaten.clear();
    this.boardStale = true;
    this.resetBoard();
  }

  private applyNewRound(round: number) {
    this.resetMaze(round);

    if (this.inRound) {
      this.resetScore();
      this.resetRound();
      this.resetPacman();
      this.graceMs = SPAWN_GRACE_MS;

      if (this.phase === "win") {
        this.setPhase("playing");
      }
    }

    this.updateHud();
  }

  private resetScore() {
    this.score = 0;
    this.pellets.forgive();
  }

  private handleStart() {
    if (this.paused) {
      return;
    }

    if (this.racing) {
      if (this.phase === "win") {
        if (this.net.isHost) {
          this.hostNewRound();
        }

        return;
      }

      if (!this.inRound) {
        this.resetScore();
        this.resetRound();
        this.updateHud();
      }

      this.resetPacman();
      this.graceMs = SPAWN_GRACE_MS;
      this.setPhase("playing");

      return;
    }

    this.resetGame();
  }

  /**
   * Network I/O. main.ts runs it every frame, paused or not: the room never
   * waits on one player's pause menu, so a paused pac keeps reporting
   * (standing still) and a paused first host still names the round. Claims
   * need no host at all.
   */
  updateNet(dt: number) {
    this.rivalIds = this.presentRivals();

    if (this.net.isHost && this.netLive && this.readSharedRound() === null) {
      this.net.updateSharedState({ round: this.boardRound });
    }

    if (this.netRate.due(dt * 1000)) {
      if (this.net.connectionStatus !== "offline") {
        this.sendMyState();
      }

      this.updateNetHud();
    }

    this.remotePacs.update(this.net.players, this.rivalIds, this.t);
  }

  private sendMyState() {
    if (!this.inRound) {
      this.net.updateMyState({ active: false });

      return;
    }

    if (!this.net.serverClock.synced) {
      return;
    }

    this.net.updateMyState({
      active: true,
      score: this.score,
      spawn: this.spawnCount,
      t: Math.round(this.net.serverNow()),
      x: Math.round(this.pac.x * 100) / 100,
      z: Math.round(this.pac.z * 100) / 100,
    });
  }

  private netLine() {
    switch (this.net.connectionStatus) {
      case "connected": {
        return this.racing ? `RACE · ${this.rivalIds.length + 1} PLAYERS` : "ONLINE · WAITING";
      }

      case "connecting": {
        return "CONNECTING…";
      }

      case "reconnecting": {
        return "RECONNECTING…";
      }

      case "offline": {
        return "";
      }
    }
  }

  private updateNetHud() {
    const netInfo = this.netLine();

    if (netInfo !== this.netInfoText) {
      this.netInfoText = netInfo;
      this.netInfoEl.textContent = netInfo;
      this.netInfoEl.dataset["status"] = this.net.connectionStatus;
      this.updateHud();
    }

    if (!this.racing) {
      if (this.boardEl.childElementCount > 0) {
        this.boardEl.replaceChildren();
      }

      this.boardSig = "";

      return;
    }

    const rows = [{ id: this.net.playerId ?? "solo", me: true, score: this.score }];

    for (const id of this.rivalIds) {
      const sc = this.net.players[id]?.state?.["score"];
      rows.push({ id, me: false, score: isJsonNumber(sc) ? sc : 0 });
    }

    rows.sort((a, b) => b.score - a.score);
    const sig = rows.map((r) => `${r.id}:${r.score}`).join("|");

    if (sig === this.boardSig) {
      return;
    }

    this.boardSig = sig;
    const frag = document.createDocumentFragment();

    for (const r of rows.slice(0, 4)) {
      const row = document.createElement("div");
      row.className = `row${r.me ? " me" : ""}`;
      const name = document.createElement("span");
      name.textContent = r.me ? "you" : r.id.slice(0, 4);
      const sc = document.createElement("span");
      sc.className = "sc";
      sc.textContent = String(r.score);
      row.append(name, sc);
      frag.append(row);
    }

    this.boardEl.replaceChildren(frag);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.baseFov = fovForAspect(aspect);
    this.camera.fov = this.baseFov + this.fovKick;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number) {
    const dtMs = dt * 1000;
    this.t += dt;
    const scaredMsBefore = this.scaredMs;

    this.reconcileBoard();
    this.pollPad();

    if (this.phase === "ready") {
      this.readyMs -= dtMs;

      if (this.readyMs <= 0) {
        this.setPhase("playing");
      }
    } else if (this.phase === "playing") {
      if (this.chompQueued > 0 && !this.pac.isMoving) {
        this.chompQueued = 0;
        this.takeStep();
      }

      if (this.movePacman(dt)) {
        this.collectPellet();
      }

      if (this.pac.isMoving) {
        this.chompQueued = Math.max(0, this.chompQueued - dt);
      }

      if (this.phase === "playing") {
        this.scaredMs = Math.max(0, this.scaredMs - dtMs);
        this.graceMs = Math.max(0, this.graceMs - dtMs);
        this.moveGhosts(dt);
        this.checkGhostContact();
      }
    } else if (this.phase === "win") {
      this.winConfettiIn -= dt;

      if (this.winConfettiIn <= 0 && !REDUCED_MOTION.matches) {
        this.fx.confettiRain(26);
        this.winConfettiIn = 0.7;
      }
    }

    const scared = this.scaredMs > 0 && this.phase === "playing";

    if (scared !== this.prevScared) {
      this.prevScared = scared;
      music.setPowerMode(scared);
    }

    if (scared && scaredMsBefore > SCARED_WARN_MS && this.scaredMs <= SCARED_WARN_MS) {
      sfx.play("warn");
    }

    this.updatePresentation(dt);
    this.renderActors(dt);
    this.powerHalo.update(this.pac.x, this.pac.z, scared ? this.scaredMs : 0);
    this.updateChainHud();
    this.fx.update(dt);
    this.updateCamera(dt);
    music.update(dt, this.phase, this.nearestDanger());
  }

  private nearestDanger() {
    if (this.phase !== "playing" || this.scaredMs > 0 || this.graceMs > 0) {
      return null;
    }

    let nearest = Infinity;

    for (const g of this.ghosts) {
      nearest = Math.min(nearest, Math.hypot(g.x - this.pac.x, g.z - this.pac.z));
    }

    return nearest;
  }

  /** Read-only telemetry for bot playtests; coordinates are maze cells. */
  writeDiagnostics(out: GameDiagnostics) {
    out.score = this.score;
    out.complete = this.phase === "win" || this.phase === "gameover";
    out.phase = this.phase;
    out.player.x = this.pac.x;
    out.player.y = this.pac.z;
    out.entities = this.ghosts.length + this.pelletsLeft() + 1;
    out.powerMs = this.scaredMs;
    out.facing = this.pac.dir;
    out.moving = this.pac.isMoving;
    out.lives = this.lives;
    out.pelletsLeft = this.pelletsLeft();
    out.invulnerable = this.graceMs > 0;
    out.nav = this.navDiagnostics ? this.readMaze() : null;
  }

  private readMaze() {
    const here: Cell = { col: Math.round(this.pac.x), row: Math.round(this.pac.z) };
    const fromHere = flood([here]);
    const frightened = this.scaredMs > 0;
    const ghostCells = this.ghosts.map((g) => ({ col: Math.round(g.x), row: Math.round(g.z) }));
    const ghosts: MazeNav["ghosts"] = [];

    for (const cell of ghostCells) {
      const nav = navTo(here, cell, fromHere);

      if (nav) {
        ghosts.push({ ...nav, frightened });
      }
    }

    ghosts.sort((a, b) => a.steps - b.steps);
    const hearts: Cell[] = [];

    for (const key of this.hearts.keys()) {
      const cell = GameScene.parseCellKey(key);

      if (cell) {
        hearts.push(cell);
      }
    }

    const pellet = nearestCell(this.pelletField.cells, fromHere);
    const power = nearestCell(hearts, fromHere);

    return {
      fleeStep: frightened
        ? null
        : fleeStep(here, ghostCells, [...this.pelletField.cells, ...hearts]),
      ghosts: ghosts.slice(0, 2),
      open: openDirs(here),
      pellet: pellet ? navTo(here, pellet, fromHere) : null,
      power: power ? navTo(here, power, fromHere) : null,
    };
  }

  enableNavDiagnostics() {
    this.navDiagnostics = true;
  }

  /** Reseed the ghost AI and restart the round, so the whole run is seeded. */
  seed(seed: number) {
    this.random = seededRandom(seed);
    this.resetGame();
  }

  /** 'active-play' leaves any banner for a live solo round; false for unknown names. */
  setTestState(name: string) {
    if (name !== "active-play") {
      return false;
    }

    if (this.onBanner) {
      this.resetGame();
    }

    return true;
  }

  private updateChainHud() {
    const active =
      this.phase === "playing" && this.comboIdx > 0 && this.t - this.lastPelletAt < COMBO_WINDOW_S;

    const text = active ? `♪ ${this.comboIdx + 1} PEARL CHAIN` : "";

    if (text === this.chainText) {
      return;
    }

    this.chainText = text;
    this.chainEl.textContent = text;
    this.chainEl.classList.toggle("active", active);
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY));

    const cx = (GRID_COLS - 1) / 2;
    const cz = (GRID_ROWS - 1) / 2;
    const half = Math.max(GRID_COLS, GRID_ROWS) / 2 + 6;
    const key = new THREE.DirectionalLight(KEY_COLOR, KEY_INTENSITY);
    key.position.set(cx + 6, 16, cz - 6);
    key.target.position.set(cx, 0, cz);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 60;
    key.shadow.camera.left = -half;
    key.shadow.camera.right = half;
    key.shadow.camera.top = half;
    key.shadow.camera.bottom = -half;
    key.shadow.normalBias = 0.03;
    this.scene.add(key, key.target);
  }

  private buildMaze() {
    const floorSize = Math.max(GRID_COLS, GRID_ROWS) + 44;
    const floorTex = polkaDotTexture();
    floorTex.repeat.set(floorSize / 2, floorSize / 2);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorSize, floorSize),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 }),
    );

    floor.rotation.x = -Math.PI / 2;
    floor.position.set(GRID_COLS / 2, FLOOR_Y, GRID_ROWS / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    const cells = mapCells(1);
    const wallGeo = new RoundedBoxGeometry(0.97, 0.92, 0.97, 4, 0.14);

    const wallMat = new THREE.MeshStandardMaterial({
      color: 0xff_ff_ff,
      depthWrite: false,
      opacity: WALL_OPACITY,
      roughness: 0.85,
      transparent: true,
    });

    const walls = new THREE.InstancedMesh(wallGeo, wallMat, cells.length);
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();

    for (const [i, { col, row }] of cells.entries()) {
      const h = hash2(col, row);
      dummy.position.set(col, 0.44, row);
      dummy.scale.set(1, 0.94 + h * 0.1, 1);
      dummy.updateMatrix();
      walls.setMatrixAt(i, dummy.matrix);
      tint.setHex(COLORS.wall).offsetHSL(0, 0, (h - 0.5) * 2 * WALL_TINT_WOBBLE);
      walls.setColorAt(i, tint);
    }

    walls.castShadow = true;
    walls.receiveShadow = true;
    this.scene.add(walls);
  }

  private resetBoard() {
    for (const heart of this.hearts.values()) {
      this.scene.remove(heart.mesh);
    }

    this.hearts.clear();
    const pearls: PelletCell[] = [];

    for (let row = 0; row < GRID_ROWS; row += 1) {
      for (let col = 0; col < GRID_COLS; col += 1) {
        const cell = MAP[row]?.[col];
        const phase = hash2(col, row) * Math.PI * 2;

        if (cell === 2) {
          pearls.push({ col, phase, row });
        } else if (cell === 3) {
          const mesh = new THREE.Mesh(this.heartGeo, this.powerMat);
          mesh.position.set(col, HEART_Y, row);
          mesh.castShadow = true;
          this.scene.add(mesh);
          this.hearts.set(cellKey(col, row), { mesh, phase });
        }
      }
    }

    this.pelletField.reset(pearls);
  }

  private pelletsLeft() {
    return this.pelletField.count + this.hearts.size;
  }

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.selfieBtnEl.addEventListener("click", () => this.toggleSelfie());
    this.restartBtnEl.addEventListener("click", () => this.requestRestart());
  }

  /** Wrapper pause: drop anything half-entered so resume starts from neutral. */
  setPaused(paused: boolean) {
    if (paused === this.paused) {
      return;
    }

    this.paused = paused;
    this.chompQueued = 0;
    this.shiftHeld = false;
    this.swipeOrigin = null;
    this.swiped = false;
    this.pad.update();
    this.padStickDir = stickDirection4(this.pad.getStick());
  }

  private toggleSound() {
    const on = toggleSound();

    if (on) {
      unlockAudio();
    }

    this.showNotice(on ? "♪ sound on" : "♪ sound off");
  }

  private toggleSelfie() {
    if (this.paused) {
      return;
    }

    this.selfieOn = !this.selfieOn;
    this.selfieBtnEl.classList.toggle("on", this.selfieOn);
    this.selfieBtnEl.setAttribute("aria-pressed", this.selfieOn ? "true" : "false");
  }

  private requestRestart() {
    if (this.phase !== "ready") {
      this.handleStart();
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.paused || SYSTEM_KEYS.has(e.key)) {
      return;
    }

    if (e.key === "Shift") {
      this.shiftHeld = true;

      return;
    }

    if (e.code === "KeyM") {
      this.toggleSound();

      return;
    }

    if (this.phase === "title") {
      this.handleStart();

      return;
    }

    if (e.code === "KeyR") {
      if (this.phase === "playing" || this.phase === "win" || this.phase === "gameover") {
        this.handleStart();
      }

      return;
    }

    switch (e.code) {
      case "ArrowUp": {
        e.preventDefault();
        break;
      }

      case "ArrowDown": {
        e.preventDefault();
        this.steer("reverse");
        break;
      }

      case "ArrowLeft": {
        e.preventDefault();
        this.steer("left");
        break;
      }

      case "ArrowRight": {
        e.preventDefault();
        this.steer("right");
        break;
      }

      case "Space": {
        e.preventDefault();
        this.chomp();
        break;
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Shift") {
      this.shiftHeld = false;
    }
  };

  private onBlur = () => {
    this.shiftHeld = false;
  };

  private onPointerDown = (e: PointerEvent) => {
    if (this.paused) {
      return;
    }

    if (e.target instanceof Element && e.target.closest("#controls, #webcam")) {
      return;
    }

    this.swipeOrigin = { x: e.clientX, y: e.clientY };
    this.swiped = false;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.paused) {
      return;
    }

    if (!this.swipeOrigin || this.swiped) {
      return;
    }

    const dx = e.clientX - this.swipeOrigin.x;
    const dy = e.clientY - this.swipeOrigin.y;

    if (dx * dx + dy * dy < SWIPE_MIN_PX * SWIPE_MIN_PX) {
      return;
    }

    this.swiped = true;

    if (this.onBanner) {
      this.handleStart();

      return;
    }

    if (Math.abs(dx) > Math.abs(dy)) {
      this.steer(dx > 0 ? "right" : "left");
    } else if (dy > 0) {
      this.steer("reverse");
    } else {
      this.chomp();
    }
  };

  private onPointerUp = () => {
    if (!this.swiped && this.swipeOrigin && this.onBanner) {
      this.handleStart();
    }

    this.swipeOrigin = null;
  };

  private get onBanner() {
    return this.phase === "title" || this.phase === "win" || this.phase === "gameover";
  }

  private chomp() {
    if (this.paused) {
      return;
    }

    if (this.onBanner) {
      this.handleStart();
    } else {
      this.chompQueued = CHOMP_BUFFER_S;
    }
  }

  private pollPad() {
    this.pad.update();

    if (this.pad.justPressed("a")) {
      this.chomp();
    }

    if (this.pad.justPressed("start")) {
      this.requestRestart();
    }

    if (this.pad.justPressed("left")) {
      this.steer("left");
    }

    if (this.pad.justPressed("right")) {
      this.steer("right");
    }

    if (this.pad.justPressed("down")) {
      this.steer("reverse");
    }

    const dir = stickDirection4(this.pad.getStick());

    if (dir !== this.padStickDir) {
      this.padStickDir = dir;

      if (dir === "left" || dir === "right") {
        this.steer(dir);
      } else if (dir === "down") {
        this.steer("reverse");
      } else if (dir === "up") {
        this.chomp();
      }
    }
  }

  private steer(action: "left" | "right" | "reverse") {
    if (this.paused) {
      return;
    }

    if (this.phase !== "playing" && this.phase !== "ready") {
      return;
    }

    if (action === "reverse") {
      this.pac.dir = OPPOSITE[this.pac.dir];
    } else if (action === "left") {
      this.pac.dir = TURN_LEFT[this.pac.dir];
    } else {
      this.pac.dir = TURN_RIGHT[this.pac.dir];
    }

    this.taughtTurn = true;

    if (this.t - this.lastTurnTickAt > 0.06) {
      this.lastTurnTickAt = this.t;
      const rates = { left: 0.94, reverse: 0.85, right: 1.06 };
      const rate = rates[action];
      sfx.play("turn", { gain: 0.5, rate });
    }
  }

  /** Raw per-frame mouth state; a closed→open transition = one step (legacy). */
  onMouthChange(open: boolean) {
    const wasOpen = this.prevMouthOpen;
    this.prevMouthOpen = open;

    if (!open || wasOpen) {
      return;
    }

    this.chomp();
  }

  /** Legacy fired a synthetic ArrowLeft on head-turn-left. */
  onHeadTurnLeft() {
    if (this.onBanner) {
      this.handleStart();
    } else {
      this.steer("left");
    }
  }

  onHeadTurnRight() {
    if (this.onBanner) {
      this.handleStart();
    } else {
      this.steer("right");
    }
  }

  private takeStep() {
    if (this.pac.isMoving) {
      return;
    }

    const [dx, dz] = DIR_VECT[this.pac.dir];
    const col = Math.round(this.pac.x) + dx;
    const row = Math.round(this.pac.z) + dz;

    if (!isOpen(col, row)) {
      this.teachingBlockedUntil = this.t + 1.2;
      sfx.play("bump", { gain: 0.7 });
      this.squashKick = Math.max(this.squashKick, 0.5);
      this.fx.puff(
        new THREE.Vector3(this.pac.x + dx * 0.55, 0.15, this.pac.z + dz * 0.55),
        4,
        COLORS.wall,
        { direction: { x: -dx, z: -dz }, sizeMax: 0.1, sizeMin: 0.05, speed: 0.8 },
      );

      return;
    }

    this.pac.target = { x: col, z: row };
    this.pac.isMoving = true;
    this.taughtStep = true;
    sfx.play("chomp", { gain: 0.55 });
  }

  private movePacman(dt: number) {
    const p = this.pac;

    if (!p.isMoving) {
      return false;
    }

    const step = PACMAN_STEP_SPEED * dt;
    const dx = p.target.x - p.x;
    const dz = p.target.z - p.z;
    const dist = Math.hypot(dx, dz);

    if (step >= dist || dist < EPS) {
      p.x = p.target.x;
      p.z = p.target.z;
      p.isMoving = false;
      this.squashKick = 1;
    } else {
      p.x += (dx / dist) * step;
      p.z += (dz / dist) * step;
    }

    return true;
  }

  private collectPellet() {
    const col = Math.round(this.pac.x);
    const row = Math.round(this.pac.z);
    const cell = cellKey(col, row);
    const at = new THREE.Vector3(col, 0.35, row);
    const heart = this.hearts.get(cell);
    let undo: EatUndo;

    if (heart) {
      this.scene.remove(heart.mesh);
      this.hearts.delete(cell);
      undo = { points: SCORE_POWER, scaredBefore: this.scaredMs };
      this.scaredMs = SCARED_MS;
      this.scaredBy = cell;
      this.addScore(SCORE_POWER);
      this.fx.heartBurst(at, 9);
      this.fx.puff(at, 10, COLORS.power, { speed: 1.8 });
      this.fx.ring(col, row, 2.4, COLORS.power);
      this.shaker.add(TRAUMA_POWER);
      this.fovKick = FOV_KICK_POWER;
      sfx.play("power");
    } else if (this.pelletField.collect(col, row)) {
      undo = { points: SCORE_PELLET, scaredBefore: null };
      this.addScore(SCORE_PELLET);
      this.fx.puff(at, 6, COLORS.pellet, { sizeMax: 0.14, sizeMin: 0.06 });
      this.comboIdx = this.t - this.lastPelletAt < COMBO_WINDOW_S ? this.comboIdx + 1 : 0;
      this.lastPelletAt = this.t;
      const semis = COMBO_SCALE[Math.min(this.comboIdx, COMBO_SCALE.length - 1)] ?? 0;
      sfx.play("pellet", { rate: 2 ** (semis / 12) });
    } else {
      return;
    }

    this.claimEat(cell, undo);
    this.updateHud();

    if (this.pelletsLeft() === 0) {
      this.setPhase("win");
    }
  }

  private moveGhosts(dt: number) {
    for (const g of this.ghosts) {
      const speed = this.scaredMs > 0 ? GHOST_SCARED_SPEED : GHOST_SPEED;
      stepGhost(g, speed * dt, (col, row) =>
        chooseGhostDir(
          col,
          row,
          g.dir,
          this.scaredMs > 0,
          Math.round(this.pac.x),
          Math.round(this.pac.z),
          this.random,
        ),
      );
    }
  }

  private checkGhostContact() {
    const scared = this.scaredMs > 0;

    for (const g of this.ghosts) {
      const dist = Math.hypot(g.x - this.pac.x, g.z - this.pac.z);

      if (scared) {
        if (dist < EAT_DIST) {
          this.eatGhost(g);
        }
      } else if (dist < CATCH_DIST && this.graceMs <= 0) {
        this.caught();

        return;
      }
    }
  }

  private eatGhost(g: Ghost) {
    this.ghostsChomped += 1;
    this.addScore(SCORE_GHOST);
    const at = new THREE.Vector3(g.x, GHOST_BOB_BASE, g.z);
    this.fx.puff(at, 14, g.color, { sizeMax: 0.26, sizeMin: 0.12, speed: 2 });
    this.fx.ring(g.x, g.z, 1.15, g.color);
    this.fx.heartBurst(at, 5);
    this.shaker.add(TRAUMA_GHOST_EATEN);
    sfx.play("ghost_eaten");
    g.x = GHOST_RESPAWN.col;
    g.z = GHOST_RESPAWN.row;
    g.spawnScale = 0;
    this.fx.puff(new THREE.Vector3(g.x, 0.12, g.z), 6, g.color, {
      lift: 0.7,
      sizeMax: 0.14,
      sizeMin: 0.07,
      speed: 0.65,
    });
  }

  private caught() {
    this.captureAge = 0;
    this.captureEcho.position.set(this.pac.x, 0, this.pac.z);
    this.captureEcho.rotation.set(0, 0, 0);

    if (this.pac.dir === "up") {
      this.captureEcho.rotation.x = -Math.PI / 2;
    } else if (this.pac.dir === "down") {
      this.captureEcho.rotation.x = Math.PI / 2;
    } else if (this.pac.dir === "left") {
      this.captureEcho.rotation.y = Math.PI;
    }

    this.captureEcho.visible = !REDUCED_MOTION.matches && (this.racing || this.lives > 1);
    this.shaker.add(TRAUMA_CAUGHT);
    this.fx.puff(new THREE.Vector3(this.pac.x, 0.4, this.pac.z), 12, COLORS.power, {
      speed: 1.6,
    });
    this.squashKick = 1.6;
    this.softFlash();
    sfx.play("caught");
    music.duck();

    if (this.racing) {
      this.resetPacman();
      this.graceMs = SPAWN_GRACE_MS;

      return;
    }

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

  private resetPacman() {
    this.reappearAge = 0;
    this.pac.x = PACMAN_SPAWN.col;
    this.pac.z = PACMAN_SPAWN.row;
    this.pac.dir = "right";
    this.pac.isMoving = false;
    this.pac.target = { x: PACMAN_SPAWN.col, z: PACMAN_SPAWN.row };
    this.spawnCount += 1;
    this.chompQueued = 0;
    this.mouthAngle = 0;
    this.stretchAmt = 0;
  }

  private resetGame() {
    if (this.net.isHost) {
      this.resetMaze(this.hostFreshMaze());
    } else {
      this.net.sendToHost("restart", { round: this.boardRound });
    }

    this.resetScore();
    this.graceMs = 0;
    this.resetPacman();
    this.resetRound();
    this.updateHud();
    this.beginReady();
  }

  private resetRound() {
    this.ghostsChomped = 0;
    this.captureAge = CAPTURE_ECHO_S;
    this.captureEcho.visible = false;
    this.lives = START_LIVES;
    this.scaredMs = 0;
    this.scaredBy = null;
    this.comboIdx = 0;
    this.lastPelletAt = -Infinity;
    this.squashKick = 0;

    for (const [i, g] of this.ghosts.entries()) {
      const spawn = GHOST_SPAWNS[i % GHOST_SPAWNS.length];

      if (!spawn) {
        continue;
      }

      g.x = spawn.col;
      g.z = spawn.row;
      g.dir = spawn.dir;
      g.spawnScale = 1;
    }
  }

  private beginReady() {
    notifyGameStarted();
    this.readyMs = READY_MS;
    this.setPhase("ready");
    sfx.play("ready");
  }

  private setPhase(phase: Phase) {
    this.phase = phase;

    if (phase === "playing") {
      notifyGameStarted();
    }

    this.resultAge = 0;
    this.resultEl.classList.remove("show");
    this.updateChainHud();
    this.renderBanner();

    if (phase !== "playing") {
      retrigger(this.bannerEl, "pop");
    }

    this.unwatchControls?.();
    this.unwatchControls =
      phase === "title" || phase === "win" || phase === "gameover"
        ? watchControlContext(() => this.renderBanner())
        : null;

    if (phase === "win") {
      this.fx.confettiRain(REDUCED_MOTION.matches ? 12 : 110);
      this.winConfettiIn = 0.7;
      sfx.play("win");
    } else if (phase === "gameover") {
      sfx.play("gameover");
    }
  }

  private renderBanner() {
    const texts = {
      gameover: ["OHH NO…", `you did your best ♥ chomp or ${restartHint()} to try again`],
      playing: ["", ""],
      ready: ["READY?", ""],
      title: ["PAC·MAN", ""],
      win: [
        this.racing ? "ROUND COMPLETE!" : "MAZE CLEAR!",
        this.racing && !this.net.isHost
          ? "every crumb tidied up ♥ waiting for the host to start the next maze"
          : `every crumb tidied up ♥ chomp or ${restartHint()} for the next maze`,
      ],
    } satisfies Record<Phase, readonly [string, string]>;

    const [title, sub] = texts[this.phase];
    this.bannerTitleEl.textContent = title;
    this.bannerSubEl.textContent = sub;

    if (this.phase === "title") {
      ensureControlsStyle();
      const card = buildControls(IS_TOUCH);
      this.bannerControlsEl.replaceChildren(...(card ? [card] : []));
    } else {
      this.bannerControlsEl.replaceChildren();
    }

    this.bannerEl.style.opacity = title === "" ? "0" : "1";
    const result = this.phase === "win" || this.phase === "gameover";
    this.bannerEl.classList.toggle("has-result", result);
    this.resultEl.hidden = !result;

    if (result) {
      this.resultModeEl.textContent = this.racing ? "YOUR SHARED-MAZE ROUND" : "YOUR SOLO RUN";
      this.resultScoreEl.textContent = String(this.score);
      this.resultBestEl.textContent = String(this.best);
      this.resultGhostsEl.textContent = String(this.ghostsChomped);
      this.resultLeftEl.textContent = String(this.pelletsLeft());
    }
  }

  private softFlash() {
    retrigger(this.flashEl, "on");
  }

  private showNotice(text: string) {
    this.statsEl.textContent = text;

    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
    }

    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.updateHud();
    }, 900);
  }

  private updatePresentation(dt: number) {
    this.captureAge = Math.min(CAPTURE_ECHO_S, this.captureAge + dt);
    this.reappearAge = Math.min(REAPPEAR_S, this.reappearAge + dt);
    this.resultAge += dt;

    if (this.captureAge >= CAPTURE_ECHO_S || REDUCED_MOTION.matches) {
      this.captureEcho.visible = false;
    }

    if (this.captureEcho.visible) {
      const u = this.captureAge / CAPTURE_ECHO_S;
      this.captureEcho.scale.set(1 - u * 0.55, Math.max(0.01, (1 - u) ** 2), 1 - u * 0.55);
    }

    this.updateTeaching();

    if (
      (this.phase === "win" || this.phase === "gameover") &&
      this.resultAge >= RESULT_REVEAL_S &&
      !this.resultEl.classList.contains("show")
    ) {
      this.resultEl.classList.add("show");
    }
  }

  private updateTeaching() {
    if (this.taughtStep && this.taughtTurn && this.teachingDoneAt < 0) {
      this.teachingDoneAt = this.t;
    }

    const visible =
      (this.phase === "ready" || this.phase === "playing") &&
      (this.teachingDoneAt < 0 || this.t - this.teachingDoneAt < 2);

    const blocked = this.t < this.teachingBlockedUntil;
    const shown = [visible, this.taughtStep, this.taughtTurn, blocked].join(",");

    if (shown === this.teachingShown) {
      return;
    }

    this.teachingShown = shown;
    this.teachingEl.hidden = !visible;
    this.teachingStepEl.textContent = this.taughtStep ? "✓ STEP" : "1 · STEP";
    this.teachingTurnEl.textContent = this.taughtTurn ? "✓ TURN" : "2 · TURN";
    this.teachingStepEl.classList.toggle("done", this.taughtStep);
    this.teachingTurnEl.classList.toggle("done", this.taughtTurn);
    this.teachingNoteEl.textContent = this.teachingNote(blocked);
  }

  private teachingNote(blocked: boolean) {
    if (blocked) {
      return "Wall ahead · turn, then chomp";
    }

    if (this.taughtStep && this.taughtTurn) {
      return "Got it! Chomp, turn, tidy the maze ♥";
    }

    if (this.taughtTurn) {
      return "Now chomp · one open tile per bite";
    }

    if (this.taughtStep) {
      return "Turn left or right · relative to your facing";
    }

    return "One chomp = one tile · turns follow your facing";
  }

  private renderActors(dt: number) {
    const tMs = this.t * 1000;

    this.squashKick = Math.max(0, this.squashKick - SQUASH_RECOVER_RATE * dt * this.squashKick);
    const stretchTarget = this.pac.isMoving ? 1 : 0;
    this.stretchAmt += (stretchTarget - this.stretchAmt) * Math.min(1, dt * 14);
    const breathe = 1 + 0.015 * Math.sin(this.t * 3);
    const sy = (1 - STEP_SQUASH * this.squashKick - 0.05 * this.stretchAmt) * breathe;
    const bulge = 1 + STEP_SQUASH * 0.6 * this.squashKick;
    const forward = bulge + STEP_STRETCH * this.stretchAmt;
    const side = bulge - 0.04 * this.stretchAmt;
    const horizontal = this.pac.dir === "left" || this.pac.dir === "right";
    this.pacRig.position.set(this.pac.x, 0, this.pac.z);
    const settle = REDUCED_MOTION.matches ? 1 : 1 - 0.18 * (1 - this.reappearAge / REAPPEAR_S) ** 2;

    const caughtScale =
      this.phase === "gameover" && !REDUCED_MOTION.matches
        ? 1 - 0.2 * Math.min(1, this.captureAge / CAPTURE_ECHO_S)
        : 1;

    this.pacRig.scale
      .set(horizontal ? forward : side, sy, horizontal ? side : forward)
      .multiplyScalar(settle * caughtScale);

    if (this.phase === "win" && !REDUCED_MOTION.matches) {
      this.pacRig.position.y = Math.sin(Math.min(1, this.resultAge / 0.65) * Math.PI) * 0.16;
    }

    this.pacRig.visible = this.graceMs <= 0 || Math.floor(tMs / 120) % 2 === 0;

    const g = this.pacGroup;
    g.rotation.set(0, 0, 0);

    if (this.pac.dir === "up") {
      g.rotation.x = -Math.PI / 2;
    } else if (this.pac.dir === "down") {
      g.rotation.x = Math.PI / 2;
    } else if (this.pac.dir === "left") {
      g.rotation.y = Math.PI;
    }

    const target = this.pac.isMoving ? MOUTH_OPEN_ANGLE : 0;
    this.mouthAngle += (target - this.mouthAngle) * Math.min(dt * MOUTH_LERP_RATE, 1);
    this.syncMouth(this.pac.isMoving ? this.mouthAngle : 0);

    this.renderGhosts(dt, tMs);
    this.renderHearts();
    this.pelletField.update(this.t);
  }

  private renderGhosts(dt: number, tMs: number) {
    const scared = this.scaredMs > 0 && this.phase === "playing";

    const blinkOut =
      scared &&
      this.scaredMs < SCARED_WARN_MS &&
      Math.floor(this.scaredMs / SCARED_BLINK_INTERVAL_MS) % 2 === 0;

    for (const [i, ghost] of this.ghosts.entries()) {
      const phase = i * GHOST_BOB_STAGGER;
      const bobY = Math.sin(tMs * GHOST_BOB_FREQ + phase) * GHOST_BOB_AMP + GHOST_BOB_BASE;
      ghost.group.position.set(ghost.x, 0, ghost.z);
      ghost.bob.position.y = bobY;
      ghost.bob.position.x = scared
        ? Math.sin(this.t * GHOST_TREMBLE_FREQ + phase) * GHOST_TREMBLE_AMP
        : 0;
      ghost.yaw = lerpAngle(ghost.yaw, dirYaw(ghost.dir), Math.min(1, dt * GHOST_YAW_RATE));
      ghost.bob.rotation.y = ghost.yaw;
      ghost.bodyMat.color.setHex(scaredTint(scared, blinkOut, ghost.color));
      ghost.worry.visible = scared;
      ghost.spawnScale = Math.min(1, ghost.spawnScale + dt * 3);
      const grow = 1 - (1 - ghost.spawnScale) * (1 - ghost.spawnScale);
      const targetScale = (scared ? GHOST_SCARED_SCALE : 1) * grow;
      ghost.scale += (targetScale - ghost.scale) * Math.min(1, dt * 8);
      ghost.group.scale.setScalar(Math.max(ghost.scale, 1e-3));
    }
  }

  private renderHearts() {
    for (const heart of this.hearts.values()) {
      const pulse = 1 + HEART_PULSE_AMP * Math.sin(this.t * HEART_PULSE_FREQ + heart.phase);
      heart.mesh.scale.setScalar(pulse);
      heart.mesh.rotation.y = this.t * 1.6 + heart.phase;
      heart.mesh.position.y = HEART_Y + Math.sin(this.t * PELLET_BOB_FREQ + heart.phase) * 0.05;
    }
  }

  private syncMouth(angle: number) {
    const bucket = Math.round(angle / MOUTH_ANGLE_QUANT);
    this.mouthMesh.visible = bucket > 0;

    if (!this.mouthMesh.visible || bucket === this.mouthBuiltBucket) {
      return;
    }

    let geo = this.mouthGeoCache.get(bucket);

    if (!geo) {
      geo = new THREE.SphereGeometry(
        MOUTH_RADIUS,
        24,
        16,
        MOUTH_PHI_START,
        MOUTH_PHI_LENGTH,
        0,
        bucket * MOUTH_ANGLE_QUANT,
      );
      this.mouthGeoCache.set(bucket, geo);
    }

    this.mouthMesh.geometry = geo;
    this.mouthBuiltBucket = bucket;
  }

  private updateCamera(dt: number) {
    if (this.phase === "title") {
      const a = REDUCED_MOTION.matches ? 0 : this.t * TITLE_ORBIT_SPEED;
      const cx = (GRID_COLS - 1) / 2;
      const cz = (GRID_ROWS - 1) / 2;
      this.camTarget.set(
        cx + Math.cos(a) * TITLE_ORBIT_RADIUS,
        TITLE_ORBIT_HEIGHT,
        cz + Math.sin(a) * TITLE_ORBIT_RADIUS,
      );
      this.lookTarget.set(cx, 0, cz);
    } else {
      const [dx, dz] = DIR_VECT[this.pac.dir];
      const selfie = this.shiftHeld || this.selfieOn || this.pad.isButtonDown("lb");
      const back = selfie ? CAM_BACK : -CAM_BACK;
      this.camTarget.set(this.pac.x + dx * back, CAM_HEIGHT, this.pac.z + dz * back);
      const ahead = selfie ? -CAM_SELFIE_LOOK_BACK : CAM_LOOK_AHEAD;
      this.lookTarget.set(this.pac.x + dx * ahead, 0, this.pac.z + dz * ahead);
    }

    if (!this.camInit) {
      this.camCur.copy(this.camTarget);
      this.lookCur.copy(this.lookTarget);
      this.camInit = true;
    }

    const follow = 1 - Math.exp(-CAMERA_FOLLOW_RATE * dt);
    this.camCur.lerp(this.camTarget, follow);
    this.lookCur.lerp(this.lookTarget, follow);
    this.camera.position.copy(this.camCur);
    this.camera.lookAt(this.lookCur);

    const shake = this.shaker.update(dt, this.t);

    if (!REDUCED_MOTION.matches && (shake.ox !== 0 || shake.oy !== 0 || shake.rot !== 0)) {
      this.camera.translateX(shake.ox);
      this.camera.translateY(shake.oy);
      this.camera.rotateZ(shake.rot);
    }

    this.fovKick *= Math.exp(-FOV_KICK_DECAY * dt);
    const fov = this.baseFov + (REDUCED_MOTION.matches ? 0 : this.fovKick);

    if (Math.abs(fov - this.camera.fov) > 0.005) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private addScore(n: number) {
    this.score += n;

    if (this.score > this.best) {
      this.best = this.score;
      saveBest(this.best);
    }

    this.updateHud();
  }

  private updateHud() {
    this.scoreEl.textContent = `SCORE ${this.score}`;
    this.bestEl.textContent = `BEST ${this.best}`;
    const hearts = this.lives > 0 ? "♥".repeat(this.lives) : "×";
    this.statsEl.textContent = `${hearts}  ·  ${this.pelletsLeft()} left`;

    if (this.phase === "win" || this.phase === "gameover") {
      this.renderBanner();
    }
  }
}
