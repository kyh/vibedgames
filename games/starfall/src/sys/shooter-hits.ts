import { sfx } from "../audio/sfx";
import type { HostCombat } from "../net/host-combat";
import type { HostIntents } from "../net/intents";
import { contactPoint } from "../render/combat-visuals";
import { HITSPARK_SKIP_BUDGET } from "../render/fx-pool";
import type { FxPool } from "../render/fx-pool";
import { now as simNow } from "../shared/clock";
import {
  ENEMY_SPECS,
  LANCER_CHARGE_HIT_RADIUS,
  UFO_RADIUS,
  XP,
  asteroidDestroyedBy,
} from "../shared/constants";
import type { AsteroidState, SharedState, Vec } from "../shared/constants";
import type { Pilot } from "../state/pilot";
import { beamHitsCircle } from "./beam";
import type { Beam } from "./beam";
import type { BeamOwner, BeamSim } from "./beam-sim";
import { DEG } from "./geometry";
import type { Progression } from "./progression";
import type { Weapons } from "./weapons";

/** PHASE LANCE: the asteroid pass iterates this instead (skip, zero alloc). */
const NO_ASTEROIDS: readonly AsteroidState[] = [];

export interface ShooterHitsDeps {
  world: SharedState;
  pilot: Pilot;
  fx: FxPool;
  weapons: Weapons;
  sim: BeamSim;
  progress: Progression;
  hostCombat: HostCombat;
  intents: HostIntents;
}

/** One pass of beams against the host-owned targets. Mine report damage
 *  (and predict the destroy bonus); a remote player's copies only react —
 *  vanish, bounce, burst, explode — so they fly the path its owner sees. */
interface HitPass {
  beams: Beam[];
  owner: BeamOwner;
  report: boolean;
  sparksOk: boolean;
  now: number;
}

/** The world's deadlines are on my sim clock; a remote pass runs on its
 *  shooter's clock, so it reads mine for them. */
const worldNow = (pass: HitPass): number => (pass.report ? pass.now : simNow());

/** Shooter-side hit detection: my beams against host-owned targets, reported to the host with the destroy bonus predicted locally — and the same contact reactions for every remote player's beams. */
export class ShooterHits {
  /** Targets whose destroy bonus I already self-awarded, awaiting host removal
   *  (id → time). Dedupes the bonus for beams that survive hits (LASER pierces
   *  and re-intersects every frame until the host's echo lands). */
  predictedKills = new Map<string, number>();

  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly fx: FxPool;

  private readonly weapons: Weapons;

  private readonly sim: BeamSim;

  private readonly progress: Progression;

  private readonly hostCombat: HostCombat;

  private readonly intents: HostIntents;

  constructor(deps: ShooterHitsDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.fx = deps.fx;
    this.weapons = deps.weapons;
    this.sim = deps.sim;
    this.progress = deps.progress;
    this.hostCombat = deps.hostCombat;
    this.intents = deps.intents;
  }

  private recordMasteryContact(beam: Beam, enemyId: string, now: number): void {
    if (beam.mastery) {
      this.pilot.mastery.contact(beam.mastery, enemyId, beam.glaive?.returning ?? false, now);
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
    this.progress.registerKill(xp, now, kind, x, y);
    return true;
  }

  /**
   * Shooter-side hit detection: I detect my own beams hitting host-owned
   * targets and report damage to the host, which applies it. Score is
   * awarded locally, with the destroy bonus predicted from the same damage
   * formula the host runs.
   */
  detectMyHits(now: number): void {
    if (!this.pilot.spawned) {
      return;
    }
    // Crowd-scale FX budget: skip non-kill hit-spark spawns over the cap
    // (the victim's white flash stays — it's the readability signal).
    this.scan({
      beams: this.weapons.beams,
      now,
      owner: this.weapons.owner,
      report: true,
      sparksOk: this.fx.aliveParticles() <= HITSPARK_SKIP_BUDGET,
    });
    for (const [id, t] of this.predictedKills) {
      if (now - t > 5000) {
        this.predictedKills.delete(id);
      }
    }
  }

  /** A remote player's beams against the same targets: reactions only. */
  react(beams: Beam[], owner: BeamOwner, now: number): void {
    this.scan({ beams, now, owner, report: false, sparksOk: false });
  }

  private scan(pass: HitPass): void {
    for (const b of pass.beams) {
      // ARC damage applied at cast
      if (b.vanished || b.chain) {
        continue;
      }
      // inert until triggered
      if (b.mine && !b.exploding) {
        continue;
      }
      this.hitAsteroids(pass, b);
      if (b.vanished) {
        continue;
      }
      this.hitEnemies(pass, b);
      if (b.vanished) {
        continue;
      }
      this.hitUfo(pass, b);
    }
  }

  /** Impact burst + sparks at the contact point, in the beam's tint. */
  private hitSparks(b: Beam, contact: Vec, impactAngle: number): void {
    this.fx.battle.burst(
      contact.x,
      contact.y,
      Math.min(32, 12 + b.weapon.power * 12),
      b.weapon.tint,
      "impact",
      impactAngle,
    );
    this.fx.sparks(contact.x, contact.y, 9, b.weapon.tint, {
      angleMax: impactAngle / DEG + 65,
      angleMin: impactAngle / DEG - 65,
      lifeMax: 300,
      lifeMin: 150,
    });
  }

  private hitAsteroids(pass: HitPass, b: Beam): void {
    const { now } = pass;
    // PHASE LANCE: no asteroid hit-test at all — rocks aren't cover.
    const rocks = b.weapon.phasesRock ? NO_ASTEROIDS : this.world.asteroids;
    for (const a of rocks) {
      if (!beamHitsCircle(b, a.x, a.y, a.radius)) {
        continue;
      }
      if (b.weapon.singularity && !b.exploding) {
        // Flight contact collapses the orb; damage comes from the pop.
        this.sim.startCollapse(b, pass.owner, now);
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
        this.sim.ricochetBounce(b, nx / nl, ny / nl);
      } else {
        this.sim.onBeamHit(pass.beams, b, pass.owner, now);
      }
      if (pass.report) {
        const destroyed = asteroidDestroyedBy(a.radius, b.weapon.power);
        const predicted =
          destroyed && this.predictKill(a.id, XP.ASTEROID_DESTROY, "asteroid", a.x, a.y, now);
        // flat, never multiplied
        if (!predicted) {
          this.progress.gainXp(XP.ASTEROID_CHIP, now);
        }
        if (pass.sparksOk || destroyed) {
          this.hitSparks(b, contact, impactAngle);
        }
        sfx.play("hit_spark", { gain: 0.4 });
        this.intents.asteroidHit(a.id, b.weapon.power);
      }
      // AoE circle keeps testing every target
      if (!b.exploding) {
        break;
      }
    }
  }

  private hitEnemies(pass: HitPass, b: Beam): void {
    const { now } = pass;
    for (const e of this.world.enemies) {
      const charging = e.kind === "lancer" && e.chargeUntil > worldNow(pass);
      const r = charging ? LANCER_CHARGE_HIT_RADIUS : ENEMY_SPECS[e.kind].hitRadius;
      if (!beamHitsCircle(b, e.x, e.y, r)) {
        continue;
      }
      if (b.weapon.singularity && !b.exploding) {
        this.sim.startCollapse(b, pass.owner, now);
        break;
      }
      if (b.hitIds.has(e.id)) {
        continue;
      }
      b.hitIds.add(e.id);
      const contact = contactPoint(b.tail, b.head, e, r, b.exploding);
      const impactAngle = b.angle;
      this.sim.onBeamHit(pass.beams, b, pass.owner, now);
      if (pass.report) {
        this.recordMasteryContact(b, e.id, now);
        const dmg = b.weapon.power * 100;
        const killed = e.hp - dmg <= 0;
        if (killed) {
          this.predictKill(e.id, this.hostCombat.enemyKillXp(e.kind), "enemy", e.x, e.y, now);
        }
        // immediate local feedback; host echoes
        e.blinkUntil = now + 150;
        if (pass.sparksOk || killed) {
          this.hitSparks(b, contact, impactAngle);
        }
        sfx.play("hit_spark", { gain: 0.4 });
        this.intents.enemyHit(e.id, dmg);
      }
      // AoE circle keeps testing every target
      if (!b.exploding) {
        break;
      }
    }
  }

  private hitUfo(pass: HitPass, b: Beam): void {
    const { now } = pass;
    const u = this.world.ufo;
    if (!u) {
      return;
    }
    const hit = beamHitsCircle(b, u.x, u.y, UFO_RADIUS);
    if (hit && b.weapon.singularity && !b.exploding) {
      this.sim.startCollapse(b, pass.owner, now);
      return;
    }
    if (!hit || b.hitIds.has(u.id)) {
      return;
    }
    b.hitIds.add(u.id);
    const contact = contactPoint(b.tail, b.head, u, UFO_RADIUS, b.exploding);
    const impactAngle = b.angle;
    this.sim.onBeamHit(pass.beams, b, pass.owner, now);
    if (!pass.report) {
      return;
    }
    const killed = u.hp - b.weapon.power * 100 <= 0;
    if (killed) {
      this.predictKill(u.id, XP.UFO_DESTROY, "ufo", u.x, u.y, now);
    }
    if (pass.sparksOk || killed) {
      this.hitSparks(b, contact, impactAngle);
    }
    sfx.play("hit_spark", { gain: 0.4 });
    this.intents.ufoHit(b.weapon.power);
  }
}
