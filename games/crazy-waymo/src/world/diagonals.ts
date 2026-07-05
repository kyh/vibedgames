// Diagonal street detection. Real SF has famous diagonal corridors (Market,
// Columbus, Portola/Sloat) that rasterize onto the 4-connected grid as
// one-block staircases — E,N,E,N chains of bend tiles that render as an ugly
// sawtooth of curbs and corners. This pass finds those runs in the road graph
// so the renderer can draw them as proper diagonal avenues (full-tile asphalt
// with lane markings along the true chord) while the LOGICAL network — traffic
// routes, fares, collision, minimap — stays 4-connected and untouched.
//
// A run is a chain of degree-2 road cells whose steps (a) alternate axis at
// least every MAX_AXIS_RUN cells and (b) never reverse sign on either axis —
// i.e. a monotonic staircase. Shallow diagonals (Market ≈ 30°) rasterize as
// "two east, one north" patterns, hence the axis-run allowance above 1.

export type GridCell = { readonly gx: number; readonly gz: number };

// Fractional grid coordinates (cell-centre units) — the straightened path of
// a run. Both the road markings AND traffic drive along this, so what you see
// painted is exactly what the cars do.
export type SpinePoint = { readonly gx: number; readonly gz: number };

export type DiagonalRun = {
  readonly cells: readonly GridCell[]; // ordered along the run
  readonly spine: readonly SpinePoint[]; // RDP-simplified centreline
};

export type Diagonals = {
  readonly cells: ReadonlySet<string>; // "gx,gz" of every cell inside a run
  readonly runs: readonly DiagonalRun[];
};

const MAX_AXIS_RUN = 3; // longest same-axis stretch that still reads diagonal
const MIN_RUN_CELLS = 4; // shorter chains are just corners/jogs
// Ramer-Douglas-Peucker tolerance (grid units): staircase jitter within this
// of the chord straightens to one line; genuine bends (switchbacks) survive
// as polyline joints.
const RDP_EPS = 0.72;

const key = (gx: number, gz: number): string => `${gx},${gz}`;

// Standard RDP over the run's cell centres.
function rdp(points: readonly GridCell[]): SpinePoint[] {
  if (points.length <= 2) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [...points];
  const dx = last.gx - first.gx;
  const dz = last.gz - first.gz;
  const len = Math.hypot(dx, dz) || 1;
  let maxD = -1;
  let maxI = 0;
  for (let i = 1; i + 1 < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const d = Math.abs((p.gx - first.gx) * dz - (p.gz - first.gz) * dx) / len;
    if (d > maxD) {
      maxD = d;
      maxI = i;
    }
  }
  if (maxD <= RDP_EPS) return [first, last];
  const left = rdp(points.slice(0, maxI + 1));
  const right = rdp(points.slice(maxI));
  return [...left.slice(0, -1), ...right];
}

const STEPS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function findDiagonals(
  isRoad: (gx: number, gz: number) => boolean,
  sizeX: number,
  sizeZ: number,
): Diagonals {
  const neighbors = (gx: number, gz: number): GridCell[] => {
    const out: GridCell[] = [];
    for (const [dx, dz] of STEPS) {
      if (isRoad(gx + dx, gz + dz)) out.push({ gx: gx + dx, gz: gz + dz });
    }
    return out;
  };
  const degree2 = (gx: number, gz: number): boolean =>
    isRoad(gx, gz) && neighbors(gx, gz).length === 2;

  // --- Collect maximal staircase chains. Degree-2 cells walk as plain path
  // cells; JUNCTIONS don't stop the walk — a diagonal corridor crossed by
  // side streets every few cells (Market!) continues through a junction when
  // exactly the staircase-consistent continuation exists (alternate axis
  // first, same-axis within the run cap second, sign-monotonic always). ---
  const visited = new Set<string>();
  const chains: GridCell[][] = [];
  for (let gx = 0; gx < sizeX; gx++) {
    for (let gz = 0; gz < sizeZ; gz++) {
      if (!degree2(gx, gz) || visited.has(key(gx, gz))) continue;
      const chain: GridCell[] = [{ gx, gz }];
      visited.add(key(gx, gz));
      // Extend from both of the seed's connections.
      for (const dirIdx of [0, 1] as const) {
        let prev: GridCell = { gx, gz };
        let cur = neighbors(gx, gz)[dirIdx];
        // Monotonic-walk state for THIS direction (splitter re-validates).
        let sx = 0;
        let sz = 0;
        let lastAxisX = false;
        let axisRun = 0;
        let started = false;
        while (cur && !visited.has(key(cur.gx, cur.gz))) {
          const stepX = cur.gx - prev.gx;
          const axisX = stepX !== 0;
          const sign = axisX ? Math.sign(stepX) : Math.sign(cur.gz - prev.gz);
          if (axisX) sx = sx === 0 ? sign : sx;
          else sz = sz === 0 ? sign : sz;
          axisRun = started && axisX === lastAxisX ? axisRun + 1 : 1;
          lastAxisX = axisX;
          started = true;
          visited.add(key(cur.gx, cur.gz));
          if (dirIdx === 0) chain.push(cur);
          else chain.unshift(cur);
          const nbs = neighbors(cur.gx, cur.gz);
          let next: GridCell | undefined;
          if (nbs.length === 2) {
            next = nbs.find((n) => n.gx !== prev.gx || n.gz !== prev.gz);
          } else {
            // Junction: continue only along a staircase-consistent arm.
            const here = cur;
            const fits = (n: GridCell, wantAlternate: boolean): boolean => {
              if (n.gx === prev.gx && n.gz === prev.gz) return false;
              const dx = n.gx - here.gx;
              const dz = n.gz - here.gz;
              const ax = dx !== 0;
              if (ax === lastAxisX) {
                if (wantAlternate) return false;
                if (axisRun >= MAX_AXIS_RUN) return false;
              } else if (!wantAlternate) return false;
              const sg = ax ? Math.sign(dx) : Math.sign(dz);
              return ax ? sx === 0 || sg === sx : sz === 0 || sg === sz;
            };
            next = nbs.find((n) => fits(n, true)) ?? nbs.find((n) => fits(n, false));
          }
          prev = cur;
          cur = next;
        }
      }
      chains.push(chain);
    }
  }

  // --- Split each chain into maximal monotonic-staircase runs. ---
  const cells = new Set<string>();
  const runs: DiagonalRun[] = [];
  const emit = (slice: readonly GridCell[]): void => {
    if (slice.length < MIN_RUN_CELLS) return;
    // Must actually be diagonal: movement on BOTH axes.
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!first || !last) return;
    if (first.gx === last.gx || first.gz === last.gz) return;
    let axisRun = 1;
    let axisChanges = 0;
    for (let i = 2; i < slice.length; i++) {
      const a = slice[i - 2];
      const b = slice[i - 1];
      const c = slice[i];
      if (!a || !b || !c) return;
      const sameAxis = (a.gx === b.gx) === (b.gx === c.gx);
      if (!sameAxis) axisChanges++;
      axisRun = sameAxis ? axisRun + 1 : 1;
    }
    // One corner in an otherwise straight chain is a corner, not a diagonal.
    if (axisChanges < 2) return;
    for (const c of slice) cells.add(key(c.gx, c.gz));
    runs.push({ cells: slice, spine: rdp(slice) });
  };

  for (const chain of chains) {
    if (chain.length < MIN_RUN_CELLS) continue;
    let start = 0;
    let sx = 0; // allowed x-step sign for the current run (0 = unset)
    let sz = 0;
    let lastAxisX = false;
    let axisRun = 0;
    for (let i = 1; i < chain.length; i++) {
      const p = chain[i - 1];
      const c = chain[i];
      if (!p || !c) break;
      const dx = c.gx - p.gx;
      const dz = c.gz - p.gz;
      const axisX = dx !== 0;
      const sign = axisX ? Math.sign(dx) : Math.sign(dz);
      const sameAxis = i > start + 1 && axisX === lastAxisX;
      const signOk = axisX ? sx === 0 || sign === sx : sz === 0 || sign === sz;
      const runOk = !sameAxis || axisRun < MAX_AXIS_RUN;
      if (!signOk || !runOk) {
        emit(chain.slice(start, i));
        // Restart at the previous cell so runs stay contiguous.
        start = i - 1;
        sx = 0;
        sz = 0;
        axisRun = 0;
      }
      if (axisX) sx = sign;
      else sz = sign;
      axisRun = i > start + 1 && axisX === lastAxisX ? axisRun + 1 : 1;
      lastAxisX = axisX;
    }
    emit(chain.slice(start));
  }

  return { cells, runs };
}
