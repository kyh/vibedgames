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
import {
  CHUNK,
  CITY_SEED,
  DRAW_DISTANCE,
  GRID_X,
  GRID_Z,
  ROAD_ROT_SIGN,
  ROAD_TILE,
  ROAD_Y,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import { Rng } from "../shared/rng";
import { type Dir, DIR_DELTA, E, N, S, W } from "../shared/types";
import { conformToTerrain, toFloat32Attributes } from "./conform";
import { CUSTOM_PROPS } from "./custom-props";
import { buildFurniture } from "./furniture";
import { buildGoldenGate } from "./golden-gate";
import { type CityPlan, generateCity } from "./grid";
import { buildRoads } from "./roads";
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
// Hillside foundations: concrete plinth under buildings on a grade.
const PLINTH_GEO = new THREE.BoxGeometry(1, 1, 1);
const PLINTH_MAT = new THREE.MeshStandardMaterial({ color: 0xb3aca0, roughness: 1 });

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

// A streamed tile of static city geometry: its own merged meshes under one
// group, tagged with a centre + cull radius so it can be hidden when far away.
type Chunk = { cx: number; cz: number; radius: number; group: THREE.Group };

export class CityModel {
  readonly group = new THREE.Group();
  readonly solids: Solid[] = [];
  readonly roadCells: RoadCell[] = [];
  readonly plan: CityPlan;
  readonly terrain: Terrain;
  private tintCache = new Map<string, THREE.Material>();
  private chunks: Chunk[] = [];

  constructor(
    private cache: ModelCache,
    private rng = new Rng(CITY_SEED),
  ) {
    this.terrain = makeTerrain();
    this.plan = generateCity();
    this.build();
  }

  worldX(gx: number): number {
    return (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
  }
  worldZ(gz: number): number {
    return (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
  }
  gridX(x: number): number {
    return Math.floor((x + WORLD_HALF_X) / ROAD_TILE);
  }
  gridZ(z: number): number {
    return Math.floor((z + WORLD_HALF_Z) / ROAD_TILE);
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

    // --- Roads: procedural street geometry generated straight from the
    // network graph (world/roads.ts) — asphalt/curbs/sidewalks/markings can
    // never disagree with the connections. ---
    for (let gx = 0; gx < GRID_X; gx++) {
      for (let gz = 0; gz < GRID_Z; gz++) {
        if (this.plan.roads[gx]?.[gz]) this.roadCells.push({ gx, gz });
      }
    }
    for (const mesh of buildRoads(this.plan, this.terrain)) staticMeshes.push(mesh);

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
      // Buildings stay vertical. Seat at the HIGHEST corner so the hill never
      // cuts through walls; a concrete plinth fills the downhill gap (stilted
      // SF hillside foundations). Extreme grades get greenery instead.
      const fh = targetFootprint / 2;
      const corners = [
        this.terrain.heightAt(wx, wz),
        this.terrain.heightAt(wx - fh, wz - fh),
        this.terrain.heightAt(wx + fh, wz - fh),
        this.terrain.heightAt(wx - fh, wz + fh),
        this.terrain.heightAt(wx + fh, wz + fh),
      ];
      const loY = Math.min(...corners);
      const seatY = Math.max(...corners);
      const drop = seatY - loY;
      if (drop > 5) {
        // Too steep to build — real SF leaves these faces green.
        for (let i = 0; i < 3; i++) {
          const steepTreeUrl = modelUrl("props", this.rng.chance(0.5) ? TREE_LARGE : TREE_SMALL);
          const stb = this.cache.bounds(steepTreeUrl);
          const sts = (ROAD_TILE * 0.3) / Math.max(stb.size.y, 0.001);
          const steepTree = this.cache.instance(steepTreeUrl);
          steepTree.scale.setScalar(sts);
          const stx = wx + this.rng.range(-3.5, 3.5);
          const stz = wz + this.rng.range(-3.5, 3.5);
          steepTree.position.set(stx, this.terrain.heightAt(stx, stz), stz);
          steepTree.rotation.y = this.rng.range(0, Math.PI * 2);
          collect(steepTree);
        }
        continue;
      }
      if (drop > 0.7) {
        const plinth = new THREE.Mesh(PLINTH_GEO, PLINTH_MAT);
        const ph = drop + 0.8;
        plinth.scale.set(targetFootprint * 0.98, ph, targetFootprint * 0.98);
        plinth.position.set(wx, seatY - 0.1 - ph / 2, wz);
        plinth.updateMatrixWorld(true);
        collect(plinth);
      }
      node.position.set(wx, seatY - 0.15, wz);
      this.tintNode(node, this.rng.pick(paletteFor(district)), tintAmountFor(district));
      collect(node);

      // Solid footprint (a touch smaller than the visual so curbs are forgiving).
      const half = (targetFootprint / 2) * 0.96;
      this.solids.push({ minX: wx - half, maxX: wx + half, minZ: wz - half, maxZ: wz + half });

      // Rooftop watertower — the classic city-builder silhouette — on some
      // mid-rise commercial roofs.
      if (
        (district.character === "commercial" || district.character === "downtown") &&
        this.rng.chance(0.09)
      ) {
        const towerUrl = modelUrl("props", "kk-watertower");
        const twb = this.cache.bounds(towerUrl);
        const roofY = seatY - 0.15 + bounds.size.y * sy;
        const tws = 3.4 / Math.max(twb.size.y, 0.001);
        const tower = this.cache.instance(towerUrl);
        tower.scale.setScalar(tws);
        tower.rotation.y = this.rng.range(0, Math.PI * 2);
        tower.position.set(
          wx + this.rng.range(-1.5, 1.5),
          roofY - 0.1,
          wz + this.rng.range(-1.5, 1.5),
        );
        collect(tower);
      }

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
    for (let gx = 0; gx < GRID_X; gx++) {
      for (let gz = 0; gz < GRID_Z; gz++) {
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
    const LX = WORLD_HALF_X;
    const LZ = WORLD_HALF_Z;
    this.solids.push({ minX: -LX - t, maxX: -LX, minZ: -LZ - t, maxZ: LZ + t }); // west
    this.solids.push({ minX: LX, maxX: LX + t, minZ: -LZ - t, maxZ: LZ + t }); // east
    this.solids.push({ minX: -LX - t, maxX: LX + t, minZ: -LZ - t, maxZ: -LZ }); // north
    this.solids.push({ minX: -LX - t, maxX: LX + t, minZ: LZ, maxZ: LZ + t }); // south

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
    const ground = this.terrain.buildMesh(groundMat, (x, z, into) => {
      into.copy(CONCRETE);
      const gx = Math.min(GRID_X - 1, Math.max(0, this.gridX(x)));
      const gz = Math.min(GRID_Z - 1, Math.max(0, this.gridZ(z)));
      if (districtAt(gx, gz).character === "park") into.lerp(PARK, 0.8);
      const land = this.terrain.landAt(x, z);
      const shore = 1 - THREE.MathUtils.smoothstep(land, 0.3, 0.55);
      if (shore > 0) {
        const u = x / WORLD_W + 0.5;
        into.lerp(SAND, u < 0.12 ? shore : shore * 0.5); // Ocean Beach reads strongest
      }
    });
    ground.name = "terrain-ground"; // the map editor raycasts against this
    this.group.add(ground);

    // --- Hand-placed decorations from the map editor (world/custom-props.ts) ---
    for (const p of CUSTOM_PROPS) {
      const parts = p.model.split("/");
      const cat = parts[0];
      const name = parts[1];
      if (!cat || !name) continue;
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
        this.solids.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz });
      }
    }

    // --- Bucket static meshes into spatial chunks, then merge each chunk by
    // material. Per-chunk merges keep draw calls low while giving the renderer
    // tight bounds to frustum-cull, and let updateStreaming() hide far tiles. ---
    const nx = Math.ceil(WORLD_W / CHUNK);
    const nz = Math.ceil(WORLD_H / CHUNK);
    const buckets = new Map<number, THREE.Mesh[]>();
    const centroid = new THREE.Vector3();
    for (const mesh of staticMeshes) {
      if (!(mesh.geometry instanceof THREE.BufferGeometry)) continue;
      mesh.geometry.computeBoundingBox();
      mesh.geometry.boundingBox?.getCenter(centroid);
      centroid.applyMatrix4(mesh.matrixWorld);
      const cx = Math.min(nx - 1, Math.max(0, Math.floor((centroid.x + WORLD_HALF_X) / CHUNK)));
      const cz = Math.min(nz - 1, Math.max(0, Math.floor((centroid.z + WORLD_HALF_Z) / CHUNK)));
      const key = cz * nx + cx;
      const list = buckets.get(key);
      if (list) list.push(mesh);
      else buckets.set(key, [mesh]);
    }
    // Half-diagonal of a chunk, plus slack for geometry (trees, tall roofs) that
    // overhangs its tile — used as the cull radius so nothing pops at the edge.
    const cullRadius = CHUNK * 0.71 + ROAD_TILE * 2;
    for (const [key, meshes] of buckets) {
      const cx = key % nx;
      const cz = Math.floor(key / nx);
      const group = new THREE.Group();
      for (const merged of mergeByMaterial(meshes)) group.add(merged);
      this.group.add(group);
      this.chunks.push({
        cx: (cx + 0.5) * CHUNK - WORLD_HALF_X,
        cz: (cz + 0.5) * CHUNK - WORLD_HALF_Z,
        radius: cullRadius,
        group,
      });
    }

    // --- Iconic landmarks (procedural; kept separate — always visible) ---
    this.group.add(buildLandmarks(this.terrain, this.cache));
  }

  // Hide chunks whose nearest point is beyond the draw distance from the camera.
  // Frustum culling (per merged mesh, automatic) removes tiles behind and beside
  // the camera; this removes distant tiles ahead, past the fog.
  updateStreaming(camX: number, camZ: number): void {
    for (const c of this.chunks) {
      const d = Math.hypot(camX - c.cx, camZ - c.cz) - c.radius;
      const visible = d < DRAW_DISTANCE;
      if (c.group.visible !== visible) c.group.visible = visible;
    }
  }

  // Is the world position over a road cell (vs a building lot)?
  isOnRoad(x: number, z: number): boolean {
    const gx = this.gridX(x);
    const gz = this.gridZ(z);
    if (gx < 0 || gz < 0 || gx >= GRID_X || gz >= GRID_Z) return false;
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
