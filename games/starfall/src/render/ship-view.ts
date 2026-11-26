import { BlendModes, Math as PhaserMath } from "phaser";
import type Phaser from "phaser";
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
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import { DEG } from "../sys/geometry";
import type { Progression } from "../sys/progression";
import type { RemoteFire } from "../sys/remote-fire";
import { TESLA_TINT } from "../sys/shield";
import type { Shield } from "../sys/shield";
import { SENTRY_WEAPON } from "../sys/volley";
import { twinAngle } from "../sys/weapons";
import type { Weapons } from "../sys/weapons";
import { PARTICLE_SOFT_BUDGET } from "./fx-pool";
import type { FxPool } from "./fx-pool";
import type { Layers } from "./layers";
import { cssToInt, weaponTint } from "./tint";
import type { TraumaCamera } from "./trauma-camera";
import {
  shipAlpha,
  shipHullPoints,
  shipScaleForLevel,
  strokeClosed,
  strokeRegularPolygon,
} from "./vector-shapes";
import type { WorldView } from "./world-view";

export interface ShipObjs {
  gfx: Phaser.GameObjects.Graphics;
  tint: number;
  /** Level the hull was last built for; rebuild on change (ships grow per level). */
  level: number;
  alive: boolean;
  /** False until the first state lands: a ship that was already dead when
   *  first seen gets no death burst. */
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

/** Authored thruster-puff size (see WorldView.hullGlow for the one thing that
 *  ever scales it down). */
export const TRAIL_PARTICLE_SCALE = 0.5;

/** Thruster emitter cadence (ms): NITRO doubles the rate; throttled halves it. */
export const trailFrequency = (nitro: boolean, throttled: boolean) => {
  if (nitro) {
    return throttled ? 24 : 12;
  }

  return throttled ? 50 : 25;
};

/** Trail = thruster puffs, or the NITRO flame (others must see it). */
export const configureTrail = (rec: ShipObjs, nitro: boolean, throttled: boolean, glow = 1) => {
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

export interface ShipViewDeps {
  scene: Phaser.Scene;
  pilot: Pilot;
  link: Link;
  fx: FxPool;
  layers: Layers;
  trauma: TraumaCamera;
  view: WorldView;
  shield: Shield;
  weapons: Weapons;
  progress: Progression;
  remoteFire: RemoteFire;
}

/** Ship rendering for me and every remote: hull graphics per level, thruster trails, shield ring/halo, impact arcs, and the twin/windup/tesla/sentry decor. */
export class ShipView {
  ships = new Map<string, ShipObjs>();

  private remoteTrailCount = 0;

  private readonly scene: Phaser.Scene;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly fx: FxPool;

  private readonly layers: Layers;

  private readonly trauma: TraumaCamera;

  private readonly view: WorldView;

  private readonly shield: Shield;

  private readonly weapons: Weapons;

  private readonly progress: Progression;

  private readonly remoteFire: RemoteFire;

  constructor(deps: ShipViewDeps) {
    this.scene = deps.scene;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.fx = deps.fx;
    this.layers = deps.layers;
    this.trauma = deps.trauma;
    this.view = deps.view;
    this.shield = deps.shield;
    this.weapons = deps.weapons;
    this.progress = deps.progress;
    this.remoteFire = deps.remoteFire;
  }

  private makeTrailEmitter(tint: number) {
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

  syncShips(now: number) {
    const throttled = this.fx.aliveParticles() > PARTICLE_SOFT_BUDGET;
    const seen = new Set<string>();
    const { myId } = this.link;
    this.layers.haloGfx.clear();

    for (const [id, player] of Object.entries(this.link.peers)) {
      seen.add(id);
      const rec = this.shipRec(id, player.color);

      if (id === myId) {
        this.syncMyShip(rec, throttled, now);
      } else {
        this.syncRemoteShip(id, rec, throttled, now);
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

  private shipRec(id: string, color: string | undefined) {
    const existing = this.ships.get(id);

    if (existing) {
      return existing;
    }

    const tint = cssToInt(color);
    let trail: Phaser.GameObjects.Particles.ParticleEmitter | null = null;

    if (id === this.link.myId) {
      trail = this.makeTrailEmitter(tint);
    } else if (this.remoteTrailCount < 8) {
      trail = this.makeTrailEmitter(tint);
      this.remoteTrailCount += 1;
    }

    const lvl0 = id === this.link.myId ? this.progress.level : 1;

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

  private syncMyShip(rec: ShipObjs, throttled: boolean, now: number) {
    this.ensureShipLevel(rec, this.progress.level);
    configureTrail(rec, this.pilot.boosts.has("nitro"), throttled, this.view.hullGlow());
    rec.gfx.setPosition(this.pilot.shipX, this.pilot.shipY).setRotation(this.pilot.shipAngle);
    rec.gfx.setVisible(this.pilot.spawned && this.pilot.alive);
    const phased = now < this.shield.phasedUntil;
    rec.gfx.setAlpha(shipAlpha(phased, now < this.pilot.invulnUntil, now));
    rec.alive = this.pilot.alive;

    if (rec.trail) {
      rec.trail.emitting = this.pilot.alive && this.pilot.spawned && this.pilot.thrust > 0.3;
      rec.trail.setPosition(
        this.pilot.shipX - Math.cos(this.pilot.shipAngle) * 10,
        this.pilot.shipY - Math.sin(this.pilot.shipAngle) * 10,
      );
    }

    if (this.pilot.alive && this.pilot.spawned) {
      this.drawMyShipDecor(now);
    }

    if (this.weapons.sentry && now < this.weapons.sentry.until) {
      this.drawSentry(this.weapons.sentry.x, this.weapons.sentry.y, this.weapons.sentry.until, now);
    }
  }

  private drawMyShipDecor(now: number) {
    this.drawShield(
      this.pilot.shipX,
      this.pilot.shipY,
      this.pilot.shipAngle,
      this.shield.shieldHp,
      this.shield.overHp,
      this.shield.shieldModNetState(now),
      now,
      {
        flash: now < this.shield.haloFlashUntil,
        regen: this.shield.regenActive || now < this.shield.repairSweepUntil,
        siphonPulse: now < this.shield.siphonPulseUntil,
      },
    );
    this.drawImpactArcs(now);

    if (now < this.pilot.invulnUntil && !this.link.trailer) {
      const remaining = PhaserMath.Clamp((this.pilot.invulnUntil - now) / INVULNERABLE_MS, 0, 1);
      this.layers.haloGfx.lineStyle(1.5, 0x7d_d3_fc, 0.8).beginPath();
      this.layers.haloGfx.arc(
        this.pilot.shipX,
        this.pilot.shipY,
        SHIELD_RING_RADIUS + 6,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * remaining,
      );
      this.layers.haloGfx.strokePath();
    }

    if (this.pilot.boosts.has("twin")) {
      this.drawTwinDrone(this.pilot.shipX, this.pilot.shipY, twinAngle());
    }

    this.drawWindupGlow(
      this.pilot.shipX,
      this.pilot.shipY,
      this.pilot.shipAngle,
      this.weapons.windupFrac(),
      this.pilot.weapon.tint,
    );

    if (this.weapons.teslaActive(now)) {
      this.drawTeslaAura(this.pilot.shipX, this.pilot.shipY, now);
    }
  }

  private syncRemoteShip(id: string, rec: ShipObjs, throttled: boolean, now: number) {
    const st = this.link.peerStates.get(id) ?? null;

    if (!st || !st.present) {
      rec.gfx.setVisible(false);

      if (rec.trail) {
        rec.trail.emitting = false;
      }

      if (st) {
        rec.alive = false;
      } else {
        rec.seenState = false;
      }

      return;
    }

    this.ensureShipLevel(rec, st.level);

    if (!rec.seenState) {
      rec.seenState = true;
      rec.alive = st.alive;
      rec.lastShieldHp = st.shieldHp;
    }

    if (rec.alive && !st.alive) {
      this.fx.battle.burst(rec.gfx.x, rec.gfx.y, 95, rec.tint, "death", st.angle);
      this.view.splinterBurst(rec.gfx.x, rec.gfx.y, 50, 30, now);
      this.fx.shatter(rec.gfx.x, rec.gfx.y, shipHullPoints(), st.angle, rec.tint);
      this.fx.ring(rec.gfx.x, rec.gfx.y, 10, 90, 400, 0xff_ff_ff, 0.7);

      if (this.view.onScreen(rec.gfx.x, rec.gfx.y)) {
        this.trauma.add(0.2);
      }
    }

    if (!rec.alive && st.alive) {
      rec.lastShieldHp = st.shieldHp;
    }

    rec.alive = st.alive;
    rec.gfx.setVisible(st.alive);

    if (st.alive) {
      rec.gfx.setPosition(st.x, st.y).setRotation(st.angle);
      rec.gfx.setAlpha(shipAlpha(st.shieldMod?.phased === true, st.invuln, now));
      this.drawRemoteShipDecor(id, rec, st, now);
    }

    configureTrail(rec, st.alive && st.nitro, throttled);

    if (rec.trail) {
      rec.trail.emitting = st.alive && Math.hypot(st.vx, st.vy) > 100;
      rec.trail.setPosition(
        rec.gfx.x - Math.cos(st.angle) * 10,
        rec.gfx.y - Math.sin(st.angle) * 10,
      );
    }
  }

  private drawRemoteShipDecor(id: string, rec: ShipObjs, st: PlayerNetState, now: number) {
    if (st.shieldHp < rec.lastShieldHp) {
      rec.flashUntil = now + 80;
      this.fx.sparks(rec.gfx.x, rec.gfx.y, 6, SHIELD_RING_TINT, {
        lifeMax: 250,
        lifeMin: 150,
      });
    } else if (st.shieldHp > rec.lastShieldHp) {
      rec.regenUntil = now + 250;
    }

    rec.lastShieldHp = st.shieldHp;
    this.drawShield(rec.gfx.x, rec.gfx.y, st.angle, st.shieldHp, st.overHp, st.shieldMod, now, {
      flash: now < rec.flashUntil,
      regen: now < rec.regenUntil,
      siphonPulse: false,
    });

    if (st.twin) {
      this.drawTwinDrone(rec.gfx.x, rec.gfx.y, (now / 1000) * TWIN_ORBIT_DEG_PER_S * DEG);
    }

    this.drawWindupGlow(rec.gfx.x, rec.gfx.y, st.angle, st.windup, weaponTint(st.weaponName));

    if (st.tesla) {
      this.drawTeslaAura(rec.gfx.x, rec.gfx.y, now);
    }

    const turret = this.remoteFire.turretOf(id);

    if (turret) {
      this.drawSentry(turret.x, turret.y, now + turret.leftMs, now);
    }
  }

  private drawShieldRing(
    x: number,
    y: number,
    angle: number,
    shieldHp: number,
    frac: number,
    now: number,
    opts: { flash: boolean; regen: boolean },
  ) {
    const g = this.layers.haloGfx;
    let alpha = 0.15 + 0.45 * frac + (opts.regen ? 0.15 : 0);

    if (frac < SHIELD_LOW_FRACTION) {
      alpha = 0.45 + 0.25 * Math.sin((now / 1000) * Math.PI * 2 * 6);
    }

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

  private drawShield(
    x: number,
    y: number,
    angle: number,
    shieldHp: number,
    overHp: number,
    mod: ShieldModNetState | null,
    now: number,
    opts: { flash: boolean; regen: boolean; siphonPulse: boolean },
  ) {
    const g = this.layers.haloGfx;
    const frac = Math.max(0, Math.min(1, shieldHp / SHIELD_MAX));

    if (frac > 0) {
      this.drawShieldRing(x, y, angle, shieldHp, frac, now, opts);
    }

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

    this.drawShieldMod(x, y, angle, mod, now, opts);
  }

  private drawShieldMod(
    x: number,
    y: number,
    angle: number,
    mod: ShieldModNetState,
    now: number,
    opts: { regen: boolean; siphonPulse: boolean },
  ) {
    const g = this.layers.haloGfx;
    const { tint } = SHIELD_MOD_SPECS[mod.kind];

    switch (mod.kind) {
      case "overshield": {
        return;
      }

      case "reflect": {
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

      case "bulwark":
      case "leech": {
        break;
      }

      default: {
        const unhandled: never = mod.kind;
        throw new Error("unhandled case", { cause: unhandled });
      }
    }
  }

  private drawImpactArcs(now: number) {
    this.shield.impactArcs = this.shield.impactArcs.filter((ia) => now < ia.diesAt);
    const g = this.layers.haloGfx;

    for (const ia of this.shield.impactArcs) {
      const alpha = Math.max(0, (ia.diesAt - now) / 150);
      g.lineStyle(2, 0xff_ff_ff, alpha);
      g.beginPath();
      g.arc(
        this.pilot.shipX,
        this.pilot.shipY,
        SHIELD_RING_RADIUS,
        ia.angle - 30 * DEG,
        ia.angle + 30 * DEG,
      );
      g.strokePath();
    }
  }

  private drawTwinDrone(cx: number, cy: number, orbitAngle: number) {
    const g = this.layers.haloGfx;
    const x = cx + Math.cos(orbitAngle) * TWIN_ORBIT_RADIUS;
    const y = cy + Math.sin(orbitAngle) * TWIN_ORBIT_RADIUS;
    g.lineStyle(1, BOOSTER_SPECS.twin.tint, 0.9);
    strokeRegularPolygon(g, x, y, 3, 3, orbitAngle);
  }

  private drawWindupGlow(x: number, y: number, angle: number, frac: number, tint: number) {
    if (frac <= 0.02) {
      return;
    }

    const g = this.layers.haloGfx;
    g.fillStyle(tint, 0.35 + 0.45 * frac);
    g.fillCircle(
      x + Math.cos(angle) * (SHIP_RADIUS + 2),
      y + Math.sin(angle) * (SHIP_RADIUS + 2),
      6 * frac * this.view.hullGlow(),
    );
  }

  private drawTeslaAura(x: number, y: number, now: number) {
    const g = this.layers.haloGfx;
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

  private drawSentry(x: number, y: number, until: number, now: number) {
    const left = until - now;

    if (left <= 0) {
      return;
    }

    const g = this.layers.haloGfx;
    const alpha = 0.9 * Math.min(1, left / 2000);
    g.lineStyle(1, SENTRY_WEAPON.tint, alpha);
    g.lineBetween(x - 4, y + 8, x + 4, y + 8);
    g.lineBetween(x, y + 8, x, y + 2);
    strokeRegularPolygon(g, x, y - 2, 4.5, 3, (now / 1000) * 60 * DEG);
  }

  makeShipGfx(tint: number, level = 1) {
    const g = this.scene.add.graphics().setDepth(10);
    const L = Math.max(1, Math.min(LEVEL_CAP, Math.round(level)));
    const s = shipScaleForLevel(L);
    const sw = this.view.strokeScale();
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
      g.lineBetween(-2 * s, -3 * s, -9 * s, -7 * s);
      g.lineBetween(-2 * s, 3 * s, -9 * s, 7 * s);
      g.fillStyle(tint, 0.9).fillCircle(2 * s, 0, 1.4 * s);
    }

    if (L >= 3) {
      g.lineStyle(sw, tint, 0.4);
      strokeClosed(
        g,
        shipHullPoints(L).map((p) => ({ x: p.x * 0.55, y: p.y * 0.55 })),
      );
      g.lineStyle(sw, tint, 1);
      g.lineBetween(SHIP_RADIUS * s, 0, (SHIP_RADIUS + 4) * s, 0);
      g.fillStyle(0xff_ff_ff, 0.9);
      g.fillCircle(-9 * s, -7 * s, 1.2 * s);
      g.fillCircle(-9 * s, 7 * s, 1.2 * s);
    }

    return g;
  }

  private ensureShipLevel(rec: ShipObjs, level: number) {
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
