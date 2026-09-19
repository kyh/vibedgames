import type { Effects } from "../fx/effects";
import { clamp, lerp } from "../utils";
import type { Bomb, Combat } from "./combat";

// Bombs fly on a sine arc from the muzzle to the marked landing spot,
// tumbling as they go, and kick up dust when they touch down.
const flyBomb = (bomb: Bomb, dt: number, effects: Effects): void => {
  const { a, slot } = bomb;
  bomb.t += dt;
  const k = clamp(bomb.t / a.flight, 0, 1);
  const arc = a.big ? 4.4 : 3.3;
  const y = lerp(bomb.sy, 0.2, k) + Math.sin(k * Math.PI) * arc;
  slot.group.position.set(lerp(bomb.sx, bomb.tx, k), y, lerp(bomb.sz, bomb.tz, k));
  slot.group.rotation.x += dt * 9;
  slot.group.rotation.z += dt * 5;
  if (k >= 1) {
    bomb.landed = true;
    effects.dust(bomb.tx, bomb.tz, 4, 1.4);
  }
};

/** Advance one bomb: flight or fuse, the pulsing marker, its light, and detonation. */
export const stepBomb = (combat: Combat, bomb: Bomb, dt: number): void => {
  const { effects, elapsed, lighting } = combat.game;
  const { a, slot } = bomb;
  if (bomb.landed) {
    bomb.fuse -= dt;
    slot.group.position.y = 0.2 * slot.group.scale.x;
  } else {
    flyBomb(bomb, dt, effects);
  }
  // The marker fills and the spark flickers faster as the fuse runs down.
  const urgency = bomb.landed ? 1 - clamp(bomb.fuse / a.fuse, 0, 1) : 0;
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * (14 + urgency * 30));
  slot.spark.scale.setScalar(0.8 + pulse * 0.9);
  slot.ring.material.opacity = 0.55 + pulse * 0.35;
  slot.fillDisc.material.opacity = 0.1 + urgency * 0.22;
  const p = slot.group.position;
  lighting.addLight(p.x, p.y + 0.3, p.z, combat.orange, 2.2 + pulse * 2.5, 4);
  if (Math.random() < dt * 40) {
    effects.spark(p.x, p.y + 0.25 * slot.group.scale.x, p.z, combat.orange);
  }
  if (bomb.landed && bomb.fuse <= 0) {
    bomb.done = true;
    slot.busy = false;
    slot.group.visible = false;
    slot.ring.visible = false;
    combat.explode(bomb.tx, bomb.tz, a, bomb.owner, bomb.isSuper);
  }
};
