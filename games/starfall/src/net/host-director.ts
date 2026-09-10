import { Math as PhaserMath } from "phaser";
import { now as simNow } from "../shared/clock";
import {
  ASTEROID_CULL_MARGIN,
  BEACON_ACTIVE_S,
  BEACON_CHARGE_S,
  BEACON_EDGE_MARGIN,
  BEACON_LURE_FRACTION,
  BEACON_LURE_RING_MAX,
  BEACON_LURE_RING_MIN,
  BEACON_MIN_INTERVAL_S,
  BEACON_MIN_T_S,
  BEACON_PLAYER_CLEARANCE,
  BEACON_RADIUS,
  BEACON_SPAWN_WINDOW_S,
  BEACON_TROUGH_PERIOD_S,
  BOSS_SPAWN_COOLDOWN_MS,
  BOSS_SPAWN_INTENSITY,
  BOSS_SPAWN_MIN_PLAYERS,
  EARLY_FODDER_KINDS,
  EARLY_FODDER_SEED_COUNT,
  EARLY_SEED_RING_MAX,
  EARLY_SPAWN_INTERVAL_MS,
  EARLY_SPAWN_RING_MAX,
  EARLY_SPAWN_WINDOW_S,
  ELITE_HP_BASE,
  ENEMY_DEBUT_SUPPRESS_MS,
  ENEMY_DESPAWN_INTERVAL_MS,
  ENEMY_DESPAWN_MIN_DIST,
  ENEMY_DESPAWN_SLACK,
  ENEMY_KINDS,
  ENEMY_SPAWN_CLEARANCE,
  ITEM_SPEED,
  MAGNET_PULL_SPEED,
  NET_INTERVAL_MS,
  SECTOR_BOSS_AT_S,
  SHARD_DRIFT_SPEED,
  SHARD_MAGNET_PULL_SPEED,
  SINGULARITY_PULL_RANGE,
  SINGULARITY_PULL_SPEED,
  UFO_SPAWN_RATE,
  arenaIntensity,
  asteroidCap,
  asteroidSpawnIntervalMs,
  bossHp,
  edgeSpawn,
  eliteHp,
  enemyCap,
  enemySpawnIntervalMs,
  enemySpawnWeight,
  playHeightForPlayers,
  playWidthForPlayers,
  playerPressure,
  randomWorldPoint,
  ringSpawnPoint,
  sectorIdx,
  sectorRelT,
  spawnAsteroidState,
  spawnEnemyState,
  spawnUfoState,
  wavePulse,
} from "../shared/constants";
import type { EnemyKind, SharedState, Vec } from "../shared/constants";
import { rand } from "../shared/rng";
import {
  asteroidToWire,
  beaconToWire,
  enemyShotToWire,
  enemyToWire,
  itemToWire,
  pullToWire,
  shardToWire,
  ufoToWire,
} from "../shared/wire";
import { setAllDirty } from "../state/dirty-flags";
import type { DirtyFlags } from "../state/dirty-flags";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import type { EnemyAi } from "../sys/enemy-ai";
import { inWorld, magnetPull } from "../sys/geometry";
import type { Progression } from "../sys/progression";
import type { HostCombat } from "./host-combat";
import type { sharedToPatch } from "./shared-world";

/** Late-built collaborators the director consults. */
export interface HostDirectorHooks {
  /** WorldSync.prepareHost — adopt the accepted room world before any host tick/command (sync is built after the director). */
  prepareHost: () => boolean;
  /** My PHASE shield-mod window end (Shield is built after the director). */
  phasedUntil: () => number;
}

/** Host suppresses enemy spawns for the arena's first seconds (safe opening). */
export const ARENA_SAFE_MS = 6000;

export const weightedEnemyRoll = (
  kinds: readonly EnemyKind[],
  intensity: number,
): EnemyKind | null => {
  let total = 0;
  for (const k of kinds) {
    total += enemySpawnWeight(k, intensity);
  }
  if (total <= 0) {
    return null;
  }
  let roll = rand() * total;
  for (const k of kinds) {
    roll -= enemySpawnWeight(k, intensity);
    if (roll <= 0) {
      return k;
    }
  }
  return kinds.at(-1) ?? null;
};

export interface HostDirectorDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  dirty: DirtyFlags;
  ai: EnemyAi;
  hostCombat: HostCombat;
  progress: Progression;
  hooks: HostDirectorHooks;
}

/** Host-only world director: the authoritative tick (asteroid/UFO/enemy spawn cadence, pulls, magnets, breathers, boss guarantee, BEACON control) and the dirty-flag share of the world to guests. */
export class HostDirector {
  // boss (host-private; recomputed from the world each tick so migration adopts it)
  bossAlive = false;

  lastBossKilledAt = 0;

  /** Set when host grows the play bounds — flushed into the next shared patch. */
  private playBoundsDirty = false;

  private shareAcc = 0;

  lastAsteroidSpawnAt = 0;

  lastEnemySpawnAt = 0;

  /** False until our first hostTick — promotion stamps the spawn clocks. */
  wasHost = false;

  private lastBreatherDespawnAt = 0;

  private debuted = new Set<EnemyKind>();

  private debutSuppressUntil = 0;

  /** BEACON cadence clock (host-local): last beacon START. A promoted host
   *  re-derives it from a live beacon's timestamps, or stamps `now` when none
   *  is live (worst case one trough of extra delay after a migration). */
  private lastBeaconStartedAt = 0;

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly dirty: DirtyFlags;

  private readonly ai: EnemyAi;

  private readonly hostCombat: HostCombat;

  private readonly progress: Progression;

  private readonly hooks: HostDirectorHooks;

  constructor(deps: HostDirectorDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.dirty = deps.dirty;
    this.ai = deps.ai;
    this.hostCombat = deps.hostCombat;
    this.progress = deps.progress;
    this.hooks = deps.hooks;
  }

  hostTick(now: number, dt: number, delta: number): void {
    if (!this.hooks.prepareHost()) {
      return;
    }
    if (!this.wasHost) {
      this.hostAdoptClocks(now);
    }
    const w = this.world;
    const d = this.dirty;
    const tSec = Math.max(0, (now - w.arenaEpoch) / 1000);
    const intensity = arenaIntensity(tSec);
    const pc = Math.max(1, Object.keys(this.link.peers).length);
    const pressure = playerPressure(pc);
    const wave = wavePulse(tSec);
    // Grow the play area with player count (grow-only within an arena, so it
    // never yanks ships inward; resets to BASE on a fresh arena). Broadcast on
    // change so every client clamps/spawns/culls to the same bounds.
    const wantW = playWidthForPlayers(pc);
    if (wantW > w.playW) {
      w.playW = wantW;
      w.playH = playHeightForPlayers(pc);
      this.playBoundsDirty = true;
    }
    this.hostTickAsteroids(now, intensity, pressure, wave);
    this.hostTickUfo(now, dt);
    this.hostTickPickups(now);

    // One living-players snapshot for the whole tick (spawn/boss/sim/breather).
    const players = this.livingPlayers();
    this.hostTickBeacon(now, tSec, players);
    this.hostSpawnEnemies(now, tSec, intensity, pressure, wave, players);
    this.hostMaybeSpawnBoss(now, intensity, players);
    this.ai.hostSimEnemies(now, dt, players);
    // After the sim: the pull overrides steering for dragged enemies.
    this.hostApplyPulls(now);
    const livePulls = w.pulls.filter((p) => p.until > now);
    if (livePulls.length !== w.pulls.length) {
      w.pulls = livePulls;
      d.pulls = true;
    }
    // Trailer: staged crowds are deliberately far over the cap and the wide
    // zooms put the despawn line on camera — never cull them mid-shot.
    if (!this.link.trailer) {
      this.hostDespawnBreather(now, intensity, pressure, wave, players);
    }

    const liveShots = w.enemyShots.filter(
      (s) => s.diesAt > now && inWorld(s.x, s.y, 60, w.playW, w.playH),
    );
    if (liveShots.length !== w.enemyShots.length) {
      w.enemyShots = liveShots;
      d.enemyShots = true;
    }
    this.hostMarkMotionDirty();

    this.shareAcc += delta;
    if (this.shareAcc < NET_INTERVAL_MS) {
      return;
    }
    this.shareAcc = 0;
    this.hostShareWorld();
  }

  /** First tick after promotion (or first-ever host): zeroed spawn stamps
   *  would read as long-overdue and burst-spawn. Start intervals from now. */
  private hostAdoptClocks(now: number): void {
    this.wasHost = true;
    this.lastAsteroidSpawnAt = now;
    this.lastEnemySpawnAt = now;
    // Recover the beacon cadence clock: a live beacon carries its own start
    // (activeAt − CHARGE); with none live, a mid-run promotion stamps `now`
    // (worst case one trough of extra delay) while a fresh arena keeps 0 so
    // the first beacon still lands at t≈90.
    const b = this.world.beacon;
    if (b) {
      this.lastBeaconStartedAt = b.activeAt - BEACON_CHARGE_S * 1000;
    } else if ((now - this.world.arenaEpoch) / 1000 >= BEACON_MIN_T_S) {
      this.lastBeaconStartedAt = now;
    }
  }

  private hostTickAsteroids(now: number, intensity: number, pressure: number, wave: number): void {
    const w = this.world;
    if (
      w.asteroids.length < asteroidCap(intensity, pressure, wave) &&
      now - this.lastAsteroidSpawnAt > asteroidSpawnIntervalMs(intensity)
    ) {
      w.asteroids.push(spawnAsteroidState(w.playW, w.playH));
      this.lastAsteroidSpawnAt = now;
      this.dirty.asteroids = true;
    }
    const kept = w.asteroids.filter((a) =>
      inWorld(a.x, a.y, ASTEROID_CULL_MARGIN, w.playW, w.playH),
    );
    if (kept.length !== w.asteroids.length) {
      w.asteroids = kept;
      this.dirty.asteroids = true;
    }
  }

  /** UFO is the weapon piñata; the v2 gate relaxes to < 2 weapon items live.
   *  Trailer mode: never — a wandering piñata (and its weapon drop landing
   *  in the player's pickup radius) would derail a staged shot. */
  private hostTickUfo(now: number, dt: number): void {
    const w = this.world;
    const weaponItemsInFlight = w.items.filter((it) => it.kind === "weapon").length;
    if (!w.ufo && !this.link.trailer && weaponItemsInFlight < 2 && rand() < UFO_SPAWN_RATE * dt) {
      w.ufo = spawnUfoState(w.playW, w.playH);
      this.dirty.ufo = true;
    }
    if (w.ufo && w.ufo.x === w.ufo.destX && w.ufo.y === w.ufo.destY) {
      w.ufo.destX = rand() * w.playW;
      w.ufo.destY = rand() * w.playH;
      this.dirty.ufo = true;
    }
  }

  /** Expire items + shards, then run the magnet pass. */
  private hostTickPickups(now: number): void {
    const w = this.world;
    const liveItems = w.items.filter((it) => it.diesAt > now);
    if (liveItems.length !== w.items.length) {
      w.items = liveItems;
      this.dirty.items = true;
    }
    const liveShards = w.shards.filter((s) => s.diesAt > now);
    if (liveShards.length !== w.shards.length) {
      w.shards = liveShards;
      this.dirty.shards = true;
    }
    this.hostMagnetItems(now);
  }

  /** Continuous motion dirties whatever is actually moving. */
  private hostMarkMotionDirty(): void {
    const w = this.world;
    const d = this.dirty;
    if (w.asteroids.length > 0) {
      d.asteroids = true;
    }
    if (w.ufo) {
      d.ufo = true;
    }
    if (w.items.length > 0) {
      d.items = true;
    }
    if (w.shards.length > 0) {
      d.shards = true;
    }
    if (w.enemies.length > 0) {
      d.enemies = true;
    }
    if (w.enemyShots.length > 0) {
      d.enemyShots = true;
    }
  }

  /** Send the dirty fields as one shallow-merge patch, then clear the flags. */
  private hostShareWorld(): void {
    const w = this.world;
    const d = this.dirty;
    // Quantize at the serialization boundary (shared/wire.ts) — the working
    // arrays keep full precision, only the outgoing snapshot is rounded.
    const patch: Partial<ReturnType<typeof sharedToPatch>> = {};
    if (d.asteroids) {
      patch["asteroids"] = w.asteroids.map(asteroidToWire);
    }
    if (d.ufo) {
      patch["ufo"] = w.ufo ? ufoToWire(w.ufo) : null;
    }
    if (d.items) {
      patch["items"] = w.items.map(itemToWire);
    }
    if (d.shards) {
      patch["shards"] = w.shards.map(shardToWire);
    }
    if (d.enemies) {
      patch["enemies"] = w.enemies.map(enemyToWire);
    }
    if (d.enemyShots) {
      patch["enemyShots"] = w.enemyShots.map(enemyShotToWire);
    }
    if (d.pulls) {
      patch["pulls"] = w.pulls.map(pullToWire);
    }
    if (d.beacon) {
      patch["beacon"] = w.beacon ? beaconToWire(w.beacon) : null;
    }
    // Piggyback play bounds on ANY outgoing patch (cheap — 2 ints) so guests and
    // a freshly-promoted host stay in sync; force a send if ONLY bounds changed.
    if (this.playBoundsDirty || Object.keys(patch).length > 0) {
      patch["playW"] = w.playW;
      patch["playH"] = w.playH;
      // Boss-guarantee marker rides along too (1 int): any spawn dirties
      // enemies, so the marker always reaches guests within the same patch.
      patch["sectorBossIdx"] = w.sectorBossIdx;
    }
    this.playBoundsDirty = false;
    if (Object.keys(patch).length > 0) {
      this.link.patchShared(patch);
    }
    setAllDirty(this.dirty, false);
  }

  /** Next share sends the whole world (bounds and boss marker included). */
  markWorldDirty(): void {
    setAllDirty(this.dirty, true);
    this.playBoundsDirty = true;
  }

  /** Boss down: free the arena-wide slot and arm the spawn cooldown. */
  noteBossKilled(now: number): void {
    this.bossAlive = false;
    this.lastBossKilledAt = now;
  }

  /** Alive+present players with ids — the beacon control census. Phased ships
   *  still count (they are IN the arena; only enemy targeting ignores them). */
  private beaconOccupants(cx: number, cy: number): string[] {
    const out: string[] = [];
    const { myId } = this.link;
    if (
      myId &&
      this.pilot.alive &&
      this.pilot.spawned &&
      Math.hypot(this.pilot.shipX - cx, this.pilot.shipY - cy) <= BEACON_RADIUS
    ) {
      out.push(myId);
    }
    for (const [id, st] of this.link.peerStates) {
      if (id === myId || !st || !st.alive || !st.present) {
        continue;
      }
      if (Math.hypot(st.x - cx, st.y - cy) <= BEACON_RADIUS) {
        out.push(id);
      }
    }
    return out;
  }

  /** Spawn eligibility + placement + the per-tick control read + the expiry
   *  payout. Phases themselves are DERIVED from the shared timestamps (never
   *  stored), so a promoted host resumes mid-phase from the snapshot alone. */
  private hostTickBeacon(now: number, tSec: number, players: Vec[]): void {
    const w = this.world;
    const b = w.beacon;
    if (b) {
      if (now >= b.diesAt) {
        // Expiry. Sole controller at the moment of death → the hold payout
        // crystal (guaranteed, pity-fed like an elite kill, cap-bypassed like
        // a UFO drop so it can never be silently skipped). The 40 XP bonus is
        // owner-simulated client-side off this same final snapshot; the gold
        // shockwave fx is drawn by every client in tickBeaconClient.
        if (b.controllerId !== null && !b.contested) {
          this.hostCombat.hostRollLoot(b.x, b.y, 1, true, true);
        }
        w.beacon = null;
        this.dirty.beacon = true;
        return;
      }
      if (now >= b.activeAt) {
        // ACTIVE: 0 inside → uncontrolled; 1 → controls; 2+ → contested.
        const occ = this.beaconOccupants(b.x, b.y);
        const controllerId = occ.length === 1 ? (occ[0] ?? null) : null;
        const contested = occ.length >= 2;
        if (controllerId !== b.controllerId || contested !== b.contested) {
          b.controllerId = controllerId;
          b.contested = contested;
          this.dirty.beacon = true;
        }
      }
      return;
    }
    // No beacon live: eligible only in the trough window of the intensity
    // director's macro wave, never in the opening 90s, and ≥180s start-to-
    // start (the spec's twice-stated t≈90/270/450 cadence — every other
    // trough; measured start-to-start, end-to-next-start comes to ~132s).
    // dir-006: the old global t>=90 gate generalizes to sector-relative time —
    // identical in sector 1; in later sectors it keeps the recap beat and the
    // fresh-start breath beacon-free. (540 = 6x90, so the trough window below
    // stays phase-locked to the same sector-relative times every sector.)
    if (sectorRelT(tSec) < BEACON_MIN_T_S) {
      return;
    }
    // dir-006: one "be HERE now" at a time — no NEW beacon while a dreadnought
    // is alive. A beacon already live completes normally (block above); the
    // deferred slot is not queued — the next eligible trough after boss death
    // picks the cadence back up through these same gates.
    if (w.enemies.some((e) => e.kind === "dreadnought")) {
      return;
    }
    if (tSec % BEACON_TROUGH_PERIOD_S > BEACON_SPAWN_WINDOW_S) {
      return;
    }
    if (
      this.lastBeaconStartedAt > 0 &&
      now - this.lastBeaconStartedAt < BEACON_MIN_INTERVAL_S * 1000
    ) {
      return;
    }
    // Placement: ≥600px inside the barrier, ≥900px from every present player
    // (fair approach run); crowded arenas take the candidate farthest from
    // the nearest player.
    let best: Vec | null = null;
    let bestClearance = -1;
    for (let i = 0; i < 12; i += 1) {
      const c = randomWorldPoint(BEACON_EDGE_MARGIN, BEACON_EDGE_MARGIN, w.playW, w.playH);
      let nearest = Infinity;
      for (const p of players) {
        nearest = Math.min(nearest, Math.hypot(p.x - c.x, p.y - c.y));
      }
      if (nearest > bestClearance) {
        bestClearance = nearest;
        best = c;
      }
      if (nearest >= BEACON_PLAYER_CLEARANCE) {
        break;
      }
    }
    if (!best) {
      return;
    }
    this.hostSpawnBeacon(best.x, best.y, now);
  }

  /** Create the shared beacon entry (also the dev-hook entrypoint; custom
   *  charge/active lengths are for compressed-timer e2e probes only). */
  hostSpawnBeacon(
    x: number,
    y: number,
    now: number,
    chargeS = BEACON_CHARGE_S,
    activeS = BEACON_ACTIVE_S,
  ): void {
    this.world.beacon = {
      activeAt: now + chargeS * 1000,
      contested: false,
      controllerId: null,
      diesAt: now + (chargeS + activeS) * 1000,
      x,
      y,
    };
    this.lastBeaconStartedAt = now;
    this.dirty.beacon = true;
  }

  /** Position of a player by id (me from the live ship, remotes from their
   *  net state). Null when unknown/absent. */
  playerPos(id: string): Vec | null {
    if (id === this.link.myId) {
      return this.pilot.spawned && this.pilot.alive
        ? { x: this.pilot.shipX, y: this.pilot.shipY }
        : null;
    }
    const st = this.link.peerStates.get(id);
    return st && st.alive ? { x: st.x, y: st.y } : null;
  }

  /**
   * SINGULARITY drag (host-only): for every live pull, point asteroid and
   * enemy velocities at the center. Speed scales down near the center
   * (d/100 clamp) so bodies gather at the point instead of slingshotting
   * through; the dragged velocities ride the normal snapshots, so guests
   * dead-reckon the same motion.
   */
  private hostApplyPulls(now: number): void {
    for (const p of this.world.pulls) {
      if (p.until <= now) {
        continue;
      }
      for (const a of this.world.asteroids) {
        const d = Math.hypot(p.x - a.x, p.y - a.y);
        if (d > SINGULARITY_PULL_RANGE || d < 1) {
          continue;
        }
        const sp = SINGULARITY_PULL_SPEED * Math.min(1, Math.max(0.15, d / 100));
        a.vx = ((p.x - a.x) / d) * sp;
        a.vy = ((p.y - a.y) / d) * sp;
      }
      for (const e of this.world.enemies) {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d > SINGULARITY_PULL_RANGE || d < 1) {
          continue;
        }
        const sp = SINGULARITY_PULL_SPEED * Math.min(1, Math.max(0.15, d / 100));
        e.vx = ((p.x - e.x) / d) * sp;
        e.vy = ((p.y - e.y) / d) * sp;
      }
    }
  }

  /**
   * MAGNET (host-side: items + shards are host-owned): steer any item within
   * range of a magnet holder toward them at 140 px/s; shards get pulled
   * harder (SHARD_MAGNET_PULL_SPEED); back to drift speed outside.
   * Holders are read from per-player `boosts` state (mine locally).
   */
  private hostMagnetItems(now: number): void {
    const w = this.world;
    if (w.items.length === 0 && w.shards.length === 0) {
      return;
    }
    const holders = this.magnetHolders(now);
    if (holders.length === 0) {
      return;
    }
    for (const it of w.items) {
      magnetPull(it, holders, MAGNET_PULL_SPEED, ITEM_SPEED);
    }
    this.dirty.items = true;
    for (const sd of w.shards) {
      magnetPull(sd, holders, SHARD_MAGNET_PULL_SPEED, SHARD_DRIFT_SPEED);
    }
    this.dirty.shards = true;
  }

  /** Positions of every living ship with a live MAGNET booster. */
  private magnetHolders(now: number): Vec[] {
    const holders: Vec[] = [];
    const mine = this.pilot.boosts.get("magnet");
    if (mine !== undefined && mine > now && this.pilot.alive && this.pilot.spawned) {
      holders.push({ x: this.pilot.shipX, y: this.pilot.shipY });
    }
    const { myId } = this.link;
    for (const [id, st] of this.link.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive) {
        continue;
      }
      if (st.boosts.some((b) => b.kind === "magnet" && b.until > now)) {
        holders.push({ x: st.x, y: st.y });
      }
    }
    return holders;
  }

  /** Highest level among present players in the local view (default 1 when
   *  unknowable). Drives elite HP stamping at spawn (host) and elite kill XP
   *  (shooter) — qa-018: the same multiplier moves cost and reward together. */
  maxPresentLevel(): number {
    let max = this.pilot.spawned ? this.progress.level : 1;
    const { myId } = this.link;
    for (const [id, st] of this.link.peerStates) {
      if (id === myId || !st || !st.present) {
        continue;
      }
      if (st.level > max) {
        max = st.level;
      }
    }
    return Math.max(1, max);
  }

  /** Living player positions (mine locally + remotes from net state). */
  private livingPlayers(): Vec[] {
    const out: Vec[] = [];
    if (this.pilot.alive && this.pilot.spawned && simNow() >= this.hooks.phasedUntil()) {
      out.push({ x: this.pilot.shipX, y: this.pilot.shipY });
    }
    const { myId } = this.link;
    for (const [id, st] of this.link.peerStates) {
      if (id === myId) {
        continue;
      }
      if (st && st.alive && !st.shieldMod?.phased) {
        out.push({ x: st.x, y: st.y });
      }
    }
    return out;
  }

  private hostSpawnEnemies(
    now: number,
    tSec: number,
    intensity: number,
    pressure: number,
    wave: number,
    players: Vec[],
  ): void {
    // safe opening
    if (tSec * 1000 < ARENA_SAFE_MS) {
      return;
    }
    if (now < this.debutSuppressUntil) {
      return;
    }
    const w = this.world;
    const early = tSec < EARLY_SPAWN_WINDOW_S;
    if (early && !this.debuted.has("drone") && w.enemies.length === 0 && players.length > 0) {
      this.hostSeedDebutWave(now, players);
      return;
    }
    if (w.enemies.length >= enemyCap(intensity, pressure, wave)) {
      return;
    }
    const interval = early
      ? Math.min(enemySpawnIntervalMs(intensity), EARLY_SPAWN_INTERVAL_MS)
      : enemySpawnIntervalMs(intensity);
    if (now - this.lastEnemySpawnAt < interval) {
      return;
    }
    const pick = this.pickSpawnKind(intensity);
    if (!pick) {
      return;
    }
    const { kind, isDebut } = pick;
    const placed = this.placeEnemySpawn(kind, early, players);
    // skip this tick
    if (!placed) {
      return;
    }
    const e = spawnEnemyState(kind, placed.x, placed.y);
    e.angle = placed.ang;
    // qa-018: elites are stamped to the room's beam-DPS ceiling at spawn (the
    // exact bossHp pattern). Stamped ONCE — leveling never retro-buffs a live
    // elite. Fodder, sniper and the boss keep their spec hp.
    if (ELITE_HP_BASE.has(kind)) {
      e.hp = eliteHp(kind, this.maxPresentLevel());
      e.maxHp = e.hp;
    }
    w.enemies.push(e);
    this.lastEnemySpawnAt = now;
    this.dirty.enemies = true;
    if (isDebut) {
      this.debuted.add(kind);
      this.debutSuppressUntil = now + ENEMY_DEBUT_SUPPRESS_MS;
    }
  }

  /** Early debut wave: the moment the safe opening ends, seed a few drones in
   *  the convergence ring at once so the arena's first threats are already
   *  visibly inbound. This IS the drone debut (suppression follows as usual). */
  private hostSeedDebutWave(now: number, players: Vec[]): void {
    const w = this.world;
    for (let i = 0; i < EARLY_FODDER_SEED_COUNT; i += 1) {
      const placed = this.ringPlacementNear(players, EARLY_SEED_RING_MAX);
      if (!placed) {
        break;
      }
      const e = spawnEnemyState("drone", placed.x, placed.y);
      e.angle = placed.ang;
      w.enemies.push(e);
    }
    this.debuted.add("drone");
    this.debutSuppressUntil = now + ENEMY_DEBUT_SUPPRESS_MS;
    this.lastEnemySpawnAt = now;
    this.dirty.enemies = true;
  }

  /** Debut rule: a type's first appearance is solo + suppresses other spawns;
   *  otherwise a weighted roll over the kinds live at this intensity. */
  private pickSpawnKind(intensity: number): { kind: EnemyKind; isDebut: boolean } | null {
    const avail = ENEMY_KINDS.filter((k) => enemySpawnWeight(k, intensity) > 0);
    if (avail.length === 0) {
      return null;
    }
    const debut = avail.find((k) => !this.debuted.has(k));
    if (debut) {
      return { isDebut: true, kind: debut };
    }
    const kind = weightedEnemyRoll(avail, intensity);
    return kind ? { isDebut: false, kind } : null;
  }

  /** Where a fresh spawn lands: early-window fodder converges via the ring
   *  outside a player's viewport; a live BEACON lures half of spawns onto a
   *  ring around it (bias only — caps, weights and intervals are untouched);
   *  everything else takes the far edge entrance. */
  private placeEnemySpawn(
    kind: EnemyKind,
    early: boolean,
    players: Vec[],
  ): { x: number; y: number; ang: number } | null {
    const w = this.world;
    let placed: { x: number; y: number; ang: number } | null = null;
    if (early && EARLY_FODDER_KINDS.includes(kind) && players.length > 0) {
      placed = this.ringPlacementNear(players);
    }
    const { beacon } = w;
    if (!placed && beacon && rand() < BEACON_LURE_FRACTION) {
      const ang = rand() * Math.PI * 2;
      const r = BEACON_LURE_RING_MIN + rand() * (BEACON_LURE_RING_MAX - BEACON_LURE_RING_MIN);
      const x = PhaserMath.Clamp(beacon.x + Math.cos(ang) * r, 30, w.playW - 30);
      const y = PhaserMath.Clamp(beacon.y + Math.sin(ang) * r, 30, w.playH - 30);
      const clear = players.every((p) => Math.hypot(p.x - x, p.y - y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) {
        placed = { ang: Math.atan2(beacon.y - y, beacon.x - x), x, y };
      }
    }
    for (let i = 0; i < 5 && !placed; i += 1) {
      const c = edgeSpawn(30, w.playW, w.playH);
      const clear = players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) {
        placed = c;
      }
    }
    return placed;
  }

  /** A clear point in the early-onslaught ring [ENEMY_SPAWN_CLEARANCE ..
   *  maxR] around a random living player, aimed at them.
   *  Null when clamping keeps violating clearance (caller falls back / skips). */
  private ringPlacementNear(
    players: Vec[],
    maxR = EARLY_SPAWN_RING_MAX,
  ): { x: number; y: number; ang: number } | null {
    for (let i = 0; i < 8; i += 1) {
      const anchor = players[Math.floor(rand() * players.length)];
      if (!anchor) {
        return null;
      }
      const c = ringSpawnPoint(
        anchor.x,
        anchor.y,
        ENEMY_SPAWN_CLEARANCE,
        maxR,
        this.world.playW,
        this.world.playH,
      );
      const clear = players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE);
      if (clear) {
        return c;
      }
    }
    return null;
  }

  /**
   * Breather rule: when the live count runs past the (intensity-trough) cap by
   * more than the slack — splitter children bypass the cap — quietly despawn
   * the enemy farthest from all living players: no loot, no score, only if
   * it's beyond ENEMY_DESPAWN_MIN_DIST from everyone, max one per interval.
   */
  private hostDespawnBreather(
    now: number,
    intensity: number,
    pressure: number,
    wave: number,
    players: Vec[],
  ): void {
    const w = this.world;
    if (w.enemies.length <= enemyCap(intensity, pressure, wave) + ENEMY_DESPAWN_SLACK) {
      return;
    }
    if (now - this.lastBreatherDespawnAt < ENEMY_DESPAWN_INTERVAL_MS) {
      return;
    }
    let farIdx = -1;
    let farDist = -1;
    for (let i = 0; i < w.enemies.length; i += 1) {
      const e = w.enemies[i];
      if (!e) {
        continue;
      }
      // the boss is never auto-despawned
      if (e.kind === "dreadnought") {
        continue;
      }
      let minD = Infinity;
      for (const p of players) {
        minD = Math.min(minD, Math.hypot(e.x - p.x, e.y - p.y));
      }
      if (minD > farDist) {
        farDist = minD;
        farIdx = i;
      }
    }
    if (farIdx === -1 || farDist <= ENEMY_DESPAWN_MIN_DIST) {
      return;
    }
    const e = w.enemies[farIdx];
    if (!e) {
      return;
    }
    w.enemies.splice(farIdx, 1);
    this.ai.enemySim.delete(e.id);
    this.lastBreatherDespawnAt = now;
    this.dirty.enemies = true;
  }

  /** Boss spawn trigger: near a wave peak, in a busy room (or after the cooldown
   *  in a quiet one). One boss arena-wide. Called each host tick. */
  private hostMaybeSpawnBoss(now: number, intensity: number, players: Vec[]): void {
    const w = this.world;
    // Recompute from the world so a migrated host adopts the flag.
    this.bossAlive = w.enemies.some((e) => e.kind === "dreadnought");
    if (this.bossAlive) {
      return;
    }
    // dir-006 guaranteed sector boss: at sector-relative 405s a sector with no
    // dreadnought spawn yet force-spawns one — bypassing the intensity/
    // cooldown/busy gates but keeping edge placement + spawn clearance.
    // ADDITIVE: the organic gates below are byte-identical to a0c0272.
    // w.sectorBossIdx (host-written, on the wire) marks the satisfied sector,
    // so a migrated host never double-guarantees; a boss spilling across a
    // boundary keeps the NEW sector's guarantee waived via the bossAlive
    // early-return above — once it dies, this rel-405 check applies normally.
    const tSec = Math.max(0, (now - w.arenaEpoch) / 1000);
    const sIdx = sectorIdx(tSec);
    if (sectorRelT(tSec) >= SECTOR_BOSS_AT_S && w.sectorBossIdx < sIdx && players.length > 0) {
      if (this.hostForceSpawnBoss(players)) {
        w.sectorBossIdx = sIdx;
      }
      // placement failure retries next tick; organic gates don't apply
      return;
    }
    if (intensity < BOSS_SPAWN_INTENSITY) {
      return;
    }
    if (this.lastBossKilledAt !== 0 && now - this.lastBossKilledAt < BOSS_SPAWN_COOLDOWN_MS) {
      return;
    }
    // never spawn a boss with nobody to fight it
    if (players.length === 0) {
      return;
    }
    const busy = Object.keys(this.link.peers).length >= BOSS_SPAWN_MIN_PLAYERS;
    // Quiet rooms only get one once the cooldown has fully elapsed since the last.
    if (!busy && this.lastBossKilledAt === 0 && now < BOSS_SPAWN_COOLDOWN_MS) {
      return;
    }
    let placed: { x: number; y: number; ang: number } | null = null;
    for (let i = 0; i < 8 && !placed; i += 1) {
      const c = edgeSpawn(30, this.world.playW, this.world.playH);
      if (players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE)) {
        placed = c;
      }
    }
    if (!placed) {
      return;
    }
    const e = spawnEnemyState("dreadnought", placed.x, placed.y);
    e.angle = placed.ang;
    e.hp = bossHp(Math.max(1, Object.keys(this.link.peers).length));
    e.maxHp = e.hp;
    w.enemies.push(e);
    this.bossAlive = true;
    this.dirty.enemies = true;
    // dir-006: ANY dreadnought spawn (organic or forced) satisfies the
    // sector's guarantee — an organic rel-214 boss means rel-405 no-ops.
    w.sectorBossIdx = sIdx;
  }

  /** dir-006: edge-place + spawn the guaranteed sector dreadnought. Same
   *  placement + stat block as the organic path above — deliberately
   *  duplicated (not extracted) so the organic block stays byte-identical
   *  for diff inspection (spec criterion 6). */
  private hostForceSpawnBoss(players: Vec[]): boolean {
    const w = this.world;
    let placed: { x: number; y: number; ang: number } | null = null;
    for (let i = 0; i < 8 && !placed; i += 1) {
      const c = edgeSpawn(30, w.playW, w.playH);
      if (players.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= ENEMY_SPAWN_CLEARANCE)) {
        placed = c;
      }
    }
    if (!placed) {
      return false;
    }
    const e = spawnEnemyState("dreadnought", placed.x, placed.y);
    e.angle = placed.ang;
    e.hp = bossHp(Math.max(1, Object.keys(this.link.peers).length));
    e.maxHp = e.hp;
    w.enemies.push(e);
    this.bossAlive = true;
    this.dirty.enemies = true;
    return true;
  }
}
