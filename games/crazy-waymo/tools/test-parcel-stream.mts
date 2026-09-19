import { mock } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { Box3, Group, Mesh } from "three";
import { buildParcelGeometry, buildParcelGeometrySteps } from "../src/world/parcel-mesh.ts";
import type { DetailLevel } from "../src/world/parcel-mesh.ts";
import type { ParcelLot, ParcelPlan } from "../src/world/parcel-plan.ts";
import { ParcelStreamer } from "../src/world/parcel-stream.ts";
import { packLots, packPlans } from "../src/world/parcel-pack.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

const house = (x: number, z: number, seed: number): ParcelPlan => ({
  blind: new Uint8Array([0, 1, 0, 1]),
  blockHash: 4,
  character: "victorian",
  district: "the Haight",
  footY: 0,
  front: 0,
  height: 4.8,
  hero: false,
  hint: "house",
  id: seed,
  kind: "rowhouse",
  n: 4,
  obb: { cx: x + 2, cz: z + 3, ex: 1, ez: 0, halfA: 2, halfB: 3 },
  rect: true,
  ring: new Float32Array([x, z, x + 4, z, x + 4, z + 6, x, z + 6]),
  seatY: 0,
  seed,
  solids: [],
  storeys: 3,
  units: 1,
});

const block = (x: number, z = 0): ParcelPlan[] =>
  Array.from({ length: 16 }, (_, index) =>
    house(x + (index % 4) * 5, z + Math.floor(index / 4) * 7, index),
  );

const streamer = (
  root: Group,
  plans: readonly ParcelPlan[],
  lots: readonly ParcelLot[],
  detail: DetailLevel,
): ParcelStreamer => {
  const stream = new ParcelStreamer(root, detail);
  stream.addTile(0, packPlans(plans), packLots(lots));
  return stream;
};

const drain = (stream: ParcelStreamer, x: number, z: number, radius: number): number => {
  let frames = 0;
  while (stream.stats().pending > 0 && frames < 2000) {
    frames += 1;
    stream.update(x, z, radius);
  }
  return frames;
};

const checkResumableSteps = async (
  check: Check,
  variants: readonly ParcelPlan[],
  lot: ParcelLot,
): Promise<void> => {
  for (const detail of [0, 1, 2] satisfies DetailLevel[]) {
    const expected = await buildParcelGeometry(variants, detail, undefined, [lot]);
    const steps = buildParcelGeometrySteps(variants, detail, [lot]);
    let slices = 0;
    let result = steps.next();
    while (!result.done) {
      slices += 1;
      result = steps.next();
    }
    check(
      `resumable parcel level ${detail} preserves every geometry buffer`,
      slices === variants.length + 1 && isDeepStrictEqual(result.value, expected),
      `${slices} parcel/lot boundaries; ${expected.stats.vertices} vertices`,
    );
  }
};

const checkLodReplacement = (check: Check): void => {
  const lodRoot = new Group();
  const lod = streamer(lodRoot, block(240), [], 2);
  lod.update(0, 0, 500);
  const previous = [...lodRoot.children];
  lod.update(150, 0, 500);
  check(
    "LOD replacements retain the complete old cell until the new mesh is ready",
    lod.stats().pending > 0 &&
      lodRoot.children.length === previous.length &&
      previous.every((group, index) => lodRoot.children[index] === group),
  );
  drain(lod, 150, 0, 500);
  check(
    "budgeted facade promotions finish without duplicate cells",
    lod.stats().detailedCells > 0 && lodRoot.children.length === previous.length,
  );
  // jump resets detail hysteresis, despite partial downgrade
  lod.update(-20, 0, 500);
  drain(lod, -20, 0, 500);
  check(
    "teleport LOD reset survives a multi-frame downgrade",
    lod.stats().pending === 0 && lod.stats().detailedCells === 0,
  );
  lod.update(4000, 4000, 0);
};

export const checkParcelStreaming = async (check: Check): Promise<void> => {
  const plans = block(0);
  const [first] = plans;
  if (!first) {
    throw new Error("Missing parcel stream fixture");
  }
  const lot: ParcelLot = {
    id: 90,
    n: 4,
    obb: { cx: 35, cz: 6, ex: 1, ez: 0, halfA: 5, halfB: 6 },
    pillars: [],
    ring: new Float32Array([30, 0, 40, 0, 40, 12, 30, 12]),
    seed: 90,
    ys: new Float32Array([0, 0.2, 0.4, 0.1]),
  };
  const variants = [
    ...plans,
    { ...first, district: "North Beach", kind: "midrise" },
    { ...first, character: "industrial", kind: "warehouse" },
  ] satisfies ParcelPlan[];
  await checkResumableSteps(check, variants, lot);

  // Each clock check consumes 1 ms: budget behavior is deterministic even on
  // fast CI hosts. Geometry remains real; no mocked builder or render output.
  let clock = 0;
  let clockStep = 1;
  const timer = mock.method(performance, "now", () => (clock += clockStep));
  try {
    const root = new Group();
    const destination = Array.from({ length: 5 }, (_, cell) => block(960 + cell * 80)).flat();
    const stream = streamer(root, [...plans, ...destination, ...block(-1000)], [], 1);
    stream.update(0, 0, 450);
    const sourceMeshes = root.children.flatMap((group) => group.children);
    let disposed = 0;
    const countDisposal = (): void => {
      disposed += 1;
    };
    for (const mesh of sourceMeshes) {
      if (mesh instanceof Mesh) {
        mesh.geometry.addEventListener("dispose", countDisposal);
      }
    }
    stream.update(1000, 0, 450);
    check(
      "teleports release old geometry immediately and budget destination work",
      disposed === sourceMeshes.length &&
        stream.stats().resident === 0 &&
        stream.stats().pending > 1,
      `${disposed} disposed meshes; ${stream.stats().pending} queued cells`,
    );
    for (let frame = 0; frame < 20 && stream.stats().resident === 0; frame += 1) {
      stream.update(1000, 0, 450);
    }
    const nearest = new Box3().setFromObject(root);
    check(
      "teleport streaming restores the nearest street first",
      nearest.min.x >= 950 && nearest.max.x < 1070,
      `${nearest.min.x} to ${nearest.max.x}`,
    );
    const frames = drain(stream, 1000, 0, 450);
    const expectedRoot = new Group();
    const expected = streamer(expectedRoot, [...plans, ...destination, ...block(-1000)], [], 1);
    expected.update(1000, 0, 450);
    check(
      "budgeted destination converges to the synchronous geometry and residency",
      stream.stats().pending === 0 &&
        stream.stats().verts === expected.stats().verts &&
        stream.stats().bytes === expected.stats().bytes &&
        new Box3().setFromObject(root).equals(new Box3().setFromObject(expectedRoot)),
      `${frames} further budgeted updates; ${stream.stats().resident} cells`,
    );
    expected.update(4000, 4000, 0);

    // begin a new cell, then abandon it mid-build
    stream.update(0, 0, 450);
    stream.update(-1000, 0, 450);
    drain(stream, -1000, 0, 450);
    const arrived = new Box3().setFromObject(root);
    check(
      "a second teleport cancels the first unfinished destination",
      stream.stats().pending === 0 && arrived.max.x < -900,
    );
    stream.update(4000, 4000, 0);

    checkLodReplacement(check);

    const editorRoot = new Group();
    const editor = streamer(editorRoot, [...plans, ...destination], [lot], 2);
    editor.update(0, 0, 300);
    editor.update(0, 0, Infinity);
    const bounds = new Box3().setFromObject(editorRoot);
    editorRoot.position.x = 12;
    editorRoot.updateMatrixWorld(true);
    check(
      "editor show-all fills synchronously and preserves movable parent transforms",
      editor.stats().pending === 0 &&
        editor.stats().resident === editor.stats().cells &&
        Math.abs(new Box3().setFromObject(editorRoot).min.x - bounds.min.x - 12) < 0.001,
    );
    editor.update(4000, 4000, 0);

    // scanning alone has already exceeded the soft deadline
    clockStep = 10;
    const slowRoot = new Group();
    const slow = streamer(slowRoot, [...plans, ...block(1000)], [], 1);
    slow.update(0, 0, 300);
    slow.update(1000, 0, 300);
    const slowFrames = drain(slow, 1000, 0, 300);
    check(
      "parcel construction cannot starve when scan cost exceeds its frame budget",
      slow.stats().pending === 0 && slow.stats().resident > 0 && slowFrames < 40,
      `${slowFrames} updates with 10 ms clock steps`,
    );
    slow.update(4000, 4000, 0);
  } finally {
    timer.mock.restore();
  }
};

if (process.argv.includes("--check")) {
  let failures = 0;
  await checkParcelStreaming((name, condition, detail) => {
    console.log(`${condition ? "ok" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
    if (!condition) {
      failures += 1;
    }
  });
  if (failures > 0) {
    process.exitCode = 1;
  }
}
