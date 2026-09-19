import type { MultiplayerClient } from "@vibedgames/multiplayer";
import { Math as PhaserMath } from "phaser";
import type { Hud } from "../render/hud";
import {
  ASTEROID_ROT_SPEED,
  ASTEROID_SEED_COUNT,
  BASE_WORLD_H,
  BASE_WORLD_W,
  UFO_SPEED,
  WORLD_H,
  WORLD_W,
  playHeightForPlayers,
  playWidthForPlayers,
  spawnAsteroidState,
} from "../shared/constants";
import type { SharedState } from "../shared/constants";
import type { Link } from "../state/link";
import type { EnemyAi } from "../sys/enemy-ai";
import type { Pickups } from "../sys/pickups";
import type { Shield } from "../sys/shield";
import type { HostDirector } from "./host-director";
import {
  adoptShared,
  blendPos,
  cloneAsteroid,
  emptyShared,
  indexById,
  isShared,
  reconcileDrifters,
  sharedToPatch,
} from "./shared-world";

export interface WorldSyncDeps {
  world: SharedState;
  link: Link;
  hud: Hud;
  shield: Shield;
  pickups: Pickups;
  host: HostDirector;
  ai: EnemyAi;
}

/** Host↔shared reconcile: seeding the room world, adopting it on host admission, and the guest-side blend of each 20Hz snapshot into the dead-reckoned working copy. */
export class WorldSync {
  private lastSharedRef: MultiplayerClient["sharedState"] | null = null;

  offlineSeeded = false;

  private readonly world: SharedState;

  private readonly link: Link;

  private readonly hud: Hud;

  private readonly shield: Shield;

  private readonly pickups: Pickups;

  private readonly host: HostDirector;

  private readonly ai: EnemyAi;

  constructor(deps: WorldSyncDeps) {
    this.world = deps.world;
    this.link = deps.link;
    this.hud = deps.hud;
    this.shield = deps.shield;
    this.pickups = deps.pickups;
    this.host = deps.host;
    this.ai = deps.ai;
  }

  onUpdate(): void {
    this.ensureSeeded();
    if (this.prepareHost()) {
      return;
    }
    // Reconcile only when the shared object identity changed (i.e. a real
    // state patch) — notify() also fires for player-state traffic, and
    // re-blending toward a stale snapshot would drag entities backwards.
    if (this.link.live && this.link.sharedState !== this.lastSharedRef) {
      this.lastSharedRef = this.link.sharedState;
      this.reconcileFromShared();
    }
  }

  shared(): SharedState | null {
    // local world is authoritative solo
    if (this.link.offline) {
      return this.world;
    }
    const s = this.link.sharedState;
    return s && isShared(s) ? s : null;
  }

  /** Server election alone is not adoption. A reconnect may admit us as host
   * with a newer sync while our old working copy still contains dead entities.
   * Adopt once before host commands/ticks; never alias the SDK's shallow cache.
   * Local ship, rewards and pending pickup guards remain owner-controlled. */
  prepareHost(): boolean {
    if (this.link.offline) {
      return true;
    }
    if (!this.link.amHost) {
      this.link.hostSnapshotReady = false;
      return false;
    }
    if (this.link.hostSnapshotReady) {
      return true;
    }
    const shared = this.shared();
    if (!shared) {
      return false;
    }
    const accepted = structuredClone(shared);
    adoptShared(this.world, {
      ...accepted,
      arenaEpoch: Number.isFinite(accepted.arenaEpoch)
        ? accepted.arenaEpoch
        : this.world.arenaEpoch,
      beacon: accepted.beacon ?? null,
      enemies: accepted.enemies ?? [],
      enemyShots: accepted.enemyShots ?? [],
      items: accepted.items ?? [],
      playH: Number.isFinite(accepted.playH)
        ? PhaserMath.Clamp(accepted.playH, BASE_WORLD_H, WORLD_H)
        : this.world.playH,
      playW: Number.isFinite(accepted.playW)
        ? PhaserMath.Clamp(accepted.playW, BASE_WORLD_W, WORLD_W)
        : this.world.playW,
      pulls: accepted.pulls ?? [],
      sectorBossIdx: Number.isFinite(accepted.sectorBossIdx)
        ? accepted.sectorBossIdx
        : this.world.sectorBossIdx,
      shards: accepted.shards ?? [],
      ufo: accepted.ufo ?? null,
    });
    this.link.hostSnapshotReady = true;
    this.lastSharedRef = this.link.sharedState;
    // Existing migration policy: host-local AI is reconstructed, and the first
    // host tick rearms spawn/beacon cadence instead of bursting overdue spawns.
    this.ai.enemySim.clear();
    this.host.wasHost = false;
    // Admission is a baseline, not evidence that a missed encounter just
    // happened. Fresh events on the admitted world still announce normally.
    this.hud.bossEncounters.reset();
    this.hud.battleBeat.reset();
    this.hud.observeBossEncounters(this.world);
    return true;
  }

  /**
   * The first host to connect seeds the world (arenaEpoch = now + the opening
   * asteroid field). Guests adopt the host's existing state; a guest promoted
   * to host after a migration keeps the live world — and the epoch — instead
   * of resetting it.
   */
  ensureSeeded(): void {
    // Seed the opening asteroid field within the play bounds for the current
    // player count (so a multi-player arena opens fully populated, not just the
    // base 1-player box).
    const seedField = (s: SharedState): void => {
      const pc = Math.max(1, Object.keys(this.link.peers).length);
      s.playW = playWidthForPlayers(pc);
      s.playH = playHeightForPlayers(pc);
      for (let i = 0; i < ASTEROID_SEED_COUNT; i += 1) {
        s.asteroids.push(spawnAsteroidState(s.playW, s.playH));
      }
    };
    if (this.link.offline) {
      // Solo arena: seed the local world directly, nothing to broadcast.
      if (!this.offlineSeeded) {
        this.offlineSeeded = true;
        const seeded = emptyShared();
        seedField(seeded);
        adoptShared(this.world, seeded);
      }
      return;
    }
    if (this.link.amHost && this.link.connected && !this.shared()) {
      const seeded = emptyShared();
      seedField(seeded);
      adoptShared(this.world, seeded);
      // We authored this empty-room seed at full precision. A synchronous SDK
      // notification must not replace it with its quantized outgoing copy.
      this.link.hostSnapshotReady = true;
      this.link.patchShared(sharedToPatch(seeded));
    }
  }

  /** Guest-side: adopt the host's 20Hz snapshot into the local working copy. */
  private reconcileFromShared(): void {
    const s = this.shared();
    if (!s) {
      return;
    }
    this.hud.observeBossEncounters(s);
    this.reconcileArena(s);
    this.reconcileAsteroids(s);
    this.reconcileUfo(s);
    const w = this.world;
    w.items = reconcileDrifters(w.items, s.items ?? [], this.pickups.recentPickups);
    this.reconcileEnemies(s);
    w.shards = reconcileDrifters(w.shards, s.shards ?? [], this.pickups.recentShardPickups);
    w.enemyShots = reconcileDrifters(
      w.enemyShots,
      s.enemyShots ?? [],
      this.shield.recentConsumedShots,
    );
    // Pulls are static entries — adopt wholesale (the vortex renders from
    // them; the host moves the affected bodies).
    w.pulls = (s.pulls ?? []).map((p) => ({ id: p.id, until: p.until, x: p.x, y: p.y }));
    // Beacon: one static host-written entry — adopt wholesale. Phases and
    // countdowns derive from its timestamps locally (tickBeaconClient).
    w.beacon = s.beacon ? { ...s.beacon } : null;
  }

  private reconcileArena(s: SharedState): void {
    const w = this.world;
    if (Number.isFinite(s.arenaEpoch)) {
      w.arenaEpoch = s.arenaEpoch;
    }
    // Boss-guarantee marker (dir-006): adopt like the epoch so a promoted
    // host never double-guarantees. Legacy snapshots omit it → keep local.
    if (Number.isFinite(s.sectorBossIdx)) {
      w.sectorBossIdx = s.sectorBossIdx;
    }
    // Clamp to valid bounds — never trust an out-of-range value from the host.
    if (Number.isFinite(s.playW)) {
      w.playW = PhaserMath.Clamp(s.playW, BASE_WORLD_W, WORLD_W);
    }
    if (Number.isFinite(s.playH)) {
      w.playH = PhaserMath.Clamp(s.playH, BASE_WORLD_H, WORLD_H);
    }
  }

  private reconcileAsteroids(s: SharedState): void {
    const w = this.world;
    const localAsteroids = indexById(w.asteroids);
    const asteroidIds = new Set<string>();
    for (const a of s.asteroids) {
      asteroidIds.add(a.id);
      const local = localAsteroids.get(a.id);
      if (!local) {
        w.asteroids.push(cloneAsteroid(a));
        continue;
      }
      local.radius = a.radius;
      local.vx = a.vx;
      local.vy = a.vy;
      blendPos(local, a.x, a.y);
    }
    // Departed asteroids (destroyed or culled) — display sweep handles the FX.
    w.asteroids = w.asteroids.filter((x) => asteroidIds.has(x.id));
  }

  private reconcileUfo(s: SharedState): void {
    const w = this.world;
    if (!s.ufo) {
      w.ufo = null;
    } else if (!w.ufo || w.ufo.id !== s.ufo.id) {
      w.ufo = { ...s.ufo };
    } else {
      const u = w.ufo;
      u.hp = s.ufo.hp;
      u.blinkUntil = s.ufo.blinkUntil;
      u.destX = s.ufo.destX;
      u.destY = s.ufo.destY;
      blendPos(u, s.ufo.x, s.ufo.y);
    }
  }

  private reconcileEnemies(s: SharedState): void {
    const w = this.world;
    const localEnemies = indexById(w.enemies);
    const enemyIds = new Set<string>();
    for (const e of s.enemies ?? []) {
      enemyIds.add(e.id);
      const local = localEnemies.get(e.id);
      if (!local) {
        w.enemies.push({ ...e });
        continue;
      }
      local.vx = e.vx;
      local.vy = e.vy;
      local.angle = e.angle;
      local.hp = e.hp;
      local.telegraphUntil = e.telegraphUntil;
      local.chargeUntil = e.chargeUntil;
      local.attackAt = e.attackAt;
      // Keep the most pessimistic blink (local prediction may be ahead).
      local.blinkUntil = Math.max(local.blinkUntil, e.blinkUntil);
      local.graceUntil = e.graceUntil;
      local.maxHp = e.maxHp;
      // sniper/boss laser sights
      local.lances = e.lances;
      // warden shield state
      local.shielded = e.shielded;
      blendPos(local, e.x, e.y);
    }
    w.enemies = w.enemies.filter((x) => enemyIds.has(x.id));
  }

  /** Movement integration — runs on every client for 60fps-smooth motion. */
  advanceWorld(dt: number): void {
    for (const a of this.world.asteroids) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.rot += ASTEROID_ROT_SPEED * dt;
    }
    const u = this.world.ufo;
    if (u) {
      const dx = u.destX - u.x;
      const dy = u.destY - u.y;
      const dist = Math.hypot(dx, dy);
      const step = UFO_SPEED * dt;
      if (dist > step) {
        u.x += (dx / dist) * step;
        u.y += (dy / dist) * step;
      } else {
        // Park at the destination; only the host picks the next one.
        u.x = u.destX;
        u.y = u.destY;
      }
    }
    for (const it of this.world.items) {
      it.x += it.vx * dt;
      it.y += it.vy * dt;
    }
    for (const s of this.world.shards) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    for (const e of this.world.enemies) {
      e.x = PhaserMath.Clamp(e.x + e.vx * dt, -40, this.world.playW + 40);
      e.y = PhaserMath.Clamp(e.y + e.vy * dt, -40, this.world.playH + 40);
    }
    for (const s of this.world.enemyShots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
  }
}
