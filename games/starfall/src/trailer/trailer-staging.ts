// Trailer-mode staging contract between GameScene and the trailer director.
//
// GameScene holds ONE nullable `TrailerStaging` field (null outside ?trailer=1,
// so every guard is dead in normal play). The director writes the per-frame
// override fields; `GameScene.trailerStage()` installs the staging and returns
// the `TrailerStageApi` closures, all of which route through the exact code
// paths real gameplay uses (spawn factories, hostDamageEnemy, gainXp, die).
// Types only — this module has no runtime cost in the game bundle.

import type { PlayerMap } from "@vibedgames/multiplayer";

import type {
  BoosterKind,
  EnemyKind,
  EnemyState,
  LootClass,
  ShieldModKind,
  Vec,
} from "../shared/constants";

/** Scripted steering for this frame. `thrust` 0 keeps the nose aimed while the
 *  brake drag bleeds speed (the authentic kiting flip). Null = coast. */
export type TrailerSteer = { angle: number; thrust: number } | null;

/** Live per-frame overrides the director owns while trailer mode is active.
 *  While installed, the real input sources (pointer/keys/pads) are never read
 *  — a stray cursor can't steal the ship mid-take. */
export type TrailerStaging = {
  steer: TrailerSteer;
  fire: boolean;
  /**
   * While true, a drain that would zero the shield leaves 1hp instead of
   * killing. Staged crowds still land REAL hits — the arcs, the flash, the
   * sfx, the drain — but a scene with no death beat can never lose its pilot
   * to luck. Nothing else can make that guarantee: enemy shots bypass contact
   * i-frames and several can resolve inside one sim step, so any top-up the
   * director applies between frames races the stack. Only the death-beat scene
   * clears this.
   */
  deathless: boolean;
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
  /** Live weapon name (what the HUD reads). A scene that stages a pickup has
   *  to branch on the loadout actually changing, not on being near the drop. */
  weapon: string;
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
  /** Drop every rock, silently. clearWorld() deliberately spares asteroids, so
   *  without this a rock staged for shot 3 is still parked in shot 11 — and
   *  since every shot now composes its own rock field (see dressRocks), the
   *  leftovers stack up into a debris wall nobody framed. */
  clearAsteroids(): void;
  /** Place (and if needed revive) the ship, snap the camera to it. */
  setPlayerPose(pose: { x: number; y: number; angle?: number; vx?: number; vy?: number }): void;
  /** Set level + xp-into-level and apply the level's base loadout. */
  setLevel(level: number, xpIntoLevel?: number): void;
  /** Write xp-into-level WITHOUT touching the loadout. The level-up ring is
   *  one scene's named beat; a shot that clears a picket at Lv1 earns enough
   *  to cross the threshold twice over and would fire that beat two cuts
   *  early, so those scenes hold the bar down. */
  setXp(xpIntoLevel: number): void;
  /** Equip a special weapon by exact name (WEAPONS_SPECIAL). */
  grantWeapon(name: string): void;
  grantBooster(kind: BoosterKind): void;
  /** Equip a shield MODIFIER (the defensive half of the loadout). clearWorld()
   *  nulls the mod, so scenes grant AFTER staging. */
  grantShieldMod(kind: ShieldModKind): void;
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
  /** Kill outright through the real payout path (boss XP fountain + its two
   *  guaranteed crystals, splitter children, elite drops). The ONLY way to
   *  land a boss kill inside a shot: hostDamageEnemy clamps boss damage to the
   *  current phase's HP boundary for BOSS_PHASE_MIN_MS = 8s, so no amount of
   *  damageEnemy() can finish it in trailer time. */
  killEnemy(id: string): void;
  /** Place a real loot crystal through the drop factory — the pickup beat has
   *  to be deterministic, and the organic roll is weighted RNG. Staged drops
   *  are parked (no drift): the real factory's 30 px/s scatter is enough to
   *  walk a crystal out of the 15px pickup radius during the approach. */
  spawnItem(cls: LootClass, name: string, x: number, y: number): void;
  /** Drop a parked rock at a chosen size. The arena seeds only 7 across
   *  3840×2160, so ambient rocks can never be relied on to be in frame;
   *  chip/shrink/burst then run through the real hostDamageAsteroid. Drift is
   *  zeroed because the factory draws its angle from the seeded gameplay RNG,
   *  whose stream position depends on frame timing — a drifting staged rock is
   *  not reproducible, and the two shots that need rocks need them placed. */
  spawnAsteroid(x: number, y: number, radius: number): void;
  spawnBeacon(x: number, y: number, chargeS: number, activeS: number): void;
  spawnShards(count: number, x: number, y: number): void;
  enemies(): ReadonlyArray<Readonly<EnemyState>>;
  player(): TrailerPlayerView;
  worldSize(): { w: number; h: number };
};
