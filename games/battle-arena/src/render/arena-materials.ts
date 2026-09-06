import * as THREE from "three";
import { hash2 } from "../data/decor";

export type ArenaSurface = "stone" | "floor" | "dirt" | "grate";
const SURFACES = {
  stone: { color: 0xc6c8ca, roughness: 0.86 },
  floor: { color: 0xc5c9cf, roughness: 0.92 },
  dirt: { color: 0xc0b5a6, roughness: 0.98 },
  grate: { color: 0xb4bdc9, roughness: 0.86 },
};

/** Explicit scenery vocabulary. Characters, weapons, gold, glass, banners and
 * other authored materials never enter this grade. Colors are all sRGB hex. */
export function arenaSurface(model: string): ArenaSurface | null {
  if (model === "floor_dirt_large") return "dirt";
  if (model === "floor_tile_big_grate") return "grate";
  if (model.startsWith("floor_tile_")) return "floor";
  if (
    model.startsWith("wall") ||
    model.startsWith("stairs") ||
    model.startsWith("floor_foundation") ||
    model.startsWith("pillar") ||
    model === "column" ||
    model === "barrier" ||
    model === "barrier_column" ||
    model === "rubble_half" ||
    model === "rocks" ||
    model === "rocks_small"
  )
    return "stone";
  return null;
}

/** One clone per source/surface per Environment. Rebuilds reuse the same
 * owned grade; library templates and authored texture maps stay untouched. */
export class ArenaMaterials {
  private grades = new Map<THREE.Material, Map<ArenaSurface, THREE.MeshStandardMaterial>>();

  grade(source: THREE.Material, surface: ArenaSurface): THREE.Material {
    if (!(source instanceof THREE.MeshStandardMaterial)) return source;
    // Even a misplaced metallic prop must retain its real PBR identity.
    if (source.metalness > 0) return source;
    let variants = this.grades.get(source);
    if (!variants) {
      variants = new Map();
      this.grades.set(source, variants);
    }
    const existing = variants.get(surface);
    if (existing) return existing;
    const grade = source.clone();
    const profile = SURFACES[surface];
    grade.color.setHex(profile.color);
    grade.roughness = Math.max(source.roughness, profile.roughness);
    grade.envMapIntensity = 0.35;
    variants.set(surface, grade);
    return grade;
  }

  apply(object: THREE.Object3D, model: string): void {
    const surface = arenaSurface(model);
    if (!surface) return;
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.material = Array.isArray(child.material)
        ? child.material.map((material) => this.grade(material, surface))
        : this.grade(child.material, surface);
    });
  }

  dispose(): void {
    for (const variants of this.grades.values())
      for (const material of variants.values()) material.dispose();
    this.grades.clear();
  }
}

/** Stable, small albedo variation within existing floor draw groups. Geometry,
 * floor type and simulation randomness are independent of this cosmetic tint. */
export function floorVariation(x: number, z: number, out: THREE.Color): THREE.Color {
  const value = 0.96 + hash2(x / 4 + 31, z / 4 + 73) * 0.08;
  const warmth = (hash2(z / 4 + 17, x / 4 + 59) - 0.5) * 0.012;
  return out.setRGB(value + warmth, value, value - warmth);
}
