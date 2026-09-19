import * as THREE from "three";
import { BRAWLER_RADIUS, TILE } from "../config";
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
    const size = bullet.melee ? 3 : 6;
    effects.impact(
      bullet.x - bullet.dx * 0.12,
      BULLET_Y,
      bullet.z - bullet.dz * 0.12,
      bullet.color,
      size,
    );
  }
};

const hitBrawlers = (combat: Combat, bullet: Bullet): void => {
  const { brawlers, effects } = combat.game;
  const reach = BRAWLER_RADIUS + 0.06 + bullet.radius;
  for (const target of brawlers) {
    if (!target.alive || target === bullet.owner || target.airborne) {
      continue;
    }
    const ox = target.x - bullet.x;
    const oz = target.z - bullet.z;
    if (ox * ox + oz * oz > reach * reach) {
      continue;
    }
    target.takeDamage(bullet.damage, bullet.owner);
    if (bullet.a.knockback) {
      target.knock.set(bullet.dx * bullet.a.knockback, bullet.dz * bullet.a.knockback);
    } else {
      target.knock.set(target.knock.x + bullet.dx * 1.2, target.knock.y + bullet.dz * 1.2);
    }
    effects.impact(bullet.x, BULLET_Y, bullet.z, bullet.color, 8);
    effects.flash(bullet.x, BULLET_Y, bullet.z, bullet.color, 5, 4, 0.12);
    bullet.alive = false;
    return;
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
      effects.impact(bullet.x, BULLET_Y, bullet.z, bullet.color, 2);
    }
  }
};

/** Write one bullet's stretched-sphere transform and boosted colour into the instanced mesh. */
export const drawBullet = (mesh: THREE.InstancedMesh, index: number, bullet: Bullet): void => {
  // Shots shrink over the last stretch of their range instead of popping.
  const fade = clamp((bullet.range - bullet.travel) / 0.8, 0.35, 1);
  const length = bullet.melee ? bullet.radius * 1.2 : bullet.radius * (bullet.isSuper ? 3.6 : 3);
  const width = bullet.radius * (bullet.melee ? 1 : 0.8) * fade;
  scratchEuler.set(0, Math.atan2(bullet.dx, bullet.dz), 0);
  scratchQuat.setFromEuler(scratchEuler);
  scratchMatrix.compose(
    scratchPos.set(bullet.x, BULLET_Y, bullet.z),
    scratchQuat,
    scratchScale.set(width, width * (bullet.melee ? 0.7 : 1), length),
  );
  mesh.setMatrixAt(index, scratchMatrix);
  const boost = bullet.isSuper ? 3.6 : 2.8;
  mesh.setColorAt(
    index,
    scratchColor.copy(bullet.color).multiplyScalar(boost * (bullet.melee ? 0.6 : 1)),
  );
};

// A shotgun spreads its light budget across its pellets; punches glow softly.
const lightScale = (bullet: Bullet): number => {
  if (bullet.a.kind === "spread") {
    return 1.6 / bullet.a.pellets;
  }
  return bullet.melee ? 0.5 : 1;
};

/** Cast the bullet's point light and drop a trail particle every few centimetres. */
export const lightBullet = (game: Game, bullet: Bullet, dt: number): void => {
  const intensity = (bullet.isSuper ? 2.6 : 1.9) * lightScale(bullet);
  game.lighting.addLight(bullet.x, BULLET_Y, bullet.z, bullet.color, intensity, 4.2);
  bullet.trail -= dt;
  if (bullet.trail <= 0) {
    bullet.trail = 0.03;
    game.effects.trail(
      bullet.x,
      BULLET_Y,
      bullet.z,
      bullet.color,
      bullet.radius * (bullet.melee ? 2.2 : 1.6),
    );
  }
};
