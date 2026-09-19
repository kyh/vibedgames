// Every transient visual in the arena: glow and smoke particles, muzzle and
// blast flashes, debris chunks, ground scorch decals, shockwave rings and the
// night-time fireflies. Combat and the brawlers call the named recipes here
// (`muzzle`, `explosion`, `leaves`, ...) and never touch the pools directly.
import * as THREE from "three";
import type { Game } from "../game";
import type { FxMethod, FxRecorder } from "../net/presentation";
import { rand } from "../utils";
import { DebrisField } from "./debris";
import { DecalPool } from "./decals";
import { createFireflies } from "./fireflies";
import type { FireflySwarm, FireflyUniforms } from "./fireflies";
import { FlashList } from "./flashes";
import { ParticlePool } from "./particle-pool";
import { RingPool } from "./rings";

// A full turn, deliberately a touch short of 2π: the gap is invisible in a
// random scatter and the value is what the effects were tuned against.
const TURN = 6.28;
const DEBRIS_CAP = 140;

const scratchSize = new THREE.Vector2();
const scratchColor = new THREE.Color();

export class Effects {
  game: Game;
  glow: ParticlePool;
  smoke: ParticlePool;
  fireflies: THREE.Points;
  fireflyMat: THREE.ShaderMaterial;
  private fireflyUniforms: FireflyUniforms;
  private readonly flashes: FlashList;
  private readonly debrisField: DebrisField;
  private readonly decals: DecalPool;
  private readonly rings: RingPool;
  /** While hosting online, every top-level recipe call is also written here for guests. */
  recorder: FxRecorder | null = null;
  /** Nesting depth of recipe calls: composites (explosion → flash + ring …) record once. */
  private depth = 0;

  constructor(game: Game) {
    this.game = game;
    const { scene } = game;
    this.glow = new ParticlePool(scene, 1800, true);
    this.smoke = new ParticlePool(scene, 900, false);
    this.flashes = new FlashList();
    this.debrisField = new DebrisField(scene, DEBRIS_CAP);
    this.decals = new DecalPool(scene);
    this.rings = new RingPool(scene);
    const swarm = this.mountFireflies();
    this.fireflies = swarm.points;
    this.fireflyMat = swarm.material;
    this.fireflyUniforms = swarm.uniforms;
  }

  buildFireflies(): void {
    const swarm = this.mountFireflies();
    this.fireflies = swarm.points;
    this.fireflyMat = swarm.material;
    this.fireflyUniforms = swarm.uniforms;
  }

  private mountFireflies(): FireflySwarm {
    const swarm = createFireflies(this.game.world);
    this.game.scene.add(swarm.points);
    return swarm;
  }

  /** The world was regenerated: re-seat the fireflies on the new bushes. */
  rebuildFireflies(): void {
    this.game.scene.remove(this.fireflies);
    this.fireflies.geometry.dispose();
    this.fireflyMat.dispose();
    this.buildFireflies();
  }

  private record(m: FxMethod, a: number[]): void {
    if (this.depth === 0) {
      this.recorder?.(m, a);
    }
  }

  flash(
    x: number,
    y: number,
    z: number,
    color: THREE.Color,
    intensity: number,
    distance: number,
    duration: number,
  ): void {
    this.record("flash", [x, y, z, color.getHex(), intensity, distance, duration]);
    this.flashes.add(x, y, z, color, intensity, distance, duration);
  }

  spark(x: number, y: number, z: number, color: THREE.Color): void {
    this.glow.emit(
      x,
      y,
      z,
      rand(-1.4, 1.4),
      rand(0.6, 2.6),
      rand(-1.4, 1.4),
      rand(0.18, 0.4),
      0.14,
      0.02,
      color.r * 5,
      color.g * 5,
      color.b * 5,
      1,
      2,
      7,
    );
  }

  trail(x: number, y: number, z: number, color: THREE.Color, size: number): void {
    this.glow.emit(
      x + rand(-0.04, 0.04),
      y + rand(-0.04, 0.04),
      z + rand(-0.04, 0.04),
      0,
      0,
      0,
      0.15,
      size * 1.35,
      0.02,
      color.r * 1.15,
      color.g * 1.15,
      color.b * 1.15,
      0.5,
      0,
      0,
    );
  }

  impact(x: number, y: number, z: number, color: THREE.Color, count: number): void {
    this.record("impact", [x, y, z, color.getHex(), count]);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * TURN;
      const speed = rand(1.5, 5);
      this.glow.emit(
        x,
        y,
        z,
        Math.cos(angle) * speed,
        rand(0.5, 3.5),
        Math.sin(angle) * speed,
        rand(0.15, 0.35),
        0.15,
        0.02,
        color.r * 3.2,
        color.g * 3.2,
        color.b * 3.2,
        1,
        3,
        9,
      );
    }
    this.glow.emit(
      x,
      y,
      z,
      0,
      0,
      0,
      0.1,
      0.7,
      0.2,
      color.r * 1.6,
      color.g * 1.6,
      color.b * 1.6,
      0.8,
      0,
      0,
    );
  }

  burst(x: number, y: number, z: number, color: THREE.Color, count: number, speed: number): void {
    this.record("burst", [x, y, z, color.getHex(), count, speed]);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * TURN;
      const v = rand(0.4, 1) * speed;
      this.glow.emit(
        x,
        y,
        z,
        Math.cos(angle) * v,
        rand(1, 4.5),
        Math.sin(angle) * v,
        rand(0.35, 0.7),
        0.2,
        0.03,
        color.r * 4,
        color.g * 4,
        color.b * 4,
        1,
        2.2,
        8,
      );
    }
  }

  muzzle(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    color: THREE.Color,
    scale: number,
  ): void {
    this.record("muzzle", [x, y, z, dx, dz, color.getHex(), scale]);
    this.depth += 1;
    this.flash(x + dx * 0.2, y + 0.1, z + dz * 0.2, color, 6.5 * scale, 5.5, 0.09);
    this.depth -= 1;
    this.glow.emit(
      x + dx * 0.1,
      y,
      z + dz * 0.1,
      dx * 1.5,
      0,
      dz * 1.5,
      0.07,
      0.95 * scale,
      0.3,
      color.r * 3,
      color.g * 3,
      color.b * 3,
      1,
      0,
      0,
    );
    for (let i = 0; i < 5; i += 1) {
      const jitter = 0.5;
      const vx = dx * rand(4, 9) + rand(-0.5, jitter) * 3;
      const vz = dz * rand(4, 9) + rand(-0.5, jitter) * 3;
      this.glow.emit(
        x,
        y,
        z,
        vx,
        rand(-0.5, 1.5),
        vz,
        rand(0.08, 0.2),
        0.13,
        0.02,
        color.r * 5,
        color.g * 5,
        color.b * 5,
        1,
        4,
        3,
      );
    }
    this.smoke.emit(
      x + dx * 0.15,
      y + 0.05,
      z + dz * 0.15,
      dx * 0.9,
      0.5,
      dz * 0.9,
      0.5,
      0.25,
      0.7,
      0.8,
      0.8,
      0.8,
      0.3,
      1.5,
      -0.3,
    );
  }

  dust(x: number, z: number, count: number, speed: number): void {
    this.record("dust", [x, z, count, speed]);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * TURN;
      const v = rand(0.4, 1) * speed;
      this.smoke.emit(
        x + Math.cos(angle) * 0.2,
        0.12,
        z + Math.sin(angle) * 0.2,
        Math.cos(angle) * v,
        rand(0.2, 0.9),
        Math.sin(angle) * v,
        rand(0.5, 0.95),
        0.35,
        1.1,
        0.78,
        0.66,
        0.47,
        0.42,
        2.4,
        -0.2,
      );
    }
  }

  footDust(x: number, z: number): void {
    this.smoke.emit(
      x + rand(-0.1, 0.1),
      0.06,
      z + rand(-0.1, 0.1),
      rand(-0.2, 0.2),
      0.35,
      rand(-0.2, 0.2),
      0.42,
      0.16,
      0.5,
      0.8,
      0.68,
      0.48,
      0.3,
      2,
      -0.1,
    );
  }

  leaves(x: number, z: number, count: number): void {
    this.record("leaves", [x, z, count]);
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * TURN;
      this.smoke.emit(
        x + rand(-0.3, 0.3),
        rand(0.3, 0.9),
        z + rand(-0.3, 0.3),
        Math.cos(angle) * rand(0.6, 2.2),
        rand(1.2, 3),
        Math.sin(angle) * rand(0.6, 2.2),
        rand(0.5, 0.9),
        0.17,
        0.1,
        0.3,
        0.72,
        0.22,
        0.95,
        1.6,
        6,
      );
    }
  }

  healPuff(x: number, z: number): void {
    this.record("healPuff", [x, z]);
    for (let i = 0; i < 5; i += 1) {
      this.glow.emit(
        x + rand(-0.4, 0.4),
        rand(0.4, 1.2),
        z + rand(-0.4, 0.4),
        0,
        rand(0.8, 1.6),
        0,
        rand(0.4, 0.7),
        0.16,
        0.04,
        0.5,
        3.2,
        0.9,
        0.9,
        0.5,
        0,
      );
    }
  }

  debris(x: number, y: number, z: number, color: THREE.ColorRepresentation, count: number): void {
    this.record("debris", [x, y, z, scratchColor.set(color).getHex(), count]);
    this.debrisField.spawn(x, y, z, color, count);
  }

  ring(
    x: number,
    z: number,
    radius: number,
    color: THREE.Color,
    duration = 0.4,
    brightness = 3,
  ): void {
    this.record("ring", [x, z, radius, color.getHex(), duration, brightness]);
    this.rings.spawn(x, z, radius, color, duration, brightness);
  }

  decal(x: number, z: number, radius: number): void {
    this.record("decal", [x, z, radius]);
    this.decals.stamp(x, z, radius);
  }

  explosion(x: number, z: number, radius: number, color: THREE.Color, big: boolean): void {
    this.record("explosion", [x, z, radius, color.getHex(), big ? 1 : 0]);
    this.depth += 1;
    const emberCount = big ? 46 : 24;
    this.flash(x, 1.1, z, color, big ? 95 : 48, big ? 15 : 10, big ? 0.5 : 0.34);
    this.ring(x, z, radius * 1.15, color, big ? 0.5 : 0.36);
    this.decal(x, z, radius * 0.85);
    this.glow.emit(
      x,
      0.6,
      z,
      0,
      0.5,
      0,
      0.22,
      radius * 3.2,
      radius * 0.8,
      color.r * 6,
      color.g * 5,
      color.b * 4,
      1,
      0,
      0,
    );
    for (let i = 0; i < emberCount; i += 1) {
      const angle = Math.random() * TURN;
      const speed = rand(0.3, 1) * radius * 4.2;
      const heat = Math.random();
      this.glow.emit(
        x,
        0.4,
        z,
        Math.cos(angle) * speed,
        rand(1, 6),
        Math.sin(angle) * speed,
        rand(0.3, 0.75),
        rand(0.25, 0.6),
        0.04,
        (1 + heat) * 3.2,
        (0.4 + heat * 0.6) * 3,
        0.75,
        1,
        2.6,
        6,
      );
    }
    const smokeCount = big ? 16 : 9;
    for (let i = 0; i < smokeCount; i += 1) {
      const angle = Math.random() * TURN;
      const speed = rand(0.2, 1) * radius * 1.6;
      this.smoke.emit(
        x + Math.cos(angle) * 0.3,
        rand(0.3, 0.9),
        z + Math.sin(angle) * 0.3,
        Math.cos(angle) * speed,
        rand(0.8, 2.6),
        Math.sin(angle) * speed,
        rand(0.9, 1.7),
        radius * 0.7,
        radius * 1.9,
        0.22,
        0.2,
        0.2,
        0.55,
        1.6,
        -0.5,
      );
    }
    this.dust(x, z, big ? 14 : 8, radius * 2.2);
    this.depth -= 1;
  }

  slam(x: number, z: number, radius: number, color: THREE.Color): void {
    this.record("slam", [x, z, radius, color.getHex()]);
    this.depth += 1;
    this.flash(x, 0.9, z, color, 40, 10, 0.32);
    this.ring(x, z, radius * 1.2, color, 0.42, 2.4);
    this.decal(x, z, radius * 0.6);
    this.dust(x, z, 22, radius * 3.2);
    for (let i = 0; i < 18; i += 1) {
      const angle = Math.random() * TURN;
      const speed = rand(2, 7);
      this.glow.emit(
        x,
        0.2,
        z,
        Math.cos(angle) * speed,
        rand(1, 4),
        Math.sin(angle) * speed,
        rand(0.25, 0.5),
        0.2,
        0.03,
        color.r * 4,
        color.g * 4,
        color.b * 4,
        1,
        2.5,
        8,
      );
    }
    this.depth -= 1;
  }

  defeat(x: number, z: number, color: THREE.Color): void {
    this.record("defeat", [x, z, color.getHex()]);
    this.depth += 1;
    this.flash(x, 1, z, color, 26, 8, 0.4);
    this.ring(x, z, 1.6, color, 0.45, 2.2);
    this.burst(x, 0.8, z, color, 26, 5);
    for (let i = 0; i < 8; i += 1) {
      this.smoke.emit(
        x + rand(-0.3, 0.3),
        rand(0.3, 1.2),
        z + rand(-0.3, 0.3),
        rand(-0.6, 0.6),
        rand(0.8, 2),
        rand(-0.6, 0.6),
        rand(0.7, 1.2),
        0.5,
        1.4,
        0.85,
        0.85,
        0.9,
        0.5,
        1.4,
        -0.3,
      );
    }
    this.depth -= 1;
  }

  update(dt: number): void {
    const { game } = this;
    const { lighting } = game;
    // Point sprites are sized in world units: convert to pixels per unit at
    // distance 1 so they stay the same physical size across resolutions.
    const pixelScale =
      game.pipeline.renderer.getDrawingBufferSize(scratchSize).y /
      (2 * Math.tan((game.camera.fov * Math.PI) / 360));
    this.glow.uniforms.uScale.value = pixelScale;
    this.smoke.uniforms.uScale.value = pixelScale;
    this.smoke.uniforms.uDim.value = lighting.ambientLevel;
    this.fireflyUniforms.uScale.value = pixelScale;
    this.fireflyUniforms.uTime.value = game.elapsed;
    this.fireflyUniforms.uNight.value = lighting.night;
    this.fireflies.visible = lighting.night > 0.01;
    this.glow.update(dt);
    this.smoke.update(dt);
    this.flashes.update(dt, lighting);
    this.debrisField.update(dt);
    this.decals.update(dt);
    this.rings.update(dt);
  }
}
