// The ground plane: a painted colour map (sand checker, speckle grain, tinted
// halos under water and bushes) multiplied by a baked occlusion map that
// darkens the floor around every solid tile. The occlusion bake is redone
// whenever props are destroyed or loot boxes appear, so it lives in its own
// canvas that is re-composited over the base.
import * as THREE from "three";

import { PROP, TILE } from "../config";
import { makeCanvas, seededRandom } from "../utils";
import {
  AO_TEXELS_PER_TILE,
  BASE_TEXELS_PER_TILE,
  GRID,
  GRID_HALF,
  gridIndex,
  inGrid,
} from "./grid";
import { context2d } from "./textures";
import { terrainHeight } from "./terrain";

const BASE_SIZE = GRID * BASE_TEXELS_PER_TILE;
const AO_SIZE = GRID * AO_TEXELS_PER_TILE;

const isBorderTile = (x: number, y: number): boolean =>
  x < 2 || y < 2 || x >= GRID - 2 || y >= GRID - 2;

const baseTileColor = (x: number, y: number, jitter: number): string => {
  const wx = x + 0.5 - GRID_HALF;
  const wz = y + 0.5 - GRID_HALF;
  if (isBorderTile(x, y)) {
    return `hsl(93, 23%, ${34 + jitter}%)`;
  }
  const path = Math.abs(wx) < 2 || Math.abs(wz) < 2 || Math.abs(Math.abs(wz) - 11) < 1;
  const courtyard = Math.abs(wx) < 5 && Math.abs(wz) < 5;
  if (path || courtyard) {
    return `hsl(43, 27%, ${69 + jitter + ((x + y) % 2) * 2}%)`;
  }
  return `hsl(${91 + Math.sin(x * 0.6 + y * 0.24) * 5}, 32%, ${47 + jitter + Math.sin(y * 0.7) * 2}%)`;
};

/** Meadow, worn limestone paths and a central tournament courtyard. */
export const paintBase = (tiles: Uint8Array, seed: number): HTMLCanvasElement => {
  const size = BASE_SIZE;
  const canvas = makeCanvas(size, size);
  const ctx = context2d(canvas);
  const rng = seededRandom(seed);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const jitter = (rng() - 0.5) * 3;
      ctx.fillStyle = baseTileColor(x, y, jitter);
      ctx.fillRect(
        x * BASE_TEXELS_PER_TILE,
        y * BASE_TEXELS_PER_TILE,
        BASE_TEXELS_PER_TILE,
        BASE_TEXELS_PER_TILE,
      );
    }
  }
  for (let i = 0; i < 9000; i += 1) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 0.6 + rng() * 1.6;
    ctx.fillStyle = rng() < 0.5 ? "rgba(39,74,40,0.12)" : "rgba(249,241,179,0.18)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 7);
    ctx.fill();
  }
  // Fine stone joints give the courtyard scale without gridding the meadow.
  ctx.strokeStyle = "rgba(84,91,62,0.16)";
  ctx.lineWidth = 1.2;
  for (let y = 2; y < GRID - 2; y += 1) {
    for (let x = 2; x < GRID - 2; x += 1) {
      const wx = x + 0.5 - GRID_HALF;
      const wz = y + 0.5 - GRID_HALF;
      if (Math.abs(wx) < 2 || Math.abs(wz) < 2 || (Math.abs(wx) < 5 && Math.abs(wz) < 5)) {
        ctx.strokeRect(x * BASE_TEXELS_PER_TILE + 1, y * BASE_TEXELS_PER_TILE + 1, 30, 30);
      }
    }
  }
  // Damp banks and mossy ground under concealing hedges.
  const halo = makeCanvas(size, size);
  const haloCtx = context2d(halo);
  haloCtx.fillStyle = "#fff";
  haloCtx.fillRect(0, 0, size, size);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const tile = tiles[gridIndex(x, y)];
      if (tile === TILE.WATER) {
        haloCtx.fillStyle = "#779580";
      } else if (tile === TILE.BUSH) {
        haloCtx.fillStyle = "#6b9558";
      } else {
        continue;
      }
      haloCtx.fillRect(x * BASE_TEXELS_PER_TILE - 3, y * BASE_TEXELS_PER_TILE - 3, 38, 38);
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.filter = "blur(7px)";
  ctx.drawImage(halo, 0, 0);
  ctx.restore();
  return canvas;
};

export interface Occluders {
  tiles: Uint8Array;
  styles: Uint8Array;
  blockers: Uint8Array;
}

/**
 * Bakes a blurred occlusion map into `target` (allocated on first use):
 * black under walls and blockers, grey under bushes, with lamp posts shrunk
 * to their slim base.
 */
export const paintAO = (
  { tiles, styles, blockers }: Occluders,
  target?: HTMLCanvasElement,
): HTMLCanvasElement => {
  const size = AO_SIZE;
  const mask = makeCanvas(size, size);
  const ctx = context2d(mask);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const i = gridIndex(x, y);
      const tile = tiles[i];
      if (tile === TILE.WALL || blockers[i]) {
        ctx.fillStyle = "#000";
      } else if (tile === TILE.BUSH) {
        ctx.fillStyle = "#6a6a6a";
      } else {
        continue;
      }
      const inset = tile === TILE.WALL && styles[i] === PROP.LAMP ? 3 : 0;
      ctx.fillRect(
        x * AO_TEXELS_PER_TILE + inset,
        y * AO_TEXELS_PER_TILE + inset,
        AO_TEXELS_PER_TILE - inset * 2,
        AO_TEXELS_PER_TILE - inset * 2,
      );
    }
  }
  const aoCanvas = target ?? makeCanvas(size, size);
  const aoCtx = context2d(aoCanvas);
  aoCtx.fillStyle = "#fff";
  aoCtx.fillRect(0, 0, size, size);
  aoCtx.filter = "blur(6px)";
  aoCtx.drawImage(mask, 0, 0);
  aoCtx.filter = "none";
  return aoCanvas;
};

/** Composites base × occlusion into `target` (allocated on first use). */
export const composeGround = (
  base: HTMLCanvasElement,
  ao: HTMLCanvasElement,
  target?: HTMLCanvasElement,
): HTMLCanvasElement => {
  const size = BASE_SIZE;
  const canvas = target ?? makeCanvas(size, size);
  const ctx = context2d(canvas);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.drawImage(base, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = 0.34;
  ctx.drawImage(ao, 0, 0, size, size);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return canvas;
};

type Vec3 = readonly [number, number, number];
type Uv = readonly [number, number];

/** Accumulates textured quads into flat attribute arrays. */
class QuadBuilder {
  readonly positions: number[] = [];
  readonly uvs: number[] = [];
  readonly normals: number[] = [];
  readonly indices: number[] = [];

  push(
    corners: readonly [Vec3, Vec3, Vec3, Vec3],
    normal: Vec3,
    uvs: readonly [Uv, Uv, Uv, Uv],
  ): void {
    const base = this.positions.length / 3;
    for (const corner of corners) {
      this.positions.push(corner[0], corner[1] + terrainHeight(corner[0], corner[2]), corner[2]);
    }
    for (let i = 0; i < 4; i += 1) {
      this.normals.push(normal[0], normal[1], normal[2]);
    }
    for (const uv of uvs) {
      this.uvs.push(uv[0], uv[1]);
    }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  toGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    return geometry;
  }
}

// How far water tiles drop below the floor, and the UV nudge that keeps the
// bank walls sampling the neighbouring sand rather than the water halo.
const BANK_DEPTH = -0.4;
const BANK_UV_INSET = 0.12 / GRID;

const uvX = (x: number): number => x / GRID;
const uvY = (y: number): number => 1 - y / GRID;

/** The four bank walls around a water tile, one per non-water neighbour. */
const pushBanks = (quads: QuadBuilder, tiles: Uint8Array, x: number, y: number): void => {
  const x0 = x - GRID_HALF;
  const z0 = y - GRID_HALF;
  const x1 = x0 + 1;
  const z1 = z0 + 1;
  const d = BANK_DEPTH;
  const u = BANK_UV_INSET;
  const dry = (dx: number, dy: number): boolean =>
    inGrid(x + dx, y + dy) && tiles[gridIndex(x + dx, y + dy)] !== TILE.WATER;
  if (dry(0, -1)) {
    quads.push(
      [
        [x0, 0, z0],
        [x1, 0, z0],
        [x1, d, z0],
        [x0, d, z0],
      ],
      [0, 0, 1],
      [
        [uvX(x), uvY(y) + u],
        [uvX(x + 1), uvY(y) + u],
        [uvX(x + 1), uvY(y) + u],
        [uvX(x), uvY(y) + u],
      ],
    );
  }
  if (dry(0, 1)) {
    quads.push(
      [
        [x1, 0, z1],
        [x0, 0, z1],
        [x0, d, z1],
        [x1, d, z1],
      ],
      [0, 0, -1],
      [
        [uvX(x + 1), uvY(y + 1) - u],
        [uvX(x), uvY(y + 1) - u],
        [uvX(x), uvY(y + 1) - u],
        [uvX(x + 1), uvY(y + 1) - u],
      ],
    );
  }
  if (dry(-1, 0)) {
    quads.push(
      [
        [x0, 0, z1],
        [x0, 0, z0],
        [x0, d, z0],
        [x0, d, z1],
      ],
      [1, 0, 0],
      [
        [uvX(x) - u, uvY(y + 1)],
        [uvX(x) - u, uvY(y)],
        [uvX(x) - u, uvY(y)],
        [uvX(x) - u, uvY(y + 1)],
      ],
    );
  }
  if (dry(1, 0)) {
    quads.push(
      [
        [x1, 0, z0],
        [x1, 0, z1],
        [x1, d, z1],
        [x1, d, z0],
      ],
      [-1, 0, 0],
      [
        [uvX(x + 1) + u, uvY(y)],
        [uvX(x + 1) + u, uvY(y + 1)],
        [uvX(x + 1) + u, uvY(y + 1)],
        [uvX(x + 1) + u, uvY(y)],
      ],
    );
  }
};

/** Floor quads for every non-water tile plus sunken banks around water. */
export const buildGroundGeometry = (tiles: Uint8Array): THREE.BufferGeometry => {
  const quads = new QuadBuilder();
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      if (tiles[gridIndex(x, y)] === TILE.WATER) {
        pushBanks(quads, tiles, x, y);
        continue;
      }
      const x0 = x - GRID_HALF;
      const z0 = y - GRID_HALF;
      const x1 = x0 + 1;
      const z1 = z0 + 1;
      quads.push(
        [
          [x0, 0, z0],
          [x0, 0, z1],
          [x1, 0, z1],
          [x1, 0, z0],
        ],
        [0, 1, 0],
        [
          [uvX(x), uvY(y)],
          [uvX(x), uvY(y + 1)],
          [uvX(x + 1), uvY(y + 1)],
          [uvX(x + 1), uvY(y)],
        ],
      );
    }
  }
  return quads.toGeometry();
};

/** Separate pond surfaces keep every pond seated in its own terrace. */
export const buildWaterGeometry = (tiles: Uint8Array): THREE.BufferGeometry => {
  const quads = new QuadBuilder();
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      if (tiles[gridIndex(x, y)] !== TILE.WATER) {
        continue;
      }
      const x0 = x - GRID_HALF;
      const z0 = y - GRID_HALF;
      quads.push(
        [
          [x0, -0.17, z0],
          [x0, -0.17, z0 + 1],
          [x0 + 1, -0.17, z0 + 1],
          [x0 + 1, -0.17, z0],
        ],
        [0, 1, 0],
        [
          [uvX(x), uvY(y)],
          [uvX(x), uvY(y + 1)],
          [uvX(x + 1), uvY(y + 1)],
          [uvX(x + 1), uvY(y)],
        ],
      );
    }
  }
  return quads.toGeometry();
};
