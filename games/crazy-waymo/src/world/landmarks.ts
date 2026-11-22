import * as THREE from "three";
import type { WaterBody } from "./water";

import { registerBeacons } from "../fx/beacon-lights";
import type { Beacon } from "../fx/beacon-lights";
import type { ModelCache } from "../assets/loader";
import {
  GRID_X,
  GRID_Z,
  ROAD_TILE,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import { Rng } from "../shared/rng";
import type { Solid } from "./city";
import type { CityPlan } from "./grid";
import { arc, box, cyl, dome, facet, MAT, mesh, packLandmark, paint, strut } from "./landmark-geo";
import { MASONRY, seatMasonry } from "./masonry";
import type { RoadNetwork } from "./network";
import { createSalesforceModel } from "./sf-salesforce";
import type { Terrain } from "./terrain";

const KIT_SCALE = ROAD_TILE / 8;

export interface LandmarkCtx {
  readonly terrain: Terrain;
  readonly cache: ModelCache;
  readonly network: RoadNetwork | null;
  readonly rng: Rng;
  /** Resolved world position of the monument's origin (x, z). */
  readonly origin: readonly [number, number];
  /**
   * Terrain height under a landmark-LOCAL point, expressed in local units
   * relative to the monument's own origin (accounts for the placement
   * rotation and scale). Terrain-following parts — parapets on a summit,
   * ruins on a bluff — seat through this so they never float downhill.
   */
  readonly groundAt: (lx: number, lz: number) => number;
  /**
   * True when a landmark-local point sits within `margin` of street asphalt.
   * Set dressing that would land in the roadway is dropped instead of
   * fighting the drape.
   */
  readonly onAsphalt: (lx: number, lz: number, margin: number) => boolean;
  /**
   * A landmark-LOCAL point in world space, placement rotation, scale and seat
   * height applied. Geometry never needs this — it is authored in local space
   * and the group carries the transform — but anything a monument publishes to
   * a world-space registry does (the night beacons in fx/beacon-lights.ts).
   */
  readonly worldPoint: (lx: number, ly: number, lz: number) => readonly [number, number, number];
  /** Paired local water-wall geometry/collision. Cold generation captures the
   * transformed solids; runtime landmark rebuilds reuse those baked solids. */
  readonly addWaterWall: (wall: Solid & { readonly minY: number; readonly maxY: number }) => void;
  readonly addWaterBody: (body: WaterBody) => void;
}

let landmarkBeacons: Beacon[] = [];

const beaconAt = (
  ctx: LandmarkCtx,
  lx: number,
  ly: number,
  lz: number,
  color: number,
  size: number,
  blinkS?: number,
) => {
  const [x, y, z] = ctx.worldPoint(lx, ly, lz);
  landmarkBeacons.push(
    blinkS === undefined ? { color, size, x, y, z } : { blinkS, color, size, x, y, z },
  );
};

const lowestUnder = (ctx: LandmarkCtx, halfX: number, halfZ: number, x = 0, z = 0) => {
  let lo = 0;

  for (const dx of [-halfX, 0, halfX]) {
    for (const dz of [-halfZ, 0, halfZ]) {
      lo = Math.min(lo, ctx.groundAt(x + dx, z + dz));
    }
  }

  return lo;
};

type Seat = "ground" | "sea";

interface LandmarkDef {
  readonly build: (ctx: LandmarkCtx) => THREE.Group;
  readonly seat: Seat;
  readonly scale: number;
}

const pyramid = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const H = 36;
  const cone = mesh(facet(new THREE.ConeGeometry(4.4, H, 4)), MAT.white, 0, H / 2, 0);
  cone.rotation.y = Math.PI / 4;
  g.add(cone);
  g.add(box(1.4, 14, 3, MAT.white, -3.2, 7, 0));
  g.add(box(1.4, 14, 3, MAT.white, 3.2, 7, 0));
  g.add(box(9.6, 3.4, 9.6, MAT.slate, 0, 1.7, 0, Math.PI / 4));
  g.add(box(8.4, 0.5, 8.4, MAT.steel, 0, 3.6, 0, Math.PI / 4));

  for (let i = 1; i <= 7; i += 1) {
    const y = (H * i) / 8;
    const r = 4.4 * (1 - y / H) * 1.04;
    const band = cyl(r * 0.94, r, 0.4, 4, MAT.steel, 0, y, 0);
    band.rotation.y = Math.PI / 4;
    g.add(band);
  }

  g.add(cyl(0.18, 0.18, 7, 8, MAT.white, 0, H + 3, 0));
  g.add(box(0.7, 0.7, 0.7, MAT.lamp, 0, H + 6.6, 0));
  beaconAt(ctx, 0, H + 6.6, 0, 0xff_5a_48, 3.2, 2.4);

  return g;
};

const salesforce = () => createSalesforceModel();

const coitTower = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const H = 16;
  g.add(cyl(3.4, 3.7, 1.3, 16, MAT.cream, 0, 0.5, 0));
  g.add(cyl(2.1, 2.4, H, 16, MAT.white, 0, H / 2, 0));
  arc(16, 2.22, 0, 360, (x, z) => {
    g.add(cyl(0.2, 0.24, H - 1.4, 5, MAT.white, x, (H - 1.4) / 2, z));
  });
  g.add(cyl(2.5, 2.2, 2.6, 16, MAT.white, 0, H + 1, 0));
  arc(8, 2.3, 0, 360, (x, z, yaw) => {
    g.add(box(1.1, 1.7, 0.5, MAT.slate, x, H + 1.1, z, yaw));
  });
  g.add(cyl(1.4, 2.2, 2, 16, MAT.white, 0, H + 3, 0));
  g.add(cyl(1.5, 1.5, 0.5, 12, MAT.lamp, 0, H + 4.1, 0));
  beaconAt(ctx, 0, H + 4.1, 0, 0xff_e0_a8, 6.5);
  beaconAt(ctx, 0, H + 1, 0, 0xff_d9_a0, 5);

  return g;
};

const FERRY_LEN = 45.2;
const FERRY_DEPTH = 7.6;
const FERRY_EAVES = 4.2;
const FERRY_TOWER = 16.2;

const ferryBuilding = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const W = FERRY_LEN;
  const D = FERRY_DEPTH;
  const H = FERRY_EAVES;
  const foot = lowestUnder(ctx, W / 2, D / 2);
  g.add(box(W + 1.4, 0.8 - foot, D + 1.4, MAT.rock, 0, (0.8 + foot) / 2 - 0.4, 0));
  g.add(box(W, H, D, MAT.cream, 0, H / 2, 0));
  g.add(box(W + 0.8, 0.6, D + 0.8, MAT.cream, 0, H + 0.3, 0));
  g.add(box(W - 1.2, 0.5, D - 1.2, MAT.slate, 0, H + 0.8, 0));
  const bays = 22;

  for (let i = 0; i < bays; i += 1) {
    const bx = -W / 2 + (W * (i + 0.5)) / bays;

    for (const sz of [-D / 2, D / 2]) {
      g.add(box(1.1, 2.6, 0.35, MAT.slate, bx, 1.6, sz));
    }
  }

  const shaft = FERRY_TOWER - 3.8;
  g.add(box(D, shaft, D, MAT.cream, 0, shaft / 2, 0));
  g.add(box(D + 0.7, 2.2, D + 0.7, MAT.cream, 0, shaft + 1.1, 0));

  for (const [cx, cz] of [
    [0, (D + 0.7) / 2],
    [0, -(D + 0.7) / 2],
    [(D + 0.7) / 2, 0],
    [-(D + 0.7) / 2, 0],
  ] as const) {
    g.add(box(cz === 0 ? 0.3 : 2, 2, cz === 0 ? 2 : 0.3, MAT.steel, cx, shaft + 1.1, cz));
  }

  const clockR = (D + 0.7) / 2 + 0.18;

  for (let f = 0; f < 4; f += 1) {
    const face = new THREE.Group();
    face.add(cyl(2.05, 2.05, 0.24, 16, MAT.slate, 0, 0, 0).rotateX(Math.PI / 2));
    face.add(cyl(1.72, 1.72, 0.3, 16, MAT.white, 0, 0, 0.04).rotateX(Math.PI / 2));
    face.add(box(0.16, 1.4, 0.34, MAT.gold, 0, 0.6, 0.1));
    face.add(box(0.9, 0.16, 0.34, MAT.gold, 0.38, 0, 0.1));
    const yaw = (f * Math.PI) / 2;
    face.position.set(Math.sin(yaw) * clockR, shaft + 1.1, Math.cos(yaw) * clockR);
    face.rotation.y = yaw;
    g.add(face);
  }

  g.add(mesh(new THREE.ConeGeometry(D * 0.72, 1.6, 4), MAT.slate, 0, shaft + 3, 0));
  beaconAt(ctx, 0, shaft + 1.1, 0, 0xff_e9_bc, 8);
  beaconAt(ctx, 0, shaft + 3.4, 0, 0xff_d9_a0, 4);

  return g;
};

const sutroTower = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const H = 26;
  const lean = 0.1;

  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI * 2;
    const bx = Math.cos(a) * 3.4;
    const bz = Math.sin(a) * 3.4;
    const leg = cyl(0.32, 0.5, H, 6, MAT.orange, bx, H / 2, bz);
    leg.rotation.z = Math.cos(a) * lean;
    leg.rotation.x = -Math.sin(a) * lean;
    g.add(leg);
    g.add(cyl(0.16, 0.22, 14, 6, MAT.white, Math.cos(a) * 2.2, H + 6.5, Math.sin(a) * 2.2));
  }

  const legAt = (i: number, y: number) => {
    const a = (i / 3) * Math.PI * 2;
    const r = 3.4 + (y / H) * lean * 3.4;

    return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  };

  for (let lvl = 0; lvl < 5; lvl += 1) {
    const y0 = 2 + (lvl * (H - 4)) / 5;
    const y1 = 2 + ((lvl + 1) * (H - 4)) / 5;

    for (let i = 0; i < 3; i += 1) {
      const j = (i + 1) % 3;
      g.add(strut(legAt(i, y0), legAt(j, y0), 0.14, MAT.orange, 5));
      g.add(strut(legAt(i, y0), legAt(j, y1), 0.11, MAT.orange, 5));
      g.add(strut(legAt(j, y0), legAt(i, y1), 0.11, MAT.orange, 5));
    }
  }

  g.add(cyl(2.9, 2.9, 0.7, 8, MAT.orange, 0, H * 0.62, 0));
  g.add(cyl(2.4, 2.4, 0.7, 8, MAT.orange, 0, H, 0));
  g.add(cyl(0.14, 0.14, 5.4, 6, MAT.white, 0, H + 13, 0));

  for (let i = 0; i < 3; i += 1) {
    const a = (i / 3) * Math.PI * 2;
    beaconAt(ctx, Math.cos(a) * 2.2, H + 13.5, Math.sin(a) * 2.2, 0xff_44_36, 3.2, 2.2);
  }

  return g;
};

const dragonGate = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const [ox, oz] = ctx.origin;
  const hit = ctx.network?.nearest(ox, oz, ROAD_TILE * 2) ?? null;
  const yaw = hit ? Math.atan2(-hit.tx, -hit.tz) : 0;
  const span = ((hit ? hit.edge.half : 5) + 1.9) / KIT_SCALE;
  const gate = new THREE.Group();

  if (hit) {
    gate.position.set((hit.x - ox) / KIT_SCALE, 0, (hit.z - oz) / KIT_SCALE);
  }

  for (const sx of [-span, span]) {
    gate.add(cyl(0.45, 0.62, 5.6, 10, MAT.gateRed, sx, 2.8, 0));
    gate.add(box(1.8, 0.8, 1.8, MAT.rock, sx, 0.4, 0));
  }

  const W = span * 2 + 2.2;
  gate.add(box(W, 0.5, 2.2, MAT.gateRed, 0, 5.8, 0));
  gate.add(box(W - 1.4, 0.9, 2.8, MAT.gateGreen, 0, 6.5, 0));
  gate.add(box(W * 0.57, 0.8, 2.4, MAT.gateGreen, 0, 7.6, 0));
  gate.add(box(W * 0.28, 0.9, 2, MAT.gateGreen, 0, 8.6, 0));
  gate.add(mesh(new THREE.SphereGeometry(0.5, 8, 6), MAT.gateRed, 0, 9.4, 0));
  gate.rotation.y = yaw;
  g.add(gate);

  return g;
};

const PL_BAY = 8.2;
const PL_DEPTH = 9.4;
const PL_H = 12.2;

const PL_PAINT = new THREE.MeshStandardMaterial({
  color: 0xff_ff_ff,
  roughness: 0.85,
  vertexColors: true,
});

const PL_MATS: readonly THREE.Material[] = [PL_PAINT, ...Object.values(MASONRY)];

interface LadyPaint {
  readonly body: number;
  readonly trim: number;
  readonly accent: number;
}

const PL_FALLBACK: LadyPaint = { accent: 0x8e_6f_40, body: 0xe0_c9_9a, trim: 0xf4_ec_d8 };

const PL_PALETTE: readonly LadyPaint[] = [
  { accent: 0x8e_6f_40, body: 0xe0_c9_9a, trim: 0xf6_ef_db },
  { accent: 0x46_62_74, body: 0xb9_cf_dd, trim: 0xee_f5_f8 },
  { accent: 0x9b_56_38, body: 0xe6_bf_a6, trim: 0xf9_eb_e0 },
  { accent: 0x5b_70_40, body: 0xc6_d2_ae, trim: 0xf0_f4_e4 },
  { accent: 0x8c_4a_63, body: 0xdc_b9_c6, trim: 0xf8_e8_ee },
  { accent: 0x4c_54_78, body: 0xb6_bc_d2, trim: 0xec_ed_f7 },
];

const PL_S1 = 4.2;
const PL_S2 = 8.2;
const PL_FRONT = PL_DEPTH / 2;
const PL_REAR = -PL_DEPTH / 2;
const PL_REAR_FACE = PL_REAR - 1;
const PL_EAVES = PL_H + 0.875;

const pl = (
  color: number,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  yaw = 0,
) => paint(box(w, h, d, PL_PAINT, x, y, z, yaw), color);

const sash = (
  g: THREE.Group,
  p: LadyPaint,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  out: 1 | -1,
) => {
  g.add(pl(p.trim, w + 0.55, h + 0.55, 0.26, x, y, z + out * 0.13));
  g.add(box(w, h, 0.2, MAT.glass, x, y, z + out * 0.29));
  g.add(pl(p.trim, 0.15, h, 0.24, x, y, z + out * 0.37));
  g.add(pl(p.trim, w, 0.15, 0.24, x, y + h * 0.16, z + out * 0.37));
};

const paintedLady = (g: THREE.Group, i: number, base: number) => {
  const cx = (i - 2.5) * PL_BAY;
  const p = PL_PALETTE[i] ?? PL_FALLBACK;
  const bayX = cx + 1.4;
  const entryX = cx - 2.4;

  g.add(pl(p.body, PL_BAY, PL_H, PL_DEPTH, cx, PL_H / 2, 0));
  g.add(box(PL_BAY, 0.7 - base, PL_DEPTH + 0.4, MAT.slate, cx, (0.7 + base) / 2, 0));

  g.add(pl(p.trim, 3.9, 3.35, 0.3, bayX, 1.85, PL_FRONT + 0.14));
  g.add(pl(p.accent, 3.2, 2.7, 0.34, bayX, 1.7, PL_FRONT + 0.26));

  for (let d = 0; d < 3; d += 1) {
    g.add(pl(p.trim, 2.9, 0.14, 0.4, bayX, 0.85 + d * 0.82, PL_FRONT + 0.3));
  }

  for (let s = 0; s < 6; s += 1) {
    g.add(pl(p.trim, 2.3, 0.46, 0.55, entryX, 0.23 + s * 0.42, PL_FRONT + 3.05 - s * 0.5));
  }

  g.add(pl(p.trim, 2.4, 0.5, 1.2, entryX, 2.75, PL_FRONT + 0.8));

  for (const sx of [-1.15, 1.15]) {
    g.add(pl(p.trim, 0.42, 1.1, 0.42, entryX + sx, 3.25, PL_FRONT + 2.85));
  }

  g.add(pl(p.trim, 2.4, 3.6, 0.32, entryX, 4.3, PL_FRONT + 0.16));
  g.add(pl(p.accent, 1.3, 2.5, 0.36, entryX, 3.85, PL_FRONT + 0.3));
  g.add(pl(p.trim, 1.4, 0.14, 0.4, entryX, 4.35, PL_FRONT + 0.34));

  for (const sx of [-0.95, 0.95]) {
    g.add(pl(p.trim, 0.28, 2.9, 0.34, entryX + sx, 4.15, PL_FRONT + 0.36));
  }

  g.add(pl(p.trim, 2.7, 0.42, 0.62, entryX, 5.85, PL_FRONT + 0.4));

  for (const sy of [PL_S1 + 2.1, PL_S2 + 2.1]) {
    g.add(pl(p.body, 2.7, 3.3, 1.8, bayX, sy, PL_FRONT + 0.9));
    sash(g, p, bayX, sy, PL_FRONT + 1.8, 2, 2.25, 1);

    for (const s of [-1, 1] as const) {
      g.add(pl(p.body, 1.5, 3.3, 0.4, bayX + s * 1.78, sy, PL_FRONT + 0.46, -s * 0.72));
      g.add(pl(p.trim, 1.35, 2.75, 0.22, bayX + s * 1.88, sy, PL_FRONT + 0.575, -s * 0.72));
      g.add(box(1, 2.25, 0.2, MAT.glass, bayX + s * 1.935, sy, PL_FRONT + 0.637, -s * 0.72));
    }

    g.add(pl(p.trim, 4, 0.42, 2.2, bayX, sy + 1.86, PL_FRONT + 0.8));
    g.add(pl(p.accent, 3.8, 0.36, 2.1, bayX, sy - 1.78, PL_FRONT + 0.8));
  }

  for (const sy of [PL_S1 + 2.1, PL_S2 + 2.1]) {
    sash(g, p, entryX, sy, PL_FRONT, 1.25, 2.2, 1);
    g.add(pl(p.trim, 2.1, 0.24, 0.5, entryX, sy - 1.5, PL_FRONT + 0.3));
    g.add(pl(p.accent, 2.1, 0.26, 0.42, entryX, sy + 1.5, PL_FRONT + 0.28));
  }

  for (const by of [PL_S1, PL_S2]) {
    g.add(pl(p.trim, PL_BAY, 0.34, PL_DEPTH + 0.7, cx, by, 0));
  }

  for (const s of [-1, 1] as const) {
    g.add(pl(p.trim, 0.5, PL_H, 0.55, cx + (s * PL_BAY) / 2, PL_H / 2, PL_FRONT + 0.2));
    g.add(
      pl(p.trim, 0.44, PL_H - 1.2, 0.5, cx + (s * PL_BAY) / 2, (PL_H - 1.2) / 2, PL_REAR - 0.2),
    );
  }

  g.add(pl(p.trim, PL_BAY + 0.35, 0.85, 2.4, cx, PL_H + 0.45, PL_FRONT - 0.3));
  g.add(pl(p.trim, PL_BAY, 0.5, 1.2, cx, PL_H + 0.25, PL_REAR + 0.2));

  for (let d = 0; d < 11; d += 1) {
    g.add(pl(p.accent, 0.34, 0.7, 0.5, cx - 3.5 + d * 0.7, PL_H - 0.35, PL_FRONT + 0.62));
  }

  g.add(box(PL_BAY, 0.9, PL_DEPTH + 0.2, MAT.slate, cx, PL_H + 0.35, -0.5));

  if (i % 2 === 0) {
    const ped = mesh(
      facet(new THREE.CylinderGeometry(3.5, 3.5, 2.4, 3)),
      MAT.slate,
      cx,
      PL_EAVES + 1.09,
      PL_FRONT - 0.3,
    );

    ped.rotation.x = -Math.PI / 2;
    ped.scale.set(1, 1, 0.62);
    g.add(ped);
    g.add(pl(p.trim, 1.25, 0.95, 0.3, cx, PL_EAVES + 1, PL_FRONT + 0.85));
    g.add(box(0.85, 0.6, 0.24, MAT.glass, cx, PL_EAVES + 1, PL_FRONT + 1));
  } else {
    g.add(
      mesh(
        facet(new THREE.CylinderGeometry(1.6, 3.9, 2.4, 4)),
        MAT.slate,
        cx,
        PL_EAVES + 1.2,
        -0.5,
      ).rotateY(Math.PI / 4),
    );
    g.add(box(2.2, 0.4, 2.2, MAT.slate, cx, PL_EAVES + 2.5, -0.5));
    g.add(pl(p.trim, 1.9, 1.7, 1.1, cx, PL_EAVES + 1.1, PL_FRONT - 1.5));
    g.add(box(1.25, 1.05, 0.24, MAT.glass, cx, PL_EAVES + 1.1, PL_FRONT - 0.9));
    g.add(box(2.2, 0.3, 1.4, MAT.slate, cx, PL_EAVES + 2, PL_FRONT - 1.5));
  }

  g.add(pl(p.body, 4.6, PL_H - 1.1, 1, cx - 0.8, (PL_H - 1.1) / 2, PL_REAR - 0.5));
  g.add(pl(p.trim, 4.8, 0.3, 1.2, cx - 0.8, PL_H - 1.1, PL_REAR - 0.5));

  for (const sy of [PL_S1 + 2.1, PL_S2 + 2.1]) {
    sash(g, p, cx - 0.8, sy, PL_REAR_FACE, 1.1, 2.1, -1);
    sash(g, p, cx + 2.9, sy, PL_REAR, 1, 1.9, -1);
  }

  sash(g, p, cx + 2.9, 1.9, PL_REAR, 1, 1.9, -1);
  g.add(pl(p.trim, 1.9, 3, 0.28, cx - 0.8, 1.75, PL_REAR_FACE - 0.14));
  g.add(pl(p.accent, 1.15, 2.4, 0.3, cx - 0.8, 1.55, PL_REAR_FACE - 0.28));

  for (let s = 0; s < 2; s += 1) {
    g.add(pl(p.trim, 2.2, 0.34, 0.7, cx - 0.8, 0.17 + s * 0.32, PL_REAR_FACE - 0.85 + s * 0.34));
  }
};

const paintedLadies = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const base = lowestUnder(ctx, 3 * PL_BAY, PL_DEPTH / 2);

  for (let i = 0; i < 6; i += 1) {
    paintedLady(g, i, base);
  }

  for (let i = 0; i <= 6; i += 1) {
    const px = (i - 3) * PL_BAY;
    g.add(box(1, 3.2, 1.5, MAT.brick, px, PL_EAVES + 1.6, -1.4));
    g.add(box(1.3, 0.35, 1.8, MAT.slate, px, PL_EAVES + 3.35, -1.4));
  }

  for (const s of [-1, 1] as const) {
    const end = s < 0 ? PL_PALETTE[0] : PL_PALETTE[5];
    const p = end ?? PL_FALLBACK;
    const flank = new THREE.Group();
    flank.rotation.y = (s * Math.PI) / 2;

    for (const wy of [1.9, PL_S1 + 2.1, PL_S2 + 2.1]) {
      for (const wz of [-2.8, 0.6]) {
        sash(flank, p, -s * wz, wy, 3 * PL_BAY, 1, 1.9, 1);
      }
    }

    g.add(flank);
  }

  return g;
};

const BAY_DECK_Y = 13;
const BAY_TOWER_H = 21;
const BAY_HALF_W = 3;
const BAY_CABLE_Z = 4.2;
const BAY_APPROACH = -62;
const BAY_ABUTMENT_CLEAR = 4.6;
const BAY_RAMP_TOP = -14;
const BAY_ANCHOR_W = 8;
const BAY_TOWER_1 = 65;
const BAY_TOWER_2 = 225;
const BAY_ANCHOR_MID = 312;
const BAY_TOWER_3 = 400;
const BAY_TOWER_4 = 560;
const BAY_YERBA = 675;
const BAY_EAST_END = 760;
const BAY_ANCHOR_TOP = BAY_DECK_Y + 11;

const BAY_CABLE_SADDLES: readonly (readonly [number, number, number])[] = [
  [BAY_ANCHOR_W + 4, BAY_ANCHOR_TOP - 1, 1.5],
  [BAY_TOWER_1, BAY_DECK_Y + BAY_TOWER_H, BAY_TOWER_H - 1.6],
  [BAY_TOWER_2, BAY_DECK_Y + BAY_TOWER_H, 2.5],
  [BAY_ANCHOR_MID, BAY_DECK_Y + 13, 2.5],
  [BAY_TOWER_3, BAY_DECK_Y + BAY_TOWER_H, BAY_TOWER_H - 1.6],
  [BAY_TOWER_4, BAY_DECK_Y + BAY_TOWER_H, 2],
  [BAY_YERBA - 10, BAY_ANCHOR_TOP - 1, 0],
];

const BAY_HEADROOM = 9;

const bayClears = (ctx: LandmarkCtx, x: number, soffit: number) => {
  for (const lz of [-BAY_HALF_W, 0, BAY_HALF_W]) {
    if (!ctx.onAsphalt(x, lz, 1.5)) {
      continue;
    }

    if (soffit - ctx.groundAt(x, lz) < BAY_HEADROOM) {
      return false;
    }
  }

  return true;
};

const bayDeck = (
  g: THREE.Group,
  ctx: LandmarkCtx,
  x0: number,
  x1: number,
  y: number,
  lamps: THREE.Vector3[],
) => {
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  g.add(box(len, 1.1, BAY_HALF_W * 2, MAT.steel, cx, y - 0.55, 0));

  for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
    g.add(box(len, 0.9, 0.35, MAT.steel, cx, y + 0.45, sz));
  }

  const bays = Math.max(1, Math.round(len / 6));
  const bayLen = len / bays;

  for (let i = 0; i < bays; i += 1) {
    const bx = x0 + bayLen * (i + 0.5);

    if (bayClears(ctx, bx, y - 4.7)) {
      g.add(box(bayLen, 1, BAY_HALF_W * 2 - 0.6, MAT.steel, bx, y - 4.2, 0));

      for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
        g.add(box(bayLen, 3.4, 0.5, MAT.steel, bx, y - 2.4, sz));
      }

      continue;
    }

    for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
      g.add(box(bayLen, 1.1, 0.5, MAT.steel, bx, y - 0.55, sz));
    }
  }

  const step = 15;
  const n = Math.max(1, Math.round(len / step));

  for (let i = 0; i < n; i += 1) {
    const x = x0 + (len * (i + 0.5)) / n;

    for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
      g.add(box(0.55, 0.55, 0.55, MAT.lamp, x, y + 1.5, sz));
      g.add(box(0.16, 1.4, 0.16, MAT.steel, x, y + 0.9, sz));
      lamps.push(new THREE.Vector3(x, y + 1.5, sz));
    }
  }
};

const bayTower = (g: THREE.Group, x: number) => {
  const top = BAY_DECK_Y + BAY_TOWER_H;

  for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
    g.add(box(2.6, top + 8, 2.6, MAT.steel, x, (top - 8) / 2, sz));
  }

  for (const by of [BAY_DECK_Y - 6, BAY_DECK_Y + 6, BAY_DECK_Y + 14, top - 1.5]) {
    g.add(box(2, 1.4, BAY_CABLE_Z * 2 + 2.6, MAT.steel, x, by, 0));
  }
};

const bayCablePoints = (z: number) => {
  const pts: THREE.Vector3[] = [];

  for (let i = 0; i < BAY_CABLE_SADDLES.length - 1; i += 1) {
    const a = BAY_CABLE_SADDLES[i];
    const b = BAY_CABLE_SADDLES[i + 1];

    if (!a || !b) {
      continue;
    }

    const [ax, ay, sag] = a;
    const [bx, by] = b;
    const steps = Math.max(2, Math.round((bx - ax) / 8));

    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      pts.push(
        new THREE.Vector3(ax + (bx - ax) * t, ay + (by - ay) * t - 4 * sag * t * (1 - t), z),
      );
    }
  }

  const last = BAY_CABLE_SADDLES.at(-1);

  if (last) {
    pts.push(new THREE.Vector3(last[0], last[1], z));
  }

  return pts;
};

const bayApproach = (g: THREE.Group, ctx: LandmarkCtx) => {
  const D = BAY_DECK_Y;
  const x1 = BAY_RAMP_TOP;
  const soffit = D - 1.1;

  const abutment = (x: number) => {
    const gy = ctx.groundAt(x - 3, 0);
    const h = Math.max(2.4, soffit - gy + 2.4);
    g.add(
      seatMasonry({
        batter: 0.05,
        d: BAY_HALF_W * 2 + 4,
        h,
        seed: x,
        w: 9,
        x: x - 3.5,
        y: soffit - h,
        z: 0,
      }),
    );
  };

  let x0 = x1;

  for (let px = x1; px >= BAY_APPROACH; px -= 2) {
    let ground = -Infinity;

    for (const lz of [-BAY_HALF_W, 0, BAY_HALF_W]) {
      ground = Math.max(ground, ctx.groundAt(px, lz));
    }

    if (soffit - ground < BAY_ABUTMENT_CLEAR) {
      break;
    }

    x0 = px;
  }

  if (x1 - x0 < 10) {
    abutment(x1);

    return;
  }

  const slabLen = x1 - x0;
  g.add(box(slabLen, 1.1, BAY_HALF_W * 2, MAT.steel, (x0 + x1) / 2, soffit + 0.55, 0));

  for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
    g.add(box(slabLen, 0.9, 0.35, MAT.steel, (x0 + x1) / 2, D + 0.45, sz));
  }

  abutment(x0);

  for (let px = x0 + 7; px < BAY_ANCHOR_W - 12; px += 9) {
    const pz = [0, -8, 8].find((z) => !ctx.onAsphalt(px, z, 1.6));

    if (pz === undefined) {
      continue;
    }

    const gy = ctx.groundAt(px, pz);
    const h = soffit - gy;

    if (h < 2) {
      continue;
    }

    g.add(box(5, h, 5, MAT.concrete, px, gy + h / 2, pz));
    g.add(box(7, 1.1, BAY_HALF_W * 2 + 2, MAT.concrete, px, soffit + 0.55, pz * 0.35));
  }
};

const bayBridge = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const D = BAY_DECK_Y;
  const lamps: THREE.Vector3[] = [];

  const PORTAL_Y = D;
  const PORTAL_H = BAY_ANCHOR_TOP - PORTAL_Y;
  g.add(
    seatMasonry({
      batter: 0.04,
      d: 26,
      h: PORTAL_H,
      seed: 11,
      w: 26,
      x: BAY_ANCHOR_W,
      y: PORTAL_Y,
      z: 0,
    }),
  );
  g.add(
    seatMasonry({
      d: 20,
      h: 4,
      seed: 23,
      w: 20,
      x: BAY_ANCHOR_W,
      y: BAY_ANCHOR_TOP - 1,
      z: 0,
    }),
  );

  for (let fx = -7; fx <= 7; fx += 7) {
    for (let fz = -7; fz <= 7; fz += 7) {
      const px = BAY_ANCHOR_W + fx;

      if (ctx.onAsphalt(px, fz, 8)) {
        continue;
      }

      const gy = ctx.groundAt(px, fz);

      if (gy >= PORTAL_Y - 1) {
        continue;
      }

      g.add(box(6, PORTAL_Y - gy, 6, MAT.concrete, px, (gy + PORTAL_Y) / 2, fz));
    }
  }

  for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
    g.add(box(7, 4, 4, MAT.steel, BAY_ANCHOR_W + 11, BAY_ANCHOR_TOP + 1, sz));
  }

  bayApproach(g, ctx);
  bayDeck(g, ctx, BAY_RAMP_TOP, BAY_ANCHOR_W, D, lamps);

  bayDeck(g, ctx, BAY_ANCHOR_W, BAY_YERBA, D, lamps);

  for (const tx of [BAY_TOWER_1, BAY_TOWER_2, BAY_TOWER_3, BAY_TOWER_4]) {
    bayTower(g, tx);
  }

  {
    const tiers = [
      { d: 28, top: D - 6, w: 24 },
      { d: 25, top: D + 4, w: 21 },
      { d: 22, top: D + 15, w: 18 },
    ] as const;

    let base = D - 12;

    for (const t of tiers) {
      g.add(
        seatMasonry({
          d: t.d + 0.9,
          h: t.top - base,
          seed: t.w,
          w: t.w + 0.9,
          x: BAY_ANCHOR_MID,
          y: base,
          z: 0,
        }),
      );
      base = t.top;
    }
  }

  for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
    const curve = new THREE.CatmullRomCurve3(bayCablePoints(sz));
    g.add(mesh(new THREE.TubeGeometry(curve, 96, 0.5, 4), MAT.steel));

    for (let i = 1; i < 56; i += 1) {
      const p = curve.getPoint(i / 56);
      const h = p.y - (D + 1);

      if (h < 1.5) {
        continue;
      }

      g.add(box(0.22, h, 0.22, MAT.steel, p.x, D + 1 + h / 2, p.z));
    }
  }

  const rock = cyl(16, 26, 22, 12, MAT.rock, BAY_YERBA, 1, 0);
  rock.scale.set(1.5, 1, 1);
  g.add(rock);
  g.add(box(20, 12, 16, MAT.rock, BAY_YERBA, 12, 0));
  g.add(box(6, 9, BAY_HALF_W * 2 + 2, MAT.concrete, BAY_YERBA, D + 1.5, 0));
  bayDeck(g, ctx, BAY_YERBA, BAY_EAST_END, D, lamps);

  const beacons: Beacon[] = [];

  for (const p of lamps) {
    const [wx, wy, wz] = ctx.worldPoint(p.x, p.y, p.z);
    beacons.push({ color: 0xff_d9_a0, groundY: wy - 1.5, size: 2.2, x: wx, y: wy, z: wz });
  }

  for (const tx of [BAY_TOWER_1, BAY_TOWER_2, BAY_TOWER_3, BAY_TOWER_4]) {
    for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
      const [wx, wy, wz] = ctx.worldPoint(tx, D + BAY_TOWER_H + 5.5, sz);
      beacons.push({ blinkS: 2.6, color: 0xff_44_36, size: 3.4, x: wx, y: wy, z: wz });
    }
  }

  registerBeacons("baybridge", beacons);

  return g;
};

const alcatraz = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const cliff = cyl(17, 25, 17, 14, MAT.rock, 0, 1.5, 0);
  cliff.scale.set(2.2, 1, 1);
  g.add(cliff);
  const plateau = cyl(15, 18, 4, 14, MAT.rock, -2, 11, 0);
  plateau.scale.set(2.1, 1, 1);
  g.add(plateau);

  for (const [ox, oz, s] of [
    [-44, 3, 8],
    [42, -4, 7],
    [16, 9, 5],
  ] as const) {
    const r = mesh(new THREE.IcosahedronGeometry(s, 0), MAT.rock, ox, 6, oz);
    r.scale.set(1.4, 0.7, 1);
    r.rotation.y = ox;
    g.add(r);
  }

  g.add(box(46, 11, 15, MAT.cream, -3, 18.5, 0));
  g.add(box(48, 1.4, 17, MAT.slate, -3, 24.7, 0));
  g.add(box(9, 7, 9, MAT.cream, -3, 27, 0));
  g.add(box(9, 1.2, 10, MAT.slate, -3, 30.8, 0));

  for (let i = 0; i < 11; i += 1) {
    g.add(box(2.2, 5, 0.5, MAT.slate, -22 + i * 3.9, 18.5, 7.6));
  }

  const tankY = 26;

  for (const sx of [-3, 3]) {
    for (const sz of [-3, 3]) {
      g.add(
        strut(
          new THREE.Vector3(-36 + sx * 1.6, 13, sz * 1.6),
          new THREE.Vector3(-36 + sx, tankY, sz),
          0.32,
          MAT.steel,
          5,
        ),
      );
    }
  }

  g.add(cyl(4, 4, 7, 10, MAT.steel, -36, tankY + 3.5, 0));
  g.add(mesh(new THREE.ConeGeometry(4.3, 2.6, 10), MAT.steel, -36, tankY + 8.3, 0));

  g.add(cyl(1.5, 2.1, 17, 10, MAT.white, 26, 21.5, 2));
  g.add(cyl(2.6, 2.6, 0.6, 10, MAT.white, 26, 30.3, 2));
  g.add(cyl(2, 2, 3.2, 8, MAT.lamp, 26, 32.2, 2));
  g.add(mesh(new THREE.ConeGeometry(2.3, 1.8, 8), MAT.slate, 26, 34.7, 2));

  g.add(box(11, 6, 8, MAT.cream, 30, 14, -8));
  g.add(box(12, 1, 9, MAT.slate, 30, 17.3, -8));

  for (const lz of [-13, -3]) {
    g.add(cyl(0.2, 0.26, 5, 6, MAT.steel, 36, 13.5, lz));
    g.add(box(0.7, 0.7, 0.7, MAT.lamp, 36, 16.3, lz));
    beaconAt(ctx, 36, 16.3, lz, 0xff_d9_a0, 3.4);
  }

  beaconAt(ctx, 26, 32.2, 2, 0xff_f4_d6, 9, 3.4);
  beaconAt(ctx, -3, 25.4, 0, 0xbf_d0_e0, 7);

  return g;
};

const cityHall = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 19, 13);
  g.add(box(40, 1.4 - foot, 26, MAT.rock, 0, (0.6 + foot) / 2, 0));
  g.add(box(34, 12, 20, MAT.cream, 0, 6, 0));
  g.add(box(9, 15, 22, MAT.cream, -14, 7.5, 0));
  g.add(box(9, 15, 22, MAT.cream, 14, 7.5, 0));
  g.add(box(36, 1.3, 22, MAT.slate, 0, 15.2, 0));

  for (let i = 0; i < 13; i += 1) {
    const wx = -15 + i * 2.5;

    for (const sy of [4.4, 8.4, 12.2]) {
      g.add(box(1.5, 2.4, 0.5, MAT.slate, wx, sy, 10.1));
      g.add(box(1.5, 2.4, 0.5, MAT.slate, wx, sy, -10.1));
    }

    if (i % 2 === 0) {
      g.add(box(0.6, 12, 0.7, MAT.cream, wx + 1.25, 6.6, 10.2));
    }
  }

  for (let i = 0; i < 7; i += 1) {
    const wz = -9 + i * 3;

    for (const sy of [4.4, 8.4, 12.2]) {
      g.add(box(0.5, 2.4, 1.6, MAT.slate, -18.6, sy, wz));
      g.add(box(0.5, 2.4, 1.6, MAT.slate, 18.6, sy, wz));
    }
  }

  g.add(box(21, 1.6, 5, MAT.rock, 0, 0.8, 12.4));

  for (let i = 0; i < 8; i += 1) {
    g.add(cyl(0.75, 0.85, 9.4, 8, MAT.cream, -7.7 + i * 2.2, 6.3, 12.6));
  }

  g.add(box(19, 1.8, 3.4, MAT.cream, 0, 11.9, 12.6));
  g.add(box(16, 1.6, 3, MAT.cream, 0, 13.5, 12.6));
  g.add(box(8, 1.2, 2.6, MAT.cream, 0, 14.8, 12.6));

  g.add(cyl(6, 6.4, 7, 20, MAT.cream, 0, 19, 0));
  arc(20, 6.6, 0, 360, (x, z) => {
    g.add(cyl(0.36, 0.4, 6, 5, MAT.cream, x, 19, z));
  });
  g.add(cyl(7, 7, 1.2, 20, MAT.cream, 0, 23, 0));

  g.add(dome(6.6, 9, MAT.patina, 0, 23.6, 0, 20));
  g.add(mesh(new THREE.TorusGeometry(6.8, 0.3, 4, 22), MAT.gold, 0, 23.8, 0).rotateX(Math.PI / 2));

  for (let i = 0; i < 6; i += 1) {
    const rib = mesh(new THREE.TorusGeometry(6.95, 0.26, 4, 14, Math.PI), MAT.gold, 0, 23.6, 0);
    rib.scale.set(1, 9 / 6.6, 1);
    rib.rotation.y = (i * Math.PI) / 6;
    g.add(rib);
  }

  g.add(cyl(1.7, 2, 3.6, 10, MAT.cream, 0, 34.4, 0));
  g.add(dome(1.8, 1.6, MAT.gold, 0, 36.2, 0, 10));
  g.add(cyl(0.12, 0.12, 3, 6, MAT.gold, 0, 39, 0));

  arc(6, 8, 0, 360, (x, z) => {
    g.add(box(0.7, 0.4, 0.7, MAT.lamp, x, 24.2, z));
    beaconAt(ctx, x, 25.4, z, 0xff_e9_bc, 7);
  });
  beaconAt(ctx, 0, 37, 0, 0xff_f0_cc, 5, 4.5);

  for (const sx of [-13, 13]) {
    beaconAt(ctx, sx, 16, 11, 0xff_dd_a8, 6);
  }

  return g;
};

const fitPalaceLagoon = (ctx: LandmarkCtx) => {
  for (const scale of [1, 0.85, 0.7, 0.55, 0.4, 0.3]) {
    for (const x of [2, -10, 14, -20, 20]) {
      for (const z of [20, 14, 26, 0, -14, -20]) {
        let clear = true;

        for (const radius of [0, 0.5, 1]) {
          for (let i = 0; i < 48; i += 1) {
            const angle = (i * Math.PI * 2) / 48;
            const px = x + Math.cos(angle) * 22.5 * scale * radius;
            const pz = z + Math.sin(angle) * 10.8 * scale * radius;

            if (ctx.onAsphalt(px, pz, 1.1) || Math.hypot(px, pz) < 9) {
              clear = false;
            }
          }
        }

        if (clear) {
          return { scale, x, z };
        }
      }
    }
  }

  return null;
};

const palaceOfFineArts = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 26, 26);
  g.add(cyl(10, 10.6, 2.4 - foot, 16, MAT.rock, 0, (1.2 + foot) / 2, 0));
  arc(8, 7.4, 0, 360, (x, z) => {
    g.add(cyl(1, 1.15, 12, 8, MAT.cream, x, 7.4, z));
    g.add(box(2.4, 1, 2.4, MAT.cream, x, 13.6, z));
  });
  g.add(mesh(new THREE.TorusGeometry(7.6, 1.1, 4, 22), MAT.cream, 0, 14.6, 0).rotateX(Math.PI / 2));
  g.add(dome(7.4, 6.4, MAT.cream, 0, 15.2, 0, 18));
  g.add(cyl(1.1, 1.4, 2.4, 8, MAT.cream, 0, 22.6, 0));

  const lagoon = fitPalaceLagoon(ctx);

  if (lagoon) {
    const lagY = lowestUnder(ctx, 22.5 * lagoon.scale, 10.8 * lagoon.scale, lagoon.x, lagoon.z);
    const rim = cyl(15, 15, 1.2, 28, MAT.rock, lagoon.x, lagY + 0.1, lagoon.z);
    rim.scale.set(1.5 * lagoon.scale, 1, 0.72 * lagoon.scale);
    g.add(rim);
    const water = cyl(13.4, 13.4, 1.2, 28, MAT.lagoon, lagoon.x, lagY + 0.34, lagoon.z);
    water.scale.set(1.5 * lagoon.scale, 1, 0.72 * lagoon.scale);
    g.add(water);
    ctx.addWaterBody({
      halfX: 13.4 * 1.5 * lagoon.scale,
      halfZ: 13.4 * 0.72 * lagoon.scale,
      kind: "ellipse",
      x: lagoon.x,
      y: lagY + 0.94,
      yaw: 0,
      z: lagoon.z,
    });

    for (let i = 0; i < 48; i += 1) {
      const a = (i / 48) * Math.PI * 2;
      const b = ((i + 1) / 48) * Math.PI * 2;
      const ax = lagoon.x + Math.cos(a) * 22.05 * lagoon.scale;
      const az = lagoon.z + Math.sin(a) * 10.584 * lagoon.scale;
      const bx = lagoon.x + Math.cos(b) * 22.05 * lagoon.scale;
      const bz = lagoon.z + Math.sin(b) * 10.584 * lagoon.scale;
      const x = (ax + bx) / 2;
      const z = (az + bz) / 2;
      const length = Math.hypot(bx - ax, bz - az) + 0.3;
      const yaw = Math.atan2(-(bz - az), bx - ax);
      g.add(box(length, 2, 0.65, MAT.rock, x, lagY + 1.5, z, yaw));
      ctx.addWaterWall({
        maxX: x + length / 2,
        maxY: lagY + 2.5,
        maxZ: z + 0.325,
        minX: x - length / 2,
        minY: lagY + 0.5,
        minZ: z - 0.325,
        yaw,
      });
    }
  }

  for (const deg0 of [46, 226]) {
    arc(9, 26, deg0, 88, (x, z, yaw) => {
      if (ctx.onAsphalt(x, z, 2.2)) {
        return;
      }

      g.add(cyl(0.85, 1, 8.6, 8, MAT.cream, x, 4.3, z));
      g.add(box(2.6, 1.1, 2.6, MAT.cream, x, 9.2, z, yaw));
      g.add(box(5.4, 0.9, 1.4, MAT.cream, x, 10.1, z, yaw));
    });
  }

  arc(6, 11, 0, 360, (x, z) => {
    g.add(box(0.6, 0.35, 0.6, MAT.lamp, x, 1.4, z));
    beaconAt(ctx, x, 2.4, z, 0xff_dc_a6, 8);
  });
  beaconAt(ctx, 0, 18, 0, 0xff_e6_c0, 6);

  return g;
};

const twinPeaks = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const R = 13;
  const top = ctx.groundAt(0, 0) + 0.5;
  g.add(cyl(R, R + 1.4, 12, 24, MAT.concrete, 0, top - 6, 0));
  g.add(cyl(R - 0.6, R - 0.6, 0.5, 24, MAT.cream, 0, top + 0.2, 0));
  g.add(cyl(4.6, 4.6, 0.56, 24, MAT.brick, 0, top + 0.26, 0));
  g.add(cyl(1.5, 1.5, 0.62, 16, MAT.gold, 0, top + 0.3, 0));

  for (let i = 0; i < 4; i += 1) {
    g.add(box(0.5, 0.62, 8.6, MAT.cream, 0, top + 0.28, 0, (i * Math.PI) / 4));
  }

  arc(20, R - 0.5, 215, 290, (x, z, yaw) => {
    g.add(box(4.4, 1.1, 0.8, MAT.rock, x, top + 0.75, z, yaw));
  });

  for (const sx of [-4.5, 0, 4.5]) {
    g.add(cyl(0.22, 0.3, 1.5, 6, MAT.steel, sx, top + 0.75, -(R - 2.6)));
    g.add(box(0.5, 0.5, 1.1, MAT.steel, sx, top + 1.6, -(R - 2.6)));
  }

  for (const sx of [-1, 1] as const) {
    const a = THREE.MathUtils.degToRad(215 + (sx > 0 ? 290 : 0));
    const px = Math.sin(a) * (R - 1.6);
    const pz = -Math.cos(a) * (R - 1.6);
    g.add(cyl(0.16, 0.22, 5, 6, MAT.steel, px, top + 2.5, pz));
    g.add(box(0.6, 0.6, 0.6, MAT.lamp, px, top + 5.2, pz));
    beaconAt(ctx, px, top + 5.2, pz, 0xff_d9_a0, 3.6);
  }

  arc(6, R - 0.2, 150, 60, (x, z, yaw) => {
    g.add(cyl(0.1, 0.12, 1.1, 5, MAT.steel, x, top + 0.75, z));
    g.add(box(2.6, 0.12, 0.12, MAT.steel, x, top + 1.25, z, yaw));
  });
  g.add(box(2.6, 1.3, 0.7, MAT.rock, 0, top + 0.85, R - 3.4));

  return g;
};

const deYoung = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 20, 12);
  g.add(box(38, 1.2 - foot, 22, MAT.rock, 0, (0.4 + foot) / 2, 0));
  g.add(box(34, 8, 18, MAT.copper, 0, 4, 0));
  g.add(box(16, 6, 12, MAT.copper, -22, 3, 5));
  g.add(box(36, 0.7, 20, MAT.slate, 0, 8.3, 0));
  g.add(box(20, 4, 1, MAT.glass, 0, 4.6, 9.3));

  for (const sy of [1.9, 4, 6.1]) {
    for (const sz of [-9.1, 9.1]) {
      g.add(box(34.2, 0.34, 0.5, MAT.slate, 0, sy, sz));
    }

    for (const sx of [-17.1, 17.1]) {
      g.add(box(0.5, 0.34, 18.2, MAT.slate, sx, sy, 0));
    }
  }

  for (let i = 0; i < 11; i += 1) {
    const wx = -15 + i * 3;
    g.add(box(1.5, 1.3, 0.5, MAT.glass, wx, 5.2, 9.15));
    g.add(box(1.5, 1.3, 0.5, MAT.glass, wx, 5.2, -9.15));
  }

  for (const sx of [-14, 0, 14]) {
    beaconAt(ctx, sx, 2.2, 11.5, 0xff_dc_a6, 5.4);
  }

  beaconAt(ctx, 21.4, 31.5, -3, 0xd9_e4_ee, 6);
  g.add(box(9.4, 8, 9.4, MAT.copper, 20, 4, -1));
  const floors = 8;

  for (let i = 0; i < floors; i += 1) {
    const t = i / (floors - 1);
    g.add(
      box(
        9.2 - t * 1.4,
        2.6,
        9.2 - t * 1.4,
        MAT.copper,
        20 + t * 1.4,
        9.3 + i * 2.5,
        -1 - t * 2,
        t * 0.5,
      ),
    );
  }

  g.add(box(9, 2.4, 9, MAT.glass, 21.4, 30.6, -3, 0.5));
  g.add(box(9.6, 0.7, 9.6, MAT.slate, 21.4, 32, -3, 0.5));

  return g;
};

const conservatory = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 16, 7);
  g.add(box(32, 1.2 - foot, 15, MAT.concrete, 0, (0.6 + foot) / 2, 0));
  const VAULT_Y = 4;

  for (const sx of [-10.5, 10.5]) {
    g.add(box(9.2, 2.8, 7, MAT.white, sx, 2.6, 0));

    const vault = mesh(
      new THREE.CylinderGeometry(3.5, 3.5, 9, 12, 1, false, 0, Math.PI),
      MAT.glass,
      sx,
      VAULT_Y,
      0,
    );

    vault.rotation.z = Math.PI / 2;
    g.add(vault);

    for (let i = 0; i < 4; i += 1) {
      const rib = mesh(
        new THREE.TorusGeometry(3.62, 0.14, 4, 10, Math.PI),
        MAT.white,
        sx - 3.6 + i * 2.4,
        VAULT_Y,
        0,
      );

      rib.rotation.y = Math.PI / 2;
      g.add(rib);
    }
  }

  g.add(cyl(5, 5.4, 5, 14, MAT.white, 0, 3.7, 0));
  g.add(dome(5.2, 6.4, MAT.glass, 0, 6.2, 0, 16));

  for (let i = 0; i < 5; i += 1) {
    const rib = mesh(new THREE.TorusGeometry(5.32, 0.15, 4, 12, Math.PI), MAT.white, 0, 6.2, 0);
    rib.scale.set(1, 6.4 / 5.2, 1);
    rib.rotation.y = (i * Math.PI) / 5;
    g.add(rib);
  }

  g.add(cyl(1.2, 1.5, 2.6, 8, MAT.white, 0, 13.6, 0));
  g.add(mesh(new THREE.ConeGeometry(1.6, 2.2, 8), MAT.white, 0, 16, 0));
  g.add(box(6, 4.4, 3, MAT.white, 0, 3.4, 7.4));
  beaconAt(ctx, 0, 7, 0, 0xd8_f0_e0, 9);

  for (const sx of [-10.5, 10.5]) {
    beaconAt(ctx, sx, 4, 0, 0xd8_f0_e0, 6);
  }

  return g;
};

const windmill = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const H = 14;
  const SAIL = 15;
  const foot = lowestUnder(ctx, 6, 6);
  g.add(cyl(3.6, 5.8, H - foot, 14, MAT.rock, 0, (H + foot) / 2, 0));
  g.add(dome(4.2, 3.6, MAT.slate, 0, H, 0, 14));
  g.add(cyl(0.5, 0.5, 4.4, 8, MAT.slate, 0, H + 2.4, 2.6).rotateX(Math.PI / 2));
  const hubY = H + 2.4;

  for (let i = 0; i < 4; i += 1) {
    const a = (i * Math.PI) / 2 + 0.35;
    const px = Math.sin(a) * (SAIL / 2);
    const py = hubY + Math.cos(a) * (SAIL / 2);
    const spine = box(0.6, SAIL, 0.6, MAT.slate, px, py, 4.6);
    spine.rotation.z = -a;
    g.add(spine);
    const canvas = box(2.4, SAIL - 1.6, 0.3, MAT.white, px, py, 4.9);
    canvas.rotation.z = -a;
    g.add(canvas);

    for (const t of [-0.3, 0, 0.3]) {
      const bar = box(2.8, 0.4, 0.4, MAT.slate, 0, 0, 5.1);
      bar.position.x = Math.sin(a) * (SAIL / 2 + t * SAIL);
      bar.position.y = hubY + Math.cos(a) * (SAIL / 2 + t * SAIL);
      bar.rotation.z = -a;
      g.add(bar);
    }
  }

  g.add(cyl(1.1, 1.1, 1.6, 8, MAT.slate, 0, hubY, 4.6).rotateX(Math.PI / 2));
  g.add(box(0.6, 0.6, 0.6, MAT.lamp, 0, H + 3.4, 0));
  beaconAt(ctx, 0, H + 3.4, 0, 0xff_dc_a6, 6, 5);
  beaconAt(ctx, 0, H * 0.5, 0, 0xff_d0_a0, 6);

  return g;
};

const cliffHouse = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const bluff = cyl(15, 23, 20, 12, MAT.rock, 0, -2.4, 0);
  bluff.scale.set(1.4, 1, 1);
  g.add(bluff);

  for (const [ox, oz, s] of [
    [-19, 8, 7],
    [17, -10, 6],
  ] as const) {
    const r = mesh(new THREE.IcosahedronGeometry(s, 0), MAT.rock, ox, 1, oz);
    r.scale.set(1.2, 0.8, 1);
    g.add(r);
  }

  g.add(box(17, 10, 12, MAT.white, 0, 12.6, 0));
  g.add(box(0.6, 7.6, 11, MAT.glass, -8.6, 12.6, 0));

  for (const sz of [-6.2, 6.2]) {
    for (const sy of [9.6, 13, 16.4]) {
      g.add(box(14, 1.9, 0.4, MAT.glass, 0, sy, sz));
    }
  }

  g.add(box(18, 0.8, 13, MAT.slate, 0, 18, 0));
  g.add(box(6, 4, 6, MAT.white, 5, 19.8, 0));
  g.add(cyl(0.5, 0.5, 3, 6, MAT.steel, -6, 19.5, 4));
  g.add(box(0.5, 0.5, 0.5, MAT.lamp, -6, 21.2, 4));
  beaconAt(ctx, -6, 21.2, 4, 0xff_f0_cc, 6, 4);
  beaconAt(ctx, 0, 15, -6, 0xff_dc_a6, 6);

  const basins = [
    [-14, -30, 11, 8],
    [-1, -32, 9, 7],
    [10, -28, 8, 6],
    [-8, -42, 10, 6],
  ] as const;

  for (const [bx, bz, bw, bd] of basins) {
    const y = ctx.groundAt(bx, bz) + 0.9;
    g.add(box(bw, 1.8, 0.7, MAT.concrete, bx, y, bz - bd / 2));
    g.add(box(bw, 1.8, 0.7, MAT.concrete, bx, y, bz + bd / 2));
    g.add(box(0.7, 1.8, bd, MAT.concrete, bx - bw / 2, y, bz));
    g.add(box(0.7, 1.8, bd, MAT.concrete, bx + bw / 2, y, bz));

    for (const side of [-1, 1]) {
      ctx.addWaterWall({
        maxX: bx + bw / 2,
        maxY: y + 0.9,
        maxZ: bz + (side * bd) / 2 + 0.35,
        minX: bx - bw / 2,
        minY: y - 0.9,
        minZ: bz + (side * bd) / 2 - 0.35,
      });
      ctx.addWaterWall({
        maxX: bx + (side * bw) / 2 + 0.35,
        maxY: y + 0.9,
        maxZ: bz + bd / 2,
        minX: bx + (side * bw) / 2 - 0.35,
        minY: y - 0.9,
        minZ: bz - bd / 2,
      });
    }

    g.add(box(bw - 0.9, 1.2, bd - 0.9, MAT.lagoon, bx, y - 0.1, bz));
    ctx.addWaterBody({
      halfX: (bw - 0.9) / 2,
      halfZ: (bd - 0.9) / 2,
      kind: "rectangle",
      x: bx,
      y: y + 0.5,
      yaw: 0,
      z: bz,
    });
  }

  for (let i = 0; i < 6; i += 1) {
    const cx = -18 + i * 6.5;
    const cz = -22 - (i % 3) * 3;
    g.add(cyl(0.7, 0.85, 3 + (i % 3) * 1.6, 7, MAT.concrete, cx, ctx.groundAt(cx, cz) + 1.5, cz));
  }

  g.add(box(4, 1, 14, MAT.concrete, -6, ctx.groundAt(-6, -16) + 3, -16).rotateX(-0.32));

  return g;
};

const fortPoint = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 15, 14);
  g.add(box(30, 2.4 - foot, 28, MAT.rock, 0, (2.4 + foot) / 2 - 1.2, 0));
  const H = 11;
  const OUT = 13;
  const T = 4;
  g.add(box(OUT * 2, H, T, MAT.brick, 0, 2.4 + H / 2, -(OUT - T / 2)));
  g.add(box(OUT * 2, H, T, MAT.brick, 0, 2.4 + H / 2, OUT - T / 2));
  g.add(box(T, H, (OUT - T) * 2, MAT.brick, -(OUT - T / 2), 2.4 + H / 2, 0));
  g.add(box(T, H, (OUT - T) * 2, MAT.brick, OUT - T / 2, 2.4 + H / 2, 0));

  for (const tier of [5.4, 9.6]) {
    for (let i = 0; i < 7; i += 1) {
      const t = -OUT + 2.2 + i * ((OUT * 2 - 4.4) / 6);
      g.add(box(1.9, 2.6, 0.5, MAT.slate, t, tier, -(OUT - 0.2)));
      g.add(box(1.9, 2.6, 0.5, MAT.slate, t, tier, OUT - 0.2));
      g.add(box(0.5, 2.6, 1.9, MAT.slate, -(OUT - 0.2), tier, t));
      g.add(box(0.5, 2.6, 1.9, MAT.slate, OUT - 0.2, tier, t));
    }
  }

  for (const sz of [-1, 1] as const) {
    g.add(box(OUT * 2 + 1, 1.2, T + 1, MAT.brick, 0, 2.4 + H + 0.6, sz * (OUT - T / 2)));
    g.add(box(T + 1, 1.2, (OUT - T) * 2, MAT.brick, sz * (OUT - T / 2), 2.4 + H + 0.6, 0));
  }

  g.add(cyl(5, 5.4, H + 3, 8, MAT.brick, -OUT + 2, 2.4 + (H + 3) / 2, -OUT + 2));
  g.add(cyl(1.1, 1.4, 5, 8, MAT.white, OUT - 3, 2.4 + H + 3, -OUT + 3));
  g.add(cyl(1, 1, 1.4, 8, MAT.lamp, OUT - 3, 2.4 + H + 6.2, -OUT + 3));
  beaconAt(ctx, OUT - 3, 2.4 + H + 6.2, -OUT + 3, 0xff_f0_cc, 6, 3.8);

  return g;
};

const OP_PARCEL_A = 32.9;
const OP_PARCEL_B = 28.4;
const OP_BOWL_A = 26.5;
const OP_BOWL_B = 23.6;
const OP_OPEN_FROM = 55;
const OP_OPEN_TO = 155;
const OP_FIELD_X = 5;
const OP_FIELD_Z = -0.7;

const OP_SECTOR: readonly number[] = [
  4, 6.7, 6.6, 6.6, 0.6, 4.4, 4.4, 0.6, 0.2, -0.2, 4, 6.6, 2.2, 6.6, 6.6, 6.6, 6.6, 6.6, 6.6, 6.6,
  6.6, 4, 6.6, 6.6,
];

const OP_MASTS: readonly (readonly [number, number, number, number])[] = [
  [-7.8, -10.9, 9.7, 6],
  [-6.1, -12.6, 9.7, 6],
  [-4.1, -14.6, 9.7, 6],
  [-2.4, -16.3, 9.7, 6],
  [0.6, -18.5, 9.7, 6],
  [2.5, -19.9, 9.7, 6],
  [4.9, -21.6, 9.7, 6],
  [6.8, -22.9, 9.7, 6],
  [33.5, -6.5, 8.5, 8.6],
  [34.4, 5.7, 8.5, 8.6],
  [1.4, 22.9, 9.7, 6],
  [-0.5, 21.5, 9.7, 6],
  [-2.9, 19.8, 9.7, 6],
  [-5.3, 18.1, 9.7, 6],
  [-7.1, 16.7, 9.7, 6],
  [-18.7, 8.7, 3, 3.9],
];

const opBin = (i: number) => {
  const n = OP_SECTOR.length;
  const at = (k: number) => OP_SECTOR[((k % n) + n) % n] ?? 6.6;

  return at(i - 1) * 0.25 + at(i) * 0.5 + at(i + 1) * 0.25;
};

const opCeiling = (deg: number) => {
  const t = deg / 15;
  const i = Math.floor(t);

  return Math.max(4.4, THREE.MathUtils.lerp(opBin(i), opBin(i + 1), t - i));
};

const opRing = (
  count: number,
  a: number,
  b: number,
  deg0: number,
  sweep: number,
  place: (x: number, z: number, yaw: number, deg: number) => void,
) => {
  for (let i = 0; i < count; i += 1) {
    const deg = deg0 + (sweep * (i + 0.5)) / count;
    const r = THREE.MathUtils.degToRad(deg);
    const sn = Math.sin(r);
    const cs = Math.cos(r);
    place(sn * a, -cs * b, -Math.atan2(b * sn, a * cs), deg);
  }
};

const oraclePark = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, OP_PARCEL_A, OP_PARCEL_B);
  const apron = cyl(OP_PARCEL_A, OP_PARCEL_A + 1, 0.5 - foot, 28, MAT.concrete, 0, foot / 2, 0);
  apron.scale.set(1, 1, OP_PARCEL_B / OP_PARCEL_A);
  g.add(apron);
  const turf = cyl(19, 19, 0.6, 26, MAT.field, OP_FIELD_X, 0.3, OP_FIELD_Z);
  turf.scale.set(1, 1, 16.5 / 19);
  g.add(turf);
  g.add(cyl(6, 6, 0.7, 14, MAT.rock, -15.8, 0.4, 2.2));

  const closed = 360 - (OP_OPEN_TO - OP_OPEN_FROM);
  opRing(26, OP_BOWL_A * 0.88, OP_BOWL_B * 0.88, OP_OPEN_TO, closed, (x, z, yaw, deg) => {
    const h = opCeiling(deg);
    const deck = box(5.6, h, 9, MAT.concrete, x, h / 2 - 0.3, z, yaw);
    deck.rotation.order = "YXZ";
    deck.rotation.x = -0.34;
    g.add(deck);
  });
  opRing(26, OP_BOWL_A, OP_BOWL_B, OP_OPEN_TO, closed, (x, z, yaw, deg) => {
    const h = opCeiling(deg) + 1.4;
    g.add(box(6.2, h, 2, MAT.brick, x, h / 2, z, yaw));
  });
  opRing(11, OP_BOWL_A, OP_BOWL_B, OP_OPEN_FROM, OP_OPEN_TO - OP_OPEN_FROM, (x, z, yaw) => {
    g.add(box(6.2, 3.8, 1.8, MAT.brick, x, 1.9, z, yaw));
    g.add(box(6.2, 0.5, 2.8, MAT.concrete, x, 4, z, yaw));
  });
  {
    const r = THREE.MathUtils.degToRad((OP_OPEN_FROM + OP_OPEN_TO) / 2 + 180);
    const nx = Math.sin(r);
    const nz = -Math.cos(r);
    const sx = nx * (OP_BOWL_A + 1.5);
    const sz = nz * (OP_BOWL_B + 1.5);
    const yaw = -Math.atan2(OP_BOWL_B * Math.sin(r), OP_BOWL_A * Math.cos(r));
    g.add(box(16, 6.5, 1.4, MAT.slate, sx, 11, sz, yaw));
    g.add(box(14.5, 5, 0.4, MAT.lamp, sx - nx * 0.9, 11, sz - nz * 0.9, yaw));
  }

  const beacons: Beacon[] = [];

  for (const [mx, mz, top, mh] of OP_MASTS) {
    const fx = OP_FIELD_X - mx;
    const fz = OP_FIELD_Z - mz;
    const fl = Math.hypot(fx, fz) || 1;
    const dx = fx / fl;
    const dz = fz / fl;
    const yaw = Math.atan2(-dx, -dz);
    g.add(box(0.9, mh, 0.9, MAT.slate, mx, top - mh / 2, mz));
    g.add(box(4.4, 1.4, 0.8, MAT.slate, mx, top + 0.6, mz, yaw));
    g.add(box(4, 0.9, 0.3, MAT.lamp, mx + dx * 0.5, top + 0.6, mz + dz * 0.5, yaw));
    const [wx, wy, wz] = ctx.worldPoint(mx + dx * 0.5, top + 0.6, mz + dz * 0.5);
    beacons.push({ color: 0xff_f2_d2, size: 4.6, x: wx, y: wy, z: wz });
  }

  registerBeacons("oraclepark", beacons);

  return g;
};

const lombard = (ctx: LandmarkCtx) => {
  const g = new THREE.Group();
  const BEDS = 9;
  const RUN = 52;
  const [ox, oz] = ctx.origin;
  const hit = ctx.network?.nearest(ox, oz, ROAD_TILE * 2) ?? null;
  const tx = hit ? hit.tx : 1;
  const tz = hit ? hit.tz : 0;
  const off = (hit ? hit.edge.half : 5) + 3.2;
  const yaw = Math.atan2(-tz, tx);

  const at: (s: number, lat: number) => readonly [number, number] = (s, lat) => [
    tx * s - tz * lat,
    tz * s + tx * lat,
  ];

  for (let i = 0; i < BEDS; i += 1) {
    const s = -RUN / 2 + (RUN * (i + 0.5)) / BEDS;

    for (const side of [-1, 1] as const) {
      const [x, z] = at(s, off * side);

      if (ctx.onAsphalt(x, z, 0.8)) {
        continue;
      }

      const y = ctx.groundAt(x, z);
      g.add(box(5.4, 1.7, 4.4, MAT.brick, x, y + 0.85, z, yaw));
      g.add(box(4.8, 1.5, 3.8, MAT.hedge, x, y + 2.4, z, yaw));

      if (i % 2 === 0) {
        g.add(box(2.6, 0.35, 2, MAT.bloom, x, y + 3.15, z, yaw));
      }

      const [mx, mz] = at(s + RUN / BEDS / 2, off * side * 0.62);

      if (ctx.onAsphalt(mx, mz, 0.8)) {
        continue;
      }

      g.add(
        box(
          1.2,
          1.6,
          6.4,
          MAT.brick,
          mx,
          ctx.groundAt(mx, mz) + 0.8,
          mz,
          yaw + side * (i % 2 === 0 ? 0.7 : -0.7),
        ),
      );
    }
  }

  for (const end of [-1, 1] as const) {
    for (const side of [-1, 1] as const) {
      const [x, z] = at((end * RUN) / 2 + end * 3, off * side);

      if (ctx.onAsphalt(x, z, 0.8)) {
        continue;
      }

      g.add(box(2.6, 2.6, 8, MAT.brick, x, ctx.groundAt(x, z) + 1.3, z, yaw));
      g.add(cyl(0.14, 0.2, 4.4, 6, MAT.steel, x, ctx.groundAt(x, z) + 4.8, z));
      g.add(box(0.55, 0.55, 0.55, MAT.lamp, x, ctx.groundAt(x, z) + 7.2, z));
      beaconAt(ctx, x, ctx.groundAt(x, z) + 7.2, z, 0xff_d9_a0, 3.4);
    }
  }

  return g;
};

const DEFS = {
  alcatraz: { build: alcatraz, scale: 1, seat: "sea" },
  baybridge: { build: bayBridge, scale: 1, seat: "sea" },
  cityhall: { build: cityHall, scale: 1, seat: "ground" },
  cliffhouse: { build: cliffHouse, scale: 1, seat: "ground" },
  coittower: { build: coitTower, scale: KIT_SCALE, seat: "ground" },
  conservatory: { build: conservatory, scale: 1, seat: "ground" },
  deyoung: { build: deYoung, scale: 1, seat: "ground" },
  dragongate: { build: dragonGate, scale: KIT_SCALE, seat: "ground" },
  ferrybuilding: { build: ferryBuilding, scale: 1, seat: "ground" },
  fortpoint: { build: fortPoint, scale: 1, seat: "ground" },
  lombard: { build: lombard, scale: 1, seat: "ground" },
  oraclepark: { build: oraclePark, scale: 1, seat: "ground" },
  paintedladies: { build: paintedLadies, scale: 1, seat: "ground" },
  palace: { build: palaceOfFineArts, scale: 1, seat: "ground" },
  pyramid: { build: pyramid, scale: KIT_SCALE, seat: "ground" },
  salesforce: { build: salesforce, scale: KIT_SCALE, seat: "ground" },
  sutro: { build: sutroTower, scale: KIT_SCALE, seat: "ground" },
  twinpeaks: { build: twinPeaks, scale: 1, seat: "ground" },
  windmill: { build: windmill, scale: 1, seat: "ground" },
} as const satisfies Record<string, LandmarkDef>;

type LandmarkKind = keyof typeof DEFS;

interface Landmark {
  readonly kind: LandmarkKind;
  readonly name: string;
  readonly u: number;
  readonly v: number;
  readonly rotDeg: number;
  readonly clearR?: number;
  readonly protHalf?: readonly [number, number];
  readonly clearHalf?: readonly [number, number];
  readonly clearOffset?: readonly [number, number];
}

const LANDMARKS: readonly Landmark[] = [
  {
    clearHalf: [30, 32],
    clearOffset: [-20, 24],
    kind: "baybridge",
    name: "the Bay Bridge",
    protHalf: [20, 20],
    rotDeg: 49.5,
    u: 0.7954,
    v: 0.2127,
  },
  {
    clearR: 7.2,
    kind: "pyramid",
    name: "the Transamerica Pyramid",
    protHalf: [7.2, 7.2],
    rotDeg: 0,
    u: 0.701,
    v: 0.15,
  },
  {
    clearR: 6.9,
    kind: "salesforce",
    name: "Salesforce Tower",
    protHalf: [6.9, 6.9],
    rotDeg: 0,
    u: 0.7396,
    v: 0.2038,
  },
  {
    clearR: 6,
    kind: "coittower",
    name: "Coit Tower",
    protHalf: [6, 6],
    rotDeg: 0,
    u: 0.683,
    v: 0.082,
  },
  {
    kind: "ferrybuilding",
    name: "the Ferry Building",
    protHalf: [5.5, 23.5],
    rotDeg: 270,
    u: 0.756,
    v: 0.15,
  },
  {
    kind: "paintedladies",
    name: "the Painted Ladies",
    protHalf: [9, 26],
    rotDeg: 270,
    u: 0.513,
    v: 0.33,
  },
  {
    clearR: 6.5,
    kind: "sutro",
    name: "Sutro Tower",
    protHalf: [6.5, 6.5],
    rotDeg: 0,
    u: 0.402,
    v: 0.52,
  },
  { kind: "dragongate", name: "the Dragon Gate", rotDeg: 0, u: 0.6725, v: 0.228 },
  { kind: "alcatraz", name: "Alcatraz", rotDeg: 14, u: 0.62, v: 0.006 },
  {
    clearR: 12,
    kind: "cityhall",
    name: "City Hall",
    protHalf: [20, 13],
    rotDeg: 0,
    u: 0.62,
    v: 0.28,
  },
  {
    clearR: 11,
    kind: "palace",
    name: "the Palace of Fine Arts",
    protHalf: [30, 26],
    rotDeg: 200,
    u: 0.46,
    v: 0.06,
  },
  {
    clearR: 14,
    kind: "twinpeaks",
    name: "the Twin Peaks overlook",
    protHalf: [17, 17],
    rotDeg: 0,
    u: 0.412,
    v: 0.56,
  },
  {
    clearR: 12,
    kind: "deyoung",
    name: "the de Young Museum",
    protHalf: [28, 12],
    rotDeg: 0,
    u: 0.33,
    v: 0.414,
  },
  {
    clearR: 10,
    kind: "conservatory",
    name: "the Conservatory of Flowers",
    protHalf: [16, 9],
    rotDeg: 0,
    u: 0.368,
    v: 0.386,
  },
  {
    clearR: 7,
    kind: "windmill",
    name: "the Dutch Windmill",
    protHalf: [8, 8],
    rotDeg: 250,
    u: 0.055,
    v: 0.373,
  },
  {
    clearR: 7,
    kind: "windmill",
    name: "the Murphy Windmill",
    protHalf: [8, 8],
    rotDeg: 250,
    u: 0.055,
    v: 0.437,
  },
  {
    clearR: 12,
    kind: "cliffhouse",
    name: "the Cliff House",
    protHalf: [20, 34],
    rotDeg: 0,
    u: 0.049,
    v: 0.281,
  },
  {
    clearR: 14,
    kind: "fortpoint",
    name: "Fort Point",
    protHalf: [17, 16],
    rotDeg: 0,
    u: 0.335,
    v: 0.107,
  },
  {
    clearR: 31,
    kind: "oraclepark",
    name: "Oracle Park",
    protHalf: [33, 29],
    rotDeg: 0,
    u: 0.7838,
    v: 0.3115,
  },
  { kind: "lombard", name: "Lombard Street", rotDeg: 0, u: 0.602, v: 0.088 },
];

const uWorld = (u: number) => (u - 0.5) * WORLD_W;
const vWorld = (v: number) => (v - 0.5) * WORLD_H;

const resolvePosition: (lm: Landmark, network: RoadNetwork | null) => readonly [number, number] = (
  lm,
  network,
) => {
  let x = uWorld(lm.u);
  let z = vWorld(lm.v);
  const r = lm.clearR;

  if (!network || r === undefined) {
    return [x, z];
  }

  for (let i = 0; i < 4; i += 1) {
    const hit = network.nearest(x, z, r + ROAD_TILE * 1.6);

    if (!hit) {
      break;
    }

    const want = hit.edge.half + r + 0.6;

    if (hit.dist >= want) {
      break;
    }

    let nx = -hit.tz;
    let nz = hit.tx;

    if (nx * (x - hit.x) + nz * (z - hit.z) < 0) {
      nx = -nx;
      nz = -nz;
    }

    x = hit.x + nx * want;
    z = hit.z + nz * want;
  }

  return [x, z];
};

export interface LandmarkMarker {
  readonly name: string;
  readonly x: number;
  readonly z: number;
}

/**
 * Every landmark's display name at its RESOLVED world position (the same
 * street-avoidance pass the visuals use), so a caption/minimap layer and the
 * monument it labels can never disagree.
 */
export const landmarkMarkers: (network?: RoadNetwork | null) => readonly LandmarkMarker[] = (
  network = null,
) =>
  LANDMARKS.map((lm) => {
    const [x, z] = resolvePosition(lm, network);

    return { name: lm.name, x, z };
  });

/** Name of the landmark nearest (x, z) within `radius`, else null. */
export const landmarkNameAt = (
  x: number,
  z: number,
  radius: number,
  network: RoadNetwork | null = null,
) => {
  let best: string | null = null;
  let bestD = radius * radius;

  for (const m of landmarkMarkers(network)) {
    const d = (m.x - x) * (m.x - x) + (m.z - z) * (m.z - z);

    if (d > bestD) {
      continue;
    }

    bestD = d;
    best = m.name;
  }

  return best;
};

export interface LandmarkProtection {
  readonly reserved: ReadonlySet<string>;
  readonly parkGreen: ReadonlySet<string>;
  readonly solids: readonly Solid[];
}

const cellKey = (gx: number, gz: number) => `${gx},${gz}`;
const gxOf = (u: number) => Math.min(GRID_X - 1, Math.max(0, Math.floor(u * GRID_X)));
const gzOf = (v: number) => Math.min(GRID_Z - 1, Math.max(0, Math.floor(v * GRID_Z)));

export const landmarkProtection = (plan: CityPlan, network: RoadNetwork | null = null) => {
  const reserved = new Set<string>();
  const parkGreen = new Set<string>();
  const solids: Solid[] = [];

  const inRoadway = (minX: number, maxX: number, minZ: number, maxZ: number) => {
    if (!network) {
      return false;
    }

    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    for (const [px, pz] of [
      [cx, cz],
      [minX, minZ],
      [maxX, minZ],
      [minX, maxZ],
      [maxX, maxZ],
    ] as const) {
      const hit = network.nearest(px, pz, ROAD_TILE * 1.6);

      if (hit && hit.dist < hit.edge.half + 0.4) {
        return true;
      }
    }

    return false;
  };

  const protect = (x: number, z: number, halfX: number, halfZ: number, solid: boolean) => {
    const minX = x - halfX;
    const maxX = x + halfX;
    const minZ = z - halfZ;
    const maxZ = z + halfZ;
    const g0x = Math.max(0, Math.floor((minX + WORLD_HALF_X) / ROAD_TILE));
    const g1x = Math.min(GRID_X - 1, Math.floor((maxX + WORLD_HALF_X) / ROAD_TILE));
    const g0z = Math.max(0, Math.floor((minZ + WORLD_HALF_Z) / ROAD_TILE));
    const g1z = Math.min(GRID_Z - 1, Math.floor((maxZ + WORLD_HALF_Z) / ROAD_TILE));

    for (let gx = g0x; gx <= g1x; gx += 1) {
      for (let gz = g0z; gz <= g1z; gz += 1) {
        reserved.add(cellKey(gx, gz));

        if (!solid || plan.cells[gx]?.[gz] !== "lot") {
          continue;
        }

        const cMinX = gx * ROAD_TILE - WORLD_HALF_X;
        const cMinZ = gz * ROAD_TILE - WORLD_HALF_Z;
        const bx0 = Math.max(minX, cMinX);
        const bx1 = Math.min(maxX, cMinX + ROAD_TILE);
        const bz0 = Math.max(minZ, cMinZ);
        const bz1 = Math.min(maxZ, cMinZ + ROAD_TILE);

        if (inRoadway(bx0, bx1, bz0, bz1)) {
          continue;
        }

        solids.push({ maxX: bx1, maxZ: bz1, minX: bx0, minZ: bz0 });
      }
    }
  };

  reserved.add(cellKey(94, 107));

  for (const lm of LANDMARKS) {
    if (!lm.protHalf && !lm.clearHalf) {
      continue;
    }

    const [x, z] = resolvePosition(lm, network);

    if (lm.clearHalf) {
      const off = lm.clearOffset ?? [0, 0];
      protect(x + off[0], z + off[1], lm.clearHalf[0], lm.clearHalf[1], false);
    }

    if (lm.protHalf) {
      protect(x, z, lm.protHalf[0], lm.protHalf[1], true);
    }
  }

  {
    const gx = gxOf(0.513);
    const gz = gzOf(0.33);

    for (let dx = 1; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        parkGreen.add(cellKey(gx - dx, gz + dz));
      }
    }
  }

  return { parkGreen, reserved, solids };
};

export const buildLandmarks = (
  terrain: Terrain,
  cache: ModelCache,
  network: RoadNetwork | null = null,
  collectWaterWall?: (solid: Solid) => void,
  collectWaterBody?: (body: WaterBody) => void,
) => {
  const root = new THREE.Group();
  const rng = new Rng(4242);
  landmarkBeacons = [];

  for (const lm of LANDMARKS) {
    const def = DEFS[lm.kind];
    const [x, z] = resolvePosition(lm, network);
    const y = def.seat === "sea" ? 0 : terrain.heightAt(x, z);
    const rot = THREE.MathUtils.degToRad(lm.rotDeg);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const s = def.scale;

    const worldOf: (lx: number, lz: number) => readonly [number, number] = (lx, lz) => [
      x + s * (lx * cos + lz * sin),
      z + s * (-lx * sin + lz * cos),
    ];

    const ctx: LandmarkCtx = {
      addWaterBody: (body) => {
        const [wx, wz] = worldOf(body.x, body.z);
        collectWaterBody?.({
          ...body,
          halfX: body.halfX * s,
          halfZ: body.halfZ * s,
          x: wx,
          y: y + body.y * s,
          yaw: rot + body.yaw,
          z: wz,
        });
      },
      addWaterWall: (wall) => {
        const [wx, wz] = worldOf((wall.minX + wall.maxX) / 2, (wall.minZ + wall.maxZ) / 2);
        const hx = ((wall.maxX - wall.minX) * s) / 2;
        const hz = ((wall.maxZ - wall.minZ) * s) / 2;
        collectWaterWall?.({
          maxX: wx + hx,
          maxY: y + wall.maxY * s,
          maxZ: wz + hz,
          minX: wx - hx,
          minY: y + wall.minY * s,
          minZ: wz - hz,
          yaw: rot + (wall.yaw ?? 0),
        });
      },
      cache,
      groundAt: (lx, lz) => {
        const [wx, wz] = worldOf(lx, lz);

        return (terrain.heightAt(wx, wz) - y) / s;
      },
      network,
      onAsphalt: (lx, lz, margin) => {
        if (!network) {
          return false;
        }

        const [wx, wz] = worldOf(lx, lz);
        const hit = network.nearest(wx, wz, ROAD_TILE * 1.6);

        return hit !== null && hit.dist < hit.edge.half + margin;
      },
      origin: [x, z],
      rng,
      terrain,
      worldPoint: (lx, ly, lz) => {
        const [wx, wz] = worldOf(lx, lz);

        return [wx, y + ly * s, wz];
      },
    };

    const node = packLandmark(def.build(ctx), PL_MATS);
    node.position.set(x, y, z);
    node.rotation.y = rot;
    node.scale.multiplyScalar(s);
    root.add(node);
  }

  registerBeacons("landmarks", landmarkBeacons);

  return root;
};
