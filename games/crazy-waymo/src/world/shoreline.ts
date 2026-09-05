import * as THREE from "three";
import { disablePropShadows, setPropShadowPolicy } from "../render/prop-shadow";
import { WORLD_HALF_X, WORLD_HALF_Z, WORLD_H, WORLD_W } from "../shared/constants";
import type { Solid, SurfaceDeck } from "../shared/types";
import { GGP_LAKE } from "./land-class";
import { seawallShore } from "./sf-map";
import { surfaceDeckAt, surfaceDeckHeight } from "./surface-decks";

type Point = { readonly x: number; readonly z: number };
type Segment = { readonly a: Point; readonly b: Point };
type Bounds = {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
};
type ShoreTreatment =
  | { readonly kind: "seawall"; readonly material: "stone" | "concrete" }
  | { readonly kind: "park-fence"; readonly material: "timber" | "metal" }
  | { readonly kind: "deck-rail"; readonly material: "timber" | "orange" };
type RailJoint = "continuous" | "post" | "neighbor-post";
export const SHORE_COLORS = {
  stone: 0xb8a58a,
  concrete: 0x929ea4,
  timber: 0x896944,
  orange: 0xb94b2e,
  metal: 0x31434a,
};
export type ShoreBarrier = {
  readonly solid: Solid & { readonly minY: number; readonly maxY: number };
  readonly treatment: ShoreTreatment;
  readonly groundTop: number;
  readonly joints: { readonly start: RailJoint; readonly end: RailJoint };
};
export type ShoreAccessSite = {
  readonly id: "ocean-beach" | "stow-boat-launch";
  readonly region: string;
  readonly dry: Point;
  readonly wet: Point;
  readonly width: number;
  readonly opening: Bounds;
};
const LAKE_X = (GGP_LAKE.u - 0.5) * WORLD_W;
const LAKE_Z = (GGP_LAKE.v - 0.5) * WORLD_H;
const LAKE_WEST = LAKE_X - GGP_LAKE.ru;

/** Authored water access remains a real gap in the static collision plan.
 * Ocean Beach is broadly open; Stow has one readable west-bank launch. */
export const SHORE_ACCESS_SITES: readonly ShoreAccessSite[] = [
  {
    id: "ocean-beach",
    region: "Ocean Beach",
    dry: { x: -1438, z: 200 },
    wet: { x: -1470, z: 200 },
    width: WORLD_H * 0.52,
    opening: {
      minX: -WORLD_HALF_X,
      maxX: -WORLD_W * 0.415,
      minZ: -WORLD_H * 0.2,
      maxZ: WORLD_H * 0.32,
    },
  },
  {
    id: "stow-boat-launch",
    region: "Golden Gate Park",
    dry: { x: LAKE_WEST - 12, z: LAKE_Z },
    wet: { x: LAKE_WEST + 7, z: LAKE_Z },
    width: 8,
    opening: {
      minX: LAKE_WEST - 14,
      maxX: LAKE_WEST + 9,
      minZ: LAKE_Z - 4,
      maxZ: LAKE_Z + 4,
    },
  },
];
export type ShorelineContext = {
  readonly landAt: (x: number, z: number) => number;
  readonly standingAt: (x: number, z: number) => number;
  readonly driveAt: (x: number, z: number) => number;
  readonly onRoad: (x: number, z: number) => boolean;
  readonly decks: readonly SurfaceDeck[];
};

const WIDTH = 0.8;
const STEP = 4;
const DRY_LAND = 0.42;

/** A contour of supported driving space, including exact bridge/pier openings.
 * The lake cut uses the same ellipse as the water mesh and ground treatment.
 * Roads may extend the boundary only where their draped surface is above water. */
export function shorelineSupport(ctx: ShorelineContext, x: number, z: number): boolean {
  if (surfaceDeckAt(ctx.decks, x, z, WIDTH / 2)) return true;
  const lx = (x - (GGP_LAKE.u - 0.5) * WORLD_W) / (GGP_LAKE.ru + WIDTH / 2);
  const lz = (z - (GGP_LAKE.v - 0.5) * WORLD_H) / (GGP_LAKE.rv + WIDTH / 2);
  if (lx * lx + lz * lz < 1) return false;
  const land = ctx.landAt(x, z);
  // Rendered triangles interpolate the sharp shore drop more broadly than
  // the analytic mask. Keep the barrier on visible dry ground, not underwater.
  return (
    (land >= DRY_LAND && (land > 0.6 || ctx.standingAt(x, z) >= 0)) ||
    (land > 0.15 && ctx.onRoad(x, z) && ctx.driveAt(x, z) >= 0)
  );
}

/** Shared edge bisection and an asymptotic center decision keep ambiguous
 * marching squares connected. Short overlapping wall boxes seal every joint. */
export function contourSegments(
  supported: (x: number, z: number) => boolean,
  bounds: Bounds,
  step = STEP,
  features: readonly Bounds[] = [],
): Segment[] {
  const axis = (min: number, max: number, extra: readonly number[]): number[] => {
    const n = Math.ceil((max - min) / step);
    const points = new Set(Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n));
    for (const value of extra) if (value > min && value < max) points.add(value);
    const values = [...points];
    // ES2022 target; this newly allocated array is not shared with the caller.
    // oxlint-disable-next-line unicorn/no-array-sort
    return values.sort((a, b) => a - b);
  };
  // Align narrow deck corners and lake centers with the sample grid, so no
  // feature can vanish between four otherwise-identical corner samples.
  const xs = axis(
    bounds.minX,
    bounds.maxX,
    features.flatMap((f) => [f.minX, (f.minX + f.maxX) / 2, f.maxX]),
  );
  const zs = axis(
    bounds.minZ,
    bounds.maxZ,
    features.flatMap((f) => [f.minZ, (f.minZ + f.maxZ) / 2, f.maxZ]),
  );
  const row = (z: number): Uint8Array => Uint8Array.from(xs, (x) => Number(supported(x, z)));
  const crossing = (a: Point, b: Point, aLand: boolean): Point => {
    let lo = a,
      hi = b;
    for (let i = 0; i < 10; i++) {
      const mid = { x: (lo.x + hi.x) / 2, z: (lo.z + hi.z) / 2 };
      if (supported(mid.x, mid.z) === aLand) lo = mid;
      else hi = mid;
    }
    return { x: (lo.x + hi.x) / 2, z: (lo.z + hi.z) / 2 };
  };
  const segments: Segment[] = [];
  let previous = row(bounds.minZ);
  for (let iz = 0; iz + 1 < zs.length; iz++) {
    const az = zs[iz],
      bz = zs[iz + 1];
    if (az === undefined || bz === undefined) continue;
    const next = row(bz);
    for (let ix = 0; ix + 1 < xs.length; ix++) {
      const ax = xs[ix],
        bx = xs[ix + 1];
      if (ax === undefined || bx === undefined) continue;
      const flags = [
        previous[ix] === 1,
        previous[ix + 1] === 1,
        next[ix + 1] === 1,
        next[ix] === 1,
      ];
      if (flags.every(Boolean) || flags.every((flag) => !flag)) continue;
      const points = [
        { x: ax, z: az },
        { x: bx, z: az },
        { x: bx, z: bz },
        { x: ax, z: bz },
      ];
      const edges: Point[] = [];
      for (let i = 0; i < 4; i++) {
        const a = points[i],
          b = points[(i + 1) % 4],
          flag = flags[i];
        if (!a || !b || flag === undefined || flag === flags[(i + 1) % 4]) continue;
        edges.push(crossing(a, b, flag));
      }
      const [a, b, c, d] = edges;
      if (!a || !b) continue;
      if (c && d && supported((ax + bx) / 2, (az + bz) / 2) !== flags[0]) {
        segments.push({ a, b: d }, { a: b, b: c });
      } else {
        segments.push({ a, b });
        if (c && d) segments.push({ a: c, b: d });
      }
    }
    previous = next;
  }
  return segments;
}

export function planShoreline(
  ctx: ShorelineContext,
  bounds: Bounds = {
    minX: -WORLD_HALF_X,
    maxX: WORLD_HALF_X,
    minZ: -WORLD_HALF_Z,
    maxZ: WORLD_HALF_Z,
  },
): ShoreBarrier[] {
  const supported = (x: number, z: number): boolean => shorelineSupport(ctx, x, z);
  const lakeX = (GGP_LAKE.u - 0.5) * WORLD_W,
    lakeZ = (GGP_LAKE.v - 0.5) * WORLD_H;
  const features = ctx.decks.map((d) => ({
    minX: d.minX - WIDTH / 2,
    maxX: d.maxX + WIDTH / 2,
    minZ: d.minZ - WIDTH / 2,
    maxZ: d.maxZ + WIDTH / 2,
  }));
  features.push({
    minX: lakeX - GGP_LAKE.ru - WIDTH / 2,
    maxX: lakeX + GGP_LAKE.ru + WIDTH / 2,
    minZ: lakeZ - GGP_LAKE.rv - WIDTH / 2,
    maxZ: lakeZ + GGP_LAKE.rv + WIDTH / 2,
  });
  const segments = contourSegments(supported, bounds, STEP, features);
  const wallFor = ({ a, b }: Segment): ShoreBarrier[] => {
    const dx = b.x - a.x,
      dz = b.z - a.z,
      length = Math.hypot(dx, dz);
    if (length < 0.01) return [];
    const x = (a.x + b.x) / 2,
      z = (a.z + b.z) / 2;
    const nx = -dz / length,
      nz = dx / length;
    const deck = surfaceDeckAt(ctx.decks, x, z, WIDTH / 2 + 0.02);
    // Include the complete overlapping segment footprint, not only its centre.
    // A pier or bridge inside an access area still keeps its protective rails.
    if (
      !deck &&
      SHORE_ACCESS_SITES.some(
        ({ opening }) =>
          Math.min(a.x, b.x) - WIDTH < opening.maxX &&
          Math.max(a.x, b.x) + WIDTH > opening.minX &&
          Math.min(a.z, b.z) - WIDTH < opening.maxZ &&
          Math.max(a.z, b.z) + WIDTH > opening.minZ,
      )
    ) {
      return [];
    }
    const surface = (p: Point, side: number): number => {
      const px = p.x + (nx * WIDTH * side) / 2,
        pz = p.z + (nz * WIDTH * side) / 2;
      const localDeck = surfaceDeckAt(ctx.decks, px, pz, WIDTH / 2 + 0.03) ?? deck;
      return localDeck
        ? surfaceDeckHeight(localDeck, pz)
        : Math.max(ctx.standingAt(px, pz), ctx.driveAt(px, pz));
    };
    // Both footprint edges matter on a bluff or a terraced road. Inferring
    // one inward normal at a concave marching-square corner can pick water.
    const heights = [a, b, { x, z }].flatMap((p) => [surface(p, -1), surface(p, 1)]);
    if (Math.max(...heights) - Math.min(...heights) > 1.2 && length > 0.5) {
      const mid = { x, z };
      return [...wallFor({ a, b: mid }), ...wallFor({ a: mid, b })];
    }
    const minY = Math.min(...heights) - 0.6;
    const groundTop = Math.max(...heights);
    const u = x / WORLD_W + 0.5;
    const v = z / WORLD_H + 0.5;
    const lakeR = Math.hypot((x - LAKE_X) / GGP_LAKE.ru, (z - LAKE_Z) / GGP_LAKE.rv);
    const treatment: ShoreTreatment = deck
      ? { kind: "deck-rail", material: surfaceDeckHeight(deck, z) >= 3 ? "orange" : "timber" }
      : lakeR < 1.4
        ? { kind: "park-fence", material: x < LAKE_X ? "timber" : "metal" }
        : seawallShore(u, v)
          ? { kind: "seawall", material: "concrete" }
          : u < 0.16 && v < 0.3
            ? { kind: "seawall", material: "stone" }
            : { kind: "park-fence", material: u > 0.5 ? "metal" : "timber" };
    const maxY = groundTop + (treatment.kind === "park-fence" ? 1.4 : 2);
    return [
      {
        treatment,
        groundTop,
        joints: { start: "continuous", end: "continuous" },
        solid: {
          minX: x - (length + WIDTH) / 2,
          maxX: x + (length + WIDTH) / 2,
          minZ: z - WIDTH / 2,
          maxZ: z + WIDTH / 2,
          minY,
          maxY,
          yaw: Math.atan2(-dz, dx),
        },
      },
    ];
  };
  return connectRailPanels(segments.flatMap(wallFor));
}

/** One post owns a stepped/corner joint. Level contour subdivisions are not
 * panel ends, so they keep the regular spacing instead of becoming pickets. */
function connectRailPanels(barriers: readonly ShoreBarrier[]): ShoreBarrier[] {
  type End = { readonly index: number; readonly side: "start" | "end" };
  const ends = new Map<string, End[]>();
  const joints: { start: RailJoint; end: RailJoint }[] = barriers.map(() => ({
    start: "continuous",
    end: "continuous",
  }));
  for (const [index, barrier] of barriers.entries()) {
    const s = barrier.solid;
    const cx = (s.minX + s.maxX) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    const half = (s.maxX - s.minX - WIDTH) / 2;
    const yaw = s.yaw ?? 0;
    for (const [side, sign] of [
      ["start", -1],
      ["end", 1],
    ] satisfies ["start" | "end", number][]) {
      const x = cx + Math.cos(yaw) * half * sign;
      const z = cz - Math.sin(yaw) * half * sign;
      const key = `${Math.round(x * 1000)},${Math.round(z * 1000)}`;
      const group = ends.get(key);
      if (group) group.push({ index, side });
      else ends.set(key, [{ index, side }]);
    }
  }
  for (const group of ends.values()) {
    const rails = group.filter(({ index }) => barriers[index]?.treatment.kind !== "seawall");
    if (rails.length === 0) continue;
    const firstEnd = rails[0];
    const first = firstEnd ? barriers[firstEnd.index] : undefined;
    if (!first || !firstEnd) continue;
    const needsPost =
      group.length !== 2 ||
      rails.length !== 2 ||
      rails.some(({ index }) => {
        const other = barriers[index];
        if (!other) return false;
        const thickness = Math.min(
          first.treatment.material === "timber" ? 0.12 : 0.085,
          other.treatment.material === "timber" ? 0.12 : 0.085,
        );
        return (
          other.treatment.material !== first.treatment.material ||
          Math.abs(other.solid.maxY - first.solid.maxY) > thickness * 0.75 ||
          Math.abs(Math.sin((other.solid.yaw ?? 0) - (first.solid.yaw ?? 0))) > 0.12
        );
      });
    if (!needsPost) continue;
    let owner = firstEnd;
    for (const end of rails) {
      const a = barriers[end.index];
      const b = barriers[owner.index];
      if (a && b && a.solid.maxY > b.solid.maxY) owner = end;
    }
    for (const end of rails) {
      const joint = joints[end.index];
      if (joint) joint[end.side] = end === owner ? "post" : "neighbor-post";
    }
  }
  return barriers.map((barrier, i) => ({ ...barrier, joints: joints[i] ?? barrier.joints }));
}

export type ShoreVisualBox = {
  readonly solid: ShoreBarrier["solid"];
  readonly style: keyof typeof SHORE_COLORS;
  readonly role: "wall" | "cap" | "curb" | "rail" | "post";
};

/** Masonry gets an inset body and projecting cap. Park and deck edges are
 * open rail assemblies above a low footing, never a recoloured solid wall. */
export function shoreBarrierVisuals(barrier: ShoreBarrier): ShoreVisualBox[] {
  const { solid, treatment, groundTop } = barrier;
  const cx = (solid.minX + solid.maxX) / 2;
  const cz = (solid.minZ + solid.maxZ) / 2;
  if (treatment.kind === "seawall") {
    const capBottom = solid.maxY - 0.16;
    return [
      {
        style: treatment.material,
        role: "wall",
        solid: { ...solid, minZ: solid.minZ + 0.07, maxZ: solid.maxZ - 0.07, maxY: capBottom },
      },
      { style: treatment.material, role: "cap", solid: { ...solid, minY: capBottom } },
    ];
  }
  const baseTop = groundTop + 0.12;
  const parts: ShoreVisualBox[] = [
    {
      solid: { ...solid, maxY: baseTop },
      style: treatment.kind === "park-fence" ? "stone" : "concrete",
      role: "curb",
    },
  ];
  const extra = solid.maxY - baseTop;
  const timber = treatment.material === "timber";
  const railHeight = timber ? 0.12 : 0.085;
  // Rapier's rounded chassis is 0.6u at its thinnest; even a tilted taxi
  // should read as too large to pass through these 0.5u clear openings.
  const rows = Math.ceil(extra / (0.5 + railHeight));
  const rowHeight = extra / rows;
  const railHalfDepth = timber ? 0.08 : 0.055;
  for (let row = 1; row <= rows; row++) {
    const top = baseTop + rowHeight * row;
    parts.push({
      style: treatment.material,
      role: "rail",
      solid: {
        ...solid,
        // Collider/footing overlap seals corners; slender rails only need a
        // tiny joint overlap. Long ends otherwise form a zipper on grades.
        minX: solid.minX + WIDTH / 2 - 0.02,
        maxX: solid.maxX - WIDTH / 2 + 0.02,
        minZ: cz - railHalfDepth,
        maxZ: cz + railHalfDepth,
        minY: top - Math.min(railHeight, rowHeight),
        maxY: top,
      },
    });
  }

  // Contour subdivision gets very short on bluffs. World-aligned spacing
  // avoids a dense picket on every tiny segment while keeping a steady rhythm.
  const yaw = solid.yaw ?? 0;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const alongX = Math.abs(cos) >= Math.abs(sin);
  const center = alongX ? cx : cz;
  const slope = alongX ? cos : -sin;
  const half = Math.max(0, (solid.maxX - solid.minX - WIDTH) / 2);
  const begin = Math.ceil((center - Math.abs(slope) * half) / 3);
  const end = Math.floor((center + Math.abs(slope) * half) / 3);
  const post = (along: number, joint: boolean): void => {
    const x = cx + cos * along;
    const z = cz - sin * along;
    parts.push({
      style: treatment.material,
      role: "post",
      solid: {
        minX: x - (timber ? 0.11 : 0.065),
        maxX: x + (timber ? 0.11 : 0.065),
        minZ: z - (timber ? 0.11 : 0.08),
        maxZ: z + (timber ? 0.11 : 0.08),
        // The high panel's joint post reaches into its footing, connecting
        // both rail heights instead of leaving the lower panel unsupported.
        minY: joint ? solid.minY : baseTop,
        maxY: solid.maxY,
        yaw,
      },
    });
  };
  if (barrier.joints.start === "post") post(-half, true);
  if (barrier.joints.end === "post") post(half, true);
  for (let station = begin; station <= end; station++) {
    const along = (station * 3 - center) / slope;
    if (barrier.joints.start !== "continuous" && along + half < 0.45) continue;
    if (barrier.joints.end !== "continuous" && half - along < 0.45) continue;
    post(along, false);
  }
  return parts;
}

/** All constituent boxes share the collider's outer envelope. Geometry is
 * instanced through the existing city batches; fence openings stay visible. */
export function buildShoreline(barriers: readonly ShoreBarrier[]): THREE.Mesh[] {
  const materials = {
    stone: new THREE.MeshStandardMaterial({ color: SHORE_COLORS.stone, roughness: 0.97 }),
    concrete: new THREE.MeshStandardMaterial({ color: SHORE_COLORS.concrete, roughness: 0.9 }),
    timber: new THREE.MeshStandardMaterial({ color: SHORE_COLORS.timber, roughness: 0.92 }),
    orange: new THREE.MeshStandardMaterial({ color: SHORE_COLORS.orange, roughness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({
      color: SHORE_COLORS.metal,
      roughness: 0.76,
      metalness: 0.35,
    }),
  };
  disablePropShadows(materials.metal);
  // Per-piece fallback draws dwarf these small shadows on non-multidraw
  // drivers. Preserve native-driver shadows, otherwise use real instancing.
  for (const material of [materials.stone, materials.concrete, materials.timber, materials.orange])
    setPropShadowPolicy(material, "multi-draw");
  // Raw bake records own a material per geometry identity. Sharing one box
  // across styles would silently repaint every rebuilt wall as the first style.
  const geometries = {
    stone: new THREE.BoxGeometry(1, 1, 1),
    concrete: new THREE.BoxGeometry(1, 1, 1),
    timber: new THREE.BoxGeometry(1, 1, 1),
    orange: new THREE.BoxGeometry(1, 1, 1),
    metal: new THREE.BoxGeometry(1, 1, 1),
  };
  return barriers.flatMap(shoreBarrierVisuals).map(({ solid, style, role }) => {
    const mesh = new THREE.Mesh(geometries[style], materials[style]);
    mesh.name = `shore-barrier-${role}-${style}`;
    mesh.scale.set(solid.maxX - solid.minX, solid.maxY - solid.minY, solid.maxZ - solid.minZ);
    mesh.position.set(
      (solid.minX + solid.maxX) / 2,
      (solid.minY + solid.maxY) / 2,
      (solid.minZ + solid.maxZ) / 2,
    );
    mesh.rotation.y = solid.yaw ?? 0;
    mesh.castShadow = style !== "metal";
    mesh.receiveShadow = true;
    mesh.updateMatrixWorld(true);
    return mesh;
  });
}
