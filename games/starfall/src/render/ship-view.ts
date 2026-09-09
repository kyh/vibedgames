import type Phaser from "phaser";
import { BlendModes, Math as PhaserMath } from "phaser";
import type { GameScene } from "../scenes/game-scene";
import {
  BOOSTER_SPECS,
  INVULNERABLE_MS,
  LEVEL_CAP,
  OVERSHIELD_BONUS,
  SHIELD_HALO_RADIUS,
  SHIELD_LOW_FRACTION,
  SHIELD_MAX,
  SHIELD_MOD_SPECS,
  SHIELD_RING_RADIUS,
  SHIELD_RING_TINT,
  SHIP_RADIUS,
  TWIN_ORBIT_DEG_PER_S,
  TWIN_ORBIT_RADIUS,
} from "../shared/constants";
import type { PlayerNetState, ShieldModNetState } from "../shared/constants";
import { DEG } from "../sys/geometry";
import { TESLA_TINT } from "../sys/shield";
import { SENTRY_WEAPON, twinAngle } from "../sys/weapons";
import { PARTICLE_SOFT_BUDGET } from "./fx-pool";
import { cssToInt, weaponTint } from "./tint";
import {
  shipAlpha,
  shipHullPoints,
  shipScaleForLevel,
  strokeClosed,
  strokeRegularPolygon,
} from "./vector-shapes";

type ShipViewScene = Pick<
  GameScene,
  | "add"
  | "alive"
  | "boosts"
  | "cameras"
  | "fx"
  | "haloGfx"
  | "invulnUntil"
  | "myId"
  | "peerStates"
  | "peers"
  | "progress"
  | "shield"
  | "shipAngle"
  | "shipX"
  | "shipY"
  | "spawned"
  | "thrust"
  | "trailer"
  | "trauma"
  | "view"
  | "weapon"
  | "weapons"
>;

export interface ShipObjs {
  gfx: Phaser.GameObjects.Graphics;
  tint: number;
  /** Level the hull was last built for; rebuild on change (ships grow per level). */
  level: number;
  alive: boolean;
  /** False until the first state snapshot lands (remote ships snap, not glide). */
  seenState: boolean;
  /** Thruster trail emitter (null when over the remote-trail cap). */
  trail: Phaser.GameObjects.Particles.ParticleEmitter | null;
  /** Trail currently configured as the NITRO flame. */
  nitroTrail: boolean;
  /** Trail particle scale currently loaded into the emitter config. Only the
   *  trailer's hull-glow damping ever moves it off TRAIL_PARTICLE_SCALE, and
   *  it is tracked so the per-frame reconfigure is skipped when it has not. */
  trailScale: number;
  /** Last seen base shieldHp — a decrease between snapshots = hit flash.
   *  Base shield only: overHp zeroes on overshield expiry/replacement with
   *  no damage, so a combined total would phantom-flash. */
  lastShieldHp: number;
  /** Ring hit-flash window. */
  flashUntil: number;
  /** Ring regen visual window (an increase between snapshots opens it). */
  regenUntil: number;
}

/** Authored thruster-puff size (see GameScene.hullGlow for the one thing that
 *  ever scales it down). */
export const TRAIL_PARTICLE_SCALE = 0.5;

/** Thruster emitter cadence (ms): NITRO doubles the rate; throttled halves it. */
export const trailFrequency = (nitro: boolean, throttled: boolean): number => {
  if (nitro) {
    return throttled ? 24 : 12;
  }
  return throttled ? 50 : 25;
};

/** Trail = thruster puffs, or the NITRO flame (others must see it). */
export const configureTrail = (
  rec: ShipObjs,
  nitro: boolean,
  throttled: boolean,
  glow = 1,
): void => {
  if (!rec.trail) {
    return;
  }
  const scale = TRAIL_PARTICLE_SCALE * glow;
  if (rec.nitroTrail !== nitro || rec.trailScale !== scale) {
    rec.nitroTrail = nitro;
    rec.trailScale = scale;
    rec.trail.updateConfig({
      lifespan: nitro ? 450 : 300,
      scale: { end: 0, start: scale },
      tint: nitro ? BOOSTER_SPECS.nitro.tint : rec.tint,
    });
  }
  const freq = trailFrequency(nitro, throttled);
  if (rec.trail.frequency !== freq) {
    rec.trail.setFrequency(freq);
  }
};

/** Ship rendering for me and every remote: hull graphics per level, thruster trails, shield ring/halo, impact arcs, and the twin/windup/tesla/sentry decor. */
export class ShipView {
  // display caches
  ships = new Map<string, ShipObjs>();

  private remoteTrailCount = 0;

  private readonly scene: ShipViewScene;

  constructor(scene: ShipViewScene) {
    this.scene = scene;
  }

  private makeTrailEmitter(tint: number): Phaser.GameObjects.Particles.ParticleEmitter {
    const e = this.scene.add.particles(0, 0, "spark", {
      alpha: { end: 0, start: 0.7 },
      blendMode: BlendModes.ADD,
      emitting: false,
      frequency: 25,
      lifespan: 300,
      scale: { end: 0, start: TRAIL_PARTICLE_SCALE },
      speed: { max: 20, min: 0 },
      tint,
    });
    e.setDepth(9);
    return e;
  }

  /**
   * TRAILER ONLY: how much of its authored size the pilot's own additive glow
   * keeps at this shot's zoom.
   *
   * The hull is a 1px vector stroke ~16 world px across; the glow around it —
   * thruster puffs, muzzle sparks, the shield-impact burst — is the 32px soft
   * "spark" dot on ADD. Both are world-space, so both scale with the camera,
   * but only one of them GROWS: a stroked outline gains no ink when it is
   * magnified, while a soft additive dot gains area (and therefore saturates)
   * as the square of the zoom. At the reel's 1.9-2.5 zooms that inverted the
   * shot — measured on the last capture, the player read as a formless white
   * splat in calm-open, elite-behaviours, chain-reactor and pvp-duel while the
   * ENEMIES, which are pure stroke, read cleanly. The hero was the least
   * legible object in its own tight shots.
   *
   * So inside ?trailer=1 the glow is pinned to the SCREEN size it has at zoom
   * 1 (the framing the game itself ships) and the hull is the only thing the
   * tightening magnifies. Clamped at 1 so it can only ever damp — a shot below
   * zoom 1 would be wider than normal play, which the framing contract forbids
   * anyway. Outside trailer mode this is a constant 1 and every call site is
   * unchanged arithmetic.
   */
  hullGlow(): number {
    if (!this.scene.trailer) {
      return 1;
    }
    // Quantised: three scenes lerp their zoom, and the trail's scale lives in
    // the emitter CONFIG — re-parsing it every frame to chase a continuous
    // ramp buys nothing the eye can see.
    return Math.min(1, Math.round(20 / this.scene.cameras.main.zoom) / 20);
  }

  syncShips(now: number, dt: number): void {
    // Time-based smoothing (~0.35/frame at 60fps) so remote-ship glide speed
    // is refresh-rate independent.
    const blend = 1 - Math.exp(-25 * dt);
    // Over the soft particle budget: trails throttle ×2 (vfx skill rule).
    const throttled = this.scene.fx.aliveParticles() > PARTICLE_SOFT_BUDGET;
    const seen = new Set<string>();
    const { myId } = this.scene;
    this.scene.haloGfx.clear();
    for (const [id, player] of Object.entries(this.scene.peers)) {
      seen.add(id);
      const rec = this.shipRec(id, player.color);
      if (id === myId) {
        this.syncMyShip(rec, throttled, now);
      } else {
        this.syncRemoteShip(id, rec, blend, throttled, now);
      }
    }
    for (const [id, rec] of this.ships) {
      if (!seen.has(id)) {
        rec.gfx.destroy();
        if (rec.trail) {
          rec.trail.destroy();
          if (id !== myId) {
            this.remoteTrailCount = Math.max(0, this.remoteTrailCount - 1);
          }
        }
        this.ships.delete(id);
      }
    }
  }

  /** The render record for a ship, built on first sight (remote trails are
   *  capped; the pilot always gets one). */
  private shipRec(id: string, color: string | undefined): ShipObjs {
    const existing = this.ships.get(id);
    if (existing) {
      return existing;
    }
    const tint = cssToInt(color);
    let trail: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
    if (id === this.scene.myId) {
      trail = this.makeTrailEmitter(tint);
    } else if (this.remoteTrailCount < 8) {
      trail = this.makeTrailEmitter(tint);
      this.remoteTrailCount += 1;
    }
    const lvl0 = id === this.scene.myId ? this.scene.progress.level : 1;
    const rec: ShipObjs = {
      alive: true,
      flashUntil: 0,
      gfx: this.makeShipGfx(tint, lvl0),
      lastShieldHp: SHIELD_MAX,
      level: lvl0,
      nitroTrail: false,
      regenUntil: 0,
      seenState: false,
      tint,
      trail,
      trailScale: TRAIL_PARTICLE_SCALE,
    };
    this.ships.set(id, rec);
    return rec;
  }

  private syncMyShip(rec: ShipObjs, throttled: boolean, now: number): void {
    this.ensureShipLevel(rec, this.scene.progress.level);
    // Only the PILOT's glow is damped: the reel's tight shots need the
    // contrast between a hull that grew and a glow that did not, and the
    // enemies (pure stroke) never had the problem in the first place.
    configureTrail(rec, this.scene.boosts.has("nitro"), throttled, this.hullGlow());
    rec.gfx.setPosition(this.scene.shipX, this.scene.shipY).setRotation(this.scene.shipAngle);
    rec.gfx.setVisible(this.scene.spawned && this.scene.alive);
    const phased = now < this.scene.shield.phasedUntil;
    rec.gfx.setAlpha(shipAlpha(phased, now < this.scene.invulnUntil, now));
    rec.alive = this.scene.alive;
    if (rec.trail) {
      rec.trail.emitting = this.scene.alive && this.scene.spawned && this.scene.thrust > 0.3;
      rec.trail.setPosition(
        this.scene.shipX - Math.cos(this.scene.shipAngle) * 10,
        this.scene.shipY - Math.sin(this.scene.shipAngle) * 10,
      );
    }
    if (this.scene.alive && this.scene.spawned) {
      this.drawMyShipDecor(now);
    }
    if (this.scene.weapons.sentry && now < this.scene.weapons.sentry.until) {
      this.drawSentry(
        this.scene.weapons.sentry.x,
        this.scene.weapons.sentry.y,
        this.scene.weapons.sentry.until,
        now,
      );
    }
  }

  /** Shield stack, impact arcs, spawn-protection arc, TWIN drone, windup
   *  glow and TESLA aura around the pilot's hull. */
  private drawMyShipDecor(now: number): void {
    this.drawShield(
      this.scene.shipX,
      this.scene.shipY,
      this.scene.shipAngle,
      this.scene.shield.shieldHp,
      this.scene.shield.overHp,
      this.scene.shield.shieldModNetState(now),
      now,
      {
        flash: now < this.scene.shield.haloFlashUntil,
        regen: this.scene.shield.regenActive || now < this.scene.shield.repairSweepUntil,
        siphonPulse: now < this.scene.shield.siphonPulseUntil,
      },
    );
    this.drawImpactArcs(now);
    if (now < this.scene.invulnUntil && !this.scene.trailer) {
      // The existing two-second protection, drawn outside the shield.
      const remaining = PhaserMath.Clamp((this.scene.invulnUntil - now) / INVULNERABLE_MS, 0, 1);
      this.scene.haloGfx.lineStyle(1.5, 0x7d_d3_fc, 0.8).beginPath();
      this.scene.haloGfx.arc(
        this.scene.shipX,
        this.scene.shipY,
        SHIELD_RING_RADIUS + 6,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * remaining,
      );
      this.scene.haloGfx.strokePath();
    }
    if (this.scene.boosts.has("twin")) {
      this.drawTwinDrone(this.scene.shipX, this.scene.shipY, twinAngle());
    }
    this.drawWindupGlow(
      this.scene.shipX,
      this.scene.shipY,
      this.scene.shipAngle,
      this.scene.weapons.windupFrac(),
      this.scene.weapon.tint,
    );
    if (this.scene.weapons.teslaActive(now)) {
      this.drawTeslaAura(this.scene.shipX, this.scene.shipY, now);
    }
  }

  private syncRemoteShip(
    id: string,
    rec: ShipObjs,
    blend: number,
    throttled: boolean,
    now: number,
  ): void {
    const st = this.scene.peerStates.get(id) ?? null;
    if (!st) {
      rec.gfx.setVisible(false);
      if (rec.trail) {
        rec.trail.emitting = false;
      }
      return;
    }
    if (!st.present) {
      // Cleanly docked out (paused-as-spectator): hide with NO death FX, and
      // clear rec.alive so re-entry snaps in fresh rather than gliding from a
      // stale spot or firing a spurious death burst.
      rec.gfx.setVisible(false);
      if (rec.trail) {
        rec.trail.emitting = false;
      }
      rec.alive = false;
      return;
    }
    // remotes grow with their level too
    this.ensureShipLevel(rec, st.level);
    if (!rec.seenState) {
      // First snapshot: snap into place (no glide from the origin) and adopt
      // alive as-is (no death FX for players who were already dead).
      rec.seenState = true;
      rec.alive = st.alive;
      rec.gfx.setPosition(st.x, st.y);
      rec.lastShieldHp = st.shieldHp;
    }
    if (rec.alive && !st.alive) {
      this.scene.fx.battle.burst(rec.gfx.x, rec.gfx.y, 95, rec.tint, "death", st.angle);
      this.scene.view.splinterBurst(rec.gfx.x, rec.gfx.y, 50, 30, now);
      this.scene.fx.shatter(rec.gfx.x, rec.gfx.y, shipHullPoints(), st.angle, rec.tint);
      this.scene.fx.ring(rec.gfx.x, rec.gfx.y, 10, 90, 400, 0xff_ff_ff, 0.7);
      if (this.scene.view.onScreen(rec.gfx.x, rec.gfx.y)) {
        this.scene.trauma.add(0.2);
      }
    }
    // respawn: snap, don't glide
    if (!rec.alive && st.alive) {
      rec.gfx.setPosition(st.x, st.y);
    }
    rec.alive = st.alive;
    rec.gfx.setVisible(st.alive);
    if (st.alive) {
      rec.gfx.setPosition(
        PhaserMath.Linear(rec.gfx.x, st.x, blend),
        PhaserMath.Linear(rec.gfx.y, st.y, blend),
      );
      rec.gfx.setRotation(st.angle);
      // networked invuln/phase
      rec.gfx.setAlpha(shipAlpha(st.shieldMod?.phased === true, st.invuln, now));
      this.drawRemoteShipDecor(rec, st, now);
    }
    const nitro = st.alive && st.boosts.some((b) => b.kind === "nitro" && b.until > now);
    configureTrail(rec, nitro, throttled);
    if (rec.trail) {
      // Remote thrust isn't on the wire — speed from vx,vy is the proxy.
      rec.trail.emitting = st.alive && Math.hypot(st.vx, st.vy) > 100;
      rec.trail.setPosition(
        rec.gfx.x - Math.cos(st.angle) * 10,
        rec.gfx.y - Math.sin(st.angle) * 10,
      );
    }
  }

  /** Shield stack (with drain flash / regen inferred between snapshots),
   *  TWIN drone, windup glow, TESLA aura and sentry for a living remote. */
  private drawRemoteShipDecor(rec: ShipObjs, st: PlayerNetState, now: number): void {
    // Drains are visible as shieldHp drops between snapshots: flash + sparks.
    if (st.shieldHp < rec.lastShieldHp) {
      rec.flashUntil = now + 80;
      this.scene.fx.sparks(rec.gfx.x, rec.gfx.y, 6, SHIELD_RING_TINT, {
        lifeMax: 250,
        lifeMin: 150,
      });
    } else if (st.shieldHp > rec.lastShieldHp) {
      // infer regen from increases
      rec.regenUntil = now + 250;
    }
    rec.lastShieldHp = st.shieldHp;
    this.drawShield(rec.gfx.x, rec.gfx.y, st.angle, st.shieldHp, st.overHp, st.shieldMod, now, {
      flash: now < rec.flashUntil,
      regen: now < rec.regenUntil,
      siphonPulse: false,
    });
    if (st.boosts.some((b) => b.kind === "twin" && b.until > now)) {
      this.drawTwinDrone(rec.gfx.x, rec.gfx.y, (now / 1000) * TWIN_ORBIT_DEG_PER_S * DEG);
    }
    this.drawWindupGlow(rec.gfx.x, rec.gfx.y, st.angle, st.windup, weaponTint(st.weaponName));
    if (st.tesla) {
      this.drawTeslaAura(rec.gfx.x, rec.gfx.y, now);
    }
    if (st.sentry && now < st.sentry.until) {
      this.drawSentry(st.sentry.x, st.sentry.y, st.sentry.until, now);
    }
  }

  /** Base ring: completeness = shield fraction; the gap in the arc IS the
   *  health bar. Low shield pulses, flashes go white, regen rides bright
   *  head dots on the re-closing tips. */
  private drawShieldRing(
    x: number,
    y: number,
    angle: number,
    shieldHp: number,
    frac: number,
    now: number,
    opts: { flash: boolean; regen: boolean },
  ): void {
    const g = this.scene.haloGfx;
    let alpha = 0.15 + 0.45 * frac + (opts.regen ? 0.15 : 0);
    if (frac < SHIELD_LOW_FRACTION) {
      // Low shield: pulse 0.2↔0.7 at 6Hz.
      alpha = 0.45 + 0.25 * Math.sin((now / 1000) * Math.PI * 2 * 6);
    }
    // SIPHON overheal banked above 100: the closed ring glows brighter.
    if (shieldHp > SHIELD_MAX) {
      alpha += 0.1;
    }
    if (opts.flash) {
      alpha = 1;
    }
    g.lineStyle(1, SHIELD_RING_TINT, Math.min(1, alpha));
    const sweep = Math.PI * 2 * frac;
    g.beginPath();
    g.arc(x, y, SHIELD_RING_RADIUS, angle - sweep / 2, angle + sweep / 2);
    g.strokePath();
    if (opts.regen && frac < 1) {
      g.fillStyle(0xff_ff_ff, 0.95);
      g.fillCircle(
        x + Math.cos(angle - sweep / 2) * SHIELD_RING_RADIUS,
        y + Math.sin(angle - sweep / 2) * SHIELD_RING_RADIUS,
        1.5,
      );
      g.fillCircle(
        x + Math.cos(angle + sweep / 2) * SHIELD_RING_RADIUS,
        y + Math.sin(angle + sweep / 2) * SHIELD_RING_RADIUS,
        1.5,
      );
    }
  }

  /**
   * The v2 shield stack on the additive layer (1px strokes): base ring at
   * r=12 whose ARC SWEEP is the health bar, the OVERSHIELD hex, then the mod
   * halo at r=15.
   */
  private drawShield(
    x: number,
    y: number,
    angle: number,
    shieldHp: number,
    overHp: number,
    mod: ShieldModNetState | null,
    now: number,
    opts: { flash: boolean; regen: boolean; siphonPulse: boolean },
  ): void {
    const g = this.scene.haloGfx;
    const frac = Math.max(0, Math.min(1, shieldHp / SHIELD_MAX));
    if (frac > 0) {
      this.drawShieldRing(x, y, angle, shieldHp, frac, now, opts);
    }
    // OVERSHIELD bonus layer: Halo hexagon, fading with the remaining bonus.
    if (overHp > 0) {
      g.lineStyle(
        1,
        SHIELD_MOD_SPECS.overshield.tint,
        0.8 * Math.min(1, overHp / OVERSHIELD_BONUS),
      );
      strokeRegularPolygon(g, x, y, SHIELD_HALO_RADIUS, 6, 0);
    }
    if (!mod) {
      return;
    }
    const { tint } = SHIELD_MOD_SPECS[mod.kind];
    switch (mod.kind) {
      case "overshield": {
        // the hexagon above IS the halo
        return;
      }
      case "reflect": {
        // dim = arm down (≤40)
        g.lineStyle(1, tint, mod.active ? 0.85 : 0.25);
        strokeRegularPolygon(
          g,
          x,
          y,
          SHIELD_HALO_RADIUS,
          3,
          ((now / 1000) * 90 * DEG) % (Math.PI * 2),
        );
        return;
      }
      case "ram": {
        // bright when armed
        g.lineStyle(1, tint, mod.active ? 0.9 : 0.35);
        g.beginPath();
        g.arc(x, y, SHIELD_HALO_RADIUS, angle - Math.PI / 4, angle + Math.PI / 4);
        g.strokePath();
        return;
      }
      case "phase": {
        let alpha = 0.2;
        if (mod.phased) {
          alpha = 0.25;
        } else if (mod.active) {
          alpha = 0.7;
        }
        g.lineStyle(1, tint, alpha);
        const rot = (now / 1000) * 45 * DEG;
        for (let i = 0; i < 8; i += 1) {
          const a0 = rot + (Math.PI * 2 * i) / 8;
          g.beginPath();
          g.arc(x, y, SHIELD_HALO_RADIUS, a0, a0 + ((Math.PI * 2) / 8) * 0.55);
          g.strokePath();
        }
        return;
      }
      case "siphon": {
        const alpha = opts.siphonPulse ? 0.95 : 0.5;
        g.lineStyle(1, tint, alpha);
        g.strokeCircle(x, y, SHIELD_HALO_RADIUS);
        g.strokeCircle(x, y, SHIELD_HALO_RADIUS + 2);
        return;
      }
      case "aegis": {
        g.lineStyle(1, tint, 0.5);
        g.strokeCircle(x, y, SHIELD_HALO_RADIUS);
        // 4 orbiting dots; spin ×3 + brighten while regen is running.
        const spin = (now / 1000) * TWIN_ORBIT_DEG_PER_S * DEG * (opts.regen ? 3 : 1);
        g.fillStyle(tint, opts.regen ? 1 : 0.7);
        for (let i = 0; i < 4; i += 1) {
          const a0 = spin + (Math.PI * 2 * i) / 4;
          g.fillCircle(
            x + Math.cos(a0) * SHIELD_HALO_RADIUS,
            y + Math.sin(a0) * SHIELD_HALO_RADIUS,
            1,
          );
        }
        break;
      }
      default: {
        // bulwark / leech: no halo beyond the hexagon.
        break;
      }
    }
  }

  /** 60° white impact arcs at the incoming-damage angle, alpha 1→0 / 150ms. */
  private drawImpactArcs(now: number): void {
    this.scene.shield.impactArcs = this.scene.shield.impactArcs.filter((ia) => now < ia.diesAt);
    const g = this.scene.haloGfx;
    for (const ia of this.scene.shield.impactArcs) {
      const alpha = Math.max(0, (ia.diesAt - now) / 150);
      g.lineStyle(2, 0xff_ff_ff, alpha);
      g.beginPath();
      g.arc(
        this.scene.shipX,
        this.scene.shipY,
        SHIELD_RING_RADIUS,
        ia.angle - 30 * DEG,
        ia.angle + 30 * DEG,
      );
      g.strokePath();
    }
  }

  /** TWIN: 3px wireframe drone orbiting at r=28 (remotes drive it from boosts). */
  private drawTwinDrone(cx: number, cy: number, orbitAngle: number): void {
    const g = this.scene.haloGfx;
    const x = cx + Math.cos(orbitAngle) * TWIN_ORBIT_RADIUS;
    const y = cy + Math.sin(orbitAngle) * TWIN_ORBIT_RADIUS;
    g.lineStyle(1, BOOSTER_SPECS.twin.tint, 0.9);
    strokeRegularPolygon(g, x, y, 3, 3, orbitAngle);
  }

  /** RAILGUN charge: nose glow scales 0→6px with the windup fraction. It is a
   *  filled disc rather than a stroke, so it damps with the rest of the pilot's
   *  glow in trailer mode (hullGlow() is 1 everywhere else). */
  private drawWindupGlow(x: number, y: number, angle: number, frac: number, tint: number): void {
    if (frac <= 0.02) {
      return;
    }
    const g = this.scene.haloGfx;
    g.fillStyle(tint, 0.35 + 0.45 * frac);
    g.fillCircle(
      x + Math.cos(angle) * (SHIP_RADIUS + 2),
      y + Math.sin(angle) * (SHIP_RADIUS + 2),
      6 * frac * this.hullGlow(),
    );
  }

  /** TESLA AURA: crackling broken ring (per-frame random arc phases = the
   *  electric flicker), driven locally for the owner and by the serialized
   *  flag for remotes. */
  private drawTeslaAura(x: number, y: number, now: number): void {
    const g = this.scene.haloGfx;
    g.lineStyle(1, TESLA_TINT, 0.7);
    const base = (now / 1000) * 240 * DEG;
    for (let i = 0; i < 5; i += 1) {
      const a0 = base + (Math.PI * 2 * i) / 5 + Math.random() * 0.5;
      const r = SHIELD_HALO_RADIUS + 3 + Math.random() * 2;
      g.beginPath();
      g.arc(x, y, r, a0, a0 + 0.7);
      g.strokePath();
    }
  }

  /** SENTRY turret: amber wireframe triangle-on-post; the head spins slowly
   *  and the whole glyph fades over its last 2s. */
  private drawSentry(x: number, y: number, until: number, now: number): void {
    const left = until - now;
    if (left <= 0) {
      return;
    }
    const g = this.scene.haloGfx;
    const alpha = 0.9 * Math.min(1, left / 2000);
    g.lineStyle(1, SENTRY_WEAPON.tint, alpha);
    // base
    g.lineBetween(x - 4, y + 8, x + 4, y + 8);
    // post
    g.lineBetween(x, y + 8, x, y + 2);
    strokeRegularPolygon(g, x, y - 2, 4.5, 3, (now / 1000) * 60 * DEG);
  }

  makeShipGfx(tint: number, level = 1): Phaser.GameObjects.Graphics {
    const g = this.scene.add.graphics().setDepth(10);
    const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
    const s = shipScaleForLevel(L);
    const sw = this.scene.view.strokeScale();
    const hull = shipHullPoints(L);
    g.fillStyle(0x05_0c_17, 0.94).fillPoints(
      hull.map((p) => new PhaserMath.Vector2(p.x, p.y)),
      true,
    );
    g.lineStyle(sw * 3, 0x05_0c_17, 0.9);
    strokeClosed(g, hull);
    g.lineStyle(sw, tint, 1);
    strokeClosed(g, hull);
    if (L >= 2) {
      // swept wings
      g.lineBetween(-2 * s, -3 * s, -9 * s, -7 * s);
      g.lineBetween(-2 * s, 3 * s, -9 * s, 7 * s);
      // cockpit
      g.fillStyle(tint, 0.9).fillCircle(2 * s, 0, 1.4 * s);
    }
    if (L >= 3) {
      // inner frame
      g.lineStyle(sw, tint, 0.4);
      strokeClosed(
        g,
        shipHullPoints(L).map((p) => ({ x: p.x * 0.55, y: p.y * 0.55 })),
      );
      g.lineStyle(sw, tint, 1);
      // nose spike
      g.lineBetween(SHIP_RADIUS * s, 0, (SHIP_RADIUS + 4) * s, 0);
      g.fillStyle(0xff_ff_ff, 0.9);
      // wingtip nodes
      g.fillCircle(-9 * s, -7 * s, 1.2 * s);
      g.fillCircle(-9 * s, 7 * s, 1.2 * s);
    }
    return g;
  }

  /** Rebuild a ship's hull when its level changes (preserve transform/visibility). */
  private ensureShipLevel(rec: ShipObjs, level: number): void {
    if (rec.level === level) {
      return;
    }
    rec.level = level;
    const { x, y, rotation, alpha, visible } = rec.gfx;
    rec.gfx.destroy();
    rec.gfx = this.makeShipGfx(rec.tint, level);
    rec.gfx.setPosition(x, y).setRotation(rotation).setAlpha(alpha).setVisible(visible);
  }
}
