import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import type { ModelCache } from "../assets/loader";
import {
  BUILDINGS_COMMERCIAL,
  BUILDINGS_INDUSTRIAL,
  BUILDINGS_SKYSCRAPER,
  BUILDINGS_SUBURBAN,
  modelUrl,
  ROAD_CROSSING,
  ROAD_CROSSROAD,
  ROAD_CROSSROAD_LINE,
  ROAD_INTERSECTION,
  ROAD_INTERSECTION_LINE,
  ROAD_STRAIGHT,
  TREE_LARGE,
  TREE_SMALL,
} from "../assets/manifest";
import {
  CITY_SEED,
  GRID,
  ROAD_ROT_SIGN,
  ROAD_TILE,
  ROAD_Y,
  WORLD_HALF,
  WORLD_SIZE,
} from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import { conformToTerrain, toFloat32Attributes } from "./conform";
import { buildFurniture } from "./furniture";
import { buildGoldenGate } from "./golden-gate";
import { type CityPlan, generateCity } from "./grid";
import { buildLandmarks, landmarkProtection } from "./landmarks";
import { type DistrictChar, districtAt, makeTerrain, paletteFor, tintAmountFor } from "./sf-map";
import type { Terrain } from "./terrain";

export type Solid = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  // World-space top of the obstacle, when it CAN be jumped over (traffic).
  // Absent = infinitely tall (buildings, walls).
  readonly maxY?: number;
};

export type RoadCell = { readonly gx: number; readonly gz: number };

const HALF_PI = Math.PI / 2;

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
  private tintCache = new Map<string, THREE.Material>();

  constructor(
    private cache: ModelCache,
    private rng = new Rng(CITY_SEED),
  ) {
    this.terrain = makeTerrain();
    this.plan = generateCity();
    this.build();
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

  private poolFor(c: DistrictChar): readonly string[] {
    switch (c) {
      case "downtown":
      case "highrise":
        return this.rng.chance(0.55) ? BUILDINGS_SKYSCRAPER : BUILDINGS_COMMERCIAL;
      case "commercial":
      case "wharf":
        return BUILDINGS_COMMERCIAL;
      case "industrial":
        return BUILDINGS_INDUSTRIAL;
      case "victorian":
      case "residential":
      case "park":
        return BUILDINGS_SUBURBAN;
    }
  }

  private heightScaleFor(c: DistrictChar): number {
    switch (c) {
      case "highrise":
        return 1.6;
      case "downtown":
        return 1.3;
      case "commercial":
        return 1.05;
      case "industrial":
        return 1.0;
      case "park":
        return 1.0;
      case "victorian":
        return 0.9;
      case "residential":
        return 0.85;
      case "wharf":
        return 0.8;
    }
  }

  // District-tinted material clones, cached so tinted buildings still merge.
  private tintMaterial(base: THREE.Material, hex: number, amt: number): THREE.Material {
    if (!(base instanceof THREE.MeshStandardMaterial)) return base;
    const key = `${base.uuid}:${hex}:${amt}`;
    const cached = this.tintCache.get(key);
    if (cached) return cached;
    const m = base.clone();
    m.color.copy(base.color).lerp(new THREE.Color(hex), amt);
    this.tintCache.set(key, m);
    return m;
  }
  private tintNode(node: THREE.Object3D, hex: number, amt: number): void {
    node.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.Material) {
        c.material = this.tintMaterial(c.material, hex, amt);
      }
    });
  }

  private build(): void {
    const staticMeshes: THREE.Mesh[] = [];
    const collect = (obj: THREE.Object3D): void => {
      obj.updateMatrixWorld(true);
      obj.traverse((c) => {
        if (c instanceof THREE.Mesh) staticMeshes.push(c);
      });
    };
    // Bake an object's meshes to world space, drape them over the terrain
    // (subdivide + displace through the shared height field), and collect the
    // result. Used for anything that must hug the hills: roads, grass.
    const collectConformed = (obj: THREE.Object3D, lift: number): void => {
      obj.updateMatrixWorld(true);
      obj.traverse((c) => {
        if (!(c instanceof THREE.Mesh) || !(c.geometry instanceof THREE.BufferGeometry)) return;
        const mat = c.material;
        if (Array.isArray(mat)) return;
        const baked = c.geometry.clone();
        toFloat32Attributes(baked); // dequantize BEFORE baking world coords
        baked.applyMatrix4(c.matrixWorld);
        const draped = conformToTerrain(baked, this.terrain, lift);
        staticMeshes.push(new THREE.Mesh(draped, mat));
      });
    };

    // Grass patch + scattered trees on a cell (parks + block interiors).
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x52803d, roughness: 1 });
    const grassGeo = new THREE.PlaneGeometry(ROAD_TILE, ROAD_TILE, 4, 4);
    grassGeo.rotateX(-HALF_PI); // normal → +Y; conform drapes it over the slope
    const placeGreen = (gx: number, gz: number): void => {
      const wx = this.worldX(gx);
      const wz = this.worldZ(gz);
      const quad = new THREE.Mesh(grassGeo, grassMat);
      quad.position.set(wx, 0, wz);
      collectConformed(quad, 0.05);
      if (this.rng.chance(0.55)) {
        const count = 1 + this.rng.int(2);
        for (let i = 0; i < count; i++) {
          const treeUrl = modelUrl("props", this.rng.chance(0.6) ? TREE_LARGE : TREE_SMALL);
          const tb = this.cache.bounds(treeUrl);
          const tsc = (ROAD_TILE * 0.42) / Math.max(tb.size.y, 0.001);
          const tree = this.cache.instance(treeUrl);
          tree.scale.setScalar(tsc);
          const tx = wx + this.rng.range(-2.6, 2.6);
          const tz = wz + this.rng.range(-2.6, 2.6);
          tree.position.set(tx, this.terrain.heightAt(tx, tz), tz);
          tree.rotation.y = this.rng.range(0, Math.PI * 2);
          collect(tree);
        }
      }
    };

    // --- Roads ---
    // Swap in decorated variants: zebra crossings on straights that feed an
    // intersection in walkable districts; lane-marked junctions downtown.
    const decoratedTile = (gx: number, gz: number, tile: string): string => {
      const d = districtAt(gx, gz).character;
      if (tile === ROAD_STRAIGHT) {
        const walkable =
          d === "commercial" || d === "downtown" || d === "wharf" || d === "victorian";
        if (!walkable) return tile;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nb = this.plan.roads[gx + dx]?.[gz + dz];
          if (nb && (nb.tile === ROAD_CROSSROAD || nb.tile === ROAD_INTERSECTION)) {
            return ROAD_CROSSING;
          }
        }
        return tile;
      }
      if (d === "downtown" || d === "highrise") {
        if (tile === ROAD_CROSSROAD) return ROAD_CROSSROAD_LINE;
        if (tile === ROAD_INTERSECTION) return ROAD_INTERSECTION_LINE;
      }
      return tile;
    };
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        const r = this.plan.roads[gx]?.[gz];
        if (!r) continue;
        this.roadCells.push({ gx, gz });
        const url = modelUrl("roads", decoratedTile(gx, gz, r.tile));
        const tb = this.cache.bounds(url);
        const tile = this.cache.instance(url);
        // Scale by measured footprint (KayKit tiles aren't unit-sized), laid
        // flat with a hair of overlap, then draped over the height field —
        // adjacent tiles displace through the same surface, so they meet.
        const ts = (ROAD_TILE * 1.03) / Math.max(tb.size.x, tb.size.z, 0.001);
        tile.scale.set(ts, ts, ts);
        tile.position.set(this.worldX(gx), 0, this.worldZ(gz));
        tile.rotation.y = ROAD_ROT_SIGN * r.quarterTurns * HALF_PI;
        collectConformed(tile, ROAD_Y);
      }
    }

    // --- Landmark footprints: cells the procedural city leaves alone ---
    const lm = landmarkProtection(this.plan);
    for (const s of lm.solids) this.solids.push(s);

    // --- Buildings (district-driven pool, palette tint, height) ---
    for (const b of this.plan.buildingCells) {
      const cellId = `${b.gx},${b.gz}`;
      if (lm.reserved.has(cellId)) continue; // a landmark stands here
      const district = districtAt(b.gx, b.gz);
      const wx = this.worldX(b.gx);
      const wz = this.worldZ(b.gz);
      if (district.character === "park" || lm.parkGreen.has(cellId)) {
        placeGreen(b.gx, b.gz); // park frontage → green, drivable (no solid)
        continue;
      }
      const key = this.rng.pick(this.poolFor(district.character));
      const url = modelUrl("buildings", key);
      const bounds = this.cache.bounds(url);
      const footprint = Math.max(bounds.size.x, bounds.size.z, 0.001);
      const targetFootprint = ROAD_TILE * this.rng.range(0.74, 0.86); // fill lots, less bare ground
      const scale = targetFootprint / footprint;
      const node = this.cache.instance(url);
      // Victorians go narrow and tall — the SF row-house silhouette.
      const vict = district.character === "victorian";
      const sxz = scale * (vict ? 0.75 : 1);
      const sy = scale * this.heightScaleFor(district.character) * (vict ? 1.4 : 1);
      node.scale.set(sxz, sy, sxz);
      node.rotation.y = dirToYaw(b.faceDir) + BUILDING_FRONT_OFFSET;
      // Buildings stay vertical, seated at the LOWEST corner of the footprint so
      // no edge floats on a slope — the uphill side digs in, like real SF.
      const fh = targetFootprint / 2;
      const seatY = Math.min(
        this.terrain.heightAt(wx, wz),
        this.terrain.heightAt(wx - fh, wz - fh),
        this.terrain.heightAt(wx + fh, wz - fh),
        this.terrain.heightAt(wx - fh, wz + fh),
        this.terrain.heightAt(wx + fh, wz + fh),
      );
      node.position.set(wx, seatY - 0.15, wz);
      this.tintNode(node, this.rng.pick(paletteFor(district)), tintAmountFor(district));
      collect(node);

      // Solid footprint (a touch smaller than the visual so curbs are forgiving).
      const half = (targetFootprint / 2) * 0.96;
      this.solids.push({ minX: wx - half, maxX: wx + half, minZ: wz - half, maxZ: wz + half });

      // Occasional curbside tree, nudged toward the street.
      if (this.rng.chance(0.3)) {
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

    // --- Green block interiors ---
    for (const g of this.plan.greenCells) placeGreen(g.gx, g.gz);

    // --- Street furniture: lights, parked cars, yards, awnings, smokestacks,
    // construction chicanes, park allées, wharf piers + seawall. ---
    const fr = buildFurniture({
      plan: this.plan,
      terrain: this.terrain,
      cache: this.cache,
      rng: this.rng,
      reserved: lm.reserved,
      worldX: (g) => this.worldX(g),
      worldZ: (g) => this.worldZ(g),
    });
    for (const o of fr.objects) collect(o);
    for (const s of fr.solids) this.solids.push(s);
    this.addDecks(fr.pierDecks);

    // --- The drivable Golden Gate: ramp off the Presidio coast road onto an
    // orange deck over the strait, out to a railed vista turnaround. ---
    const gg = buildGoldenGate({
      plan: this.plan,
      terrain: this.terrain,
      cache: this.cache,
      worldX: (g) => this.worldX(g),
      worldZ: (g) => this.worldZ(g),
    });
    for (const o of gg.objects) collect(o);
    for (const s of gg.solids) this.solids.push(s);
    this.addDecks(gg.decks);

    // --- Shoreline collision: wall off each water cell that borders land so
    // the taxi can reach the waterfront but not drive into the bay. ---
    for (let gx = 0; gx < GRID; gx++) {
      for (let gz = 0; gz < GRID; gz++) {
        if (this.plan.cells[gx]?.[gz] !== "water") continue;
        const waterKey = `${gx},${gz}`;
        if (fr.openWaterCells.has(waterKey)) continue; // pier runs out here
        if (gg.openWaterCells.has(waterKey)) continue; // Golden Gate span
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

    // --- Displaced terrain ground (hills + island; ocean plane sits below),
    // vertex-graded: concrete in the city, Ocean Beach sand along the west
    // shore (half-strength on other shores), park green under the big parks. ---
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
    });
    const CONCRETE = new THREE.Color(0x9a9b92);
    const SAND = new THREE.Color(0xd9c9a1);
    const PARK = new THREE.Color(0x74975c);
    this.group.add(
      this.terrain.buildMesh(groundMat, (x, z, into) => {
        into.copy(CONCRETE);
        const gx = Math.min(GRID - 1, Math.max(0, this.gridX(x)));
        const gz = Math.min(GRID - 1, Math.max(0, this.gridZ(z)));
        if (districtAt(gx, gz).character === "park") into.lerp(PARK, 0.8);
        const land = this.terrain.landAt(x, z);
        const shore = 1 - THREE.MathUtils.smoothstep(land, 0.3, 0.55);
        if (shore > 0) {
          const u = x / WORLD_SIZE + 0.5;
          into.lerp(SAND, u < 0.12 ? shore : shore * 0.5); // Ocean Beach reads strongest
        }
      }),
    );

    // --- Merge static meshes by material to slash draw calls ---
    for (const merged of mergeByMaterial(staticMeshes)) this.group.add(merged);

    // --- Iconic landmarks (procedural; kept separate from the merge) ---
    this.group.add(buildLandmarks(this.terrain, this.cache));
  }

  // Is the world position over a road cell (vs a building lot)?
  isOnRoad(x: number, z: number): boolean {
    const gx = this.gridX(x);
    const gz = this.gridZ(z);
    if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return false;
    return this.plan.cells[gx]?.[gz] === "road";
  }

  // --- Surface (what the car drives on): terrain, overridden by decks —
  // flat (wharf piers) or Z-sloped ramps (bridge approaches). `y` is the
  // height at minZ; `y2` (when set) is the height at maxZ, lerped between. ---
  private decks: SurfaceDeck[] = [];

  addDecks(decks: readonly SurfaceDeck[]): void {
    for (const d of decks) this.decks.push(d);
  }

  getDecks(): readonly SurfaceDeck[] {
    return this.decks;
  }

  private deckHeight(d: SurfaceDeck, z: number): number {
    if (d.y2 === undefined || d.maxZ <= d.minZ) return d.y;
    const t = (z - d.minZ) / (d.maxZ - d.minZ);
    return d.y + (d.y2 - d.y) * t;
  }

  heightAt(x: number, z: number): number {
    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        return Math.max(this.deckHeight(d, z), this.terrain.heightAt(x, z));
      }
    }
    return this.terrain.heightAt(x, z);
  }

  normalInto(out: THREE.Vector3, x: number, z: number): THREE.Vector3 {
    for (const d of this.decks) {
      if (x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ) {
        // Only take the deck normal where the deck actually IS the surface.
        if (this.deckHeight(d, z) >= this.terrain.heightAt(x, z) - 0.05) {
          if (d.y2 === undefined || d.maxZ <= d.minZ) return out.set(0, 1, 0);
          const slope = (d.y2 - d.y) / (d.maxZ - d.minZ);
          return out.set(0, 1, -slope).normalize();
        }
      }
    }
    return this.terrain.normalInto(out, x, z);
  }
}

// A drivable surface patch floating over the terrain (pier deck, bridge ramp).
export type SurfaceDeck = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly y: number; // height at minZ
  readonly y2?: number; // height at maxZ (sloped ramp when set)
};

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
    // De-index up front: conformed geometry is non-indexed, and mergeGeometries
    // refuses to mix indexed with non-indexed in one group.
    const baked = geo.index ? geo.toNonIndexed() : geo.clone();
    toFloat32Attributes(baked); // dequantize meshopt attrs BEFORE baking world coords
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
