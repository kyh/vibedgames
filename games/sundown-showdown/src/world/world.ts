// The arena: a seeded 44×44 tile map and everything built from it — the
// painted ground, instanced props, grass, water and lamp posts — plus the
// spatial queries the rest of the game asks of it: tile lookups, circle
// collision, shot raycasts, A* paths and prop destruction.
import * as THREE from "three";

import { PROP, TILE } from "../config";
import { seededRandom } from "../utils";
import type { Position } from "./collision";
import { pushOutOfTile } from "./collision";
import type { GrassUniforms } from "./grass";
import {
  BLADES_PER_BUSH,
  buildBladeGeometry,
  collectBushTiles,
  makeGrassMaterial,
  makeGrassUniforms,
  populateBushes,
} from "./grass";
import type { TileCoord } from "./grid";
import {
  GRID_HALF,
  gridIndex,
  HIDDEN_MATRIX,
  inGrid,
  saltedSeed,
  TILE_COUNT,
  tileCenter,
  toTile,
} from "./grid";
import { buildGroundGeometry, composeGround, paintAO, paintBase } from "./ground";
import type { Lantern } from "./lamps";
import { buildLampGlassGeometry, buildLampPostGeometry, placeLamps } from "./lamps";
import { generateLayout } from "./layout";
import type { ExtraCost } from "./path";
import { Pathfinder } from "./path";
import type { WallGroups } from "./props";
import {
  buildBarrels,
  buildCacti,
  buildCactusGeometry,
  buildCrates,
  buildFringe,
  buildRocks,
  buildStones,
  groupWallTiles,
  scatterOutskirts,
} from "./props";
import { makeWaterNormalTexture } from "./textures";

interface Disposable {
  dispose: () => void;
}

/** Where a shot hit a solid tile. */
export interface RayHit {
  tx: number;
  ty: number;
  /** Distance travelled from the ray origin. */
  dist: number;
  x: number;
  z: number;
}

/** What was standing on a tile that just got destroyed. */
export interface BrokenTile {
  type: number;
  style: number;
  x: number;
  z: number;
}

interface GroundLayer {
  baseCanvas: HTMLCanvasElement;
  aoCanvas: HTMLCanvasElement;
  groundCanvas: HTMLCanvasElement;
  groundMap: THREE.CanvasTexture;
  groundAO: THREE.CanvasTexture;
}

interface WaterLayer {
  mesh: THREE.Mesh;
  normal: THREE.CanvasTexture;
}

interface LampLayer {
  glass: THREE.MeshStandardMaterial;
  lanterns: Lantern[];
}

// Salts that give each build pass its own random stream off the map seed.
const GROUND_SALT = 20_973;
const PROPS_SALT = 2577;
const GRASS_SALT = 2821;

// Instanced mesh that holds each breakable wall style, by prop id.
const WALL_MESH_NAMES = ["stone", "crate", "barrel", "cactus"];

// Seconds a dirty occlusion map waits before rebaking, so a burst of
// destruction costs one bake rather than one per tile.
const AO_REBAKE_DELAY = 0.3;

export class World {
  scene: THREE.Scene;
  anisotropy: number;
  group: THREE.Group;
  tiles: Uint8Array;
  styles: Uint8Array;
  /** 1 where a loot box or other dynamic obstacle occupies the tile. */
  blockers: Uint8Array;
  /** Tile index → instance index of the prop standing on it, or -1. */
  instanceOf: Int32Array;
  /** Per tile `[firstBlade, bladeCount]` into the bush instances. */
  bushRange: Int32Array;
  spawns: TileCoord[] = [];
  boxSpots: TileCoord[] = [];
  lampTiles: TileCoord[] = [];
  lanterns: Lantern[];
  meshes: Record<string, THREE.InstancedMesh> = {};
  disposables: Disposable[] = [];
  aoDirty = false;
  aoTimer = 0;
  /** Tile indices destroyed so far, in order — a late joiner replays them. */
  broken: number[] = [];
  grassUniforms: GrassUniforms;
  seed = 0;
  baseCanvas: HTMLCanvasElement;
  aoCanvas: HTMLCanvasElement;
  groundCanvas: HTMLCanvasElement;
  groundMap: THREE.CanvasTexture;
  groundAO: THREE.CanvasTexture;
  water: THREE.Mesh | undefined;
  waterNormal: THREE.CanvasTexture | undefined;
  lampGlass: THREE.MeshStandardMaterial;
  private readonly pathfinder = new Pathfinder();

  constructor(scene: THREE.Scene, seed: number, maxAniso = 8) {
    this.scene = scene;
    this.anisotropy = maxAniso;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tiles = new Uint8Array(TILE_COUNT);
    this.styles = new Uint8Array(TILE_COUNT);
    this.blockers = new Uint8Array(TILE_COUNT);
    this.instanceOf = new Int32Array(TILE_COUNT).fill(-1);
    this.bushRange = new Int32Array(TILE_COUNT * 2).fill(-1);
    this.grassUniforms = makeGrassUniforms();
    this.generate(seed);
    const ground = this.buildGround();
    this.baseCanvas = ground.baseCanvas;
    this.aoCanvas = ground.aoCanvas;
    this.groundCanvas = ground.groundCanvas;
    this.groundMap = ground.groundMap;
    this.groundAO = ground.groundAO;
    const propRng = seededRandom(saltedSeed(this.seed, PROPS_SALT));
    const walls = this.buildWalls(propRng);
    this.buildBushes();
    const water = this.buildWater();
    this.water = water?.mesh;
    this.waterNormal = water?.normal;
    const lamps = this.buildLamps();
    this.lampGlass = lamps.glass;
    this.lanterns = lamps.lanterns;
    this.buildOutskirts(propRng, walls);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the world's public query surface
  toTile(world: number): number {
    return toTile(world);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the world's public query surface
  center(tile: number): number {
    return tileCenter(tile);
  }

  /** Tile type under a world position; everything off the grid counts as wall. */
  tileAt(x: number, z: number): number {
    const tx = toTile(x);
    const ty = toTile(z);
    return inGrid(tx, ty) ? (this.tiles[gridIndex(tx, ty)] ?? TILE.WALL) : TILE.WALL;
  }

  isBushAt(x: number, z: number): boolean {
    return this.tileAt(x, z) === TILE.BUSH;
  }

  /** Blocks movement: walls, water, loot boxes and anything off the grid. */
  isSolidTile(tx: number, ty: number): boolean {
    if (!inGrid(tx, ty)) {
      return true;
    }
    const i = gridIndex(tx, ty);
    const tile = this.tiles[i];
    return tile === TILE.WALL || tile === TILE.WATER || this.blockers[i] === 1;
  }

  /** Blocks shots: walls and loot boxes, but bullets fly over water. */
  blocksShots(tx: number, ty: number): boolean {
    if (!inGrid(tx, ty)) {
      return true;
    }
    const i = gridIndex(tx, ty);
    return this.tiles[i] === TILE.WALL || this.blockers[i] === 1;
  }

  isWalkable(tx: number, ty: number): boolean {
    return !this.isSolidTile(tx, ty);
  }

  /** Bushes and every wall prop except the rock border and lamp posts. */
  isBreakable(tx: number, ty: number): boolean {
    if (!inGrid(tx, ty)) {
      return false;
    }
    const i = gridIndex(tx, ty);
    if (this.tiles[i] === TILE.BUSH) {
      return true;
    }
    return (
      this.tiles[i] === TILE.WALL && this.styles[i] !== PROP.ROCK && this.styles[i] !== PROP.LAMP
    );
  }

  /** Rolls the seed forward until a layout passes validation (up to 60 tries). */
  private generate(seed: number): void {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      // oxlint-disable-next-line no-bitwise, unicorn/prefer-math-trunc -- `| 0` wraps the derived seed to int32 like the RNG expects
      const candidate = (seed + attempt * 7919) | 0;
      const layout = generateLayout(seededRandom(candidate), this.tiles, this.styles);
      this.spawns = layout.spawns;
      this.lampTiles = layout.lampTiles;
      this.boxSpots = layout.boxSpots;
      if (layout.valid) {
        this.seed = candidate;
        return;
      }
    }
    console.warn("[world] map validation kept failing; using last attempt");
  }

  private buildGround(): GroundLayer {
    const baseCanvas = paintBase(this.tiles, saltedSeed(this.seed, GROUND_SALT));
    const aoCanvas = paintAO(this);
    const groundCanvas = composeGround(baseCanvas, aoCanvas);
    const groundMap = new THREE.CanvasTexture(groundCanvas);
    groundMap.colorSpace = THREE.SRGBColorSpace;
    groundMap.anisotropy = this.anisotropy;
    const groundAO = new THREE.CanvasTexture(aoCanvas);
    groundAO.anisotropy = 4;
    const geometry = buildGroundGeometry(this.tiles);
    const material = new THREE.MeshStandardMaterial({
      aoMap: groundAO,
      aoMapIntensity: 1,
      map: groundMap,
      metalness: 0,
      roughness: 0.96,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.name = "ground";
    this.group.add(mesh);
    this.disposables.push(geometry, material, groundMap, groundAO);
    return { aoCanvas, baseCanvas, groundAO, groundCanvas, groundMap };
  }

  rebakeGround(): void {
    paintAO(this, this.aoCanvas);
    composeGround(this.baseCanvas, this.aoCanvas, this.groundCanvas);
    this.groundMap.needsUpdate = true;
    this.groundAO.needsUpdate = true;
  }

  addInstanced(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    count: number,
    castShadow = true,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, count));
    mesh.count = count;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.name = name;
    this.group.add(mesh);
    this.meshes[name] = mesh;
    this.disposables.push(geometry, material);
    return mesh;
  }

  private buildWalls(rng: () => number): WallGroups {
    const groups = groupWallTiles(this.tiles, this.styles);
    buildStones(this, rng, groups.stones);
    buildCrates(this, rng, groups.crates);
    buildBarrels(this, rng, groups.barrels);
    return groups;
  }

  private buildOutskirts(rng: () => number, groups: WallGroups): void {
    const scatter = scatterOutskirts(rng);
    buildRocks(this, rng, groups.rocks, scatter.rocks);
    const cactusGeometry = buildCactusGeometry();
    const cactusMaterial = new THREE.MeshStandardMaterial({
      color: 0xff_ff_ff,
      roughness: 0.7,
      vertexColors: true,
    });
    buildCacti(this, rng, cactusGeometry, cactusMaterial, groups.cacti, scatter.cacti);
    buildFringe(this.group, this.disposables);
  }

  private buildBushes(): void {
    const rng = seededRandom(saltedSeed(this.seed, GRASS_SALT));
    const bushes = collectBushTiles(this.tiles);
    const geometry = buildBladeGeometry();
    const material = makeGrassMaterial(this.grassUniforms);
    const mesh = this.addInstanced("bush", geometry, material, bushes.length * BLADES_PER_BUSH);
    populateBushes(mesh, bushes, this.bushRange, rng);
  }

  private buildWater(): WaterLayer | undefined {
    if (!this.tiles.includes(TILE.WATER)) {
      return undefined;
    }
    const normal = makeWaterNormalTexture();
    const material = new THREE.MeshStandardMaterial({
      color: 0x1f_9f_c4,
      emissive: 0x06_38_4f,
      emissiveIntensity: 0.35,
      envMapIntensity: 1.6,
      metalness: 0.05,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 0.07,
    });
    const geometry = new THREE.PlaneGeometry(GRID_HALF * 2, GRID_HALF * 2).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = -0.17;
    mesh.receiveShadow = true;
    mesh.name = "water";
    this.group.add(mesh);
    this.disposables.push(geometry, material, normal);
    return { mesh, normal };
  }

  private buildLamps(): LampLayer {
    const count = this.lampTiles.length;
    const postMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a_4f_60,
      metalness: 0.25,
      roughness: 0.55,
    });
    const posts = this.addInstanced("lampPost", buildLampPostGeometry(), postMaterial, count);
    const glass = new THREE.MeshStandardMaterial({
      color: 0x3a_2a_14,
      emissive: 0xff_b4_5a,
      emissiveIntensity: 0.15,
      roughness: 0.3,
    });
    const lanternMesh = this.addInstanced(
      "lampGlass",
      buildLampGlassGeometry(),
      glass,
      count,
      false,
    );
    lanternMesh.receiveShadow = false;
    const lanterns = placeLamps(posts, lanternMesh, this.lampTiles);
    return { glass, lanterns };
  }

  /** Removes a breakable tile's prop or bush; returns what stood there, or null. */
  destroyTile(tx: number, ty: number): BrokenTile | null {
    if (!this.isBreakable(tx, ty)) {
      return null;
    }
    const i = gridIndex(tx, ty);
    const broken: BrokenTile = {
      style: this.styles[i] ?? 0,
      type: this.tiles[i] ?? TILE.EMPTY,
      x: tileCenter(tx),
      z: tileCenter(ty),
    };
    if (this.tiles[i] === TILE.BUSH) {
      const first = this.bushRange[i * 2] ?? 0;
      const count = this.bushRange[i * 2 + 1] ?? 0;
      const { bush } = this.meshes;
      if (bush) {
        for (let blade = 0; blade < count; blade += 1) {
          bush.setMatrixAt(first + blade, HIDDEN_MATRIX);
        }
        bush.instanceMatrix.needsUpdate = true;
      }
    } else {
      const name = WALL_MESH_NAMES[this.styles[i] ?? 0];
      const mesh = name === undefined ? undefined : this.meshes[name];
      const instance = this.instanceOf[i] ?? -1;
      if (mesh && instance >= 0) {
        mesh.setMatrixAt(instance, HIDDEN_MATRIX);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.tiles[i] = TILE.EMPTY;
    this.broken.push(i);
    this.aoDirty = true;
    return broken;
  }

  setBlocker(tx: number, ty: number, on: boolean): void {
    this.blockers[gridIndex(tx, ty)] = on ? 1 : 0;
    this.aoDirty = true;
  }

  /** Pushes a circle out of every solid tile it overlaps (two passes settle corners). */
  resolveCircle(pos: Position, radius: number): void {
    for (let pass = 0; pass < 2; pass += 1) {
      const cx = toTile(pos.x);
      const cy = toTile(pos.z);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (this.isSolidTile(cx + dx, cy + dy)) {
            pushOutOfTile(pos, radius, cx + dx, cy + dy);
          }
        }
      }
    }
  }

  /**
   * Walks the grid from (x0, z0) toward (x1, z1) and reports the first tile
   * that blocks shots, or null if the segment is clear.
   */
  raycast(x0: number, z0: number, x1: number, z1: number, out?: RayHit): RayHit | null {
    let tx = toTile(x0);
    let ty = toTile(z0);
    const dx = x1 - x0;
    const dz = z1 - z0;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) {
      return null;
    }
    const dirX = dx / length;
    const dirZ = dz / length;
    const stepX = dirX > 0 ? 1 : -1;
    const stepY = dirZ > 0 ? 1 : -1;
    const deltaX = dirX === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dirX);
    const deltaY = dirZ === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dirZ);
    const fracX = x0 + GRID_HALF - tx;
    const fracZ = z0 + GRID_HALF - ty;
    let nextX = dirX === 0 ? Number.POSITIVE_INFINITY : (dirX > 0 ? 1 - fracX : fracX) * deltaX;
    let nextY = dirZ === 0 ? Number.POSITIVE_INFINITY : (dirZ > 0 ? 1 - fracZ : fracZ) * deltaY;
    let travelled = 0;
    for (let step = 0; step < 160; step += 1) {
      if (nextX < nextY) {
        travelled = nextX;
        nextX += deltaX;
        tx += stepX;
      } else {
        travelled = nextY;
        nextY += deltaY;
        ty += stepY;
      }
      if (travelled > length) {
        return null;
      }
      if (this.blocksShots(tx, ty)) {
        const hit = out ?? { dist: 0, tx: 0, ty: 0, x: 0, z: 0 };
        hit.tx = tx;
        hit.ty = ty;
        hit.dist = travelled;
        hit.x = x0 + dirX * travelled;
        hit.z = z0 + dirZ * travelled;
        return hit;
      }
    }
    return null;
  }

  hasLineOfSight(x0: number, z0: number, x1: number, z1: number): boolean {
    return this.raycast(x0, z0, x1, z1) === null;
  }

  /** A* between tiles; see `Pathfinder.find`. */
  findPath(
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    extraCost?: ExtraCost,
  ): TileCoord[] | null {
    return this.pathfinder.find((x, y) => this.isWalkable(x, y), sx, sy, tx, ty, extraCost);
  }

  /** The closest walkable point to (x, z), searching rings up to four tiles out. */
  nearestOpen(x: number, z: number): Position {
    const cx = toTile(x);
    const cy = toTile(z);
    let best: Position | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let ring = 0; ring <= 4 && !best; ring += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        for (let dx = -ring; dx <= ring; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring || !this.isWalkable(cx + dx, cy + dy)) {
            continue;
          }
          const px = tileCenter(cx + dx);
          const pz = tileCenter(cy + dy);
          const dist = (px - x) * (px - x) + (pz - z) * (pz - z);
          if (dist < bestDist) {
            bestDist = dist;
            best = ring === 0 ? { x, z } : { x: px, z: pz };
          }
        }
      }
    }
    return best ?? { x, z };
  }

  update(dt: number, elapsed: number): void {
    this.grassUniforms.uTime.value = elapsed;
    if (this.waterNormal) {
      this.waterNormal.offset.set(elapsed * 0.021, elapsed * 0.013);
    }
    if (this.aoDirty) {
      this.aoTimer -= dt;
      if (this.aoTimer <= 0) {
        this.rebakeGround();
        this.aoDirty = false;
        this.aoTimer = AO_REBAKE_DELAY;
      }
    } else {
      this.aoTimer = Math.max(0, this.aoTimer - dt);
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const item of this.disposables) {
      item.dispose();
    }
    for (const mesh of Object.values(this.meshes)) {
      mesh?.dispose();
    }
  }
}
