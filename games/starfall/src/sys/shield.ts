import { sfx } from "../audio/sfx";
import { REDUCED_MOTION } from "../render/battle-fx";
import { DEATH_HINTS } from "../render/hud-dom";
import { shipHullPoints } from "../render/vector-shapes";
import type { GameScene } from "../scenes/game-scene";
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
  WEAPON_DEFAULT,
  XP,
  asteroidContactDamage,
  baseRegenMult,
  baseWeaponForLevel,
  enemyShotHit,
} from "../shared/constants";
import type {
  EnemyKind,
  EnemyShotState,
  PlayerNetState,
  ShieldModKind,
  ShieldModNetState,
  Vec,
  Weapon,
} from "../shared/constants";
import { serializedBeamHitSeg } from "./beam";
import { DEG, dist2, segHitsCircle } from "./geometry";

type ShieldScene = Pick<
  GameScene,
  | "alive"
  | "amHost"
  | "boosts"
  | "flashRect"
  | "fx"
  | "hits"
  | "host"
  | "hostCombat"
  | "invulnUntil"
  | "myId"
  | "myTint"
  | "net"
  | "netSendEvent"
  | "peerStates"
  | "progress"
  | "regenMult"
  | "respawnAt"
  | "scale"
  | "shipAngle"
  | "shipVX"
  | "shipVY"
  | "shipView"
  | "shipX"
  | "shipY"
  | "spawned"
  | "specialBase"
  | "trailer"
  | "trauma"
  | "tweens"
  | "view"
  | "weapon"
  | "weaponUntil"
  | "weapons"
  | "world"
>;

/** ARC per-hop falloff for victim-side chain drains. SerializedBeam carries
 *  no weapon ref, so read it from the ARC spec (TESLA also carries an arc
 *  spec, hence the !aura filter). */
export const ARC_FALLOFF =
  WEAPONS_SPECIAL.find((w) => w.arc !== null && !w.aura)?.arc?.falloff ?? 0.7;

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
export const hullContactDamage = (kind: EnemyKind): number => {
  if (kind === "lancer") {
    return DMG.LANCER_HULL;
  }
  if (kind === "dreadnought") {
    return BOSS_CONTACT_DMG;
  }
  return DMG.ENEMY_HULL;
};

/** Victim-side adjudication: every incoming damage source (rocks, hulls, enemy shots, UFO, PvP beams and rams) drains my shield here, with regen, mods (overshield/phase/reflect/bulwark/aegis…) and death. */
export class Shield {
  /** Enemy shots we consumed locally (shield/death), awaiting host removal
   *  (id → time) — stops stale snapshots resurrecting them into the shield. */
  recentConsumedShots = new Map<string, number>();

  // base shield + mod (victim-side adjudication; mirrored into net state)
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

  /** PvP beams persist across render frames between 20Hz snapshots: brief
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

  // death bookkeeping (overlay cause + adaptive hints)
  deathCause = "";

  deathHint = "";

  private deathCounts = new Map<string, number>();

  private readonly scene: ShieldScene;

  constructor(scene: ShieldScene) {
    this.scene = scene;
  }

  private ramArmed(): boolean {
    return (
      this.shieldMod === "ram" && Math.hypot(this.scene.shipVX, this.scene.shipVY) > RAM_ARM_SPEED
    );
  }

  /** REFLECT bounces only while the base shield is above the gate. */
  private reflectArmed(): boolean {
    return this.shieldMod === "reflect" && this.shieldHp > REFLECT_MIN_SHIELD;
  }

  /** Reflect my velocity off the obstacle at (cx,cy), scaled, plus a nudge out. */
  private bounceOff(cx: number, cy: number, scale: number): void {
    let nx = this.scene.shipX - cx;
    let ny = this.scene.shipY - cy;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const dot = this.scene.shipVX * nx + this.scene.shipVY * ny;
    if (dot < 0) {
      this.scene.shipVX = (this.scene.shipVX - 2 * dot * nx) * scale;
      this.scene.shipVY = (this.scene.shipVY - 2 * dot * ny) * scale;
    } else {
      this.scene.shipVX *= scale;
      this.scene.shipVY *= scale;
    }
    this.scene.shipX += nx * 2;
    this.scene.shipY += ny * 2;
  }

  /** Ring flash + 60° impact arc + sparks + retuned trauma + pitched ping. */
  private shieldHitFx(now: number, impactX: number, impactY: number, amount: number): void {
    this.haloFlashUntil = now + 80;
    const ang = Math.atan2(impactY - this.scene.shipY, impactX - this.scene.shipX);
    this.impactArcs.push({ angle: ang, diesAt: now + 150 });
    this.scene.fx.battle.burst(
      this.scene.shipX + Math.cos(ang) * SHIELD_RING_RADIUS,
      this.scene.shipY + Math.sin(ang) * SHIELD_RING_RADIUS,
      27,
      SHIELD_RING_TINT,
      "impact",
      ang,
      "important",
    );
    this.scene.fx.sparks(impactX, impactY, 8, SHIELD_RING_TINT, {
      angleMax: ang / DEG + 22.5,
      angleMin: ang / DEG - 22.5,
      importance: "important",
      lifeMax: 250,
      lifeMin: 150,
      // Hull-local, and the reel's crowd shots take one of these every few
      // frames — the single biggest contributor to the white splat.
      scale: 0.6 * this.scene.shipView.hullGlow(),
    });
    // Hits sound lower as you get closer to death (§A.5).
    const fraction = Math.max(0, Math.min(1, this.shieldHp / SHIELD_MAX));
    sfx.play("shield_hit", { rate: 0.85 + 0.3 * fraction });
    this.scene.trauma.add(amount >= 40 ? 0.25 : 0.12);
  }

  /** Halo break flash (PHASE blinks; death layers shield_break in die()). */
  private shieldBreakFx(now: number): void {
    this.haloFlashUntil = now + 80;
    this.scene.fx.ring(
      this.scene.shipX,
      this.scene.shipY,
      SHIELD_RING_RADIUS,
      40,
      300,
      SHIELD_RING_TINT,
      0.7,
      "important",
    );
    this.scene.trauma.add(0.3);
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
  ): "phased" | "dead" | "drained" {
    if (!this.scene.alive) {
      return "dead";
    }
    // PHASE auto-blink: negate haymakers (≥40) and killing blows entirely.
    if (
      this.shieldMod === "phase" &&
      now >= this.phaseReadyAt &&
      (amount >= PHASE_TRIGGER_HIT || amount >= this.shieldHp + this.overHp)
    ) {
      this.phasedUntil = now + PHASE_DURATION_MS;
      this.phaseReadyAt = now + PHASE_COOLDOWN_MS;
      // Blink cost — phasing itself can never kill you.
      this.shieldHp -= Math.min(PHASE_COST, Math.max(0, this.shieldHp - 1));
      this.lastDamageAt = now;
      this.regenActive = false;
      this.shieldBreakFx(now);
      sfx.play("shield_break", { gain: 0.6, rate: 1.25 });
      return "phased";
    }
    // BULWARK: hits landing inside the frontal cone are mitigated; the rear is
    // exposed. fromX/fromY is the hit source, so no extra wire data is needed.
    let mitigated = amount;
    if (this.shieldMod === "bulwark" && now < this.shieldModUntil) {
      let rel =
        Math.atan2(fromY - this.scene.shipY, fromX - this.scene.shipX) - this.scene.shipAngle;
      // wrap to [-π, π]
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
    // Trailer: the hit is real — drain, arcs, flash, sfx — but a staged scene
    // with no death beat cannot lose its pilot. Enemy shots skip contact
    // i-frames and several resolve inside one sim step, so a between-frames
    // top-up always races them; the guarantee has to live at the kill itself.
    if (this.shieldHp <= 0 && this.scene.trailer?.deathless === true) {
      this.shieldHp = 1;
    }
    if (this.shieldHp <= 0) {
      this.die(now, killerId, cause);
      return "dead";
    }
    this.shieldHitFx(now, fromX, fromY, amount);
    if (!wasLow && this.shieldHp < SHIELD_MAX * SHIELD_LOW_FRACTION) {
      this.scene.trauma.add(0.15);
    }
    return "drained";
  }

  /** Base regen (Halo grammar) + overheal decay + mod/booster expiry. */
  tickShield(now: number, dt: number): void {
    if (this.shieldMod && now >= this.shieldModUntil) {
      this.shieldMod = null;
      // remaining OVERSHIELD bonus vanishes with the mod
      this.overHp = 0;
    }
    for (const [kind, until] of this.scene.boosts) {
      if (now >= until) {
        this.scene.boosts.delete(kind);
      }
    }
    if (!this.scene.alive) {
      return;
    }
    // SIPHON overheal above 100 bleeds off and never regens.
    if (this.shieldHp > SHIELD_MAX) {
      this.shieldHp = Math.max(SHIELD_MAX, this.shieldHp - SIPHON_OVERHEAL_DECAY_PER_S * dt);
    }
    const delay = this.shieldMod === "aegis" ? AEGIS_REGEN_DELAY_MS : SHIELD_REGEN_DELAY_MS;
    if (this.shieldHp < SHIELD_MAX && now - this.lastDamageAt >= delay) {
      if (!this.regenActive) {
        this.regenActive = true;
        // once, when regen starts after a drain
        sfx.play("shield_regen");
      }
      const rate =
        (SHIELD_MAX / (SHIELD_REGEN_FULL_MS / 1000)) *
        // levelling: faster recovery, not more max HP
        this.scene.regenMult *
        (this.shieldMod === "aegis" ? AEGIS_REGEN_MULT : 1);
      this.shieldHp = Math.min(SHIELD_MAX, this.shieldHp + rate * dt);
      if (this.shieldHp >= SHIELD_MAX) {
        this.regenActive = false;
      }
    } else if (this.shieldHp >= SHIELD_MAX) {
      this.regenActive = false;
    }
    // Low-shield warning tone: while low and not regenerating, 1.2s gate.
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

  /** Locally remove an enemy shot + tell the host (it owns the array). */
  private consumeShot(shot: EnemyShotState): void {
    const idx = this.scene.world.enemyShots.findIndex((s) => s.id === shot.id);
    if (idx !== -1) {
      this.scene.world.enemyShots.splice(idx, 1);
    }
    this.recentConsumedShots.set(shot.id, simNow());
    if (this.scene.amHost) {
      this.scene.host.dirty.enemyShots = true;
    }
    this.scene.netSendEvent("proj_consumed", { shotId: shot.id });
  }

  /** REFLECT return shot: NORMAL-stat beam along the reversed incoming vector. */
  private fireReflectBeam(angle: number, now: number): void {
    const weapon: Weapon = { ...WEAPON_DEFAULT, tint: SHIELD_MOD_SPECS.reflect.tint };
    this.scene.weapons.beams.push(
      this.scene.weapons.makeBeam({ x: this.scene.shipX, y: this.scene.shipY }, angle, weapon, now),
    );
  }

  /**
   * Victim-side drain detection (§A.2/§B.2): asteroids and hulls drain on
   * contact with the ship CENTER (generous); shots/beams drain within the
   * ship radius. Every source computes a drain and runs the one applyDamage
   * pipeline; the victim reports its own killer and adjudicates its own mods.
   */
  detectIncomingDamage(now: number, dt: number): void {
    if (!this.scene.alive || !this.scene.spawned) {
      return;
    }
    // intangible: no collisions either way
    if (now < this.phasedUntil) {
      return;
    }
    // respawn invuln: zero shield interaction
    if (now < this.scene.invulnUntil) {
      return;
    }
    // Each source returns false once a drain ended the frame (death / phase
    // blink); the alive re-check covers drains that killed without saying so.
    if (!this.asteroidContactDamage(now) || !this.scene.alive) {
      return;
    }
    if (!this.enemyContactDamage(now) || !this.scene.alive) {
      return;
    }
    if (!this.enemyShotDamage(now, dt) || !this.scene.alive) {
      return;
    }
    if (!this.ufoContactDamage(now) || !this.scene.alive) {
      return;
    }
    this.playerDamage(now);
  }

  /** Asteroid contact: one drain per CONTACT_IFRAME window. */
  private asteroidContactDamage(now: number): boolean {
    for (const a of this.scene.world.asteroids) {
      if (dist2(a.x, a.y, this.scene.shipX, this.scene.shipY) > a.radius * a.radius) {
        continue;
      }
      if (this.ramArmed()) {
        // RAM stops matter: small rocks die free, big rocks chip + 10 drain.
        const imm = this.ramImmunity.get(a.id);
        if (imm !== undefined && now < imm) {
          continue;
        }
        this.ramImmunity.set(a.id, now + RAM_IMMUNITY_MS);
        if (a.radius <= RAM_ASTEROID_DESTROY_R) {
          this.scene.hits.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
          this.scene.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: 1 });
          this.scene.fx.sparks(a.x, a.y, 8, SHIELD_MOD_SPECS.ram.tint, {
            lifeMax: 250,
            lifeMin: 150,
          });
          sfx.play("hit_spark");
          this.scene.trauma.add(0.1);
          continue;
        }
        this.scene.progress.gainXp(XP.ASTEROID_CHIP, now);
        this.scene.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: RAM_ASTEROID_CHIP });
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

  /** Enemy hull contact + LANCER charge. */
  private enemyContactDamage(now: number): boolean {
    for (const e of this.scene.world.enemies) {
      // flashing in: harmless
      if (e.graceUntil > now) {
        continue;
      }
      const charging = e.kind === "lancer" && e.chargeUntil > now;
      const r = charging ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
      if (dist2(e.x, e.y, this.scene.shipX, this.scene.shipY) > r * r) {
        continue;
      }
      let nx = e.x - this.scene.shipX;
      let ny = e.y - this.scene.shipY;
      const nlen = Math.hypot(nx, ny) || 1;
      nx /= nlen;
      ny /= nlen;
      if (this.ramArmed()) {
        // The shield becomes a weapon: enemy takes 60, I pay 10 (25 vs a
        // mid-charge lancer, with the bounce + trauma).
        const imm = this.ramImmunity.get(e.id);
        if (imm !== undefined && now < imm) {
          continue;
        }
        this.ramImmunity.set(e.id, now + RAM_IMMUNITY_MS);
        if (e.hp - RAM_DAMAGE <= 0) {
          this.scene.hits.predictKill(
            e.id,
            this.scene.hostCombat.enemyKillXp(e.kind),
            "enemy",
            e.x,
            e.y,
            now,
          );
        }
        this.scene.netSendEvent("enemy_hit", {
          damage: RAM_DAMAGE,
          enemyId: e.id,
          kx: nx * RAM_KNOCKBACK,
          ky: ny * RAM_KNOCKBACK,
        });
        e.blinkUntil = now + 150;
        if (charging) {
          this.bounceOff(e.x, e.y, 0.6);
          this.scene.trauma.add(0.3);
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
      // knock both back (kept from v1)
      this.scene.netSendEvent("enemy_hit", {
        damage: 0,
        enemyId: e.id,
        kx: nx * RAM_KNOCKBACK * 0.5,
        ky: ny * RAM_KNOCKBACK * 0.5,
      });
      this.contactIframeUntil = now + CONTACT_IFRAME_MS;
      break;
    }
    return true;
  }

  /** Enemy projectiles (host-owned; I detect my own hit, mirror of PvP
   *  beams). Shots ignore contact i-frames and are always consumed. */
  private enemyShotDamage(now: number, dt: number): boolean {
    // Reverse index loop: consumeShot splices mid-iteration.
    for (let i = this.scene.world.enemyShots.length - 1; i >= 0; i -= 1) {
      const s = this.scene.world.enemyShots[i];
      // consumed; host echo pending
      if (!s || this.recentConsumedShots.has(s.id)) {
        continue;
      }
      const hit = segHitsCircle(
        s.x - s.vx * dt,
        s.y - s.vy * dt,
        s.x,
        s.y,
        this.scene.shipX,
        this.scene.shipY,
        SHIP_RADIUS,
      );
      if (!hit) {
        continue;
      }
      // Shots aren't source-attributed on the wire; speed identifies the kind
      // (drone/warden/boss-plasma → DRONE, wasp → WASP, sniper/boss-lance → SNIPER).
      const { cause, dmg } = enemyShotHit(Math.hypot(s.vx, s.vy));
      // every shot that hits is consumed — same event
      this.consumeShot(s);
      if (this.reflectArmed()) {
        // Bounce: pay 12 shield instead of the damage, return the bolt.
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

  /** UFO contact (treated as a hull). */
  private ufoContactDamage(now: number): boolean {
    const u = this.scene.world.ufo;
    if (!u || dist2(u.x, u.y, this.scene.shipX, this.scene.shipY) > UFO_RADIUS * UFO_RADIUS) {
      return true;
    }
    if (this.ramArmed()) {
      const imm = this.ramImmunity.get(u.id);
      if (imm === undefined || now >= imm) {
        this.ramImmunity.set(u.id, now + RAM_IMMUNITY_MS);
        if (u.hp - RAM_DAMAGE <= 0) {
          this.scene.hits.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
        }
        this.scene.netSendEvent("ufo_hit", { damage: RAM_DAMAGE / 100 });
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

  /** Other players: armed-RAM hull contact + the beam volley rule (§A.2). */
  private playerDamage(now: number): void {
    const { myId } = this.scene;
    for (const [id, st] of this.scene.peerStates) {
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

  /** Hull contact with a remote ship: their armed RAM drains me 35 (victim
   *  adjudicates); my own armed RAM costs me 10 (they take their 35). */
  private playerRamDamage(id: string, st: PlayerNetState, now: number): boolean {
    const contact2 = SHIP_RADIUS * 2 * (SHIP_RADIUS * 2);
    const touching = dist2(st.x, st.y, this.scene.shipX, this.scene.shipY) <= contact2;
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

  /**
   * Volley rule: test ALL of one shooter's beams this frame, sum the
   * drains, clamp, apply once, then i-frame that shooter — this is what
   * makes SCATTER one 48-drain volley instead of an instakill, and stops
   * a persistent beam snapshot draining 60×/s between 20Hz updates.
   */
  private playerVolleyDamage(id: string, st: PlayerNetState, now: number): boolean {
    const iframeUntil = this.pvpIframeUntil.get(id) ?? 0;
    if (now < iframeUntil) {
      return true;
    }
    const volley = this.collectVolley(st);
    if (!volley.impact) {
      return true;
    }
    // Heavy beams (RAILGUN, power ≥ 0.9) get the 300ms tier: a 320px lance
    // covers the victim across ≥2 serialized snapshots (~150ms at 20Hz), so
    // the 120ms i-frame would let one shot drain twice — 180 from full,
    // breaking PVP_MAX_SINGLE_HIT's no-volley-kills-from-full invariant.
    // No intended-TTK change: BLASTER (450ms) and RAILGUN (1100ms) both
    // refire slower than 300ms. GLAIVE shares the tier: the blade stalls at
    // its apex (GLAIVE_DECEL_PX), so a parked snapshot would otherwise
    // re-drain 35 every 120ms — apex camping beats the intended ~per-pass hit.
    const heavy = volley.anyExploding || volley.anyGlaive || volley.maxPower >= 0.9;
    this.pvpIframeUntil.set(id, now + (heavy ? PVP_EXPLOSION_IFRAME_MS : PVP_HIT_IFRAME_MS));
    let { beamDrain } = volley;
    if (beamDrain > 0 && this.reflectArmed()) {
      // One bounce covers the entire same-frame volley; AoE is never
      // reflected and drains normally on top.
      this.fireReflectBeam(volley.reflectAngle, now);
      beamDrain = REFLECT_BOUNCE_COST;
    }
    const total = Math.min(PVP_MAX_SINGLE_HIT, beamDrain + volley.aoeDrain);
    const res = this.applyDamage(total, volley.impact.x, volley.impact.y, "PLAYER", id, now);
    return res === "drained";
  }

  /** Sum one shooter's beams (and TESLA aura) that touch my hull this frame. */
  private collectVolley(st: PlayerNetState): Volley {
    const v: Volley = {
      anyExploding: false,
      anyGlaive: false,
      aoeDrain: 0,
      beamDrain: 0,
      impact: null,
      maxPower: 0,
      reflectAngle: 0,
    };
    // TESLA AURA (RAM pattern): the shooter's serialized flag + MY
    // proximity adjudicate the zap. It joins the same volley sum, so the
    // aura and any stray beam clamp + i-frame together.
    if (
      st.tesla &&
      dist2(st.x, st.y, this.scene.shipX, this.scene.shipY) <= TESLA_RANGE * TESLA_RANGE
    ) {
      v.beamDrain += TESLA_POWER * 100 * PVP_DAMAGE_MULT;
      v.maxPower = Math.max(v.maxPower, TESLA_POWER);
      v.impact = { x: st.x, y: st.y };
      v.reflectAngle = Math.atan2(st.y - this.scene.shipY, st.x - this.scene.shipX);
    }
    for (const sb of st.beams) {
      // inert mines never hit-test
      if (sb.mine && !sb.exploding) {
        continue;
      }
      // SINGULARITY orb: only the pop damages
      if (sb.orb) {
        continue;
      }
      // TESLA chains are render-only for PvP — the flag above is the drain.
      if (st.tesla && sb.chain) {
        continue;
      }
      const chainSeg = serializedBeamHitSeg(sb, this.scene.shipX, this.scene.shipY);
      if (chainSeg === null) {
        continue;
      }
      const power = sb.power ?? WEAPON_DEFAULT.power;
      v.maxPower = Math.max(v.maxPower, power);
      // ARC hops decay like the owner-side cast: segment i ends at hop i+1,
      // so segment 0 (muzzle→first target) is full power and each later
      // segment falls off once per hop — matching the PvE falloff exactly.
      const hopMult = sb.chain ? ARC_FALLOFF ** chainSeg : 1;
      const drain = power * 100 * PVP_DAMAGE_MULT * hopMult;
      if (sb.exploding) {
        v.aoeDrain += drain;
        v.anyExploding = true;
      } else {
        if (sb.glaive === true) {
          v.anyGlaive = true;
        }
        v.beamDrain += drain;
        v.reflectAngle = Math.atan2(sb.ty - sb.hy, sb.tx - sb.hx);
      }
      v.impact ??= { x: sb.hx, y: sb.hy };
    }
    return v;
  }

  die(now: number, killerId: string | null, cause: string): void {
    this.scene.fx.battle.burst(
      this.scene.shipX,
      this.scene.shipY,
      110,
      this.scene.myTint(),
      "death",
      this.scene.shipAngle,
      "important",
    );
    this.scene.view.splinterBurst(this.scene.shipX, this.scene.shipY, 50, 30, now);
    this.scene.fx.shatter(
      this.scene.shipX,
      this.scene.shipY,
      shipHullPoints(),
      this.scene.shipAngle,
      this.scene.myTint(),
      "important",
    );
    this.scene.fx.ring(
      this.scene.shipX,
      this.scene.shipY,
      10,
      90,
      400,
      0xff_ff_ff,
      0.7,
      "important",
    );
    this.screenFlash();
    this.scene.trauma.add(0.55);
    // break = death, layered under the boom (§A.4)
    sfx.play("shield_break");
    sfx.play("player_death");
    this.scene.alive = false;
    this.scene.respawnAt = now + RESPAWN_DELAY_MS;
    this.scene.invulnUntil = 0;
    // mines included — they ride in beams[]
    this.scene.weapons.beams = [];
    // the turret dies with its owner
    this.scene.weapons.sentry = null;
    // Death tax: lose XP (and maybe one level), then revert to the new level's
    // base weapon. Mod + boosters lost, combo resets.
    this.scene.progress.applyDeathXpPenalty();
    this.scene.specialBase = null;
    this.scene.weapon = baseWeaponForLevel(this.scene.progress.level);
    this.scene.weaponUntil = 0;
    this.scene.regenMult = baseRegenMult(this.scene.progress.level);
    this.shieldHp = 0;
    this.overHp = 0;
    this.shieldMod = null;
    this.shieldModUntil = 0;
    this.scene.boosts.clear();
    this.scene.weapons.windupAcc = 0;
    this.regenActive = false;
    this.impactArcs = [];
    this.phasedUntil = 0;
    this.scene.progress.streak = 0;
    this.scene.progress.comboTier = 1;
    this.deathCause = cause;
    const count = (this.deathCounts.get(cause) ?? 0) + 1;
    this.deathCounts.set(cause, count);
    this.deathHint = count >= 3 ? (DEATH_HINTS.get(cause) ?? "") : "";
    const { myId } = this.scene;
    if (killerId && myId) {
      this.scene.netSendEvent("player_killed", { cause, killerId, victimId: myId });
    }
    // immediate, so remote ships hide without 50ms lag
    this.scene.net.pushMyState(now);
  }

  /** 50ms full-screen white at 0.25, fading 200ms (§9 player death). */
  private screenFlash(): void {
    this.scene.flashRect.setSize(this.scene.scale.width + 8, this.scene.scale.height + 8);
    this.scene.flashRect.setAlpha(REDUCED_MOTION.matches ? 0 : 0.25);
    this.scene.tweens.killTweensOf(this.scene.flashRect);
    this.scene.tweens.add({ alpha: 0, delay: 50, duration: 200, targets: this.scene.flashRect });
  }

  /** Wire shape of my shield mod: `active` = ram-armed / reflect->40 / phase-ready. */
  shieldModNetState(now: number): ShieldModNetState | null {
    const mod = this.shieldMod;
    if (!mod) {
      return null;
    }
    return {
      active: this.shieldModArmed(mod, now),
      kind: mod,
      phased: now < this.phasedUntil,
      until: this.shieldModUntil,
    };
  }

  private shieldModArmed(mod: ShieldModKind, now: number): boolean {
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
