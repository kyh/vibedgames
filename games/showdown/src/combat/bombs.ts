import type { LobAttack } from "../config";
import { clamp, lerp } from "../utils";
import type { Bomb, Combat } from "./combat";

/** A lob in flight: from its muzzle point towards its landing marker, `t` seconds out. */
export interface LobFlight {
  a: LobAttack;
  sx: number;
  sy: number;
  sz: number;
  t: number;
  tx: number;
  tz: number;
}

/** Place a lob on its arc; returns flight progress (1 once it has landed). Shared by host and guest. */
export const placeLob = (
  lob: LobFlight,
  heightAt: (x: number, z: number) => number,
  out: { set: (x: number, y: number, z: number) => void },
): number => {
  const { a } = lob;
  const k = clamp(lob.t / a.flight, 0, 1);
  let arc = a.big ? 4.4 : 3.3;
  if (a.style === "potion") {
    arc *= 0.65;
  }
  const y = lerp(lob.sy, heightAt(lob.tx, lob.tz) + 0.2, k) + Math.sin(k * Math.PI) * arc;
  out.set(lerp(lob.sx, lob.tx, k), y, lerp(lob.sz, lob.tz, k));
  return k;
};

// Bombs fly on a sine arc from the muzzle to the marked landing spot,
// tumbling as they go, and kick up dust when they touch down.
const flyBomb = (combat: Combat, bomb: Bomb, dt: number): void => {
  const { effects, world } = combat.game;
  const { slot } = bomb;
  bomb.t += dt;
  const k = placeLob(bomb, world.heightAt, slot.group.position);
  slot.group.rotation.x += dt * 9;
  slot.group.rotation.z += dt * 5;
  if (k >= 1) {
    bomb.landed = true;
    combat.game.asActor(bomb.owner, () => effects.dust(bomb.tx, bomb.tz, 4, 1.4));
  }
};

/** Advance one bomb: flight or fuse, the pulsing marker, its light, and detonation. */
export const stepBomb = (combat: Combat, bomb: Bomb, dt: number): void => {
  const { effects, elapsed, lighting, world } = combat.game;
  const { a, slot } = bomb;
  if (bomb.landed) {
    bomb.fuse -= dt;
    slot.group.position.y = world.heightAt(bomb.tx, bomb.tz) + 0.2 * slot.group.scale.x;
  } else {
    flyBomb(combat, bomb, dt);
  }
  // The marker fills and the spark flickers faster as the fuse runs down.
  const urgency = bomb.landed ? 1 - clamp(bomb.fuse / a.fuse, 0, 1) : 0;
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * (14 + urgency * 30));
  slot.spark.scale.setScalar(0.8 + pulse * 0.9);
  slot.ring.material.opacity = 0.55 + pulse * 0.35;
  slot.fillDisc.material.opacity = 0.1 + urgency * 0.22;
  const p = slot.group.position;
  effects.trail(p.x, p.y, p.z, bomb.color, a.big ? 0.46 : 0.26);
  lighting.addLight(p.x, p.y + 0.3, p.z, bomb.color, 2.2 + pulse * 2.5, 4);
  if (Math.random() < dt * 40) {
    effects.spark(p.x, p.y + 0.25 * slot.group.scale.x, p.z, bomb.color);
  }
  if (bomb.landed && bomb.fuse <= 0) {
    bomb.done = true;
    slot.busy = false;
    slot.group.visible = false;
    slot.ring.visible = false;
    combat.explode(bomb.tx, bomb.tz, a, bomb.owner, bomb.isSuper);
  }
};
