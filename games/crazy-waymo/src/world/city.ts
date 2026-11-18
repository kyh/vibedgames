import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { geoLayoutKey } from "../assets/loader";
import type { ModelCache } from "../assets/loader";
import { modelUrl, TREE_LARGE, TREE_SMALL, GARAGE_MODEL } from "../assets/manifest";
import { registerBeacons } from "../fx/beacon-lights";
import { applyMaterialBreakup, CITY_BREAKUP } from "../render/material-breakup";
import { createTerrainMaterial } from "../render/terrain-material";
import { StaticWorldGroup } from "../render/static-world-group";
import { propShadowPolicy, propShadowsDisabled, setPropShadowPolicy } from "../render/prop-shadow";
import type { PropShadowPolicy } from "../render/prop-shadow";
import { drawDistance, isCoarsePointer, liveQuality, reachScale } from "../render/quality";
import { contextLostBefore } from "../render/safe-mode";
import { renderCapabilities } from "../render/capabilities";
import { releaseArraysAfterUpload } from "../render/gpu-only-geometry";
import { compatiblePropBatch } from "./instanced-props";
import type { PropBatch, PropInstance } from "./instanced-props";
import {
  CHUNK,
  CITY_SEED,
  GRID_X,
  GRID_Z,
  ROAD_TILE,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import { Rng } from "../shared/rng";
import { toFloat32Attributes } from "./conform";
import type { DrapeField } from "./conform";
import { activeMapProps } from "./map-file";
import { pickGarageSpots } from "./garages";
import type { Garage } from "./garages";
import { buildReservation } from "./reservation";
import { buildFurniture } from "./furniture";
import type { LampHead, ParkedSpec } from "./furniture";
import { buildGoldenGate, goldenGateBeacons, goldenGatePlan } from "./golden-gate";
import { RoadNetwork } from "./network";
import { generateCity } from "./grid";
import type { CityPlan } from "./grid";
import { CUSTOM_MAP, editorMode, loadLocalOverrides } from "./custom-map";
import {
  makeGroundBlendAt,
  makeGroundColorAt,
  makePaintedFloorAt,
  makeGroundOffset,
  makeStandingSurface,
  makeTerracedDrapeField,
} from "./ground";
import { buildShoreline, planShoreline } from "./shoreline";
import { makeLandClassAt, wheelSurface } from "./land-class";
import type { LandClassAt } from "./land-class";
import { buildGridNetwork } from "./grid-network";
import { buildRoads, ROAD_MATERIALS, roadCollapseTarget, roadPartsToMeshes } from "./roads";
import type { CityGenPayload } from "./gen-worker";
import { unpackSolids } from "./world-bin";
import type { CityRestMeta, PackedMergedChunk, PackedWorldTile } from "./world-bin";
import { fetchWorldTile } from "./world-fetch";
import { WorldTileStreamer } from "./world-tiles";
import {
  buildPackedGeometry,
  constantColorAttribute,
  packGeometry,
  seatPackedMesh,
} from "./quantized-geometry";
import { buildFreeways, isFreewayDeckContact, nearFreeway } from "./freeways";
import { buildPiers } from "./piers";
import { buildLandmarks, landmarkProtection } from "./landmarks";
import { SEA_Y, waterBodyContains, waterBedHeight } from "./water";
import type { WaterBody } from "./water";
import { surfaceDeckAt } from "./surface-decks";
import { carveWaterReservations } from "./water-reservations";
import { stowWaterHeightAt } from "./lake";
import { buildParcelFabric, parcelDetailLevel, parkOnLots } from "./parcel-build";
import { visibleParcelPlans } from "./parcel-visibility";
import { ParcelStreamer, streamRadiusFor } from "./parcel-stream";
import { frontSegment, emptyParcelPlan, planParcels } from "./parcel-plan";
import type { ParcelLot, ParcelPlan, ParcelPlanResult } from "./parcel-plan";
import { packLots, packPlans, unpackPlans } from "./parcel-pack";
import type { ParcelSource } from "./parcel-source";
import { buildParcelClearance } from "./parcel-clearance";
import type { ParcelClearance } from "./parcel-clearance";
import { buildTreeClearance } from "./tree-clearance";
import { districtAt, makeTerrain } from "./sf-map";
import type { Terrain } from "./terrain";
import type { Solid, SurfaceDeck } from "../shared/types";
import { DriveSurface } from "./surface";

export type { Garage } from "./garages";

export { type Solid, type SurfaceDeck } from "../shared/types";

export interface RoadCell {
  readonly gx: number;
  readonly gz: number;
}

interface OccBox {
  readonly x: number;
  readonly z: number;
  readonly hw: number;
  readonly hd: number;
  readonly cos: number;
  readonly sin: number;
  readonly row: number;
}

const OCC = 26;
const OCC_COLS = Math.ceil(WORLD_W / OCC) + 4;
const OCC_SLOP = 0.4;

const occBox = (x: number, z: number, hw: number, hd: number, yaw: number, row: number) => ({
  cos: Math.cos(yaw),
  hd,
  hw,
  row,
  sin: Math.sin(yaw),
  x,
  z,
});

const occSpan = (b: OccBox, visit: (key: number) => void) => {
  const rx = Math.abs(b.cos * b.hw) + Math.abs(b.sin * b.hd);
  const rz = Math.abs(b.sin * b.hw) + Math.abs(b.cos * b.hd);
  const x0 = Math.floor((b.x - rx + WORLD_HALF_X) / OCC);
  const x1 = Math.floor((b.x + rx + WORLD_HALF_X) / OCC);
  const z0 = Math.floor((b.z - rz + WORLD_HALF_Z) / OCC);
  const z1 = Math.floor((b.z + rz + WORLD_HALF_Z) / OCC);

  for (let ix = x0; ix <= x1; ix += 1) {
    for (let iz = z0; iz <= z1; iz += 1) {
      visit(ix + OCC_COLS * iz);
    }
  }
};

const boxesOverlap = (a: OccBox, b: OccBox) => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const ahw = Math.max(a.hw - OCC_SLOP, 0.05);
  const ahd = Math.max(a.hd - OCC_SLOP, 0.05);
  const bhw = Math.max(b.hw - OCC_SLOP, 0.05);
  const bhd = Math.max(b.hd - OCC_SLOP, 0.05);
  const ca = Math.abs(a.cos * b.cos + a.sin * b.sin);
  const sa = Math.abs(a.cos * b.sin - a.sin * b.cos);

  if (Math.abs(dx * a.cos + dz * a.sin) > ahw + bhw * ca + bhd * sa) {
    return false;
  }

  if (Math.abs(-dx * a.sin + dz * a.cos) > ahd + bhw * sa + bhd * ca) {
    return false;
  }

  if (Math.abs(dx * b.cos + dz * b.sin) > bhw + ahw * ca + ahd * sa) {
    return false;
  }

  if (Math.abs(-dx * b.sin + dz * b.cos) > bhd + ahw * sa + ahd * ca) {
    return false;
  }

  return true;
};

export type MatRec = {
  color: number;
  roughness: number;
  metalness: number;
  vertexColors: boolean;
  polygonOffset: boolean;
  polygonOffsetFactor: number;
  polygonOffsetUnits: number;
  transparent: boolean;
  opacity: number;
  /**
   * UNLIT (MeshBasicMaterial). The capture used to understand exactly one
   * material class, so the first builder to reach for an unlit one — the
   * Golden Gate's tower lamps, which must survive the night grade — cleared
   * `restComplete` and the world stopped baking for everybody. Optional so
   * older rest payloads deserialize unchanged.
   */
  unlit?: boolean;
  toneMapped?: boolean;
  propShadow?: PropShadowPolicy;
};

/** A merged chunk as it ships and draws: quantized (world/quantized-geometry.ts). */
export type MergedChunkRec = PackedMergedChunk;

export interface BatchItemRec {
  url: string | null;
  idx: number;
  raw: number | null;
  m: Float32Array;
  tint: number | null;
  big: boolean;
}

export interface RawGeoRec {
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  index: Uint16Array | Uint32Array | null;
  mat: MatRec;
}

export interface CityRestPayload {
  mergedChunks: MergedChunkRec[];
  rawGeos: RawGeoRec[];
  batchItems: BatchItemRec[];
  solids: Solid[];
  parkedCars: ParkedSpec[];
  lampHeads: LampHead[];
  decks: readonly SurfaceDeck[];
}

interface ChunkMeshGroup {
  readonly group: THREE.Group;
  readonly cx: number;
  readonly cz: number;
  readonly dist: number;
}

type BakedMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;

export const materialFactory = () => {
  const mats = new Map<string, BakedMaterial>();

  return (m: MatRec) => {
    const k = JSON.stringify(m);
    let mat = mats.get(k);

    if (!mat) {
      mat = m.unlit
        ? new THREE.MeshBasicMaterial({
            color: m.color,
            opacity: m.opacity,
            polygonOffset: m.polygonOffset,
            polygonOffsetFactor: m.polygonOffsetFactor,
            polygonOffsetUnits: m.polygonOffsetUnits,
            toneMapped: m.toneMapped ?? true,
            transparent: m.transparent,
            vertexColors: m.vertexColors,
          })
        : new THREE.MeshStandardMaterial({
            color: m.color,
            metalness: m.metalness,
            opacity: m.opacity,
            polygonOffset: m.polygonOffset,
            polygonOffsetFactor: m.polygonOffsetFactor,
            polygonOffsetUnits: m.polygonOffsetUnits,
            roughness: m.roughness,
            transparent: m.transparent,
            vertexColors: m.vertexColors,
          });

      if (m.propShadow !== undefined) {
        setPropShadowPolicy(mat, m.propShadow);
      }

      applyMaterialBreakup(mat, CITY_BREAKUP);
      mats.set(k, mat);
    }

    return mat;
  };
};

/** The MatRec for a material the capture understands, or null. */
export const matRecOf = (mat: THREE.Material) => {
  if (mat instanceof THREE.MeshStandardMaterial) {
    return {
      color: mat.color.getHex(),
      metalness: mat.metalness,
      opacity: mat.opacity,
      polygonOffset: mat.polygonOffset,
      polygonOffsetFactor: mat.polygonOffsetFactor,
      polygonOffsetUnits: mat.polygonOffsetUnits,
      propShadow: propShadowPolicy(mat),
      roughness: mat.roughness,
      transparent: mat.transparent,
      vertexColors: mat.vertexColors,
    };
  }

  if (mat instanceof THREE.MeshBasicMaterial) {
    return {
      color: mat.color.getHex(),
      metalness: 0,
      opacity: mat.opacity,
      polygonOffset: mat.polygonOffset,
      polygonOffsetFactor: mat.polygonOffsetFactor,
      polygonOffsetUnits: mat.polygonOffsetUnits,
      propShadow: propShadowPolicy(mat),
      roughness: 1,
      toneMapped: mat.toneMapped,
      transparent: mat.transparent,
      unlit: true,
      vertexColors: mat.vertexColors,
    };
  }

  return null;
};

const meshFromMergedChunk = (rec: MergedChunkRec, material: THREE.Material) => {
  const mesh = new THREE.Mesh(buildPackedGeometry(rec), material);
  seatPackedMesh(mesh, rec.pos);
  mesh.receiveShadow = true;

  return mesh;
};

const buildMergedChunkGroups: (options: {
  readonly records: readonly MergedChunkRec[];
  readonly cache: ModelCache;
  readonly materialFor: (m: MatRec) => BakedMaterial;
  readonly runtimeMaterials?: ReadonlyMap<MergedChunkRec, THREE.Material>;
  readonly breathe?: () => Promise<void>;
  readonly onRecord?: (done: number, total: number) => void;
}) => Promise<ChunkMeshGroup[]> = async (options) => {
  const groups = new Map<string, ChunkMeshGroup>();
  let n = 0;

  for (const rec of options.records) {
    const { breathe } = options;

    if (breathe) {
      await breathe();
    }

    n += 1;
    options.onRecord?.(n, options.records.length);
    const gk = `${rec.cx},${rec.cz},${rec.dist}`;
    let g = groups.get(gk);

    if (!g) {
      g = { cx: rec.cx, cz: rec.cz, dist: rec.dist, group: new THREE.Group() };
      groups.set(gk, g);
    }

    const runtimeMat = options.runtimeMaterials?.get(rec);

    if (runtimeMat) {
      const mesh = meshFromMergedChunk(rec, runtimeMat);
      mesh.castShadow = !propShadowsDisabled(runtimeMat, renderCapabilities().multiDraw);
      g.group.add(mesh);
      continue;
    }

    const road = rec.srcMat
      ? null
      : roadCollapseTarget(rec.mat.color, rec.mat.polygonOffset, rec.mat.vertexColors);

    if (road) {
      const mesh = meshFromMergedChunk(rec, road.mat);

      if (!rec.col) {
        mesh.geometry.setAttribute(
          "color",
          constantColorAttribute(rec.pos.q.length / 3, road.color),
        );
      }

      g.group.add(mesh);
      continue;
    }

    const srcM = rec.srcMat ? options.cache.srcMesh(rec.srcMat.url, rec.srcMat.idx) : null;
    const srcMatOk = srcM && !Array.isArray(srcM.material) ? srcM.material : null;
    const material = srcMatOk ?? options.materialFor(rec.mat);
    const mesh = meshFromMergedChunk(rec, material);

    if (propShadowPolicy(material) !== undefined) {
      mesh.castShadow = !propShadowsDisabled(material, renderCapabilities().multiDraw);
    }

    g.group.add(mesh);
  }

  return [...groups.values()];
};

interface BatchItem {
  geo: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  tint?: THREE.Color;
  src?: { url: string; idx: number };
}

interface BatchBucket {
  material: THREE.Material;
  geoVerts: Map<THREE.BufferGeometry, number>;
  items: BatchItem[];
  verts: number;
  indices: number;
}

export interface SolidSink {
  readonly add: (tile: number, solids: readonly Solid[]) => void;
  readonly remove: (tile: number) => void;
}

interface Chunk {
  cx: number;
  cz: number;
  radius: number;
  dist: number;
  group: THREE.Object3D;
  tile?: number;
}

/** Tiles are held this far out — just past the merged chunks' own draw distance. */
export const tileHoldRadius = () => drawDistance() + 60;

const NEAR_ALWAYS = 170;
export const DETAIL_DISTANCE = 440;
export const BIG_SILHOUETTE_H = 13;
const STREAM_CELL = 80;
const STREAM_PAD = STREAM_CELL * 0.71 + ROAD_TILE * 2;
export const MID_SILHOUETTE_H = 5;
const TALL_NO_IMPOSTER_H = 6;
const TALL_DETAIL_DISTANCE = 700;
export const MID_IMPOSTER_DISTANCE = 1100;
export const IMPOSTER_DISTANCE = 1400;
const imposterReach = () => (contextLostBefore() ? reachScale() : 1);
export const imposterDistance = () => IMPOSTER_DISTANCE * imposterReach();
export const midImposterDistance = () => MID_IMPOSTER_DISTANCE * imposterReach();
export const LANDMARK_HOLD_DISTANCE = IMPOSTER_DISTANCE;
const LANDMARK_MEMBER_MIN = 1;
const LANDMARK_SPAN_RATIO = 44;

interface LandmarkVolume {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly hold: number;
}

const landmarkHoldAt = (volumes: readonly LandmarkVolume[], p: THREE.Vector3) => {
  let hold = 0;

  for (const v of volumes) {
    if (p.x < v.minX || p.x > v.maxX || p.z < v.minZ || p.z > v.maxZ) {
      continue;
    }

    hold = Math.max(hold, v.hold);
  }

  return hold;
};

const nextFrame = () =>
  // oxlint-disable-next-line promise/avoid-new -- wraps requestAnimationFrame
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });

const nextFrameTask = () =>
  // oxlint-disable-next-line promise/avoid-new -- wraps requestAnimationFrame plus setTimeout
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });

const gpuOnlyGeometry = () => isCoarsePointer() && !editorMode();

const noFacade = () => false;

interface StreamPass {
  readonly camX: number;
  readonly camZ: number;
  readonly detail: number;
  readonly flagFar: Uint8Array;
  readonly flagLandmark: Uint8Array;
  readonly flagNear: Uint8Array;
  readonly flagTall: Uint8Array;
  readonly nx: number;
  readonly pad: number;
  readonly scale: number;
  readonly showAll: boolean;
  readonly tallDetail: number;
  readonly total: number;
}

const flipImposters = (
  flags: Uint8Array,
  key: number,
  vis: 0 | 1,
  instances: Map<number, number[]>,
  mesh: PropBatch,
) => {
  if (flags[key] === vis) {
    return;
  }

  flags[key] = vis;
  const list = instances.get(key);

  if (!list) {
    return;
  }

  for (const iid of list) {
    mesh.setVisibleAt(iid, vis === 1);
  }
};

const SCRATCH_SCALE = new THREE.Vector3();
const STREAM_MAT = new THREE.Matrix4();
const STREAM_FRUSTUM = new THREE.Frustum();
const STREAM_SPHERE = new THREE.Sphere();

const BUILDINGS_PREFIX = modelUrl("buildings", "").slice(0, -".glb".length);

interface ImposterSpec {
  key: number;
  mid: boolean;
  mat: THREE.Material;
  item: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4; tint?: THREE.Color };
}

interface BatchBuildCtx {
  readonly mode: "capture" | "restore";
  readonly multiDraw: boolean;
  readonly gpuOnly: boolean;
  readonly nx: number;
  readonly nz: number;
  readonly pos: THREE.Vector3;
  readonly volumes: readonly LandmarkVolume[];
  readonly landmarkKeys: Map<number, number>;
  readonly imposters: ImposterSpec[];
  readonly untagged: Map<string, number>;
}

const itemExtents = (item: BatchItem | undefined) => {
  if (!item) {
    return { extent: 3, worldH: 3 };
  }

  if (!item.geo.boundingBox) {
    item.geo.computeBoundingBox();
  }

  const sc = SCRATCH_SCALE.setFromMatrixScale(item.matrix);
  const bb = item.geo.boundingBox;
  const worldH = bb ? (bb.max.y - bb.min.y) * sc.y : 3;

  return {
    extent: bb ? Math.max((bb.max.x - bb.min.x) * sc.x, worldH, (bb.max.z - bb.min.z) * sc.z) : 3,
    worldH,
  };
};

const propTierOf: (
  item: BatchItem | undefined,
  worldH: number,
  hold: number,
) => "big" | "landmark" | "mid" | "near" | "tall" = (item, worldH, hold) => {
  if (hold > 0) {
    return "landmark";
  }

  if (worldH >= BIG_SILHOUETTE_H) {
    return "big";
  }

  if (worldH >= MID_SILHOUETTE_H && (item?.src?.url.startsWith(BUILDINGS_PREFIX) ?? false)) {
    return "mid";
  }

  if (worldH >= TALL_NO_IMPOSTER_H) {
    return "tall";
  }

  return "near";
};

const IMPOSTER_FALLBACK = new THREE.Color(0x97_a1_ae);
const ATLAS_SAMPLE = 128;
const IMPOSTER_COLOR = new THREE.Color();
const ATLAS_TEXEL = new THREE.Color();
const ALBEDO_A = new THREE.Vector3();
const ALBEDO_B = new THREE.Vector3();
const ALBEDO_C = new THREE.Vector3();

interface AtlasPixels {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

interface AlbedoParts {
  all: THREE.Color;
  roof: THREE.Color;
  wall: THREE.Color;
}

const atlasPixelCache = new Map<string, AtlasPixels | null>();
const meanAlbedoCache = new Map<string, AlbedoParts | null>();
const ALBEDO_N = new THREE.Vector3();

const drawableImage = (tex: THREE.Texture) => {
  const img: unknown = tex.image;

  if (globalThis.ImageBitmap !== undefined && img instanceof ImageBitmap) {
    return img;
  }

  if (globalThis.HTMLImageElement !== undefined && img instanceof HTMLImageElement) {
    return img;
  }

  if (globalThis.HTMLCanvasElement !== undefined && img instanceof HTMLCanvasElement) {
    return img;
  }

  return null;
};

const atlasPixels = (tex: THREE.Texture) => {
  const cached = atlasPixelCache.get(tex.uuid);

  if (cached !== undefined) {
    return cached;
  }

  let out: AtlasPixels | null = null;
  const img = drawableImage(tex);

  if (img) {
    try {
      const w = Math.max(1, Math.min(ATLAS_SAMPLE, img.width));
      const h = Math.max(1, Math.min(ATLAS_SAMPLE, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, w, h);
        out = { data: ctx.getImageData(0, 0, w, h).data, h, w };
      }
    } catch {
      out = null;
    }
  }

  atlasPixelCache.set(tex.uuid, out);

  return out;
};

const meanAlbedo = (geo: THREE.BufferGeometry, tex: THREE.Texture) => {
  const cacheKey = `${geo.uuid}|${tex.uuid}`;
  const cached = meanAlbedoCache.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  let out: AlbedoParts | null = null;
  const px = atlasPixels(tex);
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");

  if (px && pos && uv) {
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    let wSum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let roofSum = 0;
    let rr = 0;
    let rg = 0;
    let rb = 0;
    let wallSum = 0;
    let wr = 0;
    let wg = 0;
    let wb = 0;

    for (let t = 0; t + 2 < count; t += 3) {
      const i0 = idx ? idx.getX(t) : t;
      const i1 = idx ? idx.getX(t + 1) : t + 1;
      const i2 = idx ? idx.getX(t + 2) : t + 2;
      ALBEDO_A.fromBufferAttribute(pos, i0);
      ALBEDO_B.fromBufferAttribute(pos, i1).sub(ALBEDO_A);
      ALBEDO_C.fromBufferAttribute(pos, i2).sub(ALBEDO_A);
      ALBEDO_N.copy(ALBEDO_B).cross(ALBEDO_C);
      const area = ALBEDO_N.length() * 0.5;

      if (area <= 0) {
        continue;
      }

      const up = ALBEDO_N.y / (area * 2);
      const su = ((uv.getX(i0) + uv.getX(i1) + uv.getX(i2)) / 3) * tex.repeat.x + tex.offset.x;
      const sv = ((uv.getY(i0) + uv.getY(i1) + uv.getY(i2)) / 3) * tex.repeat.y + tex.offset.y;
      const fu = su - Math.floor(su);
      const fv0 = sv - Math.floor(sv);
      const fv = tex.flipY ? 1 - fv0 : fv0;
      const col = Math.min(px.w - 1, Math.floor(fu * px.w));
      const row = Math.min(px.h - 1, Math.floor(fv * px.h));
      const o = (row * px.w + col) * 4;
      ATLAS_TEXEL.setRGB(
        (px.data[o] ?? 0) / 255,
        (px.data[o + 1] ?? 0) / 255,
        (px.data[o + 2] ?? 0) / 255,
        tex.colorSpace,
      );
      wSum += area;
      r += ATLAS_TEXEL.r * area;
      g += ATLAS_TEXEL.g * area;
      b += ATLAS_TEXEL.b * area;

      if (up > 0.5) {
        roofSum += area;
        rr += ATLAS_TEXEL.r * area;
        rg += ATLAS_TEXEL.g * area;
        rb += ATLAS_TEXEL.b * area;
      } else if (up > -0.5) {
        wallSum += area;
        wr += ATLAS_TEXEL.r * area;
        wg += ATLAS_TEXEL.g * area;
        wb += ATLAS_TEXEL.b * area;
      }
    }

    if (wSum > 0) {
      const all = new THREE.Color().setRGB(r / wSum, g / wSum, b / wSum);
      out = {
        all,
        roof:
          roofSum > 0
            ? new THREE.Color().setRGB(rr / roofSum, rg / roofSum, rb / roofSum)
            : all.clone(),
        wall:
          wallSum > 0
            ? new THREE.Color().setRGB(wr / wallSum, wg / wallSum, wb / wallSum)
            : all.clone(),
      };
    }
  }

  meanAlbedoCache.set(cacheKey, out);

  return out;
};

const imposterColorInto = (
  out: THREE.Color,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  tint: THREE.Color | undefined,
) => {
  if (mat instanceof THREE.MeshStandardMaterial) {
    const albedo = mat.map ? meanAlbedo(geo, mat.map) : null;

    if (albedo) {
      out.copy(albedo.all).multiply(mat.color);
    } else if (mat.map) {
      out.copy(IMPOSTER_FALLBACK);
    } else {
      out.copy(mat.color);
    }
  } else {
    out.copy(IMPOSTER_FALLBACK);
  }

  if (tint) {
    out.multiply(tint);
  }

  return out;
};

const IMPOSTER_RATIO_MIN = 0.55;
const IMPOSTER_RATIO_MAX = 1.7;
const imposterBoxCache = new Map<string, THREE.BufferGeometry>();

const imposterRatio = (p: number, a: number) =>
  a <= 0.0001 ? 1 : Math.min(IMPOSTER_RATIO_MAX, Math.max(IMPOSTER_RATIO_MIN, p / a));

const ratioInto = (out: THREE.Color, part: THREE.Color, all: THREE.Color) =>
  out.setRGB(
    imposterRatio(part.r, all.r),
    imposterRatio(part.g, all.g),
    imposterRatio(part.b, all.b),
  );

const imposterBox = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
  const map = mat instanceof THREE.MeshStandardMaterial ? mat.map : null;
  const albedo = map ? meanAlbedo(geo, map) : null;
  const key = albedo ? `${geo.uuid}|${map?.uuid ?? ""}` : "flat";
  const cached = imposterBoxCache.get(key);

  if (cached) {
    return cached;
  }

  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const pos = box.getAttribute("position");
  const nor = box.getAttribute("normal");
  const colors = new Float32Array(pos.count * 3);
  const roof = new THREE.Color(1, 1, 1);
  const wall = new THREE.Color(1, 1, 1);

  if (albedo) {
    ratioInto(roof, albedo.roof, albedo.all);
    ratioInto(wall, albedo.wall, albedo.all);
  }

  for (let i = 0; i < pos.count; i += 1) {
    const c = nor.getY(i) > 0.5 ? roof : wall;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  box.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  imposterBoxCache.set(key, box);

  return box;
};

const splitGeoByChunk = (geo: THREE.BufferGeometry, nx: number, nz: number) => {
  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  const uv = geo.getAttribute("uv");
  const col = geo.getAttribute("color");
  const idx = geo.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const vid = (k: number) => (idx ? idx.getX(k) : k);

  interface Piece {
    map: Map<number, number>;
    pos: number[];
    nor: number[];
    uv: number[];
    col: number[];
    index: number[];
  }

  const pieces = new Map<number, Piece>();

  for (let t = 0; t < triCount; t += 1) {
    const a = vid(t * 3);
    const b = vid(t * 3 + 1);
    const c = vid(t * 3 + 2);
    const mx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const mz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const cx = Math.min(nx - 1, Math.max(0, Math.floor((mx + WORLD_HALF_X) / CHUNK)));
    const cz = Math.min(nz - 1, Math.max(0, Math.floor((mz + WORLD_HALF_Z) / CHUNK)));
    const key = cz * nx + cx;
    let piece = pieces.get(key);

    if (!piece) {
      piece = { col: [], index: [], map: new Map(), nor: [], pos: [], uv: [] };
      pieces.set(key, piece);
    }

    for (const v of [a, b, c]) {
      let nid = piece.map.get(v);

      if (nid === undefined) {
        nid = piece.pos.length / 3;
        piece.map.set(v, nid);
        piece.pos.push(pos.getX(v), pos.getY(v), pos.getZ(v));

        if (nor) {
          piece.nor.push(nor.getX(v), nor.getY(v), nor.getZ(v));
        }

        if (uv) {
          piece.uv.push(uv.getX(v), uv.getY(v));
        }

        if (col) {
          piece.col.push(col.getX(v), col.getY(v), col.getZ(v));
        }
      }

      piece.index.push(nid);
    }
  }

  const out = new Map<number, THREE.BufferGeometry>();

  for (const [key, piece] of pieces) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(piece.pos), 3));

    if (nor) {
      g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(piece.nor), 3));
    }

    if (uv) {
      g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(piece.uv), 2));
    }

    if (col) {
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(piece.col), 3));
    }

    const IndexArr = piece.pos.length / 3 > 65_535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new IndexArr(piece.index), 1));
    out.set(key, g);
  }

  return out;
};

const mergeByMaterial = (meshes: readonly THREE.Mesh[]) => {
  interface Group {
    material: THREE.Material;
    attrs: string;
    geometries: THREE.BufferGeometry[];
  }

  const groups = new Map<string, Group>();

  for (const mesh of meshes) {
    const mat = mesh.material;

    if (Array.isArray(mat)) {
      continue;
    }

    const geo = mesh.geometry;

    if (!(geo instanceof THREE.BufferGeometry)) {
      continue;
    }

    const baked = geo.clone();
    toFloat32Attributes(baked);
    baked.applyMatrix4(mesh.matrixWorld);
    const wanted = new Set(["position", "normal", "uv", "color"]);

    for (const name of Object.keys(baked.attributes)) {
      if (!wanted.has(name)) {
        baked.deleteAttribute(name);
      }
    }

    if (!baked.getAttribute("uv") && baked.getAttribute("position")) {
      const { count } = baked.getAttribute("position");
      baked.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }

    const attrs = ["position", "normal", "uv", "color"]
      .filter((n) => baked.getAttribute(n))
      .join(",");

    const key = `${mat.uuid}|${attrs}|${baked.index ? "i" : "n"}`;
    const g = groups.get(key);

    if (g) {
      g.geometries.push(baked);
    } else {
      groups.set(key, { attrs, geometries: [baked], material: mat });
    }
  }

  const out: THREE.Mesh[] = [];

  for (const g of groups.values()) {
    const merged = mergeGeometries(g.geometries, false);

    if (!merged) {
      for (const geo of g.geometries) {
        const m = new THREE.Mesh(geo, g.material);
        m.castShadow = true;
        m.receiveShadow = true;
        out.push(m);
      }

      continue;
    }

    const mesh = new THREE.Mesh(merged, g.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.push(mesh);
  }

  return out;
};

const bucketForMerge = (
  mesh: THREE.Mesh,
  mat: THREE.Material | THREE.Material[],
  nx: number,
  nz: number,
  buckets: Map<number, THREE.Mesh[]>,
  centroid: THREE.Vector3,
) => {
  const push = (key: number, m: THREE.Mesh) => {
    const list = buckets.get(key);

    if (list) {
      list.push(m);
    } else {
      buckets.set(key, [m]);
    }
  };

  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  const spanX = bb ? bb.max.x - bb.min.x : 0;
  const spanZ = bb ? bb.max.z - bb.min.z : 0;

  if (!Array.isArray(mat) && Math.max(spanX, spanZ) > CHUNK * 1.5) {
    mesh.updateMatrixWorld(true);
    const world = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);

    for (const [key, g] of splitGeoByChunk(world, nx, nz)) {
      const piece = new THREE.Mesh(g, mat);
      piece.userData.merge = true;

      if (mesh.userData.srcMat) {
        piece.userData.srcMat = mesh.userData.srcMat;
      }

      push(key, piece);
    }

    return;
  }

  bb?.getCenter(centroid);
  centroid.applyMatrix4(mesh.matrixWorld);
  const cx = Math.min(nx - 1, Math.max(0, Math.floor((centroid.x + WORLD_HALF_X) / CHUNK)));
  const cz = Math.min(nz - 1, Math.max(0, Math.floor((centroid.z + WORLD_HALF_Z) / CHUNK)));
  push(cz * nx + cx, mesh);
};

const bucketForBatch = (
  mesh: THREE.Mesh,
  mat: THREE.Material,
  buckets: Map<string, BatchBucket>,
) => {
  const geo = mesh.geometry;
  const bKey = `${mat.uuid}|${geoLayoutKey(geo)}`;
  let bucket = buckets.get(bKey);

  if (!bucket) {
    bucket = { geoVerts: new Map(), indices: 0, items: [], material: mat, verts: 0 };
    buckets.set(bKey, bucket);
  }

  if (!bucket.geoVerts.has(geo)) {
    const vCount = geo.attributes.position?.count ?? 0;
    bucket.geoVerts.set(geo, vCount);
    bucket.verts += vCount;
    bucket.indices += geo.index ? geo.index.count : vCount;
  }

  const tint = mesh.userData.tint instanceof THREE.Color ? mesh.userData.tint : undefined;
  const src = mesh.userData.src as { url: string; idx: number } | undefined;
  const item: BatchItem = { geo, matrix: mesh.matrixWorld.clone() };

  if (tint) {
    item.tint = tint;
  }

  if (src) {
    item.src = src;
  }

  bucket.items.push(item);
};

export class CityModel {
  readonly group = new StaticWorldGroup();
  readonly solids: Solid[] = [];
  private readonly landmarkWater: WaterBody[] = [];
  readonly roadCells: RoadCell[] = [];
  plan: CityPlan;
  readonly terrain: Terrain;
  network: RoadNetwork;
  parkedCarSpecs: readonly ParkedSpec[] = [];
  readonly garages: readonly Garage[];
  lampHeads: readonly LampHead[] = [];
  private chunks: Chunk[] = [];
  private groundOffsetCache: ((x: number, z: number) => number) | null = null;
  private groundOffsetNet: RoadNetwork | null = null;
  private groundOffset() {
    if (!this.groundOffsetCache || this.groundOffsetNet !== this.network) {
      this.groundOffsetCache = makeGroundOffset(this.network, this.terrain);
      this.groundOffsetNet = this.network;
    }

    return this.groundOffsetCache;
  }
  private landClassCache: LandClassAt | null = null;
  private paintedFloorAt = makePaintedFloorAt();
  private landClassPlan: CityPlan | null = null;
  private get landClassAt() {
    if (!this.landClassCache || this.landClassPlan !== this.plan) {
      this.landClassCache = makeLandClassAt(this.plan, this.terrain);
      this.landClassPlan = this.plan;
    }

    return this.landClassCache satisfies LandClassAt;
  }
  private standCache: ((x: number, z: number) => number) | null = null;
  private standNet: RoadNetwork | null = null;
  private standAt(x: number, z: number) {
    if (!this.standCache || this.standNet !== this.network) {
      this.standCache = makeStandingSurface(
        this.network,
        this.terrain,
        this.groundOffset(),
        this.roadDrape(),
      );
      this.standNet = this.network;
    }

    return this.standCache(x, z);
  }
  private roadDrapeCache: DrapeField | null = null;
  private roadDrapeNet: RoadNetwork | null = null;
  private roadDrape() {
    if (!this.roadDrapeCache || this.roadDrapeNet !== this.network) {
      this.roadDrapeCache = makeTerracedDrapeField(this.network, this.terrain);
      this.roadDrapeNet = this.network;
    }

    return this.roadDrapeCache;
  }
  private batches: { mesh: PropBatch; chunkIds: Uint16Array }[] = [];
  private batchChunkGrid = { nx: 1, nz: 1 };
  private chunkVisible: Uint8Array | null = null;
  private chunkInstancesNear = new Map<number, [number, number][]>();
  private chunkInstancesTall = new Map<number, [number, number][]>();
  private chunkInstancesLandmark = new Map<number, [number, number][]>();
  private chunkVisibleLandmark: Uint8Array | null = null;
  private chunkLandmarkHold: Float32Array | null = null;
  private imposterInstances = new Map<number, number[]>();
  private imposterMidInstances = new Map<number, number[]>();
  private imposterMesh: PropBatch | null = null;
  private imposterVisible: Uint8Array | null = null;
  private imposterMidVisible: Uint8Array | null = null;
  restCapture: CityRestPayload | null = null;
  private capturedMerged: MergedChunkRec[] = [];
  private capturedMergedMats = new Map<MergedChunkRec, THREE.Material>();
  private restItems: BatchItemRec[] = [];
  private restComplete = true;
  private rawGeos: RawGeoRec[] = [];
  private rawGeoIds = new Map<string, number>();
  private restSkipLogged = new Set<string>();

  private captureMerged(mesh: THREE.Mesh, cx: number, cz: number, dist: number) {
    const geo = mesh.geometry;
    const mat = mesh.material;

    if (Array.isArray(mat) || !(mat instanceof THREE.MeshStandardMaterial)) {
      return null;
    }

    const srcMat =
      (mesh.userData.srcMat as { url: string; idx: number } | undefined) ??
      (mat.map ? this.cache.srcOfMaterial(mat) : null);

    const restorable =
      srcMat !== null ||
      roadCollapseTarget(mat.color.getHex(), mat.polygonOffset, mat.vertexColors) !== null;

    const serializable = !mat.map || restorable;

    if (mat.map && !restorable) {
      this.restComplete = false;

      if (!this.restSkipLogged.has(mat.uuid)) {
        this.restSkipLogged.add(mat.uuid);
        console.log(`[city] merged mesh untagged texture: ${mat.name || mat.uuid}`);
      }
    }

    if (!geo.getAttribute("position")) {
      return null;
    }

    const rec: MergedChunkRec = {
      cx,
      cz,
      dist,
      ...packGeometry(geo),
      mat: {
        color: mat.color.getHex(),
        metalness: mat.metalness,
        opacity: mat.opacity,
        polygonOffset: mat.polygonOffset,
        polygonOffsetFactor: mat.polygonOffsetFactor,
        polygonOffsetUnits: mat.polygonOffsetUnits,
        propShadow: propShadowPolicy(mat),
        roughness: mat.roughness,
        transparent: mat.transparent,
        vertexColors: mat.vertexColors,
      },
      srcMat,
    };

    this.capturedMergedMats.set(rec, mat);

    if (serializable) {
      this.capturedMerged.push(rec);
    }

    return rec;
  }

  private async addMergedChunkRecords(
    records: readonly MergedChunkRec[],
    fallbacks: readonly THREE.Mesh[],
    cx: number,
    cz: number,
    dist: number,
    cullRadius: number,
  ) {
    const builtGroups = await buildMergedChunkGroups({
      cache: this.cache,
      materialFor: materialFactory(),
      records,
      runtimeMaterials: this.capturedMergedMats,
    });

    const chunkGroups = [...builtGroups];

    if (fallbacks.length > 0) {
      const [first] = chunkGroups;
      let target: ChunkMeshGroup;

      if (first) {
        target = first;
      } else {
        target = { cx, cz, dist, group: new THREE.Group() };
        chunkGroups.push(target);
      }

      for (const mesh of fallbacks) {
        target.group.add(mesh);
      }
    }

    for (const chunk of chunkGroups) {
      this.group.add(chunk.group);
      this.chunks.push({
        cx: chunk.cx,
        cz: chunk.cz,
        dist: chunk.dist,
        group: chunk.group,
        radius: cullRadius,
      });
    }
  }
  private chunkVisibleNear: Uint8Array | null = null;
  private chunkVisibleTall: Uint8Array | null = null;

  private restPayload: CityRestPayload | null = null;
  private restMeta: CityRestMeta | null = null;
  private tileStreamer: WorldTileStreamer | null = null;
  /** Collision boxes of the resident tiles, by tile key. `solids` holds the
   *  base set; the physics stream and the solid index take these per tile. */
  readonly tileSolids = new Map<number, readonly Solid[]>();
  private solidSink: SolidSink | null = null;
  private readonly bakedMaterialFor = materialFactory();

  private reservedCells: ReadonlySet<string> = new Set();
  private parcelSource: ParcelSource | null = null;
  /** The parcel source (world-fetch.ts fetchParcelSource) — the main-thread fallback's input. */
  setParcelSource(src: ParcelSource | null) {
    this.parcelSource = src;
  }
  private parcelPlanCache: ParcelPlanResult | null = null;
  /** The plan, computed off-thread (parcel-worker.ts) — set before initLate(). */
  setParcelPlan(plan: ParcelPlanResult | null) {
    this.parcelPlanCache = plan;
  }
  private parcelPlan() {
    if (!this.parcelPlanCache) {
      const source = this.parcelSource;

      if (!source) {
        this.parcelPlanCache = emptyParcelPlan();
        console.log("[city] parcels: no source — kit fabric only");

        return this.parcelPlanCache satisfies ParcelPlanResult;
      }

      const t0 = performance.now();
      this.parcelPlanCache = planParcels({
        network: this.network,
        reserved: this.reservedCells,
        source,
        standAt: (x, z) => this.standAt(x, z),
        terrain: this.terrain,
      });
      const s = this.parcelPlanCache.stats;
      console.log(
        `[city] parcels planned: ${s.built} built (${s.onRoad} in a lane, ${s.clipped} clipped away, ` +
          `${s.stacked} stacked, ${s.park} park, ${s.reserved} reserved, ${s.freeway} freeway, ` +
          `${s.folded} folded, ${s.straddle} straddling, ${s.cliff} cliff, ${s.water} water; ` +
          `${s.movedVerts} verts moved, ${s.stretched} stretched; ${s.underDeck} under a deck, ${s.boxed} boxed, ${s.split} split, ${s.lots} lots) ` +
          `${Math.round(performance.now() - t0)}ms`,
      );
    }

    return this.parcelPlanCache satisfies ParcelPlanResult;
  }
  private parcelStreamer: ParcelStreamer | null = null;
  /** The visible plan of a live build, for the bake. Null on the baked path. */
  parcelCapture: {
    readonly skyline: readonly ParcelPlan[];
    readonly fabric: readonly ParcelPlan[];
    /** Every plan, culled ones included — their collision boxes still stand. */
    readonly all: readonly ParcelPlan[];
    readonly lots: readonly ParcelLot[];
  } | null = null;
  parcelStreamStats() {
    return this.parcelStreamer?.stats() ?? null;
  }
  private async buildParcels() {
    const t0 = performance.now();
    const { plans, lots } = this.parcelPlan();
    const detail = parcelDetailLevel();
    const visible = visibleParcelPlans(plans);
    const skyline = visible.filter((p) => p.height >= BIG_SILHOUETTE_H);
    const fabric = visible.filter((p) => p.height < BIG_SILHOUETTE_H);

    const built = await buildParcelFabric(
      skyline,
      [],
      { detail: DETAIL_DISTANCE, imposter: imposterDistance(), midImposter: midImposterDistance() },
      detail,
      () => this.breathe(),
    );

    for (const c of built.chunks) {
      this.group.add(c.group);
      this.chunks.push({ cx: c.cx, cz: c.cz, dist: c.dist, group: c.group, radius: c.radius });
    }

    this.parcelStreamer = new ParcelStreamer(this.group, detail);
    this.parcelStreamer.addTile(0, packPlans(fabric), packLots(lots));

    for (const p of plans) {
      for (const so of p.solids) {
        this.solids.push(so);
      }
    }

    const cars = parkOnLots(lots, plans);
    this.parkedCarSpecs = [...this.parkedCarSpecs, ...cars];
    this.parcelCapture = { all: plans, fabric, lots, skyline };
    console.log(
      `[city] parcels: ${skyline.length} skyline buildings static (${built.stats.vertices} verts), ` +
        `${fabric.length} streamed over ${this.parcelStreamer.stats().cells} cells, ${lots.length} lots ` +
        `(${cars.length} cars) in ${Math.round(performance.now() - t0)}ms`,
    );
  }
  private lateRoadFallback: (() => void) | null = null;

  setRestPayload(p: CityRestPayload | null) {
    this.restPayload = p;
  }

  /** The baked city's untiled remainder (world-fetch.ts fetchWorldMeta) —
   *  set before initLate(). Its tiles stream in afterwards. */
  setRestMeta(m: CityRestMeta | null) {
    this.restMeta = m;
  }

  tileStreamStats() {
    return this.tileStreamer?.stats() ?? null;
  }

  /** Where tile solids go from now on; the tiles already resident are replayed. */
  setSolidSink(sink: SolidSink) {
    this.solidSink = sink;

    for (const [key, solids] of this.tileSolids) {
      sink.add(key, solids);
    }
  }

  /** Resolve once the tiles within `radius` of (x, z) are installed. */
  async streamGate(
    x: number,
    z: number,
    radius: number,
    onProgress?: (done: number, total: number) => void,
  ) {
    await this.tileStreamer?.ensure(x, z, radius, onProgress);
  }

  private readonly cache: ModelCache;
  private readonly genPayload: CityGenPayload | null;
  private readonly rng: Rng;

  constructor(
    cache: ModelCache,
    genPayload: CityGenPayload | null = null,
    rng = new Rng(CITY_SEED),
  ) {
    this.cache = cache;
    this.genPayload = genPayload;
    this.rng = rng;
    this.terrain = makeTerrain();
    this.plan = generateCity();
    const local = loadLocalOverrides();

    const streetEdits =
      CUSTOM_MAP.add.length > 0 ||
      CUSTOM_MAP.remove.length > 0 ||
      local.add.length > 0 ||
      local.remove.length > 0;

    if (streetEdits) {
      const gridNet = buildGridNetwork(
        this.plan,
        (gx) => this.worldX(gx),
        (gz) => this.worldZ(gz),
      );

      this.network = new RoadNetwork(gridNet.nodes, gridNet.edges);
    } else {
      this.network = new RoadNetwork();
    }

    this.garages = pickGarageSpots(this.plan, this.terrain, this.network);
  }

  rebuildStreetsLive(root: THREE.Object3D) {
    this.plan = generateCity();

    const gridNet = buildGridNetwork(
      this.plan,
      (gx) => this.worldX(gx),
      (gz) => this.worldZ(gz),
    );

    this.network = new RoadNetwork(gridNet.nodes, gridNet.edges);
    const roadMats = new Set(Object.values(ROAD_MATERIALS));
    const doomed: THREE.Mesh[] = [];
    root.traverse((o) => {
      if (
        o instanceof THREE.Mesh &&
        o.material instanceof THREE.Material &&
        roadMats.has(o.material)
      ) {
        doomed.push(o);
      }
    });

    for (const m of doomed) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }

    for (const m of buildRoads(this.network, this.roadDrape())) {
      root.add(m);
    }
  }

  // oxlint-disable-next-line class-methods-use-this -- instance API, see above
  worldX(gx: number) {
    return (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
  }
  // oxlint-disable-next-line class-methods-use-this -- instance API, see worldX
  worldZ(gz: number) {
    return (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
  }
  // oxlint-disable-next-line class-methods-use-this -- instance API, see worldX
  gridX(x: number) {
    return Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
  }
  // oxlint-disable-next-line class-methods-use-this -- instance API, see worldX
  gridZ(z: number) {
    return Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
  }

  private onAsphalt(x: number, z: number, margin = 0.2) {
    const hit = this.network.nearest(x, z, ROAD_TILE * 1.4);

    return hit !== null && hit.dist < hit.edge.half + margin;
  }

  private fitRectOffAsphalt(
    cx: number,
    cz: number,
    ex: number,
    ez: number,
    halfA: number,
    halfB: number,
    margin: number,
    minSide: number,
  ) {
    const at = (a: number, b: number) =>
      this.onAsphalt(cx + a * ex - b * ez, cz + a * ez + b * ex, margin);

    const sideHit = (axis: 0 | 1, value: number, from: number, to: number) => {
      for (let i = 0; i <= 4; i += 1) {
        const t = from + ((to - from) * i) / 4;

        if (axis === 0 ? at(value, t) : at(t, value)) {
          return true;
        }
      }

      return false;
    };

    let a0 = -halfA;
    let a1 = halfA;
    let b0 = -halfB;
    let b1 = halfB;
    const STEP = 1;

    for (let iter = 0; iter < 10; iter += 1) {
      let moved = false;

      if (sideHit(0, a0, b0, b1)) {
        a0 += STEP;
        moved = true;
      }

      if (sideHit(0, a1, b0, b1)) {
        a1 -= STEP;
        moved = true;
      }

      if (sideHit(1, b0, a0, a1)) {
        b0 += STEP;
        moved = true;
      }

      if (sideHit(1, b1, a0, a1)) {
        b1 -= STEP;
        moved = true;
      }

      if (!moved) {
        break;
      }

      if (a1 - a0 < minSide || b1 - b0 < minSide) {
        return null;
      }
    }

    if (a1 - a0 < minSide || b1 - b0 < minSide) {
      return null;
    }

    if (sideHit(0, a0, b0, b1) || sideHit(0, a1, b0, b1)) {
      return null;
    }

    if (sideHit(1, b0, a0, a1) || sideHit(1, b1, a0, a1)) {
      return null;
    }

    const ma = (a0 + a1) / 2;
    const mb = (b0 + b1) / 2;

    return {
      cx: cx + ma * ex - mb * ez,
      cz: cz + ma * ez + mb * ex,
      halfA: (a1 - a0) / 2,
      halfB: (b1 - b0) / 2,
    };
  }

  async init(onProgress?: (f: number) => void) {
    await this.initEarly(onProgress);
    await this.initLate(onProgress);
  }

  async initEarly(onProgress?: (f: number) => void) {
    const tick = async (f: number) => {
      onProgress?.(f);
      await nextFrame();
    };

    const t0 = performance.now();
    await tick(0.87);
    this.buildPhase1();
    console.log(`[city] phase1 ${Math.round(performance.now() - t0)}ms`);
    this.releaseStaticGeometryAfterUpload();
    await tick(0.95);
  }

  async initLate(onProgress?: (f: number) => void) {
    const tick = async (f: number) => {
      onProgress?.(f);
      await nextFrame();
    };

    if (this.restMeta) {
      const tR = performance.now();
      await this.rebuildFromMeta(this.restMeta, onProgress);
      this.restMeta = null;
      console.log(`[city] meta rebuild ${Math.round(performance.now() - tR)}ms`);
      this.releaseStaticGeometryAfterUpload();
      await tick(0.97);

      return;
    }

    if (this.restPayload) {
      const tR = performance.now();
      await this.rebuildRest(this.restPayload, onProgress);
      this.restPayload = null;
      console.log(`[city] rest rebuild ${Math.round(performance.now() - tR)}ms`);
      this.releaseStaticGeometryAfterUpload();
      await tick(0.97);

      return;
    }

    this.lateRoadFallback?.();
    const t0 = performance.now();
    this.phase2();
    const t1 = performance.now();
    await tick(0.9);
    await this.phase3();
    console.log(
      `[city] phase2 ${Math.round(t1 - t0)}ms phase3 ${Math.round(performance.now() - t1)}ms`,
    );
    this.releaseStaticGeometryAfterUpload();
    await tick(0.97);
  }

  private releaseStaticGeometryAfterUpload() {
    if (!gpuOnlyGeometry()) {
      return;
    }

    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.name.startsWith("parcel-")) {
        return;
      }

      if (Object.getPrototypeOf(o) !== THREE.Mesh.prototype) {
        return;
      }

      const { geometry } = o;
      const attrs = [...Object.values(geometry.attributes), geometry.index];

      for (const a of attrs) {
        if (a instanceof THREE.BufferAttribute && a.usage !== THREE.StaticDrawUsage) {
          return;
        }
      }

      releaseArraysAfterUpload(geometry, { deferred: true });
    });
  }

  private phase2!: () => void;
  private phase3!: () => Promise<void>;
  private facadeAt: (x: number, z: number) => boolean = noFacade;
  private lastBreathe = 0;
  private async breathe() {
    if (performance.now() - this.lastBreathe < 12) {
      return;
    }

    await nextFrameTask();
    this.lastBreathe = performance.now();
  }

  private buildPhase1() {
    const staticMeshes: THREE.Mesh[] = [];
    const landmarkWalls: Solid[] = [];
    let landmarks: THREE.Group | null = null;

    const resolveLandmarks = () => {
      if (landmarks) {
        return landmarks;
      }

      this.landmarkWater.length = 0;
      landmarks = buildLandmarks(
        this.terrain,
        this.cache,
        this.network,
        (wall) => landmarkWalls.push(wall),
        (body) => this.landmarkWater.push(body),
      );

      return landmarks;
    };

    let parcelIndex: ParcelClearance | null = null;

    const parcelClear: ParcelClearance = (footprint, margin) => {
      parcelIndex ??= buildParcelClearance(this.parcelPlan().plans);

      return parcelIndex(footprint, margin);
    };

    const treeClear = buildTreeClearance(this.cache, parcelClear, this.landmarkWater);

    const collect = (obj: THREE.Object3D) => {
      obj.updateMatrixWorld(true);
      obj.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          staticMeshes.push(c);
        }
      });
    };

    const placedHash = new Map<number, OccBox[]>();
    let occRow = 0;

    const occupiedBy = (b: OccBox) => {
      let hit = false;
      occSpan(b, (key) => {
        if (hit) {
          return;
        }

        for (const o of placedHash.get(key) ?? []) {
          if (o.row === b.row) {
            continue;
          }

          if (boxesOverlap(o, b)) {
            hit = true;

            return;
          }
        }
      });

      return hit;
    };

    const occupy = (b: OccBox) => {
      occSpan(b, (key) => {
        const arr = placedHash.get(key);

        if (arr) {
          arr.push(b);
        } else {
          placedHash.set(key, [b]);
        }
      });
    };

    const treeSolid = (tx: number, tz: number) => {
      const h = 0.55;
      this.solids.push({ maxX: tx + h, maxZ: tz + h, minX: tx - h, minZ: tz - h, noBody: true });
    };

    const placeGreen = (gx: number, gz: number) => {
      if ((gz + 0.5) / GRID_Z < 0.03) {
        return;
      }

      const wx = this.worldX(gx);
      const wz = this.worldZ(gz);

      if (this.rng.chance(0.55)) {
        const count = 1 + this.rng.int(2);

        for (let i = 0; i < count; i += 1) {
          const large = this.rng.chance(0.6);
          const treeUrl = modelUrl("props", large ? TREE_LARGE : TREE_SMALL);
          const tb = this.cache.bounds(treeUrl);
          const tsc = (ROAD_TILE * 0.42) / Math.max(tb.size.y, 0.001);
          const tree = this.cache.instance(treeUrl);
          tree.scale.setScalar(tsc);
          const tx = wx + this.rng.range(-2.6, 2.6);
          const tz = wz + this.rng.range(-2.6, 2.6);

          if (this.onAsphalt(tx, tz, 0.6)) {
            continue;
          }

          if (nearFreeway(tx, tz, 0.5)) {
            continue;
          }

          if (occupiedBy(occBox(tx, tz, 0.6, 0.6, 0, 0))) {
            continue;
          }

          tree.position.set(tx, this.standAt(tx, tz), tz);
          tree.rotation.y = this.rng.range(0, Math.PI * 2);

          if (
            !treeClear(treeUrl, { scaleX: tsc, scaleZ: tsc, x: tx, yaw: tree.rotation.y, z: tz })
          ) {
            continue;
          }

          collect(tree);

          if (large) {
            treeSolid(tx, tz);
          }
        }
      }
    };

    for (let gx = 0; gx < GRID_X; gx += 1) {
      for (let gz = 0; gz < GRID_Z; gz += 1) {
        if (this.plan.roads[gx]?.[gz]) {
          this.roadCells.push({ gx, gz });
        }
      }
    }

    const pushRoads = (meshes: THREE.Mesh[]) => {
      for (const mesh of meshes) {
        mesh.userData.merge = true;
        staticMeshes.push(mesh);
      }
    };

    if (this.genPayload && this.genPayload.roadParts.length > 0) {
      pushRoads(roadPartsToMeshes(this.genPayload.roadParts));
    } else if (!this.genPayload) {
      pushRoads(buildRoads(this.network, this.roadDrape()));
    }

    this.lateRoadFallback = () => {
      if (this.genPayload && this.genPayload.roadParts.length === 0) {
        pushRoads(buildRoads(this.network, this.roadDrape()));
      }
    };

    const lmBase = landmarkProtection(this.plan, this.network);

    const reservedAll = buildReservation({
      clears: loadLocalOverrides().clear ?? [],
      garages: this.garages,
      landmarks: lmBase.reserved,
      plan: this.plan,
      terrain: this.terrain,
    });

    const lm = { ...lmBase, reserved: reservedAll };
    this.reservedCells = reservedAll;

    const landmarkReservations = lm.solids.map((s) => ({
      ...s,
      unseen: "landmark (unbatched monument)",
    }));

    this.solids.push(...landmarkReservations);

    for (const g of this.garages) {
      const url = modelUrl("buildings", GARAGE_MODEL);
      const node = this.cache.instance(url);
      const b = this.cache.bounds(url);
      const sc = (ROAD_TILE * 0.78) / Math.max(b.size.x, b.size.z, 0.001);
      node.scale.setScalar(sc);
      node.rotation.y = g.yaw;
      node.position.set(g.x, this.standAt(g.x, g.z), g.z);
      node.updateMatrixWorld(true);
      collect(node);
      const half = ROAD_TILE * 0.42;
      this.solids.push({
        maxX: g.x + half,
        maxZ: g.z + half,
        minX: g.x - half,
        minZ: g.z - half,
      });
      occupy(occBox(g.x, g.z, half + 0.6, half + 0.6, 0, (occRow += 1)));
    }

    const FACADE_CELL = 2.5;
    const FACADE_STRIDE = 4096;
    const facadeCells = new Set<number>();

    const facadeKey = (x: number, z: number) =>
      Math.floor((x + WORLD_HALF_X) / FACADE_CELL) * FACADE_STRIDE +
      Math.floor((z + WORLD_HALF_Z) / FACADE_CELL);

    const stampSegment = (x0: number, z0: number, x1: number, z1: number) => {
      const steps = Math.max(2, Math.ceil((Math.hypot(x1 - x0, z1 - z0) * 2) / FACADE_CELL));

      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        facadeCells.add(facadeKey(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t));
      }
    };

    this.facadeAt = (x: number, z: number) => facadeCells.has(facadeKey(x, z));

    this.phase2 = () => {
      resolveLandmarks();
      const { plans } = this.parcelPlan();

      for (const b of this.plan.buildingCells) {
        const cellId = `${b.gx},${b.gz}`;

        if (lm.reserved.has(cellId)) {
          continue;
        }

        if (districtAt(b.gx, b.gz).character === "park" || lm.parkGreen.has(cellId)) {
          placeGreen(b.gx, b.gz);
        }
      }

      for (const p of plans) {
        const o = p.obb;
        occupy(occBox(o.cx, o.cz, o.halfA, o.halfB, Math.atan2(-o.ez, o.ex), (occRow += 1)));
        const seg = frontSegment(p);

        if (seg) {
          stampSegment(seg[0], seg[1], seg[2], seg[3]);
        }
      }

      for (const g of this.plan.greenCells) {
        placeGreen(g.gx, g.gz);
      }
    };

    this.phase3 = async () => {
      const tFurn = performance.now();

      const fr = await buildFurniture({
        cache: this.cache,
        facadeAt: (x, z) => this.facadeAt(x, z),
        groundOffset: this.groundOffset(),
        network: this.network,
        parcelClear,
        plan: this.plan,
        reserved: lm.reserved,
        rng: this.rng,
        roadDrape: this.roadDrape(),
        terrain: this.terrain,
        treeClear,
        worldX: (g) => this.worldX(g),
        worldZ: (g) => this.worldZ(g),
      });

      console.log(`[city] furniture ${Math.round(performance.now() - tFurn)}ms`);
      await this.breathe();

      for (const o of fr.objects) {
        collect(o);
      }

      for (const s of fr.solids) {
        this.solids.push(s);
      }

      this.addDecks(fr.pierDecks);
      this.parkedCarSpecs = fr.parkedCars;
      this.lampHeads = fr.lampHeads;

      const gg = buildGoldenGate({
        cache: this.cache,
        plan: this.plan,
        terrain: this.terrain,
        worldX: (g) => this.worldX(g),
        worldZ: (g) => this.worldZ(g),
      });

      for (const o of gg.objects) {
        collect(o);
      }

      for (const s of gg.solids) {
        this.solids.push(s);
      }

      this.addDecks(gg.decks);

      const shore = planShoreline({
        decks: this.getDecks(),
        driveAt: (x, z) => this.heightAt(x, z),
        landAt: (x, z) => this.terrain.landAt(x, z),
        onRoad: (x, z) => this.onAsphalt(x, z, 1.3),
        standingAt: (x, z) => this.standAt(x, z),
      });

      for (const wall of buildShoreline(shore)) {
        collect(wall);
      }

      for (const wall of shore) {
        this.solids.push(wall.solid);
      }

      const t = 3;
      const LX = WORLD_HALF_X;
      const LZ = WORLD_HALF_Z;
      const edge = { unseen: "map border" } as const;
      this.solids.push(
        { ...edge, maxX: -LX, maxZ: LZ + t, minX: -LX - t, minZ: -LZ - t },
        { ...edge, maxX: LX + t, maxZ: LZ + t, minX: LX, minZ: -LZ - t },
        { ...edge, maxX: LX + t, maxZ: -LZ, minX: -LX - t, minZ: -LZ - t },
        { ...edge, maxX: LX + t, maxZ: LZ + t, minX: -LX - t, minZ: LZ },
      );

      this.buildGround();

      this.addMapProps(collect);

      const nx = Math.ceil(WORLD_W / CHUNK);
      const nz = Math.ceil(WORLD_H / CHUNK);
      const mergeBuckets = new Map<number, THREE.Mesh[]>();
      const batchBuckets = new Map<string, BatchBucket>();
      const centroid = new THREE.Vector3();

      for (const mesh of staticMeshes) {
        if (!(mesh.geometry instanceof THREE.BufferGeometry)) {
          continue;
        }

        const mat = mesh.material;

        if (mesh.userData.merge === true || Array.isArray(mat)) {
          bucketForMerge(mesh, mat, nx, nz, mergeBuckets, centroid);
        } else {
          bucketForBatch(mesh, mat, batchBuckets);
        }
      }

      const DETAIL_HEXES = new Set(["dfe3e3", "d8a13c", "d8a23c", "8f938c"]);
      const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;
      const tMerge = performance.now();
      let mergeN = 0;

      for (const [key, meshes] of mergeBuckets) {
        mergeN += 1;

        if (mergeN % 2 === 0) {
          await this.breathe();
        }

        const cx = key % nx;
        const cz = Math.floor(key / nx);

        const isDetail = (m: THREE.Mesh) => {
          const mat = m.material;

          if (Array.isArray(mat)) {
            return false;
          }

          if (mat.polygonOffset) {
            return true;
          }

          return (
            mat instanceof THREE.MeshStandardMaterial && DETAIL_HEXES.has(mat.color.getHexString())
          );
        };

        const main = meshes.filter((m) => !isDetail(m));
        const detail = meshes.filter(isDetail);
        const ccx = (cx + 0.5) * CHUNK - WORLD_HALF_X;
        const ccz = (cz + 0.5) * CHUNK - WORLD_HALF_Z;

        const publishMerged = async (src: readonly THREE.Mesh[], dist: number) => {
          const records: MergedChunkRec[] = [];
          const fallbacks: THREE.Mesh[] = [];

          for (const merged of mergeByMaterial(src)) {
            const rec = this.captureMerged(merged, ccx, ccz, dist);

            if (rec) {
              records.push(rec);
            } else {
              fallbacks.push(merged);
            }
          }

          await this.addMergedChunkRecords(records, fallbacks, ccx, ccz, dist, cullRadius);
        };

        if (main.length > 0) {
          await publishMerged(main, drawDistance());
        }

        if (detail.length > 0) {
          await publishMerged(detail, DETAIL_DISTANCE);
        }
      }

      console.log(`[city] merges ${Math.round(performance.now() - tMerge)}ms`);
      await this.buildBatchesFrom(batchBuckets, "capture");

      this.group.add(resolveLandmarks());
      this.solids.push(...landmarkWalls);
      const reservationSet = new Set<Solid>(landmarkReservations);
      let solidCount = 0;

      for (const solid of this.solids) {
        if (!reservationSet.has(solid)) {
          this.solids[solidCount] = solid;
          solidCount += 1;
        }
      }

      this.solids.length = solidCount;
      this.solids.push(...carveWaterReservations(landmarkReservations, this.landmarkWater));
      this.group.add(buildFreeways(this.terrain, this.network));
      this.group.add(buildPiers(this.terrain));
      this.lightGoldenGate();

      if (this.restComplete) {
        this.restCapture = {
          batchItems: [...this.restItems],
          decks: this.getDecks(),
          lampHeads: [...this.lampHeads],
          mergedChunks: this.capturedMerged,
          parkedCars: [...this.parkedCarSpecs],
          rawGeos: this.rawGeos,
          solids: [...this.solids],
        };
        console.log(
          `[city] rest capture: ${this.capturedMerged.length} merged, ${this.restItems.length} items`,
        );
      } else {
        console.log("[city] rest capture skipped: untagged batch items");
      }

      await this.buildParcels();
    };
  }

  private addMapProps(collect: (o: THREE.Object3D) => void) {
    for (const p of activeMapProps(editorMode())) {
      const [cat, name] = p.model.split("/");

      if (!cat || !name) {
        continue;
      }

      const node = this.cache.instance(modelUrl(cat, name));
      node.scale.setScalar(p.s);
      node.rotation.y = p.yaw;
      const x = (p.u - 0.5) * WORLD_W;
      const z = (p.v - 0.5) * WORLD_H;
      node.position.set(x, this.heightAt(x, z), z);
      collect(node);

      if (p.solid) {
        const b = this.cache.bounds(modelUrl(cat, name));
        const hx = (b.size.x * p.s) / 2;
        const hz = (b.size.z * p.s) / 2;
        this.solids.push({ maxX: x + hx, maxZ: z + hz, minX: x - hx, minZ: z - hz });
      }
    }
  }

  private buildGround() {
    this.paintedFloorAt = makePaintedFloorAt();

    const groundMat = createTerrainMaterial(
      makeGroundBlendAt(this.landClassAt, this.paintedFloorAt),
    );

    let ground: THREE.Group;

    if (this.genPayload) {
      ground = new THREE.Group();

      for (const t of this.genPayload.tiles) {
        const tile = new THREE.Group();
        tile.position.set(t.x, 0, t.z);
        tile.rotation.x = -Math.PI / 2;
        const mesh = new THREE.Mesh(buildPackedGeometry(t), groundMat);
        seatPackedMesh(mesh, t.pos);
        mesh.receiveShadow = true;
        mesh.name = "terrain-ground";
        tile.add(mesh);
        ground.add(tile);
      }
    } else {
      ground = this.terrain.buildMesh(
        groundMat,
        makeGroundColorAt(this.plan, this.terrain, this.landClassAt),
        this.groundOffset(),
      );
    }

    ground.name = "terrain-ground";
    this.group.add(ground);

    for (const tile of ground.children) {
      this.chunks.push({
        cx: tile.position.x,
        cz: tile.position.z,
        dist: drawDistance(),
        group: tile,
        radius: 660,
      });
    }
  }

  private async rebuildRest(rest: CityRestPayload, onProgress?: (f: number) => void) {
    const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;

    const groups = await buildMergedChunkGroups({
      breathe: () => this.breathe(),
      cache: this.cache,
      materialFor: this.bakedMaterialFor,
      onRecord: (done, total) => {
        if (done % 16 === 0) {
          onProgress?.((done / total) * 0.55);
        }
      },
      records: rest.mergedChunks,
    });

    for (const g of groups) {
      this.group.add(g.group);
      this.chunks.push({ cx: g.cx, cz: g.cz, dist: g.dist, group: g.group, radius: cullRadius });
    }

    await this.rebuildCityBody(rest, onProgress);
    await this.buildParcels();
  }

  private async rebuildFromMeta(meta: CityRestMeta, onProgress?: (f: number) => void) {
    await this.rebuildCityBody(meta, onProgress);
    const t0 = performance.now();
    const detail = parcelDetailLevel();
    const skyline = unpackPlans(meta.skyline);

    const built = await buildParcelFabric(
      skyline,
      [],
      { detail: DETAIL_DISTANCE, imposter: imposterDistance(), midImposter: midImposterDistance() },
      detail,
      () => this.breathe(),
    );

    for (const c of built.chunks) {
      this.group.add(c.group);
      this.chunks.push({ cx: c.cx, cz: c.cz, dist: c.dist, group: c.group, radius: c.radius });
    }

    this.parcelStreamer = new ParcelStreamer(this.group, detail);
    this.tileStreamer = new WorldTileStreamer(meta.tiles, CHUNK, {
      evict: (key) => this.evictWorldTile(key),
      fetch: fetchWorldTile,
      install: (key, tile) => this.installWorldTile(key, tile),
    });
    console.log(
      `[city] parcels: ${skyline.length} skyline buildings static (${built.stats.vertices} verts), ` +
        `${meta.tiles.length} tiles to stream in ${Math.round(performance.now() - t0)}ms`,
    );
  }

  private async installWorldTile(key: number, tile: PackedWorldTile) {
    const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;

    const groups = await buildMergedChunkGroups({
      breathe: () => this.breathe(),
      cache: this.cache,
      materialFor: this.bakedMaterialFor,
      records: tile.mergedChunks,
    });

    for (const g of groups) {
      this.group.add(g.group);
      g.group.updateMatrixWorld(true);
      g.group.traverse((o) => {
        o.matrixAutoUpdate = false;
        o.matrixWorldAutoUpdate = this.group.matrixWorldAutoUpdate;
      });
      this.chunks.push({
        cx: g.cx,
        cz: g.cz,
        dist: g.dist,
        group: g.group,
        radius: cullRadius,
        tile: key,
      });
    }

    this.releaseStaticGeometryAfterUpload();
    this.parcelStreamer?.addTile(key, tile.plans, tile.lots);
    const solids = unpackSolids(tile.solids);
    this.tileSolids.set(key, solids);
    this.solidSink?.add(key, solids);
  }

  private evictWorldTile(key: number) {
    const keep: Chunk[] = [];

    for (const c of this.chunks) {
      if (c.tile !== key) {
        keep.push(c);
        continue;
      }

      this.group.remove(c.group);
      c.group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
        }
      });
    }

    this.chunks = keep;
    this.parcelStreamer?.removeTile(key);

    if (this.tileSolids.delete(key)) {
      this.solidSink?.remove(key);
    }
  }

  private buildRawGeos(rawGeos: readonly RawGeoRec[]) {
    const matFor = this.bakedMaterialFor;
    const rawBuilt: { geo: THREE.BufferGeometry; mat: BakedMaterial }[] = [];

    for (const rg of rawGeos) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(rg.position, 3));

      if (rg.uv) {
        geo.setAttribute("uv", new THREE.BufferAttribute(rg.uv, 2));
      }

      if (rg.index) {
        geo.setIndex(new THREE.BufferAttribute(rg.index, 1));
      }

      if (rg.normal) {
        geo.setAttribute("normal", new THREE.BufferAttribute(rg.normal, 3));
      } else {
        geo.computeVertexNormals();
      }

      rawBuilt.push({ geo, mat: matFor(rg.mat) });
    }

    return rawBuilt;
  }

  private async rebuildCityBody(
    rest: Omit<CityRestPayload, "mergedChunks">,
    onProgress?: (f: number) => void,
  ) {
    const rawBuilt = this.buildRawGeos(rest.rawGeos);
    const buckets = new Map<string, BatchBucket>();
    let dropSrc = 0;
    let dropRaw = 0;
    let okN = 0;

    for (const rec of rest.batchItems) {
      let geo: THREE.BufferGeometry;
      let mat: THREE.Material;

      if (rec.url !== null) {
        const srcMesh = this.cache.srcMesh(rec.url, rec.idx);

        if (!srcMesh || Array.isArray(srcMesh.material)) {
          dropSrc += 1;

          if (dropSrc <= 3) {
            console.log(`[city] rest drop src: ${rec.url}#${rec.idx}`);
          }

          continue;
        }

        geo = srcMesh.geometry;
        mat = srcMesh.material;
      } else if (rec.raw !== null && rawBuilt[rec.raw]) {
        const rb = rawBuilt[rec.raw];

        if (!rb) {
          continue;
        }

        ({ geo, mat } = rb);
      } else {
        dropRaw += 1;
        continue;
      }

      okN += 1;
      const bKey = `${mat.uuid}|${geoLayoutKey(geo)}`;
      let bucket = buckets.get(bKey);

      if (!bucket) {
        bucket = { geoVerts: new Map(), indices: 0, items: [], material: mat, verts: 0 };
        buckets.set(bKey, bucket);
      }

      if (!bucket.geoVerts.has(geo)) {
        const vCount = geo.attributes.position?.count ?? 0;
        bucket.geoVerts.set(geo, vCount);
        bucket.verts += vCount;
        bucket.indices += geo.index ? geo.index.count : vCount;
      }

      const item: BatchItem = { geo, matrix: new THREE.Matrix4().fromArray(rec.m) };

      if (rec.tint !== null) {
        item.tint = new THREE.Color(rec.tint);
      }

      if (rec.url !== null) {
        item.src = { idx: rec.idx, url: rec.url };
      }

      bucket.items.push(item);
    }

    console.log(`[city] rest items ok ${okN} dropSrc ${dropSrc} dropRaw ${dropRaw}`);
    await this.buildBatchesFrom(buckets, "restore", (f) => onProgress?.(0.55 + f * 0.4));
    this.solids.length = 0;

    for (const so of rest.solids) {
      this.solids.push(so);
    }

    this.parkedCarSpecs = rest.parkedCars;
    this.lampHeads = rest.lampHeads;
    this.addDecks(rest.decks);
    this.buildGround();
    this.landmarkWater.length = 0;
    this.group.add(
      buildLandmarks(this.terrain, this.cache, this.network, undefined, (body) =>
        this.landmarkWater.push(body),
      ),
    );
    this.group.add(buildFreeways(this.terrain, this.network));
    this.group.add(buildPiers(this.terrain));
    this.lightGoldenGate();
  }

  private lightGoldenGate() {
    const gg = this.goldenGate();

    if (gg) {
      registerBeacons("golden-gate", goldenGateBeacons(gg));
    }
  }

  private goldenGate() {
    return goldenGatePlan({
      plan: this.plan,
      terrain: this.terrain,
      worldX: (g) => this.worldX(g),
      worldZ: (g) => this.worldZ(g),
    });
  }

  private landmarkVolumes() {
    const gg = this.goldenGate();

    if (!gg) {
      return [];
    }

    const pad = gg.half + 26;
    const minZ = Math.min(gg.northEndZ, gg.shoreZ, gg.endZ) - 30;
    const maxZ = Math.max(gg.northEndZ, gg.shoreZ, gg.endZ) + 30;
    const span = Math.max(maxZ - minZ, pad * 2);

    return [
      {
        hold: Math.min(LANDMARK_HOLD_DISTANCE, span * LANDMARK_SPAN_RATIO),
        maxX: gg.ax + pad,
        maxZ,
        minX: gg.ax - pad,
        minZ,
      },
    ];
  }

  private async buildBucketBatch(bucket: BatchBucket, ctx: BatchBuildCtx) {
    const { gpuOnly, mode, multiDraw, nx, nz, pos, untagged } = ctx;
    const translucent = bucket.material.transparent && bucket.material.opacity < 1;

    if (translucent) {
      bucket.material.depthWrite = false;
    }

    applyMaterialBreakup(bucket.material, CITY_BREAKUP);

    const batched = new THREE.BatchedMesh(
      bucket.items.length,
      bucket.verts,
      bucket.indices,
      bucket.material,
    );

    batched.castShadow = !translucent && !propShadowsDisabled(bucket.material, multiDraw);
    batched.receiveShadow = true;
    batched.perObjectFrustumCulled = true;
    batched.sortObjects = bucket.material.transparent;
    const geoIds = new Map<THREE.BufferGeometry, number>();
    const chunkIds = new Uint16Array(bucket.items.length);

    for (let i = 0; i < bucket.items.length; i += 1) {
      if (i % 512 === 0) {
        await this.breathe();
      }

      const item = bucket.items[i];

      if (!item) {
        continue;
      }

      let gid = geoIds.get(item.geo);

      if (gid === undefined) {
        gid = batched.addGeometry(item.geo);
        geoIds.set(item.geo, gid);
      }

      const iid = batched.addInstance(gid);
      batched.setMatrixAt(iid, item.matrix);

      if (mode === "capture" && item.src) {
        this.restItems.push({
          big: false,
          idx: item.src.idx,
          m: new Float32Array(item.matrix.elements),
          raw: null,
          tint: item.tint ? item.tint.getHex() : null,
          url: item.src.url,
        });
      } else if (mode === "capture") {
        this.captureRestRecord(item, bucket.material, untagged);
      }

      if (item.tint) {
        batched.setColorAt(iid, item.tint);
      }

      pos.setFromMatrixPosition(item.matrix);
      const ccx = Math.min(nx - 1, Math.max(0, Math.floor((pos.x + WORLD_HALF_X) / STREAM_CELL)));
      const ccz = Math.min(nz - 1, Math.max(0, Math.floor((pos.z + WORLD_HALF_Z) / STREAM_CELL)));
      chunkIds[iid] = ccz * nx + ccx;
    }

    batched.computeBoundingSphere();
    const bIndex = this.batches.length;
    const anyBig = this.mapBucketInstances(bucket, chunkIds, bIndex, ctx);

    if (!anyBig) {
      batched.castShadow = false;
    }

    if (!batched.castShadow && !bucket.material.transparent) {
      batched.perObjectFrustumCulled = false;
    }

    const mesh = compatiblePropBatch(batched, bucket.items, multiDraw);

    if (gpuOnly) {
      if (mesh instanceof THREE.BatchedMesh) {
        releaseArraysAfterUpload(mesh.geometry);
      } else {
        mesh.releaseCpuGeometry();
      }
    }

    this.group.add(mesh);
    this.batches.push({ chunkIds, mesh });
  }

  private captureRestRecord(item: BatchItem, mat: THREE.Material, untagged: Map<string, number>) {
    const textured = mat instanceof THREE.MeshStandardMaterial && mat.map !== null;
    const rec = textured ? null : matRecOf(mat);

    if (rec === null) {
      this.restComplete = false;

      const tag =
        mat instanceof THREE.MeshStandardMaterial
          ? `${mat.name || "?"}#${mat.color.getHexString()}`
          : mat.type;

      untagged.set(tag, (untagged.get(tag) ?? 0) + 1);
    } else {
      let rawId = this.rawGeoIds.get(item.geo.uuid);

      if (rawId === undefined) {
        const pos2 = item.geo.getAttribute("position");
        const nor2 = item.geo.getAttribute("normal");
        const uv2 = item.geo.getAttribute("uv");
        rawId = this.rawGeos.length;
        this.rawGeoIds.set(item.geo.uuid, rawId);
        this.rawGeos.push({
          index: item.geo.index ? (item.geo.index.array as Uint16Array | Uint32Array) : null,
          mat: rec,
          normal: nor2 ? (nor2.array as Float32Array) : null,
          position: pos2.array as Float32Array,
          uv: uv2 ? (uv2.array as Float32Array) : null,
        });
      }

      this.restItems.push({
        big: false,
        idx: 0,
        m: new Float32Array(item.matrix.elements),
        raw: rawId,
        tint: item.tint ? item.tint.getHex() : null,
        url: null,
      });
    }
  }

  private mapBucketInstances(
    bucket: BatchBucket,
    chunkIds: Uint16Array,
    bIndex: number,
    ctx: BatchBuildCtx,
  ) {
    const { imposters, landmarkKeys, pos, volumes } = ctx;
    let anyBig = false;

    for (let iid = 0; iid < chunkIds.length; iid += 1) {
      const key = chunkIds[iid] ?? 0;
      const item = bucket.items[iid];
      const { extent, worldH } = itemExtents(item);

      const hold =
        item && extent >= LANDMARK_MEMBER_MIN
          ? landmarkHoldAt(volumes, pos.setFromMatrixPosition(item.matrix))
          : 0;

      const tier = propTierOf(item, worldH, hold);

      if (tier === "big" || tier === "landmark") {
        anyBig = true;
      }

      let map = this.chunkInstancesNear;

      if (tier === "landmark") {
        map = this.chunkInstancesLandmark;
      } else if (tier === "tall") {
        map = this.chunkInstancesTall;
      }

      const list = map.get(key);

      if (list) {
        list.push([bIndex, iid]);
      } else {
        map.set(key, [[bIndex, iid]]);
      }

      if (tier === "landmark") {
        landmarkKeys.set(key, Math.max(landmarkKeys.get(key) ?? 0, hold));
      }

      if ((tier === "big" || tier === "mid") && item) {
        imposters.push({ item, key, mat: bucket.material, mid: tier === "mid" });
      }
    }

    return anyBig;
  }

  private async buildImposterBatch(imposters: readonly ImposterSpec[], multiDraw: boolean) {
    const boxes = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();

    for (const { mat, item } of imposters) {
      if (!boxes.has(item.geo)) {
        boxes.set(item.geo, imposterBox(item.geo, mat));
      }
    }

    const boxMat = new THREE.MeshStandardMaterial({
      color: 0xff_ff_ff,
      roughness: 0.95,
      vertexColors: true,
    });

    applyMaterialBreakup(boxMat, CITY_BREAKUP);
    const boxN = new Set(boxes.values()).size;
    const imp = new THREE.BatchedMesh(imposters.length, 24 * boxN, 36 * boxN, boxMat);
    imp.castShadow = false;
    imp.frustumCulled = false;
    imp.perObjectFrustumCulled = false;
    imp.sortObjects = false;
    const gids = new Map<THREE.BufferGeometry, number>();
    const impItems: PropInstance[] = [];
    const m4 = new THREE.Matrix4();
    const box = new THREE.Box3();
    const sizeV = new THREE.Vector3();
    const ctrV = new THREE.Vector3();
    let impN = 0;

    for (const { key, mid, mat, item } of imposters) {
      if (impN % 1024 === 0) {
        await this.breathe();
      }

      impN += 1;

      if (!item.geo.boundingBox) {
        item.geo.computeBoundingBox();
      }

      if (!item.geo.boundingBox) {
        continue;
      }

      box.copy(item.geo.boundingBox);
      box.getSize(sizeV);
      box.getCenter(ctrV);
      const shrinkXZ = mid ? 0.94 : 1;
      const shrinkY = mid ? 0.93 : 1;
      m4.makeScale(
        Math.max(sizeV.x * shrinkXZ, 0.1),
        Math.max(sizeV.y * shrinkY, 0.1),
        Math.max(sizeV.z * shrinkXZ, 0.1),
      );
      m4.setPosition(ctrV.x, box.min.y, ctrV.z);
      m4.premultiply(item.matrix);
      const boxGeo = boxes.get(item.geo);

      if (!boxGeo) {
        continue;
      }

      let gid = gids.get(boxGeo);

      if (gid === undefined) {
        gid = imp.addGeometry(boxGeo);
        gids.set(boxGeo, gid);
      }

      const iid = imp.addInstance(gid);
      imp.setMatrixAt(iid, m4);
      imp.setColorAt(iid, imposterColorInto(IMPOSTER_COLOR, item.geo, mat, item.tint));
      imp.setVisibleAt(iid, false);

      if (!multiDraw) {
        impItems.push({ geo: boxGeo, matrix: m4.clone(), tint: IMPOSTER_COLOR.clone() });
      }

      const tier = mid ? this.imposterMidInstances : this.imposterInstances;
      const list = tier.get(key);

      if (list) {
        list.push(iid);
      } else {
        tier.set(key, [iid]);
      }
    }

    imp.computeBoundingSphere();
    const mesh = compatiblePropBatch(imp, impItems, multiDraw);
    this.group.add(mesh);
    this.imposterMesh = mesh;
    let midN = 0;

    for (const spec of imposters) {
      if (spec.mid) {
        midN += 1;
      }
    }

    console.log(`[city] imposters ${imposters.length} (mid ${midN})`);
  }

  private async buildBatchesFrom(
    batchBuckets: Map<string, BatchBucket>,
    mode: "capture" | "restore",
    onProgress?: (f: number) => void,
  ) {
    const { multiDraw } = renderCapabilities();
    const gpuOnly = gpuOnlyGeometry();
    const nx = Math.ceil(WORLD_W / STREAM_CELL);
    const nz = Math.ceil(WORLD_H / STREAM_CELL);
    const pos = new THREE.Vector3();
    const tBatch = performance.now();
    const imposters: ImposterSpec[] = [];
    const volumes = this.landmarkVolumes();
    const landmarkKeys = new Map<number, number>();
    const untagged = new Map<string, number>();

    const ctx: BatchBuildCtx = {
      gpuOnly,
      imposters,
      landmarkKeys,
      mode,
      multiDraw,
      nx,
      nz,
      pos,
      untagged,
      volumes,
    };

    this.restItems.length = 0;
    let batchN = 0;

    for (const bucket of batchBuckets.values()) {
      await this.breathe();
      onProgress?.(batchN / batchBuckets.size);
      batchN += 1;
      await this.buildBucketBatch(bucket, ctx);
    }

    if (imposters.length > 0) {
      await this.buildImposterBatch(imposters, multiDraw);
    }

    if (untagged.size > 0) {
      console.log("[city] untagged batch items:", JSON.stringify([...untagged.entries()]));
    }

    this.batchChunkGrid = { nx, nz };
    this.chunkVisible = null;
    this.chunkVisibleNear = null;
    this.chunkVisibleTall = null;
    this.chunkVisibleLandmark = null;

    if (landmarkKeys.size > 0) {
      const holds = new Float32Array(nx * nz);

      for (const [key, hold] of landmarkKeys) {
        if (key < holds.length) {
          holds[key] = hold;
        }
      }

      this.chunkLandmarkHold = holds;
      console.log(
        `[city] landmark tier: ${[...this.chunkInstancesLandmark.values()].reduce((n, l) => n + l.length, 0)} members over ${landmarkKeys.size} cells, hold ${Math.round(Math.max(...landmarkKeys.values()))}u`,
      );
    } else {
      this.chunkLandmarkHold = null;
    }

    console.log(`[city] batches ${Math.round(performance.now() - tBatch)}ms`);
  }

  freezeStatic() {
    this.group.seal();
  }

  updateStreaming(camera: THREE.Camera, showAll = false) {
    const camX = camera.position.x;
    const camZ = camera.position.z;
    this.tileStreamer?.update(camX, camZ, showAll ? Infinity : tileHoldRadius());
    this.parcelStreamer?.update(
      camX,
      camZ,
      showAll ? Infinity : streamRadiusFor(liveQuality().detailScale),
    );

    for (const c of this.chunks) {
      const d = Math.hypot(camX - c.cx, camZ - c.cz) - c.radius;
      const visible = showAll || d < c.dist;

      if (c.group.visible !== visible) {
        c.group.visible = visible;
      }
    }

    const { nx, nz } = this.batchChunkGrid;
    const total = nx * nz;
    this.chunkVisible ??= new Uint8Array(total).fill(1);
    this.chunkVisibleNear ??= new Uint8Array(total).fill(1);
    this.chunkVisibleTall ??= new Uint8Array(total).fill(1);
    this.chunkVisibleLandmark ??= new Uint8Array(total).fill(1);
    STREAM_MAT.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    STREAM_FRUSTUM.setFromProjectionMatrix(STREAM_MAT);
    const scale = liveQuality().detailScale;

    const pass: StreamPass = {
      camX,
      camZ,
      detail: DETAIL_DISTANCE * scale,
      flagFar: this.chunkVisible,
      flagLandmark: this.chunkVisibleLandmark,
      flagNear: this.chunkVisibleNear,
      flagTall: this.chunkVisibleTall,
      nx,
      pad: STREAM_PAD,
      scale,
      showAll,
      tallDetail: TALL_DETAIL_DISTANCE * scale,
      total,
    };

    for (let key = 0; key < total; key += 1) {
      this.updateStreamCell(key, pass);
    }
  }

  private updateStreamCell(key: number, pass: StreamPass) {
    const { camX, camZ, detail, flagFar, flagNear, flagTall, nx, pad, showAll, tallDetail } = pass;
    const cx = ((key % nx) + 0.5) * STREAM_CELL - WORLD_HALF_X;
    const cz = (Math.floor(key / nx) + 0.5) * STREAM_CELL - WORLD_HALF_Z;
    const dist = Math.hypot(camX - cx, camZ - cz);
    let inFrustum = false;

    if (dist - pad < imposterDistance()) {
      STREAM_SPHERE.center.set(cx, 14, cz);
      STREAM_SPHERE.radius = pad + 30;
      inFrustum = STREAM_FRUSTUM.intersectsSphere(STREAM_SPHERE);
    }

    const near = dist < NEAR_ALWAYS;
    const visFar: 0 | 1 = showAll || near || (inFrustum && dist - pad < imposterDistance()) ? 1 : 0;
    const visNear: 0 | 1 = showAll || near || (inFrustum && dist < detail) ? 1 : 0;

    if (flagFar[key] !== visFar) {
      flagFar[key] = visFar;
    }

    this.flipChunk(flagNear, key, visNear, this.chunkInstancesNear);
    this.updateLandmarkCell(key, pass, near, inFrustum, dist);
    const visTall: 0 | 1 = showAll || near || (inFrustum && dist < tallDetail) ? 1 : 0;
    this.flipChunk(flagTall, key, visTall, this.chunkInstancesTall);
    this.updateImposterCell(key, pass, visFar, visNear, dist);
  }

  private updateLandmarkCell(
    key: number,
    pass: StreamPass,
    near: boolean,
    inFrustum: boolean,
    dist: number,
  ) {
    const lmHold = (this.chunkLandmarkHold?.[key] ?? 0) * pass.scale;

    if (lmHold <= 0) {
      return;
    }

    const visLm: 0 | 1 = pass.showAll || near || (inFrustum && dist < lmHold) ? 1 : 0;
    this.flipChunk(pass.flagLandmark, key, visLm, this.chunkInstancesLandmark);
  }

  private updateImposterCell(
    key: number,
    pass: StreamPass,
    visFar: 0 | 1,
    visNear: 0 | 1,
    dist: number,
  ) {
    const mesh = this.imposterMesh;

    if (!mesh) {
      return;
    }

    this.imposterVisible ??= new Uint8Array(pass.total).fill(0);
    this.imposterMidVisible ??= new Uint8Array(pass.total).fill(0);
    const visImp: 0 | 1 = visFar === 1 && visNear === 0 ? 1 : 0;
    flipImposters(this.imposterVisible, key, visImp, this.imposterInstances, mesh);
    const visMid: 0 | 1 = visImp === 1 && dist - pass.pad < midImposterDistance() ? 1 : 0;
    flipImposters(this.imposterMidVisible, key, visMid, this.imposterMidInstances, mesh);
  }

  private flipChunk(
    flags: Uint8Array,
    key: number,
    vis: 0 | 1,
    instances: Map<number, [number, number][]>,
  ) {
    if (flags[key] === vis) {
      return;
    }

    flags[key] = vis;
    const list = instances.get(key);

    if (!list) {
      return;
    }

    for (const [b, iid] of list) {
      this.batches[b]?.mesh.setVisibleAt(iid, vis === 1);
    }
  }

  isOnRoad(x: number, z: number) {
    const gx = this.gridX(x);
    const gz = this.gridZ(z);

    if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) {
      return false;
    }

    return this.plan.cells[gx]?.[gz] === "road";
  }

  surfaceKindAt(x: number, z: number, y?: number) {
    const contactY = y ?? this.heightAt(x, z);

    if (
      this.surface.isDeckContact(x, z, contactY) ||
      isFreewayDeckContact(this.terrain, this.network, x, z, contactY)
    ) {
      return "road";
    }

    const painted = this.paintedFloorAt(x, z);

    if (painted === "grass" || painted === "sand") {
      return painted;
    }

    if (painted === "plaza") {
      return "concrete";
    }

    return wheelSurface(this.landClassAt(x, z));
  }

  private surfaceImpl: DriveSurface | null = null;
  private get surface() {
    this.surfaceImpl ??= new DriveSurface(this.terrain, this.plan, () => this.network);

    return this.surfaceImpl;
  }

  addDecks(decks: readonly SurfaceDeck[]) {
    this.surface.addDecks(decks);
  }

  getDecks() {
    return this.surface.getDecks();
  }

  heightAt(x: number, z: number) {
    const floor = this.surface.heightAt(x, z);

    if (surfaceDeckAt(this.getDecks(), x, z)) {
      return floor;
    }

    return waterBedHeight(this.landmarkWater, x, z, floor);
  }

  getWaterBodies() {
    return this.landmarkWater;
  }

  waterHeightAt(x: number, z: number) {
    const lake = stowWaterHeightAt(x, z);

    if (lake !== null) {
      return lake;
    }

    for (const body of this.landmarkWater) {
      if (waterBodyContains(body, x, z)) {
        return body.y;
      }
    }

    return this.terrain.landAt(x, z) < 0.6 ? SEA_Y : null;
  }

  cameraFloorAt(x: number, z: number, referenceY: number) {
    return this.surface.floorBelow(x, z, referenceY);
  }

  normalInto(out: THREE.Vector3, x: number, z: number) {
    return this.surface.normalInto(out, x, z);
  }
}
