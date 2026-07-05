import * as THREE from "three";

import { GRID_X, GRID_Z, ROAD_TILE, ROAD_Y, WORLD_HALF_X, WORLD_HALF_Z } from "../shared/constants";
import { DIR_DELTA, E, type Mask, maskHas, N, S, W } from "../shared/types";
import { conformToTerrain } from "./conform";
import type { CityPlan } from "./grid";
import { districtAt } from "./sf-map";
import type { Terrain } from "./terrain";

// Procedural street geometry, the way a racing game builds roads: the network
// graph IS the geometry source. Each road cell emits asphalt, sidewalks,
// curbs, lane markings and crosswalks directly from its connection mask — a
// junction can never render as a straight, arms always meet neighbours at the
// tile edge, and the asphalt top sits exactly at the height the car drives on.

// Asphalt span within a tile. Everything else derives from it: sidewalks fill
// to the tile edge, parked cars sit inside the outer lane, traffic drives at
// ±LANE_CENTER, streetlights stand on the sidewalk.
export const ASPHALT_W = ROAD_TILE * 0.8; // wider tarmac — drifting needs room
export const SIDEWALK_W = (ROAD_TILE - ASPHALT_W) / 2;
export const LANE_CENTER = ASPHALT_W * 0.19; // traffic keeps right of the yellow line
const CURB_H = 0.13;
// Asphalt floats a hair above ROAD_Y so the coarser terrain mesh can't poke
// through on slopes (their tessellations approximate the same field ±~0.03).
const ASPHALT_LIFT = ROAD_Y + 0.05;
const SIDEWALK_LIFT = ROAD_Y + CURB_H;
const LINE_LIFT = ASPHALT_LIFT + 0.07; // above the conform error tolerance
const LINE_W = 0.24;
const EDGE_INSET = 0.5; // white edge line inset from the asphalt edge
const DASH_LEN = 2.2;
const DASH_GAP = 2.6;
const ZEBRA_BARS = 5;

const MAT_ASPHALT = new THREE.MeshStandardMaterial({ color: 0x40454c, roughness: 1 });
const MAT_SIDEWALK = new THREE.MeshStandardMaterial({ color: 0xb6b9b0, roughness: 1 });
const MAT_CURB = new THREE.MeshStandardMaterial({ color: 0x8f938c, roughness: 1 });
const MAT_YELLOW = new THREE.MeshStandardMaterial({ color: 0xd8a13c, roughness: 0.9 });
const MAT_WHITE = new THREE.MeshStandardMaterial({ color: 0xdfe3e3, roughness: 0.9 });

type Part = { geo: THREE.BufferGeometry; mat: THREE.Material; lift: number };

// A flat +Y quad in world space (two triangles, CCW seen from above, simple UVs).
function quad(x0: number, z0: number, x1: number, z1: number): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array([x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0]);
  const nor = new Float32Array(18);
  for (let i = 0; i < 6; i++) nor[i * 3 + 1] = 1;
  const uv = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

// A flat +Y triangle in world space (winding fixed up to face +Y).
function tri(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): THREE.BufferGeometry {
  // Upward normal needs (b-a)×(c-a) with positive y.
  const crossY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  const p =
    crossY >= 0
      ? [ax, 0, az, bx, 0, bz, cx, 0, cz]
      : [ax, 0, az, cx, 0, cz, bx, 0, bz];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3));
  const nor = new Float32Array(9);
  for (let i = 0; i < 3; i++) nor[i * 3 + 1] = 1;
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 1]), 2));
  return geo;
}

// A flat +Y strip quad between two world points with a half-width — the
// diagonal counterpart of quad(). Same winding/attribute layout.
function stripQuad(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  halfW: number,
): THREE.BufferGeometry {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz) || 1;
  const px = (-dz / len) * halfW;
  const pz = (dx / len) * halfW;
  // Corners mapped like quad()'s (x0,z0)/(x0,z1)/(x1,z1)/(x1,z0) pattern.
  const ax = x0 - px;
  const az = z0 - pz;
  const bx = x0 + px;
  const bz = z0 + pz;
  const cx = x1 + px;
  const cz = z1 + pz;
  const dx2 = x1 - px;
  const dz2 = z1 - pz;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array([ax, 0, az, bx, 0, bz, cx, 0, cz, ax, 0, az, cx, 0, cz, dx2, 0, dz2]);
  const nor = new Float32Array(18);
  for (let i = 0; i < 6; i++) nor[i * 3 + 1] = 1;
  const uv = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0]);
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

// A curb: a thin raised box strip (axis-aligned).
function curb(x0: number, z0: number, x1: number, z1: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(x1 - x0, CURB_H, z1 - z0);
  geo.translate((x0 + x1) / 2, CURB_H / 2, (z0 + z1) / 2);
  return geo;
}

export function buildRoads(plan: CityPlan, terrain: Terrain): THREE.Mesh[] {
  const parts: Part[] = [];
  const wx = (gx: number): number => (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
  const wz = (gz: number): number => (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
  const isRoad = (gx: number, gz: number): boolean => plan.cells[gx]?.[gz] === "road";

  const half = ROAD_TILE / 2;
  const aHalf = ASPHALT_W / 2;

  for (let gx = 0; gx < GRID_X; gx++) {
    for (let gz = 0; gz < GRID_Z; gz++) {
      if (!isRoad(gx, gz)) continue;
      // Diagonal-run cells: one full-tile asphalt slab — the sawtooth of
      // per-arm asphalt/sidewalk/curbs is exactly what reads jagged on a
      // staircase. The run's chord markings are emitted after this loop.
      if (plan.diagonalCells.has(`${gx},${gz}`)) {
        parts.push({
          geo: quad(wx(gx) - half, wz(gz) - half, wx(gx) + half, wz(gz) + half),
          mat: MAT_ASPHALT,
          lift: ASPHALT_LIFT,
        });
        continue;
      }
      let mask: Mask = 0;
      for (const d of [N, E, S, W] as const) {
        const [dx, dz] = DIR_DELTA[d];
        if (isRoad(gx + dx, gz + dz)) mask |= 1 << d;
      }
      const cx = wx(gx);
      const cz = wz(gz);
      const conn = {
        n: maskHas(mask, N),
        e: maskHas(mask, E),
        s: maskHas(mask, S),
        w: maskHas(mask, W),
      };
      const count = (conn.n ? 1 : 0) + (conn.e ? 1 : 0) + (conn.s ? 1 : 0) + (conn.w ? 1 : 0);
      const isStraightNS = conn.n && conn.s && count === 2;
      const isStraightEW = conn.e && conn.w && count === 2;

      // --- Asphalt: centre square + an arm to every connected edge. Straights
      // are one continuous ribbon so markings can run unbroken. ---
      if (isStraightNS) {
        parts.push({ geo: quad(cx - aHalf, cz - half, cx + aHalf, cz + half), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
      } else if (isStraightEW) {
        parts.push({ geo: quad(cx - half, cz - aHalf, cx + half, cz + aHalf), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
      } else {
        parts.push({ geo: quad(cx - aHalf, cz - aHalf, cx + aHalf, cz + aHalf), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
        if (conn.n) parts.push({ geo: quad(cx - aHalf, cz - half, cx + aHalf, cz - aHalf), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
        if (conn.s) parts.push({ geo: quad(cx - aHalf, cz + aHalf, cx + aHalf, cz + half), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
        if (conn.w) parts.push({ geo: quad(cx - half, cz - aHalf, cx - aHalf, cz + aHalf), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
        if (conn.e) parts.push({ geo: quad(cx + aHalf, cz - aHalf, cx + half, cz + aHalf), mat: MAT_ASPHALT, lift: ASPHALT_LIFT });
      }

      // --- Sidewalks: four corner pads always; edge strips where no arm exits. ---
      const sw: Part["geo"][] = [
        quad(cx - half, cz - half, cx - aHalf, cz - aHalf), // NW corner
        quad(cx + aHalf, cz - half, cx + half, cz - aHalf), // NE
        quad(cx - half, cz + aHalf, cx - aHalf, cz + half), // SW
        quad(cx + aHalf, cz + aHalf, cx + half, cz + half), // SE
      ];
      if (!conn.n) sw.push(quad(cx - aHalf, cz - half, cx + aHalf, cz - aHalf));
      if (!conn.s) sw.push(quad(cx - aHalf, cz + aHalf, cx + aHalf, cz + half));
      if (!conn.w) sw.push(quad(cx - half, cz - aHalf, cx - aHalf, cz + aHalf));
      if (!conn.e) sw.push(quad(cx + aHalf, cz - aHalf, cx + half, cz + aHalf));
      for (const g of sw) parts.push({ geo: g, mat: MAT_SIDEWALK, lift: SIDEWALK_LIFT });

      // --- Curbs along every asphalt/sidewalk boundary. ---
      const CT = 0.28; // curb thickness (grows inward from the asphalt edge)
      // Arm flanks (N/S arms: vertical curbs beside them; E/W: horizontal).
      if (conn.n) {
        parts.push({ geo: curb(cx - aHalf - CT, cz - half, cx - aHalf, cz - aHalf), mat: MAT_CURB, lift: ROAD_Y });
        parts.push({ geo: curb(cx + aHalf, cz - half, cx + aHalf + CT, cz - aHalf), mat: MAT_CURB, lift: ROAD_Y });
      } else {
        parts.push({ geo: curb(cx - aHalf - CT, cz - aHalf - CT, cx + aHalf + CT, cz - aHalf), mat: MAT_CURB, lift: ROAD_Y });
      }
      if (conn.s) {
        parts.push({ geo: curb(cx - aHalf - CT, cz + aHalf, cx - aHalf, cz + half), mat: MAT_CURB, lift: ROAD_Y });
        parts.push({ geo: curb(cx + aHalf, cz + aHalf, cx + aHalf + CT, cz + half), mat: MAT_CURB, lift: ROAD_Y });
      } else {
        parts.push({ geo: curb(cx - aHalf - CT, cz + aHalf, cx + aHalf + CT, cz + aHalf + CT), mat: MAT_CURB, lift: ROAD_Y });
      }
      if (conn.w) {
        parts.push({ geo: curb(cx - half, cz - aHalf - CT, cx - aHalf, cz - aHalf), mat: MAT_CURB, lift: ROAD_Y });
        parts.push({ geo: curb(cx - half, cz + aHalf, cx - aHalf, cz + aHalf + CT), mat: MAT_CURB, lift: ROAD_Y });
      } else if (conn.n || conn.s) {
        parts.push({ geo: curb(cx - aHalf - CT, cz - aHalf, cx - aHalf, cz + aHalf), mat: MAT_CURB, lift: ROAD_Y });
      }
      if (conn.e) {
        parts.push({ geo: curb(cx + aHalf, cz - aHalf - CT, cx + half, cz - aHalf), mat: MAT_CURB, lift: ROAD_Y });
        parts.push({ geo: curb(cx + aHalf, cz + aHalf, cx + half, cz + aHalf + CT), mat: MAT_CURB, lift: ROAD_Y });
      } else if (conn.n || conn.s) {
        parts.push({ geo: curb(cx + aHalf, cz - aHalf, cx + aHalf + CT, cz + aHalf), mat: MAT_CURB, lift: ROAD_Y });
      }

      // --- Markings ---
      const lw = LINE_W / 2;
      const edge = aHalf - EDGE_INSET;
      const walkable = ((): boolean => {
        const c = districtAt(gx, gz).character;
        return c === "commercial" || c === "downtown" || c === "wharf" || c === "victorian";
      })();
      const junctionNeighbor = (dx: number, dz: number): boolean => {
        const ngx = gx + dx;
        const ngz = gz + dz;
        if (!isRoad(ngx, ngz)) return false;
        let m = 0;
        for (const d of [N, E, S, W] as const) {
          const [ddx, ddz] = DIR_DELTA[d];
          if (isRoad(ngx + ddx, ngz + ddz)) m++;
        }
        return m >= 3;
      };

      if (isStraightNS || isStraightEW) {
        const along = isStraightNS ? "z" : "x";
        // Yellow centre dashes + white edge lines, full tile length.
        for (let off = -half; off < half; off += DASH_LEN + DASH_GAP) {
          const d0 = off;
          const d1 = Math.min(off + DASH_LEN, half);
          parts.push({
            geo:
              along === "z"
                ? quad(cx - lw, cz + d0, cx + lw, cz + d1)
                : quad(cx + d0, cz - lw, cx + d1, cz + lw),
            mat: MAT_YELLOW,
            lift: LINE_LIFT,
          });
        }
        for (const side of [-edge, edge]) {
          parts.push({
            geo:
              along === "z"
                ? quad(cx + side - lw, cz - half, cx + side + lw, cz + half)
                : quad(cx - half, cz + side - lw, cx + half, cz + side + lw),
            mat: MAT_WHITE,
            lift: LINE_LIFT,
          });
        }
        // Crosswalk at the junction-facing end (walkable districts).
        if (walkable) {
          const ends: readonly (readonly [number, number])[] = isStraightNS
            ? [
                [0, -1],
                [0, 1],
              ]
            : [
                [-1, 0],
                [1, 0],
              ];
          for (const [dx, dz] of ends) {
            if (!junctionNeighbor(dx, dz)) continue;
            const barW = (ASPHALT_W - 1.6) / (ZEBRA_BARS * 2 - 1);
            for (let i = 0; i < ZEBRA_BARS; i++) {
              const b0 = -(ASPHALT_W - 1.6) / 2 + i * barW * 2;
              if (isStraightNS) {
                const zEdge = dz < 0 ? cz - half + 0.5 : cz + half - 2.1;
                parts.push({ geo: quad(cx + b0, zEdge, cx + b0 + barW, zEdge + 1.6), mat: MAT_WHITE, lift: LINE_LIFT });
              } else {
                const xEdge = dx < 0 ? cx - half + 0.5 : cx + half - 2.1;
                parts.push({ geo: quad(xEdge, cz + b0, xEdge + 1.6, cz + b0 + barW), mat: MAT_WHITE, lift: LINE_LIFT });
              }
            }
          }
        }
      } else {
        // Bends/junctions: dashes run along each arm up to the centre square.
        if (conn.n)
          parts.push({ geo: quad(cx - lw, cz - half, cx + lw, cz - aHalf), mat: MAT_YELLOW, lift: LINE_LIFT });
        if (conn.s)
          parts.push({ geo: quad(cx - lw, cz + aHalf, cx + lw, cz + half), mat: MAT_YELLOW, lift: LINE_LIFT });
        if (conn.w)
          parts.push({ geo: quad(cx - half, cz - lw, cx - aHalf, cz + lw), mat: MAT_YELLOW, lift: LINE_LIFT });
        if (conn.e)
          parts.push({ geo: quad(cx + aHalf, cz - lw, cx + half, cz + lw), mat: MAT_YELLOW, lift: LINE_LIFT });
      }
    }
  }

  // --- Diagonal avenue markings: yellow dashes + white edge lines along each
  // run's RDP spine — the same straightened centreline traffic drives, so the
  // painted lane IS the driving line. ---
  const EDGE_DIAG = ROAD_TILE * 0.3; // inside the tile-union pinch points
  const lw = LINE_W / 2;
  const CHAMFER = ROAD_TILE * 0.48; // leg length of the elbow-notch fill
  for (const run of plan.diagonalRuns) {
    const cells = run.cells;
    const first = cells[0];
    const last = cells[cells.length - 1];
    if (!first || !last) continue;

    // Chamfer the inner elbow of every staircase step: where the path turns
    // around a tile corner, a square lawn notch pokes into the avenue — a 45°
    // asphalt triangle across the notch smooths the sawtooth silhouette.
    for (let i = 2; i < cells.length; i++) {
      const a = cells[i - 2];
      const b = cells[i - 1];
      const c = cells[i];
      if (!a || !b || !c) continue;
      const s1x = b.gx - a.gx;
      const s1z = b.gz - a.gz;
      const s2x = c.gx - b.gx;
      const s2z = c.gz - b.gz;
      if ((s1x !== 0) === (s2x !== 0)) continue; // straight-through, no elbow
      // Corner of tile b where tiles a and c touch; the notch opens from it
      // along (-step1, +step2).
      const px = wx(b.gx) + ((-s1x + s2x) * ROAD_TILE) / 2;
      const pz = wz(b.gz) + ((-s1z + s2z) * ROAD_TILE) / 2;
      parts.push({
        geo: tri(
          px,
          pz,
          px - s1x * CHAMFER,
          pz - s1z * CHAMFER,
          px + s2x * CHAMFER,
          pz + s2z * CHAMFER,
        ),
        mat: MAT_ASPHALT,
        lift: ASPHALT_LIFT,
      });
    }
    // worldX/worldZ arithmetic works for the spine's fractional grid coords.
    const pts: [number, number][] = run.spine.map((p) => [wx(p.gx), wz(p.gz)]);

    // Dashes by global arclength; a dash spanning a polyline joint renders as
    // a straight chord across it (2.2u dashes — the cut is invisible).
    const cum: number[] = [0];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const prev = cum[i] ?? 0;
      cum.push(prev + (a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0));
    }
    const total = cum[cum.length - 1] ?? 0;
    const pointAt = (s: number): readonly [number, number] => {
      for (let i = 0; i + 1 < pts.length; i++) {
        const s0 = cum[i] ?? 0;
        const s1 = cum[i + 1] ?? 0;
        if (s > s1 && i + 2 < pts.length) continue;
        const a = pts[i];
        const b = pts[i + 1];
        if (!a || !b) break;
        const t = s1 > s0 ? THREE.MathUtils.clamp((s - s0) / (s1 - s0), 0, 1) : 0;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      const lastPt = pts[pts.length - 1];
      return lastPt ?? [0, 0];
    };
    for (let s = 0; s < total; s += DASH_LEN + DASH_GAP) {
      const e = Math.min(s + DASH_LEN, total);
      if (e - s < 0.5) continue;
      const p0 = pointAt(s);
      const p1 = pointAt(e);
      parts.push({
        geo: stripQuad(p0[0], p0[1], p1[0], p1[1], lw),
        mat: MAT_YELLOW,
        lift: LINE_LIFT,
      });
    }

    // White edge lines along each long-enough spine segment.
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < ROAD_TILE * 3.2) continue; // short bend segments: dashes only
      const px = (-(b[1] - a[1]) / len) * EDGE_DIAG;
      const pz = ((b[0] - a[0]) / len) * EDGE_DIAG;
      for (const s of [1, -1] as const) {
        parts.push({
          geo: stripQuad(a[0] + px * s, a[1] + pz * s, b[0] + px * s, b[1] + pz * s, lw),
          mat: MAT_WHITE,
          lift: LINE_LIFT,
        });
      }
    }
  }

  // Conform every part to the terrain and hand back identity meshes; the
  // caller's mergeByMaterial collapses these to one draw call per material.
  const out: THREE.Mesh[] = [];
  for (const p of parts) {
    const draped = conformToTerrain(p.geo, terrain, p.lift);
    out.push(new THREE.Mesh(draped, p.mat));
  }
  return out;
}
