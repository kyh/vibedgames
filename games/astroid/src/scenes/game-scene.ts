import { MultiplayerClient } from "@vibedgames/multiplayer";
import type { Player } from "@vibedgames/multiplayer";
import Phaser from "phaser";

import { Starfield } from "../render/starfield";
import {
  ASTEROID_CULL_MARGIN,
  ASTEROID_MAX_NUM,
  ASTEROID_MAX_RADIUS,
  ASTEROID_MIN_RADIUS,
  ASTEROID_ROT_SPEED,
  ASTEROID_SPAWN_INTERVAL_MS,
  asteroidSpeed,
  INVULN_BLINK_MS,
  INVULNERABLE_MS,
  ITEM_DRAW_RADIUS,
  ITEM_PICKUP_RADIUS,
  MINIMAP_H,
  MINIMAP_PAD,
  MINIMAP_W,
  NET_INTERVAL_MS,
  randomWorldPoint,
  RESPAWN_DELAY_MS,
  SCORE,
  SHIP_HULL_DEG,
  SHIP_RADIUS,
  SHIP_SPEED,
  SPECIAL_WEAPON_DURATION_MS,
  spawnAsteroidState,
  spawnItemState,
  spawnUfoState,
  UFO_BLINK_MS,
  UFO_RADIUS,
  UFO_SPAWN_RATE,
  UFO_SPEED,
  WEAPON_DEFAULT,
  WEAPONS_SPECIAL,
  WORLD_H,
  WORLD_W,
  type AsteroidState,
  type PlayerNetState,
  type SerializedBeam,
  type SharedState,
  type Weapon,
} from "../shared/constants";

/** A locally-simulated beam (only ever our own — remote beams arrive serialized). */
type Beam = {
  head: { x: number; y: number };
  tail: { x: number; y: number };
  angle: number;
  weapon: Weapon;
  released: boolean;
  exploding: boolean;
  explosionRadius: number;
  vanished: boolean;
};

type ShipObjs = {
  gfx: Phaser.GameObjects.Graphics;
  tint: number;
  alive: boolean;
  /** False until the first state snapshot lands (remote ships snap, not glide). */
  seenState: boolean;
};
type AsteroidObjs = { gfx: Phaser.GameObjects.Graphics; drawnRadius: number };
type ItemObjs = { gfx: Phaser.GameObjects.Graphics; tint: number };

type Splinter = {
  originX: number;
  originY: number;
  angle: number;
  dist: number;
  speed: number;
  diesAt: number;
  x: number;
  y: number;
};

const MULTIPLAYER_HOST = import.meta.env.DEV
  ? "http://localhost:8787"
  : "https://vibedgames-party.kyh.workers.dev";

// Fresh room name: old deployed clients on the legacy "home" room can't
// pollute this build's shared-state shape.
const ROOM = "astroid-arena";

const DEG = Math.PI / 180;
/** Beams vanish this far outside the world. */
const BEAM_CULL_MARGIN = 200;
/** Black mask thickness past the world edge (covers any screen half-width). */
const MASK_PAD = 4000;
/** Reconcile snaps instead of blending past this offset. */
const SNAP_DIST = 80;
const SPLINTER_LIFE_MS = 7000;
const SPLINTER_PX = 2;

function emptyShared(): SharedState {
  // Every resettable field MUST be present — patches shallow-merge, so an
  // omitted key carries over.
  return { asteroids: [], ufo: null, items: [] };
}

function isShared(v: unknown): v is SharedState {
  return (
    typeof v === "object" && v !== null && Array.isArray((v as { asteroids?: unknown }).asteroids)
  );
}

export class GameScene extends Phaser.Scene {
  private client!: MultiplayerClient;
  private starfield!: Starfield;

  /**
   * Local working copy of the shared world. The host owns it (events mutate
   * it, hostTick broadcasts it); guests dead-reckon it every frame and
   * reconcile toward the host's 20Hz snapshots — that's what keeps asteroid
   * motion smooth at 60fps despite the 20Hz wire rate.
   */
  private world: SharedState = emptyShared();
  private lastSharedRef: unknown = null;

  // my ship + weapon
  private spawned = false;
  private shipX = 0;
  private shipY = 0;
  private shipAngle = 0;
  private alive = true;
  private respawnAt = 0;
  private invulnUntil = 0;
  private weapon: Weapon = WEAPON_DEFAULT;
  private weaponUntil = 0;
  private shootCooldown = 0;
  private score = 0;
  private beams: Beam[] = [];
  /** Phaser's activePointer sits at (0,0) until the first real pointer event —
   *  steering before then would yank the ship to the screen corner. */
  private pointerSeen = false;
  /** Items we picked up locally, awaiting host confirmation (id → time). */
  private recentPickups = new Map<string, number>();
  /** Targets whose destroy bonus I already self-awarded, awaiting host removal
   *  (id → time). Dedupes the bonus for beams that survive hits (LASER pierces
   *  and re-intersects every frame until the host's echo lands). */
  private predictedKills = new Map<string, number>();

  // networking cadence
  private netAcc = 0;
  private shareAcc = 0;
  private dirty = { asteroids: false, ufo: false, items: false };
  private lastAsteroidSpawnAt = 0;

  // camera recoil
  private kickX = 0;
  private kickY = 0;

  // display caches
  private ships = new Map<string, ShipObjs>();
  private asteroidObjs = new Map<string, AsteroidObjs>();
  private itemObjs = new Map<string, ItemObjs>();
  private ufoGfx: Phaser.GameObjects.Graphics | null = null;
  private ufoId = "";
  private beamGfx!: Phaser.GameObjects.Graphics;
  private splinterGfx!: Phaser.GameObjects.Graphics;
  private minimapGfx!: Phaser.GameObjects.Graphics;
  private splinters: Splinter[] = [];

  // HUD (DOM, owned by index.html)
  private scoreEl: HTMLElement | null = null;
  private weaponEl: HTMLElement | null = null;
  private playersEl: HTMLElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private countdownEl: HTMLElement | null = null;

  constructor() {
    super("Game");
  }

  create(): void {
    this.scoreEl = document.getElementById("score");
    this.weaponEl = document.getElementById("weapon");
    this.playersEl = document.getElementById("players");
    this.overlayEl = document.getElementById("overlay");
    this.countdownEl = document.getElementById("countdown");

    this.starfield = new Starfield(this);

    // Black mask outside the world: entities legitimately exist past the edge
    // (spawning asteroids, escaping beams) but must not be visible there.
    const edges: ReadonlyArray<readonly [number, number, number, number]> = [
      [-MASK_PAD, -MASK_PAD, WORLD_W + MASK_PAD * 2, MASK_PAD],
      [-MASK_PAD, WORLD_H, WORLD_W + MASK_PAD * 2, MASK_PAD],
      [-MASK_PAD, 0, MASK_PAD, WORLD_H],
      [WORLD_W, 0, MASK_PAD, WORLD_H],
    ];
    for (const [x, y, w, h] of edges) {
      this.add.rectangle(x, y, w, h, 0x020617).setOrigin(0).setDepth(50);
    }

    this.beamGfx = this.add.graphics().setDepth(12);
    this.splinterGfx = this.add.graphics().setDepth(15);
    this.minimapGfx = this.add.graphics().setScrollFactor(0).setDepth(100);

    // No `initialState`: the package re-applies it whenever a client becomes
    // host, which would wipe the live world on host migration. The first host
    // seeds explicitly (see `ensureSeeded`).
    this.client = new MultiplayerClient({
      host: MULTIPLAYER_HOST,
      party: "vg-server",
      room: ROOM,
      onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
    });
    this.client.subscribe(() => this.onUpdate());

    this.input.on(Phaser.Input.Events.POINTER_MOVE, () => {
      this.pointerSeen = true;
    });
    this.input.on(Phaser.Input.Events.POINTER_DOWN, () => {
      this.pointerSeen = true;
    });

    this.events.on(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.client.destroy();
    });

    if (import.meta.env.DEV) {
      (window as unknown as { __astroid?: unknown }).__astroid = {
        scene: this,
        client: this.client,
      };
    }
  }

  override update(time: number, delta: number): void {
    const dt = Math.min(delta, 100) / 1000; // clamp tab-switch spikes
    this.starfield.update(dt, time);
    if (this.client.connectionStatus !== "connected") return;
    const now = Date.now();

    this.ensureSpawned();
    this.tickRespawn(now);
    this.steerShip(dt);
    this.handleShooting(delta);
    this.updateBeams(dt);
    this.advanceWorld(dt);
    if (this.client.isHost) this.hostTick(now, dt, delta);
    this.detectMyHits(now);
    this.detectMyDeath(now);
    this.pickupItems(now);
    if (this.weapon !== WEAPON_DEFAULT && now >= this.weaponUntil) this.weapon = WEAPON_DEFAULT;
    this.netSend(delta, now);

    this.syncShips(now, dt);
    this.syncAsteroids(now);
    this.syncUfo(now);
    this.syncItems();
    this.drawBeams();
    this.updateSplinters(dt, now);
    this.drawMinimap();
    this.updateCamera(dt);
    this.updateHud(now);
  }

  // ---- input + my ship -------------------------------------------------------

  /** First connect: drop the ship at a random spot and snap the camera. */
  private ensureSpawned(): void {
    if (this.spawned || !this.client.playerId) return;
    const pos = randomWorldPoint();
    this.shipX = pos.x;
    this.shipY = pos.y;
    this.spawned = true;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.pushMyState(Date.now());
  }

  private tickRespawn(now: number): void {
    if (this.alive || this.respawnAt === 0 || now < this.respawnAt) return;
    const pos = randomWorldPoint();
    this.shipX = pos.x;
    this.shipY = pos.y;
    this.alive = true;
    this.respawnAt = 0;
    this.invulnUntil = now + INVULNERABLE_MS;
    this.kickX = 0;
    this.kickY = 0;
    this.cameras.main.centerOn(pos.x, pos.y);
    this.pushMyState(now);
  }

  /**
   * The control identity: the ship constantly flies toward the cursor at
   * fixed speed, stopping only inside a ship-sized dead zone; the nose always
   * points at the cursor. Touch works the same — the ship chases the finger.
   */
  private steerShip(dt: number): void {
    if (!this.alive || !this.spawned || !this.pointerSeen) return;
    const cam = this.cameras.main;
    const p = this.input.activePointer;
    const dx = p.x + cam.scrollX - this.shipX;
    const dy = p.y + cam.scrollY - this.shipY;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.001) this.shipAngle = Math.atan2(dy, dx);
    if (dist > SHIP_RADIUS) {
      const step = SHIP_SPEED * dt;
      this.shipX = Phaser.Math.Clamp(this.shipX + (dx / dist) * step, 0, WORLD_W);
      this.shipY = Phaser.Math.Clamp(this.shipY + (dy / dist) * step, 0, WORLD_H);
    }
  }

  private handleShooting(delta: number): void {
    this.shootCooldown = Math.max(0, this.shootCooldown - delta);
    if (!this.alive || !this.spawned) return;
    if (!this.input.activePointer.isDown || this.shootCooldown > 0) return;
    this.shootCooldown = this.weapon.intervalMs;
    const nose = {
      x: this.shipX + Math.cos(this.shipAngle) * SHIP_RADIUS,
      y: this.shipY + Math.sin(this.shipAngle) * SHIP_RADIUS,
    };
    this.beams.push({
      head: { ...nose },
      tail: { ...nose },
      angle: this.shipAngle,
      weapon: this.weapon,
      released: false,
      exploding: false,
      explosionRadius: 0,
      vanished: false,
    });
    // Tiny camera recoil opposite the shot.
    this.kickX -= Math.cos(this.shipAngle) * 2;
    this.kickY -= Math.sin(this.shipAngle) * 2;
  }

  private updateBeams(dt: number): void {
    this.beams = this.beams.filter((b) => !b.vanished);
    for (const b of this.beams) {
      if (b.exploding) {
        const explosion = b.weapon.explosion;
        if (!explosion) {
          b.vanished = true;
          continue;
        }
        b.explosionRadius += explosion.growth * dt;
        if (b.explosionRadius >= explosion.range) b.vanished = true;
        continue;
      }
      const step = b.weapon.speed * dt;
      const sx = Math.cos(b.angle) * step;
      const sy = Math.sin(b.angle) * step;
      b.head.x += sx;
      b.head.y += sy;
      if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN)) {
        b.vanished = true;
        continue;
      }
      if (b.released) {
        b.tail.x += sx;
        b.tail.y += sy;
      } else if (Math.hypot(b.head.x - b.tail.x, b.head.y - b.tail.y) > b.weapon.length) {
        // The tail stays at the barrel until the beam reaches full length.
        b.released = true;
        b.tail.x = b.head.x - Math.cos(b.angle) * b.weapon.length;
        b.tail.y = b.head.y - Math.sin(b.angle) * b.weapon.length;
      }
    }
  }

  /** Beam reaction to a hit: explode, pass through, or vanish. */
  private onBeamHit(b: Beam): void {
    if (b.weapon.explosion && !b.exploding) {
      b.exploding = true;
      b.explosionRadius = 0;
      return;
    }
    if (!b.weapon.through) b.vanished = true;
  }

  /**
   * Shooter-side hit detection: I detect my own beams hitting host-owned
   * targets and report damage events; the host applies them. Score is awarded
   * locally, with the destroy bonus predicted from the same damage formula
   * the host runs.
   */
  private detectMyHits(now: number): void {
    if (!this.spawned) return;
    for (const b of this.beams) {
      if (b.vanished) continue;
      for (const a of this.world.asteroids) {
        const hit = b.exploding
          ? dist2(b.head.x, b.head.y, a.x, a.y) <= b.explosionRadius * b.explosionRadius
          : segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, a.x, a.y, a.radius);
        if (!hit) continue;
        this.onBeamHit(b);
        const destroyed =
          a.radius - ASTEROID_MAX_RADIUS * Math.min(b.weapon.power, 1) < ASTEROID_MIN_RADIUS;
        let bonus = 0;
        if (destroyed && !this.predictedKills.has(a.id)) {
          this.predictedKills.set(a.id, now);
          bonus = SCORE.ASTEROID_DESTROY;
        }
        this.score += SCORE.ASTEROID_DAMAGE + bonus;
        this.impactBurst(b.head.x, b.head.y, 0xffffff, 6);
        this.client.sendEvent("asteroid_hit", { asteroidId: a.id, damage: b.weapon.power });
        break;
      }
    }
    const u = this.world.ufo;
    if (u) {
      for (const b of this.beams) {
        if (b.vanished) continue;
        const hit = b.exploding
          ? dist2(b.head.x, b.head.y, u.x, u.y) <= b.explosionRadius * b.explosionRadius
          : segHitsCircle(b.tail.x, b.tail.y, b.head.x, b.head.y, u.x, u.y, UFO_RADIUS);
        if (!hit) continue;
        this.onBeamHit(b);
        if (u.hp - b.weapon.power * 100 <= 0 && !this.predictedKills.has(u.id)) {
          this.predictedKills.set(u.id, now);
          this.score += SCORE.UFO_DESTROY;
        }
        this.impactBurst(b.head.x, b.head.y, 0xffffff, 6);
        this.client.sendEvent("ufo_hit", { damage: b.weapon.power });
        break;
      }
    }
    for (const [id, t] of this.predictedKills) {
      if (now - t > 5000) this.predictedKills.delete(id);
    }
  }

  /**
   * Victim-side death detection: asteroids and the UFO kill on contact with
   * the ship CENTER (generous to the player); other players' beams kill
   * within the ship radius. The victim reports its own killer.
   */
  private detectMyDeath(now: number): void {
    if (!this.alive || !this.spawned || now < this.invulnUntil) return;
    for (const a of this.world.asteroids) {
      if (dist2(a.x, a.y, this.shipX, this.shipY) <= a.radius * a.radius) {
        this.die(now, null);
        return;
      }
    }
    const u = this.world.ufo;
    if (u && dist2(u.x, u.y, this.shipX, this.shipY) <= UFO_RADIUS * UFO_RADIUS) {
      this.die(now, null);
      return;
    }
    const myId = this.client.playerId;
    for (const [id, player] of Object.entries(this.client.players)) {
      if (id === myId) continue;
      const st = readNetState(player);
      if (!st || !st.alive) continue;
      for (const sb of st.beams) {
        const hit = sb.exploding
          ? dist2(sb.hx, sb.hy, this.shipX, this.shipY) <= sb.explosionRadius * sb.explosionRadius
          : segHitsCircle(sb.tx, sb.ty, sb.hx, sb.hy, this.shipX, this.shipY, SHIP_RADIUS);
        if (hit) {
          this.die(now, id);
          return;
        }
      }
    }
  }

  private die(now: number, killerId: string | null): void {
    this.splinterBurst(this.shipX, this.shipY, 50, 30, now);
    this.cameras.main.shake(280, 0.008);
    this.alive = false;
    this.respawnAt = now + RESPAWN_DELAY_MS;
    this.invulnUntil = 0;
    this.beams = [];
    const myId = this.client.playerId;
    if (killerId && myId) {
      this.client.sendEvent("player_killed", { killerId, victimId: myId });
    }
    this.pushMyState(now); // immediate, so remote ships hide without 50ms lag
  }

  private pickupItems(now: number): void {
    if (!this.alive || !this.spawned) return;
    const items = this.world.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (this.recentPickups.has(it.id)) continue;
      if (dist2(it.x, it.y, this.shipX, this.shipY) > ITEM_PICKUP_RADIUS * ITEM_PICKUP_RADIUS) {
        continue;
      }
      const weapon = WEAPONS_SPECIAL[it.weaponIdx] ?? WEAPON_DEFAULT;
      this.weapon = weapon;
      this.weaponUntil = now + SPECIAL_WEAPON_DURATION_MS;
      this.recentPickups.set(it.id, now);
      this.impactBurst(this.shipX, this.shipY, weapon.tint, 14);
      this.client.sendEvent("item_pickup", { itemId: it.id });
      // Remove locally right away; the host event (or the next reconcile,
      // guarded by recentPickups) makes it stick.
      items.splice(i, 1);
      if (this.client.isHost) this.dirty.items = true;
    }
    for (const [id, t] of this.recentPickups) {
      if (now - t > 5000) this.recentPickups.delete(id);
    }
  }

  private netSend(delta: number, now: number): void {
    this.netAcc += delta;
    if (this.netAcc < NET_INTERVAL_MS) return;
    this.netAcc = 0;
    this.pushMyState(now);
  }

  private pushMyState(now: number): void {
    if (!this.client.playerId) return;
    const state: PlayerNetState = {
      x: this.shipX,
      y: this.shipY,
      angle: this.shipAngle,
      alive: this.alive,
      invuln: now < this.invulnUntil,
      score: this.score,
      weaponName: this.weapon.name,
      beams: this.beams.filter((b) => !b.vanished).map(serializeBeam),
    };
    this.client.updateMyState(state);
  }

  // ---- connection callbacks ----------------------------------------------------

  private handleEvent(event: string, payload: unknown, _from: string): void {
    const p = asRecord(payload);
    if (event === "player_killed") {
      // The killer awards itself: every client hears the victim's report.
      if (p && p["killerId"] === this.client.playerId) this.score += SCORE.PLAYER_KILL;
      return;
    }
    if (!this.client.isHost || !p) return;
    if (event === "asteroid_hit") {
      const id = p["asteroidId"];
      const damage = p["damage"];
      if (typeof id === "string" && typeof damage === "number") {
        this.hostDamageAsteroid(id, damage);
      }
    } else if (event === "ufo_hit") {
      const damage = p["damage"];
      if (typeof damage === "number") this.hostDamageUfo(damage);
    } else if (event === "item_pickup") {
      const id = p["itemId"];
      if (typeof id !== "string") return;
      const idx = this.world.items.findIndex((it) => it.id === id);
      if (idx !== -1) {
        this.world.items.splice(idx, 1);
        this.dirty.items = true;
      }
    }
  }

  private onUpdate(): void {
    this.ensureSeeded();
    // Reconcile only when the shared object identity changed (i.e. a real
    // state patch) — notify() also fires for player-state traffic, and
    // re-blending toward a stale snapshot would drag entities backwards.
    if (!this.client.isHost && this.client.sharedState !== this.lastSharedRef) {
      this.lastSharedRef = this.client.sharedState;
      this.reconcileFromShared();
    }
  }

  private shared(): SharedState | null {
    return isShared(this.client.sharedState) ? this.client.sharedState : null;
  }

  /**
   * The first host to connect seeds the world. Guests adopt the host's
   * existing state; a guest promoted to host after a migration keeps the
   * live world instead of resetting it.
   */
  private ensureSeeded(): void {
    if (this.client.isHost && this.client.connectionStatus === "connected" && !this.shared()) {
      this.client.updateSharedState(emptyShared() as unknown as Record<string, unknown>);
    }
  }

  /** Guest-side: adopt the host's 20Hz snapshot into the local working copy. */
  private reconcileFromShared(): void {
    const s = this.shared();
    if (!s) return;
    const w = this.world;

    const asteroidIds = new Set<string>();
    for (const a of s.asteroids) {
      asteroidIds.add(a.id);
      const local = w.asteroids.find((x) => x.id === a.id);
      if (!local) {
        w.asteroids.push(cloneAsteroid(a));
        continue;
      }
      local.radius = a.radius;
      local.verts = a.verts;
      local.vx = a.vx;
      local.vy = a.vy;
      blendPos(local, a.x, a.y);
    }
    // Departed asteroids (destroyed or culled) — display sweep handles the FX.
    w.asteroids = w.asteroids.filter((x) => asteroidIds.has(x.id));

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

    const itemIds = new Set<string>();
    for (const it of s.items) {
      itemIds.add(it.id);
      if (this.recentPickups.has(it.id)) continue; // picked locally, host lagging
      const local = w.items.find((x) => x.id === it.id);
      if (!local) {
        w.items.push({ ...it });
        continue;
      }
      local.vx = it.vx;
      local.vy = it.vy;
      local.diesAt = it.diesAt;
      blendPos(local, it.x, it.y);
    }
    w.items = w.items.filter((x) => itemIds.has(x.id) && !this.recentPickups.has(x.id));
  }

  // ---- world simulation ----------------------------------------------------------

  /** Movement integration — runs on every client for 60fps-smooth motion. */
  private advanceWorld(dt: number): void {
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
  }

  // ---- host-only logic -------------------------------------------------------------

  private hostTick(now: number, dt: number, delta: number): void {
    const w = this.world;
    const d = this.dirty;

    if (
      w.asteroids.length < ASTEROID_MAX_NUM &&
      now - this.lastAsteroidSpawnAt > ASTEROID_SPAWN_INTERVAL_MS
    ) {
      w.asteroids.push(spawnAsteroidState());
      this.lastAsteroidSpawnAt = now;
      d.asteroids = true;
    }

    const kept = w.asteroids.filter((a) => inWorld(a.x, a.y, ASTEROID_CULL_MARGIN));
    if (kept.length !== w.asteroids.length) {
      w.asteroids = kept;
      d.asteroids = true;
    }

    // Exactly one power-up in flight at a time: no UFO while an item lives.
    if (!w.ufo && w.items.length === 0 && Math.random() < UFO_SPAWN_RATE * dt) {
      w.ufo = spawnUfoState();
      d.ufo = true;
    }
    if (w.ufo && w.ufo.x === w.ufo.destX && w.ufo.y === w.ufo.destY) {
      w.ufo.destX = Math.random() * WORLD_W;
      w.ufo.destY = Math.random() * WORLD_H;
      d.ufo = true;
    }

    const liveItems = w.items.filter((it) => it.diesAt > now);
    if (liveItems.length !== w.items.length) {
      w.items = liveItems;
      d.items = true;
    }

    // Continuous motion dirties whatever is actually moving.
    if (w.asteroids.length > 0) d.asteroids = true;
    if (w.ufo) d.ufo = true;
    if (w.items.length > 0) d.items = true;

    this.shareAcc += delta;
    if (this.shareAcc < NET_INTERVAL_MS) return;
    this.shareAcc = 0;
    const patch: Record<string, unknown> = {};
    if (d.asteroids) patch["asteroids"] = w.asteroids;
    if (d.ufo) patch["ufo"] = w.ufo;
    if (d.items) patch["items"] = w.items;
    if (Object.keys(patch).length > 0) this.client.updateSharedState(patch);
    this.dirty = { asteroids: false, ufo: false, items: false };
  }

  private hostDamageAsteroid(id: string, damage: number): void {
    const w = this.world;
    const idx = w.asteroids.findIndex((a) => a.id === id);
    if (idx === -1) return;
    const a = w.asteroids[idx]!;
    const newRadius = a.radius - ASTEROID_MAX_RADIUS * Math.min(damage, 1);
    if (newRadius < ASTEROID_MIN_RADIUS) {
      w.asteroids.splice(idx, 1); // display sweep bursts it
    } else {
      // Scale the existing outline instead of re-rolling it — no shape pop.
      const ratio = newRadius / a.radius;
      a.verts = a.verts.map((v) => ({ x: v.x * ratio, y: v.y * ratio }));
      a.radius = newRadius;
      const ang = Math.atan2(a.vy, a.vx) + (Math.random() * 60 - 30) * DEG;
      const speed = asteroidSpeed(newRadius);
      a.vx = Math.cos(ang) * speed;
      a.vy = Math.sin(ang) * speed;
    }
    this.dirty.asteroids = true;
  }

  private hostDamageUfo(damage: number): void {
    const u = this.world.ufo;
    if (!u) return;
    u.hp -= damage * 100;
    u.blinkUntil = Date.now() + UFO_BLINK_MS;
    if (u.hp <= 0) {
      this.world.items.push(spawnItemState(u.x, u.y));
      this.world.ufo = null;
      this.dirty.items = true;
    }
    this.dirty.ufo = true;
  }

  // ---- shared-state rendering ---------------------------------------------------------

  private syncShips(now: number, dt: number): void {
    // Time-based smoothing (~0.35/frame at 60fps) so remote-ship glide speed
    // is refresh-rate independent.
    const blend = 1 - Math.exp(-25 * dt);
    const seen = new Set<string>();
    const myId = this.client.playerId;
    for (const [id, player] of Object.entries(this.client.players)) {
      seen.add(id);
      let rec = this.ships.get(id);
      if (!rec) {
        const tint = cssToInt(player.color);
        rec = { gfx: this.makeShipGfx(tint), tint, alive: true, seenState: false };
        this.ships.set(id, rec);
      }
      if (id === myId) {
        rec.gfx.setPosition(this.shipX, this.shipY).setRotation(this.shipAngle);
        rec.gfx.setVisible(this.spawned && this.alive);
        rec.gfx.setAlpha(now < this.invulnUntil ? blinkAlpha(now) : 1);
        rec.alive = this.alive;
        continue;
      }
      const st = readNetState(player);
      if (!st) {
        rec.gfx.setVisible(false);
        continue;
      }
      if (!rec.seenState) {
        // First snapshot: snap into place (no glide from the origin) and adopt
        // alive as-is (no death FX for players who were already dead).
        rec.seenState = true;
        rec.alive = st.alive;
        rec.gfx.setPosition(st.x, st.y);
      }
      if (rec.alive && !st.alive) this.splinterBurst(rec.gfx.x, rec.gfx.y, 50, 30, now);
      if (!rec.alive && st.alive) rec.gfx.setPosition(st.x, st.y); // respawn: snap, don't glide
      rec.alive = st.alive;
      rec.gfx.setVisible(st.alive);
      if (st.alive) {
        rec.gfx.setPosition(
          Phaser.Math.Linear(rec.gfx.x, st.x, blend),
          Phaser.Math.Linear(rec.gfx.y, st.y, blend),
        );
        rec.gfx.setRotation(st.angle);
        rec.gfx.setAlpha(st.invuln ? blinkAlpha(now) : 1); // networked invulnerability
      }
    }
    for (const [id, rec] of this.ships) {
      if (!seen.has(id)) {
        rec.gfx.destroy();
        this.ships.delete(id);
      }
    }
  }

  private syncAsteroids(now: number): void {
    const seen = new Set<string>();
    for (const a of this.world.asteroids) {
      seen.add(a.id);
      let rec = this.asteroidObjs.get(a.id);
      if (!rec) {
        rec = { gfx: this.add.graphics().setDepth(5), drawnRadius: 0 };
        this.asteroidObjs.set(a.id, rec);
      }
      if (rec.drawnRadius !== a.radius) {
        drawPoly(rec.gfx, a.verts);
        if (rec.drawnRadius > a.radius) {
          // Took a hit: brief scale pop.
          rec.gfx.setScale(1.15);
          this.tweens.add({ targets: rec.gfx, scale: 1, duration: 120, ease: "Quad.Out" });
        }
        rec.drawnRadius = a.radius;
      }
      rec.gfx.setPosition(a.x, a.y).setRotation(a.rot);
    }
    for (const [id, rec] of this.asteroidObjs) {
      if (seen.has(id)) continue;
      // Destroyed (visible burst) or culled off-world (burst hidden by mask).
      this.splinterBurst(rec.gfx.x, rec.gfx.y, rec.drawnRadius, 20, now);
      this.tweens.killTweensOf(rec.gfx);
      rec.gfx.destroy();
      this.asteroidObjs.delete(id);
    }
  }

  private syncUfo(now: number): void {
    const u = this.world.ufo;
    if (!u) {
      if (this.ufoGfx) {
        this.splinterBurst(this.ufoGfx.x, this.ufoGfx.y, 25, 20, now);
        this.ufoGfx.destroy();
        this.ufoGfx = null;
      }
      return;
    }
    if (!this.ufoGfx || this.ufoId !== u.id) {
      this.ufoGfx?.destroy();
      this.ufoGfx = this.makeUfoGfx();
      this.ufoId = u.id;
    }
    this.ufoGfx.setPosition(u.x, u.y);
    // Damage flicker: hidden every 4th 66ms slot (legacy: every 4th tick of 40).
    const hidden = now < u.blinkUntil && Math.floor(now / 66) % 4 === 0;
    this.ufoGfx.setVisible(!hidden);
  }

  private syncItems(): void {
    const seen = new Set<string>();
    for (const it of this.world.items) {
      seen.add(it.id);
      let rec = this.itemObjs.get(it.id);
      if (!rec) {
        const tint = WEAPONS_SPECIAL[it.weaponIdx]?.tint ?? 0xffffff;
        rec = { gfx: this.makeItemGfx(tint), tint };
        this.itemObjs.set(it.id, rec);
        this.tweens.add({
          targets: rec.gfx,
          scale: { from: 0.92, to: 1.1 },
          duration: 600,
          ease: "Sine.InOut",
          yoyo: true,
          repeat: -1,
        });
      }
      rec.gfx.setPosition(it.x, it.y);
    }
    for (const [id, rec] of this.itemObjs) {
      if (seen.has(id)) continue;
      this.impactBurst(rec.gfx.x, rec.gfx.y, rec.tint, 10);
      this.tweens.killTweensOf(rec.gfx);
      rec.gfx.destroy();
      this.itemObjs.delete(id);
    }
  }

  /** All beams — mine simulated, everyone else's raw from their snapshots. */
  private drawBeams(): void {
    const g = this.beamGfx;
    g.clear();
    const myId = this.client.playerId;
    const draw = (sb: SerializedBeam): void => {
      if (sb.exploding) {
        g.lineStyle(1, sb.tint, 1).strokeCircle(sb.hx, sb.hy, sb.explosionRadius);
      } else {
        g.lineStyle(sb.width, sb.tint, 1).lineBetween(sb.tx, sb.ty, sb.hx, sb.hy);
      }
    };
    for (const b of this.beams) {
      if (!b.vanished) draw(serializeBeam(b));
    }
    for (const [id, player] of Object.entries(this.client.players)) {
      if (id === myId) continue;
      const st = readNetState(player);
      if (!st || !st.alive) continue;
      for (const sb of st.beams) draw(sb);
    }
  }

  // ---- visual effects ----------------------------------------------------------------

  /** Classic vector death debris: white pixel squares radiating outward. */
  private splinterBurst(x: number, y: number, radius: number, count: number, now: number): void {
    for (let i = 0; i < count; i++) {
      this.splinters.push({
        originX: x,
        originY: y,
        angle: Math.random() * Math.PI * 2,
        dist: Math.random() * radius,
        speed: Math.random() * 60, // legacy 0..1 px/tick
        diesAt: now + SPLINTER_LIFE_MS,
        x,
        y,
      });
    }
  }

  private updateSplinters(dt: number, now: number): void {
    this.splinters = this.splinters.filter((s) => {
      s.dist += s.speed * dt;
      s.x = s.originX + Math.cos(s.angle) * s.dist;
      s.y = s.originY + Math.sin(s.angle) * s.dist;
      return now < s.diesAt && inWorld(s.x, s.y, 10);
    });
    const g = this.splinterGfx;
    g.clear();
    g.fillStyle(0xffffff, 1);
    for (const s of this.splinters) g.fillRect(s.x, s.y, SPLINTER_PX, SPLINTER_PX);
  }

  private impactBurst(x: number, y: number, tint: number, count: number): void {
    const emitter = this.add.particles(x, y, "spark", {
      speed: { min: 30, max: 140 },
      angle: { min: 0, max: 360 },
      lifespan: { min: 200, max: 420 },
      scale: { start: 0.7, end: 0 },
      alpha: { start: 1, end: 0 },
      tint,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    emitter.setDepth(20);
    emitter.explode(count);
    this.time.delayedCall(600, () => emitter.destroy());
  }

  /** Hard-centered on the ship (plus recoil); unzoomed, so no bounds clamping. */
  private updateCamera(dt: number): void {
    if (!this.spawned) return;
    const decay = Math.exp(-8 * dt);
    this.kickX *= decay;
    this.kickY *= decay;
    this.cameras.main.centerOn(this.shipX + this.kickX, this.shipY + this.kickY);
  }

  // ---- display-object factories ---------------------------------------------------------

  private makeShipGfx(tint: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(10);
    g.lineStyle(1, tint, 1);
    strokeClosed(g, shipHullPoints());
    return g;
  }

  private makeUfoGfx(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(6);
    g.lineStyle(1, 0xffffff, 1);
    strokeClosed(g, UFO_OUTLINE);
    const [, , p2, p3, , , p6, p7] = UFO_OUTLINE;
    if (p2 && p3 && p6 && p7) {
      g.lineBetween(p2.x, p2.y, p7.x, p7.y);
      g.lineBetween(p3.x, p3.y, p6.x, p6.y);
    }
    return g;
  }

  private makeItemGfx(tint: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(4);
    g.lineStyle(1, tint, 1);
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI * 2 * i) / 6;
      pts.push({ x: Math.cos(a) * ITEM_DRAW_RADIUS, y: Math.sin(a) * ITEM_DRAW_RADIUS });
    }
    strokeClosed(g, pts);
    for (let i = 0; i < 3; i++) {
      const a = pts[i]!;
      const b = pts[i + 3]!;
      g.lineBetween(a.x, a.y, b.x, b.y);
    }
    return g;
  }

  // ---- minimap + HUD ---------------------------------------------------------------------

  private drawMinimap(): void {
    const g = this.minimapGfx;
    g.clear();
    const x0 = this.scale.width - MINIMAP_W - MINIMAP_PAD;
    const y0 = this.scale.height - MINIMAP_H - MINIMAP_PAD;
    g.fillStyle(0x000000, 0.6).fillRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    g.lineStyle(1, 0xffffff, 0.15).strokeRoundedRect(x0, y0, MINIMAP_W, MINIMAP_H, 4);
    const sx = MINIMAP_W / WORLD_W;
    const sy = MINIMAP_H / WORLD_H;

    for (const a of this.world.asteroids) {
      if (!inWorld(a.x, a.y, 0)) continue; // no auto-clip on Graphics
      g.fillStyle(0xffffff, 0.3);
      g.fillCircle(x0 + a.x * sx, y0 + a.y * sy, Math.max(1, a.radius * sx * 0.3));
    }

    const myId = this.client.playerId;
    for (const [id, player] of Object.entries(this.client.players)) {
      const isMe = id === myId;
      const tint = this.ships.get(id)?.tint ?? 0xffffff;
      let px: number;
      let py: number;
      if (isMe) {
        if (!this.spawned || !this.alive) continue;
        px = this.shipX;
        py = this.shipY;
      } else {
        const st = readNetState(player);
        if (!st || !st.alive) continue; // each dot filtered by ITS player's alive state
        px = st.x;
        py = st.y;
      }
      g.fillStyle(tint, 1).fillCircle(x0 + px * sx, y0 + py * sy, isMe ? 3 : 2);
    }
  }

  private updateHud(now: number): void {
    setText(this.scoreEl, String(this.score));
    setText(this.weaponEl, this.weapon.name);
    const n = Object.keys(this.client.players).length;
    setText(this.playersEl, `${n} player${n === 1 ? "" : "s"}`);
    const dead = this.spawned && !this.alive;
    if (this.overlayEl) this.overlayEl.style.opacity = dead ? "1" : "0";
    const secs = dead ? Math.max(0, Math.ceil((this.respawnAt - now) / 1000)) : 0;
    setText(this.countdownEl, secs > 0 ? `Respawning in ${secs}...` : "");
  }
}

// ---- module helpers (pure) ----------------------------------------------------------------

/** Saucer outline relative to the UFO's reference point (half-width UFO_RADIUS). */
const UFO_OUTLINE: ReadonlyArray<{ x: number; y: number }> = [
  { x: -4.5, y: -5 },
  { x: 4.5, y: -5 },
  { x: 7, y: 0 },
  { x: UFO_RADIUS, y: 4.5 },
  { x: 7, y: 9 },
  { x: -7, y: 9 },
  { x: -UFO_RADIUS, y: 4.5 },
  { x: -7, y: 0 },
];

function shipHullPoints(): Array<{ x: number; y: number }> {
  return SHIP_HULL_DEG.map((deg) => {
    const r = deg === 180 ? SHIP_RADIUS / 2 : SHIP_RADIUS;
    return { x: Math.cos(deg * DEG) * r, y: Math.sin(deg * DEG) * r };
  });
}

function strokeClosed(
  g: Phaser.GameObjects.Graphics,
  pts: ReadonlyArray<{ x: number; y: number }>,
): void {
  const first = pts[0];
  if (!first) return;
  g.beginPath();
  g.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
  g.closePath();
  g.strokePath();
}

function drawPoly(g: Phaser.GameObjects.Graphics, verts: ReadonlyArray<{ x: number; y: number }>) {
  g.clear();
  g.lineStyle(1, 0xffffff, 1);
  strokeClosed(g, verts);
}

function serializeBeam(b: Beam): SerializedBeam {
  return {
    hx: b.head.x,
    hy: b.head.y,
    tx: b.tail.x,
    ty: b.tail.y,
    tint: b.weapon.tint,
    width: b.weapon.width,
    exploding: b.exploding,
    explosionRadius: b.explosionRadius,
  };
}

function readNetState(player: Player | undefined): PlayerNetState | null {
  const s = player?.state;
  if (!s) return null;
  const x = s["x"];
  const y = s["y"];
  const angle = s["angle"];
  if (typeof x !== "number" || typeof y !== "number" || typeof angle !== "number") return null;
  const beams: SerializedBeam[] = [];
  const raw = s["beams"];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const b = asRecord(entry);
      if (!b) continue;
      const hx = b["hx"];
      const hy = b["hy"];
      const tx = b["tx"];
      const ty = b["ty"];
      const tint = b["tint"];
      const width = b["width"];
      if (
        typeof hx !== "number" ||
        typeof hy !== "number" ||
        typeof tx !== "number" ||
        typeof ty !== "number" ||
        typeof tint !== "number" ||
        typeof width !== "number"
      ) {
        continue;
      }
      const er = b["explosionRadius"];
      beams.push({
        hx,
        hy,
        tx,
        ty,
        tint,
        width,
        exploding: b["exploding"] === true,
        explosionRadius: typeof er === "number" ? er : 0,
      });
    }
  }
  const score = s["score"];
  const weaponName = s["weaponName"];
  return {
    x,
    y,
    angle,
    alive: s["alive"] !== false,
    invuln: s["invuln"] === true,
    score: typeof score === "number" ? score : 0,
    weaponName: typeof weaponName === "string" ? weaponName : "",
    beams,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function cloneAsteroid(a: AsteroidState): AsteroidState {
  return { ...a, verts: a.verts.map((v) => ({ ...v })) };
}

/** Soft-correct a dead-reckoned position toward the authoritative one. */
function blendPos(target: { x: number; y: number }, ax: number, ay: number): void {
  const dx = ax - target.x;
  const dy = ay - target.y;
  if (dx * dx + dy * dy > SNAP_DIST * SNAP_DIST) {
    target.x = ax;
    target.y = ay;
  } else {
    target.x += dx * 0.3;
    target.y += dy * 0.3;
  }
}

function blinkAlpha(now: number): number {
  return Math.floor(now / INVULN_BLINK_MS) % 2 === 0 ? 0.9 : 0.3;
}

function inWorld(x: number, y: number, margin: number): boolean {
  return x >= -margin && x <= WORLD_W + margin && y >= -margin && y <= WORLD_H + margin;
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Closest-point distance from segment (x1,y1)→(x2,y2) to a circle. */
function segHitsCircle(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Phaser.Math.Clamp(((cx - x1) * dx + (cy - y1) * dy) / len2, 0, 1) : 0;
  return dist2(x1 + dx * t, y1 + dy * t, cx, cy) <= r * r;
}

function setText(el: HTMLElement | null, text: string): void {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Server player colors are `hsl(h, s%, l%)` strings; Graphics wants ints. */
function cssToInt(css: string | undefined): number {
  if (!css) return 0xffffff;
  const hsl = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(css);
  if (hsl) {
    return hslToInt(Number(hsl[1] ?? 0), Number(hsl[2] ?? 0) / 100, Number(hsl[3] ?? 100) / 100);
  }
  const rgb = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(css);
  if (rgb) {
    return (Number(rgb[1] ?? 255) << 16) | (Number(rgb[2] ?? 255) << 8) | Number(rgb[3] ?? 255);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(css);
  if (hex) return parseInt(hex[1] ?? "ffffff", 16);
  return 0xffffff;
}

function hslToInt(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
