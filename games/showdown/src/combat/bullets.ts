import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BRAWLER_RADIUS, TILE } from "../config";
import type { ProjectileStyle } from "../config";
import type { Game } from "../game";
import { clamp } from "../utils";
import { gridIndex } from "../world/grid";
import type { Bullet, Combat } from "./combat";

export const MAX_BULLETS = 360;
/** Height every bullet flies at: chest level on the brawler models. */
export const BULLET_Y = 0.64;
// Longest distance a bullet moves per sub-step, so fast shots cannot tunnel
// through a wall or skip past a brawler between frames.
const STEP = 0.2;

const scratchMatrix = new THREE.Matrix4();
const scratchQuat = new THREE.Quaternion();
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchEuler = new THREE.Euler();
const scratchColor = new THREE.Color();

// A bullet that reaches a blocking tile either chips the loot box there,
// breaks through a breakable wall (piercing shots keep going) or dies.
const hitTile = (combat: Combat, bullet: Bullet, tx: number, tz: number): void => {
  const { effects, world } = combat.game;
  const box = combat.boxAt(tx, tz);
  if (box) {
    combat.damageBox(box, bullet.damage, bullet.owner);
    bullet.alive = false;
  } else if (bullet.a.breaksWalls && world.isBreakable(tx, tz)) {
    combat.breakTile(tx, tz);
    if (!bullet.a.pierce) {
      bullet.alive = false;
    }
  } else {
    bullet.alive = false;
  }
  if (!bullet.alive) {
    const size = 5;
    effects.impact(
      bullet.x - bullet.dx * 0.12,
      BULLET_Y + world.heightAt(bullet.x, bullet.z),
      bullet.z - bullet.dz * 0.12,
      bullet.color,
      size,
    );
  }
};

const hitBrawlers = (combat: Combat, bullet: Bullet): void => {
  const { brawlers, effects, world } = combat.game;
  const reach = BRAWLER_RADIUS + 0.06 + bullet.radius;
  for (const target of brawlers) {
    if (
      !target.alive ||
      target === bullet.owner ||
      target.airborne ||
      target.evadingInvulnerable ||
      bullet.hitTargets.has(target.id)
    ) {
      continue;
    }
    const ox = target.x - bullet.x;
    const oz = target.z - bullet.z;
    if (ox * ox + oz * oz > reach * reach) {
      continue;
    }
    bullet.hitTargets.add(target.id);
    target.takeDamage(bullet.damage, bullet.owner);
    if (bullet.a.knockback) {
      target.knock.set(bullet.dx * bullet.a.knockback, bullet.dz * bullet.a.knockback);
    } else {
      target.knock.set(target.knock.x + bullet.dx * 1.2, target.knock.y + bullet.dz * 1.2);
    }
    effects.impact(
      bullet.x,
      BULLET_Y + world.heightAt(bullet.x, bullet.z),
      bullet.z,
      bullet.color,
      8,
    );
    effects.flash(
      bullet.x,
      BULLET_Y + world.heightAt(bullet.x, bullet.z),
      bullet.z,
      bullet.color,
      5,
      4,
      0.12,
    );
    if (!bullet.a.pierce) {
      bullet.alive = false;
      return;
    }
  }
};

/** Move a bullet for one frame in short sub-steps, resolving hits along the way. */
export const advanceBullet = (combat: Combat, bullet: Bullet, dt: number): void => {
  const { effects, world } = combat.game;
  let remaining = bullet.speed * dt;
  while (remaining > 0 && bullet.alive) {
    const step = Math.min(remaining, STEP);
    remaining -= step;
    bullet.x += bullet.dx * step;
    bullet.z += bullet.dz * step;
    bullet.travel += step;
    const tx = world.toTile(bullet.x);
    const tz = world.toTile(bullet.z);
    if (world.blocksShots(tx, tz)) {
      hitTile(combat, bullet, tx, tz);
      if (!bullet.alive) {
        break;
      }
    } else if (bullet.a.breaksWalls && world.tiles[gridIndex(tx, tz)] === TILE.BUSH) {
      combat.breakTile(tx, tz);
    }
    hitBrawlers(combat, bullet);
    if (bullet.alive && bullet.travel >= bullet.range) {
      bullet.alive = false;
      effects.impact(
        bullet.x,
        BULLET_Y + world.heightAt(bullet.x, bullet.z),
        bullet.z,
        bullet.color,
        2,
      );
    }
  }
};

/** Shared instanced arrow: pointed head, narrow shaft and crossed fletching. */
export const buildArrowGeometry = (): THREE.BufferGeometry => {
  const parts = [
    new THREE.CylinderGeometry(0.18, 0.18, 2.1, 5).rotateX(Math.PI / 2).translate(0, 0, -0.1),
    new THREE.ConeGeometry(0.85, 0.9, 4).rotateX(Math.PI / 2).translate(0, 0, 1.15),
    new THREE.BoxGeometry(1.2, 0.13, 0.6).translate(0, 0, -0.95),
    new THREE.BoxGeometry(0.13, 1.2, 0.6).translate(0, 0, -0.95),
  ];
  const geometry = mergeGeometries(parts);
  for (const part of parts) {
    part.dispose();
  }
  if (!geometry) {
    throw new Error("Arrow geometry could not be merged");
  }
  return geometry;
};

type ProjectileView = Pick<Bullet, "color" | "dx" | "dz" | "isSuper" | "radius" | "x" | "z">;

/** One shared draw path keeps hosts and guests' weapon silhouettes identical. */
export const drawProjectile = (
  mesh: THREE.InstancedMesh,
  index: number,
  bullet: ProjectileView,
  style: ProjectileStyle,
  remaining: number,
  groundY: number,
): void => {
  const fade = clamp(remaining / 0.8, 0.35, 1);
  const width = bullet.radius * fade;
  scratchEuler.set(0, Math.atan2(bullet.dx, bullet.dz), 0);
  scratchQuat.setFromEuler(scratchEuler);
  switch (style) {
    case "spear": {
      scratchScale.set(width * 0.8, width * 0.8, 0.6);
      break;
    }
    case "bolt": {
      scratchScale.set(width * 1.3, width * 1.3, 0.24);
      break;
    }
    case "thorn": {
      scratchScale.set(width * 0.8, width * 0.55, 0.42);
      break;
    }
    case "arrow": {
      scratchScale.set(width, width, bullet.isSuper ? 0.36 : 0.3);
      break;
    }
    default: {
      const unreachable: never = style;
      throw new Error(`Unknown projectile style: ${unreachable}`);
    }
  }
  scratchMatrix.compose(
    scratchPos.set(bullet.x, BULLET_Y + groundY, bullet.z),
    scratchQuat,
    scratchScale,
  );
  mesh.setMatrixAt(index, scratchMatrix);
  mesh.setColorAt(
    index,
    scratchColor.copy(bullet.color).multiplyScalar(bullet.isSuper ? 1.7 : 1.1),
  );
};

export const buildProjectileMesh = (
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
): THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> => {
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0xff_ff_ff }),
    MAX_BULLETS,
  );
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.userData.noAO = true;
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  scene.add(mesh);
  return mesh;
};

export const finishProjectileMesh = (mesh: THREE.InstancedMesh, count: number): void => {
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
  }
};

/** Enchanted arrows leave a thin trail; normal shafts remain easy to track. */
export const lightBullet = (game: Game, bullet: Bullet, dt: number): void => {
  const y = BULLET_Y + game.world.heightAt(bullet.x, bullet.z);
  if (bullet.isSuper) {
    const intensity = bullet.a.kind === "spread" ? 1.4 / bullet.a.pellets : 1;
    game.lighting.addLight(bullet.x, y, bullet.z, bullet.color, intensity, 2.5);
  }
  bullet.trail -= dt;
  if (bullet.trail <= 0) {
    bullet.trail = 0.045;
    game.effects.trail(bullet.x, y, bullet.z, bullet.color, bullet.isSuper ? 0.15 : 0.065);
  }
};
