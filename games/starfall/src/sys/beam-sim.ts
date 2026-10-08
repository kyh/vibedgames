import { Math as PhaserMath } from "phaser";
import { sfx } from "../audio/sfx";
import type { HostIntents } from "../net/intents";
import type { FxPool } from "../render/fx-pool";
import type { TraumaCamera } from "../render/trauma-camera";
import type { WorldView } from "../render/world-view";
import { now as simNow } from "../shared/clock";
import {
  FLAK_FRAG_WEAPON,
  GLAIVE_DECEL_PX,
  GRAVITON_PULL_MS,
  MINE_MAX_LIVE,
  MINE_TRIGGER_RADIUS,
  SHIP_RADIUS,
  SINGULARITY_PULL_MS,
} from "../shared/constants";
import type { SharedState, Vec, Weapon } from "../shared/constants";
import type { Link } from "../state/link";
import type { Pilot } from "../state/pilot";
import { BEAM_CULL_MARGIN, newBeam } from "./beam";
import type { Beam, TargetRef } from "./beam";
import { DEG, dist2, inWorld, rotateToward } from "./geometry";

/** Who fired a set of beams. */
export interface BeamOwner {
  /** The shooter's player id (null before this client has one). */
  readonly id: string | null;
  /** My own beams: the only ones that report to the host (SINGULARITY pulls)
   *  and that shake my camera or play sound. A remote player's are visual. */
  readonly local: boolean;
  /** Where a returning glaive flies home to; null once the shooter is down. */
  hull: () => Vec | null;
}

/** Late-built state the simulation consults. */
export interface BeamSimHooks {
  /** My PHASE intangibility window (Shield is built after the sim). */
  phasedUntil: () => number;
}

export interface BeamSimDeps {
  world: SharedState;
  pilot: Pilot;
  link: Link;
  fx: FxPool;
  trauma: TraumaCamera;
  view: WorldView;
  intents: HostIntents;
  hooks: BeamSimHooks;
}

/**
 * Beam flight for any shooter: straight, homing, ricochet, glaive, flak,
 * mines, explosions and the SINGULARITY collapse. My beams and every remote
 * player's rebuilt beams run through these same functions; each call takes
 * the beam list it works on and `now` on that shooter's clock.
 */
export class BeamSim {
  private readonly world: SharedState;

  private readonly pilot: Pilot;

  private readonly link: Link;

  private readonly fx: FxPool;

  private readonly trauma: TraumaCamera;

  private readonly view: WorldView;

  private readonly intents: HostIntents;

  private readonly hooks: BeamSimHooks;

  constructor(deps: BeamSimDeps) {
    this.world = deps.world;
    this.pilot = deps.pilot;
    this.link = deps.link;
    this.fx = deps.fx;
    this.trauma = deps.trauma;
    this.view = deps.view;
    this.intents = deps.intents;
    this.hooks = deps.hooks;
  }

  /** Advance every live beam by `dt`; returns the list without the vanished
   *  (fresh FLAK fragments are appended to it and fly this same step). */
  step(beams: Beam[], owner: BeamOwner, dt: number, now: number): Beam[] {
    const live = beams.filter((b) => !b.vanished);
    for (const b of live) {
      if (this.updateStationaryBeam(b, owner, dt, now)) {
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
        this.updateGlaive(b, gl, boomerang, owner, dt);
        continue;
      }
      this.updateFlyingBeam(live, b, owner, dt, now);
    }
    return live;
  }

  /** Beams that don't fly this frame: mines, ARC bolts, explosions and the
   *  SINGULARITY collapse. Returns true when the beam was handled. */
  private updateStationaryBeam(b: Beam, owner: BeamOwner, dt: number, now: number): boolean {
    // Mine: stationary until triggered; lifetime expiry detonates it.
    if (b.mine && !b.exploding) {
      if (now >= b.diesAt) {
        this.detonateMine(b, owner);
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
          this.popSingularity(b, owner);
        }
        return true;
      }
      if (b.diesAt > 0 && now >= b.diesAt) {
        this.startCollapse(b, owner, now);
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
    owner: BeamOwner,
    dt: number,
  ): void {
    b.spin += 12 * dt;
    let step: number;
    if (gl.returning) {
      const home = owner.hull();
      if (!home) {
        b.vanished = true;
        return;
      }
      const dx = home.x - b.head.x;
      const dy = home.y - b.head.y;
      if (Math.hypot(dx, dy) < SHIP_RADIUS + 6) {
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
    if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN, this.world.playW, this.world.playH)) {
      b.vanished = true;
    }
  }

  /** Straight / homing / ricochet flight: advance the head, then the tail. */
  private updateFlyingBeam(
    beams: Beam[],
    b: Beam,
    owner: BeamOwner,
    dt: number,
    now: number,
  ): void {
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
      this.burstFlak(beams, b, owner, now);
      return;
    }
    // RICOCHET: bounce off the world edge while bounces remain.
    if (b.bouncesLeft > 0 && !inWorld(b.head.x, b.head.y, 0, this.world.playW, this.world.playH)) {
      this.ricochetEdgeBounce(b);
    }
    if (!inWorld(b.head.x, b.head.y, BEAM_CULL_MARGIN, this.world.playW, this.world.playH)) {
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

  /** A player's position for a lock: my live hull, or a remote ship where it
   *  is drawn. Null when unknown, dead or absent. */
  playerPos(id: string): Vec | null {
    if (id === this.link.myId) {
      return this.pilot.spawned && this.pilot.alive
        ? { x: this.pilot.shipX, y: this.pilot.shipY }
        : null;
    }
    const st = this.link.peerStates.get(id) ?? null;
    return st && st.alive ? { x: st.x, y: st.y } : null;
  }

  /** Current world position of a target ref, or null if it's gone. */
  private resolveTarget(ref: TargetRef): Vec | null {
    switch (ref.kind) {
      case "enemy": {
        const e = this.world.enemies.find((x) => x.id === ref.id);
        return e ? { x: e.x, y: e.y } : null;
      }
      case "player": {
        return this.playerPos(ref.id);
      }
      case "ufo": {
        const u = this.world.ufo;
        return u ? { x: u.x, y: u.y } : null;
      }
      case "asteroid": {
        const a = this.world.asteroids.find((x) => x.id === ref.id);
        return a ? { x: a.x, y: a.y } : null;
      }
      default: {
        return ref satisfies never;
      }
    }
  }

  /** Armed mines trigger on enemy / player / UFO proximity (§C). */
  tickMines(beams: readonly Beam[], owner: BeamOwner, now: number): void {
    for (const b of beams) {
      if (!b.mine || b.exploding || b.vanished || now < b.mine.armAt) {
        continue;
      }
      if (this.mineTriggered(b.head.x, b.head.y, owner)) {
        this.detonateMine(b, owner);
      }
    }
  }

  /** Over the live-mine cap the oldest detonates harmlessly at 30% scale —
   *  run before a new mine joins the list. */
  capMines(beams: readonly Beam[]): void {
    const live = beams.filter((b) => b.mine && !b.exploding && !b.vanished);
    if (live.length < MINE_MAX_LIVE) {
      return;
    }
    const [oldest] = live;
    if (oldest) {
      oldest.vanished = true;
      const range = oldest.weapon.explosion?.range ?? 90;
      this.fx.ring(oldest.head.x, oldest.head.y, 4, range * 0.3, 200, oldest.weapon.tint, 0.4);
    }
  }

  /** Anything hostile inside the trigger radius: enemies, the UFO, or a
   *  targetable player other than the mine's owner (alive, not invulnerable,
   *  not phased). Judged on this client's view, like every victim-side test. */
  private mineTriggered(x: number, y: number, owner: BeamOwner): boolean {
    const r2 = MINE_TRIGGER_RADIUS * MINE_TRIGGER_RADIUS;
    for (const e of this.world.enemies) {
      if (dist2(e.x, e.y, x, y) <= r2) {
        return true;
      }
    }
    const u = this.world.ufo;
    if (u && dist2(u.x, u.y, x, y) <= r2) {
      return true;
    }
    const { myId } = this.link;
    if (!owner.local && this.pilot.alive && this.pilot.spawned) {
      const t = simNow();
      if (
        t >= this.pilot.invulnUntil &&
        t >= this.hooks.phasedUntil() &&
        dist2(this.pilot.shipX, this.pilot.shipY, x, y) <= r2
      ) {
        return true;
      }
    }
    for (const [id, st] of this.link.peerStates) {
      if (id === myId || id === owner.id) {
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
  private detonateMine(b: Beam, owner: BeamOwner): void {
    this.fx.battle.burst(b.head.x, b.head.y, 70, b.weapon.tint, "detonation");
    b.exploding = true;
    b.explosionRadius = 0;
    if (owner.local && this.view.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_heavy", { gain: 0.8, rate: 0.85 });
      this.trauma.add(0.06);
    }
  }

  /** Beam reaction to a hit: explode, airburst, pass through, or vanish. */
  onBeamHit(beams: Beam[], b: Beam, owner: BeamOwner, now: number): void {
    // expanding AoE keeps going; step() expires it at range
    if (b.exploding) {
      return;
    }
    if (b.weapon.flak) {
      // first hit pops the shell early
      this.burstFlak(beams, b, owner, now);
      return;
    }
    if (b.weapon.explosion) {
      this.fx.battle.burst(
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
  private burstFlak(beams: Beam[], b: Beam, owner: BeamOwner, now: number): void {
    const spec = b.weapon.flak;
    if (!spec || b.vanished) {
      return;
    }
    b.vanished = true;
    const ttlMs = (spec.fragRange / FLAK_FRAG_WEAPON.speed) * 1000;
    for (let i = 0; i < spec.fragments; i += 1) {
      const ang = (Math.PI * 2 * i) / spec.fragments;
      const fb = newBeam({ x: b.head.x, y: b.head.y }, ang, FLAK_FRAG_WEAPON, now);
      fb.released = true;
      fb.diesAt = now + ttlMs;
      fb.hitIds = new Set(b.hitIds);
      beams.push(fb);
    }
    this.fx.battle.burst(
      b.head.x,
      b.head.y,
      spec.fragments > 8 ? 95 : 65,
      b.weapon.tint,
      "detonation",
    );
    this.fx.ring(b.head.x, b.head.y, 4, 36, 200, b.weapon.tint, 0.7);
    if (owner.local && this.view.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_scatter", { gain: 0.7, rate: 0.9 });
      this.trauma.add(0.04);
    }
  }

  /** SINGULARITY collapse start (flight range reached or first contact):
   *  freeze the orb. My own collapse also asks the HOST for the one shared
   *  pull, which drags its simulated enemies/asteroids so all clients see the
   *  same motion; a remote player's copy only freezes. */
  startCollapse(b: Beam, owner: BeamOwner, now: number): void {
    if (b.collapseUntil > 0 || b.exploding || b.vanished) {
      return;
    }
    // GRAVITON WELL herds far longer than SINGULARITY.
    const pullMs = b.weapon.name === "GRAVITON WELL" ? GRAVITON_PULL_MS : SINGULARITY_PULL_MS;
    b.collapseUntil = now + pullMs;
    b.diesAt = 0;
    b.tail = { ...b.head };
    if (!owner.local) {
      return;
    }
    this.intents.pull(b.head.x, b.head.y, pullMs);
    if (this.view.onScreen(b.head.x, b.head.y)) {
      sfx.play("fire_laser", { gain: 0.6, rate: 0.5 });
    }
  }

  /** SINGULARITY pop: the standard exploding-beam path. hitIds is cleared so
   *  a flight-contact target isn't deduped out of its own pop. */
  private popSingularity(b: Beam, owner: BeamOwner): void {
    b.collapseUntil = 0;
    b.exploding = true;
    b.explosionRadius = 0;
    b.hitIds.clear();
    this.fx.battle.burst(b.head.x, b.head.y, 125, b.weapon.tint, "detonation");
    this.fx.ring(b.head.x, b.head.y, 6, 90, 250, b.weapon.tint, 0.8);
    if (owner.local && this.view.onScreen(b.head.x, b.head.y)) {
      // The boom, dropped well below the EXPLOSION family's pitch.
      sfx.play("fire_heavy", { gain: 1.2, rate: 0.55 });
      this.trauma.add(0.12);
    }
  }

  /** RICOCHET world-edge bounce: clamp inside, reflect off the edge normal. */
  private ricochetEdgeBounce(b: Beam): void {
    let nx = 0;
    let ny = 0;
    if (b.head.x < 0) {
      nx = 1;
    } else if (b.head.x > this.world.playW) {
      nx = -1;
    }
    if (b.head.y < 0) {
      ny = 1;
    } else if (b.head.y > this.world.playH) {
      ny = -1;
    }
    b.head.x = PhaserMath.Clamp(b.head.x, 0, this.world.playW);
    b.head.y = PhaserMath.Clamp(b.head.y, 0, this.world.playH);
    const len = Math.hypot(nx, ny) || 1;
    this.ricochetBounce(b, nx / len, ny / len);
  }

  /** RICOCHET bounce: reflect off the surface normal, then re-aim at the
   *  nearest un-hit enemy/asteroid in range (the re-aim IS the weapon; the
   *  reflection is the fallback). The tail re-grows from the kink so the
   *  segment visibly bends. */
  ricochetBounce(b: Beam, nx: number, ny: number): void {
    b.bouncesLeft -= 1;
    const dx = Math.cos(b.angle);
    const dy = Math.sin(b.angle);
    const dot = dx * nx + dy * ny;
    b.angle = Math.atan2(dy - 2 * dot * ny, dx - 2 * dot * nx);
    this.retargetRicochet(b);
    b.tail = { ...b.head };
    b.released = false;
    this.fx.battle.burst(b.head.x, b.head.y, 20, b.weapon.tint, "impact", b.angle);
    this.fx.sparks(b.head.x, b.head.y, 3, b.weapon.tint, {
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
    for (const e of this.world.enemies) {
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
      for (const a of this.world.asteroids) {
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
