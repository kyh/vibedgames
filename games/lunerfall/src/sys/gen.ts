import { TILE } from "../config";
import { RoomDef } from "../data/rooms";
import type { Grid } from "./grid";
import { mulberry32 } from "./rng";

const RW = 52;
const RH = 21;
const S = RH - 3;

const MAX_UP = 3;
const MAX_GAP = 5;
const MIN_VGAP = 3;

export interface Surf {
  x0: number;
  x1: number;
  r: number;
}

const hgap = (a: Surf, b: Surf) => Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
const canHop = (a: Surf, b: Surf) => b.r >= a.r - MAX_UP && hgap(a, b) <= MAX_GAP;

const rowClear = (g: Grid, x0: number, x1: number, r: number) => {
  if (r < 1) {
    return true;
  }

  for (let x = x0; x <= x1; x += 1) {
    if (g.isSolidCell(x, r) || g.isOneWayCell(x, r)) {
      return false;
    }
  }

  return true;
};

const gapBelowOk = (g: Grid, x0: number, x1: number, fromRow: number, need: number) => {
  for (let dy = 0; dy < need; dy += 1) {
    const r = fromRow + dy;

    for (let x = x0; x <= x1; x += 1) {
      if (g.isSolidCell(x, r)) {
        return false;
      }
    }
  }

  return true;
};

const reachMap = (surfs: Surf[]) => {
  const dist = new Map<Surf, number>();
  const q: Surf[] = [];

  for (const s of surfs) {
    if (s.r === S) {
      dist.set(s, 0);
      q.push(s);
    }
  }

  let head = 0;

  while (head < q.length) {
    const a = q[head];
    head += 1;

    if (!a) {
      break;
    }

    const d = (dist.get(a) ?? 0) + 1;

    for (const b of surfs) {
      if (!dist.has(b) && canHop(a, b)) {
        dist.set(b, d);
        q.push(b);
      }
    }
  }

  return dist;
};

export const surfacesFromGrid = (g: Grid) => {
  const out: Surf[] = [];

  for (let r = 1; r < g.rows - 1; r += 1) {
    let x0 = -1;

    for (let x = 0; x <= g.cols; x += 1) {
      const stand =
        x < g.cols &&
        (g.isSolidCell(x, r + 1) || g.isOneWayCell(x, r + 1)) &&
        !g.isSolidCell(x, r) &&
        !g.isOneWayCell(x, r) &&
        !g.isSolidCell(x, r - 1) &&
        !g.isOneWayCell(x, r - 1);

      if (stand && x0 < 0) {
        x0 = x;
      } else if (!stand && x0 >= 0) {
        out.push({ r, x0, x1: x - 1 });
        x0 = -1;
      }
    }
  }

  return out;
};

interface Knobs {
  platforms: number;
  ceil: number;
  oneWayPct: number;
  enemies: number;
}

const knobs = (biome: number, ri: (n: number) => number) => {
  const b = Math.max(1, biome);

  return {
    ceil: Math.max(4, 13 - b * 2),
    enemies: Math.min(6, 2 + b + ri(2)),
    oneWayPct: Math.min(8, 5 + b),
    platforms: Math.min(12, 5 + b + ri(3)),
  };
};

const mid = (s: Surf) => Math.trunc((s.x0 + s.x1) / 2);

const platformX0 = (anchor: Surf, w: number, ri: (n: number) => number) => {
  const side = ri(3) - 1;

  if (side < 0) {
    return anchor.x0 - w - ri(MAX_GAP + 1);
  }

  if (side > 0) {
    return anchor.x1 + 1 + ri(MAX_GAP + 1);
  }

  return mid(anchor) - Math.trunc(w / 2) + (ri(5) - 2);
};

const canPlace = (g: Grid, placed: Surf[], cand: Surf) =>
  placed.some((s) => canHop(s, cand)) &&
  !placed.some((s) => s.x1 >= cand.x0 && s.x0 <= cand.x1 && Math.abs(s.r - cand.r) < MIN_VGAP) &&
  rowClear(g, cand.x0, cand.x1, cand.r) &&
  rowClear(g, cand.x0, cand.x1, cand.r - 1);

const carvePlatform = (def: RoomDef, cand: Surf, oneWay: boolean) => {
  const g = def.grid;
  const { r } = cand;

  if (oneWay) {
    if (!rowClear(g, cand.x0, cand.x1, r + 1)) {
      return false;
    }

    def.oneway(cand.x0, r + 1, cand.x1);

    return true;
  }

  if (r + 2 >= S) {
    return false;
  }

  if (!rowClear(g, cand.x0, cand.x1, r + 1) || !rowClear(g, cand.x0, cand.x1, r + 2)) {
    return false;
  }

  if (!gapBelowOk(g, cand.x0, cand.x1, r + 3, MIN_VGAP)) {
    return false;
  }

  def.block(cand.x0, r + 1, cand.x1);

  return true;
};

const growPlatforms = (def: RoomDef, k: Knobs, ri: (n: number) => number) => {
  const g = def.grid;
  const placed: Surf[] = [{ r: S, x0: 1, x1: RW - 2 }];
  let tries = 0;

  while (placed.length < k.platforms + 1 && tries < 400) {
    tries += 1;
    const anchor = placed[ri(placed.length)];

    if (!anchor) {
      continue;
    }

    const w = 4 + ri(6);
    const dr = ri(MAX_UP + 2) - MAX_UP;
    const r = Math.max(k.ceil, Math.min(S - 2, anchor.r + dr));

    if (r >= S) {
      continue;
    }

    const x0 = Math.max(1, Math.min(RW - 1 - w, platformX0(anchor, w, ri)));
    const cand: Surf = { r, x0, x1: x0 + w - 1 };

    if (!canPlace(g, placed, cand)) {
      continue;
    }

    if (carvePlatform(def, cand, ri(10) < k.oneWayPct)) {
      placed.push(cand);
    }
  }
};

const pickDoorSurfs = (ledges: Surf[], floorSpans: Surf[], d: (s: Surf) => number) => {
  if (ledges.length >= 2) {
    const [hardest] = [...ledges].toSorted((a, b) => d(b) - d(a));

    if (hardest) {
      const [far] = [...ledges]
        .filter((s) => s !== hardest)
        .toSorted((p, q) => Math.abs(mid(q) - mid(hardest)) - Math.abs(mid(p) - mid(hardest)));

      if (far) {
        return [hardest, far];
      }
    }
  }

  const [a] = floorSpans;
  const b = floorSpans.at(-1);
  const ends: Surf[] = [];

  if (a) {
    ends.push(a);
  }

  if (b && b !== a) {
    ends.push(b);
  }

  return ends;
};

const placeEnemies = (
  def: RoomDef,
  reach: Surf[],
  doorSurfs: Surf[],
  d: (s: Surf) => number,
  spawnX: number,
  doorCols: Set<number>,
  max: number,
) => {
  const used = new Set<number>([spawnX, ...doorCols]);
  const cands: { r: number; cx: number }[] = [];

  for (const s of reach.filter((x) => !doorSurfs.includes(x)).toSorted((a, b) => d(a) - d(b))) {
    const cx = s.r === S ? Math.max(s.x0 + 1, Math.min(s.x1 - 1, mid(s))) : mid(s);

    if (used.has(cx) || Math.abs(cx - spawnX) < 3) {
      continue;
    }

    used.add(cx);
    cands.push({ cx, r: s.r });
  }

  const n = Math.min(max, cands.length);

  for (let i = 0; i < n; i += 1) {
    const c = cands[Math.floor(((i + 0.5) / n) * cands.length)];

    if (c) {
      def.enemy(c.cx, c.r);
    }
  }

  if (n === 0) {
    def.enemy(Math.min(RW - 4, spawnX + 10), S);
  }
};

export const genAttempt = (seed: number, biome = 1) => {
  const rand = mulberry32(seed);
  const ri = (n: number) => Math.floor(rand() * n);
  const k = knobs(biome, ri);
  const def = new RoomDef(RW, RH).arena();

  growPlatforms(def, k, ri);

  const dist = reachMap(surfacesFromGrid(def.grid));
  const reach = [...dist.keys()];
  const d = (s: Surf) => dist.get(s) ?? 0;
  const floorSpans = reach.filter((s) => s.r === S).toSorted((a, b) => a.x0 - b.x0);
  const ledges = reach.filter((s) => s.r < S);

  const doorSurfs = pickDoorSurfs(ledges, floorSpans, d);
  const doorCols = new Set<number>();

  for (const s of doorSurfs) {
    def.door(mid(s), s.r);
    doorCols.add(mid(s));
  }

  const doorMidX = doorSurfs.reduce((sum, s) => sum + mid(s), 0) / Math.max(1, doorSurfs.length);

  const [spawnSpan] = [...floorSpans].toSorted(
    (a, b) => Math.abs(mid(b) - doorMidX) - Math.abs(mid(a) - doorMidX),
  );

  const spawnX = spawnSpan
    ? Math.max(spawnSpan.x0 + 1, Math.min(spawnSpan.x1 - 1, mid(spawnSpan)))
    : 4;

  def.player(spawnX, S);

  placeEnemies(def, reach, doorSurfs, d, spawnX, doorCols, k.enemies);

  return def;
};

export const verifyRoom = (def: RoomDef) => {
  const g = def.grid;
  const surfs = surfacesFromGrid(g);
  const reach = reachMap(surfs);

  const toSurf = (sx: number, sy: number) => {
    const cx = Math.floor(sx / TILE);
    const fr = Math.round(sy / TILE) - 1;

    return surfs.find((s) => s.r === fr && cx >= s.x0 && cx <= s.x1);
  };

  const start = toSurf(def.playerSpawn.x, def.playerSpawn.y);

  if (!start || !reach.has(start)) {
    return false;
  }

  const spots = [...def.enemySpawns, ...def.doorSlots];

  return spots.every((s) => {
    const surf = toSurf(s.x, s.y);

    return surf !== undefined && reach.has(surf);
  });
};

export const genCombatRoom = (seed: number, biome = 1) => {
  for (let k = 0; k < 6; k += 1) {
    // oxlint-disable-next-line no-bitwise -- `>>> 0` wraps the stride to uint32, which is the seed space.
    const def = genAttempt((seed + k * 0x9e_37_79_b1) >>> 0, biome);

    if (verifyRoom(def)) {
      return def;
    }
  }

  const def = new RoomDef(RW, RH).arena();
  def
    .player(5, S)
    .enemy(20, S)
    .enemy(34, S)
    .door(RW - 6, S);

  return def;
};
