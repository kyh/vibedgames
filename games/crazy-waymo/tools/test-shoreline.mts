import { ColliderDesc, init, World } from "@dimforge/rapier3d-compat";
import { BatchedMesh, Matrix4, MeshStandardMaterial, Vector3 } from "three";
import { propShadowsDisabled } from "../src/render/prop-shadow";
import { staticSolidBox, staticSolidCollider } from "../src/physics/static-solid";
import type { Solid, SurfaceDeck } from "../src/shared/types";
import { RaycastVehicle } from "../src/vehicle/raycast-vehicle";
import { GGP_LAKE } from "../src/world/land-class";
import { WORLD_H, WORLD_W } from "../src/shared/constants";
import {
  buildShoreline,
  contourSegments,
  planShoreline,
  SHORE_ACCESS_SITES,
  shoreBarrierVisuals,
  shorelineSupport,
} from "../src/world/shoreline";
import type { ShorelineContext, ShoreBarrier } from "../src/world/shoreline";
import { surfaceDeckHeight, surfaceDeckPhysics } from "../src/world/surface-decks";
import { SolidIndex } from "../src/world/solid-index";
import { ModelCache } from "../src/assets/loader";
import { buildLandmarks } from "../src/world/landmarks";
import type { Terrain } from "../src/world/terrain";
import { RoadNetwork } from "../src/world/network";
import {
  hasSupportedRoadThrough,
  shoreAccessClear,
  shoreRailJointsConnected,
  shoreVisualEnvelopeMatches,
} from "./water-barrier-audit.mts";
import { materialFactory, matRecOf } from "../src/world/city";
import type { CityRestPayload } from "../src/world/city";
import { compatiblePropBatch, InstancedProps } from "../src/world/instanced-props";
import { packRest, serializeWorldBin } from "../src/world/world-bin-pack";
import { deserializeWorldBin, unpackRest, WORLD_REV } from "../src/world/world-bin";

type Check = (name: string, condition: boolean, detail?: string) => void;
const shoreContext: ShorelineContext = {
  decks: [],
  driveAt: () => 0,
  landAt: (x) => (x < 0 ? 1 : 0),
  onRoad: () => false,
  standingAt: () => 0,
};
const bounds = { maxX: 30, maxZ: 80, minX: -30, minZ: -80 };

const jointCount = (plans: readonly ShoreBarrier[]): number =>
  plans.reduce(
    (count, panel) =>
      count + Number(panel.joints.start === "post") + Number(panel.joints.end === "post"),
    0,
  );

type ShoreMesh = ReturnType<typeof buildShoreline>[number];
type ShoreGeometry = ShoreMesh["geometry"];
type MatRecord = NonNullable<ReturnType<typeof matRecOf>>;
type RestoreMaterial = ReturnType<typeof materialFactory>;
type BakedMaterial = ReturnType<RestoreMaterial>;
interface BatchItem {
  geo: ShoreGeometry;
  matrix: Matrix4;
}
interface BatchCounts {
  indexed: number;
  positions: number;
}
interface ShadowSource {
  mesh: ShoreMesh;
  style: string;
}
type UnpackedRest = Awaited<ReturnType<typeof unpackRest>>;

const FLAT_TRIANGLE = [-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0];

const makeBatch = (
  material: BakedMaterial,
  geometry: ShoreGeometry,
  items: readonly BatchItem[],
  counts: BatchCounts,
): BatchedMesh => {
  const batch = new BatchedMesh(4, counts.positions, counts.indexed, material);
  const geometryId = batch.addGeometry(geometry);
  for (const item of items) {
    batch.setMatrixAt(batch.addInstance(geometryId), item.matrix);
  }
  return batch;
};

const checkRoadCapAudit = (check: Check): void => {
  const bend = new RoadNetwork(
    [
      [-30, 0],
      [0, 20],
      [30, 20],
    ],
    [
      { a: 0, b: 1, p: [-30, 0, -10, 0, 0, 10, 0, 20], w: 2 },
      { a: 1, b: 2, p: [0, 20, 30, 20], w: 2 },
    ],
  );
  const roadSupport = (x: number, z: number): boolean =>
    (bend.nearest(x, z, 1)?.dist ?? Infinity) < 0.1;
  const curvedHit = bend.nearest(-6, 4, 1);
  const junctionHit = bend.nearest(0, 19, 1);
  if (!curvedHit || !junctionHit) {
    throw new Error("Missing curved road fixtures");
  }
  check(
    "road-cap audit follows supported curves rather than escaping along a tangent",
    hasSupportedRoadThrough(bend, curvedHit, roadSupport),
  );
  check(
    "road-cap audit follows connected arms past edge endpoints",
    hasSupportedRoadThrough(bend, junctionHit, roadSupport),
  );
  check(
    "road-cap audit detects unsupported continuation on the actual connected arm",
    !hasSupportedRoadThrough(bend, junctionHit, (x, z) => roadSupport(x, z) && x < 4),
  );
};

const checkContourTopology = (check: Check): void => {
  const saddle = contourSegments(
    (x, z) => x * z >= -0.1,
    { maxX: 1, maxZ: 1, minX: -1, minZ: -1 },
    2,
  );
  check(
    "ambiguous coast saddle preserves the supported center channel",
    saddle.length === 2 && saddle.every(({ a, b }) => ((a.x + b.x) / 2) * ((a.z + b.z) / 2) < 0),
  );
  const ring = contourSegments((x, z) => x * x + z * z <= 225, {
    maxX: 24,
    maxZ: 24,
    minX: -24,
    minZ: -24,
  });
  const ends = ring.flatMap(({ a, b }) => [a, b]);
  check(
    "shore contour has no open joints around an inland lake",
    ends.every((p) => ends.filter((q) => Math.hypot(p.x - q.x, p.z - q.z) < 0.01).length === 2),
  );
};

const checkBarrierMeshes = (
  check: Check,
  walls: readonly ShoreBarrier[],
  meshes: readonly ShoreMesh[],
  styled: readonly ShoreMesh[],
): void => {
  check(
    "bake geometry identity preserves five distinct shoreline materials",
    new Set(styled.map((mesh) => mesh.geometry)).size === 5 &&
      new Set(styled.map((mesh) => mesh.material)).size === 5,
  );
  const visualBoxes = walls.flatMap(shoreBarrierVisuals);
  check(
    "each shoreline assembly exactly matches its generated constituent boxes",
    meshes.length === visualBoxes.length &&
      meshes.every((mesh, i) => {
        const part = visualBoxes[i];
        if (!part) {
          return false;
        }
        const box = part.solid;
        const position = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
        return (
          position.distanceTo(
            new Vector3(
              (box.minX + box.maxX) / 2,
              (box.minY + box.maxY) / 2,
              (box.minZ + box.maxZ) / 2,
            ),
          ) < 1e-9 &&
          Math.abs(mesh.scale.x - (box.maxX - box.minX)) < 1e-9 &&
          Math.abs(mesh.scale.y - (box.maxY - box.minY)) < 1e-9 &&
          Math.abs(mesh.scale.z - (box.maxZ - box.minZ)) < 1e-9 &&
          Math.abs(mesh.rotation.y - (box.yaw ?? 0)) < 1e-9
        );
      }),
  );
};

const checkFenceFixtures = (check: Check, fenceFixtures: readonly ShoreBarrier[]): void => {
  check(
    "rotated seawalls and open railings match their collision envelopes with sub-car openings",
    fenceFixtures.every(shoreVisualEnvelopeMatches),
    `${fenceFixtures.length} form/width/yaw combinations`,
  );
  check(
    "park and deck barriers are mostly open above their low footings",
    fenceFixtures.every((wall) => {
      if (wall.treatment.kind === "seawall" || wall.solid.maxX - wall.solid.minX < 1) {
        return true;
      }
      const height = wall.solid.maxY - wall.groundTop - 0.12;
      const area = shoreBarrierVisuals(wall)
        .filter((part) => part.role === "rail" || part.role === "post")
        .reduce((sum, { solid }) => sum + (solid.maxX - solid.minX) * (solid.maxY - solid.minY), 0);
      return area / ((wall.solid.maxX - wall.solid.minX) * height) < 0.5;
    }),
  );
};

const checkRailJoints = (check: Check, walls: readonly ShoreBarrier[]): void => {
  const stepped = planShoreline(
    {
      ...shoreContext,
      driveAt: (_x, z) => (z > 0 ? 0.45 : 0),
      standingAt: (_x, z) => (z > 0 ? 0.45 : 0),
    },
    bounds,
  );
  const corner = planShoreline(
    { ...shoreContext, landAt: (x, z) => Number(x < 0 && z < 0) },
    bounds,
  );
  check(
    "straight level fences only add terminal posts, not a post at every contour subdivision",
    walls.length > 20 && jointCount(walls) === 2 && shoreRailJointsConnected(walls),
  );
  check(
    "stepped and corner rail ends connect to shared posts across every rail height",
    jointCount(stepped) > 2 &&
      jointCount(corner) > 2 &&
      shoreRailJointsConnected(stepped) &&
      shoreRailJointsConnected(corner),
  );
};

const checkShoreAccess = (check: Check): void => {
  const launchWalls = SHORE_ACCESS_SITES.flatMap((site) =>
    planShoreline(
      { ...shoreContext, landAt: (x) => (site.id === "ocean-beach" ? Number(x > -1454) : 1) },
      {
        maxX: site.dry.x + 65,
        maxZ: site.dry.z + 25,
        minX: site.wet.x - 35,
        minZ: site.dry.z - 25,
      },
    ),
  );
  check(
    "Ocean Beach and Stow launch remain open across the car footprint",
    shoreAccessClear(launchWalls),
  );
  const stow = SHORE_ACCESS_SITES.find((site) => site.id === "stow-boat-launch");
  if (!stow) {
    throw new Error("Missing Stow launch fixture");
  }
  const lakeWalls = planShoreline(
    { ...shoreContext, landAt: () => 1 },
    {
      maxX: stow.dry.x + 65,
      maxZ: stow.dry.z + 25,
      minX: stow.wet.x - 35,
      minZ: stow.dry.z - 25,
    },
  );
  check(
    "Stow launch gap preserves fences around the opposite shore",
    lakeWalls.length > 20 &&
      lakeWalls.some(({ solid }) =>
        new SolidIndex([solid]).hitAt((GGP_LAKE.u - 0.5) * WORLD_W + GGP_LAKE.ru + 0.4, stow.dry.z),
      ),
  );
  const lakeX = (GGP_LAKE.u - 0.5) * WORLD_W;
  const lakeZ = (GGP_LAKE.v - 0.5) * WORLD_H;
  check(
    "Stow Lake cuts actual dry-land support",
    !shorelineSupport({ ...shoreContext, landAt: () => 1 }, lakeX, lakeZ),
  );
};

const checkBridgeDecks = (check: Check): void => {
  const deck: SurfaceDeck = { maxX: 5, maxZ: 30, minX: -5, minZ: -30, y: 7 };
  const bridge = { ...shoreContext, decks: [deck], landAt: () => 0 };
  check(
    "bridge opening is exact footprint, not a whole water cell",
    shorelineSupport(bridge, 0, 0) && !shorelineSupport(bridge, 6, 0),
  );
  const narrow: SurfaceDeck = { maxX: 2.3, maxZ: 30.6, minX: 0.7, minZ: -30.6, y: 7 };
  const narrowWalls = planShoreline({ ...bridge, decks: [narrow] }, bounds);
  const narrowIndex = new SolidIndex(narrowWalls.map(({ solid }) => solid));
  const probes = Array.from({ length: 123 }, (_, i) => -30.5 + i * 0.5);
  check(
    "sub-grid deck keeps continuous walls along both complete edges",
    probes.every((z) => narrowIndex.hitAt(0.3, z, 7.5) && narrowIndex.hitAt(2.7, z, 7.5)) &&
      narrowIndex.hitAt(1.5, -31, 7.5) &&
      narrowIndex.hitAt(1.5, 31, 7.5),
  );
  const connected = planShoreline(
    { ...shoreContext, decks: [deck], landAt: (_x, z) => (z > 0 ? 1 : 0) },
    bounds,
  );
  const connectedIndex = new SolidIndex(connected.map(({ solid }) => solid));
  check(
    "supported bridge landfall stays open to driving",
    Array.from({ length: 41 }, (_, i) => -5 + i * 0.25).every(
      (z) => !connectedIndex.hitAt(0, z, 7.5),
    ),
  );
  check(
    "submerged road cannot open a water barrier",
    !shorelineSupport(
      { ...shoreContext, driveAt: () => -2, landAt: () => 0.2, onRoad: () => true },
      0,
      0,
    ),
  );
};

const checkElevatedRail = (check: Check, bounded: Solid): void => {
  const index = new SolidIndex([bounded]);
  check(
    "elevated rail clips camera only within its visible vertical span",
    !index.hitAt(5.4, 0, 2) && index.hitAt(5.4, 0, 7) && !index.hitAt(5.4, 0, 10),
  );
};

/** Captures the authored fence materials into `rest.rawGeos`, in bake order. */
const captureShadowFixtures = (
  rest: CityRestPayload,
  fenced: readonly ShoreMesh[],
  styled: readonly ShoreMesh[],
) => {
  const metal = fenced.find((mesh) => mesh.name.endsWith("-metal"));
  if (!metal || !(metal.material instanceof MeshStandardMaterial)) {
    throw new Error("Missing fence metal");
  }
  const record = matRecOf(metal.material);
  if (!record) {
    throw new Error("Uncaptured fence metal");
  }
  rest.rawGeos.push({
    index: null,
    mat: record,
    normal: null,
    position: new Float32Array(FLAT_TRIANGLE),
    uv: null,
  });
  const shadowStyles = ["stone", "concrete", "timber", "orange"];
  const shadowSources = shadowStyles.map((style) => {
    const mesh = styled.find((candidate) => candidate.name.endsWith(`-${style}`));
    if (!mesh || !(mesh.material instanceof MeshStandardMaterial)) {
      throw new Error(`Missing authored ${style} material`);
    }
    const mat = matRecOf(mesh.material);
    if (!mat) {
      throw new Error(`Uncaptured ${style} material`);
    }
    rest.rawGeos.push({
      index: null,
      mat,
      normal: null,
      position: new Float32Array(FLAT_TRIANGLE),
      uv: null,
    });
    return { mesh, style };
  });
  return { metal, record, shadowSources };
};

const checkShadowRestore = (
  check: Check,
  fixtures: {
    counts: BatchCounts;
    geometry: ShoreGeometry;
    items: readonly BatchItem[];
    record: MatRecord;
    restore: RestoreMaterial;
    restoredRecord: MatRecord;
  },
) => {
  const restoredMetal = fixtures.restore(fixtures.restoredRecord);
  const automatic = fixtures.restore({ ...fixtures.restoredRecord, propShadow: undefined });
  check(
    "fence shadow policy survives actual material capture and baked restoration",
    fixtures.record.propShadow === "none" &&
      propShadowsDisabled(restoredMetal, false) &&
      !propShadowsDisabled(automatic, false) &&
      restoredMetal !== automatic,
  );
  const batch = makeBatch(restoredMetal, fixtures.geometry, fixtures.items, fixtures.counts);
  batch.castShadow = !propShadowsDisabled(restoredMetal, false);
  const compatible = compatiblePropBatch(batch, fixtures.items, false);
  check(
    "explicit fence policy keeps tall props eligible for the no-multidraw fallback",
    compatible instanceof InstancedProps && compatible.children.every((mesh) => !mesh.castShadow),
  );
  compatible.dispose();
  return { automatic, restoredMetal };
};

const checkStyleShadows = (
  check: Check,
  fixtures: {
    counts: BatchCounts;
    geometry: ShoreGeometry;
    items: readonly BatchItem[];
    restore: RestoreMaterial;
    shadowSources: readonly ShadowSource[];
    unpacked: UnpackedRest;
  },
): void => {
  for (const [slot, source] of fixtures.shadowSources.entries()) {
    const restored = fixtures.unpacked.rawGeos[slot + 1]?.mat;
    if (!restored) {
      throw new Error(`Missing restored ${source.style} material`);
    }
    const material = fixtures.restore(restored);
    check(
      `${source.style} shadow policy survives baking independently of driver capabilities`,
      restored.propShadow === "multi-draw" &&
        propShadowsDisabled(source.mesh.material, false) &&
        !propShadowsDisabled(source.mesh.material, true) &&
        propShadowsDisabled(material, false) &&
        !propShadowsDisabled(material, true),
    );
    for (const multiDraw of [false, true]) {
      const sourceBatch = makeBatch(material, fixtures.geometry, fixtures.items, fixtures.counts);
      sourceBatch.castShadow = !propShadowsDisabled(material, multiDraw);
      const result = compatiblePropBatch(sourceBatch, fixtures.items, multiDraw);
      check(
        `${source.style} ${multiDraw ? "keeps native shadows" : "uses one instanced fallback draw"}`,
        multiDraw
          ? result === sourceBatch && result.castShadow
          : result instanceof InstancedProps &&
              result.children.length === 1 &&
              result.children.every((mesh) => !mesh.castShadow),
      );
      result.dispose();
    }
    material.dispose();
  }
};

const checkSolidRoundTrip = async (
  check: Check,
  fixtures: {
    legacy: Solid;
    packed: ReturnType<typeof packRest>;
    rest: CityRestPayload;
    unpacked: UnpackedRest;
  },
): Promise<void> => {
  const { packed, unpacked } = fixtures;
  check(
    "baked explicit wall heights survive serialization",
    unpacked.solids[0]?.minY !== undefined &&
      Math.abs(unpacked.solids[0].minY - 6.4) < 1e-5 &&
      unpacked.solids[0].maxY === 9 &&
      unpacked.solids[1]?.minY === undefined,
  );
  const legacyPacked = packRest({ ...fixtures.rest, solids: [fixtures.legacy] });
  delete legacyPacked.solids.minY;
  const legacyRest = await unpackRest(legacyPacked);
  const [old] = legacyRest.solids;
  check(
    "legacy solids need no new minimum-height column",
    old !== undefined && staticSolidBox(old, () => 0).y === 0.5,
  );
  let rejected = false;
  delete packed.solids.minY;
  try {
    await unpackRest(packed);
  } catch {
    rejected = true;
  }
  check("malformed explicit wall bounds fail at decode", rejected);
};

const checkBakeRoundTrip = async (
  check: Check,
  fixtures: {
    bounded: Solid;
    fenced: readonly ShoreMesh[];
    legacy: Solid;
    styled: readonly ShoreMesh[];
  },
): Promise<void> => {
  const rest: CityRestPayload = {
    batchItems: [],
    decks: [],
    lampHeads: [],
    mergedChunks: [],
    parkedCars: [],
    rawGeos: [],
    solids: [fixtures.bounded, fixtures.legacy],
  };
  const { metal, record, shadowSources } = captureShadowFixtures(
    rest,
    fixtures.fenced,
    fixtures.styled,
  );
  const packed = packRest(rest);
  const decoded = deserializeWorldBin(serializeWorldBin({ rest: packed, rev: WORLD_REV }).buffer);
  if (!decoded.rest) {
    throw new Error("Missing shoreline round trip");
  }
  const unpacked = await unpackRest(decoded.rest);
  const restoredRecord = unpacked.rawGeos[0]?.mat;
  if (!restoredRecord) {
    throw new Error("Missing round-trip metal record");
  }
  const restore = materialFactory();
  const { geometry } = metal;
  const counts: BatchCounts = {
    indexed: geometry.index?.count ?? 0,
    positions: geometry.getAttribute("position").count,
  };
  const items = Array.from({ length: 4 }, (_, i) => ({
    geo: geometry,
    matrix: new Matrix4().makeScale(1, 20 + i, 1),
  }));
  const { automatic, restoredMetal } = checkShadowRestore(check, {
    counts,
    geometry,
    items,
    record,
    restore,
    restoredRecord,
  });
  checkStyleShadows(check, { counts, geometry, items, restore, shadowSources, unpacked });
  restoredMetal.dispose();
  automatic.dispose();
  await checkSolidRoundTrip(check, { legacy: fixtures.legacy, packed, rest, unpacked });
};

export const checkShoreline = async (check: Check): Promise<void> => {
  checkRoadCapAudit(check);
  checkContourTopology(check);
  const walls = planShoreline(shoreContext, bounds);
  const meshes = buildShoreline(walls);
  const [first] = walls;
  if (!first) {
    throw new Error("Missing shoreline fixture");
  }
  const treatments = [
    { kind: "seawall", material: "stone" },
    { kind: "seawall", material: "concrete" },
    { kind: "park-fence", material: "timber" },
    { kind: "park-fence", material: "metal" },
    { kind: "deck-rail", material: "orange" },
  ] satisfies ShoreBarrier["treatment"][];
  const styled = buildShoreline(treatments.map((treatment) => ({ ...first, treatment })));
  checkBarrierMeshes(check, walls, meshes, styled);
  const fenceFixtures: ShoreBarrier[] = [];
  for (const yaw of [-1.25, -0.78, 0, 0.92]) {
    for (const width of [0.82, 1.3, 5.7]) {
      for (const treatment of treatments) {
        fenceFixtures.push({
          groundTop: 2,
          joints: { end: "continuous", start: "continuous" },
          solid: {
            maxX: 7 + width / 2,
            maxY: treatment.kind === "park-fence" ? 3.4 : 4,
            maxZ: -2.6,
            minX: 7 - width / 2,
            minY: 0.5,
            minZ: -3.4,
            yaw,
          },
          treatment,
        });
      }
    }
  }
  const fenced = buildShoreline(fenceFixtures);
  checkFenceFixtures(check, fenceFixtures);
  checkRailJoints(check, walls);
  checkShoreAccess(check);
  checkBridgeDecks(check);
  const bounded: Solid = { maxX: 5.8, maxY: 9, maxZ: 20, minX: 5, minY: 6.4, minZ: -20 };
  checkElevatedRail(check, bounded);
  const legacy: Solid = { maxX: 2, maxY: 3, maxZ: 2, minX: -2, minZ: -2 };
  await checkBakeRoundTrip(check, { bounded, fenced, legacy, styled });
  const allMeshes = [...meshes, ...styled, ...fenced];
  for (const geo of new Set(allMeshes.map((mesh) => mesh.geometry))) {
    geo.dispose();
  }
  const materials = new Set(
    allMeshes.flatMap((mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material])),
  );
  for (const material of materials) {
    material.dispose();
  }
};

export const checkShorelinePhysics = async (check: Check): Promise<void> => {
  await init();
  for (const diagonal of [false, true]) {
    const world = new World({ x: 0, y: -30, z: 0 });
    world.timestep = 1 / 60;
    world.createCollider(ColliderDesc.cuboid(30, 0.3, 90).setTranslation(-30, -0.3, 0));
    for (const { solid } of planShoreline(shoreContext, bounds)) {
      world.createCollider(staticSolidCollider(staticSolidBox(solid, () => -5)));
    }
    const vehicle = new RaycastVehicle({ raw: () => world }, -15, 1.1, -20, Math.PI / 2);
    vehicle.setControls({ boost: false, brake: 0, steer: 0, throttle: 0 }, false);
    for (let i = 0; i < 60; i += 1) {
      vehicle.fixedStep(1 / 60);
      world.step();
    }
    vehicle.chassis.setLinvel({ x: diagonal ? 95 : 120, y: 0, z: diagonal ? 65 : 0 }, true);
    vehicle.setControls({ boost: true, brake: 0, steer: 0, throttle: 1 }, false);
    let furthest = -Infinity;
    for (let i = 0; i < 180; i += 1) {
      vehicle.fixedStep(1 / 60);
      world.step();
      furthest = Math.max(furthest, vehicle.chassis.translation().x);
    }
    check(
      `Rapier taxi stays behind shoreline at ${diagonal ? "oblique" : "straight"} boost impact`,
      furthest < 0,
      `furthest x=${furthest.toFixed(3)}`,
    );
    vehicle.dispose();
    world.free();
  }
  const deck: SurfaceDeck = { maxX: 5, maxZ: 40, minX: -5, minZ: -40, y: 7, y2: 11 };
  const world = new World({ x: 0, y: -30, z: 0 });
  world.timestep = 1 / 60;
  const vertices = surfaceDeckPhysics([deck]);
  world.createCollider(
    ColliderDesc.trimesh(
      vertices,
      Uint32Array.from({ length: vertices.length / 3 }, (_, i) => i),
    ),
  );
  const bridge = { ...shoreContext, decks: [deck], landAt: () => 0 };
  for (const { solid } of planShoreline(bridge, bounds)) {
    world.createCollider(staticSolidCollider(staticSolidBox(solid, () => -5)));
  }
  const vehicle = new RaycastVehicle({ raw: () => world }, 0, 10.1, 0, Math.PI / 2);
  vehicle.setControls({ boost: false, brake: 0, steer: 0, throttle: 0 }, false);
  for (let i = 0; i < 60; i += 1) {
    vehicle.fixedStep(1 / 60);
    world.step();
  }
  vehicle.chassis.setLinvel({ x: 100, y: 0, z: 20 }, true);
  let clearance = Infinity;
  let furthest = 0;
  for (let i = 0; i < 180; i += 1) {
    vehicle.fixedStep(1 / 60);
    world.step();
    const p = vehicle.chassis.translation();
    clearance = Math.min(clearance, p.y - surfaceDeckHeight(deck, p.z));
    furthest = Math.max(furthest, Math.abs(p.x));
  }
  check(
    "bridge rail impact retains chassis above exact sloped deck",
    clearance > 0.2 && furthest < 5.4,
    `clearance=${clearance.toFixed(3)}, lateral=${furthest.toFixed(3)}`,
  );
  vehicle.dispose();
  world.free();
};

/** Uses the shipped network: an oversized decorative lagoon previously
 * crossed several streets. Fitting water and rim together must preserve it. */
export const checkLandmarkWaterWalls = (
  check: Check,
  terrain: Terrain,
  network: RoadNetwork,
): void => {
  const walls: Solid[] = [];
  buildLandmarks(terrain, new ModelCache(), network, (wall) => walls.push(wall));
  check("Palace lagoon and all Sutro pools retain complete visible barriers", walls.length === 64);
  check(
    "authored water barriers stay clear of actual asphalt",
    walls.every((s) => {
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      const hx = (s.maxX - s.minX) / 2;
      const hz = (s.maxZ - s.minZ) / 2;
      const yaw = s.yaw ?? 0;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      return [-1, 0, 1].every((ix) =>
        [-1, 0, 1].every((iz) => {
          const x = cx + ix * hx * cos + iz * hz * sin;
          const z = cz - ix * hx * sin + iz * hz * cos;
          const hit = network.nearest(x, z, 30);
          return hit === null || hit.dist >= hit.edge.half + 0.3;
        }),
      );
    }),
  );
};
