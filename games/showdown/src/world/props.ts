// Instanced arena props: limestone, supply crates, barrels and trees on wall
// tiles, the rock ring around the border, and the scatter of rocks and cacti
// on the dead ground outside the arena. All placement is drawn from one
// seeded stream in a fixed order so a seed always builds the same scene.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { PROP, TILE } from "../config";
import type { TileCoord } from "./grid";
import { terrainHeight } from "./terrain";
import {
  GRID,
  gridIndex,
  SCRATCH_COLOR,
  SCRATCH_EULER,
  SCRATCH_MATRIX,
  SCRATCH_POSITION,
  SCRATCH_QUATERNION,
  SCRATCH_SCALE,
  tileCenter,
} from "./grid";
import { bakeHeightTint, makeBarrelTexture, makeCrateTexture } from "./textures";

type Rng = () => number;

/** What the prop builders need from the world that owns the instances. */
export interface PropHost {
  disposables: { dispose: () => void }[];
  addInstanced: (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    count: number,
    castShadow?: boolean,
  ) => THREE.InstancedMesh;
  /** Tile index → instance index of the prop standing on it, or -1. */
  instanceOf: Int32Array;
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  rotX?: number;
  rotY: number;
  rotZ?: number;
  sx: number;
  sy: number;
  sz: number;
}

/** Writes one instance transform + colour; `tile` links it back to its grid cell. */
export const placeInstance = (
  host: PropHost,
  mesh: THREE.InstancedMesh,
  index: number,
  tile: TileCoord | undefined,
  placement: Placement,
  color: THREE.Color,
): void => {
  SCRATCH_EULER.set(placement.rotX ?? 0, placement.rotY, placement.rotZ ?? 0);
  SCRATCH_QUATERNION.setFromEuler(SCRATCH_EULER);
  SCRATCH_MATRIX.compose(
    SCRATCH_POSITION.set(
      placement.x,
      placement.y + terrainHeight(placement.x, placement.z),
      placement.z,
    ),
    SCRATCH_QUATERNION,
    SCRATCH_SCALE.set(placement.sx, placement.sy, placement.sz),
  );
  mesh.setMatrixAt(index, SCRATCH_MATRIX);
  mesh.setColorAt(index, color);
  if (tile) {
    host.instanceOf[gridIndex(tile[0], tile[1])] = index;
  }
};

/** Wall tiles grouped by prop style (lamp posts are built separately). */
export interface WallGroups {
  stones: TileCoord[];
  crates: TileCoord[];
  barrels: TileCoord[];
  cacti: TileCoord[];
  rocks: TileCoord[];
}

export const groupWallTiles = (tiles: Uint8Array, styles: Uint8Array): WallGroups => {
  const groups: WallGroups = { barrels: [], cacti: [], crates: [], rocks: [], stones: [] };
  const byStyle = new Map<number, TileCoord[]>([
    [PROP.STONE, groups.stones],
    [PROP.CRATE, groups.crates],
    [PROP.BARREL, groups.barrels],
    [PROP.CACTUS, groups.cacti],
    [PROP.ROCK, groups.rocks],
  ]);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const i = gridIndex(x, y);
      if (tiles[i] !== TILE.WALL) {
        continue;
      }
      byStyle.get(styles[i] ?? 0)?.push([x, y]);
    }
  }
  return groups;
};

/** Mostly waist-high stone blocks with the occasional tall one. */
export const buildStones = (host: PropHost, rng: Rng, spots: TileCoord[]): void => {
  const geometry = bakeHeightTint(new RoundedBoxGeometry(1, 1, 1, 3, 0.085), 0.62, 0.8);
  const material = new THREE.MeshStandardMaterial({
    color: 0xff_ff_ff,
    metalness: 0,
    roughness: 0.88,
    vertexColors: true,
  });
  const mesh = host.addInstanced("stone", geometry, material, spots.length);
  for (const [i, spot] of spots.entries()) {
    const [tx, ty] = spot;
    const height = rng() < 0.13 ? 1.75 + rng() * 0.2 : 1.02 + rng() * 0.28;
    SCRATCH_COLOR.setHSL(0.12 + rng() * 0.025, 0.13 + rng() * 0.06, 0.65 + rng() * 0.1);
    placeInstance(
      host,
      mesh,
      i,
      spot,
      {
        rotY: 0,
        sx: 1,
        sy: height,
        sz: 1,
        x: tileCenter(tx),
        y: height / 2 - 0.07,
        z: tileCenter(ty),
      },
      SCRATCH_COLOR,
    );
  }
};

export const buildCrates = (host: PropHost, rng: Rng, spots: TileCoord[]): void => {
  const geometry = bakeHeightTint(new THREE.BoxGeometry(0.94, 0.94, 0.94), 0.7);
  const map = makeCrateTexture();
  host.disposables.push(map);
  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.82,
    vertexColors: true,
  });
  const mesh = host.addInstanced("crate", geometry, material, spots.length);
  for (const [i, spot] of spots.entries()) {
    const [tx, ty] = spot;
    const scale = 0.97 + rng() * 0.06;
    SCRATCH_COLOR.setHSL(0.08, 0.1, 0.86 + rng() * 0.14);
    const rotY = (rng() < 0.5 ? 0 : Math.PI / 2) + (rng() - 0.5) * 0.12;
    placeInstance(
      host,
      mesh,
      i,
      spot,
      {
        rotY,
        sx: scale,
        sy: scale,
        sz: scale,
        x: tileCenter(tx),
        y: 0.47 * scale - 0.01,
        z: tileCenter(ty),
      },
      SCRATCH_COLOR,
    );
  }
};

export const buildBarrels = (host: PropHost, rng: Rng, spots: TileCoord[]): void => {
  const geometry = bakeHeightTint(new THREE.CylinderGeometry(0.41, 0.37, 1.04, 16), 0.68);
  const map = makeBarrelTexture();
  host.disposables.push(map);
  const material = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.7,
    vertexColors: true,
  });
  const mesh = host.addInstanced("barrel", geometry, material, spots.length);
  for (const [i, spot] of spots.entries()) {
    const [tx, ty] = spot;
    SCRATCH_COLOR.setHSL(0.07, 0.1, 0.85 + rng() * 0.15);
    const rotY = rng() * 6.28;
    placeInstance(
      host,
      mesh,
      i,
      spot,
      { rotY, sx: 1, sy: 1, sz: 1, x: tileCenter(tx), y: 0.51, z: tileCenter(ty) },
      SCRATCH_COLOR,
    );
  }
};

/** Coppiced woodland trees share the old obstacle slot, preserving seeded map IDs. */
export const buildCactusGeometry = (): THREE.BufferGeometry => {
  const parts = [
    new THREE.CylinderGeometry(0.12, 0.19, 1.1, 7).toNonIndexed().translate(0, 0.55, 0),
    new THREE.IcosahedronGeometry(0.57, 1).scale(1, 1.15, 1).translate(0, 1.15, 0),
    new THREE.IcosahedronGeometry(0.42, 1).translate(0.2, 1.65, 0.03),
  ];
  const geometry = mergeGeometries(parts);
  for (const part of parts) {
    part.dispose();
  }
  return bakeHeightTint(geometry, 0.4);
};

export interface Outskirts {
  rocks: TileCoord[];
  cacti: TileCoord[];
}

/** World-space scatter points on the dead ground beyond the arena walls. */
export const scatterOutskirts = (rng: Rng): Outskirts => {
  const rocks: TileCoord[] = [];
  const cacti: TileCoord[] = [];
  for (let i = 0; i < 150; i += 1) {
    const x = (rng() - 0.5) * 70;
    const z = (rng() - 0.5) * 66 - 4;
    if (Math.abs(x) < 22.8 && Math.abs(z) < 22.8) {
      continue;
    }
    (rng() < 0.62 ? rocks : cacti).push([x, z]);
  }
  return { cacti, rocks };
};

const borderRockHeight = (rng: Rng, tx: number, ty: number): number => {
  if (ty >= GRID - 2) {
    return 0.95 + rng() * 0.4;
  }
  const outerEdge = tx === 0 || ty === 0 || tx === GRID - 1 || ty === GRID - 1;
  return (outerEdge ? 1.9 : 1.35) + rng() * 0.9;
};

/** The rock ring on border tiles plus loose boulders in the outskirts. */
export const buildRocks = (
  host: PropHost,
  rng: Rng,
  borderSpots: TileCoord[],
  outskirtSpots: TileCoord[],
): void => {
  const geometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.09);
  const material = new THREE.MeshStandardMaterial({
    color: 0xff_ff_ff,
    metalness: 0,
    roughness: 0.93,
  });
  const mesh = host.addInstanced(
    "rock",
    geometry,
    material,
    borderSpots.length + outskirtSpots.length,
  );
  for (const [i, [tx, ty]] of borderSpots.entries()) {
    const height = borderRockHeight(rng, tx, ty);
    const width = 1.05 + rng() * 0.32;
    SCRATCH_COLOR.setHSL(0.11 + rng() * 0.025, 0.13 + rng() * 0.1, 0.48 + rng() * 0.1);
    const x = tileCenter(tx) + (rng() - 0.5) * 0.25;
    const z = tileCenter(ty) + (rng() - 0.5) * 0.25;
    const rotY = rng() * 6.28;
    const rotX = (rng() - 0.5) * 0.4;
    const rotZ = (rng() - 0.5) * 0.4;
    placeInstance(
      host,
      mesh,
      i,
      undefined,
      { rotX, rotY, rotZ, sx: width, sy: height, sz: width, x, y: height * 0.3, z },
      SCRATCH_COLOR,
    );
  }
  for (const [i, [x, z]] of outskirtSpots.entries()) {
    const size = 0.5 + rng() * 1.3;
    SCRATCH_COLOR.setHSL(0.13 + rng() * 0.025, 0.1 + rng() * 0.1, 0.46 + rng() * 0.12);
    const rotY = rng() * 6.28;
    const sy = size * (0.7 + rng() * 0.8);
    const rotX = (rng() - 0.5) * 0.5;
    const rotZ = (rng() - 0.5) * 0.5;
    placeInstance(
      host,
      mesh,
      borderSpots.length + i,
      undefined,
      { rotX, rotY, rotZ, sx: size, sy, sz: size, x, y: size * 0.28, z },
      SCRATCH_COLOR,
    );
  }
  mesh.instanceMatrix.needsUpdate = true;
};

/** Woodland trees on obstacle tiles and in the surrounding forest. */
export const buildCacti = (
  host: PropHost,
  rng: Rng,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  tileSpots: TileCoord[],
  outskirtSpots: TileCoord[],
): void => {
  const mesh = host.addInstanced(
    "cactus",
    geometry,
    material,
    tileSpots.length + outskirtSpots.length,
  );
  for (const [i, spot] of tileSpots.entries()) {
    const [tx, ty] = spot;
    const size = 1 + rng() * 0.3;
    SCRATCH_COLOR.setHSL(0.3 + rng() * 0.04, 0.42, 0.42 + rng() * 0.08);
    const rotY = rng() * 6.28;
    placeInstance(
      host,
      mesh,
      i,
      spot,
      { rotY, sx: size, sy: size, sz: size, x: tileCenter(tx), y: -0.04, z: tileCenter(ty) },
      SCRATCH_COLOR,
    );
  }
  for (const [i, [x, z]] of outskirtSpots.entries()) {
    const size = 0.8 + rng() * 0.7;
    SCRATCH_COLOR.setHSL(0.3 + rng() * 0.04, 0.38, 0.38 + rng() * 0.08);
    const rotY = rng() * 6.28;
    placeInstance(
      host,
      mesh,
      tileSpots.length + i,
      undefined,
      { rotY, sx: size, sy: size, sz: size, x, y: -0.04, z },
      SCRATCH_COLOR,
    );
  }
};

// Flat dead-ground planes past the arena edge: [x, z, width, depth].
const FRINGE_PLANES: readonly (readonly [number, number, number, number])[] = [
  [0, -67, 224, 90],
  [0, 67, 224, 90],
  [-67, 0, 90, 44],
  [67, 0, 90, 44],
];

/** Meadow beyond the tournament walls, matching the terraces. */
export const buildFringe = (group: THREE.Group, disposables: { dispose: () => void }[]): void => {
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(100 / 360, 0.25, 0.31),
    roughness: 1,
  });
  for (const [x, z, width, depth] of FRINGE_PLANES) {
    const geometry = new THREE.PlaneGeometry(width, depth, 1, Math.ceil(depth)).rotateX(
      -Math.PI / 2,
    );
    const position = geometry.getAttribute("position");
    for (let i = 0; i < position.count; i += 1) {
      position.setY(i, terrainHeight(position.getX(i) + x, position.getZ(i) + z));
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, 0, z);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geometry);
  }
  disposables.push(material);
};
