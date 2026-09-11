// 3D first-person Pac-Man, restored from the legacy r3f build on plain three.js.
// Step-per-chomp movement: each mouth-open transition (or SPACE) advances one
// grid cell; head turns / arrow keys rotate the heading relative to the current
// facing. Chase camera trails Pacman; SHIFT flips to a selfie view.
//
// Look & feel: "plush clinic" — warm cream fog, marshmallow walls, Baymax-faced
// ghost blobs, heart power pellets, squash & stretch, pooled puff/heart VFX and
// a gentle trauma camera.
//
// The simulation follows the legacy build (step-per-chomp, relative steering,
// ghost AI) with two deliberate departures: ghost contact uses radial
// hitboxes checked every frame (legacy cell-snapping only ran on movement
// frames, so a stationary Pacman could never be caught — played as a bug),
// and the maze is a bigger generated braided board.

import * as THREE from "three";
import { createTouchControls, notifyGameStarted, watchControlContext } from "@repo/embed";
import { PhysicalGamepad, stickDirection4 } from "@vibedgames/gamepad";
import type { Dir4 } from "@vibedgames/gamepad";
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
import { RemotePacs } from "../net/remote-pacs";
import { NetSession, isJsonNumber, isJsonObject, isJsonString } from "../net/session";
import type { JsonValue } from "../net/session";
import type { Dir } from "../shared/constants";
import {
  MP_ROOM,
  MP_MAX_PLAYERS,
  OFFLINE_FALLBACK_MS,
  NET_TICK_HZ,
  BASE_FOV,
  BEST_KEY,
  CAM_BACK,
  CATCH_DIST,
  CAM_HEIGHT,
  CAM_LOOK_AHEAD,
  CAM_SELFIE_LOOK_BACK,
  CAMERA_SMOOTHING,
  CHASE_CHANCE,
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
  /** Body color, resolved once at construction. */
  color: number;
  group: THREE.Group;
  bob: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  /** Worried "o" mouth, shown while scared. */
  worry: THREE.Mesh;
  yaw: number;
  /** 0→1 grow-in after a respawn teleport (nothing pops). */
  spawnScale: number;
  scale: number;
}

interface Heart {
  mesh: THREE.Mesh;
  /** Per-cell phase so the hearts breathe out of sync. */
  phase: number;
}

/** Pentatonic combo ladder for quick pellet streaks (semitones above root). */
const COMBO_SCALE: readonly number[] = [0, 2, 4, 7, 9, 12, 14, 16, 19];
/** Streak window: pellets eaten within this many seconds keep climbing. */
const COMBO_WINDOW_S = 0.9;

const SWIPE_MIN_PX = 24;
const EPS = 1e-4;
/** DEV-only room override (?room=): the two-client harness isolates each run
 *  so a stale room's board can't leak into assertions. */
const ROOM = (import.meta.env.DEV && new URLSearchParams(location.search).get("room")) || MP_ROOM;
/** Shrinking after-image left where Pacman was caught. */
const CAPTURE_ECHO_S = 0.28;
/** Settle-in scale after a respawn. */
const REAPPEAR_S = 0.24;
/** The result card unhides one frame before it fades in, so its transition runs. */
const RESULT_REVEAL_S = 0.16;
/** Browser/wrapper chords: never a "press any key" start, never play input. */
const SYSTEM_KEYS = new Set(["Tab", "Control", "Alt", "Meta", "Escape"]);
/**
 * Ceiling for the portrait FOV widening below — past this it just fisheyes.
 *
 * 110 is deliberate, not a default. A phone wants 118° vertical to hold the
 * 16:9 horizontal view; capping tighter (95 was tried) does buy back some of
 * the empty sky, but it costs corridor lookahead and blows pac up until he
 * fills the frame. The empty band above the maze comes from the chase camera's
 * pitch, not from this angle, so narrowing here pays for nothing.
 */
const MAX_FOV = 110;

/** Plush-clinic skin for the shared touch pause/mute cluster (@repo/embed):
 *  same card/edge palette as the HUD pills, docked under the BEST pill so it
 *  never lands on one. */
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

export const UPDATE_STEPS = [
  "net",
  "board",
  "pad",
  "presentation",
  "actors",
  "ghosts",
  "hearts",
  "pellets",
  "halo",
  "hud",
  "fx",
  "camera",
  "music",
  "netOut",
] as const;
export type UpdateStep = (typeof UPDATE_STEPS)[number];

export interface GameDiagnostics {
  score: number;
  complete: boolean;
  phase: Phase;
  player: { x: number; y: number };
  entities: number;
  powerMs: number;
}

/** Points a pellet cell is worth — from the map, never trusted from the wire. */
const cellScore = (cell: { col: number; row: number }): number =>
  MAP[cell.row]?.[cell.col] === 3 ? SCORE_POWER : SCORE_PELLET;

const el = (id: string): HTMLElement => {
  const node = document.querySelector(`#${id}`);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`missing #${id}`);
  }
  return node;
};
/**
 * Hor+ vertical FOV. `PerspectiveCamera.fov` is the VERTICAL angle, so holding
 * BASE_FOV on a portrait phone collapses the horizontal field to ~39° — ghosts
 * one corridor over are invisible until they touch you. Below square, solve the
 * vertical angle that keeps the horizontal field at its square-aspect value
 * (same construction as games/tetris/src/render/camera-rig.ts), capped so an
 * extreme ratio stops widening rather than turning into a fish-eye.
 */
const fovForAspect = (aspect: number): number => {
  if (aspect >= 1) {
    return BASE_FOV;
  }
  const vertical = (Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / aspect) * 360) / Math.PI;
  return Math.min(MAX_FOV, vertical);
};
/**
 * Butter-yellow plush ball with the animated mouth wedge, plus a face you
 * only meet in the selfie cam: lens eyes and blush cheeks. Face is on +x
 * (the mouth wedge's home), matching the "right" rest orientation.
 */
const buildPacman = (): THREE.Group => {
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
/**
 * Ghost as a Baymax-style marshmallow: pastel capsule, two black lens eyes
 * joined by a thin line, blush cheeks, and a hidden worried "o" mouth that
 * appears while scared. Face is on -z; the bob group yaws toward travel.
 */
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
/** Yaw (rotation.y) that points the -z face along a grid direction. */
const dirYaw = (dir: Dir): number => {
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
    // no default
  }
};
/** Shortest-arc angle lerp. */
const lerpAngle = (from: number, to: number, k: number): number => {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return from + delta * k;
};
/** Deterministic per-cell hash in [0, 1) — stable tint/height/phase wobble. */
const hash2 = (col: number, row: number): number => {
  const n = Math.sin(col * 127.1 + row * 311.7) * 43_758.5453;
  return n - Math.floor(n);
};
/** All MAP cells of a given type (1 wall, 2 pellet, 3 power heart). */
const mapCells = (type: number): { col: number; row: number }[] => {
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
/** Restart a CSS animation by re-applying its class. */
const retrigger = (node: HTMLElement, cls: string): void => {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
};
const hexCss = (hex: number): string => `#${hex.toString(16).padStart(6, "0")}`;
/** Cream weave with soft polka dots — repeats across the plush floor. */
const polkaDotTexture = (): THREE.CanvasTexture => {
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
    // Center dot + quarter dots in each corner = staggered diagonal grid.
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
/**
 * Advance a ghost `dist` cells along its dir, re-deciding at every grid
 * center via `decide` (null = stop). Movement is broken at cell boundaries so
 * decisions land exactly on centers; no wraparound (out-of-bounds is wall).
 */
const stepGhost = (
  g: { x: number; z: number; dir: Dir },
  distance: number,
  decide: (col: number, row: number) => Dir | null,
): void => {
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
const pick = <T>(arr: readonly T[]): T | undefined => arr[Math.floor(Math.random() * arr.length)];
/**
 * Ghost AI, evaluated at each grid center (legacy moveGhostsOnGrid): never
 * reverse unless dead-ended; scared = uniform random; otherwise 70% greedy
 * (random among strictly distance-reducing options, falling back to random)
 * / 30% pure random.
 */
const chooseGhostDir = (
  col: number,
  row: number,
  dir: Dir,
  scared: boolean,
  pacX: number,
  pacZ: number,
): Dir | null => {
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
    return pick(options) ?? null;
  }
  if (Math.random() < CHASE_CHANCE) {
    const here = (col - pacX) ** 2 + (row - pacZ) ** 2;
    const closer = options.filter((d) => {
      const [dx, dz] = DIR_VECT[d];
      return (col + dx - pacX) ** 2 + (row + dz - pacZ) ** 2 < here;
    });
    if (closer.length > 0) {
      return pick(closer) ?? null;
    }
  }
  return pick(options) ?? null;
};
const loadBest = (): number => {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const n = raw === null ? 0 : Math.trunc(Number(raw));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
};
const saveBest = (best: number): void => {
  try {
    localStorage.setItem(BEST_KEY, String(best));
  } catch {
    // storage unavailable (private mode) — best just won't persist
  }
};

/** Ghost body tint: its own color normally, the scared blue while scared, and
 *  the blink color on the warning strobe. */
const scaredTint = (scared: boolean, blinkOut: boolean, own: number): number => {
  if (!scared) {
    return own;
  }
  return blinkOut ? COLORS.scaredBlink : COLORS.scared;
};

export class GameScene {
  /** Wrapper pause: the sim and every input path stand still. */
  private paused = false;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  // ---- simulation state ------------------------------------------------------
  private phase: Phase = "title";
  private pac: PacBody = {
    dir: "right",
    isMoving: false,
    target: { x: PACMAN_SPAWN.col, z: PACMAN_SPAWN.row },
    x: PACMAN_SPAWN.col,
    z: PACMAN_SPAWN.row,
  };
  private ghosts: Ghost[] = [];
  private pelletField: PelletField;
  private hearts = new Map<string, Heart>();
  private score = 0;
  private best = 0;
  /** Local ghost contacts, retained across lives and reset with the round score. */
  private ghostsChomped = 0;

  // ---- multiplayer (shared-maze pellet race) ---------------------------------
  // The maze + pellets come from the static MAP (identical on every client). The
  // host owns the authoritative set of eaten cells; players race to grab them.
  // Ghosts stay LOCAL — each player dodges their own. Solo/offline is unchanged.
  private net = new NetSession({
    fallbackMs: OFFLINE_FALLBACK_MS,
    maxPlayers: MP_MAX_PLAYERS,
    onEvent: (event, payload, from) => this.handleNetEvent(event, payload, from),
    room: ROOM,
  });
  private remotePacs: RemotePacs;
  /** Rivals present this frame (see presentRivals). */
  private rivalIds: string[] = [];
  private netAcc = 0;
  private boardRound = 0;
  private boardSig = "";
  /** Host: authoritative eaten cells. */
  private hostEaten = new Set<string>();
  /** Cells already removed locally. */
  private appliedEaten = new Set<string>();
  /** At most one optimistic claim per maze cell, retired on rejection or reset. */
  private pendingClaims = new Set<string>();
  /** Last shared board object reconciled (patches replace it, so `===` detects change). */
  private lastBoardRef: JsonValue | undefined = null;
  /** Whether we were host when lastBoardRef was reconciled — a promotion must re-adopt. */
  private lastBoardAsHost = false;
  private netInfoText = "";
  private boardEl = el("board");
  private netInfoEl = el("netinfo");
  private lives = START_LIVES;
  private scaredMs = 0;
  private graceMs = 0;
  private readyMs = 0;

  // ---- input state -------------------------------------------------------------
  private stepRequested = false;
  private prevMouthOpen = false;
  private shiftHeld = false;
  /** Touch stand-in for SHIFT: the 🤳 pill latches instead of holding. */
  private selfieOn = false;
  private swipeOrigin: { x: number; y: number } | null = null;
  private swiped = false;
  /** Physical controller — polled once per frame; steering is edge-triggered. */
  private readonly pad = new PhysicalGamepad();
  /** Last snapped left-stick direction, so a held deflection fires once. */
  private padStickDir: Dir4 | null = null;
  /** Live while a banner is up: re-renders it on pad connect/disconnect. */
  private unwatchControls: (() => void) | null = null;
  // ---- display objects -----------------------------------------------------------
  /** Outer rig: world position + axis-aligned squash/stretch. */
  private pacRig = new THREE.Group();
  /** Inner group: facing rotation (so the rig's scale stays world-aligned). */
  private pacGroup: THREE.Group;
  /** One render-only copy; shares immutable geometry/materials, never owns/disposes them. */
  private captureEcho: THREE.Group;
  private captureAge = CAPTURE_ECHO_S;
  private reappearAge = REAPPEAR_S;
  private resultAge = 0;
  private mouthMesh: THREE.Mesh;
  private mouthAngle = 0;
  private mouthBuiltBucket = -1;
  /** Quantized wedge geometries, built once each (~16 total, never disposed). */
  private mouthGeoCache = new Map<number, THREE.SphereGeometry>();
  private heartGeo = buildHeartGeometry(POWER_PELLET_RADIUS * 1.85);
  private powerMat = new THREE.MeshStandardMaterial({
    color: COLORS.power,
    emissive: COLORS.heartGlow,
    emissiveIntensity: 0.4,
    roughness: 0.5,
  });

  // ---- feel / vfx state ---------------------------------------------------------
  private fx: FxPool;
  private powerHalo: PowerHalo;
  private shaker = new TraumaCamera();
  private t = 0;
  private fovKick = 0;
  /** Vertical FOV for the live aspect — the kick rides on top of this. */
  private baseFov = BASE_FOV;
  private squashKick = 0;
  private stretchAmt = 0;
  private comboIdx = 0;
  private lastPelletAt = -Infinity;
  private lastTurnTickAt = -Infinity;
  private prevScared = false;
  private winConfettiIn = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

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
  /** Bitset of what the teaching card last showed — skips the DOM writes while unchanged. */
  private teachingShown = "";
  private resultEl = el("result");
  private resultModeEl = el("result-mode");
  private resultScoreEl = el("result-score");
  private resultBestEl = el("result-best");
  private resultGhostsEl = el("result-ghosts");
  private resultLeftEl = el("result-left");

  constructor() {
    // Touch-only pause button — the phone stand-in for Escape.
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
      throw new Error("pacman mouth missing");
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
    this.best = loadBest();
    this.bindInput();
    this.setPhase("title");
    this.updateHud();
  }

  // ---- multiplayer ---------------------------------------------------------

  /** A rival is sharing the maze (so the game runs in race mode). */
  private get racing(): boolean {
    return this.rivalIds.length > 0;
  }

  /** Other players present right now. A seat the server holds for a reconnect
   *  is not a rival: its last state would park a frozen pac in the maze for the
   *  whole grace window and keep a lone player on race rules. */
  private presentRivals(): string[] {
    const me = this.net.playerId;
    return Object.entries(this.net.players)
      .filter(([id, p]) => id !== me && p.connected !== false)
      .map(([id]) => id);
  }

  private handleNetEvent(event: string, payload: JsonValue, from: string): void {
    const p = isJsonObject(payload) ? payload : {};
    // Host arbitrates pellet eats: the first valid claim on a cell wins.
    if (event === "eat" && this.net.isHost) {
      // Stale claims (buffered during connect, or from a previous round) must
      // not chew pellets out of the current board.
      if (p["round"] !== this.boardRound) {
        return;
      }
      const { key } = p;
      if (isJsonString(key)) {
        this.hostArbitrate(key, from);
      }
      return;
    }
    // Loser of a contested cell rolls back the points it awarded optimistically.
    // Only the host may order a rollback — otherwise a guest could forge a
    // `reject` to drive a rival's score down.
    if (event === "reject" && from === this.net.hostId) {
      const { key } = p;
      if (p["round"] !== this.boardRound || p["to"] !== this.net.playerId || !isJsonString(key)) {
        return;
      }
      const cell = GameScene.parseEatKey(key);
      if (!cell || !this.pendingClaims.delete(key)) {
        return;
      }
      this.addScore(-cellScore(cell));
    }
  }

  /** Parse a cell key into in-bounds integer coordinates. */
  private static parseCellKey(key: string): { col: number; row: number } | null {
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

  /** Parse + validate a wire cell key: it must be an in-bounds eatable cell. */
  private static parseEatKey(key: string): { col: number; row: number } | null {
    const cell = GameScene.parseCellKey(key);
    if (!cell) {
      return null;
    }
    const type = MAP[cell.row]?.[cell.col];
    // 2 = pellet, 3 = power.
    if (type !== 2 && type !== 3) {
      return null;
    }
    return cell;
  }

  /**
   * Host decides who owns a cell: the first valid claim wins. A late claim
   * (the same cell already taken) loses the points it optimistically awarded —
   * the host rolls its own back, or tells the guest to via a `reject`. The
   * amount is derived from the map, never trusted from the wire.
   */
  private hostArbitrate(key: string, claimer: string): void {
    const cell = GameScene.parseEatKey(key);
    // Malformed / out-of-bounds / not a pellet cell: drop it.
    if (!cell) {
      return;
    }
    if (this.hostEaten.has(key)) {
      if (claimer === (this.net.playerId ?? "solo")) {
        this.addScore(-cellScore(cell));
      } else {
        this.net.sendEvent("reject", { key, round: this.boardRound, to: claimer });
      }
      return;
    }
    this.hostEaten.add(key);
    this.broadcastBoard();
  }

  private broadcastBoard(): void {
    if (this.net.offline) {
      return;
    }
    const eaten: Record<string, number> = {};
    for (const k of this.hostEaten) {
      eaten[k] = 1;
    }
    this.net.patchShared({ board: { eaten, round: this.boardRound } });
  }

  /** Record that the LOCAL player ate a cell (already removed + scored locally),
   *  and propagate it to the shared board. */
  private markEaten(col: number, row: number): void {
    const key = cellKey(col, row);
    if (this.appliedEaten.has(key)) {
      return;
    }
    this.appliedEaten.add(key);
    if (this.net.isHost) {
      // Route the host's own eat through arbitration too, so it rolls back if a
      // guest claimed the same cell first this tick.
      this.hostArbitrate(key, this.net.playerId ?? "solo");
    } else {
      this.pendingClaims.add(key);
      this.net.sendEvent("eat", { key, round: this.boardRound });
    }
  }

  /** Adopt the host's authoritative eaten set: remove pellets others grabbed,
   *  and honour a round reset. */
  private reconcileBoard(): void {
    if (this.net.isHost && this.sharedBoard() === null) {
      // First host seeds an empty board.
      this.broadcastBoard();
      return;
    }
    // Patches REPLACE the board object, so reference equality means nothing
    // changed — skip the re-parse + eaten loop (60 Hz otherwise). A host
    // promotion re-runs once so the new host adopts the accumulated set.
    const raw = this.net.sharedState?.["board"];
    if (raw === this.lastBoardRef && this.net.isHost === this.lastBoardAsHost) {
      // The win check still runs: it depends on local phase, which can flip
      // between board updates (e.g. rivals emptied the maze during READY).
      this.checkRaceWin();
      return;
    }
    const board = this.sharedBoard();
    if (!board) {
      return;
    }
    if (board.round !== this.boardRound) {
      this.applyNewRound(board.round);
      return;
    }
    const promoted = this.net.isHost && !this.lastBoardAsHost;
    this.lastBoardRef = raw;
    this.lastBoardAsHost = this.net.isHost;
    let removed = false;
    for (const key of board.eaten) {
      // A promoted host must adopt the accumulated set, or its next broadcast
      // (rebuilt from hostEaten alone) would resurrect every earlier pellet
      // for late joiners.
      if (this.net.isHost) {
        this.hostEaten.add(key);
      }
      if (this.appliedEaten.has(key)) {
        continue;
      }
      this.appliedEaten.add(key);
      this.removeCellVisual(key);
      removed = true;
    }
    // The pellets-left pill and the result card both read the shared maze.
    if (removed || promoted) {
      this.updateHud();
    }
    this.checkRaceWin();
  }

  /** In a race, the shared maze emptying out ends the round for everyone. */
  private checkRaceWin(): void {
    if (this.racing && this.phase === "playing" && this.pelletsLeft() === 0) {
      this.setPhase("win");
    }
  }

  private sharedBoard(): { round: number; eaten: ReadonlySet<string> } | null {
    const s = this.net.sharedState;
    const b = s?.["board"];
    if (!isJsonObject(b)) {
      return null;
    }
    const round = isJsonNumber(b["round"]) ? b["round"] : 0;
    const eaten = isJsonObject(b["eaten"]) ? new Set(Object.keys(b["eaten"])) : new Set<string>();
    return { eaten, round };
  }

  /** Remove a pellet/heart at a cell key that a rival ate (no score, no sfx). */
  private removeCellVisual(key: string): void {
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

  /** Host starts a fresh round; everyone resets when they see the new number. */
  private hostNewRound(): void {
    this.boardRound += 1;
    this.hostEaten.clear();
    this.broadcastBoard();
    this.applyNewRound(this.boardRound);
  }

  private applyNewRound(round: number): void {
    this.boardRound = round;
    this.pendingClaims.clear();
    this.appliedEaten.clear();
    this.resetBoard();
    this.score = 0;
    this.resetRound();
    this.resetPacman();
    this.graceMs = SPAWN_GRACE_MS;
    this.updateHud();
    // Only players already in the race get pulled into the fresh maze — a
    // round bump must not yank someone off the title/gameover screen into
    // live ghosts they never asked for.
    if (this.phase === "playing" || this.phase === "ready" || this.phase === "win") {
      this.setPhase("playing");
    }
  }

  /** Tap/gesture to start or restart — solo resets the board; in a race it just
   *  drops you into the ongoing shared maze (host can start a new round). */
  private handleStart(): void {
    if (this.paused) {
      return;
    }
    if (this.racing) {
      if (this.phase === "win") {
        // Only the host can start the next round; a guest flipping to
        // "playing" here would bounce straight back on the next reconcile,
        // replaying the win fanfare every press.
        if (this.net.isHost) {
          this.hostNewRound();
        }
        return;
      }
      this.resetPacman();
      this.graceMs = SPAWN_GRACE_MS;
      this.setPhase("playing");
      return;
    }
    this.resetGame();
  }

  private updateNet(dt: number): void {
    if (!this.net.offline) {
      this.netAcc += dt;
      if (this.netAcc >= 1 / NET_TICK_HZ) {
        this.netAcc = 0;
        this.net.updateMyState({ score: this.score, x: this.pac.x, z: this.pac.z });
        // Roster/standings work only needs to track the ~NET_TICK_HZ updates;
        // the smoothing in remotePacs.update below still runs every frame.
        this.remotePacs.sync(this.net.players, this.rivalIds);
        this.updateNetHud();
      }
    }
    this.remotePacs.update(dt, this.t);
  }

  private updateNetHud(): void {
    let netInfo = "";
    if (this.net.live && !this.net.offline) {
      netInfo = this.racing ? `RACE · ${this.rivalIds.length + 1} PLAYERS` : "ONLINE · WAITING";
    }
    if (netInfo !== this.netInfoText) {
      this.netInfoText = netInfo;
      this.netInfoEl.textContent = netInfo;
      // A rival arriving or leaving reworded the result card.
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
    // The board only changes when someone scores or joins/leaves — skip the
    // DOM rebuild (60 Hz otherwise) while the standings are unchanged.
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

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.baseFov = fovForAspect(aspect);
    this.camera.fov = this.baseFov + this.fovKick;
    this.camera.updateProjectionMatrix();
  }

  // ---- per-frame update ---------------------------------------------------------

  /** `allow` is a probe hook (src/gpu-probe.ts): each named step runs only
   *  when it says so, so a driver crash can be bisected to one of them. */
  // oxlint-disable-next-line complexity -- the per-step gates are probe scaffolding, removed with src/gpu-probe.ts
  update(dt: number, allow: (step: UpdateStep) => boolean = () => true): void {
    const dtMs = dt * 1000;
    this.t += dt;
    const scaredMsBefore = this.scaredMs;

    if (allow("net")) {
      this.net.tick();
      this.rivalIds = this.presentRivals();
    }
    if (allow("board")) {
      this.reconcileBoard();
    }
    if (allow("pad")) {
      this.pollPad();
    }

    if (this.phase === "ready") {
      this.readyMs -= dtMs;
      if (this.readyMs <= 0) {
        this.setPhase("playing");
      }
    } else if (this.phase === "playing") {
      // Legacy semantics: a chomp during the step animation is dropped, not queued.
      if (this.stepRequested) {
        this.stepRequested = false;
        this.takeStep();
      }
      if (this.movePacman(dt)) {
        this.collectPellet();
      }
      if (this.phase === "playing") {
        this.scaredMs = Math.max(0, this.scaredMs - dtMs);
        this.graceMs = Math.max(0, this.graceMs - dtMs);
        this.moveGhosts(dt);
        // Contact every frame — standing still is not a safe spot. (The
        // legacy build only checked on movement frames; that played as a bug.)
        this.checkGhostContact();
      }
    } else if (this.phase === "win") {
      // Drifting celebration: another confetti wave every beat.
      this.winConfettiIn -= dt;
      if (this.winConfettiIn <= 0 && !REDUCED_MOTION.matches) {
        this.fx.confettiRain(26);
        this.winConfettiIn = 0.7;
      }
    }

    // Power mode is a PLAYING-phase thing — leaving the round (win/gameover)
    // must drop the sped-up music even though scaredMs froze mid-value.
    const scared = this.scaredMs > 0 && this.phase === "playing";
    if (scared !== this.prevScared) {
      this.prevScared = scared;
      music.setPowerMode(scared);
    }
    // One soft cue when power mode enters its blinking last stretch.
    if (scared && scaredMsBefore > SCARED_WARN_MS && this.scaredMs <= SCARED_WARN_MS) {
      sfx.play("warn");
    }

    if (allow("presentation")) {
      this.updatePresentation(dt);
    }
    if (allow("actors")) {
      this.renderActors(dt, allow);
    }
    if (allow("halo")) {
      this.powerHalo.update(this.pac.x, this.pac.z, scared ? this.scaredMs : 0);
    }
    if (allow("hud")) {
      this.updateChainHud();
    }
    if (allow("fx")) {
      this.fx.update(dt);
    }
    if (allow("camera")) {
      this.updateCamera(dt);
    }
    if (allow("music")) {
      music.update(dt, this.phase, this.nearestDanger());
    }
    if (allow("netOut")) {
      this.updateNet(dt);
    }
  }

  /** Maze-cell distance to the closest ghost that can catch us; null while none can. */
  private nearestDanger(): number | null {
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
  writeDiagnostics(out: GameDiagnostics): void {
    out.score = this.score;
    out.complete = this.phase === "win";
    out.phase = this.phase;
    out.player.x = this.pac.x;
    out.player.y = this.pac.z;
    out.entities = this.ghosts.length + this.pelletsLeft() + 1;
    out.powerMs = this.scaredMs;
  }

  private updateChainHud(): void {
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

  // ---- board ---------------------------------------------------------------

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY));

    const cx = (GRID_COLS - 1) / 2;
    const cz = (GRID_ROWS - 1) / 2;
    const half = Math.max(GRID_COLS, GRID_ROWS) / 2 + 6;
    const key = new THREE.DirectionalLight(KEY_COLOR, KEY_INTENSITY);
    key.position.set(cx + 6, 16, cz - 6);
    key.target.position.set(cx, 0, cz);
    key.castShadow = true;
    // 1024 over the maze-sized frustum — plenty for blobby plush shadows,
    // half the depth-pass cost of 2048 on phones.
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

  private buildMaze(): void {
    // Floor: a big plush plane (extends past the maze so it melts into fog),
    // with a subtle polka-dot weave. Legacy half-cell offset kept.
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

    // Walls: one InstancedMesh of rounded marshmallow blocks, gently varied
    // in height and tint so the candy field doesn't read as flat extrusion.
    const cells = mapCells(1);
    const wallGeo = new RoundedBoxGeometry(0.97, 0.92, 0.97, 4, 0.14);
    // depthWrite OFF: instances inside one InstancedMesh draw in buffer
    // order, not back-to-front — with depth writes, wall-behind-wall
    // translucency flips between "invisible" and "blended" depending on
    // which way the chase cam faces (measured 7.5× direction asymmetry).
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

  private resetBoard(): void {
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

  /** Pellets remaining (pearls + hearts) — win when it hits zero. */
  private pelletsLeft(): number {
    return this.pelletField.count + this.hearts.size;
  }

  // ---- input ---------------------------------------------------------------

  private bindInput(): void {
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
  setPaused(paused: boolean): void {
    if (paused === this.paused) {
      return;
    }
    this.paused = paused;
    this.stepRequested = false;
    this.shiftHeld = false;
    this.swipeOrigin = null;
    this.swiped = false;
    // Buttons pressed during the pause must not read as "just pressed" on resume.
    this.pad.update();
    this.padStickDir = stickDirection4(this.pad.getStick());
  }

  /** M key — one toggle for music + sfx, persisted. */
  private toggleSound(): void {
    const on = toggleSound();
    if (on) {
      unlockAudio();
    }
    this.showNotice(on ? "♪ sound on" : "♪ sound off");
  }

  /** 🤳 pill — latched selfie cam (SHIFT still works as hold on keyboards). */
  private toggleSelfie(): void {
    if (this.paused) {
      return;
    }
    this.selfieOn = !this.selfieOn;
    this.selfieBtnEl.classList.toggle("on", this.selfieOn);
    this.selfieBtnEl.setAttribute("aria-pressed", this.selfieOn ? "true" : "false");
  }

  /** ↻ pill — R-equivalent (also starts from the title). */
  private requestRestart(): void {
    if (this.phase !== "ready") {
      this.handleStart();
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
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
      // Legacy keyboard semantics: arrows are RELATIVE to the current heading
      // and apply instantly without wall validation. ArrowUp re-sets the
      // current heading (effectively a no-op).
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
      // Keyboard fallback for the chomp (legacy couldn't move without a webcam).
      case "Space": {
        e.preventDefault();
        this.chomp();
        break;
      }
      // no default
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") {
      this.shiftHeld = false;
    }
  };

  private onBlur = (): void => {
    this.shiftHeld = false;
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.paused) {
      return;
    }
    // Taps on the HUD pills / webcam porthole are UI, not game input — they
    // must not swipe-steer or tap-start underneath.
    if (e.target instanceof Element && e.target.closest("#controls, #webcam")) {
      return;
    }
    this.swipeOrigin = { x: e.clientX, y: e.clientY };
    this.swiped = false;
  };

  // Touch fallback: horizontal swipe = relative turn, swipe up = step forward,
  // swipe down = reverse. Tap = start/restart.
  private onPointerMove = (e: PointerEvent): void => {
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
    // On a banner, ANY deliberate gesture starts the round — the same as a
    // mouth chomp, a head turn or pad A. Steering there is a no-op, and the
    // swipe would otherwise also eat the tap-to-restart onPointerUp gates on
    // `!swiped`, leaving touch with no way off the gameover screen.
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

  private onPointerUp = (): void => {
    if (!this.swiped && this.swipeOrigin && this.onBanner) {
      this.handleStart();
    }
    this.swipeOrigin = null;
  };

  /** A banner is up, so every input means "start/restart" rather than "play". */
  private get onBanner(): boolean {
    return this.phase === "title" || this.phase === "win" || this.phase === "gameover";
  }

  /** One chomp: a grid step while playing, the start gesture on a banner.
   *  Every chomp input (mouth, SPACE, swipe ↑, pad A / stick ↑) lands here. */
  private chomp(): void {
    if (this.paused) {
      return;
    }
    if (this.onBanner) {
      this.handleStart();
    } else {
      this.stepRequested = true;
    }
  }

  /** Physical pad, polled per frame. Buttons mirror the keyboard: A = SPACE
   *  (chomp; start/restart from a banner), d-pad = arrows, START = R, LB =
   *  SHIFT (read directly in updateCamera). Stick steering fires on the
   *  snapped direction CHANGING, so a held deflection is one turn, not sixty. */
  private pollPad(): void {
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

  /** Heading change — instant, unvalidated, relative to current facing (legacy). */
  private steer(action: "left" | "right" | "reverse"): void {
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
    // Audible "turn registered" tick — vital for face input, where the only
    // other confirmation is the slow camera swing. Throttled against
    // key-repeat spam from held arrows.
    if (this.t - this.lastTurnTickAt > 0.06) {
      this.lastTurnTickAt = this.t;
      const rates = { left: 0.94, reverse: 0.85, right: 1.06 };
      const rate = rates[action];
      sfx.play("turn", { gain: 0.5, rate });
    }
  }

  // ---- face-gesture entry points (wired by main.ts to FaceCamera) -------------

  /** Raw per-frame mouth state; a closed→open transition = one step (legacy). */
  onMouthChange(open: boolean): void {
    const wasOpen = this.prevMouthOpen;
    this.prevMouthOpen = open;
    if (!open || wasOpen) {
      return;
    }
    this.chomp();
  }

  /** Legacy fired a synthetic ArrowLeft on head-turn-left. */
  onHeadTurnLeft(): void {
    if (this.onBanner) {
      this.handleStart();
    } else {
      this.steer("left");
    }
  }

  onHeadTurnRight(): void {
    if (this.onBanner) {
      this.handleStart();
    } else {
      this.steer("right");
    }
  }

  // ---- simulation ----------------------------------------------------------

  /** One grid step in the current heading, if the next cell is open (legacy takeStep). */
  private takeStep(): void {
    if (this.pac.isMoving) {
      return;
    }
    const [dx, dz] = DIR_VECT[this.pac.dir];
    const col = Math.round(this.pac.x) + dx;
    const row = Math.round(this.pac.z) + dz;
    if (!isOpen(col, row)) {
      // Blocked chomp still gets feedback — with face input, a silent no-op
      // is indistinguishable from "the camera missed my gesture".
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

  /** Advances the step animation; returns true if this was a movement frame. */
  private movePacman(dt: number): boolean {
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
      // Landing on the cell: a little plush squash.
      this.squashKick = 1;
    } else {
      p.x += (dx / dist) * step;
      p.z += (dz / dist) * step;
    }
    return true;
  }

  private collectPellet(): void {
    const col = Math.round(this.pac.x);
    const row = Math.round(this.pac.z);
    const at = new THREE.Vector3(col, 0.35, row);
    const heart = this.hearts.get(cellKey(col, row));
    if (heart) {
      this.scene.remove(heart.mesh);
      this.hearts.delete(cellKey(col, row));
      // A second power pellet RESETS the clock (the legacy timer didn't —
      // a flagged bug; kept fixed per the rebuild).
      this.scaredMs = SCARED_MS;
      this.addScore(SCORE_POWER);
      this.fx.heartBurst(at, 9);
      this.fx.puff(at, 10, COLORS.power, { speed: 1.8 });
      this.fx.ring(col, row, 2.4, COLORS.power);
      this.shaker.add(TRAUMA_POWER);
      this.fovKick = FOV_KICK_POWER;
      sfx.play("power");
    } else if (this.pelletField.collect(col, row)) {
      this.addScore(SCORE_PELLET);
      this.fx.puff(at, 6, COLORS.pellet, { sizeMax: 0.14, sizeMin: 0.06 });
      // Quick streaks climb a pentatonic ladder — eating fast plays a melody.
      this.comboIdx = this.t - this.lastPelletAt < COMBO_WINDOW_S ? this.comboIdx + 1 : 0;
      this.lastPelletAt = this.t;
      const semis = COMBO_SCALE[Math.min(this.comboIdx, COMBO_SCALE.length - 1)] ?? 0;
      sfx.play("pellet", { rate: 2 ** (semis / 12) });
    } else {
      return;
    }
    // Claim this cell on the shared board so rivals see it vanish too.
    this.markEaten(col, row);
    this.updateHud();
    if (this.pelletsLeft() === 0) {
      this.setPhase("win");
    }
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

  /**
   * Radial hitboxes on the ground plane (replaces the legacy cell-snap
   * compare): forgiving when a ghost catches Pacman, generous when Pacman
   * eats a scared ghost.
   */
  private checkGhostContact(): void {
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

  /** Eaten scared ghost: +200, respawn at center, heading kept (legacy). */
  private eatGhost(g: Ghost): void {
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

  /**
   * Caught by a normal ghost: Pacman resets to (1,1) facing right, score kept,
   * ghosts keep roaming where they are (legacy). Lives + game over are the
   * rebuild's additions, kept.
   */
  private caught(): void {
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
    // Deflate, Baymax-style.
    this.squashKick = 1.6;
    this.softFlash();
    sfx.play("caught");
    music.duck();

    // In a race, dying is a setback, not an elimination — respawn and keep
    // grabbing pellets (the shared board keeps going regardless).
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

  // ---- round lifecycle -------------------------------------------------------

  private resetPacman(): void {
    this.reappearAge = 0;
    this.pac.x = PACMAN_SPAWN.col;
    this.pac.z = PACMAN_SPAWN.row;
    this.pac.dir = "right";
    this.pac.isMoving = false;
    this.pac.target = { x: PACMAN_SPAWN.col, z: PACMAN_SPAWN.row };
    this.stepRequested = false;
    this.mouthAngle = 0;
    this.stretchAmt = 0;
  }

  private resetGame(): void {
    this.pendingClaims.clear();
    this.hostEaten.clear();
    this.appliedEaten.clear();
    this.score = 0;
    this.graceMs = 0;
    // Online-but-alone: restarting restores every pellet locally, so the
    // shared board must start a fresh round too — otherwise the stale eaten
    // set desyncs the maze for the next rival who joins.
    if (!this.net.offline && this.net.isHost) {
      this.boardRound += 1;
      this.broadcastBoard();
    }
    this.resetBoard();
    this.resetPacman();
    this.resetRound();
    this.updateHud();
    this.beginReady();
  }

  /** Fresh solo and shared mazes retire the same local round state. */
  private resetRound(): void {
    this.ghostsChomped = 0;
    this.captureAge = CAPTURE_ECHO_S;
    this.captureEcho.visible = false;
    this.lives = START_LIVES;
    this.scaredMs = 0;
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

  private beginReady(): void {
    notifyGameStarted();
    this.readyMs = READY_MS;
    this.setPhase("ready");
    sfx.play("ready");
  }

  private setPhase(phase: Phase): void {
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
    // Instruction banners keep a watcher so controller rows appear the moment
    // a pad is plugged in (and vanish when it's pulled); other phases drop it.
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

  /** Banner copy. Split from setPhase so a pad connect/disconnect re-renders
   *  the instructions without replaying the phase's pop/confetti/sfx. The
   *  title phase teaches controls with the SAME grouped chip card the pause
   *  overlay renders (../pause-overlay buildControls); win/gameover keep their
   *  short prose state lines. */
  private renderBanner(): void {
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

  /** Soft pink full-screen blink on getting caught — feedback, not punishment. */
  private softFlash(): void {
    retrigger(this.flashEl, "on");
  }

  /** Borrow the stats pill for a transient message (e.g. music toggled). */
  private showNotice(text: string): void {
    this.statsEl.textContent = text;
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      this.updateHud();
    }, 900);
  }

  // ---- presentation (never drives the simulation) -----------------------------

  private updatePresentation(dt: number): void {
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

  /** First-round coach card: STEP then TURN, gone two seconds after both land. */
  private updateTeaching(): void {
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

  private teachingNote(blocked: boolean): string {
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

  // ---- rendering ---------------------------------------------------------------

  private renderActors(dt: number, allow: (step: UpdateStep) => boolean): void {
    const tMs = this.t * 1000;

    // Pacman rig: world position + axis-aligned squash & stretch.
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
    // Spawn-grace blink: classic readable invincibility flicker.
    this.pacRig.visible = this.graceMs <= 0 || Math.floor(tMs / 120) % 2 === 0;

    // Facing: legacy orientation (rotation reset, then one axis).
    const g = this.pacGroup;
    g.rotation.set(0, 0, 0);
    if (this.pac.dir === "up") {
      g.rotation.x = -Math.PI / 2;
    } else if (this.pac.dir === "down") {
      g.rotation.x = Math.PI / 2;
    } else if (this.pac.dir === "left") {
      g.rotation.y = Math.PI;
    }
    // right is the default orientation

    // Mouth wedge: lerp toward PI/4 while moving (legacy rate delta*10), and
    // hard-shut when stopped (legacy passed thetaLength 0 while idle).
    const target = this.pac.isMoving ? MOUTH_OPEN_ANGLE : 0;
    this.mouthAngle += (target - this.mouthAngle) * Math.min(dt * MOUTH_LERP_RATE, 1);
    this.syncMouth(this.pac.isMoving ? this.mouthAngle : 0);

    if (allow("ghosts")) {
      this.renderGhosts(dt, tMs);
    }
    if (allow("hearts")) {
      this.renderHearts();
    }
    if (allow("pellets")) {
      this.pelletField.update(this.t);
    }
  }

  /** Ghosts: staggered bob, face toward travel direction, tremble + worry
   *  while scared (blinking pale in the final stretch), grow-in after respawn. */
  private renderGhosts(dt: number, tMs: number): void {
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

  /** Pearls shimmer (instanced); power hearts breathe and twirl. */
  private renderHearts(): void {
    for (const heart of this.hearts.values()) {
      const pulse = 1 + HEART_PULSE_AMP * Math.sin(this.t * HEART_PULSE_FREQ + heart.phase);
      heart.mesh.scale.setScalar(pulse);
      heart.mesh.rotation.y = this.t * 1.6 + heart.phase;
      heart.mesh.position.y = HEART_Y + Math.sin(this.t * PELLET_BOB_FREQ + heart.phase) * 0.05;
    }
  }

  private syncMouth(angle: number): void {
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

  /**
   * Chase camera (legacy PacmanCamera): behind Pacman at -facing*2.5, y=2,
   * looking at pos+facing*2; while SHIFT is held, flip to the front at
   * +facing*2.5 looking back at pos-facing. Both position and look-at lerp
   * at 0.1 per frame, initialized to their targets on the first frame.
   * Title screen instead orbits the maze slowly. Trauma shake + FOV kick
   * are layered on after the lerp.
   */
  private updateCamera(dt: number): void {
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
    this.camCur.lerp(this.camTarget, CAMERA_SMOOTHING);
    this.lookCur.lerp(this.lookTarget, CAMERA_SMOOTHING);
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
    this.statsEl.textContent = `${hearts}  ·  ${this.pelletsLeft()} left`;
    if (this.phase === "win" || this.phase === "gameover") {
      this.renderBanner();
    }
  }
}

// ---- pure helpers ---------------------------------------------------------------
