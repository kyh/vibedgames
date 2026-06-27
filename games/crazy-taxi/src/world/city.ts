import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { ModelCache } from "../assets/loader";
import {
  BUILDINGS_COMMERCIAL,
  BUILDINGS_INDUSTRIAL,
  BUILDINGS_SKYSCRAPER,
  BUILDINGS_SUBURBAN,
  modelUrl,
  TREE_LARGE,
  TREE_SMALL,
} from "../assets/manifest";
import { CITY_SEED, GRID, ROAD_ROT_SIGN, ROAD_TILE, ROAD_Y, WORLD_HALF } from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import { type CityPlan, generateCity } from "./grid";
import { makeTerrain } from "./sf-map";
import type { Terrain } from "./terrain";

export type Solid = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
};

export type RoadCell = { readonly gx: number; readonly gz: number };

const HALF_PI = Math.PI / 2;
const UP = new THREE.Vector3(0, 1, 0);

// Building front faces +Z in the native model; this offset rotates it to face
// the street. Tune if entrances point the wrong way.
const BUILDING_FRONT_OFFSET = Math.PI;

function dirToYaw(d: Dir): number {
  // Yaw that points "toward" the given grid direction (about +Y).
  switch (d) {
    case N:
      return Math.PI;
    case S:
      return 0;
    case E:
      return -HALF_PI;
    case W:
      return HALF_PI;
    default:
      return 0;
  }
}

export class CityModel {
  readonly group = new THREE.Group();
  readonly solids: Solid[] = [];
  readonly roadCells: RoadCell[] = [];
  readonly plan: CityPlan;
  readonly terrain: Terrain;
  private scratchN = new THREE.Vector3();
  private scratchTilt = new THREE.Quaternion();
  private scratchSpin = new THREE.Quaternion();

  constructor(
    private cache: ModelCache,
    private rng = new Rng(CITY_SEED),
  ) {
    this.terrain = makeTerrain();
    this.plan = generateCity();
    this.build();
  }

  // Lay a Y-up object on the terrain: tilt its up-axis to the slope normal,
  // spin it around that normal by `yaw`, and seat it at the ground height.
  private placeOnTerrain(
    obj: THREE.Object3D,
    wx: number,
    wz: number,
    yaw: number,
    yOffset: number,
  ): void {
    const n = this.terrain.normalInto(this.scratchN, wx, wz);
    const tilt = this.scratchTilt.setFromUnitVectors(UP, n);
    const spin = this.scratchSpin.setFromAxisAngle(n, yaw);
    obj.quaternion.copy(spin).multiply(tilt);
    obj.position.set(wx, this.terrain.heightAt(wx, wz) + yOffset, wz);
  }

  worldX(gx: number): number {
    return (gx + 0.5) * ROAD_TILE - WORLD_HALF;
  }
  worldZ(gz: number): number {
    return (gz + 0.5) * ROAD_TILE - WORLD_HALF;
  }
  gridX(x: number): number {
    return Math.floor((x + WORLD_HALF) / ROAD_TILE);
  }
  gridZ(z: number): number {
    return Math.floor((z + WORLD_HALF) / ROAD_TILE);
  }

  private buildingPool(gx: number, gz: number): readonly string[] {
    // District zoning by distance from city center.
    const cx = (gx - (GRID - 1) / 2) / ((GRID - 1) / 2);
    const cz = (gz - (GRID - 1) / 2) / ((GRID - 1) / 2);
    const r = Math.hypot(cx, cz); // 0 center → ~1.4 corner
    if (r < 0.24) return this.rng.chance(0.35) ? BUILDINGS_SKYSCRAPER : BUILDINGS_COMMERCIAL;
    if (r < 0.72) return BUILDINGS_COMMERCIAL;
    if (this.rng.chance(0.22)) return BUILDINGS_INDUSTRIAL;
    return BUILDINGS_SUBURBAN;
  }

  private build(): void {
    const staticMeshes: THREE.Mesh[] = [];
    const collect = (obj: THREE.Object3D): void => {
      obj.updateMatrixWorld(true);
      obj.traverse((c) => {
        if (c instanceof THREE.Mesh) staticMeshes.push(c);
      });
    };

    // --- Roads ---
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        const r = this.plan.roads[gx]?.[gz];
        if (!r) continue;
        this.roadCells.push({ gx, gz });
        const tile = this.cache.instance(modelUrl("roads", r.tile));
        tile.scale.set(ROAD_TILE, ROAD_TILE, ROAD_TILE);
        this.placeOnTerrain(
          tile,
          this.worldX(gx),
          this.worldZ(gz),
          ROAD_ROT_SIGN * r.quarterTurns * HALF_PI,
          ROAD_Y,
        );
        collect(tile);
      }
    }

    // --- Buildings + frontage props ---
    for (const b of this.plan.buildingCells) {
      const pool = this.buildingPool(b.gx, b.gz);
      const key = this.rng.pick(pool);
      const url = modelUrl("buildings", key);
      const bounds = this.cache.bounds(url);
      const footprint = Math.max(bounds.size.x, bounds.size.z, 0.001);
      const targetFootprint = ROAD_TILE * this.rng.range(0.58, 0.7);
      const scale = targetFootprint / footprint;
      const node = this.cache.instance(url);
      node.scale.setScalar(scale);
      node.rotation.y = dirToYaw(b.faceDir) + BUILDING_FRONT_OFFSET;
      const wx = this.worldX(b.gx);
      const wz = this.worldZ(b.gz);
      // Buildings stay vertical; sink the base a touch so it digs into a slope.
      node.position.set(wx, this.terrain.heightAt(wx, wz) - 0.4, wz);
      collect(node);

      // Solid footprint (a touch smaller than the visual so curbs are forgiving).
      const half = (targetFootprint / 2) * 0.96;
      this.solids.push({ minX: wx - half, maxX: wx + half, minZ: wz - half, maxZ: wz + half });

      // Occasional curbside tree, nudged toward the street.
      if (this.rng.chance(0.33)) {
        const [dx, dz] = DIR_DELTA[b.faceDir];
        const treeUrl = modelUrl("props", this.rng.chance(0.5) ? TREE_LARGE : TREE_SMALL);
        const tb = this.cache.bounds(treeUrl);
        const ts = (ROAD_TILE * 0.32) / Math.max(tb.size.y, 0.001);
        const tree = this.cache.instance(treeUrl);
        tree.scale.setScalar(ts);
        const tx = wx + dx * ROAD_TILE * 0.46 + this.rng.range(-1, 1);
        const tz = wz + dz * ROAD_TILE * 0.46 + this.rng.range(-1, 1);
        tree.position.set(tx, this.terrain.heightAt(tx, tz), tz);
        tree.rotation.y = this.rng.range(0, Math.PI * 2);
        collect(tree);
      }
    }

    // --- Green / park cells: grass + trees in the interiors of big blocks ---
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x52803d, roughness: 1 });
    const grassGeo = new THREE.PlaneGeometry(ROAD_TILE, ROAD_TILE);
    grassGeo.rotateX(-HALF_PI); // normal → +Y so placeOnTerrain tilts it to the slope
    for (const g of this.plan.greenCells) {
      const wx = this.worldX(g.gx);
      const wz = this.worldZ(g.gz);
      const quad = new THREE.Mesh(grassGeo, grassMat);
      this.placeOnTerrain(quad, wx, wz, 0, 0.04);
      quad.receiveShadow = true;
      collect(quad);
      if (this.rng.chance(0.5)) {
        const count = 1 + this.rng.int(2);
        for (let i = 0; i < count; i++) {
          const treeUrl = modelUrl("props", this.rng.chance(0.6) ? TREE_LARGE : TREE_SMALL);
          const tb = this.cache.bounds(treeUrl);
          const ts = (ROAD_TILE * 0.42) / Math.max(tb.size.y, 0.001);
          const tree = this.cache.instance(treeUrl);
          tree.scale.setScalar(ts);
          const tx = wx + this.rng.range(-2.6, 2.6);
          const tz = wz + this.rng.range(-2.6, 2.6);
          tree.position.set(tx, this.terrain.heightAt(tx, tz), tz);
          tree.rotation.y = this.rng.range(0, Math.PI * 2);
          collect(tree);
        }
      }
    }

    // --- Shoreline collision: wall off each water cell that borders land so
    // the taxi can reach the waterfront but not drive into the bay. ---
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        if (this.plan.cells[gx]?.[gz] !== "water") continue;
        let coastal = false;
        for (const d of [N, E, S, W] as const) {
          const [dx, dz] = DIR_DELTA[d];
          const nb = this.plan.cells[gx + dx]?.[gz + dz];
          if (nb === "road" || nb === "lot") coastal = true;
        }
        if (!coastal) continue;
        const wx = this.worldX(gx);
        const wz = this.worldZ(gz);
        const half = ROAD_TILE * 0.46;
        this.solids.push({ minX: wx - half, maxX: wx + half, minZ: wz - half, maxZ: wz + half });
      }
    }

    // --- Outer border walls (close the south/inland map edge) ---
    const t = 3;
    const L = WORLD_HALF;
    this.solids.push({ minX: -L - t, maxX: -L, minZ: -L - t, maxZ: L + t });
    this.solids.push({ minX: L, maxX: L + t, minZ: -L - t, maxZ: L + t });
    this.solids.push({ minX: -L - t, maxX: L + t, minZ: -L - t, maxZ: -L });
    this.solids.push({ minX: -L - t, maxX: L + t, minZ: L, maxZ: L + t });

    // --- Displaced terrain ground (hills + island; ocean plane sits below) ---
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x3b3e36, roughness: 1 });
    this.group.add(this.terrain.buildMesh(groundMat));

    // --- Merge static meshes by material to slash draw calls ---
    for (const merged of mergeByMaterial(staticMeshes)) this.group.add(merged);
  }

  // Is the world position over a road cell (vs a building lot)?
  isOnRoad(x: number, z: number): boolean {
    const gx = this.gridX(x);
    const gz = this.gridZ(z);
    if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return false;
    return this.plan.cells[gx]?.[gz] === "road";
  }
}

// Bake world transforms and merge geometries that share a material, producing a
// handful of static meshes instead of hundreds of draw calls.
function mergeByMaterial(meshes: readonly THREE.Mesh[]): THREE.Mesh[] {
  type Group = { material: THREE.Material; attrs: string; geometries: THREE.BufferGeometry[] };
  const groups = new Map<string, Group>();

  for (const mesh of meshes) {
    const mat = mesh.material;
    if (Array.isArray(mat)) continue; // multi-material meshes left un-merged (rare here)
    const geo = mesh.geometry;
    if (!(geo instanceof THREE.BufferGeometry)) continue;
    const baked = geo.clone();
    baked.applyMatrix4(mesh.matrixWorld);
    // Normalize attributes so merge never fails on a mismatched set.
    const wanted = new Set(["position", "normal", "uv"]);
    for (const name of Object.keys(baked.attributes)) {
      if (!wanted.has(name)) baked.deleteAttribute(name);
    }
    if (!baked.getAttribute("uv") && baked.getAttribute("position")) {
      const count = baked.getAttribute("position").count;
      baked.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    // Deterministic signature in a fixed order (avoids a mutating sort).
    const attrs = ["position", "normal", "uv"].filter((n) => baked.getAttribute(n)).join(",");
    const key = `${mat.uuid}|${attrs}`;
    const g = groups.get(key);
    if (g) g.geometries.push(baked);
    else groups.set(key, { material: mat, attrs, geometries: [baked] });
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
}
