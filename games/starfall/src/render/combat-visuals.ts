import type { Vec, Weapon } from "../shared/constants";

export type WeaponLook =
  | "bolt"
  | "rapid"
  | "heavy"
  | "laser"
  | "rail"
  | "scatter"
  | "missile"
  | "plasma"
  | "drill"
  | "glaive"
  | "arc"
  | "orb"
  | "nova"
  | "mine";

/** Local weapon identity only. Remote snapshots use their actual shape flags,
 * never the owner's current loadout to guess an old projectile's weapon. */
export function weaponLook(weapon: Weapon): WeaponLook {
  if (weapon.singularity) return "orb";
  if (weapon.homing) return "missile";
  switch (weapon.sfx) {
    case "rapid":
      return "rapid";
    case "heavy":
    case "boom":
      return "heavy";
    case "zap":
      return "laser";
    case "rail":
      return "rail";
    case "scatter":
      return "scatter";
    case "plasma":
      return "plasma";
    case "drill":
      return "drill";
    case "glaive":
      return "glaive";
    case "arc":
    case "tesla":
      return "arc";
    case "singularity":
      return "orb";
    case "nova":
      return "nova";
    case "mine":
      return "mine";
    default:
      return "bolt";
  }
}

/** Presentation contact at the near surface of a hit circle. Call BEFORE any
 * bounce/reaction changes the beam. Collision testing remains the caller's job. */
export function contactPoint(
  tail: Vec,
  head: Vec,
  target: Vec,
  radius: number,
  radial: boolean,
): Vec {
  if (radial) {
    const dx = head.x - target.x;
    const dy = head.y - target.y;
    const distance = Math.hypot(dx, dy);
    const offset = Math.min(radius, distance);
    return distance > 0
      ? { x: target.x + (dx / distance) * offset, y: target.y + (dy / distance) * offset }
      : { x: target.x, y: target.y };
  }
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return { x: head.x, y: head.y };
  const ox = tail.x - target.x;
  const oy = tail.y - target.y;
  const b = ox * dx + oy * dy;
  const discriminant = b * b - length2 * (ox * ox + oy * oy - radius * radius);
  // Width padding can hit beside the physical hull. Project onto the segment
  // in that case; never move the authored beam or invent a collision.
  const along = discriminant >= 0 ? (-b - Math.sqrt(discriminant)) / length2 : -b / length2;
  const t = Math.max(0, Math.min(1, along));
  return { x: tail.x + dx * t, y: tail.y + dy * t };
}

export type BurstKind = "muzzle" | "impact" | "fracture" | "death" | "boss" | "detonation";

export function burstLifetime(kind: BurstKind): number {
  switch (kind) {
    case "muzzle":
      return 115;
    case "impact":
      return 300;
    case "fracture":
      return 650;
    case "death":
      return 900;
    case "boss":
      return 1550;
    case "detonation":
      return 650;
  }
}

/** A stage's envelope is exactly zero before launch and after expiry. */
export function burstStage(age: number, delay: number, life: number): number {
  if (age < delay || age >= delay + life) return 0;
  return 1 - (age - delay) / life;
}
