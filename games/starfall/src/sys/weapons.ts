import type Phaser from "phaser";
import { sfx } from "../audio/sfx";
import type { PlayOpts } from "../audio/sfx";
import { weaponSound } from "../audio/weapon-sound";
import { FIRE_BASE, FIRE_REFLECT, FIRE_TURRET, encodeFire } from "../net/fire-wire";
import type { HostCombat } from "../net/host-combat";
import type { HostIntents } from "../net/intents";
import { weaponLook } from "../render/combat-visuals";
import type { WeaponLook } from "../render/combat-visuals";
import type { FxPool } from "../render/fx-pool";
import type { TraumaCamera } from "../render/trauma-camera";
import type { WorldView } from "../render/world-view";
import { now as simNow } from "../shared/clock";
import {
  ARC_CAST_CONE_DEG,
  ARC_FIZZLE_LEN,
  ARC_RENDER_MS,
  HOMING_LOCK_CONE_DEG,
  OVERDRIVE_RATE_MULT,
  SENTRY_FIRE_MS,
  SENTRY_LIFETIME_MS,
  SENTRY_RANGE,
  SHIP_RADIUS,
  TWIN_ORBIT_DEG_PER_S,
  WEAPONS_SPECIAL,
  XP,
  asteroidDestroyedBy,
} from "../shared/constants";
import type { SharedState, Vec, Weapon } from "../shared/constants";
import { rand } from "../shared/rng";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import { newBeam, targetKey } from "./beam";
import type { Beam, TargetRef } from "./beam";
import type { BeamOwner, BeamSim } from "./beam-sim";
import { DEG, dist2, wrapAngle } from "./geometry";
import type { Progression } from "./progression";
import type { Shield } from "./shield";
import type { ShooterHits } from "./shooter-hits";
import { REFLECT_WEAPON, SENTRY_WEAPON, buildVolley, isNova, twinOrigin } from "./volley";
import type { FireKind, FireSpec } from "./volley";

/** Scene input + late-built collaborators weapons reports into. */
export interface WeaponsHooks {
  /** Scene input: is the trigger held this frame. */
  isFiring: () => boolean;
  /** Built after weapons; resolved at call time. */
  hits: () => ShooterHits;
  /** Built after weapons; resolved at call time. */
  shield: () => Shield;
}

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

export const SINGULARITY_TINT = WEAPONS_SPECIAL.find((w) => w.singularity)?.tint ?? 0x7c_3a_ed;

/** TWIN orbit phase — derived from the wall clock with the exact formula
 *  remotes use, so the owner's drone and every remote render agree. */
export const twinAngle = (): number => (simNow() / 1000) * TWIN_ORBIT_DEG_PER_S * DEG;

/** The `w` code remotes rebuild a weapon from: a special's WEAPONS_SPECIAL
 *  index, else the base weapon (which remotes scale to the shooter's level). */
const weaponCode = (w: Weapon): number => {
  const idx = WEAPONS_SPECIAL.findIndex((special) => special.name === w.name);
  return idx === -1 ? FIRE_BASE : idx;
};

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

export interface WeaponsDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  fx: FxPool;
  trauma: TraumaCamera;
  clock: Phaser.Time.Clock;
  view: WorldView;
  progress: Progression;
  hostCombat: HostCombat;
  sim: BeamSim;
  intents: HostIntents;
  hooks: WeaponsHooks;
}

/** My arsenal: trigger cadence and windup, every fire mode (pellets, arc, tesla aura, mines, cluster, nova, sentry), and the muzzle feedback. Each trigger pull becomes a FireSpec that builds my beams here and goes out as a `fire` event; flight is the shared BeamSim's. */
export class Weapons {
  shootCooldown = 0;

  beams: Beam[] = [];

  /** RAILGUN charge accumulator, ms (resets on release). */
  windupAcc = 0;

  /** SENTRY turret (owner-simulated; remotes place theirs from my SENTRY volleys). */
  sentry: { x: number; y: number; until: number; nextFireAt: number } | null = null;

  muzzleFlashes: MuzzleFlash[] = [];

  /** My beams' owner record for the shared beam simulation. */
  readonly owner: BeamOwner;

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly fx: FxPool;

  private readonly trauma: TraumaCamera;

  private readonly clock: Phaser.Time.Clock;

  private readonly view: WorldView;

  private readonly progress: Progression;

  private readonly hostCombat: HostCombat;

  private readonly sim: BeamSim;

  private readonly intents: HostIntents;

  private readonly hooks: WeaponsHooks;

  constructor(deps: WeaponsDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.fx = deps.fx;
    this.trauma = deps.trauma;
    this.clock = deps.clock;
    this.view = deps.view;
    this.progress = deps.progress;
    this.hostCombat = deps.hostCombat;
    this.sim = deps.sim;
    this.intents = deps.intents;
    this.hooks = deps.hooks;
    const { link, pilot } = deps;
    this.owner = {
      hull: () => (pilot.alive ? { x: pilot.shipX, y: pilot.shipY } : null),
      get id() {
        return link.myId;
      },
      local: true,
    };
  }

  handleShooting(delta: number, now: number): void {
    if (!this.pilot.alive || !this.pilot.spawned) {
      return;
    }
    // The cooldown runs into (bounded) deficit and each shot pays intervalMs
    // back, so the leftover carries between shots — true average cadence on
    // any refresh rate instead of rounding up to whole frames. OVERDRIVE
    // multiplies intervalMs and windupMs at fire time (+50% rate).
    const rateMult = this.pilot.boosts.has("overdrive") ? OVERDRIVE_RATE_MULT : 1;
    const interval = this.pilot.weapon.intervalMs * rateMult;
    this.shootCooldown = Math.max(-interval, this.shootCooldown - delta);
    if (!this.pilot.alive || !this.pilot.spawned || now < this.hooks.shield().phasedUntil) {
      this.windupAcc = 0;
      return;
    }
    if (!this.hooks.isFiring()) {
      // releasing mid-windup cancels
      this.windupAcc = 0;
      return;
    }
    const windupMs = this.pilot.weapon.windupMs * rateMult;
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
    const rateMult = this.pilot.boosts.has("overdrive") ? OVERDRIVE_RATE_MULT : 1;
    const windupMs = this.pilot.weapon.windupMs * rateMult;
    return windupMs > 0 ? Math.min(1, this.windupAcc / windupMs) : 0;
  }

  /** One volley of the current weapon (pellets / arc cast / mine / nova). */
  fireWeapon(now: number): void {
    const nose = {
      x: this.pilot.shipX + Math.cos(this.pilot.shipAngle) * SHIP_RADIUS,
      y: this.pilot.shipY + Math.sin(this.pilot.shipAngle) * SHIP_RADIUS,
    };
    const w = this.pilot.weapon;
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
    } else {
      // SENTRY: the trigger also places/moves the turret (sound gated there).
      if (w.sentry) {
        this.placeSentry(now);
      }
      if (w.mine) {
        this.sim.capMines(this.beams);
      }
      this.fire(this.volleySpec(now, w));
      if (isNova(w)) {
        this.fx.battle.burst(
          this.pilot.shipX,
          this.pilot.shipY,
          Math.min(260, (w.explosion?.range ?? 0) * 0.85),
          w.tint,
          "detonation",
          0,
          "important",
        );
      }
      // CLUSTER: the other missiles launch staggered, each re-running the
      // nose position + HOMING lock at its own instant so the locks fan
      // across a crowd. Each launch is its own fire event.
      const { cluster } = w;
      if (cluster) {
        for (let i = 1; i < cluster.missiles; i += 1) {
          this.clock.delayedCall(cluster.staggerMs * i, () => {
            if (this.pilot.alive && this.pilot.spawned) {
              this.fire(this.volleySpec(simNow(), w));
            }
          });
        }
      }
    }
    this.muzzleFx(nose, now, gainScale);
  }

  /** Put a trigger pull's beams in the air here, and send the same spec to
   *  everyone else (stamped on the clock remotes draw my ship against). */
  private fire(spec: FireSpec): void {
    for (const b of buildVolley(spec)) {
      b.mastery = this.link.trailer ? null : this.pilot.mastery.shot(b.weapon.name, spec.t);
      this.beams.push(b);
    }
    this.link.broadcast("fire", encodeFire({ ...spec, t: performance.now() }));
  }

  /** A volley of `w` from the ship as it stands. */
  private volleySpec(now: number, w: Weapon): FireSpec {
    const { shipX: x, shipY: y, shipAngle: angle } = this.pilot;
    const nose = { x: x + Math.cos(angle) * SHIP_RADIUS, y: y + Math.sin(angle) * SHIP_RADIUS };
    const twin = this.pilot.boosts.has("twin") ? twinAngle() : null;
    const { homing } = w;
    return {
      angle,
      chain: null,
      code: weaponCode(w),
      kind: "volley",
      level: this.progress.level,
      lock: homing ? this.acquireHomingTarget(nose, homing.acquireRange) : null,
      seed: Math.floor(rand() * 0x1_00_00),
      t: now,
      twin,
      twinLock:
        homing && twin !== null
          ? this.acquireHomingTarget(twinOrigin(x, y, twin), homing.acquireRange)
          : null,
      weapon: w,
      x,
      y,
    };
  }

  /** A single bolt that isn't my weapon's volley: a SENTRY turret shot or a
   *  REFLECT return. */
  fireBolt(
    kind: Extract<FireKind, "turret" | "reflect">,
    origin: Vec,
    angle: number,
    now: number,
  ): void {
    const turret = kind === "turret";
    this.fire({
      angle,
      chain: null,
      code: turret ? FIRE_TURRET : FIRE_REFLECT,
      kind,
      level: 1,
      lock: null,
      seed: 0,
      t: now,
      twin: null,
      twinLock: null,
      weapon: turret ? SENTRY_WEAPON : REFLECT_WEAPON,
      x: origin.x,
      y: origin.y,
    });
  }

  /** An ARC / TESLA bolt: hops already resolved (and damage applied) here. */
  private fireChain(chain: Vec[], now: number): void {
    this.fire({
      angle: this.pilot.shipAngle,
      chain,
      code: weaponCode(this.pilot.weapon),
      kind: "chain",
      level: this.progress.level,
      lock: null,
      seed: 0,
      t: now,
      twin: null,
      twinLock: null,
      weapon: this.pilot.weapon,
      x: this.pilot.shipX,
      y: this.pilot.shipY,
    });
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
    for (const e of this.world.enemies) {
      const d = dist2(e.x, e.y, this.pilot.shipX, this.pilot.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { id: e.id, kind: "enemy" }, x: e.x, y: e.y };
      }
    }
    const u = this.world.ufo;
    if (u) {
      const d = dist2(u.x, u.y, this.pilot.shipX, this.pilot.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { kind: "ufo" }, x: u.x, y: u.y };
      }
    }
    for (const a of this.world.asteroids) {
      const d = dist2(a.x, a.y, this.pilot.shipX, this.pilot.shipY);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { ref: { id: a.id, kind: "asteroid" }, x: a.x, y: a.y };
      }
    }
    if (!best) {
      return false;
    }
    this.applyArcDamage(best.ref, best.x, best.y, this.pilot.weapon.power * 100, now);
    this.fireChain(
      [
        { x: this.pilot.shipX, y: this.pilot.shipY },
        { x: best.x, y: best.y },
      ],
      now,
    );
    return true;
  }

  /** SENTRY: place (or move) the one turret at the ship; re-placing
   *  refreshes its 12s life. The clack only plays on a real move so
   *  drag-firing doesn't machine-gun the sound. */
  private placeSentry(now: number): void {
    const prev = this.sentry;
    const moved = !prev || dist2(prev.x, prev.y, this.pilot.shipX, this.pilot.shipY) > 100 * 100;
    this.sentry = {
      nextFireAt: prev?.nextFireAt ?? 0,
      until: now + SENTRY_LIFETIME_MS,
      x: this.pilot.shipX,
      y: this.pilot.shipY,
    };
    if (moved) {
      sfx.play("sentry_place", { priority: "local" });
      this.fx.ring(this.pilot.shipX, this.pilot.shipY, 4, 18, 200, SENTRY_WEAPON.tint, 0.6);
    }
  }

  /** SENTRY turret sim: every SENTRY_FIRE_MS fire a bolt (ordinary owner
   *  beam — hits, score and the fire event all ride the normal pipelines)
   *  at the nearest enemy, else the nearest asteroid, within range. */
  tickSentry(now: number): void {
    const s = this.sentry;
    if (!s) {
      return;
    }
    if (!this.pilot.alive || now >= s.until) {
      this.sentry = null;
      return;
    }
    if (now < s.nextFireAt) {
      return;
    }
    const r2 = SENTRY_RANGE * SENTRY_RANGE;
    let best: Vec | null = null;
    let bestD = Infinity;
    for (const e of this.world.enemies) {
      const d = dist2(e.x, e.y, s.x, s.y);
      if (d <= r2 && d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
    if (!best) {
      for (const a of this.world.asteroids) {
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
    this.fireBolt("turret", s, ang, now);
    s.nextFireAt = now + SENTRY_FIRE_MS;
    this.fx.battle.burst(s.x, s.y, 18, SENTRY_WEAPON.tint, "muzzle", ang);
    this.fx.sparks(s.x, s.y, 2, SENTRY_WEAPON.tint, {
      lifeMax: 140,
      lifeMin: 80,
      scale: 0.4,
    });
    if (this.view.onScreen(s.x, s.y)) {
      sfx.play("fire_pulse", { gain: 0.35, rate: 1.15 });
    }
  }

  /** TESLA AURA live = weapon held and able to fire (mirrored to the wire). */
  teslaActive(now: number): boolean {
    return (
      this.pilot.weapon.aura &&
      this.pilot.alive &&
      this.pilot.spawned &&
      this.hooks.isFiring() &&
      now >= this.hooks.shield().phasedUntil
    );
  }

  /** Fly my beams one frame. */
  updateBeams(dt: number, now: number): void {
    this.beams = this.sim.step(this.beams, this.owner, dt, now);
  }

  /** Detonate my armed mines that something hostile wandered into. */
  tickMines(now: number): void {
    this.sim.tickMines(this.beams, this.owner, now);
  }

  /** Muzzle flash + camera kick + fire sfx, per weapon family (§9). */
  private muzzleFx(nose: Vec, now: number, gainScale = 1): void {
    const w = this.pilot.weapon;
    const sound = weaponSound(w.sfx);
    const playOpts: PlayOpts = { gain: sound.gain * gainScale, priority: "local" };
    if (sound.rate !== undefined) {
      playOpts.rate = sound.rate;
    }
    sfx.play(sound.name, playOpts);
    // Every burst below sits ON the pilot's nose, so all of it damps together
    // in trailer mode (1 everywhere else — see hullGlow).
    const glow = this.view.hullGlow();
    const look = weaponLook(w);
    if (look !== "nova") {
      const size = muzzleBurstSize(look);
      this.fx.battle.burst(
        nose.x,
        nose.y,
        size * glow,
        w.tint,
        "muzzle",
        this.pilot.shipAngle,
        "important",
      );
    }
    // OVERDRIVE: muzzle flashes gain a gold outer spark.
    if (this.pilot.boosts.has("overdrive")) {
      this.fx.sparks(nose.x, nose.y, 2, 0xfa_cc_15, {
        lifeMax: 180,
        lifeMin: 100,
        scale: 0.5 * glow,
        speedMax: 320,
        speedMin: 150,
      });
    }
    const aimDeg = this.pilot.shipAngle / DEG;
    switch (w.sfx) {
      case "mine": {
        // Drop, not a shot: tiny puff, no kick.
        this.fx.sparks(nose.x, nose.y, 2, w.tint, {
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
        this.fx.sparks(nose.x, nose.y, 5, w.tint, {
          angleMax: aimDeg + 12,
          angleMin: aimDeg - 12,
          lifeMax: 200,
          lifeMin: 120,
          scale: 0.5 * glow,
          speedMax: 450,
          speedMin: 250,
        });
        this.muzzleFlashes.push({
          angle: this.pilot.shipAngle,
          diesAt: now + 50,
          kind: "cross",
          size: 12,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.trauma.add(0.08);
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
        this.fx.sparks(nose.x, nose.y, 5, w.tint, {
          angleMax: aimDeg + 15,
          angleMin: aimDeg - 15,
          lifeMax: 200,
          lifeMin: 120,
          scale: 0.5 * glow,
          speedMax: 400,
          speedMin: 200,
        });
        this.muzzleFlashes.push({
          angle: this.pilot.shipAngle,
          diesAt: now + 50,
          kind: "cross",
          size: 10,
          tint: w.tint,
          x: nose.x,
          y: nose.y,
        });
        this.trauma.add(0.06);
        this.kick(4);
        break;
      }
      case "zap": {
        this.muzzleFlashes.push({
          angle: this.pilot.shipAngle,
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
        this.fx.sparks(nose.x, nose.y, 4, w.tint, {
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
        this.fx.sparks(nose.x, nose.y, 3, w.tint, {
          angleMax: aimDeg + 15,
          angleMin: aimDeg - 15,
          lifeMax: 180,
          lifeMin: 100,
          scale: 0.5 * glow,
          speedMax: 400,
          speedMin: 200,
        });
        this.muzzleFlashes.push({
          angle: this.pilot.shipAngle,
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
    this.pilot.kickX -= Math.cos(this.pilot.shipAngle) * px;
    this.pilot.kickY -= Math.sin(this.pilot.shipAngle) * px;
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
      return Math.abs(wrapAngle(ang - this.pilot.shipAngle)) <= half ? d : null;
    };
    let bestD = Infinity;
    let best: TargetRef | null = null;
    for (const e of this.world.enemies) {
      const d = inCone(e.x, e.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { id: e.id, kind: "enemy" };
      }
    }
    if (best) {
      return best;
    }
    const { myId } = this.link;
    for (const [id, st] of this.link.peerStates) {
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
    const u = this.world.ufo;
    if (u && inCone(u.x, u.y) !== null) {
      return { kind: "ufo" };
    }
    for (const a of this.world.asteroids) {
      const d = inCone(a.x, a.y);
      if (d !== null && d < bestD) {
        bestD = d;
        best = { id: a.id, kind: "asteroid" };
      }
    }
    return best;
  }

  /**
   * ARC: hitscan chain lightning. Damage applies at cast; the bolt then lives
   * ARC_RENDER_MS as a re-jittered polyline. The hops ride the fire event so
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
      if (Math.abs(wrapAngle(ang - this.pilot.shipAngle)) > half) {
        continue;
      }
      bestD = d;
      first = c;
    }
    if (!first) {
      // Fizzle: 80px jittered bolt, no damage, never sent (a fizzle must not
      // hit-test against PvP victims); fireWeapon quiets the zap.
      const jang = this.pilot.shipAngle + (Math.random() * 2 - 1) * 10 * DEG;
      const fizzle = newBeam(nose, this.pilot.shipAngle, this.pilot.weapon, now);
      fizzle.chain = [
        { ...nose },
        {
          x: nose.x + Math.cos(jang) * ARC_FIZZLE_LEN,
          y: nose.y + Math.sin(jang) * ARC_FIZZLE_LEN,
        },
      ];
      fizzle.diesAt = now + ARC_RENDER_MS;
      fizzle.fizzle = true;
      this.beams.push(fizzle);
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
    let dmg = this.pilot.weapon.power * 100;
    for (const t of hitRefs) {
      chain.push({ x: t.x, y: t.y });
      this.applyArcDamage(t.ref, t.x, t.y, dmg, now);
      dmg *= spec.falloff;
    }
    this.fireChain(chain, now);
    return false;
  }

  private arcCandidates(): { ref: TargetRef; x: number; y: number }[] {
    const out: { ref: TargetRef; x: number; y: number }[] = [];
    for (const e of this.world.enemies) {
      out.push({ ref: { id: e.id, kind: "enemy" }, x: e.x, y: e.y });
    }
    const { myId } = this.link;
    for (const [id, st] of this.link.peerStates) {
      if (id === myId) {
        continue;
      }
      if (st && st.alive && !st.invuln && !st.shieldMod?.phased) {
        out.push({ ref: { id, kind: "player" }, x: st.x, y: st.y });
      }
    }
    const u = this.world.ufo;
    if (u) {
      out.push({ ref: { kind: "ufo" }, x: u.x, y: u.y });
    }
    for (const a of this.world.asteroids) {
      out.push({ ref: { id: a.id, kind: "asteroid" }, x: a.x, y: a.y });
    }
    return out;
  }

  private applyArcDamage(ref: TargetRef, x: number, y: number, dmgHp: number, now: number): void {
    this.fx.battle.burst(
      x,
      y,
      22,
      this.pilot.weapon.tint,
      "impact",
      Math.atan2(y - this.pilot.shipY, x - this.pilot.shipX),
    );
    this.fx.sparks(x, y, 9, this.pilot.weapon.tint, { lifeMax: 300, lifeMin: 150 });
    sfx.play("hit_spark", { gain: 0.4 });
    switch (ref.kind) {
      case "enemy": {
        const e = this.world.enemies.find((en) => en.id === ref.id);
        if (!e) {
          return;
        }
        e.blinkUntil = now + 150;
        if (e.hp - dmgHp <= 0) {
          this.hooks
            .hits()
            .predictKill(e.id, this.hostCombat.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
        }
        this.intents.enemyHit(e.id, dmgHp);
        return;
      }
      case "asteroid": {
        const a = this.world.asteroids.find((as) => as.id === ref.id);
        if (!a) {
          return;
        }
        const power = dmgHp / 100;
        const predicted =
          asteroidDestroyedBy(a.radius, power) &&
          this.hooks.hits().predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
        if (!predicted) {
          this.progress.gainXp(XP.ASTEROID_CHIP, now);
        }
        this.intents.asteroidHit(a.id, power);
        return;
      }
      case "ufo": {
        const u = this.world.ufo;
        if (!u) {
          return;
        }
        if (u.hp - dmgHp <= 0) {
          this.hooks.hits().predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
        }
        this.intents.ufoHit(dmgHp / 100);
        break;
      }
      case "player": {
        // The victim hit-tests the chain from my fire event and adjudicates
        // its own shield — nothing to send from the shooter side.
        break;
      }
      default: {
        ref satisfies never;
      }
    }
  }
}
