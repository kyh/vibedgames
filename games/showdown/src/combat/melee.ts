import { BRAWLER_RADIUS } from "../config";
import type { MeleeAttack } from "../config";
import type { Brawler } from "../entities/brawler";
import { meleeFollowTime } from "../entities/melee-pose";
import type { World } from "../world/world";
import type { Combat } from "./combat";

interface Point {
  x: number;
  z: number;
}

/** Circle against a directional sector, including the target's outer edge. */
export const inMeleeArc = (
  origin: Point,
  direction: Point,
  attack: Pick<MeleeAttack, "arc" | "range">,
  target: Point,
  radius: number,
): boolean => {
  const x = target.x - origin.x;
  const z = target.z - origin.z;
  const distance = Math.hypot(x, z);
  if (distance > attack.range + radius) {
    return false;
  }
  if (distance <= radius) {
    return true;
  }
  const angle = Math.abs(
    Math.atan2(direction.x * z - direction.z * x, direction.x * x + direction.z * z),
  );
  if (angle <= attack.arc / 2) {
    return true;
  }
  const edgeAngle = angle - attack.arc / 2;
  const projected = Math.max(0, Math.min(attack.range, distance * Math.cos(edgeAngle)));
  const edgeDistanceSquared =
    distance * distance + projected * projected - 2 * distance * projected * Math.cos(edgeAngle);
  return edgeDistanceSquared <= radius * radius;
};

/** The target tile may be a crate, but cover between the sword and it still blocks. */
export const meleeReaches = (
  world: Pick<World, "raycast" | "toTile">,
  origin: Point,
  target: Point,
  targetBlocks: boolean,
): boolean => {
  const hit = world.raycast(origin.x, origin.z, target.x, target.z);
  return (
    !hit || (targetBlocks && hit.tx === world.toTile(target.x) && hit.ty === world.toTile(target.z))
  );
};

/** Resolve one weapon sweep once. Capture cover before destroying anything. */
export const swingMelee = (
  combat: Combat,
  owner: Brawler,
  attack: MeleeAttack,
  dx: number,
  dz: number,
  isSuper: boolean,
): void => {
  const { game } = combat;
  const { world, effects } = game;
  const direction = { x: dx, z: dz };
  const targets = game.brawlers.filter(
    (target) =>
      target !== owner &&
      target.alive &&
      !target.airborne &&
      !target.evadingInvulnerable &&
      inMeleeArc(owner, direction, attack, target, BRAWLER_RADIUS) &&
      meleeReaches(world, owner, target, false),
  );
  const boxes = combat.boxes.filter(
    (box) =>
      box.alive &&
      inMeleeArc(owner, direction, attack, box, 0.46) &&
      meleeReaches(world, owner, box, true),
  );
  const walls: Point[] = [];
  if (attack.breaksWalls) {
    const reach = Math.ceil(attack.range);
    const tx = world.toTile(owner.x);
    const tz = world.toTile(owner.z);
    for (let z = tz - reach; z <= tz + reach; z += 1) {
      for (let x = tx - reach; x <= tx + reach; x += 1) {
        const tile = { x: world.center(x), z: world.center(z) };
        if (
          world.isBreakable(x, z) &&
          inMeleeArc(owner, direction, attack, tile, 0.4) &&
          meleeReaches(world, owner, tile, true)
        ) {
          walls.push({ x, z });
        }
      }
    }
  }
  const color = owner.bulletColor(isSuper);
  effects.slash(
    owner.x,
    world.heightAt(owner.x, owner.z) + 0.72,
    owner.z,
    Math.atan2(dx, dz),
    attack.range,
    attack.arc,
    color,
    isSuper,
    meleeFollowTime(attack.style, attack.recovery),
  );
  for (const target of targets) {
    const dealt = target.takeDamage(attack.damage * owner.damageMul, owner);
    if (dealt <= 0) {
      continue;
    }
    const distance = Math.hypot(target.x - owner.x, target.z - owner.z) || 1;
    const force = attack.knockback ?? 2;
    target.knock.set(
      ((target.x - owner.x) / distance) * force,
      ((target.z - owner.z) / distance) * force,
    );
    effects.impact(
      target.x,
      world.heightAt(target.x, target.z) + 0.75,
      target.z,
      color,
      isSuper ? 10 : 6,
    );
  }
  for (const box of boxes) {
    combat.damageBox(box, attack.damage * owner.damageMul, owner);
    effects.impact(box.x, world.heightAt(box.x, box.z) + 0.65, box.z, color, 5);
  }
  for (const wall of walls) {
    combat.breakTile(wall.x, wall.z);
  }
  if (targets.length > 0 || boxes.length > 0) {
    game.shake(isSuper ? 0.25 : 0.09, owner.x, owner.z);
  }
};
