import { TILE } from "../config";
import { RoomDef } from "../data/rooms";
import type { Grid } from "./grid";

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
const S = RH - 3; // 18 — ground stand row (feet marker), matches the hand templates

const MAX_UP = 3; // a hop may rise at most this many tiles (real apex clears ~4)
const MAX_GAP = 5; // max horizontal tile gap between platform edges (real reach ~7)
const MIN_VGAP = 3; // min empty rows under a solid platform — no cramped pockets

// A standable surface: feet rest at row `r` (the marker row), body occupies rows
// r and r-1; the platform cell sits at r+1.
type Surf = { x0: number; x1: number; r: number };

// mulberry32 — small deterministic PRNG so rooms are reproducible from a seed
// (lets the sim harness sweep thousands and lets us log the seed of a bad room).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hgap = (a: Surf, b: Surf): number => Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
// Can the player get from surface a to surface b in one hop? Up is capped at
// MAX_UP; dropping down is free; both need the horizontal gap within MAX_GAP.
const canHop = (a: Surf, b: Surf): boolean => b.r >= a.r - MAX_UP && hgap(a, b) <= MAX_GAP;

const rowClear = (g: Grid, x0: number, x1: number, r: number): boolean => {
  if (r < 1) return true;
  for (let x = x0; x <= x1; x++) if (g.isSolidCell(x, r) || g.isOneWayCell(x, r)) return false;
  return true;
};

// Empty rows below a solid block (down to the next solid / floor) must be >= need,
// so the player can always fit under a platform instead of hitting a pocket.
const gapBelowOk = (g: Grid, x0: number, x1: number, fromRow: number, need: number): boolean => {
  for (let dy = 0; dy < need; dy++) {
    const r = fromRow + dy;
    for (let x = x0; x <= x1; x++) if (g.isSolidCell(x, r)) return false;
  }
  return true;
};

// BFS the reachable surface set from any floor span (the player always starts on
// the floor). Shared by generation-time placement and verifyRoom.
function reachableFrom(surfs: Surf[]): Set<Surf> {
  const seen = new Set<Surf>();
  const q: Surf[] = [];
  for (const s of surfs) if (s.r === S) (seen.add(s), q.push(s)); // floor spans are the roots
  while (q.length > 0) {
    const a = q.shift();
    if (!a) break;
    for (const b of surfs) if (!seen.has(b) && canHop(a, b)) (seen.add(b), q.push(b));
  }
  return seen;
}

// One generation attempt (may fail verification; genCombatRoom retries + falls
// back). Exported so the sim harness can measure the first-try success rate.
export function genAttempt(seed: number): RoomDef {
  const rand = mulberry32(seed);
  const ri = (n: number): number => Math.floor(rand() * n);
  const def = new RoomDef(RW, RH).arena();
  const g = def.grid;

  // ── 1. Grow platforms. Anchor each to an already-placed surface so the layout
  // stays connected; keep a ≥MIN_VGAP vertical gap between x-overlapping surfaces
  // so a new platform never eats an old one's headroom.
  const placed: Surf[] = [{ x0: 1, x1: RW - 2, r: S }]; // floor
  const target = 6 + ri(4); // 6–9 platforms
  let tries = 0;
  while (placed.length < target + 1 && tries < 400) {
    tries++;
    const anchor = placed[ri(placed.length)];
    if (!anchor) continue;
    const w = 4 + ri(6); // 4–9 wide
    const dr = ri(MAX_UP + 2) - MAX_UP; // -3..+1, biased upward
    const r = Math.max(5, Math.min(S - 2, anchor.r + dr));
    if (r >= S) continue;

    const side = ri(3) - 1; // -1 left, 0 over, 1 right
    let x0: number;
    if (side < 0) x0 = anchor.x0 - w - ri(MAX_GAP + 1);
    else if (side > 0) x0 = anchor.x1 + 1 + ri(MAX_GAP + 1);
    else x0 = ((anchor.x0 + anchor.x1) >> 1) - (w >> 1) + (ri(5) - 2);
    x0 = Math.max(1, Math.min(RW - 1 - w, x0));
    const cand: Surf = { x0, x1: x0 + w - 1, r };

    if (!placed.some((s) => canHop(s, cand))) continue; // reachable from something
    // Don't crowd another surface vertically (would destroy headroom / make a pocket).
    if (placed.some((s) => s.x1 >= cand.x0 && s.x0 <= cand.x1 && Math.abs(s.r - r) < MIN_VGAP)) continue;
    if (!rowClear(g, cand.x0, cand.x1, r) || !rowClear(g, cand.x0, cand.x1, r - 1)) continue; // headroom

    if (ri(10) < 6) {
      if (!rowClear(g, cand.x0, cand.x1, r + 1)) continue; // one-way (jump-through)
      def.oneway(cand.x0, r + 1, cand.x1);
    } else {
      if (r + 2 >= S) continue; // solid 2-thick — keep clearance beneath it
      if (!rowClear(g, cand.x0, cand.x1, r + 1) || !rowClear(g, cand.x0, cand.x1, r + 2)) continue;
      if (!gapBelowOk(g, cand.x0, cand.x1, r + 3, MIN_VGAP)) continue;
      def.block(cand.x0, r + 1, cand.x1);
    }
    placed.push(cand);
  }

  // ── 2. Place spawns from the GRID's own truth (not `placed`): re-derive every
  // standable surface and its reachability, so verifyRoom (same method) always
  // agrees and nothing is stranded.
  const surfs = surfacesFromGrid(g);
  const reach = reachableFrom(surfs);
  const floorSpans = [...reach].filter((s) => s.r === S).sort((a, b) => a.x0 - b.x0);
  const ledges = [...reach].filter((s) => s.r < S).sort((a, b) => (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
  const mid = (s: Surf): number => (s.x0 + s.x1) >> 1;

  // Player: a floor span, on the side away from the bulk of the ledges.
  const midLedge = ledges[Math.floor(ledges.length / 2)];
  const leftHeavy = midLedge !== undefined && mid(midLedge) < RW / 2;
  const spawnSpan = leftHeavy ? floorSpans[floorSpans.length - 1] : floorSpans[0];
  const spawnX = spawnSpan ? Math.min(spawnSpan.x1 - 1, Math.max(spawnSpan.x0 + 1, leftHeavy ? spawnSpan.x1 - 2 : spawnSpan.x0 + 2)) : 4;
  def.player(spawnX, S);

  // Doors: two reachable surfaces spread across the room (prefer ledges).
  const doorSurfs =
    ledges.length >= 2
      ? [ledges[0], ledges[ledges.length - 1]]
      : [floorSpans[0], floorSpans[floorSpans.length - 1]];
  const doorCols = new Set<number>();
  for (const s of doorSurfs) if (s) (def.door(mid(s), s.r), doorCols.add(mid(s)));

  // Enemies: 3–4 reachable surfaces, off the spawn + door tiles.
  const spots = [...reach];
  const wanted = 3 + ri(2);
  let count = 0;
  let guard = 0;
  while (count < wanted && guard++ < 60 && spots.length > 0) {
    const s = spots[ri(spots.length)];
    if (!s) continue;
    const cx = s.r === S ? Math.max(s.x0 + 1, Math.min(s.x1 - 1, s.x0 + 1 + ri(Math.max(1, s.x1 - s.x0 - 1)))) : mid(s);
    if (doorCols.has(cx) || Math.abs(cx - spawnX) < 4) continue;
    def.enemy(cx, s.r);
    count++;
  }
  if (count === 0) def.enemy(Math.min(RW - 4, spawnX + 10), S); // never an empty fight

  return def;
}

// Extract every standable surface straight from a grid (feet row r: cell r+1 is a
// floor/platform, cells r and r-1 are clear). Contiguous columns merge into spans.
export function surfacesFromGrid(g: Grid): Surf[] {
  const out: Surf[] = [];
  for (let r = 1; r < g.rows - 1; r++) {
    let x0 = -1;
    for (let x = 0; x <= g.cols; x++) {
      const stand =
        x < g.cols &&
        (g.isSolidCell(x, r + 1) || g.isOneWayCell(x, r + 1)) &&
        !g.isSolidCell(x, r) &&
        !g.isOneWayCell(x, r) &&
        !g.isSolidCell(x, r - 1) &&
        !g.isOneWayCell(x, r - 1);
      if (stand && x0 < 0) x0 = x;
      else if (!stand && x0 >= 0) {
        out.push({ x0, x1: x - 1, r });
        x0 = -1;
      }
    }
  }
  return out;
}

// Independent guard: from the grid alone, is every enemy + door spawn on a
// surface reachable from the floor? Path-maps the room — extracts standable
// surfaces, BFSs the hop graph — the same map the generator placed against, so a
// pass here means the player can physically walk/jump to every spawn.
export function verifyRoom(def: RoomDef): boolean {
  const g = def.grid;
  const surfs = surfacesFromGrid(g);
  const reach = reachableFrom(surfs);
  const toSurf = (sx: number, sy: number): Surf | undefined => {
    const cx = Math.floor(sx / TILE);
    const fr = Math.round(sy / TILE) - 1;
    return surfs.find((s) => s.r === fr && cx >= s.x0 && cx <= s.x1);
  };

  const start = toSurf(def.playerSpawn.x, def.playerSpawn.y);
  if (!start || !reach.has(start)) return false;

  const spots = [...def.enemySpawns, ...def.doorSlots];
  return spots.every((s) => {
    const surf = toSurf(s.x, s.y);
    return surf !== undefined && reach.has(surf);
  });
}

// Public entry: a verified generated combat room. Retries on the rare failed
// verification, then falls back to a known-good grown room (target on floor).
export function genCombatRoom(seed: number): RoomDef {
  for (let k = 0; k < 6; k++) {
    const def = genAttempt((seed + k * 0x9e3779b1) >>> 0);
    if (verifyRoom(def)) return def;
  }
  // Fallback: floor-only fight — trivially reachable, never broken.
  const def = new RoomDef(RW, RH).arena();
  def.player(5, S).enemy(20, S).enemy(34, S).door(RW - 6, S);
  return def;
}
