import type { Accessor, Document, Node, Scene } from "@gltf-transform/core";
import type { RouterOutputs } from "@repo/contract";
import type { mergeClipsInput, optimizeInput } from "@repo/contract/asset/asset-schema";
import type { z } from "zod";
import { ImageUtils, WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  getBounds,
  meshopt,
  prune,
  quantize,
  resample,
  simplify,
  weld,
} from "@gltf-transform/functions";
import { ORPCError } from "@orpc/server";

type Stats = RouterOutputs["asset"]["inspect"];

type OptimizeOptions = Omit<z.infer<typeof optimizeInput>, "model_url">;

type MergeOptions = Pick<z.infer<typeof mergeClipsInput>, "keep_animations" | "names">;

type Vec3 = [number, number, number];

type Quat = [number, number, number, number];

const loadMeshopt = async () => {
  const [{ MeshoptDecoder }, { MeshoptEncoder }, { MeshoptSimplifier }] = await Promise.all([
    import("meshoptimizer/decoder"),
    import("meshoptimizer/encoder"),
    import("meshoptimizer/simplifier"),
  ]);

  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);

  return { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier };
};

const createIO = async () => {
  const meshoptimizer = await loadMeshopt();

  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "meshopt.decoder": meshoptimizer.MeshoptDecoder,
    "meshopt.encoder": meshoptimizer.MeshoptEncoder,
  });

  return { io, meshoptimizer };
};

type IO = Awaited<ReturnType<typeof createIO>>["io"];

const read = async (io: IO, bytes: Uint8Array, label: string) => {
  try {
    return await io.readBinary(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const draco = /draco/iu.test(reason) ? " Draco-compressed input is not supported yet." : "";

    throw new ORPCError("BAD_REQUEST", {
      cause: error,
      message: `${label} is not a GLB this can read: ${reason}.${draco}`,
    });
  }
};

const sceneOf = (doc: Document) => {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  if (!scene) {
    throw new ORPCError("BAD_REQUEST", { message: "The GLB has no scene." });
  }

  return scene;
};

const round = (n: number) => Math.round(n * 1e4) / 1e4;

const roundAll: (v: Vec3) => Vec3 = (v) => [round(v[0]), round(v[1]), round(v[2])];

const boundsOf = (scene: Scene) => {
  const { max, min } = getBounds(scene);
  const finite = [...min, ...max].every(Number.isFinite);
  const lo: Vec3 = finite ? [min[0], min[1], min[2]] : [0, 0, 0];
  const hi: Vec3 = finite ? [max[0], max[1], max[2]] : [0, 0, 0];

  const size: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];

  return { max: roundAll(hi), min: roundAll(lo), size: roundAll(size) };
};

const TRIANGLES = 4;

const countGeometry = (doc: Document) => {
  let triangles = 0;
  let vertices = 0;

  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const count = prim.getAttribute("POSITION")?.getCount() ?? 0;
      const indexed = prim.getIndices()?.getCount() ?? count;
      vertices += count;

      if (prim.getMode() === TRIANGLES) {
        triangles += Math.floor(indexed / 3);
      } else if (prim.getMode() > TRIANGLES) {
        triangles += Math.max(0, indexed - 2);
      }
    }
  }

  return { triangles, vertices };
};

const durationOf = (samplers: { getInput: () => Accessor | null }[]) => {
  let end = 0;

  for (const sampler of samplers) {
    const input = sampler.getInput();

    if (input && input.getCount() > 0) {
      end = Math.max(end, input.getMax([0])[0] ?? 0);
    }
  }

  return round(end);
};

/** What a document holds, as `asset.inspect` reports it. */
export const statsOf: (doc: Document, bytes: number) => Stats = (doc, bytes) => {
  const root = doc.getRoot();

  return {
    animations: root.listAnimations().map((animation) => ({
      channels: animation.listChannels().length,
      duration_seconds: durationOf(animation.listSamplers()),
      name: animation.getName(),
    })),
    bounds: boundsOf(sceneOf(doc)),
    bytes,
    extensions: root.listExtensionsUsed().map((extension) => extension.extensionName),
    materials: root.listMaterials().length,
    meshes: root.listMeshes().length,
    skins: root.listSkins().map((skin) => ({
      joints: skin.listJoints().length,
      name: skin.getName(),
    })),
    textures: root.listTextures().map((texture) => {
      const image = texture.getImage();
      const mime = texture.getMimeType();
      const size = image ? ImageUtils.getSize(image, mime) : null;

      return {
        bytes: image?.byteLength ?? 0,
        height: size?.[1] ?? null,
        mime,
        name: texture.getName() || texture.getURI(),
        width: size?.[0] ?? null,
      };
    }),
    ...countGeometry(doc),
  };
};

/** Reads a GLB and reports what it holds. */
export const inspectGlb = async (bytes: Uint8Array) => {
  const { io } = await createIO();

  return statsOf(await read(io, bytes, "model_url"), bytes.byteLength);
};

const axisAngle: (axis: Vec3, degrees: number) => Quat = (axis, degrees) => {
  const half = (degrees * Math.PI) / 360;
  const s = Math.sin(half);

  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
};

const multiply: (a: Quat, b: Quat) => Quat = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const wrapScene = (doc: Document, scene: Scene) => {
  const pivot = doc.createNode("normalized");

  for (const child of scene.listChildren()) {
    pivot.addChild(child);
  }

  scene.addChild(pivot);

  return pivot;
};

const scaleFor = (size: Vec3, options: OptimizeOptions) => {
  if (options.height !== undefined) {
    return size[1] > 0 ? options.height / size[1] : 1;
  }

  if (options.size !== undefined) {
    const longest = Math.max(...size);

    return longest > 0 ? options.size / longest : 1;
  }

  return 1;
};

const needsNormalize = (options: OptimizeOptions) =>
  options.up_axis === "z" ||
  options.yaw_degrees !== undefined ||
  options.height !== undefined ||
  options.size !== undefined ||
  options.origin !== undefined;

const normalize = (doc: Document, options: OptimizeOptions) => {
  if (options.height !== undefined && options.size !== undefined) {
    throw new ORPCError("BAD_REQUEST", { message: "Give height or size, not both." });
  }

  const scene = sceneOf(doc);
  const pivot: Node = wrapScene(doc, scene);
  const upright = options.up_axis === "z" ? axisAngle([1, 0, 0], -90) : axisAngle([1, 0, 0], 0);
  const rotation = multiply(axisAngle([0, 1, 0], options.yaw_degrees ?? 0), upright);
  pivot.setRotation(rotation);

  const { max: hi, min: lo } = getBounds(scene);
  const scale = scaleFor([hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], options);
  pivot.setScale([scale, scale, scale]);

  if (options.origin !== undefined) {
    const { max, min } = getBounds(scene);
    const centre = min.map((v, i) => (v + (max[i] ?? v)) / 2);
    const y = options.origin === "feet" ? min[1] : centre[1];
    pivot.setTranslation([-(centre[0] ?? 0), -(y ?? 0), -(centre[2] ?? 0)]);
  }
};

const stripMeshes = (doc: Document) => {
  for (const node of doc.getRoot().listNodes()) {
    node.setMesh(null);
    node.setSkin(null);
  }

  for (const mesh of doc.getRoot().listMeshes()) {
    mesh.dispose();
  }
};

type Meshopt = Awaited<ReturnType<typeof loadMeshopt>>;

const simplifyTo = async (doc: Document, target: number, error: number, mo: Meshopt) => {
  const { triangles } = countGeometry(doc);

  if (triangles <= target) {
    return;
  }

  await doc.transform(
    weld(),
    simplify({ error, ratio: target / triangles, simplifier: mo.MeshoptSimplifier }),
  );
};

const compressWith = async (doc: Document, compress: OptimizeOptions["compress"], mo: Meshopt) => {
  if (compress === "meshopt") {
    await doc.transform(meshopt({ encoder: mo.MeshoptEncoder, level: "medium" }));
  } else if (compress === "quantize") {
    await doc.transform(quantize());
  }
};

/** Reads a GLB, normalizes, simplifies and compresses it per `options`, and writes it back. */
export const optimizeGlb = async (bytes: Uint8Array, options: OptimizeOptions) => {
  const { io, meshoptimizer } = await createIO();
  const doc = await read(io, bytes, "model_url");

  if (options.strip_meshes) {
    stripMeshes(doc);
  }

  if (needsNormalize(options)) {
    normalize(doc, options);
  }

  if (options.target_triangles !== undefined && !options.strip_meshes) {
    await simplifyTo(doc, options.target_triangles, options.simplify_error, meshoptimizer);
  }

  await doc.transform(dedup(), resample(), prune());
  await compressWith(doc, options.compress, meshoptimizer);

  const out = await io.writeBinary(doc);

  return { bytes: out, stats: statsOf(doc, out.byteLength) };
};

const copyAccessor = (doc: Document, source: Accessor) => {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const array = source.getArray();

  if (!array) {
    throw new ORPCError("BAD_REQUEST", { message: "A clip holds an animation with no keyframes." });
  }

  return doc
    .createAccessor(source.getName())
    .setType(source.getType())
    .setArray(array)
    .setNormalized(source.getNormalized())
    .setBuffer(buffer);
};

const nodesByName = (doc: Document) => {
  const byName = new Map<string, Node>();

  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();

    if (name && !byName.has(name)) {
      byName.set(name, node);
    }
  }

  return byName;
};

const MIN_MATCHED = 0.5;

const clipName = (names: string[] | undefined, clip: number, index: number, own: string) => {
  const given = names?.[clip];

  if (given === undefined) {
    return own || `clip_${clip + 1}${index > 0 ? `_${index + 1}` : ""}`;
  }

  return index > 0 ? `${given}_${index + 1}` : given;
};

const mergeOne = (
  base: Document,
  byName: Map<string, Node>,
  clip: Document,
  clipIndex: number,
  names: string[] | undefined,
) => {
  let total = 0;
  let skipped = 0;

  for (const [index, animation] of clip.getRoot().listAnimations().entries()) {
    const target = base.createAnimation(clipName(names, clipIndex, index, animation.getName()));

    for (const channel of animation.listChannels()) {
      total += 1;
      const node = channel.getTargetNode();
      const sampler = channel.getSampler();
      const input = sampler?.getInput();
      const output = sampler?.getOutput();
      const match = node ? byName.get(node.getName()) : undefined;
      const path = channel.getTargetPath();

      if (!match || !sampler || !input || !output || !path) {
        skipped += 1;
        continue;
      }

      const copy = base
        .createAnimationSampler()
        .setInput(copyAccessor(base, input))
        .setOutput(copyAccessor(base, output))
        .setInterpolation(sampler.getInterpolation());

      target
        .addSampler(copy)
        .addChannel(
          base.createAnimationChannel().setTargetNode(match).setTargetPath(path).setSampler(copy),
        );
    }
  }

  if (total === 0) {
    throw new ORPCError("BAD_REQUEST", {
      message: `clip_urls[${clipIndex}] holds no animation.`,
    });
  }

  if (total - skipped < total * MIN_MATCHED) {
    throw new ORPCError("BAD_REQUEST", {
      message: `clip_urls[${clipIndex}]'s skeleton does not match model_url's: only ${total - skipped} of ${total} channels name a joint the model has. Clips must come from the same rig, e.g. one animate-3d run.`,
    });
  }

  return skipped;
};

/**
 * Copies every animation of each clip onto the base model, matching target
 * nodes by name. Clips are read one at a time so only one is held at once.
 */
export const mergeClipsGlb = async (
  base: Uint8Array,
  clips: AsyncIterable<Uint8Array>,
  options: MergeOptions,
) => {
  const { io } = await createIO();
  const doc = await read(io, base, "model_url");

  if (!options.keep_animations) {
    for (const animation of doc.getRoot().listAnimations()) {
      animation.dispose();
    }
  }

  const byName = nodesByName(doc);
  let skipped = 0;
  let index = 0;

  for await (const bytes of clips) {
    const clip = await read(io, bytes, `clip_urls[${index}]`);
    skipped += mergeOne(doc, byName, clip, index, options.names);
    index += 1;
  }

  await doc.transform(dedup(), prune());

  const out = await io.writeBinary(doc);

  return { bytes: out, skipped_channels: skipped, stats: statsOf(doc, out.byteLength) };
};
