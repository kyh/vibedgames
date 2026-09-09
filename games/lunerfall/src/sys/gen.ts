import { TILE } from "../config";
import { RoomDef } from "../data/rooms";
import type { Grid } from "./grid";
import { mulberry32 } from "./rng";

// ── Constrained combat-room generator ───────────────────────────────────────
// Rooms are grown, not sprinkled: a platform is only placed if it is reachable
// (within a CONSERVATIVE jump envelope) from an already-reachable surface, so
// everything is reachable by construction. Doors and enemies then go only on
// reachable surfaces. `verifyRoom` re-derives reachability straight from the
// finished grid as an independent guard (also run in the sim harness).
//
// The envelope is tighter than the real movement (the player jumps ~4 tiles up /
// ~7 across; we generate against 3 / 5), so any hop the generator allows is
// comfortably doable in-game — the safety margin the constraints buy.

const RW = 52;
const RH = 21;
// 18 — ground stand row (feet marker), matches the hand templates
const S = RH - 3;

// a hop may rise at most this many tiles (real apex clears ~4)
const MAX_UP = 3;
// max horizontal tile gap between platform edges (real reach ~7)
const MAX_GAP = 5;
// min empty rows under a solid platform — no cramped pockets
const MIN_VGAP = 3;

// A standable surface: feet rest at row `r` (the marker row), body occupies rows
// r and r-1; the platform cell sits at r+1.
interface Surf {
  x0: number;
  x1: number;
  r: number;
}

// mulberry32 (sys/rng.ts) — rooms are reproducible from a seed: lets the sim
// harness sweep thousands and lets us log the seed of a bad room.

const hgap = (a: Surf, b: Surf): number => Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
// Can the player get from surface a to surface b in one hop? Up is capped at
// MAX_UP; dropping down is free; both need the horizontal gap within MAX_GAP.
const canHop = (a: Surf, b: Surf): boolean => b.r >= a.r - MAX_UP && hgap(a, b) <= MAX_GAP;

const rowClear = (g: Grid, x0: number, x1: number, r: number): boolean => {
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

// Empty rows below a solid block (down to the next solid / floor) must be >= need,
// so the player can always fit under a platform instead of hitting a pocket.
const gapBelowOk = (g: Grid, x0: number, x1: number, fromRow: number, need: number): boolean => {
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

// Path-map the room: BFS the reachable surfaces from the floor (roots = all floor
// spans; the player always starts on the floor), tagging each with its hop-
// distance so the generator can place objectives by how hard they are to reach.
// Shared by generation-time placement and verifyRoom — one source of truth.
const reachMap = (surfs: Surf[]): Map<Surf, number> => {
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

// Extract every standable surface straight from a grid (feet row r: cell r+1 is a
// floor/platform, cells r and r-1 are clear). Contiguous columns merge into spans.
export const surfacesFromGrid = (g: Grid): Surf[] => {
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

// Per-biome generation character: deeper biomes are taller, airier, denser, and
// hold more enemies — descending should feel more vertical and more hostile.
interface Knobs {
  platforms: number;
  ceil: number;
  oneWayPct: number;
  enemies: number;
}
const knobs = (biome: number, ri: (n: number) => number): Knobs => {
  const b = Math.max(1, biome);
  return {
    // highest platform row: low/gentle early, tall later
    ceil: Math.max(4, 13 - b * 2),
    // 3–4 early → up to 6 deep
    enemies: Math.min(6, 2 + b + ri(2)),
    // /10 chance a platform is a jump-through — airier deeper
    oneWayPct: Math.min(8, 5 + b),
    // 6–8 (biome 1) → up to 12 deep
    platforms: Math.min(12, 5 + b + ri(3)),
  };
};

// Horizontal centre column of a surface.
const mid = (s: Surf): number => Math.trunc((s.x0 + s.x1) / 2);

// Where a new platform starts: left of, right of, or roughly over its anchor.
const platformX0 = (anchor: Surf, w: number, ri: (n: number) => number): number => {
  // -1 left, 0 over, 1 right
  const side = ri(3) - 1;
  if (side < 0) {
    return anchor.x0 - w - ri(MAX_GAP + 1);
  }
  if (side > 0) {
    return anchor.x1 + 1 + ri(MAX_GAP + 1);
  }
  return mid(anchor) - Math.trunc(w / 2) + (ri(5) - 2);
};

// A candidate must be reachable from something already placed, must not crowd an
// x-overlapping surface vertically (that would destroy headroom / make a pocket),
// and must have headroom of its own.
const canPlace = (g: Grid, placed: Surf[], cand: Surf): boolean =>
  placed.some((s) => canHop(s, cand)) &&
  !placed.some((s) => s.x1 >= cand.x0 && s.x0 <= cand.x1 && Math.abs(s.r - cand.r) < MIN_VGAP) &&
  rowClear(g, cand.x0, cand.x1, cand.r) &&
  rowClear(g, cand.x0, cand.x1, cand.r - 1);

// Cut the candidate into the grid as a jump-through or a solid 2-thick platform.
// False when the cells below it aren't free enough to carve.
const carvePlatform = (def: RoomDef, cand: Surf, oneWay: boolean): boolean => {
  const g = def.grid;
  const { r } = cand;
  if (oneWay) {
    if (!rowClear(g, cand.x0, cand.x1, r + 1)) {
      return false;
    }
    def.oneway(cand.x0, r + 1, cand.x1);
    return true;
  }
  // solid 2-thick — keep clearance beneath it
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

// Grow platforms. Anchor each to an already-placed surface so the layout stays
// connected; keep a >= MIN_VGAP vertical gap between x-overlapping surfaces so a
// new platform never eats an old one's headroom.
const growPlatforms = (def: RoomDef, k: Knobs, ri: (n: number) => number): void => {
  const g = def.grid;
  // floor
  const placed: Surf[] = [{ r: S, x0: 1, x1: RW - 2 }];
  let tries = 0;
  while (placed.length < k.platforms + 1 && tries < 400) {
    tries += 1;
    const anchor = placed[ri(placed.length)];
    if (!anchor) {
      continue;
    }
    // 4–9 wide
    const w = 4 + ri(6);
    // -3..+1, biased upward
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
    // /10 chance of a jump-through, per the biome knob
    if (carvePlatform(def, cand, ri(10) < k.oneWayPct)) {
      placed.push(cand);
    }
  }
};

// Doors are the objective: put them on the hardest-to-reach ledges, spread far
// apart in x, so clearing the room means actually working across/up it. (Fall
// back to the floor's ends if the room grew too few ledges.)
const pickDoorSurfs = (ledges: Surf[], floorSpans: Surf[], d: (s: Surf) => number): Surf[] => {
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

// Enemies: distinct columns spread across the reachable path near→far, so some
// guard the deep exits while the approach isn't empty. Off the spawn + doors.
const placeEnemies = (
  def: RoomDef,
  reach: Surf[],
  doorSurfs: Surf[],
  d: (s: Surf) => number,
  spawnX: number,
  doorCols: Set<number>,
  max: number,
): void => {
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
    // never an empty fight
    def.enemy(Math.min(RW - 4, spawnX + 10), S);
  }
};

// One generation attempt (may fail verification; genCombatRoom retries + falls
// back). Exported so the sim harness can measure the first-try success rate.
export const genAttempt = (seed: number, biome = 1): RoomDef => {
  const rand = mulberry32(seed);
  const ri = (n: number): number => Math.floor(rand() * n);
  const k = knobs(biome, ri);
  const def = new RoomDef(RW, RH).arena();

  growPlatforms(def, k, ri);

  // Place spawns from the GRID's own path map (not the placement list): re-derive
  // every standable surface + its hop-distance, so verifyRoom (same method) always
  // agrees and objectives can be placed by how far they are to reach.
  const dist = reachMap(surfacesFromGrid(def.grid));
  const reach = [...dist.keys()];
  const d = (s: Surf): number => dist.get(s) ?? 0;
  const floorSpans = reach.filter((s) => s.r === S).toSorted((a, b) => a.x0 - b.x0);
  const ledges = reach.filter((s) => s.r < S);

  const doorSurfs = pickDoorSurfs(ledges, floorSpans, d);
  const doorCols = new Set<number>();
  for (const s of doorSurfs) {
    def.door(mid(s), s.r);
    doorCols.add(mid(s));
  }

  // Player: the floor span furthest in x from the doors — enter one side, exit
  // the other, fighting across the room.
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

// Independent guard: from the grid alone, is every enemy + door spawn on a
// surface reachable from the floor? Path-maps the room — extracts standable
// surfaces, BFSs the hop graph — the same map the generator placed against, so a
// pass here means the player can physically walk/jump to every spawn.
export const verifyRoom = (def: RoomDef): boolean => {
  const g = def.grid;
  const surfs = surfacesFromGrid(g);
  const reach = reachMap(surfs);
  const toSurf = (sx: number, sy: number): Surf | undefined => {
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

// Public entry: a verified generated combat room for the given biome. Retries on
// the rare failed verification, then falls back to a trivially-reachable room.
export const genCombatRoom = (seed: number, biome = 1): RoomDef => {
  for (let k = 0; k < 6; k += 1) {
    // oxlint-disable-next-line no-bitwise -- `>>> 0` wraps the stride to uint32, which is the seed space.
    const def = genAttempt((seed + k * 0x9e_37_79_b1) >>> 0, biome);
    if (verifyRoom(def)) {
      return def;
    }
  }
  // Fallback: floor-only fight — trivially reachable, never broken.
  const def = new RoomDef(RW, RH).arena();
  def
    .player(5, S)
    .enemy(20, S)
    .enemy(34, S)
    .door(RW - 6, S);
  return def;
};
