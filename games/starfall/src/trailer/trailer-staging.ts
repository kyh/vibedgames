// Trailer-mode staging contract between GameScene and the trailer director.
//
// GameScene holds ONE nullable `TrailerStaging` field (null outside ?trailer=1,
// so every guard is dead in normal play). The director writes the per-frame
// override fields; `GameScene.trailerStage()` installs the staging and returns
// the `TrailerStageApi` closures, all of which route through the exact code
// paths real gameplay uses (spawn factories, hostDamageEnemy, gainXp, die).
// Types only — this module has no runtime cost in the game bundle.

import type { PlayerMap } from "@vibedgames/multiplayer";

import type { BoosterKind, EnemyKind, EnemyState, Vec } from "../shared/constants";

/** Scripted steering for this frame. `thrust` 0 keeps the nose aimed while the
 *  brake drag bleeds speed (the authentic kiting flip). Null = coast. */
export type TrailerSteer = { angle: number; thrust: number } | null;

/** Live per-frame overrides the director owns while trailer mode is active.
 *  While installed, the real input sources (pointer/keys/pads) are never read
 *  — a stray cursor can't steal the ship mid-take. */
export type TrailerStaging = {
  steer: TrailerSteer;
  fire: boolean;
  /** Camera center override; null = follow the ship. */
  camPos: Vec | null;
  /** Fake offline peer map (must include the synthesized `solo` self entry).
   *  Entries flow through the real remote-player pipeline: ship gfx, shield
   *  rings, beams, AI targeting, beacon occupancy. Null = solo only. */
  peers: PlayerMap | null;
};

export type TrailerPlayerView = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  alive: boolean;
  level: number;
  shieldHp: number;
};

/** Staging levers returned by `GameScene.trailerStage()`. */
export type TrailerStageApi = {
  staging: TrailerStaging;
  /** Force the offline solo session + dismiss the start overlay (idempotent). */
  forceStart(): void;
  /** Fully re-stage: wipe hostiles/loot/beacon (display objects dropped
   *  SILENTLY — no death FX), reset the arena epoch (keeps the organic
   *  director asleep) and the pilot's combat state. Asteroids stay (ambience). */
  clearWorld(): void;
  /** Place (and if needed revive) the ship, snap the camera to it. */
  setPlayerPose(pose: { x: number; y: number; angle?: number; vx?: number; vy?: number }): void;
  /** Set level + xp-into-level and apply the level's base loadout. */
  setLevel(level: number, xpIntoLevel?: number): void;
  /** Equip a special weapon by exact name (WEAPONS_SPECIAL). */
  grantWeapon(name: string): void;
  grantBooster(kind: BoosterKind): void;
  /** Real XP through gainXp — crossing a threshold fires the level-up FX. */
  grantXp(amount: number): void;
  /** Quiet shield write (no damage pipeline, no death) — the reliability
   *  top-up for staged crowd scenes. */
  setShieldHp(hp: number): void;
  /** Real death through die(): shatter, flash, trauma, death HUD, XP tax. */
  killPlayer(cause: string): void;
  /** Spawn through the real factory; elites get the level-scaled HP stamp,
   *  the dreadnought gets bossHp(). Returns the entity id. */
  spawnEnemy(kind: EnemyKind, x: number, y: number, aimAt?: Vec): string;
  /** Direct HP write (≥1) — e.g. park the boss in phase 3. */
  setEnemyHp(id: string, hp: number): void;
  /** Real damage pipeline (kill FX + loot at ≤0). */
  damageEnemy(id: string, amount: number): void;
  spawnBeacon(x: number, y: number, chargeS: number, activeS: number): void;
  spawnShards(count: number, x: number, y: number): void;
  enemies(): ReadonlyArray<Readonly<EnemyState>>;
  player(): TrailerPlayerView;
  worldSize(): { w: number; h: number };
};
