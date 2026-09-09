import { Math as PhaserMath } from "phaser";
import { sfx } from "../audio/sfx";
import type { PlayOpts } from "../audio/sfx";
import { weaponSound } from "../audio/weapon-sound";
import { weaponLook } from "../render/combat-visuals";
import type { WeaponLook } from "../render/combat-visuals";
import { lerpTint } from "../render/tint";
import type { GameScene } from "../scenes/game-scene";
import { now as simNow } from "../shared/clock";
import {
  ARC_CAST_CONE_DEG,
  ARC_FIZZLE_LEN,
  ARC_RENDER_MS,
  FLAK_FRAG_WEAPON,
  GLAIVE_DECEL_PX,
  GRAVITON_PULL_MS,
  HOMING_LOCK_CONE_DEG,
  MINE_ARM_MS,
  MINE_LIFETIME_MS,
  MINE_MAX_LIVE,
  MINE_TRIGGER_RADIUS,
  OVERDRIVE_RATE_MULT,
  SENTRY_FIRE_MS,
  SENTRY_LIFETIME_MS,
  SENTRY_RANGE,
  SHIP_RADIUS,
  SINGULARITY_PULL_MS,
  TWIN_ORBIT_DEG_PER_S,
  TWIN_ORBIT_RADIUS,
  TWIN_POWER_MULT,
  WEAPONS_SPECIAL,
  WEAPON_DEFAULT,
  XP,
  asteroidDestroyedBy,
} from "../shared/constants";
import type { AsteroidState, Vec, Weapon } from "../shared/constants";
import { rand } from "../shared/rng";
import { BEAM_CULL_MARGIN, targetKey } from "./beam";
import type { Beam, TargetRef } from "./beam";
import { DEG, dist2, inWorld, rotateToward, wrapAngle } from "./geometry";

type WeaponsScene = Pick<
  GameScene,
  | "alive"
  | "boosts"
  | "fx"
  | "hits"
  | "hostCombat"
  | "isFiring"
  | "kickX"
  | "kickY"
  | "mastery"
  | "myId"
  | "netSendEvent"
  | "peerStates"
  | "progress"
  | "shield"
  | "shipAngle"
  | "shipView"
  | "shipX"
  | "shipY"
  | "spawned"
  | "time"
  | "trailer"
  | "trauma"
  | "view"
  | "weapon"
  | "world"
>;

/** Transient muzzle flash strokes (1–2 frames), drawn additively. */
export interface MuzzleFlash {
  x: number;
  y: number;
  angle: number;
  size: number;
  tint: number;
  diesAt: number;
  kind: "cross" | "line" | "ring";
}

/** SENTRY stat block: the turret keeps firing it even after the owner's
 *  weapon slot moves on (the turret outlives the trigger). */
export const SENTRY_WEAPON = WEAPONS_SPECIAL.find((w) => w.sentry) ?? WEAPON_DEFAULT;

export const SINGULARITY_TINT = WEAPONS_SPECIAL.find((w) => w.singularity)?.tint ?? 0x7c_3a_ed;

/** PLASMA CONE per-shot tint gradient endpoints (hot pink -> orange). */
export const PLASMA_TINT_A = 0xff_2d_78;

export const PLASMA_TINT_B = 0xff_9a_3d;

/** PHASE LANCE: the asteroid pass iterates this instead (skip, zero alloc). */
export const NO_ASTEROIDS: readonly AsteroidState[] = [];

/** TWIN orbit phase — derived from the wall clock with the exact formula
 *  remotes use, so the owner's drone and every remote render agree. */
export const twinAngle = (): number => (simNow() / 1000) * TWIN_ORBIT_DEG_PER_S * DEG;

/** Muzzle burst radius per weapon family (§9). */
export const muzzleBurstSize = (look: WeaponLook): number => {
  if (look === "rail") {
    return 36;
  }
  if (look === "heavy" || look === "scatter") {
    return 25;
  }
  if (look === "rapid" || look === "plasma") {
    return 13;
  }
  return 19;
};

/** The owner-simulated arsenal: trigger cadence and windup, every fire mode (pellets, arc, tesla aura, mines, cluster, nova, sentry), beam flight and its hits, and the muzzle feedback. */
export class Weapons {
  shootCooldown = 0;

  beams: Beam[] = [];

  /** RAILGUN charge accumulator, ms (resets on release). */
  windupAcc = 0;

  /** SENTRY turret (owner-simulated; pos+until mirrored into net state). */
  sentry: { x: number; y: number; until: number; nextFireAt: number } | null = null;

  muzzleFlashes: MuzzleFlash[] = [];

  private readonly scene: WeaponsScene;

  constructor(scene: WeaponsScene) {
    this.scene = scene;
  }

  handleShooting(delta: number, now: number): void {
    if (!this.scene.alive || !this.scene.spawned) {
      return;
    }
    // The cooldown runs into (bounded) deficit and each shot pays intervalMs
    // back, so the leftover carries between shots — true average cadence on
    // any refresh rate instead of rounding up to whole frames. OVERDRIVE
    // multiplies intervalMs and windupMs at fire time (+50% rate).
    const rateMult = this.scene.boosts.has("overdrive") ? OVERDRIVE_RATE_MULT : 1;
    const interval = this.scene.weapon.intervalMs * rateMult;
    this.shootCooldown = Math.max(-interval, this.shootCooldown - delta);
    if (!this.scene.alive || !this.scene.spawned || now < this.scene.shield.phasedUntil) {
      this.windupAcc = 0;
      return;
    }
    if (!this.scene.isFiring()) {
      // releasing mid-windup cancels
      this.windupAcc = 0;
      return;
    }
    const windupMs = this.scene.weapon.windupMs * rateMult;
    if (windupMs > 0) {
      // Charge runs inside the interval (cycle = max(interval, windup)) and
      // auto-repeats while held — the one-button identity holds.
      this.windupAcc = Math.min(windupMs, this.windupAcc + delta);
      if (this.windupAcc < windupMs || this.shootCooldown > 0) {
        return;
      }
      this.windupAcc = 0;
    } else {
      this.windupAcc = 0;
      if (this.shootCooldown > 0) {
        return;
      }
    }
    this.shootCooldown += interval;
    this.fireWeapon(now);
  }

  /** 0–1 charge fraction of a windup weapon (0 for everything else). */
  windupFrac(): number {
    const rateMult = this.scene.boosts.has("overdrive") ? OVERDRIVE_RATE_MULT : 1;
    const windupMs = this.scene.weapon.windupMs * rateMult;
    return windupMs > 0 ? Math.min(1, this.windupAcc / windupMs) : 0;
  }

  /** One volley of the current weapon (pellets / arc cast / mine / nova). */
  fireWeapon(now: number): void {
    const nose = {
      x: this.scene.shipX + Math.cos(this.scene.shipAngle) * SHIP_RADIUS,
      y: this.scene.shipY + Math.sin(this.scene.shipAngle) * SHIP_RADIUS,
    };
    const w = this.scene.weapon;
    const { arc } = w;
    let gainScale = 1;
    if (arc && w.aura) {
      // TESLA AURA: nothing in range = a silent tick (no sound, no muzzle).
      if (!this.fireAuraZap(now, arc)) {
        return;
      }
    } else if (arc) {
      // fizzle: quieter zap
      if (this.fireArc(now, nose, arc)) {
        gainScale = 0.5;
      }
    } else if (w.mine) {
      this.dropMine(now);
    } else if (w.cluster) {
      this.fireClusterVolley(w);
    } else if (w.explosion && w.speed === 0) {
      // NOVA: radial shockwave centered on the ship — serialized as an
      // exploding beam (existing fields), so victims/remotes need zero new code.
      const b = this.makeBeam(
        { x: this.scene.shipX, y: this.scene.shipY },
        this.scene.shipAngle,
        w,
        now,
      );
      b.released = true;
      b.exploding = true;
      this.beams.push(b);
      this.scene.fx.battle.burst(
        this.scene.shipX,
        this.scene.shipY,
        Math.min(260, w.explosion.range * 0.85),
        w.tint,
        "detonation",
        0,
        "important",
      );
    } else {
      // SENTRY: the trigger also places/moves the turret (sound gated there).
      if (w.sentry) {
        this.placeSentry(now);
      }
      // PLASMA: per-shot tint lerps the hot pink->orange gradient.
      const vw = w.sfx === "plasma" ? { ...w, tint: lerpTint(PLASMA_TINT_A, PLASMA_TINT_B) } : w;
      this.firePellets(nose, this.scene.shipAngle, vw, now);
      if (vw.mirror) {
        // MIRROR: the 180-deg copy launches from the tail.
        const back = {
          x: this.scene.shipX - Math.cos(this.scene.shipAngle) * SHIP_RADIUS,
          y: this.scene.shipY - Math.sin(this.scene.shipAngle) * SHIP_RADIUS,
        };
        this.firePellets(back, this.scene.shipAngle + Math.PI, vw, now);
      }
      // TWIN mirrors beams only (mines/nova excluded above by branch).
      const twin = this.twinPos();
      if (twin) {
        const tw = { ...vw, power: vw.power * TWIN_POWER_MULT };
        this.firePellets(twin, this.scene.shipAngle, tw, now);
        if (tw.mirror) {
          this.firePellets(twin, this.scene.shipAngle + Math.PI, tw, now);
        }
      }
    }
    this.muzzleFx(nose, now, gainScale);
  }

  /** TESLA AURA: zap the nearest non-player target within castRange of the
   *  SHIP (omnidirectional, no cone) — a single-hop ARC chain. Players are
   *  excluded on purpose: PvP runs victim-side off the serialized `tesla`
   *  flag (RAM pattern), so a chain hit-test would double-dip. Returns
   *  false when nothing was in range (the caller stays silent). */
  private fireAuraZap(now: number, spec: NonNullable<Weapon["arc"]>): boolean {
    const r2 = spec.castRange * spec.castRange;
    let best: { ref: TargetRef; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const e of this.scene.world.enemies) {
      const d = dist2(e.x, e.y, this.scene.shipX, this.scene.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { id: e.id, kind: "enemy" }, x: e.x, y: e.y };
      }
    }
    const u = this.scene.world.ufo;
    if (u) {
      const d = dist2(u.x, u.y, this.scene.shipX, this.scene.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { kind: "ufo" }, x: u.x, y: u.y };
      }
    }
    for (const a of this.scene.world.asteroids) {
      const d = dist2(a.x, a.y, this.scene.shipX, this.scene.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { id: a.id, kind: "asteroid" }, x: a.x, y: a.y };
      }
    }
    if (!best) {
      return false;
    }
    const origin = { x: this.scene.shipX, y: this.scene.shipY };
    const chain: Vec[] = [origin, { x: best.x, y: best.y }];
    this.applyArcDamage(best.ref, best.x, best.y, this.scene.weapon.power * 100, now);
    this.beams.push({
      ...this.makeBeam(
        origin,
        Math.atan2(best.y - this.scene.shipY, best.x - this.scene.shipX),
        this.scene.weapon,
        now,
      ),
      chain,
      diesAt: now + ARC_RENDER_MS,
    });
    return true;
  }

  /** SENTRY: place (or move) the one turret at the ship; re-placing
   *  refreshes its 12s life. The clack only plays on a real move so
   *  drag-firing doesn't machine-gun the sound. */
  private placeSentry(now: number): void {
    const prev = this.sentry;
    const moved = !prev || dist2(prev.x, prev.y, this.scene.shipX, this.scene.shipY) > 100 * 100;
    this.sentry = {
      nextFireAt: prev?.nextFireAt ?? 0,
      until: now + SENTRY_LIFETIME_MS,
      x: this.scene.shipX,
      y: this.scene.shipY,
    };
    if (moved) {
      sfx.play("sentry_place", { priority: "local" });
      this.scene.fx.ring(this.scene.shipX, this.scene.shipY, 4, 18, 200, SENTRY_WEAPON.tint, 0.6);
    }
  }

  /** SENTRY turret sim: every SENTRY_FIRE_MS fire a bolt (ordinary owner
   *  beam — hits, score and serialization all ride the normal pipelines)
   *  at the nearest enemy, else the nearest asteroid, within range. */
  tickSentry(now: number): void {
    const s = this.sentry;
    if (!s) {
      return;
    }
    if (!this.scene.alive || now >= s.until) {
      this.sentry = null;
      return;
    }
    if (now < s.nextFireAt) {
      return;
    }
    const r2 = SENTRY_RANGE * SENTRY_RANGE;
    let best: Vec | null = null;
    let bestD = Infinity;
    for (const e of this.scene.world.enemies) {
      const d = dist2(e.x, e.y, s.x, s.y);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
    if (!best) {
      for (const a of this.scene.world.asteroids) {
        const d = dist2(a.x, a.y, s.x, s.y);
        if (d <= r2 && d < bestD) {
          bestD = d;
          best = { x: a.x, y: a.y };
        }
      }
    }
    // nothing in range: rescan next frame, no cooldown
    if (!best) {
      return;
    }
    const ang = Math.atan2(best.y - s.y, best.x - s.x);
    this.beams.push(this.makeBeam({ x: s.x, y: s.y }, ang, SENTRY_WEAPON, now));
    s.nextFireAt = now + SENTRY_FIRE_MS;
    this.scene.fx.battle.burst(s.x, s.y, 18, SENTRY_WEAPON.tint, "muzzle", ang);
    this.scene.fx.sparks(s.x, s.y, 2, SENTRY_WEAPON.tint, {
      lifeMax: 140,
      lifeMin: 80,
      scale: 0.4,
    });
    if (this.scene.view.onScreen(s.x, s.y)) {
      sfx.play("fire_pulse", { gain: 0.35, rate: 1.15 });
    }
  }

  /** TESLA AURA live = weapon held and able to fire (mirrored to the wire). */
  teslaActive(now: number): boolean {
    return (
      this.scene.weapon.aura &&
      this.scene.alive &&
      this.scene.spawned &&
      this.scene.isFiring() &&
      now >= this.scene.shield.phasedUntil
    );
  }

  /** The pellet/spread loop, parameterized by origin (ship nose or TWIN drone). */
  private firePellets(origin: Vec, aimAngle: number, weapon: Weapon, now: number): void {
    const n = weapon.pellets;
    for (let i = 0; i < n; i += 1) {
      const spread = n > 1 ? -weapon.spreadDeg / 2 + (weapon.spreadDeg * i) / (n - 1) : 0;
      const jitter = (rand() * 2 - 1) * weapon.jitterDeg;
      const angle = aimAngle + (spread + jitter) * DEG;
      this.beams.push(this.makeBeam(origin, angle, weapon, now));
    }
  }

  /** TWIN drone position while the booster is live, else null. */
  private twinPos(): Vec | null {
    if (!this.scene.boosts.has("twin")) {
      return null;
    }
    const a = twinAngle();
    return {
      x: this.scene.shipX + Math.cos(a) * TWIN_ORBIT_RADIUS,
      y: this.scene.shipY + Math.sin(a) * TWIN_ORBIT_RADIUS,
    };
  }

  /** CLUSTER: launch `missiles` staggered homing missiles. Each missile
   *  re-runs the nose position + HOMING lock at its own launch instant, so
   *  the stagger fans locks across a crowd. TWIN mirrors every missile
   *  (cluster missiles are ordinary beams). */
  private fireClusterVolley(w: Weapon): void {
    const spec = w.cluster;
    if (!spec) {
      return;
    }
    const launch = (): void => {
      if (!this.scene.alive || !this.scene.spawned) {
        return;
      }
      const t = simNow();
      const nose = {
        x: this.scene.shipX + Math.cos(this.scene.shipAngle) * SHIP_RADIUS,
        y: this.scene.shipY + Math.sin(this.scene.shipAngle) * SHIP_RADIUS,
      };
      this.firePellets(nose, this.scene.shipAngle, w, t);
      const twin = this.twinPos();
      if (twin) {
        this.firePellets(twin, this.scene.shipAngle, { ...w, power: w.power * TWIN_POWER_MULT }, t);
      }
    };
    launch();
    for (let i = 1; i < spec.missiles; i += 1) {
      this.scene.time.delayedCall(spec.staggerMs * i, launch);
    }
  }

  /** Drop a proximity mine at the ship's tail (owner-simulated, in beams[]). */
  private dropMine(now: number): void {
    const live = this.beams.filter((b) => b.mine && !b.exploding && !b.vanished);
    if (live.length >= MINE_MAX_LIVE) {
      const [oldest] = live;
      if (oldest) {
        // Over the cap: the oldest detonates harmlessly at 30% scale.
        oldest.vanished = true;
        const range = oldest.weapon.explosion?.range ?? 90;
        this.scene.fx.ring(
          oldest.head.x,
          oldest.head.y,
          4,
          range * 0.3,
          200,
          oldest.weapon.tint,
          0.4,
        );
      }
    }
    const tail = {
      x: this.scene.shipX - Math.cos(this.scene.shipAngle) * (SHIP_RADIUS + 4),
      y: this.scene.shipY - Math.sin(this.scene.shipAngle) * (SHIP_RADIUS + 4),
    };
    const b = this.makeBeam(tail, this.scene.shipAngle, this.scene.weapon, now);
    b.released = true;
    b.mine = { armAt: now + MINE_ARM_MS };
    b.diesAt = now + MINE_LIFETIME_MS;
    this.beams.push(b);
  }

  makeBeam(nose: Vec, angle: number, weapon: Weapon, now: number): Beam {
    const b: Beam = {
      angle,
      bouncesLeft: weapon.ricochet?.bounces ?? 0,
      chain: null,
      collapseUntil: 0,
      // Range-limited beams (PLASMA stream, SINGULARITY flight) expire after
      // range px of travel; everything else rides 0 (callers may override).
      diesAt: weapon.range > 0 && weapon.speed > 0 ? now + (weapon.range / weapon.speed) * 1000 : 0,
      exploding: false,
      explosionRadius: 0,
      fizzle: false,
      glaive: weapon.boomerang ? { returning: false, traveled: 0 } : null,
      head: { ...nose },
      hitIds: new Set(),
      mastery: this.scene.trailer ? null : this.scene.mastery.shot(weapon.name, now),
      mine: null,
      released: false,
      // desync glaive spin phases a little
      spin: now % 1000,
      tail: { ...nose },
      target: weapon.homing ? this.acquireHomingTarget(nose, weapon.homing.acquireRange) : null,
      traveled: 0,
      vanished: false,
      weapon,
    };
    if (weapon.windupMs > 0 && weapon.length > 0) {
      // RAILGUN: near-hitscan — the full lance renders (and hits) immediately.
      b.head.x += Math.cos(angle) * weapon.length;
      b.head.y += Math.sin(angle) * weapon.length;
      b.released = true;
    }
    return b;
  }

  /** Muzzle flash + camera kick + fire sfx, per weapon family (§9). */
  private muzzleFx(nose: Vec, now: number, gainScale = 1): void {
    const w = this.scene.weapon;
    const sound = weaponSound(w.sfx);
    const playOpts: PlayOpts = { gain: sound.gain * gainScale, priority: "local" };
    if (sound.rate !== undefined) {
      playOpts.rate = sound.rate;
    }
    sfx.play(sound.name, playOpts);
    // Every burst below sits ON the pilot's nose, so all of it damps together
    // in trailer mode (1 everywhere else — see hullGlow).
    const glow = this.scene.shipView.hullGlow();
    const look = weaponLook(w);
    if (look !== "nova") {
      const size = muzzleBurstSize(look);
      this.scene.fx.battle.burst(
        nose.x,
        nose.y,
        size * glow,
        w.tint,
        "muzzle",
        this.scene.shipAngle,
        "important",
      );
    }
    // OVERDRIVE: muzzle flashes gain a gold outer spark.
    if (this.scene.boosts.has("overdrive")) {
      this.scene.fx.sparks(nose.x, nose.y, 2, 0xfa_cc_15, {
        lifeMax: 180,
        lifeMin: 100,
        scale: 0.5 * glow,
        speedMax: 320,
        speedMin: 150,
      });
    }
    const aimDeg = this.scene.shipAngle / DEG;
    switch (w.sfx) {
      case "mine": {
        // Drop, not a shot: tiny puff, no kick.
        this.scene.fx.sparks(nose.x, nose.y, 2, w.tint, {
          lifeMax: 160,
          lifeMin: 100,
          scale: 0.4 * glow,
        });
        break;
      }
      case "nova": {
        // The expanding ring IS the effect; no muzzle, no kick.
        break;
      }
      case "rail": {
        // Heavy release (§C): kick 5px, trauma +0.08.
        this.scene.fx.sparks(nose.x, nose.y, 5, w.tint, {
          angleMax: aimDeg + 12,
          angleMin: aimDeg - 12,
          lifeMax: 200,
          lifeMin: 120,
          scale: 0.5 * glow,
          speedMax: 450,
          speedMin: 250,
        });
        this.muzzleFlashes.push({
          angle: this.scene.shipAngle,
          diesAt: now + 50,
          kind: "cross",
          size: 12,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.scene.trauma.add(0.08);
        this.kick(5);
        break;
      }
      case "tesla": {
        // The zap chain is the whole show — no muzzle, no kick.
        break;
      }
      case "heavy":
      case "glaive":
      case "drill":
      case "singularity": {
        this.scene.fx.sparks(nose.x, nose.y, 5, w.tint, {
          angleMax: aimDeg + 15,
          angleMin: aimDeg - 15,
          lifeMax: 200,
          lifeMin: 120,
          scale: 0.5 * glow,
          speedMax: 400,
          speedMin: 200,
        });
        this.muzzleFlashes.push({
          angle: this.scene.shipAngle,
          diesAt: now + 50,
          kind: "cross",
          size: 10,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.scene.trauma.add(0.06);
        this.kick(4);
        break;
      }
      case "zap": {
        this.muzzleFlashes.push({
          angle: this.scene.shipAngle,
          diesAt: now + 60,
          kind: "line",
          size: 14,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.kick(3);
        break;
      }
      case "arc":
      case "seek": {
        this.scene.fx.sparks(nose.x, nose.y, 4, w.tint, {
          lifeMax: 160,
          lifeMin: 100,
          scale: 0.5 * glow,
          speedMax: 250,
          speedMin: 100,
        });
        this.muzzleFlashes.push({
          angle: 0,
          diesAt: now + 30,
          kind: "ring",
          size: 8,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.kick(2);
        break;
      }
      default: {
        // pulse family (NORMAL, TINY, SCATTER, EXPLOSION)
        this.scene.fx.sparks(nose.x, nose.y, 3, w.tint, {
          angleMax: aimDeg + 15,
          angleMin: aimDeg - 15,
          lifeMax: 180,
          lifeMin: 100,
          scale: 0.5 * glow,
          speedMax: 400,
          speedMin: 200,
        });
        this.muzzleFlashes.push({
          angle: this.scene.shipAngle,
          diesAt: now + 30,
          kind: "cross",
          size: 6,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.kick(2);
        break;
      }
    }
  }

  /** Directional camera recoil opposite the shot. */
  private kick(px: number): void {
    this.scene.kickX -= Math.cos(this.scene.shipAngle) * px;
    this.scene.kickY -= Math.sin(this.scene.shipAngle) * px;
  }

  /** HOMING lock: nearest target in a front cone, enemies > players > UFO > asteroids. */
  private acquireHomingTarget(nose: Vec, range: number): TargetRef | null {
    const half = (HOMING_LOCK_CONE_DEG / 2) * DEG;
    const inCone = (x: number, y: number): number | null => {
      const d = Math.hypot(x - nose.x, y - nose.y);
      if (d > range) {
        return null;
      }
      const ang = Math.atan2(y - nose.y, x - nose.x);
      return Math.abs(wrapAngle(ang - this.scene.shipAngle)) <= half ? d : null;
    };
    let bestD = Infinity;
    let best: TargetRef | null = null;
    for (const e of this.scene.world.enemies) {
      const d = inCone(e.x, e.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { id: e.id, kind: "enemy" };
      }
    }
    if (best) {
      return best;
    }
    const { myId } = this.scene;
    for (const [id, st] of this.scene.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive || st.invuln || st.shieldMod?.phased) {
        continue;
      }
      const d = inCone(st.x, st.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { id, kind: "player" };
      }
    }
    if (best) {
      return best;
    }
    const u = this.scene.world.ufo;
    if (u && inCone(u.x, u.y) !== null) {
      return { kind: "ufo" };
    }
    for (const a of this.scene.world.asteroids) {
      const d = inCone(a.x, a.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { id: a.id, kind: "asteroid" };
      }
    }
    return best;
  }

  /** Current world position of a target ref, or null if it's gone. */
  private resolveTarget(ref: TargetRef): Vec | null {
    switch (ref.kind) {
      case "enemy": {
        const e = this.scene.world.enemies.find((x) => x.id === ref.id);
        return e ? { x: e.x, y: e.y } : null;
      }
      case "player": {
        const st = this.scene.peerStates.get(ref.id) ?? null;
        return st && st.alive ? { x: st.x, y: st.y } : null;
      }
      case "ufo": {
        const u = this.scene.world.ufo;
        return u ? { x: u.x, y: u.y } : null;
      }
      case "asteroid": {
        const a = this.scene.world.asteroids.find((x) => x.id === ref.id);
        return a ? { x: a.x, y: a.y } : null;
      }
      default: {
        return ref satisfies never;
      }
    }
  }

  /**
   * ARC: hitscan chain lightning. Damage applies at cast; the bolt then lives
   * ARC_RENDER_MS as a re-jittered polyline. The chain is serialized so
   * remotes render the exact geometry and PvP victims hit-test it — except
   * fizzles, which stay local. Returns true when the cast fizzled.
   */
  private fireArc(now: number, nose: Vec, spec: NonNullable<Weapon["arc"]>): boolean {
    const candidates = this.arcCandidates();
    const half = (ARC_CAST_CONE_DEG / 2) * DEG;
    let first: { ref: TargetRef; x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const d = Math.hypot(c.x - nose.x, c.y - nose.y);
      if (d > spec.castRange || d >= bestD) {
        continue;
      }
      const ang = Math.atan2(c.y - nose.y, c.x - nose.x);
      if (Math.abs(wrapAngle(ang - this.scene.shipAngle)) > half) {
        continue;
      }
      bestD = d;
      first = c;
    }
    if (!first) {
      // Fizzle: 80px jittered bolt, no damage, never serialized (a fizzle must
      // not hit-test against PvP victims); fireWeapon quiets the zap.
      const jang = this.scene.shipAngle + (Math.random() * 2 - 1) * 10 * DEG;
      const chain: Vec[] = [
        { ...nose },
        {
          x: nose.x + Math.cos(jang) * ARC_FIZZLE_LEN,
          y: nose.y + Math.sin(jang) * ARC_FIZZLE_LEN,
        },
      ];
      this.beams.push({
        ...this.makeBeam(nose, this.scene.shipAngle, this.scene.weapon, now),
        chain,
        diesAt: now + ARC_RENDER_MS,
        fizzle: true,
      });
      return true;
    }
    const hitRefs: { ref: TargetRef; x: number; y: number }[] = [first];
    const used = new Set<string>([targetKey(first.ref)]);
    let cur = first;
    for (let hop = 0; hop < spec.jumps; hop += 1) {
      let next: { ref: TargetRef; x: number; y: number } | null = null;
      let nd = Infinity;
      for (const c of candidates) {
        if (used.has(targetKey(c.ref))) {
          continue;
        }
        const d = Math.hypot(c.x - cur.x, c.y - cur.y);
        if (d <= spec.hopRange && d < nd) {
          nd = d;
          next = c;
        }
      }
      if (!next) {
        break;
      }
      used.add(targetKey(next.ref));
      hitRefs.push(next);
      cur = next;
    }
    const chain: Vec[] = [{ ...nose }];
    let dmg = this.scene.weapon.power * 100;
    for (const t of hitRefs) {
      chain.push({ x: t.x, y: t.y });
      this.applyArcDamage(t.ref, t.x, t.y, dmg, now);
      dmg *= spec.falloff;
    }
    this.beams.push({
      ...this.makeBeam(nose, this.scene.shipAngle, this.scene.weapon, now),
      chain,
      diesAt: now + ARC_RENDER_MS,
    });
    return false;
  }

  private arcCandidates(): { ref: TargetRef; x: number; y: number }[] {
    const out: { ref: TargetRef; x: number; y: number }[] = [];
    for (const e of this.scene.world.enemies) {
      out.push({ ref: { id: e.id, kind: "enemy" }, x: e.x, y: e.y });
    }
    const { myId } = this.scene;
    for (const [id, st] of this.scene.peerStates) {
      if (id === myId) {
        continue;
      }
      if (st && st.alive && !st.invuln && !st.shieldMod?.phased) {
        out.push({ ref: { id, kind: "player" }, x: st.x, y: st.y });
      }
    }
    const u = this.scene.world.ufo;
    if (u) {
      out.push({ ref: { kind: "ufo" }, x: u.x, y: u.y });
    }
    for (const a of this.scene.world.asteroids) {
      out.push({ ref: { id: a.id, kind: "asteroid" }, x: a.x, y: a.y });
    }
    return out;
  }

  private applyArcDamage(ref: TargetRef, x: number, y: number, dmgHp: number, now: number): void {
    this.scene.fx.battle.burst(
      x,
      y,
      22,
      this.scene.weapon.tint,
      "impact",
      Math.atan2(y - this.scene.shipY, x - this.scene.shipX),
    );
    this.scene.fx.sparks(x, y, 9, this.scene.weapon.tint, { lifeMax: 300, lifeMin: 150 });
    sfx.play("hit_spark", { gain: 0.4 });
    switch (ref.kind) {
      case "enemy": {
        const e = this.scene.world.enemies.find((en) => en.id === ref.id);
        if (!e) {
          return;
        }
        e.blinkUntil = now + 150;
        if (e.hp - dmgHp <= 0) {
          this.scene.hits.predictKill(
            e.id,
            this.scene.hostCombat.enemyKillXp(e.kind),
            "enemy",
            e.x,
            e.y,
            now,
          );
        }
        this.scene.netSendEvent("enemy_hit", { damage: dmgHp, enemyId: e.id });
        return;
      }
      case "asteroid": {
        const a = this.scene.world.asteroids.find((as) => as.id === ref.id);
        if (!a) {
          return;
        }
        const power = dmgHp / 100;
        const predicted =
          asteroidDestroyedBy(a.radius, power) &&
          this.scene.hits.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
        if (!predicted) {
          this.scene.progress.gainXp(XP.ASTEROID_CHIP, now);
        }
        this.scene.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: power });
        return;
      }
      case "ufo": {
        const u = this.scene.world.ufo;
        if (!u) {
          return;
        }
        if (u.hp - dmgHp <= 0) {
          this.scene.hits.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
        }
        this.scene.netSendEvent("ufo_hit", { damage: dmgHp / 100 });
        break;
      }
      case "player": {
        // The victim hit-tests the serialized chain and adjudicates its own
        // shield — nothing to send from the shooter side.
        break;
      }
      default: {
        ref satisfies never;
      }
    }
  }

  updateBeams(dt: number, now: number): void {
    this.beams = this.beams.filter((b) => !b.vanished);
    for (const b of this.beams) {
      if (this.updateStationaryBeam(b, dt, now)) {
        continue;
      }
      // Range-limited plain beams (FLAK fragments, PLASMA): expire at diesAt.
      if (b.diesAt > 0 && now >= b.diesAt) {
        b.vanished = true;
        continue;
      }
      const gl = b.glaive;
      const { boomerang } = b.weapon;
      if (gl && boomerang) {
        this.updateGlaive(b, gl, boomerang, dt);
        continue;
      }
      this.updateFlyingBeam(b, dt, now);
    }
  }

  /** Beams that don't fly this frame: mines, ARC bolts, explosions and the
   *  SINGULARITY collapse. Returns true when the beam was handled. */
  private updateStationaryBeam(b: Beam, dt: number, now: number): boolean {
    // Mine: stationary until triggered; lifetime expiry detonates it.
    if (b.mine && !b.exploding) {
      if (now >= b.diesAt) {
        this.detonateMine(b);
      }
      return true;
    }
    // ARC bolt: static geometry, render-only lifetime.
    if (b.chain) {
      if (now >= b.diesAt) {
        b.vanished = true;
      }
      return true;
    }
    if (b.exploding) {
      const { explosion } = b.weapon;
      if (!explosion) {
        b.vanished = true;
        return true;
      }
      b.explosionRadius += explosion.growth * dt;
      if (b.explosionRadius >= explosion.range) {
        b.vanished = true;
      }
      return true;
    }
    // SINGULARITY: freeze through the collapse, pop at its end; the
    // flight leg collapses at diesAt instead of vanishing.
    if (b.weapon.singularity) {
      if (b.collapseUntil > 0) {
        if (now >= b.collapseUntil) {
          this.popSingularity(b);
        }
        return true;
      }
      if (b.diesAt > 0 && now >= b.diesAt) {
        this.startCollapse(b, now);
        return true;
      }
    }
    return false;
  }

  /** GLAIVE: out, decelerate, boomerang home, catch. */
  private updateGlaive(
    b: Beam,
    gl: NonNullable<Beam["glaive"]>,
    boomerang: NonNullable<Weapon["boomerang"]>,
    dt: number,
  ): void {
    b.spin += 12 * dt;
    let step: number;
    if (gl.returning) {
      const dx = this.scene.shipX - b.head.x;
      const dy = this.scene.shipY - b.head.y;
      const dist = Math.hypot(dx, dy);
      if (!this.scene.alive || dist < SHIP_RADIUS + 6) {
        b.vanished = true;
        return;
      }
      b.angle = Math.atan2(dy, dx);
      step = boomerang.returnSpeed * dt;
    } else {
      const remaining = Math.max(0, boomerang.outRange - gl.traveled);
      const speed = Math.max(30, b.weapon.speed * Math.min(1, remaining / GLAIVE_DECEL_PX));
      step = speed * dt;
      gl.traveled += step;
      if (gl.traveled >= boomerang.outRange - 2) {
        gl.returning = true;
        // second pass re-arms against everything
        b.hitIds.clear();
      }
    }
    b.head.x += Math.cos(b.angle) * step;
    b.head.y += Math.sin(b.angle) * step;
    b.tail.x = b.head.x - Math.cos(b.angle) * b.weapon.length;
    b.tail.y = b.head.y - Math.sin(b.angle) * b.weapon.length;
    if (
      !inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN, this.scene.world.playW, this.scene.world.playH)
    ) {
      b.vanished = true;
    }
  }

  /** Straight / homing / ricochet flight: advance the head, then the tail. */
  private updateFlyingBeam(b: Beam, dt: number, now: number): void {
    // HOMING: steer toward the live lock, capped turn rate.
    const { homing } = b.weapon;
    if (homing && b.target) {
      const pos = this.resolveTarget(b.target);
      if (pos) {
        const desired = Math.atan2(pos.y - b.head.y, pos.x - b.head.x);
        b.angle = rotateToward(b.angle, desired, homing.turnDegPerSec * DEG * dt);
      } else {
        // lock died → fly straight
        b.target = null;
      }
    }
    const step = b.weapon.speed * dt;
    const sx = Math.cos(b.angle) * step;
    const sy = Math.sin(b.angle) * step;
    b.head.x += sx;
    b.head.y += sy;
    b.traveled += step;
    // FLAK: airburst at burstDist traveled (first-hit burst in onBeamHit).
    if (b.weapon.flak && b.traveled >= b.weapon.flak.burstDist) {
      this.burstFlak(b, now);
      return;
    }
    // RICOCHET: bounce off the world edge while bounces remain.
    if (
      b.bouncesLeft > 0 &&
      !inWorld(b.head.x, b.head.y, 0, this.scene.world.playW, this.scene.world.playH)
    ) {
      this.ricochetEdgeBounce(b);
    }
    if (
      !inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN, this.scene.world.playW, this.scene.world.playH)
    ) {
      b.vanished = true;
      return;
    }
    if (b.released) {
      if (homing) {
        // Curved path: keep the tail glued behind the head.
        b.tail.x = b.head.x - Math.cos(b.angle) * b.weapon.length;
        b.tail.y = b.head.y - Math.sin(b.angle) * b.weapon.length;
      } else {
        b.tail.x += sx;
        b.tail.y += sy;
      }
    } else if (Math.hypot(b.head.x - b.tail.x, b.head.y - b.tail.y) > b.weapon.length) {
      // The tail stays at the barrel until the beam reaches full length.
      b.released = true;
      b.tail.x = b.head.x - Math.cos(b.angle) * b.weapon.length;
      b.tail.y = b.head.y - Math.sin(b.angle) * b.weapon.length;
    }
  }

  /** Armed mines trigger on enemy / remote player / UFO proximity (§C). */
  tickMines(now: number): void {
    for (const b of this.beams) {
      if (!b.mine || b.exploding || b.vanished || now < b.mine.armAt) {
        continue;
      }
      if (this.mineTriggered(b.head.x, b.head.y)) {
        this.detonateMine(b);
      }
    }
  }

  /** Anything hostile inside the trigger radius: enemies, the UFO, or a
   *  targetable remote player (alive, not invulnerable, not phased). */
  private mineTriggered(x: number, y: number): boolean {
    const r2 = MINE_TRIGGER_RADIUS * MINE_TRIGGER_RADIUS;
    for (const e of this.scene.world.enemies) {
      if (dist2(e.x, e.y, x, y) <= r2) {
        return true;
      }
    }
    const u = this.scene.world.ufo;
    if (u && dist2(u.x, u.y, x, y) <= r2) {
      return true;
    }
    const { myId } = this.scene;
    for (const [id, st] of this.scene.peerStates) {
      if (id === myId) {
        continue;
      }
      if (!st || !st.alive || st.invuln || st.shieldMod?.phased) {
        continue;
      }
      if (dist2(st.x, st.y, x, y) <= r2) {
        return true;
      }
    }
    return false;
  }

  /** Standard explosion through the existing exploding/explosionRadius path. */
  private detonateMine(b: Beam): void {
    this.scene.fx.battle.burst(b.head.x, b.head.y, 70, b.weapon.tint, "detonation");
    b.exploding = true;
    b.explosionRadius = 0;
    if (this.scene.view.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_heavy", { gain: 0.8, rate: 0.85 });
      this.scene.trauma.add(0.06);
    }
  }

  /** Beam reaction to a hit: explode, airburst, pass through, or vanish. */
  onBeamHit(b: Beam, now: number): void {
    // expanding AoE keeps going; updateBeams expires it at range
    if (b.exploding) {
      return;
    }
    if (b.weapon.flak) {
      // first hit pops the shell early
      this.burstFlak(b, now);
      return;
    }
    if (b.weapon.explosion) {
      this.scene.fx.battle.burst(
        b.head.x,
        b.head.y,
        b.weapon.explosion.range * 0.75,
        b.weapon.tint,
        "detonation",
      );
      b.exploding = true;
      b.explosionRadius = 0;
      return;
    }
    if (!b.weapon.through) {
      b.vanished = true;
    }
  }

  /** FLAK airburst: the shell vanishes into `fragments` radial beams, each
   *  an ordinary beam with its own hit dedup, range-limited via diesAt.
   *  Fragments inherit the shell's hitIds so a direct-hit victim eats the
   *  shell once, not shell + 8 point-blank fragments. */
  private burstFlak(b: Beam, now: number): void {
    const spec = b.weapon.flak;
    if (!spec || b.vanished) {
      return;
    }
    b.vanished = true;
    const ttlMs = (spec.fragRange / FLAK_FRAG_WEAPON.speed) * 1000;
    for (let i = 0; i < spec.fragments; i += 1) {
      const ang = (Math.PI * 2 * i) / spec.fragments;
      const fb = this.makeBeam({ x: b.head.x, y: b.head.y }, ang, FLAK_FRAG_WEAPON, now);
      fb.released = true;
      fb.diesAt = now + ttlMs;
      fb.hitIds = new Set(b.hitIds);
      this.beams.push(fb);
    }
    this.scene.fx.battle.burst(
      b.head.x,
      b.head.y,
      spec.fragments > 8 ? 95 : 65,
      b.weapon.tint,
      "detonation",
    );
    this.scene.fx.ring(b.head.x, b.head.y, 4, 36, 200, b.weapon.tint, 0.7);
    if (this.scene.view.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_scatter", { gain: 0.7, rate: 0.9 });
      this.scene.trauma.add(0.04);
    }
  }

  /** SINGULARITY collapse start (flight range reached or first contact):
   *  freeze the orb, emit ONE shared pull event — the HOST applies the drag
   *  to its simulated enemies/asteroids so all clients see the same motion
   *  (offline: the event loops straight back into the local host). */
  startCollapse(b: Beam, now: number): void {
    if (b.collapseUntil > 0 || b.exploding || b.vanished) {
      return;
    }
    // GRAVITON WELL herds far longer than SINGULARITY; the pull duration rides
    // the shared `until` so guests/host agree without a wire shape change.
    const pullMs = b.weapon.name === "GRAVITON WELL" ? GRAVITON_PULL_MS : SINGULARITY_PULL_MS;
    b.collapseUntil = now + pullMs;
    b.diesAt = 0;
    b.tail = { ...b.head };
    this.scene.netSendEvent("singularity", { until: b.collapseUntil, x: b.head.x, y: b.head.y });
    if (this.scene.view.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_laser", { gain: 0.6, rate: 0.5 });
    }
  }

  /** SINGULARITY pop: the standard exploding-beam path. hitIds is cleared so
   *  a flight-contact target isn't deduped out of its own pop. */
  private popSingularity(b: Beam): void {
    b.collapseUntil = 0;
    b.exploding = true;
    b.explosionRadius = 0;
    b.hitIds.clear();
    this.scene.fx.battle.burst(b.head.x, b.head.y, 125, b.weapon.tint, "detonation");
    this.scene.fx.ring(b.head.x, b.head.y, 6, 90, 250, b.weapon.tint, 0.8);
    if (this.scene.view.onScreen(b.head.x, b.head.y)) {
      // The boom, dropped well below the EXPLOSION family's pitch.
      sfx.play("fire_heavy", { gain: 1.2, rate: 0.55 });
      this.scene.trauma.add(0.12);
    }
  }

  /** RICOCHET world-edge bounce: clamp inside, reflect off the edge normal. */
  private ricochetEdgeBounce(b: Beam): void {
    let nx = 0;
    let ny = 0;
    if (b.head.x < 0) {
      nx = 1;
    } else if (b.head.x > this.scene.world.playW) {
      nx = -1;
    }
    if (b.head.y < 0) {
      ny = 1;
    } else if (b.head.y > this.scene.world.playH) {
      ny = -1;
    }
    b.head.x = PhaserMath.Clamp(b.head.x, 0, this.scene.world.playW);
    b.head.y = PhaserMath.Clamp(b.head.y, 0, this.scene.world.playH);
    const len = Math.hypot(nx, ny) || 1;
    this.ricochetBounce(b, nx / len, ny / len);
  }

  /** RICOCHET bounce: reflect off the surface normal, then re-aim at the
   *  nearest un-hit enemy/asteroid in range (the re-aim IS the weapon; the
   *  reflection is the fallback). The tail re-grows from the kink so the
   *  segment visibly bends; remotes see it via per-snapshot beams. */
  ricochetBounce(b: Beam, nx: number, ny: number): void {
    b.bouncesLeft -= 1;
    const dx = Math.cos(b.angle);
    const dy = Math.sin(b.angle);
    const dot = dx * nx + dy * ny;
    b.angle = Math.atan2(dy - 2 * dot * ny, dx - 2 * dot * nx);
    this.retargetRicochet(b);
    b.tail = { ...b.head };
    b.released = false;
    this.scene.fx.battle.burst(b.head.x, b.head.y, 20, b.weapon.tint, "impact", b.angle);
    this.scene.fx.sparks(b.head.x, b.head.y, 3, b.weapon.tint, {
      lifeMax: 180,
      lifeMin: 100,
      scale: 0.4,
    });
  }

  /** Aim at the nearest enemy (preferred) or asteroid within retargetRange
   *  that this beam hasn't already damaged. */
  private retargetRicochet(b: Beam): void {
    const range = b.weapon.ricochet?.retargetRange ?? 0;
    if (range <= 0) {
      return;
    }
    const r2 = range * range;
    let best: Vec | null = null;
    let bestD = Infinity;
    for (const e of this.scene.world.enemies) {
      if (b.hitIds.has(e.id)) {
        continue;
      }
      const d = dist2(e.x, e.y, b.head.x, b.head.y);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
    if (!best) {
      for (const a of this.scene.world.asteroids) {
        if (b.hitIds.has(a.id)) {
          continue;
        }
        const d = dist2(a.x, a.y, b.head.x, b.head.y);
        if (d <= r2 && d < bestD) {
          bestD = d;
          best = { x: a.x, y: a.y };
        }
      }
    }
    if (best) {
      b.angle = Math.atan2(best.y - b.head.y, best.x - b.head.x);
    }
  }
}
