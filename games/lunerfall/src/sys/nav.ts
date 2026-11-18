import { TILE } from "../config";
import { surfacesFromGrid } from "./gen";
import type { Surf } from "./gen";
import type { Grid } from "./grid";

const PLAIN_RISE = 3;
const DASH_RISE = 5;
const UP_GAP = 5;
const DASH_GAP = 2;
const DOWN_GAP = 6;
const SIDE = 8;
const EDGE = 4;
const INSET = 10;
const AT_TAKEOFF = 6;
const BODY_HALF = 6;

export interface NavPoint {
  x: number;
  y: number;
}

export interface NavBody extends NavPoint {
  grounded: boolean;
}

export interface NavStep {
  /** Where to steer, in px from the player. */
  dx: number;
  /** The surface being climbed to, in px from the feet (negative = above); 0 when already level. */
  dy: number;
  /** The run-up is done: take off now. */
  jump: boolean;
  /** Hold down to fall through the jump-through platform underfoot. */
  drop: boolean;
}

const left = (s: Surf) => s.x0 * TILE;
const right = (s: Surf) => (s.x1 + 1) * TILE;
const top = (s: Surf) => (s.r + 1) * TILE;
const hgap = (a: Surf, b: Surf) => Math.max(0, b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

const into = (s: Surf, x: number) => clamp(x, left(s) + INSET, right(s) - INSET);

const surfaces = new WeakMap<Grid, Surf[]>();

const surfacesOf = (grid: Grid) => {
  let found = surfaces.get(grid);

  if (!found) {
    found = surfacesFromGrid(grid);
    surfaces.set(grid, found);
  }

  return found;
};

const headroom = (grid: Grid, x: number, a: Surf, b: Surf, straightUp: boolean) => {
  const c0 = Math.floor((x - BODY_HALF) / TILE);
  const c1 = Math.floor((x + BODY_HALF - 0.01) / TILE);

  for (let r = straightUp ? b.r - 1 : b.r; r <= a.r; r += 1) {
    if (grid.isSolidCell(c0, r) || grid.isSolidCell(c1, r)) {
      return false;
    }
  }

  return true;
};

const takeoff = (grid: Grid, a: Surf, b: Surf, x: number) => {
  const lo = Math.max(left(a), left(b));
  const hi = Math.min(right(a), right(b));

  if (lo >= hi) {
    const edge =
      right(b) <= left(a)
        ? Math.max(left(a) + EDGE, right(b) + SIDE)
        : Math.min(right(a) - EDGE, left(b) - SIDE);

    return headroom(grid, edge, a, b, false) ? edge : null;
  }

  const under = into(b, clamp(x, lo, hi));

  if (grid.isOneWayCell(Math.floor(under / TILE), b.r + 1)) {
    return headroom(grid, under, a, b, true) ? under : null;
  }

  const sides = [left(b) - SIDE, right(b) + SIDE].filter(
    (sx) => sx >= left(a) + EDGE && sx <= right(a) - EDGE && headroom(grid, sx, a, b, true),
  );

  const [nearest] = sides.toSorted((p, q) => Math.abs(p - x) - Math.abs(q - x));

  return nearest ?? null;
};

const hopCost = (grid: Grid, a: Surf, b: Surf) => {
  const rise = a.r - b.r;
  const gap = hgap(a, b);

  if (rise > DASH_RISE) {
    return null;
  }

  let reach = DOWN_GAP;

  if (rise > PLAIN_RISE) {
    reach = DASH_GAP;
  } else if (rise >= 0) {
    reach = UP_GAP;
  }

  if (gap > reach || (rise >= 0 && takeoff(grid, a, b, left(a)) === null)) {
    return null;
  }

  return 1 + (rise > PLAIN_RISE ? 1.5 : 0) + gap * 0.2;
};

const nextHop = (grid: Grid, surfs: Surf[], from: Surf, to: Surf) => {
  const cost = new Map<Surf, number>([[from, 0]]);
  const first = new Map<Surf, Surf>();
  const open = new Set<Surf>([from]);

  while (open.size > 0) {
    let a: Surf | null = null;

    for (const s of open) {
      if (a === null || (cost.get(s) ?? 0) < (cost.get(a) ?? 0)) {
        a = s;
      }
    }

    if (a === null || a === to) {
      break;
    }

    open.delete(a);

    for (const b of surfs) {
      const hop = b === a ? null : hopCost(grid, a, b);
      const total = (cost.get(a) ?? 0) + (hop ?? 0);

      if (hop !== null && total < (cost.get(b) ?? Number.POSITIVE_INFINITY)) {
        cost.set(b, total);
        first.set(b, a === from ? b : (first.get(a) ?? b));
        open.add(b);
      }
    }
  }

  return first.get(to) ?? null;
};

const surfaceAt = (surfs: Surf[], p: NavPoint) => {
  const r = Math.round(p.y / TILE) - 1;
  const cx = Math.floor(p.x / TILE);

  return (
    surfs.find((s) => s.r === r && cx >= s.x0 && cx <= s.x1) ??
    surfs.find((s) => s.r === r && cx >= s.x0 - 1 && cx <= s.x1 + 1) ??
    null
  );
};

const surfaceUnder = (surfs: Surf[], p: NavPoint) => {
  const r = Math.ceil(p.y / TILE - 0.5) - 1;
  const cx = Math.floor(p.x / TILE);
  let best: Surf | null = null;

  for (const s of surfs) {
    if (s.r >= r && cx >= s.x0 && cx <= s.x1 && (best === null || s.r < best.r)) {
      best = s;
    }
  }

  return best;
};

const direct = (body: NavBody, target: NavPoint) => {
  const dx = target.x - body.x;
  const dy = target.y - body.y;

  return { drop: dy > TILE, dx, dy, jump: dy < -TILE && Math.abs(dx) < 4 * TILE };
};

/**
 * One target's route, replanned every frame the player stands somewhere. A hop
 * in flight keeps its landing surface — the standing surface is gone then, and
 * replanning from thin air would steer the player back under the ledge.
 */
export class Navigator {
  private grid: Grid | null = null;
  private standing: Surf | null = null;
  private heading: Surf | null = null;
  private launch: number | null = null;

  step(grid: Grid, body: NavBody, target: NavPoint) {
    if (grid !== this.grid) {
      this.grid = grid;
      this.standing = null;
      this.heading = null;
      this.launch = null;
    }

    const surfs = surfacesOf(grid);

    if (body.grounded) {
      this.standing = surfaceAt(surfs, body) ?? this.standing;
      this.heading = null;
    }

    const goal = surfaceUnder(surfs, target);
    const cur = this.standing;

    if (!cur || !goal) {
      return direct(body, target);
    }

    if (!body.grounded && this.heading) {
      return this.airborne(body, this.heading, target, goal);
    }

    if (cur === goal) {
      return { drop: false, dx: target.x - body.x, dy: 0, jump: false };
    }

    const next = nextHop(grid, surfs, cur, goal);

    if (!next) {
      return direct(body, target);
    }

    this.heading = next;

    return body.grounded
      ? this.grounded(grid, body, cur, next, target.x)
      : this.airborne(body, next, target, goal);
  }

  private airborne(body: NavBody, next: Surf, target: NavPoint, goal: Surf) {
    const dy = top(next) - body.y;
    const over = next === goal ? into(next, target.x) : into(next, body.x);
    const aim = dy < 0 && this.launch !== null ? this.launch : over;

    return { drop: dy > TILE, dx: aim - body.x, dy, jump: false };
  }

  private grounded(grid: Grid, body: NavBody, cur: Surf, next: Surf, targetX: number) {
    const dy = top(next) - body.y;

    if (next.r <= cur.r) {
      const from = takeoff(grid, cur, next, body.x) ?? into(next, body.x);
      const ready = Math.abs(from - body.x) <= AT_TAKEOFF;
      const straightUp = Math.max(left(cur), left(next)) < Math.min(right(cur), right(next));
      this.launch = straightUp ? from : null;
      const aim = ready && !straightUp ? into(next, body.x) : from;

      return { drop: false, dx: aim - body.x, dy, jump: ready };
    }

    this.launch = null;
    const lo = Math.max(left(cur), left(next));
    const hi = Math.min(right(cur), right(next));

    if (lo < hi) {
      const over = clamp(body.x, lo + SIDE, hi - SIDE);

      if (grid.isOneWayCell(Math.floor(over / TILE), cur.r + 1)) {
        const ready = Math.abs(over - body.x) <= AT_TAKEOFF;

        return { drop: ready, dx: over - body.x, dy, jump: false };
      }
    }

    const mid = (left(cur) + right(cur)) / 2;
    const wantLeft = lo < hi ? targetX < mid : (left(next) + right(next)) / 2 < mid;
    const openLeft = !grid.isSolidCell(cur.x0 - 1, cur.r);
    const openRight = !grid.isSolidCell(cur.x1 + 1, cur.r);
    const goLeft = wantLeft ? openLeft || !openRight : !openRight;
    const pastLip = goLeft ? left(cur) - TILE : right(cur) + TILE;
    const aim = lo < hi ? pastLip : into(next, body.x);
    const wide = hgap(cur, next) > 1;
    const atEdge = aim < body.x ? body.x - left(cur) < SIDE : right(cur) - body.x < SIDE;

    return { drop: false, dx: aim - body.x, dy, jump: wide && atEdge };
  }
}
