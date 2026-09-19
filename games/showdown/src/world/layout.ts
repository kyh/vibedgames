// Seeded map generation. The arena is four-fold mirror symmetric: every
// feature is stamped into all four quadrants at once so each spawn corner
// sees the same cover. A candidate layout is rejected unless the open floor
// is one connected region that reaches every spawn, the centre and enough
// loot-box spots — the caller re-rolls the seed until one passes.
import { PROP, TILE } from "../config";
import type { TileCoord } from "./grid";
import { CARDINALS, GRID, GRID_HALF, TILE_COUNT, gridIndex, inGrid } from "./grid";

export interface Layout {
  spawns: TileCoord[];
  lampTiles: TileCoord[];
  boxSpots: TileCoord[];
  /** Whether the layout passed connectivity validation. */
  valid: boolean;
}

type Rng = () => number;

interface Draft {
  rng: Rng;
  tiles: Uint8Array;
  styles: Uint8Array;
  /** Tiles kept clear around each spawn — nothing may be placed there. */
  reserved: Uint8Array;
}

// Eight spawn pads: one per corner, one per edge midpoint.
const SPAWN_TILES: readonly (readonly [number, number])[] = [
  [6, 6],
  [37, 6],
  [6, 37],
  [37, 37],
  [21, 5],
  [38, 21],
  [22, 38],
  [5, 22],
];

const BORDER = 2;
const LAST = GRID - 1;
const QUADRANT_MAX = GRID_HALF - 1;

const randInt = (rng: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

/** The four mirror images of a tile, including itself. */
const mirrored = (x: number, y: number): TileCoord[] => [
  [x, y],
  [LAST - x, y],
  [x, LAST - y],
  [LAST - x, LAST - y],
];

/** Chebyshev distance from the tile centre to the arena centre. */
const ringDistance = (x: number, y: number): number =>
  Math.max(Math.abs(x + 0.5 - GRID_HALF), Math.abs(y + 0.5 - GRID_HALF));

/**
 * Stamps `tile` into the quadrant tile and its three mirrors, skipping
 * reserved or already-occupied tiles. Only bushes may sit within the central
 * clearing. Returns whether at least one tile was written.
 */
const placeMirrored = (draft: Draft, x: number, y: number, tile: number, style = 0): boolean => {
  if (x < BORDER || y < BORDER || x > QUADRANT_MAX || y > QUADRANT_MAX) {
    return false;
  }
  if (tile !== TILE.BUSH && ringDistance(x, y) < 3.6) {
    return false;
  }
  let placed = false;
  for (const [mx, my] of mirrored(x, y)) {
    const i = gridIndex(mx, my);
    if (draft.reserved[i] || draft.tiles[i] !== TILE.EMPTY) {
      continue;
    }
    draft.tiles[i] = tile;
    draft.styles[i] = style;
    placed = true;
  }
  return placed;
};

const carveBorder = (draft: Draft): void => {
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      if (x < BORDER || y < BORDER || x >= GRID - BORDER || y >= GRID - BORDER) {
        draft.tiles[gridIndex(x, y)] = TILE.WALL;
        draft.styles[gridIndex(x, y)] = PROP.ROCK;
      }
    }
  }
};

const reserveSpawns = (draft: Draft, spawns: TileCoord[]): void => {
  for (const [sx, sy] of spawns) {
    for (const [mx, my] of mirrored(sx, sy)) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (inGrid(mx + dx, my + dy)) {
            draft.reserved[gridIndex(mx + dx, my + dy)] = 1;
          }
        }
      }
    }
  }
};

const pickWallStyle = (roll: number): number => {
  if (roll < 0.6) {
    return PROP.STONE;
  }
  return roll < 0.86 ? PROP.CRATE : PROP.BARREL;
};

/** Straight runs of stone, crates or barrels, some with an L-shaped bend. */
const placeWallRuns = (draft: Draft): void => {
  const { rng } = draft;
  const runs = randInt(rng, 13, 16);
  for (let run = 0; run < runs; run += 1) {
    const x = randInt(rng, 3, 21);
    const y = randInt(rng, 3, 21);
    const horizontal = rng() < 0.5;
    const length = randInt(rng, 2, 5);
    const style = pickWallStyle(rng());
    for (let i = 0; i < length; i += 1) {
      placeMirrored(draft, x + (horizontal ? i : 0), y + (horizontal ? 0 : i), TILE.WALL, style);
    }
    if (rng() < 0.42) {
      const endX = x + (horizontal ? length - 1 : 0);
      const endY = y + (horizontal ? 0 : length - 1);
      const dir = rng() < 0.5 ? -1 : 1;
      const bend = randInt(rng, 2, 3);
      for (let i = 1; i <= bend; i += 1) {
        placeMirrored(
          draft,
          endX + (horizontal ? 0 : i * dir),
          endY + (horizontal ? i * dir : 0),
          TILE.WALL,
          style,
        );
      }
    }
  }
};

/** Random-walk blob of `tile` starting at (x, y), up to `size` tiles. */
const growCluster = (draft: Draft, tile: number, size: number, x: number, y: number): void => {
  const { rng } = draft;
  const cells: TileCoord[] = [[x, y]];
  placeMirrored(draft, x, y, tile);
  for (let step = 0; step < size * 3 && cells.length < size; step += 1) {
    const from = cells[Math.floor(rng() * cells.length)] ?? [x, y];
    const dir = CARDINALS[Math.floor(rng() * 4)] ?? [0, 0];
    const nx = from[0] + dir[0];
    const ny = from[1] + dir[1];
    if (cells.some((c) => c[0] === nx && c[1] === ny)) {
      continue;
    }
    if (placeMirrored(draft, nx, ny, tile)) {
      cells.push([nx, ny]);
    }
  }
};

const placeClusters = (draft: Draft): void => {
  const { rng } = draft;
  const bushClusters = randInt(rng, 6, 7);
  for (let i = 0; i < bushClusters; i += 1) {
    const size = randInt(rng, 5, 12);
    const x = randInt(rng, 3, 21);
    const y = randInt(rng, 3, 21);
    growCluster(draft, TILE.BUSH, size, x, y);
  }
  growCluster(draft, TILE.BUSH, 7, 20, 20);
  const ponds = randInt(rng, 1, 2);
  for (let i = 0; i < ponds; i += 1) {
    const size = randInt(rng, 4, 8);
    const x = randInt(rng, 8, 18);
    const y = randInt(rng, 8, 18);
    growCluster(draft, TILE.WATER, size, x, y);
  }
  for (let i = 0; i < 4; i += 1) {
    const x = randInt(rng, 3, 21);
    const y = randInt(rng, 3, 21);
    placeMirrored(draft, x, y, TILE.WALL, PROP.CACTUS);
  }
};

/** Lamp posts overwrite whatever they land on, except reserved spawn ground. */
const placeLamps = (draft: Draft): TileCoord[] => {
  const { rng } = draft;
  const lampTiles: TileCoord[] = [];
  const stamp = (x: number, y: number): void => {
    for (const [mx, my] of mirrored(x, y)) {
      const i = gridIndex(mx, my);
      if (draft.reserved[i]) {
        continue;
      }
      draft.tiles[i] = TILE.WALL;
      draft.styles[i] = PROP.LAMP;
      lampTiles.push([mx, my]);
    }
  };
  stamp(17, 17);
  stamp(randInt(rng, 8, 10), randInt(rng, 14, 16));
  stamp(randInt(rng, 14, 16), randInt(rng, 7, 9));
  return lampTiles;
};

/** Four quadrant spots, spread apart and clear of the corner spawn, mirrored to sixteen. */
const pickBoxSpots = (draft: Draft): TileCoord[] => {
  const { rng } = draft;
  const picks: TileCoord[] = [];
  for (let attempt = 0; attempt < 300 && picks.length < 4; attempt += 1) {
    const x = randInt(rng, 3, 20);
    const y = randInt(rng, 3, 20);
    const i = gridIndex(x, y);
    if (draft.tiles[i] !== TILE.EMPTY || draft.reserved[i]) {
      continue;
    }
    if (Math.hypot(x - 6, y - 6) < 6) {
      continue;
    }
    if (picks.some((p) => Math.hypot(p[0] - x, p[1] - y) < 5)) {
      continue;
    }
    picks.push([x, y]);
  }
  const boxSpots: TileCoord[] = [];
  for (const [x, y] of picks) {
    for (const spot of mirrored(x, y)) {
      boxSpots.push(spot);
    }
  }
  return boxSpots;
};

interface Reach {
  /** 1 for every tile reachable on foot from the first spawn. */
  reached: Uint8Array;
  count: number;
}

const floodReachable = (tiles: Uint8Array, start: number): Reach => {
  const reached = new Uint8Array(TILE_COUNT);
  const stack = [start];
  reached[start] = 1;
  let count = 0;
  while (stack.length) {
    const i = stack.pop() ?? 0;
    count += 1;
    const x = i % GRID;
    const y = Math.trunc(i / GRID);
    for (const [dx, dy] of CARDINALS) {
      const nx = x + dx;
      const ny = y + dy;
      const n = gridIndex(nx, ny);
      if (!inGrid(nx, ny) || reached[n]) {
        continue;
      }
      if (tiles[n] === TILE.WALL || tiles[n] === TILE.WATER) {
        continue;
      }
      reached[n] = 1;
      stack.push(n);
    }
  }
  return { count, reached };
};

const countOpen = (tiles: Uint8Array): number => {
  let open = 0;
  for (const tile of tiles) {
    if (tile === TILE.EMPTY || tile === TILE.BUSH) {
      open += 1;
    }
  }
  return open;
};

/**
 * Fills `tiles`/`styles` with one candidate layout drawn from `rng`. The
 * returned layout carries the spawn, lamp and loot-box tiles it chose; when
 * `valid` is false the arrays still hold the rejected attempt.
 */
export const generateLayout = (rng: Rng, tiles: Uint8Array, styles: Uint8Array): Layout => {
  tiles.fill(TILE.EMPTY);
  styles.fill(0);
  const draft: Draft = { reserved: new Uint8Array(TILE_COUNT), rng, styles, tiles };
  const spawns: TileCoord[] = SPAWN_TILES.map(([x, y]) => [x, y]);
  carveBorder(draft);
  reserveSpawns(draft, spawns);
  placeWallRuns(draft);
  placeClusters(draft);
  const lampTiles = placeLamps(draft);
  const boxSpots = pickBoxSpots(draft);

  const [firstSpawn] = spawns;
  const reach = floodReachable(tiles, gridIndex(firstSpawn?.[0] ?? 0, firstSpawn?.[1] ?? 0));
  const connected =
    reach.count >= countOpen(tiles) * 0.93 &&
    spawns.every(([x, y]) => reach.reached[gridIndex(x, y)]) &&
    Boolean(reach.reached[gridIndex(GRID_HALF, GRID_HALF)]);
  if (!connected) {
    return { boxSpots, lampTiles, spawns, valid: false };
  }
  const reachableSpots = boxSpots.filter(([x, y]) => reach.reached[gridIndex(x, y)]);
  return { boxSpots: reachableSpots, lampTiles, spawns, valid: reachableSpots.length >= 10 };
};
