import * as THREE from "three";

import { applyMaterialBreakup, CITY_BREAKUP } from "../render/material-breakup";
import { isCoarsePointer, liveQuality } from "../render/quality";
import {
  buildParcelGeometry,
  type DetailLevel,
  type ParcelGeo,
  type ParcelGeoStats,
  type ParcelMaterial,
  tierDistance,
} from "./parcel-mesh";
import type { ParcelPlan } from "./parcel-plan";

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
  roughness: 0.32,
  metalness: 0.25,
});
GLASS_DARK.name = "parcel-glass";

// The lit panes: the same glass by day; at night the emissive comes up with
// the lamp factor (day-night.ts), warm, over a vertex colour that is a dark
// blue-grey — so the glow is the emissive, not the albedo.
const GLASS_LIT = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.32,
  metalness: 0.25,
  emissive: new THREE.Color(0xffc978),
  emissiveIntensity: 0,
});
GLASS_LIT.name = "parcel-glass-lit";

const NIGHT_EMISSIVE = 2.6;

/** Lamp factor 0 (day) .. 1 (night) — window glow tracks it. */
export function setParcelNight(night: number): void {
  GLASS_LIT.emissiveIntensity = NIGHT_EMISSIVE * Math.max(0, Math.min(1, night));
}

function materialFor(mat: ParcelMaterial): THREE.MeshStandardMaterial {
  switch (mat) {
    case "wall":
      return WALL;
    case "glassLit":
      return GLASS_LIT;
    case "glassDark":
      return GLASS_DARK;
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
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Meshes for the plan, grouped per stream tile and cull band so the caller
 * can hand them to the chunk streamer as-is.
 */
export async function buildParcelFabric(
  plans: readonly ParcelPlan[],
  bands: ParcelBands,
  detail: DetailLevel,
  onBreathe?: () => Promise<void>,
): Promise<ParcelBuild> {
  const { geos, stats } = await buildParcelGeometry(plans, detail, onBreathe);
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
  return { chunks: [...groups.values()], stats };
}
