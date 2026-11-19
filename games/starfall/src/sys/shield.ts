import type Phaser from "phaser";
import { sfx } from "../audio/sfx";
import type { HostIntents } from "../net/intents";
import { REDUCED_MOTION } from "../render/battle-fx";
import type { FxPool } from "../render/fx-pool";
import { DEATH_HINTS } from "../render/hud-dom";
import type { Layers } from "../render/layers";
import type { TraumaCamera } from "../render/trauma-camera";
import { shipHullPoints } from "../render/vector-shapes";
import type { WorldView } from "../render/world-view";
import { now as simNow } from "../shared/clock";
import {
  AEGIS_REGEN_DELAY_MS,
  AEGIS_REGEN_MULT,
  BOSS_CONTACT_DMG,
  BULWARK_CONE_DEG,
  BULWARK_FRONT_MULT,
  CONTACT_IFRAME_MS,
  DMG,
  ENEMY_SPECS,
  LANCER_CHARGE_HIT_RADIUS,
  PHASE_COOLDOWN_MS,
  PHASE_COST,
  PHASE_DURATION_MS,
  PHASE_TRIGGER_HIT,
  PVP_DAMAGE_MULT,
  PVP_EXPLOSION_IFRAME_MS,
  PVP_HIT_IFRAME_MS,
  PVP_MAX_SINGLE_HIT,
  RAM_ARM_SPEED,
  RAM_ASTEROID_CHIP,
  RAM_ASTEROID_DESTROY_R,
  RAM_DAMAGE,
  RAM_IMMUNITY_MS,
  RAM_KNOCKBACK,
  RAM_LANCER_DRAIN,
  RAM_PVP_DRAIN,
  RAM_SELF_DRAIN,
  REFLECT_BOUNCE_COST,
  REFLECT_MIN_SHIELD,
  RESPAWN_DELAY_MS,
  SHIELD_LOW_FRACTION,
  SHIELD_MAX,
  SHIELD_MOD_SPECS,
  SHIELD_REGEN_DELAY_MS,
  SHIELD_REGEN_FULL_MS,
  SHIELD_RING_RADIUS,
  SHIELD_RING_TINT,
  SHIP_RADIUS,
  SIPHON_OVERHEAL_DECAY_PER_S,
  UFO_RADIUS,
  WEAPONS_SPECIAL,
  XP,
  asteroidContactDamage,
  baseRegenMult,
  baseWeaponForLevel,
  enemyKillXp,
  enemyShotHit,
} from "../shared/constants";
import type {
  EnemyKind,
  EnemyShotState,
  PlayerNetState,
  ShieldModKind,
  SharedState,
  Vec,
} from "../shared/constants";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import { beamHitSeg } from "./beam";
import type { Beam } from "./beam";
import { DEG, dist2, segHitsCircle } from "./geometry";
import type { Progression } from "./progression";
import type { RemoteFire } from "./remote-fire";
import type { ShooterHits } from "./shooter-hits";
import type { Weapons } from "./weapons";

/** Scene lookups + the late-built net push the shield needs. */
export interface ShieldHooks {
  myTint: () => number;
  /** Immediate net push on death (PlayerNet is built after the shield). */
  pushMyState: (now: number) => void;
}

/** TESLA AURA spec for victim-side adjudication (the RAM pattern: power and
 *  range come from the shared table, not the wire). */
export const TESLA_SPEC = WEAPONS_SPECIAL.find((w) => w.aura);

export const TESLA_POWER = TESLA_SPEC?.power ?? 0.27;

export const TESLA_RANGE = TESLA_SPEC?.arc?.castRange ?? 120;

export const TESLA_TINT = TESLA_SPEC?.tint ?? 0x00_aa_ff;

/** One shooter's same-frame PvP drains against me, summed before the clamp. */
export interface Volley {
  beamDrain: number;
  aoeDrain: number;
  anyExploding: boolean;
  anyGlaive: boolean;
  maxPower: number;
  impact: Vec | null;
  reflectAngle: number;
}

/** Hull-contact damage by enemy kind (a charging LANCER is handled by the caller). */
export const hullContactDamage = (kind: EnemyKind) => {
  if (kind === "lancer") {
    return DMG.LANCER_HULL;
  }

  if (kind === "dreadnought") {
    return BOSS_CONTACT_DMG;
  }

  return DMG.ENEMY_HULL;
};

export interface ShieldDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  fx: FxPool;
  layers: Layers;
  trauma: TraumaCamera;
  tweens: Phaser.Tweens.TweenManager;
  scale: Phaser.Scale.ScaleManager;
  hits: ShooterHits;
  weapons: Weapons;
  progress: Progression;
  view: WorldView;
  remoteFire: RemoteFire;
  intents: HostIntents;
  hooks: ShieldHooks;
}

/** Victim-side adjudication: every incoming damage source (rocks, hulls, enemy shots, UFO, PvP beams and rams) drains my shield here, with regen, mods (overshield/phase/reflect/bulwark/aegis…) and death. */
export class Shield {
  /** Enemy shots we consumed locally (shield/death), awaiting host removal
   *  (id → time) — stops stale snapshots resurrecting them into the shield. */
  recentConsumedShots = new Map<string, number>();

  shieldHp = SHIELD_MAX;

  overHp = 0;

  lastDamageAt = 0;

  regenActive = false;

  private lastShieldLowAt = 0;

  shieldMod: ShieldModKind | null = null;

  shieldModUntil = 0;

  phasedUntil = 0;

  phaseReadyAt = 0;

  /** Post-contact-drain immunity vs ALL contact sources (rock = one hit). */
  contactIframeUntil = 0;

  /** A shooter's beam can overlap my hull for several frames: brief
   *  per-SHOOTER i-frames after each volley drain (§A.2). */
  pvpIframeUntil = new Map<string, number>();

  /** RAM: per-target contact immunity after a hit (id → until). */
  ramImmunity = new Map<string, number>();

  haloFlashUntil = 0;

  siphonPulseUntil = 0;

  /** REPAIR pickup: brief regen-sweep visual on the ring. */
  repairSweepUntil = 0;

  /** 60° white impact arcs at the incoming-damage angle (150ms each). */
  impactArcs: { angle: number; diesAt: number }[] = [];

  deathCause = "";

  deathHint = "";

  private deathCounts = new Map<string, number>();

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly fx: FxPool;

  private readonly layers: Layers;

  private readonly trauma: TraumaCamera;

  private readonly tweens: Phaser.Tweens.TweenManager;

  private readonly scale: Phaser.Scale.ScaleManager;

  private readonly hits: ShooterHits;

  private readonly weapons: Weapons;

  private readonly progress: Progression;

  private readonly view: WorldView;

  private readonly remoteFire: RemoteFire;

  private readonly intents: HostIntents;

  private readonly hooks: ShieldHooks;

  constructor(deps: ShieldDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.fx = deps.fx;
    this.layers = deps.layers;
    this.trauma = deps.trauma;
    this.tweens = deps.tweens;
    this.scale = deps.scale;
    this.hits = deps.hits;
    this.weapons = deps.weapons;
    this.progress = deps.progress;
    this.view = deps.view;
    this.remoteFire = deps.remoteFire;
    this.intents = deps.intents;
    this.hooks = deps.hooks;
  }

  private ramArmed() {
    return (
      this.shieldMod === "ram" && Math.hypot(this.pilot.shipVX, this.pilot.shipVY) > RAM_ARM_SPEED
    );
  }

  private reflectArmed() {
    return this.shieldMod === "reflect" && this.shieldHp > REFLECT_MIN_SHIELD;
  }

  private bounceOff(cx: number, cy: number, scale: number) {
    let nx = this.pilot.shipX - cx;
    let ny = this.pilot.shipY - cy;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const dot = this.pilot.shipVX * nx + this.pilot.shipVY * ny;

    if (dot < 0) {
      this.pilot.shipVX = (this.pilot.shipVX - 2 * dot * nx) * scale;
      this.pilot.shipVY = (this.pilot.shipVY - 2 * dot * ny) * scale;
    } else {
      this.pilot.shipVX *= scale;
      this.pilot.shipVY *= scale;
    }

    this.pilot.shipX += nx * 2;
    this.pilot.shipY += ny * 2;
  }

  private shieldHitFx(now: number, impactX: number, impactY: number, amount: number) {
    this.haloFlashUntil = now + 80;
    const ang = Math.atan2(impactY - this.pilot.shipY, impactX - this.pilot.shipX);
    this.impactArcs.push({ angle: ang, diesAt: now + 150 });
    this.fx.battle.burst(
      this.pilot.shipX + Math.cos(ang) * SHIELD_RING_RADIUS,
      this.pilot.shipY + Math.sin(ang) * SHIELD_RING_RADIUS,
      27,
      SHIELD_RING_TINT,
      "impact",
      ang,
      "important",
    );
    this.fx.sparks(impactX, impactY, 8, SHIELD_RING_TINT, {
      angleMax: ang / DEG + 22.5,
      angleMin: ang / DEG - 22.5,
      importance: "important",
      lifeMax: 250,
      lifeMin: 150,
      scale: 0.6 * this.view.hullGlow(),
    });
    const fraction = Math.max(0, Math.min(1, this.shieldHp / SHIELD_MAX));
    sfx.play("shield_hit", { rate: 0.85 + 0.3 * fraction });
    this.trauma.add(amount >= 40 ? 0.25 : 0.12);
  }

  private shieldBreakFx(now: number) {
    this.haloFlashUntil = now + 80;
    this.fx.ring(
      this.pilot.shipX,
      this.pilot.shipY,
      SHIELD_RING_RADIUS,
      40,
      300,
      SHIELD_RING_TINT,
      0.7,
      "important",
    );
    this.trauma.add(0.3);
  }

  /**
   * The one drain pipeline (§A): every damage source lands here. Runs the
   * PHASE auto-blink, drains the OVERSHIELD bonus first, stamps the regen
   * clock, drives ring FX + low-shield trauma, and dies at ≤0 — the killing
   * blow's cause is what the overlay names.
   */
  applyDamage(
    amount: number,
    fromX: number,
    fromY: number,
    cause: string,
    killerId: string | null,
    now: number,
  ) {
    if (!this.pilot.alive) {
      return "dead";
    }

    if (
      this.shieldMod === "phase" &&
      now >= this.phaseReadyAt &&
      (amount >= PHASE_TRIGGER_HIT || amount >= this.shieldHp + this.overHp)
    ) {
      this.phasedUntil = now + PHASE_DURATION_MS;
      this.phaseReadyAt = now + PHASE_COOLDOWN_MS;
      this.shieldHp -= Math.min(PHASE_COST, Math.max(0, this.shieldHp - 1));
      this.lastDamageAt = now;
      this.regenActive = false;
      this.shieldBreakFx(now);
      sfx.play("shield_break", { gain: 0.6, rate: 1.25 });

      return "phased";
    }

    let mitigated = amount;

    if (this.shieldMod === "bulwark" && now < this.shieldModUntil) {
      let rel =
        Math.atan2(fromY - this.pilot.shipY, fromX - this.pilot.shipX) - this.pilot.shipAngle;

      rel = Math.atan2(Math.sin(rel), Math.cos(rel));

      if (Math.abs(rel) <= ((BULWARK_CONE_DEG / 2) * Math.PI) / 180) {
        mitigated *= BULWARK_FRONT_MULT;
      }
    }

    const wasLow = this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION;
    let rest = mitigated;

    if (this.overHp > 0) {
      const fromOver = Math.min(this.overHp, rest);
      this.overHp -= fromOver;
      rest -= fromOver;
    }

    this.shieldHp -= rest;
    this.lastDamageAt = now;
    this.regenActive = false;

    if (this.shieldHp <= 0 && this.link.trailer?.deathless === true) {
      this.shieldHp = 1;
    }

    if (this.shieldHp <= 0) {
      this.die(now, killerId, cause);

      return "dead";
    }

    this.shieldHitFx(now, fromX, fromY, amount);

    if (!wasLow && this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION) {
      this.trauma.add(0.15);
    }

    return "drained";
  }

  /** Base regen (Halo grammar) + overheal decay + mod/booster expiry. */
  tickShield(now: number, dt: number) {
    if (this.shieldMod && now >= this.shieldModUntil) {
      this.shieldMod = null;
      this.overHp = 0;
    }

    for (const [kind, until] of this.pilot.boosts) {
      if (now >= until) {
        this.pilot.boosts.delete(kind);
      }
    }

    if (!this.pilot.alive) {
      return;
    }

    if (this.shieldHp > SHIELD_MAX) {
      this.shieldHp = Math.max(SHIELD_MAX, this.shieldHp - SIPHON_OVERHEAL_DECAY_PER_S * dt);
    }

    const delay = this.shieldMod === "aegis" ? AEGIS_REGEN_DELAY_MS : SHIELD_REGEN_DELAY_MS;

    if (this.shieldHp < SHIELD_MAX && now - this.lastDamageAt >= delay) {
      if (!this.regenActive) {
        this.regenActive = true;
        sfx.play("shield_regen");
      }

      const rate =
        (SHIELD_MAX / (SHIELD_REGEN_FULL_MS / 1000)) *
        this.pilot.regenMult *
        (this.shieldMod === "aegis" ? AEGIS_REGEN_MULT : 1);

      this.shieldHp = Math.min(SHIELD_MAX, this.shieldHp + rate * dt);

      if (this.shieldHp >= SHIELD_MAX) {
        this.regenActive = false;
      }
    } else if (this.shieldHp >= SHIELD_MAX) {
      this.regenActive = false;
    }

    if (
      this.shieldHp > 0 &&
      this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION &&
      !this.regenActive &&
      now - this.lastShieldLowAt >= 1200
    ) {
      this.lastShieldLowAt = now;
      sfx.play("shield_low");
    }
  }

  private consumeShot(shot: EnemyShotState) {
    const idx = this.world.enemyShots.findIndex((s) => s.id === shot.id);

    if (idx !== -1) {
      this.world.enemyShots.splice(idx, 1);
    }

    this.recentConsumedShots.set(shot.id, simNow());
    this.intents.shotConsumed(shot.id);
  }

  private fireReflectBeam(angle: number, now: number) {
    this.weapons.fireBolt("reflect", { x: this.pilot.shipX, y: this.pilot.shipY }, angle, now);
  }

  /** Full shield, no mod, no pending immunity: a run rebuilt from nothing (the playtest seed hook). */
  restart() {
    this.recentConsumedShots.clear();
    this.shieldHp = SHIELD_MAX;
    this.overHp = 0;
    this.lastDamageAt = 0;
    this.regenActive = false;
    this.shieldMod = null;
    this.shieldModUntil = 0;
    this.phasedUntil = 0;
    this.phaseReadyAt = 0;
    this.contactIframeUntil = 0;
    this.ramImmunity.clear();
    this.impactArcs = [];
  }

  detectIncomingDamage(now: number, dt: number) {
    if (!this.pilot.alive || !this.pilot.spawned) {
      return;
    }

    if (now < this.phasedUntil) {
      return;
    }

    if (now < this.pilot.invulnUntil) {
      return;
    }

    if (!this.asteroidContactDamage(now) || !this.pilot.alive) {
      return;
    }

    if (!this.enemyContactDamage(now) || !this.pilot.alive) {
      return;
    }

    if (!this.enemyShotDamage(now, dt) || !this.pilot.alive) {
      return;
    }

    if (!this.ufoContactDamage(now) || !this.pilot.alive) {
      return;
    }

    this.playerDamage(now);
  }

  private asteroidContactDamage(now: number) {
    for (const a of this.world.asteroids) {
      if (dist2(a.x, a.y, this.pilot.shipX, this.pilot.shipY) > a.radius * a.radius) {
        continue;
      }

      if (this.ramArmed()) {
        const imm = this.ramImmunity.get(a.id);

        if (imm !== undefined && now < imm) {
          continue;
        }

        this.ramImmunity.set(a.id, now + RAM_IMMUNITY_MS);

        if (a.radius <= RAM_ASTEROID_DESTROY_R) {
          this.hits.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
          this.intents.asteroidHit(a.id, 1);
          this.fx.sparks(a.x, a.y, 8, SHIELD_MOD_SPECS.ram.tint, {
            lifeMax: 250,
            lifeMin: 150,
          });
          sfx.play("hit_spark");
          this.trauma.add(0.1);
          continue;
        }

        this.progress.gainXp(XP.ASTEROID_CHIP, now);
        this.intents.asteroidHit(a.id, RAM_ASTEROID_CHIP);
        this.bounceOff(a.x, a.y, 0.6);

        if (this.applyDamage(RAM_SELF_DRAIN, a.x, a.y, "ASTEROID", null, now) !== "drained") {
          return false;
        }

        continue;
      }

      if (now < this.contactIframeUntil) {
        continue;
      }

      const res = this.applyDamage(
        asteroidContactDamage(a.radius),
        a.x,
        a.y,
        "ASTEROID",
        null,
        now,
      );

      if (res !== "drained") {
        return false;
      }

      this.bounceOff(a.x, a.y, 0.5);
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
      break;
    }

    return true;
  }

  private enemyContactDamage(now: number) {
    for (const e of this.world.enemies) {
      if (e.graceUntil > now) {
        continue;
      }

      const charging = e.kind === "lancer" && e.chargeUntil > now;
      const r = charging ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;

      if (dist2(e.x, e.y, this.pilot.shipX, this.pilot.shipY) > r * r) {
        continue;
      }

      let nx = e.x - this.pilot.shipX;
      let ny = e.y - this.pilot.shipY;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen;
      ny /= nlen;

      if (this.ramArmed()) {
        const imm = this.ramImmunity.get(e.id);

        if (imm !== undefined && now < imm) {
          continue;
        }

        this.ramImmunity.set(e.id, now + RAM_IMMUNITY_MS);

        if (e.hp - RAM_DAMAGE <= 0) {
          this.hits.predictKill(e.id, enemyKillXp(e), "enemy", e.x, e.y, now);
        }

        this.intents.enemyHit(e.id, RAM_DAMAGE, nx * RAM_KNOCKBACK, ny * RAM_KNOCKBACK);
        e.blinkUntil = now + 150;

        if (charging) {
          this.bounceOff(e.x, e.y, 0.6);
          this.trauma.add(0.3);
        }

        const drain = charging ? RAM_LANCER_DRAIN : RAM_SELF_DRAIN;

        if (this.applyDamage(drain, e.x, e.y, ENEMY_SPECS[e.kind].name, null, now) !== "drained") {
          return false;
        }

        continue;
      }

      if (now < this.contactIframeUntil) {
        continue;
      }

      const amount = charging ? DMG.LANCER_CHARGE : hullContactDamage(e.kind);
      const res = this.applyDamage(amount, e.x, e.y, ENEMY_SPECS[e.kind].name, null, now);

      if (res !== "drained") {
        return false;
      }

      this.bounceOff(e.x, e.y, 0.5);
      this.intents.enemyHit(e.id, 0, nx * RAM_KNOCKBACK * 0.5, ny * RAM_KNOCKBACK * 0.5);
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
      break;
    }

    return true;
  }

  private enemyShotDamage(now: number, dt: number) {
    for (let i = this.world.enemyShots.length - 1; i >= 0; i -= 1) {
      const s = this.world.enemyShots[i];

      if (!s || this.recentConsumedShots.has(s.id)) {
        continue;
      }

      const hit = segHitsCircle(
        s.x - s.vx * dt,
        s.y - s.vy * dt,
        s.x,
        s.y,
        this.pilot.shipX,
        this.pilot.shipY,
        SHIP_RADIUS,
      );

      if (!hit) {
        continue;
      }

      const { cause, dmg } = enemyShotHit(Math.hypot(s.vx, s.vy));
      this.consumeShot(s);

      if (this.reflectArmed()) {
        this.fireReflectBeam(Math.atan2(-s.vy, -s.vx), now);

        if (this.applyDamage(REFLECT_BOUNCE_COST, s.x, s.y, cause, null, now) !== "drained") {
          return false;
        }

        continue;
      }

      const res = this.applyDamage(dmg, s.x, s.y, cause, null, now);

      if (res !== "drained") {
        return false;
      }
    }

    return true;
  }

  private ufoContactDamage(now: number) {
    const u = this.world.ufo;

    if (!u || dist2(u.x, u.y, this.pilot.shipX, this.pilot.shipY) > UFO_RADIUS * UFO_RADIUS) {
      return true;
    }

    if (this.ramArmed()) {
      const imm = this.ramImmunity.get(u.id);

      if (imm === undefined || now >= imm) {
        this.ramImmunity.set(u.id, now + RAM_IMMUNITY_MS);

        if (u.hp - RAM_DAMAGE <= 0) {
          this.hits.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
        }

        this.intents.ufoHit(RAM_DAMAGE / 100);

        if (this.applyDamage(RAM_SELF_DRAIN, u.x, u.y, "UFO", null, now) !== "drained") {
          return false;
        }
      }
    } else if (now >= this.contactIframeUntil) {
      const res = this.applyDamage(DMG.UFO_HULL, u.x, u.y, "UFO", null, now);

      if (res !== "drained") {
        return false;
      }

      this.bounceOff(u.x, u.y, 0.5);
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
    }

    return true;
  }

  private playerDamage(now: number) {
    const { myId } = this.link;

    for (const [id, st] of this.link.peerStates) {
      if (id === myId) {
        continue;
      }

      if (!st || !st.alive) {
        continue;
      }

      if (!this.playerRamDamage(id, st, now)) {
        return;
      }

      if (!this.playerVolleyDamage(id, st, now)) {
        return;
      }
    }
  }

  private playerRamDamage(id: string, st: PlayerNetState, now: number) {
    const contact2 = SHIP_RADIUS * 2 * (SHIP_RADIUS * 2);
    const touching = dist2(st.x, st.y, this.pilot.shipX, this.pilot.shipY) <= contact2;

    if (
      touching &&
      st.shieldMod?.kind === "ram" &&
      st.shieldMod.active &&
      !st.invuln &&
      now >= this.contactIframeUntil
    ) {
      const res = this.applyDamage(RAM_PVP_DRAIN, st.x, st.y, "PLAYER", id, now);

      if (res !== "drained") {
        return false;
      }

      this.bounceOff(st.x, st.y, 0.5);
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
    }

    if (touching && this.ramArmed()) {
      const imm = this.ramImmunity.get(id);

      if (imm === undefined || now >= imm) {
        this.ramImmunity.set(id, now + RAM_IMMUNITY_MS);

        if (this.applyDamage(RAM_SELF_DRAIN, st.x, st.y, "PLAYER", id, now) !== "drained") {
          return false;
        }
      }
    }

    return true;
  }

  private playerVolleyDamage(id: string, st: PlayerNetState, now: number) {
    const iframeUntil = this.pvpIframeUntil.get(id) ?? 0;

    if (now < iframeUntil) {
      return true;
    }

    const volley = this.collectVolley(st, this.remoteFire.beamsOf(id));

    if (!volley.impact) {
      return true;
    }

    const heavy = volley.anyExploding || volley.anyGlaive || volley.maxPower >= 0.9;
    this.pvpIframeUntil.set(id, now + (heavy ? PVP_EXPLOSION_IFRAME_MS : PVP_HIT_IFRAME_MS));
    let { beamDrain } = volley;

    if (beamDrain > 0 && this.reflectArmed()) {
      this.fireReflectBeam(volley.reflectAngle, now);
      beamDrain = REFLECT_BOUNCE_COST;
    }

    const total = Math.min(PVP_MAX_SINGLE_HIT, beamDrain + volley.aoeDrain);
    const res = this.applyDamage(total, volley.impact.x, volley.impact.y, "PLAYER", id, now);

    return res === "drained";
  }

  private collectVolley(st: PlayerNetState, beams: readonly Beam[]) {
    const v: Volley = {
      anyExploding: false,
      anyGlaive: false,
      aoeDrain: 0,
      beamDrain: 0,
      impact: null,
      maxPower: 0,
      reflectAngle: 0,
    };

    if (
      st.tesla &&
      dist2(st.x, st.y, this.pilot.shipX, this.pilot.shipY) <= TESLA_RANGE * TESLA_RANGE
    ) {
      v.beamDrain += TESLA_POWER * 100 * PVP_DAMAGE_MULT;
      v.maxPower = Math.max(v.maxPower, TESLA_POWER);
      v.impact = { x: st.x, y: st.y };
      v.reflectAngle = Math.atan2(st.y - this.pilot.shipY, st.x - this.pilot.shipX);
    }

    for (const b of beams) {
      if (b.vanished || b.fizzle || (b.mine && !b.exploding)) {
        continue;
      }

      if (b.weapon.singularity && !b.exploding) {
        continue;
      }

      if (b.weapon.aura) {
        continue;
      }

      const chainSeg = beamHitSeg(b, this.pilot.shipX, this.pilot.shipY);

      if (chainSeg === null) {
        continue;
      }

      const { power } = b.weapon;
      v.maxPower = Math.max(v.maxPower, power);
      const hopMult = b.chain ? (b.weapon.arc?.falloff ?? 1) ** chainSeg : 1;
      const drain = power * 100 * PVP_DAMAGE_MULT * hopMult;

      if (b.exploding) {
        v.aoeDrain += drain;
        v.anyExploding = true;
      } else {
        if (b.glaive) {
          v.anyGlaive = true;
        }

        v.beamDrain += drain;
        v.reflectAngle = Math.atan2(b.tail.y - b.head.y, b.tail.x - b.head.x);
      }

      v.impact ??= { x: b.head.x, y: b.head.y };
    }

    return v;
  }

  die(now: number, killerId: string | null, cause: string) {
    this.fx.battle.burst(
      this.pilot.shipX,
      this.pilot.shipY,
      110,
      this.hooks.myTint(),
      "death",
      this.pilot.shipAngle,
      "important",
    );
    this.view.splinterBurst(this.pilot.shipX, this.pilot.shipY, 50, 30, now);
    this.fx.shatter(
      this.pilot.shipX,
      this.pilot.shipY,
      shipHullPoints(),
      this.pilot.shipAngle,
      this.hooks.myTint(),
      "important",
    );
    this.fx.ring(this.pilot.shipX, this.pilot.shipY, 10, 90, 400, 0xff_ff_ff, 0.7, "important");
    this.screenFlash();
    this.trauma.add(0.55);
    sfx.play("shield_break");
    sfx.play("player_death");
    this.pilot.alive = false;
    this.pilot.respawnAt = now + RESPAWN_DELAY_MS;
    this.pilot.invulnUntil = 0;
    this.weapons.beams = [];
    this.weapons.sentry = null;
    this.progress.applyDeathXpPenalty();
    this.pilot.specialBase = null;
    this.pilot.weapon = baseWeaponForLevel(this.progress.level);
    this.pilot.weaponUntil = 0;
    this.pilot.regenMult = baseRegenMult(this.progress.level);
    this.shieldHp = 0;
    this.overHp = 0;
    this.shieldMod = null;
    this.shieldModUntil = 0;
    this.pilot.boosts.clear();
    this.weapons.windupAcc = 0;
    this.regenActive = false;
    this.impactArcs = [];
    this.phasedUntil = 0;
    this.progress.streak = 0;
    this.progress.comboTier = 1;
    this.deathCause = cause;
    const count = (this.deathCounts.get(cause) ?? 0) + 1;
    this.deathCounts.set(cause, count);
    this.deathHint = count >= 3 ? (DEATH_HINTS.get(cause) ?? "") : "";
    const { myId } = this.link;

    if (killerId && myId) {
      this.link.sendTo(killerId, "player_killed", { cause, killerId, victimId: myId });
    }

    this.hooks.pushMyState(now);
  }

  private screenFlash() {
    this.layers.flashRect.setSize(this.scale.width + 8, this.scale.height + 8);
    this.layers.flashRect.setAlpha(REDUCED_MOTION.matches ? 0 : 0.25);
    this.tweens.killTweensOf(this.layers.flashRect);
    this.tweens.add({
      alpha: 0,
      delay: 50,
      duration: 200,
      targets: this.layers.flashRect,
    });
  }

  /** Wire shape of my shield mod: `active` = ram-armed / reflect->40 / phase-ready. */
  shieldModNetState(now: number) {
    const mod = this.shieldMod;

    if (!mod) {
      return null;
    }

    return {
      active: this.shieldModArmed(mod, now),
      kind: mod,
      phased: now < this.phasedUntil,
    };
  }

  private shieldModArmed(mod: ShieldModKind, now: number) {
    if (mod === "ram") {
      return this.ramArmed();
    }

    if (mod === "reflect") {
      return this.reflectArmed();
    }

    if (mod === "phase") {
      return now >= this.phaseReadyAt;
    }

    return true;
  }
}
