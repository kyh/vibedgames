// The slice of the vendored game object (`window.__G`, built in
// strikeforce-core.js) that the TypeScript layer reads and drives. The core is
// plain JS, so these types are a contract kept by hand: every member here
// exists on the object the core builds, and every `[net]` hook the core calls
// is in `NetHooks`.
import type { Object3D, PerspectiveCamera, Scene, Vector3 } from "three";

export interface PlayerBody {
  pos: Vector3;
  eye: Vector3;
  vel: Vector3;
  yaw: number;
  pitch: number;
  alive: boolean;
  crouching: boolean;
  health: number;
  maxHealth: number;
  enabled: boolean;
  invulnerable: boolean;
  damage: (amount: number, from?: Vector3) => void;
  reset: (start?: { pos: Vector3; yaw: number }) => void;
}

export interface Marker {
  id: string;
  short: string;
  label: string;
  pos: Vector3;
  kind: "relay" | "extract";
}

export interface Hud {
  show: (on: boolean) => void;
  message: (text: string, secs?: number) => void;
  /** Takes HTML: escape anything that did not come from this file. */
  feed: (html: string) => void;
  warn: (text: string, secs?: number) => void;
  radio: (text: string, secs?: number) => void;
  hitmarker: (kind?: string) => void;
  setObjective: (text: string) => void;
  setTally: (text: string | null) => void;
  setMarkers: (markers: Marker[]) => void;
  /** A hold-to-use prompt; also shows the touch USE button. `progress` is 0–1. */
  setPrompt: (text: string | null, progress?: number) => void;
}

export interface Fx {
  tracer: (from: Vector3, to: Vector3, options?: { color?: number; speed?: number }) => void;
  muzzleFlash: (pos: Vector3, dir: Vector3, options?: { scale?: number }) => void;
  explosion: (pos: Vector3, size?: number) => void;
  smoke: (pos: Vector3, options?: { size?: number; life?: number; color?: number }) => void;
}

export interface GameAudio {
  play: (name: string, options: { pos?: Vector3; gain?: number; jitter?: number }) => void;
}

export type GameState = "title" | "intro" | "playing" | "paused" | "dead" | "complete";

export interface Relay {
  id: string;
  cut: boolean;
  o: { pos: Vector3; label?: string; object?: { userData: { setState?: (s: string) => void } } };
}

export interface GameFlow {
  state: GameState;
  /** `mode` is the deployed one: "deathmatch", "mission" or "holdout". */
  run: { relays: Relay[]; mode: string };
  start: (options?: { skipIntro?: boolean }) => void;
  pause: () => void;
  resume: () => void;
}

export interface Explosives {
  update: (dt: number) => void;
  reset: () => void;
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

export interface EventBus {
  on: ((name: "weapon:fire", handler: (payload: WeaponFire) => void) => () => void) &
    ((name: "player:dead", handler: () => void) => () => void) &
    ((name: "explosion", handler: (payload: { pos?: Vector3 }) => void) => () => void) &
    ((name: "game:state", handler: (payload: { state?: GameState }) => void) => () => void);
  emit: (
    name: "enemy:alert" | "enemy:fire" | "enemy:killed",
    payload: { enemy: Enemy; pos: Vector3; type: string },
  ) => void;
}

/** One of the dock's enemies, as the core's Mission/Holdout flow reads it. */
export interface Enemy {
  /** The director's kind: "gull" (many, light) or "hound" (fewer, tough). */
  readonly type: string;
  readonly pos: Vector3;
  readonly alive: boolean;
  /** Returns true when the hit killed it. `part` is "weak" for a headshot. */
  damage: (amount: number, point: Vector3, dir: Vector3, part: string) => boolean;
}

/** A shot that met an enemy, as `Enemies.raycast` reports it. */
export interface EnemyHit {
  enemy: Enemy;
  part: "weak" | "body";
  point: Vector3;
  normal: Vector3;
  dist: number;
}

/**
 * The tuning the core's difficulty presets and Holdout waves write into, by
 * the director's enemy kinds. Every key a preset sets is here.
 */
export interface EnemyTune {
  gull: {
    hp: number;
    boltDamage: number;
    telegraph: number;
    cooldown: number[];
    spreadFar: number;
    spreadNear: number;
  };
  hound: {
    hp: number;
    shotDamage: number;
    burst: number;
    cooldown: number[];
    spreadFar: number;
    spreadNear: number;
    lungeDamage: number;
    runSpeed: number;
  };
  sightRange: number;
  hearRadius: number;
  maxTokens: number;
  maxTokensCrowd: number;
  tokenGap: number;
  exposureUp: number;
}

/** The enemies module (`G.enemies`) the core's Mission/Holdout flow drives. */
export interface Enemies {
  readonly TUNE: EnemyTune;
  readonly list: Enemy[];
  readonly stub: boolean;
  update: (dt: number) => void;
  spawn: (
    type: string,
    pos: Vector3,
    options?: { state?: string; target?: Vector3 },
  ) => Enemy | null;
  raycast: (origin: Vector3, dir: Vector3, maxDist: number) => EnemyHit | null;
  aliveCount: () => number;
  clear: () => void;
  /** Something loud happened at `pos`: whoever is within `radius` comes to look. */
  alert: (pos: Vector3, radius: number) => void;
}

/** Modules the TypeScript layer hands the core at boot, in place of its own. */
export interface CoreModules {
  enemies: (game: StrikeforceGame) => Enemies;
}

export interface Physics {
  raycast: (from: Vector3, dir: Vector3, max: number) => { dist: number } | null;
  /** Nothing solid between the two points. */
  lineOfSight: (from: Vector3, to: Vector3) => boolean;
  /** The highest floor at (x, z) no higher than `below`. */
  groundHeight: (x: number, z: number, below?: number) => number;
  nav: {
    isWalkable: (x: number, z: number) => boolean;
    /** Waypoints (y = 0) from one point to another, or null when unreachable. */
    findPath: (from: Vector3, to: Vector3) => Vector3[] | null;
    /** A walkable point within `radius` of `around`. */
    randomPoint: (around: Vector3, radius: number) => Vector3;
  };
}

export interface GameInput {
  down: (action: string) => boolean;
}

export interface StrikeforceGame {
  scene: Scene;
  camera: PerspectiveCamera;
  player: PlayerBody;
  explosives: Explosives;
  /** The dock's crew: they only spawn in the solo PvE modes. */
  enemies: { list: { alive: boolean; pos: Vector3 }[] };
  hud: Hud;
  fx: Fx;
  audio: Partial<GameAudio>;
  game: GameFlow;
  events: EventBus;
  physics: Physics;
  input: GameInput;
  weapon: { reset: () => void };
  combat: { stats: { shots: number; hits: number; kills: number } };
  level: { playerStart: { pos: Vector3; yaw: number } };
  time: { t: number };
}

/** A player another client's shot struck, as `NetHooks.shoot` reports it. */
export interface ShotHit {
  point: Vector3;
  normal: Vector3;
  dist: number;
  part: "head" | "body";
  who: Object3D;
}

/** What strikeforce-core.js calls on `G.net`. */
export interface NetHooks {
  /** True in deathmatch: the core's mission flow stands down for it. */
  readonly match: boolean;
  /** Another client owns the barrels. */
  readonly guest: boolean;
  attach: (game: StrikeforceGame) => void;
  /** After every module updated, before the frame renders. */
  frame: (dt: number) => void;
  /** A local shot: the nearest enemy player hit before `maxDist`, already reported. */
  shoot: (origin: Vector3, dir: Vector3, maxDist: number, damage: number) => ShotHit | null;
  barrelHit: (index: number, damage: number, point: Vector3 | null, dir: Vector3 | null) => void;
}
