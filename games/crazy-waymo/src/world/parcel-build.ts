import * as THREE from "three";

import { applyMaterialBreakup, CITY_BREAKUP } from "../render/material-breakup";
import { isCoarsePointer, liveQuality } from "../render/quality";
import {
  buildParcelGeometry,
  type DetailLevel,
  FACADE_SCALE,
  FUV_V_BIAS,
  type ParcelGeo,
  type ParcelGeoStats,
  type ParcelMaterial,
  tierDistance,
} from "./parcel-mesh";
import { TRAFFIC_CARS } from "../assets/manifest";
import { ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { Rng } from "../shared/rng";
import type { ParkedSpec } from "./furniture";
import { distToRing, type ParcelLot, type ParcelPlan, pointInRing } from "./parcel-plan";

// The parcel fabric is built LIVE on both load paths, like the freeways and
// piers — never captured into rest.bin. Three reasons, each sufficient:
//  - Payload. ~15k buildings of merged geometry is tens of megabytes in the
//    bins; the plan they are generated from is data the bundle already ships.
//  - Materials. A material only survives the bin round-trip as a descriptor
//    (colour, roughness, ...), so a shader hook on a baked material is lost —
//    the night-lit glass here is a live uniform on a live material.
//  - One source of truth. The harness regenerates the same plan headlessly and
//    audits it; there is no second copy in an artifact to drift.

const WALL = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.92,
  metalness: 0,
});
WALL.name = "parcel-wall";
applyMaterialBreakup(WALL, CITY_BREAKUP);

const GLASS_DARK = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.78,
  metalness: 0,
});
GLASS_DARK.name = "parcel-glass";

// The lit panes: the same glass by day; at night the emissive comes up with
// the lamp factor (day-night.ts), warm, over a vertex colour that is a dark
// blue-grey — so the glow is the emissive, not the albedo.
const GLASS_LIT = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.78,
  metalness: 0,
  emissive: new THREE.Color(0xffc978),
  emissiveIntensity: 0,
});
GLASS_LIT.name = "parcel-glass-lit";

const NIGHT_EMISSIVE = 2.6;

// --- The facade shader ------------------------------------------------------
// The lean fabric's walls carry their storey rhythm per vertex (parcel-mesh.ts
// FacadeBuf) and this material draws the openings: a window grid above the
// ground floor with a lighter frame, and on the ground floor a shopfront
// (SHOP), a garage door and a front door (HOUSE) or one roller door (SHED).
// Windows light at night per cell from a hash, on the buildings the seed
// says are lit. All of it in the fragment shader over the flat vertex colour,
// so the breakup and the specular AA from material-breakup.ts still apply.
const FACADE_NIGHT = { value: 0 };
const FACADE = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.92,
  metalness: 0,
});
FACADE.name = "parcel-facade";
applyMaterialBreakup(FACADE, CITY_BREAKUP);
{
  const prev = FACADE.onBeforeCompile;
  // Lazy: the breakup's key reads the device class, which only exists in a
  // window, and this module also loads in the harness and the workers.
  const prevKey = FACADE.customProgramCacheKey.bind(FACADE);
  FACADE.customProgramCacheKey = () => `${prevKey()}|facade`;
  FACADE.onBeforeCompile = (shader, renderer) => {
    prev.call(FACADE, shader, renderer);
    shader.uniforms.uFacadeNight = FACADE_NIGHT;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec2 fuv;
attribute vec4 facade;
attribute vec4 facade2;
varying vec2 vFuv;
varying vec4 vFacade;
varying vec4 vFacade2;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vFuv = fuv * 655.35 - vec2(0.0, ${FUV_V_BIAS.toFixed(1)});
vFacade = facade;
vFacade2 = facade2;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uFacadeNight;
varying vec2 vFuv;
varying vec4 vFacade;
varying vec4 vFacade2;
float facadeHash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
vec4 fF = vFacade * ${FACADE_SCALE.toFixed(1)};
float fStoreys = vFacade2.x;
float fSeed = vFacade2.y;
float fFlags = vFacade2.z;
bool fBlank = mod(floor(fFlags / 8.0), 2.0) > 0.5;
bool fShop = mod(fFlags, 2.0) > 0.5;
bool fHouse = mod(floor(fFlags / 2.0), 2.0) > 0.5;
bool fShed = mod(floor(fFlags / 4.0), 2.0) > 0.5;
float fu = vFuv.x - fF.w * 0.5;
float fv = vFuv.y;
vec3 fGlass = vec3(0.20, 0.26, 0.31);
vec3 fFrame = min(diffuseColor.rgb * 1.22 + 0.06, vec3(1.0));
float fLit = 0.0;
float fOpen = 0.0;
// Upper storeys: a window per cell, centred on the wall.
if (!fBlank && fv > fF.z && fF.x > 0.2) {
  float k = floor((fv - fF.z) / fF.x);
  float sy = fract((fv - fF.z) / fF.x);
  float span = fF.w - 0.4;
  float cells = max(1.0, floor(span / fF.y + 0.35));
  float cw = span / cells;
  float uu = fu + span * 0.5;
  float ci = floor(uu / cw);
  float sx = fract(uu / cw);
  bool fits = uu > 0.0 && uu < span && cw > 0.7;
  if (k < fStoreys - 1.0 && fits) {
    float ex = fF.y * 0.055;
    float ey = fF.x * 0.045;
    if (sx > 0.30 - ex && sx < 0.70 + ex && sy > 0.28 - ey && sy < 0.80 + ey) {
      bool inner = sx > 0.30 && sx < 0.70 && sy > 0.28 && sy < 0.80;
      diffuseColor.rgb = inner ? fGlass : fFrame;
      if (inner) {
        fOpen = 1.0;
        float onBuilding = step(0.34, fSeed / 255.0);
        fLit = onBuilding * step(0.62, facadeHash(vec3(ci, k, fSeed)));
      }
    }
  }
}
// Ground floor.
if (!fBlank && fv < fF.z) {
  float fHalf = fF.w * 0.5;
  if (fShop && fv > 0.12 && fv < fF.z - 0.42 && abs(fu) < fHalf - 0.25) {
    diffuseColor.rgb = fGlass * 0.85;
    fOpen = 1.0;
    fLit = step(0.25, fSeed / 255.0);
  } else if (fShop && fv >= fF.z - 0.42 && fv < fF.z - 0.1 && abs(fu) < fHalf - 0.2) {
    diffuseColor.rgb = diffuseColor.rgb * 0.55;
  } else if (fHouse && fHalf > 1.2) {
    float garageW = min(1.5, fHalf * 0.9);
    if (abs(fu - 0.45) < garageW * 0.5 && fv < 1.35) {
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.55, 0.56, 0.58), 0.8);
      if (abs(fract(fv / 0.34) - 0.5) < 0.06) diffuseColor.rgb *= 0.85;
    } else if (abs(fu + garageW * 0.5 + 0.6) < 0.27 && fv < 1.15) {
      diffuseColor.rgb = diffuseColor.rgb * 0.35;
    }
  } else if (fShed && abs(fu) < min(0.85, fHalf * 0.6) && fv < min(1.45, fF.z - 0.2)) {
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.44, 0.47), 0.85);
  }
}
vec3 fEmit = vec3(1.0, 0.78, 0.47) * (2.4 * uFacadeNight * fLit * fOpen);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
totalEmissiveRadiance += fEmit;`,
      );
  };
}

/** Lamp factor 0 (day) .. 1 (night) — window glow tracks it. */
export function setParcelNight(night: number): void {
  GLASS_LIT.emissiveIntensity = NIGHT_EMISSIVE * Math.max(0, Math.min(1, night));
  FACADE_NIGHT.value = Math.max(0, Math.min(1, night));
}

function materialFor(mat: ParcelMaterial): THREE.MeshStandardMaterial {
  switch (mat) {
    case "wall":
      return WALL;
    case "glassLit":
      return GLASS_LIT;
    case "glassDark":
      return GLASS_DARK;
    case "facade":
      return FACADE;
  }
}

export type ParcelChunk = {
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
  readonly dist: number;
  readonly group: THREE.Group;
};

export type ParcelBuild = {
  readonly chunks: readonly ParcelChunk[];
  readonly stats: ParcelGeoStats;
  /** Cars on the surface lots — punt-able bodies like the kerb parking. */
  readonly parkedCars: readonly ParkedSpec[];
};

export type ParcelBands = {
  readonly imposter: number;
  readonly midImposter: number;
  readonly detail: number;
};

/** Device-class detail: phones skip the bays, awnings and roof plant. */
export function parcelDetailLevel(): DetailLevel {
  if (typeof window === "undefined") return 2;
  return isCoarsePointer() ? 1 : 2;
}

function geometryOf(g: ParcelGeo): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(g.position, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(g.normal, 3, true));
  geo.setAttribute("color", new THREE.BufferAttribute(g.color, 3, true));
  geo.setIndex(new THREE.BufferAttribute(g.index, 1));
  if (g.fuv && g.facade && g.facade2) {
    geo.setAttribute("fuv", new THREE.BufferAttribute(g.fuv, 2, true));
    geo.setAttribute("facade", new THREE.BufferAttribute(g.facade, 4, true));
    geo.setAttribute("facade2", new THREE.BufferAttribute(g.facade2, 4, false));
  }
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Meshes for the plan, grouped per stream tile and cull band so the caller
 * can hand them to the chunk streamer as-is.
 */
export async function buildParcelFabric(
  plans: readonly ParcelPlan[],
  lots: readonly ParcelLot[],
  bands: ParcelBands,
  detail: DetailLevel,
  onBreathe?: () => Promise<void>,
): Promise<ParcelBuild> {
  const { geos, stats } = await buildParcelGeometry(plans, detail, onBreathe, lots);
  const detailDist = bands.detail * liveQuality().detailScale;
  const groups = new Map<string, ParcelChunk>();
  for (const g of geos) {
    const dist = tierDistance(g.tier, bands.imposter, bands.midImposter, detailDist);
    const key = `${g.cx},${g.cz},${dist}`;
    let chunk = groups.get(key);
    if (!chunk) {
      chunk = { cx: g.cx, cz: g.cz, radius: g.radius, dist, group: new THREE.Group() };
      chunk.group.name = `parcels-${g.tier}`;
      groups.set(key, chunk);
    }
    const mesh = new THREE.Mesh(geometryOf(g), materialFor(g.mat));
    mesh.name = `parcel-${g.tier}-${g.mat}`;
    // Bodies throw the street shadows; the decals and ledges only catch them.
    mesh.castShadow = g.tier !== "detail";
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    chunk.group.add(mesh);
  }
  return { chunks: [...groups.values()], stats, parkedCars: parkOnLots(lots, plans) };
}

// A car is ~2.75u long and 1.5u wide. Bays nose in toward the lot's long
// sides at the pitch the paint uses (parcel-mesh.ts BAY_PITCH); a lot too
// narrow for bays parks a single line along its length instead. Every spot
// is tested against the lot's own outline and its pillars, so a car never
// pokes into the street or stands in a footing.
const CAR_HALF_LEN = 1.4;
const CAR_HALF_W = 0.8;
const BAY_PITCH = 2.2;

/**
 * Buildings bucketed on the street grid, so a car can ask whether it would
 * stand inside one. A lot ring is often a GROUP outline (the extractor's
 * bbox fallback) with a real parcel's building inside it, and a car parked
 * through that building's wall is the one place the two passes meet.
 */
class BuildingIndex {
  private readonly cells = new Map<number, ParcelPlan[]>();
  constructor(plans: readonly ParcelPlan[]) {
    for (const p of plans) {
      const r = Math.hypot(p.obb.halfA, p.obb.halfB) + 1;
      for (let gx = this.gx(p.obb.cx - r); gx <= this.gx(p.obb.cx + r); gx++) {
        for (let gz = this.gz(p.obb.cz - r); gz <= this.gz(p.obb.cz + r); gz++) {
          const k = gx * 1024 + gz;
          const arr = this.cells.get(k);
          if (arr) arr.push(p);
          else this.cells.set(k, [p]);
        }
      }
    }
  }
  private gx(x: number): number {
    return Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
  }
  private gz(z: number): number {
    return Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
  }
  /** Inside any building's box, dilated by `pad`. */
  inside(x: number, z: number, pad: number): boolean {
    for (const p of this.cells.get(this.gx(x) * 1024 + this.gz(z)) ?? []) {
      const dx = x - p.obb.cx;
      const dz = z - p.obb.cz;
      const a = dx * p.obb.ex + dz * p.obb.ez;
      const b = -dx * p.obb.ez + dz * p.obb.ex;
      if (Math.abs(a) < p.obb.halfA + pad && Math.abs(b) < p.obb.halfB + pad) return true;
    }
    return false;
  }
}

function parkOnLots(lots: readonly ParcelLot[], plans: readonly ParcelPlan[]): ParkedSpec[] {
  const out: ParkedSpec[] = [];
  const buildings = new BuildingIndex(plans);
  for (const lot of lots) {
    const rng = new Rng(lot.seed ^ 0x51ed);
    const o = lot.obb;
    const long = o.halfA >= o.halfB;
    const lx = long ? o.ex : -o.ez;
    const lz = long ? o.ez : o.ex;
    const sx = long ? -o.ez : o.ex;
    const sz = long ? o.ex : o.ez;
    const halfL = long ? o.halfA : o.halfB;
    const halfS = long ? o.halfB : o.halfA;
    const clear = (x: number, z: number, r: number): boolean => {
      if (!pointInRing(lot.ring, lot.n, x, z)) return false;
      if (distToRing(lot.ring, lot.n, x, z) < r) return false;
      if (buildings.inside(x, z, CAR_HALF_LEN)) return false;
      for (const p of lot.pillars) {
        if (Math.hypot(p.x - x, p.z - z) < p.half + CAR_HALF_LEN + 0.4) return false;
      }
      return true;
    };
    const place = (x: number, z: number, nx: number, nz: number, r: number): void => {
      if (!clear(x, z, r) || !rng.chance(0.78)) return;
      out.push({
        x: x + rng.range(-0.1, 0.1),
        z: z + rng.range(-0.1, 0.1),
        yaw: Math.atan2(nx, nz) + rng.range(-0.05, 0.05),
        model: rng.pick(TRAFFIC_CARS),
      });
    };
    if (halfS * 2 >= 3.4) {
      const rows: number[] = halfS * 2 >= 5.6 ? [-1, 1] : [-1];
      for (const side of rows) {
        const b = side * (halfS - 0.5 - CAR_HALF_LEN);
        for (let a = -halfL + 1.2 + BAY_PITCH / 2; a <= halfL - 1.2; a += BAY_PITCH) {
          // Nose toward the long edge on this side.
          place(
            o.cx + lx * a + sx * b,
            o.cz + lz * a + sz * b,
            sx * side,
            sz * side,
            CAR_HALF_W + 0.2,
          );
        }
      }
    } else if (halfS * 2 >= 2.0) {
      for (let a = -halfL + CAR_HALF_LEN + 0.6; a <= halfL - CAR_HALF_LEN - 0.6; a += 3.4) {
        place(o.cx + lx * a, o.cz + lz * a, lx, lz, CAR_HALF_W + 0.1);
      }
    }
  }
  return out;
}
