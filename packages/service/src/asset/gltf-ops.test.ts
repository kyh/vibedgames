import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Document, WebIO } from "@gltf-transform/core";

import { inspectGlb, mergeClipsGlb, optimizeGlb } from "./gltf-ops";

const OPTIMIZE_DEFAULTS = {
  compress: "none",
  simplify_error: 0.01,
  strip_meshes: false,
  up_axis: "y",
} as const;

const grid = (cells: number, width: number, depth: number) => {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= cells; row += 1) {
    for (let col = 0; col <= cells; col += 1) {
      const x = (col / cells) * width;
      const y = (row / cells) * depth;
      positions.push(x, y, Math.sin(col) * 0.001);
    }
  }

  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const a = row * (cells + 1) + col;
      const b = a + cells + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  return { indices: new Uint32Array(indices), positions: new Float32Array(positions) };
};

const rig = (doc: Document, joints: readonly string[]) => {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const nodes = joints.map((name) => doc.createNode(name));

  for (let i = 1; i < nodes.length; i += 1) {
    nodes[i - 1]?.addChild(nodes[i] ?? doc.createNode());
  }

  return { buffer, nodes };
};

const animate = (
  doc: Document,
  name: string,
  nodes: readonly ReturnType<Document["createNode"]>[],
) => {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const animation = doc.createAnimation(name);

  for (const node of nodes) {
    const sampler = doc
      .createAnimationSampler()
      .setInput(
        doc
          .createAccessor()
          .setType("SCALAR")
          .setArray(new Float32Array([0, 0.5, 1]))
          .setBuffer(buffer),
      )
      .setOutput(
        doc
          .createAccessor()
          .setType("VEC3")
          .setArray(new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0]))
          .setBuffer(buffer),
      );

    animation
      .addSampler(sampler)
      .addChannel(
        doc
          .createAnimationChannel()
          .setTargetNode(node)
          .setTargetPath("translation")
          .setSampler(sampler),
      );
  }

  return animation;
};

const JOINTS = ["Hips", "Spine", "Head"] as const;

const model = (options: { cells?: number; joints?: readonly string[]; clip?: string } = {}) => {
  const doc = new Document();
  const { buffer, nodes } = rig(doc, options.joints ?? JOINTS);
  const { indices, positions } = grid(options.cells ?? 4, 1, 2);

  const prim = doc
    .createPrimitive()
    .setAttribute(
      "POSITION",
      doc.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer),
    )
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer));

  const meshNode = doc.createNode("body").setMesh(doc.createMesh("body").addPrimitive(prim));
  doc
    .createScene("scene")
    .addChild(meshNode)
    .addChild(nodes[0] ?? doc.createNode());

  if (options.clip) {
    animate(doc, options.clip, nodes);
  }

  return new WebIO().writeBinary(doc);
};

describe("inspectGlb", () => {
  test("reports geometry, bounds, joints-as-nodes and animations", async () => {
    const stats = await inspectGlb(await model({ clip: "wave" }));

    assert.equal(stats.triangles, 32);
    assert.equal(stats.vertices, 25);
    assert.equal(stats.meshes, 1);
    assert.deepEqual(stats.bounds.size.slice(0, 2), [1, 2]);
    assert.deepEqual(stats.animations, [{ channels: 3, duration_seconds: 1, name: "wave" }]);
  });

  test("refuses bytes that are not a GLB", async () => {
    await assert.rejects(inspectGlb(new TextEncoder().encode("nope")), /not a GLB/u);
  });
});

describe("optimizeGlb", () => {
  test("turns a z-up model y-up, scales it to a height and grounds it", async () => {
    const { stats } = await optimizeGlb(await model(), {
      ...OPTIMIZE_DEFAULTS,
      height: 1,
      origin: "feet",
      up_axis: "z",
    });

    assert.equal(stats.bounds.size[1], 1);
    assert.equal(stats.bounds.min[1], 0);
    assert.equal(stats.bounds.min[0], -stats.bounds.max[0]);
  });

  test("scales the longest side to size and centres the box", async () => {
    const { stats } = await optimizeGlb(await model(), {
      ...OPTIMIZE_DEFAULTS,
      origin: "center",
      size: 4,
    });

    assert.equal(Math.max(...stats.bounds.size), 4);
    assert.deepEqual(
      stats.bounds.min.map((v, i) => v + (stats.bounds.max[i] ?? 0)),
      [0, 0, 0],
    );
  });

  test("refuses height and size together", async () => {
    await assert.rejects(
      optimizeGlb(await model(), { ...OPTIMIZE_DEFAULTS, height: 1, size: 1 }),
      /height or size/u,
    );
  });

  test("simplifies to a triangle budget", async () => {
    const { stats } = await optimizeGlb(await model({ cells: 40 }), {
      ...OPTIMIZE_DEFAULTS,
      simplify_error: 0.1,
      target_triangles: 200,
    });

    assert.ok(stats.triangles <= 400, `${stats.triangles} triangles`);
  });

  test("meshopt-compresses into a file it can read back", async () => {
    const { bytes, stats } = await optimizeGlb(await model({ cells: 20, clip: "wave" }), {
      ...OPTIMIZE_DEFAULTS,
      compress: "meshopt",
    });

    assert.ok(stats.extensions.includes("EXT_meshopt_compression"));
    assert.ok(stats.extensions.includes("KHR_mesh_quantization"));

    const again = await inspectGlb(bytes);
    assert.equal(again.triangles, 800);
    assert.equal(again.animations.length, 1);
  });

  test("strip_meshes keeps the skeleton and animations only", async () => {
    const { stats } = await optimizeGlb(await model({ clip: "run" }), {
      ...OPTIMIZE_DEFAULTS,
      strip_meshes: true,
    });

    assert.equal(stats.meshes, 0);
    assert.equal(stats.triangles, 0);
    assert.equal(stats.animations[0]?.name, "run");
  });
});

const each = async function* each(clips: Uint8Array[]) {
  for (const clip of clips) {
    yield await Promise.resolve(clip);
  }
};

describe("mergeClipsGlb", () => {
  test("copies each clip's animation onto the model under the given name", async () => {
    const clips = [await model({ clip: "Armature|Idle" }), await model({ clip: "Armature|Run" })];

    const merged = await mergeClipsGlb(await model(), each(clips), {
      keep_animations: true,
      names: ["idle", "run"],
    });

    assert.equal(merged.skipped_channels, 0);
    assert.equal(merged.stats.meshes, 1);
    assert.deepEqual(
      merged.stats.animations.map((a) => a.name),
      ["idle", "run"],
    );
  });

  test("keeps a clip's own name without names, and drops the model's with keep_animations false", async () => {
    const merged = await mergeClipsGlb(
      await model({ clip: "old" }),
      each([await model({ clip: "jump" })]),
      {
        keep_animations: false,
        names: undefined,
      },
    );

    assert.deepEqual(
      merged.stats.animations.map((a) => a.name),
      ["jump"],
    );
  });

  test("refuses a clip from another skeleton", async () => {
    const other = await model({ clip: "dance", joints: ["pelvis", "chest", "skull"] });

    await assert.rejects(
      mergeClipsGlb(await model(), each([other]), { keep_animations: true, names: undefined }),
      /does not match/u,
    );
  });
});
