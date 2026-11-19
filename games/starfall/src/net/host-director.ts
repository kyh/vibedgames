import { FixedRate } from "@vibedgames/multiplayer";
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
  SECTOR_BOSS_AT_S,
  SHARD_DRIFT_SPEED,
  SHARD_MAGNET_PULL_SPEED,
  SINGULARITY_PULL_RANGE,
  SINGULARITY_PULL_SPEED,
  STANDINGS_RELAY_HZ,
  UFO_SPAWN_RATE,
  WORLD_NET_HZ,
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
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import type { EnemyAi } from "../sys/enemy-ai";
import { inWorld, magnetPull } from "../sys/geometry";
import { itemClaimKey, shardClaimKey } from "../sys/pickups";
import type { Progression } from "../sys/progression";
import type { HostCombat } from "./host-combat";
import type { PeerRoster } from "./peer-roster";
import type { WireValue } from "./wire-read";
import { STANDINGS_KEY, encodeWorld } from "./world-wire";

/** Late-built collaborators the director consults. */
export interface HostDirectorHooks {
  /** WorldSync.prepareHost — adopt the accepted room world before any host tick/command (sync is built after the director). */
  prepareHost: () => boolean;
  /** My PHASE shield-mod window end (Shield is built after the director). */
  phasedUntil: () => number;
}

/** Host suppresses enemy spawns for the arena's first seconds (safe opening). */
export const ARENA_SAFE_MS = 6000;

export const weightedEnemyRoll = (kinds: readonly EnemyKind[], intensity: number) => {
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
  roster: PeerRoster;
  ai: EnemyAi;
  hostCombat: HostCombat;
  progress: Progression;
  hooks: HostDirectorHooks;
}

/** Host-only world director: the authoritative tick (asteroid/UFO/enemy spawn cadence, pulls, magnets, breathers, boss guarantee, BEACON control) and the fixed-rate delta share of the world to guests. */
export class HostDirector {
  bossAlive = false;

  lastBossKilledAt = 0;

  private readonly shareRate = new FixedRate(WORLD_NET_HZ);

  private readonly standingsRate = new FixedRate(STANDINGS_RELAY_HZ);

  lastAsteroidSpawnAt = 0;

  lastEnemySpawnAt = 0;

  /** False until our first hostTick — promotion stamps the spawn clocks. */
  wasHost = false;

  private lastBreatherDespawnAt = 0;

  private debuted = new Set<EnemyKind>();

  private debutSuppressUntil = 0;

  private lastBeaconStartedAt = 0;

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly roster: PeerRoster;

  private readonly ai: EnemyAi;

  private readonly hostCombat: HostCombat;

  private readonly progress: Progression;

  private readonly hooks: HostDirectorHooks;

  constructor(deps: HostDirectorDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.roster = deps.roster;
    this.ai = deps.ai;
    this.hostCombat = deps.hostCombat;
    this.progress = deps.progress;
    this.hooks = deps.hooks;
  }

  /** Back to a never-hosted director, for a run rebuilt from nothing (the
   *  playtest seed hook): the next hostTick re-adopts every clock. */
  restart() {
    this.bossAlive = false;
    this.lastBossKilledAt = 0;
    this.shareRate.reset();
    this.standingsRate.reset();
    this.wasHost = false;
    this.lastBreatherDespawnAt = 0;
    this.debuted = new Set();
    this.debutSuppressUntil = 0;
    this.lastBeaconStartedAt = 0;
  }

  hostTick(now: number, dt: number, delta: number) {
    if (!this.hooks.prepareHost()) {
      return;
    }

    if (!this.wasHost) {
      this.hostAdoptClocks(now);
    }

    const w = this.world;
    const tSec = Math.max(0, (now - w.arenaEpoch) / 1000);
    const intensity = arenaIntensity(tSec);
    const pc = Math.max(1, Object.keys(this.link.peers).length);
    const pressure = playerPressure(pc);
    const wave = wavePulse(tSec);
    const wantW = playWidthForPlayers(pc);

    if (wantW > w.playW) {
      w.playW = wantW;
      w.playH = playHeightForPlayers(pc);
    }

    this.hostTickAsteroids(now, intensity, pressure, wave);
    this.hostTickUfo(now, dt);
    this.hostTickPickups(now);

    const players = this.livingPlayers();
    this.hostTickBeacon(now, tSec, players);
    this.hostSpawnEnemies(now, tSec, intensity, pressure, wave, players);
    this.hostMaybeSpawnBoss(now, intensity, players);
    this.ai.hostSimEnemies(now, dt, players);
    this.hostApplyPulls(now);
    w.pulls = w.pulls.filter((p) => p.until > now);

    if (!this.link.trailer) {
      this.hostDespawnBreather(now, intensity, pressure, wave, players);
    }

    w.enemyShots = w.enemyShots.filter(
      (s) => s.diesAt > now && inWorld(s.x, s.y, 60, w.playW, w.playH),
    );

    if (!this.link.offline && this.shareRate.due(delta)) {
      this.share(now);
    }

    if (!this.link.offline && this.standingsRate.due(delta)) {
      this.relayStandings();
    }
  }

  /** Share the world right now (a freshly seeded room: every row is new). */
  shareNow(now: number) {
    this.share(now);
  }

  private share(now: number) {
    const stamp = Math.round(this.link.serverAt(now));
    this.link.patchShared(encodeWorld(this.world, now, stamp, this.link.sharedState ?? {}));
  }

  private hostAdoptClocks(now: number) {
    this.wasHost = true;
    this.lastAsteroidSpawnAt = now;
    this.lastEnemySpawnAt = now;
    const b = this.world.beacon;

    if (b) {
      this.lastBeaconStartedAt = b.activeAt - BEACON_CHARGE_S * 1000;
    } else if ((now - this.world.arenaEpoch) / 1000 >= BEACON_MIN_T_S) {
      this.lastBeaconStartedAt = now;
    }
  }

  private hostTickAsteroids(now: number, intensity: number, pressure: number, wave: number) {
    const w = this.world;

    if (
      w.asteroids.length < asteroidCap(intensity, pressure, wave) &&
      now - this.lastAsteroidSpawnAt > asteroidSpawnIntervalMs(intensity)
    ) {
      w.asteroids.push(spawnAsteroidState(w.playW, w.playH));
      this.lastAsteroidSpawnAt = now;
    }

    w.asteroids = w.asteroids.filter((a) =>
      inWorld(a.x, a.y, ASTEROID_CULL_MARGIN, w.playW, w.playH),
    );
  }

  private hostTickUfo(now: number, dt: number) {
    const w = this.world;
    const weaponItemsInFlight = w.items.filter((it) => it.kind === "weapon").length;

    if (!w.ufo && !this.link.trailer && weaponItemsInFlight < 2 && rand() < UFO_SPAWN_RATE * dt) {
      w.ufo = spawnUfoState(w.playW, w.playH);
    }

    if (w.ufo && w.ufo.x === w.ufo.destX && w.ufo.y === w.ufo.destY) {
      w.ufo.destX = rand() * w.playW;
      w.ufo.destY = rand() * w.playH;
    }
  }

  private hostTickPickups(now: number) {
    const w = this.world;
    w.items = w.items.filter((it) => it.diesAt > now && !this.link.claimed(itemClaimKey(it.id)));
    w.shards = w.shards.filter((s) => s.diesAt > now && !this.link.claimed(shardClaimKey(s.id)));
    this.hostMagnetItems(now);
  }

  private relayStandings() {
    const board: WireValue[] = [];
    const { myId } = this.link;

    if (myId && this.pilot.spawned) {
      board.push(myId, Math.round(this.progress.sectorScore));
    }

    for (const [id, st] of this.link.peerStates) {
      if (id !== myId && st?.present) {
        board.push(id, Math.round(st.sectorScore));
      }
    }

    this.link.patchShared({ [STANDINGS_KEY]: board });
  }

  /** Boss down: free the arena-wide slot and arm the spawn cooldown. */
  noteBossKilled(now: number) {
    this.bossAlive = false;
    this.lastBossKilledAt = now;
  }

  private beaconOccupants(cx: number, cy: number) {
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

    const t = performance.now();

    for (const [id, st] of this.link.peerStates) {
      if (id === myId || !st || !st.alive || !st.present) {
        continue;
      }

      const p = this.roster.lead(id, t);

      if (p && Math.hypot(p.x - cx, p.y - cy) <= BEACON_RADIUS) {
        out.push(id);
      }
    }

    return out;
  }

  private hostTickBeacon(now: number, tSec: number, players: Vec[]) {
    const w = this.world;
    const b = w.beacon;

    if (b) {
      if (now >= b.diesAt) {
        if (b.controllerId !== null && !b.contested) {
          this.hostCombat.hostRollLoot(b.x, b.y, 1, true, true);
        }

        w.beacon = null;

        return;
      }

      if (now >= b.activeAt) {
        const occ = this.beaconOccupants(b.x, b.y);
        const controllerId = occ.length === 1 ? (occ[0] ?? null) : null;
        const contested = occ.length >= 2;

        if (controllerId !== b.controllerId || contested !== b.contested) {
          b.controllerId = controllerId;
          b.contested = contested;
        }
      }

      return;
    }

    if (sectorRelT(tSec) < BEACON_MIN_T_S) {
      return;
    }

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
  ) {
    this.world.beacon = {
      activeAt: now + chargeS * 1000,
      contested: false,
      controllerId: null,
      diesAt: now + (chargeS + activeS) * 1000,
      x,
      y,
    };
    this.lastBeaconStartedAt = now;
  }

  /** Position of a player by id: me from the live ship, a remote where it
   *  is drawn. Null when unknown/absent. */
  playerPos(id: string) {
    if (id === this.link.myId) {
      return this.pilot.spawned && this.pilot.alive
        ? { x: this.pilot.shipX, y: this.pilot.shipY }
        : null;
    }

    const st = this.link.peerStates.get(id);

    return st && st.alive ? { x: st.x, y: st.y } : null;
  }

  private hostApplyPulls(now: number) {
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

  private hostMagnetItems(now: number) {
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

    for (const sd of w.shards) {
      magnetPull(sd, holders, SHARD_MAGNET_PULL_SPEED, SHARD_DRIFT_SPEED);
    }
  }

  private magnetHolders(now: number) {
    const holders: Vec[] = [];
    const mine = this.pilot.boosts.get("magnet");

    if (mine !== undefined && mine > now && this.pilot.alive && this.pilot.spawned) {
      holders.push({ x: this.pilot.shipX, y: this.pilot.shipY });
    }

    const { myId } = this.link;
    const t = performance.now();

    for (const [id, st] of this.link.peerStates) {
      if (id === myId || !st || !st.alive || !st.magnet) {
        continue;
      }

      const p = this.roster.lead(id, t);

      if (p) {
        holders.push(p);
      }
    }

    return holders;
  }

  /** Highest level among present players (default 1 when unknowable) — the
   *  host sees every player. Drives elite HP stamping at spawn; kill XP reads
   *  the multiplier back off the elite (enemyKillXp), so qa-018's cost and
   *  reward move together. */
  maxPresentLevel() {
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

  private livingPlayers() {
    const out: Vec[] = [];

    if (this.pilot.alive && this.pilot.spawned && simNow() >= this.hooks.phasedUntil()) {
      out.push({ x: this.pilot.shipX, y: this.pilot.shipY });
    }

    const { myId } = this.link;
    const t = performance.now();

    for (const [id, st] of this.link.peerStates) {
      if (id === myId || !st || !st.alive || st.shieldMod?.phased) {
        continue;
      }

      const p = this.roster.lead(id, t);

      if (p) {
        out.push(p);
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
  ) {
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

    if (!placed) {
      return;
    }

    const e = spawnEnemyState(kind, placed.x, placed.y);
    e.angle = placed.ang;

    if (ELITE_HP_BASE.has(kind)) {
      e.hp = eliteHp(kind, this.maxPresentLevel());
      e.maxHp = e.hp;
    }

    w.enemies.push(e);
    this.lastEnemySpawnAt = now;

    if (isDebut) {
      this.debuted.add(kind);
      this.debutSuppressUntil = now + ENEMY_DEBUT_SUPPRESS_MS;
    }
  }

  private hostSeedDebutWave(now: number, players: Vec[]) {
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
  }

  private pickSpawnKind(intensity: number) {
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

  private placeEnemySpawn(kind: EnemyKind, early: boolean, players: Vec[]) {
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

  private ringPlacementNear(players: Vec[], maxR = EARLY_SPAWN_RING_MAX) {
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

  private hostDespawnBreather(
    now: number,
    intensity: number,
    pressure: number,
    wave: number,
    players: Vec[],
  ) {
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
  }

  private hostMaybeSpawnBoss(now: number, intensity: number, players: Vec[]) {
    const w = this.world;
    this.bossAlive = w.enemies.some((e) => e.kind === "dreadnought");

    if (this.bossAlive) {
      return;
    }

    const tSec = Math.max(0, (now - w.arenaEpoch) / 1000);
    const sIdx = sectorIdx(tSec);

    if (sectorRelT(tSec) >= SECTOR_BOSS_AT_S && w.sectorBossIdx < sIdx && players.length > 0) {
      if (this.hostForceSpawnBoss(players)) {
        w.sectorBossIdx = sIdx;
      }

      return;
    }

    if (intensity < BOSS_SPAWN_INTENSITY) {
      return;
    }

    if (this.lastBossKilledAt !== 0 && now - this.lastBossKilledAt < BOSS_SPAWN_COOLDOWN_MS) {
      return;
    }

    if (players.length === 0) {
      return;
    }

    const busy = Object.keys(this.link.peers).length >= BOSS_SPAWN_MIN_PLAYERS;

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
    w.sectorBossIdx = sIdx;
  }

  private hostForceSpawnBoss(players: Vec[]) {
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

    return true;
  }
}
