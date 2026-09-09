import { sfx } from "../audio/sfx";
import { contactPoint } from "../render/combat-visuals";
import { HITSPARK_SKIP_BUDGET } from "../render/fx-pool";
import type { GameScene } from "../scenes/game-scene";
import {
  ENEMY_SPECS,
  LANCER_CHARGE_HIT_RADIUS,
  UFO_RADIUS,
  XP,
  asteroidDestroyedBy,
} from "../shared/constants";
import type { Vec } from "../shared/constants";
import { beamHitsCircle } from "./beam";
import type { Beam } from "./beam";
import { DEG } from "./geometry";
import { NO_ASTEROIDS } from "./weapons";

type HitsScene = Pick<
  GameScene,
  "fx" | "hostCombat" | "mastery" | "netSendEvent" | "progress" | "spawned" | "weapons" | "world"
>;

/** Shooter-side hit detection: my beams against host-owned targets, reported as damage events with the destroy bonus predicted locally. */
export class ShooterHits {
  /** Targets whose destroy bonus I already self-awarded, awaiting host removal
   *  (id → time). Dedupes the bonus for beams that survive hits (LASER pierces
   *  and re-intersects every frame until the host's echo lands). */
  predictedKills = new Map<string, number>();

  private readonly scene: HitsScene;

  constructor(scene: HitsScene) {
    this.scene = scene;
  }

  private recordMasteryContact(beam: Beam, enemyId: string, now: number): void {
    if (beam.mastery) {
      this.scene.mastery.contact(beam.mastery, enemyId, beam.glaive?.returning ?? false, now);
    }
  }

  /** Self-award a predicted destroy bonus once per target (the host's echo
   *  later prunes the entry). Returns false when already predicted. */
  predictKill(
    id: string,
    xp: number,
    kind: "enemy" | "asteroid" | "ufo",
    x: number,
    y: number,
    now: number,
  ): boolean {
    if (this.predictedKills.has(id)) {
      return false;
    }
    this.predictedKills.set(id, now);
    this.scene.progress.registerKill(xp, now, kind, x, y);
    return true;
  }

  /**
   * Shooter-side hit detection: I detect my own beams hitting host-owned
   * targets and report damage events; the host applies them. Score is awarded
   * locally, with the destroy bonus predicted from the same damage formula
   * the host runs.
   */
  detectMyHits(now: number): void {
    if (!this.scene.spawned) {
      return;
    }
    // Crowd-scale FX budget: skip non-kill hit-spark spawns over the cap
    // (the victim's white flash stays — it's the readability signal).
    const sparksOk = this.scene.fx.aliveParticles() <= HITSPARK_SKIP_BUDGET;
    for (const b of this.scene.weapons.beams) {
      // ARC damage applied at cast
      if (b.vanished || b.chain) {
        continue;
      }
      // inert until triggered
      if (b.mine && !b.exploding) {
        continue;
      }
      this.hitAsteroids(b, sparksOk, now);
      if (b.vanished) {
        continue;
      }
      this.hitEnemies(b, sparksOk, now);
      if (b.vanished) {
        continue;
      }
      this.hitUfo(b, sparksOk, now);
    }
    for (const [id, t] of this.predictedKills) {
      if (now - t > 5000) {
        this.predictedKills.delete(id);
      }
    }
  }

  /** Impact burst + sparks at the contact point, in the beam's tint. */
  private hitSparks(b: Beam, contact: Vec, impactAngle: number): void {
    this.scene.fx.battle.burst(
      contact.x,
      contact.y,
      Math.min(32, 12 + b.weapon.power * 12),
      b.weapon.tint,
      "impact",
      impactAngle,
    );
    this.scene.fx.sparks(contact.x, contact.y, 9, b.weapon.tint, {
      angleMax: impactAngle / DEG + 65,
      angleMin: impactAngle / DEG - 65,
      lifeMax: 300,
      lifeMin: 150,
    });
  }

  private hitAsteroids(b: Beam, sparksOk: boolean, now: number): void {
    // PHASE LANCE: no asteroid hit-test at all — rocks aren't cover.
    const rocks = b.weapon.phasesRock ? NO_ASTEROIDS : this.scene.world.asteroids;
    for (const a of rocks) {
      if (!beamHitsCircle(b, a.x, a.y, a.radius)) {
        continue;
      }
      if (b.weapon.singularity && !b.exploding) {
        // Flight contact collapses the orb; damage comes from the pop.
        this.scene.weapons.startCollapse(b, now);
        break;
      }
      if (b.hitIds.has(a.id)) {
        continue;
      }
      b.hitIds.add(a.id);
      const contact = contactPoint(b.tail, b.head, a, a.radius, b.exploding);
      const impactAngle = b.angle;
      if (b.weapon.ricochet && b.bouncesLeft > 0 && !b.exploding) {
        // RICOCHET: damage lands below, but the bolt bounces instead of dying.
        const nx = b.head.x - a.x;
        const ny = b.head.y - a.y;
        const nl = Math.hypot(nx, ny) || 1;
        this.scene.weapons.ricochetBounce(b, nx / nl, ny / nl);
      } else {
        this.scene.weapons.onBeamHit(b, now);
      }
      const destroyed = asteroidDestroyedBy(a.radius, b.weapon.power);
      const predicted =
        destroyed && this.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
      // flat, never multiplied
      if (!predicted) {
        this.scene.progress.gainXp(XP.ASTEROID_CHIP, now);
      }
      if (sparksOk || destroyed) {
        this.hitSparks(b, contact, impactAngle);
      }
      sfx.play("hit_spark", { gain: 0.4 });
      this.scene.netSendEvent("asteroid_hit", { asteroidId: a.id, damage: b.weapon.power });
      // AoE circle keeps testing every target
      if (!b.exploding) {
        break;
      }
    }
  }

  private hitEnemies(b: Beam, sparksOk: boolean, now: number): void {
    for (const e of this.scene.world.enemies) {
      const r = e.chargeUntil > now ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
      if (!beamHitsCircle(b, e.x, e.y, r)) {
        continue;
      }
      if (b.weapon.singularity && !b.exploding) {
        this.scene.weapons.startCollapse(b, now);
        break;
      }
      if (b.hitIds.has(e.id)) {
        continue;
      }
      b.hitIds.add(e.id);
      this.recordMasteryContact(b, e.id, now);
      const contact = contactPoint(b.tail, b.head, e, r, b.exploding);
      const impactAngle = b.angle;
      this.scene.weapons.onBeamHit(b, now);
      const dmg = b.weapon.power * 100;
      const killed = e.hp - dmg <= 0;
      if (killed) {
        this.predictKill(e.id, this.scene.hostCombat.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
      }
      // immediate local feedback; host echoes
      e.blinkUntil = now + 150;
      if (sparksOk || killed) {
        this.hitSparks(b, contact, impactAngle);
      }
      sfx.play("hit_spark", { gain: 0.4 });
      this.scene.netSendEvent("enemy_hit", { damage: dmg, enemyId: e.id });
      // AoE circle keeps testing every target
      if (!b.exploding) {
        break;
      }
    }
  }

  private hitUfo(b: Beam, sparksOk: boolean, now: number): void {
    const u = this.scene.world.ufo;
    if (!u) {
      return;
    }
    const hit = beamHitsCircle(b, u.x, u.y, UFO_RADIUS);
    if (hit && b.weapon.singularity && !b.exploding) {
      this.scene.weapons.startCollapse(b, now);
      return;
    }
    if (!hit || b.hitIds.has(u.id)) {
      return;
    }
    b.hitIds.add(u.id);
    const contact = contactPoint(b.tail, b.head, u, UFO_RADIUS, b.exploding);
    const impactAngle = b.angle;
    this.scene.weapons.onBeamHit(b, now);
    const killed = u.hp - b.weapon.power * 100 <= 0;
    if (killed) {
      this.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
    }
    if (sparksOk || killed) {
      this.hitSparks(b, contact, impactAngle);
    }
    sfx.play("hit_spark", { gain: 0.4 });
    this.scene.netSendEvent("ufo_hit", { damage: b.weapon.power });
  }
}
