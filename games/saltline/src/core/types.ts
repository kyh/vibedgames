// The slice of the vendored game object (`window.__G`, built in saltline-core.js)
// that the TypeScript layer reads and drives. The core is plain JS, so these
// types are a contract kept by hand: every member here exists on the object the
// core builds, and every `[net]` hook the core calls is in `NetHooks`.
import type { Group, PerspectiveCamera, Scene, Vector3 } from "three";

export type EnemyType = "gull" | "hound";

export interface EnemyBody {
  id: number;
  type: EnemyType;
  pos: Vector3;
  muzzle: Vector3;
  alive: boolean;
  active: boolean;
  passive: boolean;
  mode: string;
  hp: number;
  rig: { group: Group };
  damage: (amount: number, point?: Vector3, dir?: Vector3 | null, part?: string) => boolean;
  _update: (dt: number) => void;
  _deactivate: () => void;
  /** Host: the pose a guest draws this body from. */
  _net: () => number[];
  /** Guest: draw the host's pose without running the brain. */
  _puppet: (dt: number, pose: readonly number[]) => void;
  /** Guest: hand the body over to its local death animation. */
  _kill: (dir: Vector3 | null) => void;
}

export interface EnemySpawnOptions {
  passive?: boolean;
  yaw?: number;
  hover?: number;
  state?: string;
}

export interface Enemies {
  list: EnemyBody[];
  TUNE: { hearRadius: number };
  spawn: (type: EnemyType, pos: Vector3, options?: EnemySpawnOptions) => EnemyBody | null;
  clear: () => void;
  alert: (pos: Vector3, radius?: number) => void;
  update: (dt: number) => void;
  puppet: (dt: number, step: (dt: number) => void) => void;
  netBolt: (from: Vector3, dir: Vector3) => void;
  debug: { gulls: EnemyBody[]; hounds: EnemyBody[] };
}

export interface PlayerBody {
  pos: Vector3;
  eye: Vector3;
  vel: Vector3;
  yaw: number;
  pitch: number;
  alive: boolean;
  crouching: boolean;
  speed: number;
  health: number;
  maxHealth: number;
  enabled: boolean;
  damage: (amount: number, from?: Vector3) => void;
}

/** Anything an enemy can aim at: the local body, or a squad member's stand-in. */
export interface EnemyTarget {
  pos: Vector3;
  eye: Vector3;
  vel: Vector3;
  alive: boolean;
  crouching: boolean;
  speed: number;
  damage: (amount: number, from?: Vector3) => void;
}

export interface Hud {
  message: (text: string, secs?: number) => void;
  /** Takes HTML: escape anything that did not come from this file. */
  feed: (html: string) => void;
  warn: (text: string, secs?: number) => void;
  radio: (text: string, secs?: number) => void;
  hitmarker: (kind?: string) => void;
}

export interface Fx {
  tracer: (from: Vector3, to: Vector3, options?: { color?: number; speed?: number }) => void;
  muzzleFlash: (pos: Vector3, dir: Vector3, options?: { scale?: number }) => void;
}

export interface GameAudio {
  play: (name: string, options: { pos?: Vector3; gain?: number; jitter?: number }) => void;
}

/** The host's run, as `netWorld()` reports it and `netSync()` applies it. */
export interface RunState {
  run: number;
  live: boolean;
  mode: string;
  diff: string;
  cut: string[];
  wave: number;
  waveOn: boolean;
  score: number;
  kills: number;
  cleared: number;
}

export type GameState = "title" | "intro" | "playing" | "paused" | "dead" | "complete";

export interface GameFlow {
  state: GameState;
  difficulty: string;
  run: {
    mode: string;
    time: number;
    allCut: boolean;
    wave: number;
    score: number;
    relays: { id: string; cut: boolean; t: number; o: { pos: Vector3 } }[];
  };
  start: (options?: { skipIntro?: boolean; mode?: string }) => void;
  pause: () => void;
  resume: () => void;
  worldTick: (dt: number) => void;
  netCut: (id: string) => void;
  netWorld: () => RunState;
  netSync: (run: RunState, quiet: boolean) => void;
  netRestart: () => void;
}

export interface Explosives {
  update: (dt: number) => void;
  aliveMask: () => string;
  syncMask: (mask: string) => void;
  netHit: (index: number, damage: number, point: number[] | null, dir: number[] | null) => void;
}

/** What the core's bus hands a weapon:fire listener. */
export interface WeaponFire {
  origin: Vector3;
  muzzle: Vector3;
  end: Vector3;
  weapon: string;
}

/** What the core's bus hands an enemy:* listener (and what a guest replays). */
export interface EnemyCue {
  enemy: EnemyBody;
  pos?: Vector3;
  dir?: Vector3;
  type?: EnemyType;
  time?: number;
  melee?: boolean;
  noise?: boolean;
  point?: Vector3;
  part?: string;
}

export type EnemyCueEvent = "enemy:fire" | "enemy:telegraph" | "enemy:melee" | "enemy:alert";

export interface EventBus {
  on: ((name: "weapon:fire", handler: (payload: WeaponFire) => void) => () => void) &
    ((name: EnemyCueEvent, handler: (payload: EnemyCue) => void) => () => void) &
    ((name: "run:reset", handler: () => void) => () => void);
  emit: ((name: EnemyCueEvent | "enemy:hit", payload: EnemyCue) => void) &
    ((name: "player:hitEnemy", payload: { enemy: EnemyBody; killed: boolean }) => void);
}

export interface Physics {
  raycast: (from: Vector3, dir: Vector3, max: number) => { dist: number } | null;
}

export interface SaltlineGame {
  scene: Scene;
  camera: PerspectiveCamera;
  player: PlayerBody;
  enemies: Enemies;
  explosives: Explosives;
  hud: Hud;
  fx: Fx;
  audio: Partial<GameAudio>;
  game: GameFlow;
  events: EventBus;
  physics: Physics;
  combat: { stats: { shots: number; hits: number; kills: number } };
  level: { playerStart: { pos: Vector3 }; extraction?: { pos: Vector3 } };
  time: { t: number };
}

/** What saltline-core.js calls on `G.net`. */
export interface NetHooks {
  /** Not alone: a host with a squad, or a guest. */
  readonly coop: boolean;
  /** Another client simulates the machines and owns the run. */
  readonly guest: boolean;
  /** The run's mode, for a guest deploying into it. */
  readonly hostMode: string | null;
  attach: (game: SaltlineGame) => void;
  /** After every module updated; `simulated` is the loop's own "world ran" flag. */
  frame: (dt: number, simulated: boolean) => void;
  /** Bodies a drone's bolt can hit. */
  targets: () => EnemyTarget[];
  keepWorld: () => boolean;
  worldEvent: (kind: "warn", text: string) => void;
  requestCut: (relayId: string) => void;
  barrelHit: (index: number, damage: number, point: Vector3 | null, dir: Vector3 | null) => void;
}
