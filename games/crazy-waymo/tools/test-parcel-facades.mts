import { Box3, Group } from "three";
import { parcelMeshOf } from "../src/world/parcel-build.ts";

import { buildParcelGeometrySync } from "../src/world/parcel-mesh.ts";
import { visibleParcelPlans } from "../src/world/parcel-visibility.ts";
import { roofVariantOf } from "../src/world/parcel-roofs.ts";
import { pointInRing } from "../src/world/parcel-plan.ts";
import { SHOP_SIGNS, shopSignIndex } from "../src/world/parcel-signs.ts";
import type { ParcelPlan } from "../src/world/parcel-plan.ts";
import { parcelDetailForDistance, ParcelStreamer } from "../src/world/parcel-stream.ts";
import { packLots, packPlans } from "../src/world/parcel-pack.ts";
import { visualHeight } from "../src/world/parcel-style.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

/** Small SF terrace fixture: its two-storey bay used to lose every pane. */
const houseFixture = (): ParcelPlan => ({
  blind: new Uint8Array([0, 1, 0, 1]),
  blockHash: 4,
  character: "victorian",
  district: "the Haight",
  footY: 0,
  front: 0,
  height: visualHeight(2),
  hero: false,
  hint: "house",
  id: 0,
  kind: "rowhouse",
  n: 4,
  obb: { cx: 2, cz: 3, ex: 1, ez: 0, halfA: 2, halfB: 3 },
  rect: true,
  ring: new Float32Array([0, 0, 4, 0, 4, 6, 0, 6]),
  seatY: 0,
  seed: 27,
  solids: [],
  storeys: 2,
  units: 1,
});

const checkHouseFacades = (check: Check, house: ParcelPlan): void => {
  const close = buildParcelGeometrySync([house], 2);
  const distant = buildParcelGeometrySync([house], 0);
  const survey = buildParcelGeometrySync([{ ...house, hero: true }], 2);
  let bayPaneVertices = 0;
  for (const geo of close.geos) {
    if (geo.mat !== "glassDark" && geo.mat !== "glassLit") {
      continue;
    }
    for (let i = 0; i < geo.position.length; i += 3) {
      if ((geo.position[i + 2] ?? 0) < -0.4 && (geo.position[i + 1] ?? 0) > 1.8) {
        bayPaneVertices += 1;
      }
    }
  }
  check(
    "two-storey Victorian bays retain their top-floor glass",
    bayPaneVertices >= 4,
    `${bayPaneVertices} projected upper-window vertices`,
  );
  check(
    "OSM and survey homes receive the same dimensional facade",
    close.stats.vertices === survey.stats.vertices &&
      close.stats.triangles === survey.stats.triangles,
    `${close.stats.vertices} OSM / ${survey.stats.vertices} survey vertices`,
  );
  check(
    "distant houses retain windows at a fraction of the geometry",
    distant.geos.some((g) => g.mat === "facade") &&
      distant.stats.vertices < close.stats.vertices / 4,
    `${distant.stats.vertices} distant / ${close.stats.vertices} close vertices`,
  );
  check(
    "dimensional facade buffers contain finite, in-range geometry",
    close.geos.every(
      (g) => g.position.every(Number.isFinite) && g.index.every((i) => i < g.position.length / 3),
    ),
  );
  const decoded = new Box3();
  for (const geo of distant.geos) {
    const mesh = parcelMeshOf(geo);
    decoded.union(new Box3().setFromObject(mesh));
    mesh.geometry.dispose();
  }
  check(
    "quantized distant vertices restore exact world bounds",
    distant.geos.every((g) => g.encoding === "quantized") &&
      Math.abs(decoded.min.x) < 0.001 &&
      Math.abs(decoded.min.z) < 0.001 &&
      Math.abs(decoded.max.x - 4) < 0.001 &&
      Math.abs(decoded.max.z - 6) < 0.001 &&
      Math.abs(decoded.max.y - house.height) < 0.001,
  );
};

const checkTowerFacades = (check: Check, house: ParcelPlan): void => {
  const tower = {
    ...house,
    blind: new Uint8Array(4),
    character: "highrise",
    district: "the Financial District",
    height: 24,
    kind: "tower",
    storeys: 20,
  } satisfies ParcelPlan;
  const towerClose = buildParcelGeometrySync([tower], 2);
  const towerWalls = towerClose.geos.filter((geo) => geo.mat === "facade");
  check(
    "near tower ribbons do not stack over a second shader window grid",
    towerWalls.length > 0 &&
      towerWalls.every((geo) =>
        // oxlint-disable-next-line no-bitwise -- facade2 packs window flags as bits
        geo.facade2?.every((value, i) => i % 3 !== 2 || (value & 8) !== 0),
      ),
  );
  const towerStyles = [0, 16, 32].map((blockHash) =>
    buildParcelGeometrySync([{ ...tower, blockHash }], 0),
  );
  check(
    "distant tower construction eras share the compact geometry budget",
    new Set(towerStyles.map((g) => g.stats.vertices)).size === 1 &&
      new Set(towerStyles.map((g) => g.geos.find((geo) => geo.mat === "facade")?.facade2?.at(2)))
        .size === 3,
  );
  check(
    "static skyline keeps upper windows beyond the detail cutoff",
    towerClose.geos.some(
      (geo) => (geo.mat === "glassDark" || geo.mat === "glassLit") && geo.tier === "far",
    ) &&
      towerClose.geos.every(
        (geo) =>
          (geo.mat !== "glassDark" && geo.mat !== "glassLit") ||
          geo.tier !== "detail" ||
          geo.position.every((value, i) => i % 3 !== 1 || value < 5),
      ),
  );
  const setbackTower = {
    ...tower,
    obb: { cx: 5, cz: 5, ex: 1, ez: 0, halfA: 5, halfB: 5 },
    ring: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]),
  };
  let floatingPodiumPanes = 0;
  for (const geo of buildParcelGeometrySync([setbackTower], 2).geos) {
    if (geo.mat !== "glassDark" && geo.mat !== "glassLit") {
      continue;
    }
    for (let i = 0; i < geo.position.length; i += 3) {
      const x = geo.position[i] ?? 0;
      const y = geo.position[i + 1] ?? 0;
      const z = geo.position[i + 2] ?? 0;
      if (y > 5 && (x < 0.5 || x > 9.5 || z < 0.5 || z > 9.5)) {
        floatingPodiumPanes += 1;
      }
    }
  }
  check(
    "podium windows stop below the tower setback instead of floating above it",
    floatingPodiumPanes === 0,
    `${floatingPodiumPanes} unsupported upper pane vertices`,
  );
};

const checkFacadeLod = (check: Check): void => {
  check(
    "facade LOD keeps a hysteresis band through a U-turn",
    parcelDetailForDistance(180, 2) === 2 &&
      parcelDetailForDistance(240, 2) === 0 &&
      parcelDetailForDistance(240, 2, 2) === 2 &&
      parcelDetailForDistance(340, 2, 2) === 0,
  );
};

const checkCornerRoofs = (check: Check, house: ParcelPlan): void => {
  const corner = { ...house, blind: new Uint8Array(4), height: visualHeight(3), storeys: 3 };
  const roofFixtures = [0, 16].map((seed) => ({ ...corner, seed }));
  check(
    "historic roof variants need exposed convex street corners",
    roofFixtures.every((p) => roofVariantOf(p) !== null) &&
      roofVariantOf({ ...corner, blind: new Uint8Array([0, 1, 0, 1]), seed: 0 }) === null &&
      roofVariantOf({ ...corner, ring: new Float32Array([0, 0, 4, 0, 1, 2, 0, 6]), seed: 0 }) ===
        null,
  );
  let roofBounds = true;
  let silhouetteStable = true;
  for (const fixture of roofFixtures) {
    const variant = roofVariantOf(fixture);
    if (!variant) {
      roofBounds = false;
      continue;
    }
    const heights: number[] = [];
    for (const detail of [0, 1, 2] satisfies readonly (0 | 1 | 2)[]) {
      let maxY = -Infinity;
      for (const geo of buildParcelGeometrySync([fixture], detail).geos) {
        for (let i = 0; i < geo.position.length; i += 3) {
          const xyz = (axis: number): number =>
            geo.encoding === "quantized"
              ? (geo.origin[axis] ?? 0) + ((geo.position[i + axis] ?? 0) * geo.scale) / 65_535
              : (geo.position[i + axis] ?? 0);
          const x = xyz(0);
          const y = xyz(1);
          const z = xyz(2);
          maxY = Math.max(maxY, y);
          if (y > fixture.height + 0.001) {
            roofBounds = false;
          }
          if (
            y > fixture.height - variant.rise + 0.65 &&
            !pointInRing(fixture.ring, fixture.n, x, z)
          ) {
            roofBounds = false;
          }
        }
      }
      heights.push(maxY);
    }
    silhouetteStable &&= Math.max(...heights) - Math.min(...heights) < 0.002;
  }
  check("corner roofs stay inside original parcel height and footprint", roofBounds);
  check("corner roof silhouettes survive phone and distant LOD", silhouetteStable);
};

const checkStorefronts = (check: Check, house: ParcelPlan): void => {
  const shop = { ...house, district: "North Beach", kind: "midrise" } satisfies ParcelPlan;
  const shopGeometry = buildParcelGeometrySync([shop], 1);
  const sign = shopGeometry.geos.find((geo) => geo.mat === "sign");
  check(
    "phone storefronts use compact correctly oriented sign atlas quads",
    sign !== undefined &&
      sign.position.length === 12 &&
      sign.uv?.length === 8 &&
      (sign.uv[0] ?? 0) > (sign.uv[2] ?? 0) &&
      SHOP_SIGNS[shopSignIndex("North Beach", 0, 0)] === "NORTH BEACH DELI" &&
      SHOP_SIGNS[shopSignIndex("the Sunset", 0, 0)] === "SUNSET MARKET",
  );
  check(
    "distant storefronts discard lettering geometry",
    !buildParcelGeometrySync([shop], 0).geos.some((geo) => geo.mat === "sign"),
  );
};

const checkParcelVisibility = (check: Check, house: ParcelPlan): void => {
  const outer = { ...house, footY: -0.1, height: 6, hero: true, id: 100 };
  const inner = { ...house, height: 3, id: 200, ring: new Float32Array([0, 0, 2, 0, 2, 4, 0, 4]) };
  check(
    "render visibility removes fully enclosed duplicate source volumes",
    visibleParcelPlans([inner, outer]).length === 1 &&
      visibleParcelPlans([outer, inner])[0] === outer &&
      outer.ring === house.ring &&
      inner.solids === house.solids,
  );
  check(
    "render visibility preserves partial overlaps, lower foundations and taller interiors",
    [
      { ...inner, ring: new Float32Array([3, 0, 5, 0, 5, 4, 3, 4]) },
      { ...inner, height: 6.1 },
      { ...inner, footY: -0.10001 },
      { ...inner, ring: new Float32Array([4, 0, 8, 0, 8, 4, 4, 4]) },
    ].every((p) => visibleParcelPlans([outer, p]).length === 2),
  );
  const seamOuter = {
    ...outer,
    obb: { ...outer.obb, cx: 78, halfA: 6 },
    ring: new Float32Array([72, 0, 84, 0, 84, 6, 72, 6]),
  };
  const seamInner = {
    ...inner,
    obb: { ...inner.obb, cx: 82, halfA: 1 },
    ring: new Float32Array([81, 0, 83, 0, 83, 4, 81, 4]),
  };
  check(
    "duplicate visibility resolves before neighboring stream cells split",
    visibleParcelPlans([seamInner, seamOuter]).length === 1,
  );
  const concave = {
    ...outer,
    n: 8,
    ring: new Float32Array([0, 0, 6, 0, 6, 6, 4, 6, 4, 2, 2, 2, 2, 6, 0, 6]),
  };
  check(
    "render containment tests whole edges across concave notches",
    visibleParcelPlans([concave, { ...inner, ring: new Float32Array([1, 1, 5, 1, 5, 5, 1, 5]) }])
      .length === 2,
  );
  check(
    "setback towers cannot hide buildings in their upper footprint",
    visibleParcelPlans([{ ...outer, kind: "tower" }, inner]).length === 2,
  );
  const duplicate = { ...outer, hero: false, id: 201 };
  check(
    "equal survey and OSM volumes keep one deterministic survey representative",
    visibleParcelPlans([duplicate, outer])[0] === outer &&
      visibleParcelPlans([outer, duplicate]).length === 1,
  );
};

const checkParcelStreaming = (check: Check, house: ParcelPlan): void => {
  const placed = (x: number): ParcelPlan => ({
    ...house,
    id: x,
    obb: { ...house.obb, cx: house.obb.cx + x },
    ring: house.ring.map((value, index) => value + (index % 2 === 0 ? x : 0)),
  });
  const root = new Group();
  root.position.set(17, 3, 9);
  root.updateMatrixWorld(true);
  root.matrixWorldAutoUpdate = false;
  const streamer = new ParcelStreamer(root, 2);
  streamer.addTile(0, packPlans([placed(0), placed(80), placed(1000), placed(1080)]), packLots([]));
  streamer.update(0, 0, 300);
  const referenceRoot = new Group();
  const referenceStream = new ParcelStreamer(referenceRoot, 2);
  referenceStream.addTile(0, packPlans([placed(0), placed(80)]), packLots([]));
  referenceStream.update(0, 0, 300);
  const expectedBounds = new Box3().setFromObject(referenceRoot).translate(root.position);
  const editorBounds = new Box3().setFromObject(referenceRoot);
  referenceRoot.position.x = 10;
  referenceRoot.updateMatrixWorld(true);
  const movedEditorBounds = new Box3().setFromObject(referenceRoot);
  check(
    "editor parcel cells retain live parent-world transforms",
    Math.abs(movedEditorBounds.min.x - editorBounds.min.x - 10) < 0.001,
  );
  referenceStream.update(2000, 0, 300);
  const firstBounds = new Box3().setFromObject(root);
  // the Scene still forces a traversal every render
  root.updateMatrixWorld(true);
  const renderedBounds = new Box3().setFromObject(root);
  check(
    "new streamed cells preserve their frozen parent-world transform",
    firstBounds.min.distanceTo(expectedBounds.min) < 0.001 &&
      firstBounds.max.distanceTo(expectedBounds.max) < 0.001 &&
      renderedBounds.equals(firstBounds),
  );
  streamer.update(1000, 0, 300);
  for (let frame = 0; frame < 20 && streamer.stats().pending > 0; frame += 1) {
    streamer.update(1000, 0, 300);
  }
  const arrived = streamer.stats();
  check(
    "teleports finish every new facade cell within the streaming budget",
    arrived.pending === 0 &&
      arrived.resident === 2 &&
      arrived.detailedCells === 2 &&
      root.children.length === 2,
    `${arrived.resident} resident / ${arrived.detailedCells} detailed destination cells`,
  );
  streamer.update(2000, 0, 300);
  const phoneRoot = new Group();
  const phone = new ParcelStreamer(phoneRoot, 1);
  phone.addTile(0, packPlans([placed(0), placed(880)]), packLots([]));
  phone.update(0, 0, 960);
  check("phone quality upgrades retain the bounded fabric radius", phone.stats().resident === 1);
  phone.update(2000, 0, 300);
  check(
    "departed facade cells release their meshes",
    streamer.stats().resident === 0 && root.children.length === 0,
  );
};

export const checkParcelFacades = (check: Check): void => {
  const house = houseFixture();
  checkHouseFacades(check, house);
  checkTowerFacades(check, house);
  checkFacadeLod(check);
  checkCornerRoofs(check, house);
  checkStorefronts(check, house);
  checkParcelVisibility(check, house);
  checkParcelStreaming(check, house);
};

/** Audit actual eligible source parcels, including every roof peak at each supported tier. */
export const checkHistoricCorners = (check: Check, plans: readonly ParcelPlan[]): void => {
  const corners = plans.flatMap((p) => {
    const roof = roofVariantOf(p);
    return roof ? [{ p, roof }] : [];
  });
  const turrets = corners.filter(({ roof }) => roof.kind === "turret").length;
  const mansards = corners.length - turrets;
  let escapedHeight = 0;
  let escapedFootprint = 0;
  for (const { p, roof } of corners) {
    const geometry = buildParcelGeometrySync([p], 2);
    for (const geo of geometry.geos) {
      for (let i = 0; i < geo.position.length; i += 3) {
        const y = geo.position[i + 1] ?? 0;
        if (y > p.seatY + p.height + 0.001) {
          escapedHeight += 1;
        }
        if (
          y > p.seatY + p.height - roof.rise + 0.65 &&
          !pointInRing(p.ring, p.n, geo.position[i] ?? 0, geo.position[i + 2] ?? 0)
        ) {
          escapedFootprint += 1;
        }
      }
    }
  }
  check(
    "source historic corners remain rare and contain both roof families",
    turrets >= 5 && mansards >= 5 && corners.length < 120,
    `${turrets} turrets, ${mansards} mansards across ${plans.length} parcels`,
  );
  check(
    "every source corner roof preserves its height and footprint envelope",
    escapedHeight === 0 && escapedFootprint === 0,
    `${escapedHeight} high vertices, ${escapedFootprint} escaped roof vertices`,
  );
};
