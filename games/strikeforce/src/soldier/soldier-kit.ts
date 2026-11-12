// The two soldier kits: palettes, the merged limb geometry and the camo
// material, built once per kit and shared by every soldier wearing it.
import {
  BoxGeometry,
  BufferAttribute,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import type { BufferGeometry } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type Kit = "operator" | "garrison";

interface Palette {
  fabric: string;
  /** The two camo blotch tones laid over fabric. */
  camo: readonly [string, string];
  vest: string;
  pouch: string;
  helmet: string;
  mask: string;
  glove: string;
  boot: string;
  lens: string;
  band: string;
}

const PALETTES: Record<Kit, Palette> = {
  garrison: {
    band: "#c0352b",
    boot: "#1b1c1f",
    camo: ["#26282d", "#6e727b"],
    fabric: "#44474e",
    glove: "#26282c",
    helmet: "#2f3237",
    lens: "#b9c4d2",
    mask: "#141517",
    pouch: "#34373d",
    vest: "#2b2d32",
  },
  operator: {
    band: "#ffb347",
    boot: "#3b3127",
    camo: ["#5e523c", "#8f805f"],
    fabric: "#76694f",
    glove: "#3a352c",
    helmet: "#7a6c51",
    lens: "#ffb347",
    mask: "#2a2622",
    pouch: "#6f6b4f",
    vest: "#5f5e45",
  },
};

const GUNMETAL = "#1e2225";
const POLYMER = "#2b2e31";

// Heights in metres, feet at 0.
export const HIP_Y = 0.92;
export const KNEE_DROP = 0.45;
export const SHOULDER_Y = 1.4;
export const NECK_Y = 1.5;

/** Where the rifle's muzzle sits in the arms group. */
export const MUZZLE = new Vector3(0.09, -0.05, -0.86);

interface PartOptions {
  at?: readonly [number, number, number];
  rot?: readonly [number, number, number];
  scale?: readonly [number, number, number];
  camo?: boolean;
}

/** Collects coloured primitives and merges them into one limb mesh. */
class Limb {
  private readonly parts: BufferGeometry[] = [];

  add(geometry: BufferGeometry, color: string, options: PartOptions = {}): this {
    const [x, y, z] = options.at ?? [0, 0, 0];
    const [rx, ry, rz] = options.rot ?? [0, 0, 0];
    const [sx, sy, sz] = options.scale ?? [1, 1, 1];
    geometry.applyMatrix4(
      new Matrix4().compose(
        new Vector3(x, y, z),
        new Quaternion().setFromEuler(new Euler(rx, ry, rz)),
        new Vector3(sx, sy, sz),
      ),
    );
    this.paint(geometry, color, options.camo ?? false);
    return this;
  }

  /** A rounded segment from `a` to `b` (a forearm, a shin). */
  bone(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    radius: number,
    color: string,
    camo = false,
  ): this {
    const from = new Vector3(...a);
    const dir = new Vector3(...b).sub(from);
    const length = dir.length();
    const geometry = new CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 4, 10);
    geometry.applyMatrix4(
      new Matrix4().compose(
        from.clone().addScaledVector(dir, 0.5),
        new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize()),
        new Vector3(1, 1, 1),
      ),
    );
    this.paint(geometry, color, camo);
    return this;
  }

  build(): BufferGeometry {
    const merged = mergeGeometries(this.parts);
    for (const part of this.parts) {
      part.dispose();
    }
    return merged;
  }

  private paint(geometry: BufferGeometry, color: string, camo: boolean): void {
    const { count } = geometry.getAttribute("position");
    const c = new Color(color);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    geometry.setAttribute(
      "camo",
      new BufferAttribute(new Float32Array(count).fill(camo ? 1 : 0), 1),
    );
    this.parts.push(geometry);
  }
}

const box = (w: number, h: number, d: number): BoxGeometry => new BoxGeometry(w, h, d);

export interface KitGeometry {
  pelvis: BufferGeometry;
  torso: BufferGeometry;
  head: BufferGeometry;
  thigh: BufferGeometry;
  shin: BufferGeometry;
  arms: BufferGeometry;
}

const buildKit = (p: Palette): KitGeometry => {
  const pelvis = new Limb()
    .add(new CapsuleGeometry(0.13, 0.08, 4, 12), p.fabric, {
      at: [0, HIP_Y + 0.02, 0],
      camo: true,
      rot: [0, 0, Math.PI / 2],
      scale: [1, 1, 0.75],
    })
    .add(box(0.34, 0.05, 0.22), p.pouch, { at: [0, HIP_Y + 0.1, 0] })
    .add(box(0.07, 0.11, 0.06), p.pouch, { at: [0.19, HIP_Y + 0.02, -0.02] })
    .build();

  const torso = new Limb()
    .add(new CapsuleGeometry(0.15, 0.3, 4, 12), p.fabric, {
      at: [0, 1.22, 0],
      camo: true,
      scale: [1.1, 1, 0.72],
    })
    .add(box(0.36, 0.34, 0.26), p.vest, { at: [0, 1.25, 0] })
    .add(box(0.3, 0.06, 0.32), p.vest, { at: [0, 1.06, 0] })
    // Front pouches and a med patch, a radio and a hydration pack behind.
    .add(box(0.09, 0.12, 0.05), p.pouch, { at: [-0.1, 1.16, -0.17] })
    .add(box(0.09, 0.12, 0.05), p.pouch, { at: [0, 1.16, -0.17] })
    .add(box(0.09, 0.12, 0.05), p.pouch, { at: [0.1, 1.16, -0.17] })
    .add(box(0.12, 0.1, 0.04), p.pouch, { at: [-0.06, 1.33, -0.165] })
    .add(box(0.045, 0.015, 0.01), p.band, { at: [-0.06, 1.34, -0.188] })
    .add(box(0.015, 0.045, 0.01), p.band, { at: [-0.06, 1.34, -0.188] })
    .add(box(0.1, 0.18, 0.06), p.pouch, { at: [0.13, 1.3, 0.17] })
    .add(new CylinderGeometry(0.008, 0.008, 0.22, 5), GUNMETAL, { at: [0.15, 1.48, 0.17] })
    .add(box(0.26, 0.32, 0.08), p.vest, { at: [0, 1.24, 0.18] })
    // Shoulders and collar.
    .add(new SphereGeometry(0.07, 10, 8), p.fabric, { at: [-0.2, SHOULDER_Y, 0], camo: true })
    .add(new SphereGeometry(0.07, 10, 8), p.fabric, { at: [0.2, SHOULDER_Y, 0], camo: true })
    .add(box(0.14, 0.06, 0.1), p.vest, { at: [-0.15, 1.44, 0] })
    .add(box(0.14, 0.06, 0.1), p.vest, { at: [0.15, 1.44, 0] })
    .add(new CylinderGeometry(0.075, 0.09, 0.08, 10), p.fabric, { at: [0, NECK_Y - 0.02, 0] })
    .build();

  // The head group's origin is the neck.
  const head = new Limb()
    .add(new CylinderGeometry(0.055, 0.06, 0.08, 10), p.mask, { at: [0, 0.03, 0] })
    .add(new SphereGeometry(0.105, 16, 12), p.mask, { at: [0, 0.13, 0] })
    // A cut ballistic helmet: a dome with side rails, ear cups, an NVG mount.
    .add(new SphereGeometry(0.128, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), p.helmet, {
      at: [0, 0.15, 0.01],
    })
    .add(box(0.025, 0.035, 0.13), p.helmet, { at: [-0.124, 0.15, 0.01] })
    .add(box(0.025, 0.035, 0.13), p.helmet, { at: [0.124, 0.15, 0.01] })
    .add(new CylinderGeometry(0.045, 0.045, 0.035, 12), POLYMER, {
      at: [-0.115, 0.1, 0.01],
      rot: [0, 0, Math.PI / 2],
    })
    .add(new CylinderGeometry(0.045, 0.045, 0.035, 12), POLYMER, {
      at: [0.115, 0.1, 0.01],
      rot: [0, 0, Math.PI / 2],
    })
    .add(box(0.06, 0.04, 0.03), POLYMER, { at: [0, 0.255, -0.105] })
    .add(new CylinderGeometry(0.014, 0.014, 0.05, 8), POLYMER, {
      at: [0.06, 0.25, -0.06],
      rot: [Math.PI / 2, 0, 0],
    })
    // Goggles and their strap.
    .add(box(0.2, 0.055, 0.04), POLYMER, { at: [0, 0.155, -0.1] })
    .add(box(0.18, 0.04, 0.02), p.lens, { at: [0, 0.155, -0.122] })
    .add(new CylinderGeometry(0.118, 0.118, 0.025, 16, 1, true), POLYMER, { at: [0, 0.155, 0] })
    .build();

  // Leg groups pivot at the hip; the shin group at the knee.
  const thigh = new Limb()
    .bone([0, 0.03, 0], [0, -KNEE_DROP, -0.01], 0.074, p.fabric, true)
    .add(box(0.07, 0.11, 0.05), p.pouch, { at: [0.07, -0.2, 0] })
    .build();
  const shin = new Limb()
    .bone([0, 0.04, -0.01], [0, -0.4, 0.02], 0.064, p.fabric, true)
    .add(box(0.11, 0.11, 0.05), POLYMER, { at: [0, 0, -0.06] })
    .add(box(0.12, 0.1, 0.27), p.boot, { at: [0, -0.43, -0.05] })
    .add(box(0.125, 0.03, 0.28), POLYMER, { at: [0, -0.475, -0.05] })
    .build();

  // Arms and the carbine move as one, pitching with the aim. The group's
  // origin is between the shoulders.
  const arms = new Limb()
    .bone([0.21, 0, 0.02], [0.25, -0.24, -0.06], 0.056, p.fabric, true)
    .add(new CylinderGeometry(0.062, 0.062, 0.05, 10), p.band, {
      at: [0.225, -0.1, 0],
      rot: [0, 0, 0.17],
    })
    .bone([0.25, -0.24, -0.06], [0.11, -0.1, -0.2], 0.05, p.fabric, true)
    .add(new SphereGeometry(0.048, 10, 8), p.glove, { at: [0.1, -0.1, -0.21] })
    .bone([-0.21, 0, 0.02], [-0.17, -0.24, -0.2], 0.056, p.fabric, true)
    .bone([-0.17, -0.24, -0.2], [0.07, -0.08, -0.45], 0.05, p.fabric, true)
    .add(new SphereGeometry(0.048, 10, 8), p.glove, { at: [0.08, -0.08, -0.47] })
    // Collapsible stock, receiver, magazine, rail and optic, handguard, barrel.
    .add(box(0.05, 0.08, 0.2), POLYMER, { at: [0.12, -0.03, 0.06] })
    .add(new CylinderGeometry(0.014, 0.014, 0.16, 8), GUNMETAL, {
      at: [0.12, -0.02, -0.06],
      rot: [Math.PI / 2, 0, 0],
    })
    .add(box(0.055, 0.075, 0.3), GUNMETAL, { at: [0.1, -0.04, -0.25] })
    .add(box(0.04, 0.14, 0.07), GUNMETAL, { at: [0.1, -0.13, -0.27], rot: [0.25, 0, 0] })
    .add(box(0.035, 0.09, 0.04), POLYMER, { at: [0.1, -0.11, -0.16], rot: [-0.3, 0, 0] })
    .add(box(0.024, 0.016, 0.42), GUNMETAL, { at: [0.1, 0.005, -0.36] })
    .add(box(0.045, 0.05, 0.1), POLYMER, { at: [0.1, 0.035, -0.26] })
    .add(box(0.03, 0.026, 0.006), p.lens, { at: [0.1, 0.04, -0.312] })
    .add(box(0.06, 0.065, 0.28), POLYMER, { at: [0.1, -0.035, -0.53] })
    .add(new CylinderGeometry(0.012, 0.012, 0.2, 8), GUNMETAL, {
      at: [MUZZLE.x, MUZZLE.y + 0.01, -0.76],
      rot: [Math.PI / 2, 0, 0],
    })
    .add(new CylinderGeometry(0.018, 0.018, 0.05, 8), GUNMETAL, {
      at: [MUZZLE.x, MUZZLE.y + 0.01, MUZZLE.z + 0.02],
      rot: [Math.PI / 2, 0, 0],
    })
    .build();

  return { arms, head, pelvis, shin, thigh, torso };
};

const CAMO_GLSL = `
varying float vCamo;
varying vec3 vCamoP;
uniform vec3 uCamoA;
uniform vec3 uCamoB;
float camoHash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
float camoNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(camoHash(i), camoHash(i + vec3(1, 0, 0)), f.x),
        mix(camoHash(i + vec3(0, 1, 0)), camoHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(camoHash(i + vec3(0, 0, 1)), camoHash(i + vec3(1, 0, 1)), f.x),
        mix(camoHash(i + vec3(0, 1, 1)), camoHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

/** Vertex-coloured, with fabric (`camo` = 1) broken up into blotches. */
const kitMaterial = (kit: Kit, p: Palette): MeshStandardMaterial => {
  const material = new MeshStandardMaterial({
    metalness: 0.05,
    roughness: 0.84,
    vertexColors: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCamoA = { value: new Color(p.camo[0]) };
    shader.uniforms.uCamoB = { value: new Color(p.camo[1]) };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float camo;\nvarying float vCamo;\nvarying vec3 vCamoP;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvCamo = camo;\nvCamoP = position;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${CAMO_GLSL}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float camoA = step(0.57, camoNoise(vCamoP * 16.0));
        float camoB = step(0.6, camoNoise(vCamoP * 23.0 + 7.3));
        vec3 camo = mix(mix(diffuseColor.rgb, uCamoA, camoA), uCamoB, camoB * (1.0 - camoA));
        diffuseColor.rgb = mix(diffuseColor.rgb, camo, vCamo);`,
      );
  };
  // Both kits compile the same program; only their uniforms differ.
  material.customProgramCacheKey = () => `soldier-kit-${kit}`;
  return material;
};

export interface KitAssets {
  geometry: KitGeometry;
  material: MeshStandardMaterial;
}

const KITS = new Map<Kit, KitAssets>();

export const kitAssets = (kit: Kit): KitAssets => {
  let assets = KITS.get(kit);
  if (!assets) {
    const palette = PALETTES[kit];
    assets = { geometry: buildKit(palette), material: kitMaterial(kit, palette) };
    KITS.set(kit, assets);
  }
  return assets;
};
