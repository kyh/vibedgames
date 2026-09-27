import type { BufferGeometry } from "three";
import { clamp } from "../utils";

/** Two grassy terraces on each side of the low courtyard, joined by walkable ramps. */
export const terrainHeight = (_x: number, z: number): number => {
  const distance = Math.abs(z);
  return clamp((distance - 5) / 3, 0, 1) * 1.4 + clamp((distance - 14) / 3, 0, 1);
};

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Intersect the same height field the floor uses, at weapon-target height. */
export const terrainAimDistance = (origin: Point3, direction: Point3): number | null => {
  if (direction.y >= -0.001) {
    return null;
  }
  let near = 0;
  let far = Math.max(0, (origin.y + 1) / -direction.y);
  for (let i = 0; i < 24; i += 1) {
    const distance = (near + far) * 0.5;
    const x = origin.x + direction.x * distance;
    const z = origin.z + direction.z * distance;
    if (origin.y + direction.y * distance > terrainHeight(x, z) + 0.5) {
      near = distance;
    } else {
      far = distance;
    }
  }
  return (near + far) * 0.5;
};

/** Drape a horizontal marker over ramps; X/Z remain unchanged for repeated updates. */
export const conformGroundGeometry = (
  geometry: BufferGeometry,
  x: number,
  z: number,
  scale = 1,
  angle = 0,
): void => {
  const positions = geometry.getAttribute("position");
  const ground = terrainHeight(x, z);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let i = 0; i < positions.count; i += 1) {
    const px = positions.getX(i) * scale;
    const pz = positions.getZ(i) * scale;
    positions.setY(i, terrainHeight(x + px * cos + pz * sin, z + pz * cos - px * sin) - ground);
  }
  positions.needsUpdate = true;
};
