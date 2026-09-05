import { ModelCache } from "../src/assets/loader";
import { ROAD_TILE } from "../src/shared/constants";
import type { Solid } from "../src/shared/types";
import type { CityRestPayload } from "../src/world/city";
import { buildLandmarks } from "../src/world/landmarks";
import {
  planShoreline,
  SHORE_ACCESS_SITES,
  SHORE_COLORS,
  shoreBarrierVisuals,
  shorelineSupport,
  type ShoreBarrier,
  type ShoreVisualBox,
} from "../src/world/shoreline";
import { DriveSurface } from "../src/world/surface";
import { SolidIndex } from "../src/world/solid-index";
import type { NetEdge, NearestHit, RoadNetwork } from "../src/world/network";
import { roadIntrusions, solidObb, type AuditWorld, type PropInstance } from "./geometry-audit.mts";

type Check = (name: string, passed: boolean, detail?: string) => void;
type Expected = { readonly solid: Solid };
export type WaterBarrierMatches = {
  readonly solids: ReadonlySet<Solid>;
  readonly props: ReadonlySet<PropInstance>;
};
const key = (x: number, z: number): string => `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
const close = (a: number | undefined, b: number | undefined): boolean =>
  a !== undefined && b !== undefined && Math.abs(a - b) < 0.005;

function nearbyEntries<T extends Expected>(entries: readonly T[]): (x: number, z: number) => T[] {
  const buckets = new Map<string, T[]>();
  for (const entry of entries) {
    const s = entry.solid;
    const k = key((s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2);
    const list = buckets.get(k);
    if (list) list.push(entry);
    else buckets.set(k, [entry]);
  }
  return (x, z) => {
    const result: T[] = [];
    for (const dx of [-4, 0, 4])
      for (const dz of [-4, 0, 4]) result.push(...(buckets.get(key(x + dx, z + dz)) ?? []));
    return result;
  };
}

/** A fence models its collider's envelope, not an opaque solid infill. */
export function shoreVisualEnvelopeMatches(barrier: ShoreBarrier): boolean {
  const parts = shoreBarrierVisuals(barrier);
  const s = barrier.solid;
  const cx = (s.minX + s.maxX) / 2;
  const cz = (s.minZ + s.maxZ) / 2;
  const hx = (s.maxX - s.minX) / 2;
  const hz = (s.maxZ - s.minZ) / 2;
  const cos = Math.cos(s.yaw ?? 0);
  const sin = Math.sin(s.yaw ?? 0);
  let minY = Infinity;
  let maxY = -Infinity;
  let outerX = 0;
  let outerZ = 0;
  for (const part of parts) {
    const box = part.solid;
    const dx = (box.minX + box.maxX) / 2 - cx;
    const dz = (box.minZ + box.maxZ) / 2 - cz;
    if (
      Math.abs(Math.sin((box.yaw ?? 0) - (s.yaw ?? 0))) > 1e-8 ||
      Math.abs(dx * cos - dz * sin) + (box.maxX - box.minX) / 2 > hx + 1e-8 ||
      Math.abs(dx * sin + dz * cos) + (box.maxZ - box.minZ) / 2 > hz + 1e-8 ||
      box.minY < s.minY - 1e-8 ||
      box.maxY > s.maxY + 1e-8 ||
      (part.role === "curb" && box.maxY > barrier.groundTop + 0.12 + 1e-8)
    ) {
      return false;
    }
    minY = Math.min(minY, box.minY);
    maxY = Math.max(maxY, box.maxY);
    outerX = Math.max(outerX, Math.abs(dx * cos - dz * sin) + (box.maxX - box.minX) / 2);
    outerZ = Math.max(outerZ, Math.abs(dx * sin + dz * cos) + (box.maxZ - box.minZ) / 2);
  }
  const base = parts.find((part) => part.role === "wall" || part.role === "curb")?.solid;
  if (
    !base ||
    !close(base.minX, s.minX) ||
    !close(base.maxX, s.maxX) ||
    !close(outerX, hx) ||
    !close(outerZ, hz) ||
    !close(minY, s.minY) ||
    !close(maxY, s.maxY)
  ) {
    return false;
  }
  // Rails cover the contour span, without the footing's 0.4u end extensions.
  // Vertical openings stay smaller than the 0.6u rounded chassis thickness.
  let previousTop = base.maxY;
  for (const part of parts) {
    if (part.role !== "rail" && part.role !== "cap") continue;
    if (
      part.solid.minY - previousTop > 0.5 + 1e-8 ||
      (part.role === "cap" &&
        (!close(part.solid.minX, s.minX) || !close(part.solid.maxX, s.maxX))) ||
      (part.role === "rail" && (part.solid.minX > s.minX + 0.4 || part.solid.maxX < s.maxX - 0.4))
    ) {
      return false;
    }
    previousTop = part.solid.maxY;
  }
  return close(previousTop, s.maxY);
}

/** Trace the complete launch width through the authored collision plan. A
 * point-only check would miss a fence end intruding into the car's path. */
export function shoreAccessClear(barriers: readonly ShoreBarrier[]): boolean {
  const index = new SolidIndex(barriers.map(({ solid }) => solid));
  return SHORE_ACCESS_SITES.every((site) => {
    const dx = site.wet.x - site.dry.x;
    const dz = site.wet.z - site.dry.z;
    const length = Math.hypot(dx, dz);
    const steps = Math.ceil(length / 0.25);
    const half = Math.min(site.width / 2 - 1, 3);
    for (let i = 0; i <= steps; i++) {
      for (const side of [-half, 0, half]) {
        const x = site.dry.x + (dx * i) / steps - (dz * side) / length;
        const z = site.dry.z + (dz * i) / steps + (dx * side) / length;
        if (index.hitAt(x, z)) return false;
      }
    }
    return true;
  });
}

/** Every height step, corner and open terminal needs a post through each
 * terminating rail. Use actual generated boxes, including the neighboring
 * panel's shared post, rather than assuming endpoint metadata is sufficient. */
export function shoreRailJointsConnected(barriers: readonly ShoreBarrier[]): boolean {
  const posts = new SolidIndex(
    barriers
      .flatMap(shoreBarrierVisuals)
      .filter((part) => part.role === "post")
      .map((part) => part.solid),
  );
  return barriers.every((barrier) => {
    if (barrier.treatment.kind === "seawall") return true;
    const s = barrier.solid;
    const x = (s.minX + s.maxX) / 2;
    const z = (s.minZ + s.maxZ) / 2;
    const half = (s.maxX - s.minX - 0.8) / 2;
    const yaw = s.yaw ?? 0;
    const rails = shoreBarrierVisuals(barrier).filter((part) => part.role === "rail");
    return ([-1, 1] satisfies (-1 | 1)[]).every((sign) => {
      const joint = sign === -1 ? barrier.joints.start : barrier.joints.end;
      if (joint === "continuous") return true;
      return rails.every(({ solid }) =>
        posts.hitAt(
          x + Math.cos(yaw) * half * sign,
          z - Math.sin(yaw) * half * sign,
          (solid.minY + solid.maxY) / 2,
        ),
      );
    });
  });
}

/** Follow the actual polyline and connected arms. A tangent can leave a
 * curved coastal road, while clamping at an endpoint can invent a route.
 * Both directions need a supported continuation for a through-road to exist. */
export function hasSupportedRoadThrough(
  network: RoadNetwork,
  hit: NearestHit,
  supported: (x: number, z: number) => boolean,
  distance = 16,
): boolean {
  const walk = (
    edge: NetEdge,
    s: number,
    direction: -1 | 1,
    remaining: number,
    visited: ReadonlySet<number>,
  ): boolean => {
    const available = direction === 1 ? edge.len - s : s;
    const travel = Math.min(available, remaining);
    const steps = Math.max(1, Math.ceil(travel / 2));
    for (let i = 0; i <= steps; i++) {
      const point = network.sample(edge, s + (direction * travel * i) / steps);
      if (!supported(point.x, point.z)) return false;
    }
    if (remaining <= available + 1e-6) return true;
    const node = direction === 1 ? edge.b : edge.a;
    const seen = new Set(visited);
    seen.add(edge.id);
    return (network.nodeEdges[node] ?? []).some((id) => {
      if (seen.has(id)) return false;
      const next = network.edges.find((candidate) => candidate.id === id);
      if (!next) return false;
      const forward = next.a === node;
      return walk(next, forward ? 0 : next.len, forward ? 1 : -1, remaining - travel, seen);
    });
  };
  return (
    walk(hit.edge, hit.s, -1, distance, new Set()) && walk(hit.edge, hit.s, 1, distance, new Set())
  );
}

/** The legacy census measures fixed-scale props and building masses. These
 * objects are neither: a retaining wall's variable foundation intentionally
 * follows both ends of a bluff. Only EXACT regenerated, visibly paired walls
 * earn this separate classification. Unknown bounded solids remain audited. */
export function auditWaterBarriers(
  check: Check,
  rest: CityRestPayload,
  world: AuditWorld,
  props: readonly PropInstance[],
): WaterBarrierMatches {
  const drive = new DriveSurface(world.terrain, world.plan, () => world.network);
  drive.addDecks(rest.decks);
  const ctx = {
    landAt: (x: number, z: number) => world.terrain.landAt(x, z),
    standingAt: world.standAt,
    driveAt: (x: number, z: number) => drive.heightAt(x, z),
    onRoad: (x: number, z: number) => {
      const hit = world.network.nearest(x, z, ROAD_TILE * 1.4);
      return hit !== null && hit.dist < hit.edge.half + 1.3;
    },
    decks: rest.decks,
  };
  const shore = planShoreline(ctx);
  check(
    "stepped shoreline rails terminate in actual shared posts",
    shoreRailJointsConnected(shore),
  );
  check(
    "authored beach and lake launch corridors stay open across the car footprint",
    shoreAccessClear(shore),
  );
  check(
    "shoreline parapets and open railings match full collider envelopes without car-sized gaps",
    shore.every(shoreVisualEnvelopeMatches),
    `${shore.length} bounded visible barriers`,
  );
  const expected: Expected[] = shore.map(({ solid }) => ({ solid }));
  const visualBoxes = shore.flatMap(shoreBarrierVisuals);
  // These visuals are intentionally rebuilt from this same authored function
  // at runtime. Their collision bounds alone are stored in the rest artifact.
  buildLandmarks(world.terrain, new ModelCache(), world.network, (solid) =>
    expected.push({ solid }),
  );
  const near = nearbyEntries(expected);
  const nearVisual = nearbyEntries(visualBoxes);
  const same = (a: Solid, b: Solid): boolean =>
    close(a.minX, b.minX) &&
    close(a.maxX, b.maxX) &&
    close(a.minZ, b.minZ) &&
    close(a.maxZ, b.maxZ) &&
    close(a.minY, b.minY) &&
    close(a.maxY, b.maxY) &&
    close(a.yaw ?? 0, b.yaw ?? 0);
  const solids = new Set<Solid>(),
    sourceFound = new Set<Expected>(),
    visualFound = new Set<ShoreVisualBox>(),
    wallProps = new Set<PropInstance>();
  for (const solid of rest.solids) {
    if (solid.minY === undefined) continue;
    const match = near((solid.minX + solid.maxX) / 2, (solid.minZ + solid.maxZ) / 2).find(
      (entry) => !sourceFound.has(entry) && same(solid, entry.solid),
    );
    if (!match) continue;
    sourceFound.add(match);
    solids.add(solid);
  }
  let wrongColor = 0;
  let wrongShadowPolicy = 0;
  for (const [i, item] of rest.batchItems.entries()) {
    if (item.url !== null || item.raw === null) continue;
    const raw = rest.rawGeos[item.raw],
      prop = props[i];
    if (!raw || !prop || raw.position.length !== 72) continue;
    const match = nearVisual(prop.x, prop.z).find((entry) => {
      const s = entry.solid;
      return (
        !visualFound.has(entry) &&
        close(prop.x, (s.minX + s.maxX) / 2) &&
        close(prop.z, (s.minZ + s.maxZ) / 2) &&
        close(prop.y, (s.minY + s.maxY) / 2) &&
        close(prop.sx, s.maxX - s.minX) &&
        close(prop.sy, s.maxY - s.minY) &&
        close(prop.sz, s.maxZ - s.minZ) &&
        Math.abs(Math.sin(Math.atan2(-(item.m[2] ?? 0), item.m[0] ?? 0) - (s.yaw ?? 0))) < 0.001
      );
    });
    if (!match) continue;
    visualFound.add(match);
    wallProps.add(prop);
    if (raw.mat.color !== SHORE_COLORS[match.style]) wrongColor++;
    if (raw.mat.propShadow !== (match.style === "metal" ? "none" : "multi-draw"))
      wrongShadowPolicy++;
  }
  check(
    "baked water collider spans match every authoritative boundary",
    sourceFound.size === expected.length && solids.size === expected.length,
    `${sourceFound.size}/${expected.length} source walls`,
  );
  check(
    "every baked shoreline collider has its exact visible parapet and fence boxes",
    visualFound.size === visualBoxes.length && wallProps.size === visualBoxes.length,
    `${visualFound.size}/${visualBoxes.length} visible boxes across ${shore.length} walls`,
  );
  check(
    "baked water barriers retain their masonry timber bridge and metal colors",
    wrongColor === 0,
    `${wrongColor} wrong materials`,
  );
  check(
    "baked shoreline retains native-shadow and instancing policies",
    wrongShadowPolicy === 0,
    `${wrongShadowPolicy} shoreline boxes with wrong policy`,
  );
  const laneCaps = roadIntrusions(
    shore.map(({ solid }) => solidObb(solid)),
    world.network,
    0.5,
  );
  const blockedSafeRoads = laneCaps.filter((cap) => {
    const hit = world.network.nearest(cap.x, cap.z, ROAD_TILE * 1.4);
    if (!hit) return false;
    // An authored road line can continue into a creek/lake below sea level.
    // Its approach needs an end wall. A continuously supported through-road
    // must never be excused by this classification.
    return hasSupportedRoadThrough(world.network, hit, (x, z) => shorelineSupport(ctx, x, z));
  });
  check(
    "shore road caps only close approaches into unsupported water",
    blockedSafeRoads.length === 0,
    `${laneCaps.length} water-road caps, ${blockedSafeRoads.length} supported through-roads blocked`,
  );
  return { solids, props: wallProps };
}
