import path from "node:path";

import { NodeIO } from "@gltf-transform/core";
import type { Document, Mesh, Node, vec3, vec4 } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  meshopt,
  mergeDocuments,
  prune,
  resample,
  simplify,
  textureCompress,
  weld,
} from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const SOLDIER_TRIANGLES = 36_000;
const CARBINE_TRIANGLES = 7000;
const SIMPLIFY_ERROR = 0.01;
const CARBINE_LENGTH = 0.78;

const CLIPS: Readonly<Record<string, string>> = {
  "Armature|running|baselayer": "jog",
  "Armature|walking_man|baselayer": "walk",
  Cautious_Crouch_Walk_Forward_inplace: "crouch-walk",
  Crouch_Walk_Left_with_Gun_inplace: "crouch-left",
  Hit_Reaction: "hit",
  Rifle_Charge_inplace: "sprint",
  Walk_Backward_with_Gun_1_inplace: "back",
  Walk_Backward_with_Gun_inplace: "crouch-back",
  Walk_Left_with_Gun_inplace: "strafe-left",
};

const MIRRORED: Readonly<Record<string, string>> = {
  "crouch-left": "crouch-right",
  "strafe-left": "strafe-right",
};

const ARMS = /^(?:Left|Right)(?:Shoulder|Arm|ForeArm|Hand)$/u;

const GRIPS = [
  { bone: "LeftHand", creases: [0.132, 0.178], side: 1, turns: [0.9, 1.1] },
  { bone: "RightHand", creases: [0.132, 0.178], side: -1, turns: [1.15, 1.3] },
] as const;

const CREASE_WIDTH = 0.014;

const smoothstep = (lo: number, hi: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

  return t * t * (3 - 2 * t);
};

const need = <T,>(value: T | null | undefined, what: string) => {
  if (value === null || value === undefined) {
    throw new Error(`build-soldier: no ${what}`);
  }

  return value;
};

const quat = (values: readonly number[]) => {
  const [x = 0, y = 0, z = 0, w = 1] = values;
  const q: vec4 = [x, y, z, w];

  return q;
};

const multiply = ([ax, ay, az, aw]: vec4, [bx, by, bz, bw]: vec4) => {
  const q: vec4 = [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];

  return q;
};

const conjugate = ([x, y, z, w]: vec4) => {
  const q: vec4 = [-x, -y, -z, w];

  return q;
};

const mirror = ([x, y, z, w]: vec4) => {
  const q: vec4 = [x, -y, -z, w];

  return q;
};

const triple = (values: readonly number[]) => {
  const [x = 0, y = 0, z = 0] = values;
  const v: vec3 = [x, y, z];

  return v;
};

const twin = (name: string) =>
  name.startsWith("Left") ? name.replace("Left", "Right") : name.replace(/^Right/u, "Left");

const [sourceArg, packedArg] = process.argv.slice(2);
const source = need(sourceArg, "source folder (argv 1)");
const packed = need(packedArg, "output path (argv 2)");

await MeshoptDecoder.ready;

await MeshoptEncoder.ready;

await MeshoptSimplifier.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

const doc = await io.read(path.join(source, "rigged.glb"));
const root = doc.getRoot();
const scene = need(root.listScenes()[0], "scene");
const bones = new Map<string, Node>();

scene.traverse((node) => bones.set(node.getName(), node));

for (const animation of root.listAnimations()) {
  animation.dispose();
}

const body = need(root.listMeshes()[0], "soldier mesh");

body.setName("soldier");

need(
  root.listNodes().find((node) => node.getMesh() === body),
  "soldier node",
).setName("soldier");

need(root.listMaterials()[0], "soldier material").setName("soldier");

const oneBuffer = () => {
  const [first, ...spare] = root.listBuffers();
  const buffer = need(first, "buffer");

  for (const accessor of root.listAccessors()) {
    accessor.setBuffer(buffer);
  }

  for (const other of spare) {
    other.dispose();
  }
};

for (const file of ["clips.glb", "walking-armature.glb", "running-armature.glb"]) {
  mergeDocuments(doc, await io.read(path.join(source, file)));
}

for (const animation of root.listAnimations()) {
  for (const channel of animation.listChannels()) {
    channel.setTargetNode(bones.get(channel.getTargetNode()?.getName() ?? "") ?? null);
  }
}

const kept = new Set(bones.values());

for (const node of root.listNodes()) {
  if (!kept.has(node)) {
    node.dispose();
  }
}

for (const extra of root.listScenes().slice(1)) {
  extra.dispose();
}

for (const mesh of root.listMeshes()) {
  if (mesh !== body) {
    mesh.dispose();
  }
}

for (const skin of root.listSkins().slice(1)) {
  skin.dispose();
}

oneBuffer();

const hips = need(bones.get("Hips"), "Hips bone");
const rest = hips.getTranslation();

for (const animation of root.listAnimations()) {
  const name = CLIPS[animation.getName()] ?? null;

  for (const channel of animation.listChannels()) {
    const bone = channel.getTargetNode();
    const property = channel.getTargetPath();
    const posed = property === "rotation" || (property === "translation" && bone === hips);

    if (name === null || name === "" || !bone || !posed || ARMS.test(bone.getName())) {
      channel.getSampler()?.dispose();
      channel.dispose();
    } else if (property === "translation") {
      const output = need(channel.getSampler()?.getOutput(), "translation output");

      for (let i = 0; i < output.getCount(); i += 1) {
        output.setElement(i, [rest[0], output.getElement(i, [])[1] ?? 0, rest[2]]);
      }
    }
  }

  if (name !== null && name !== "") {
    animation.setName(name);
  } else {
    animation.dispose();
  }
}

for (const animation of root.listAnimations()) {
  const name = MIRRORED[animation.getName()] ?? null;

  if (name === null || name === "") {
    continue;
  }

  const flipped = doc.createAnimation(name);

  for (const channel of animation.listChannels()) {
    const from = need(channel.getTargetNode(), "mirrored channel's bone");
    const to = bones.get(twin(from.getName())) ?? from;
    const sampler = need(channel.getSampler(), "mirrored channel's sampler");
    const output = need(sampler.getOutput(), "mirrored channel's output").clone();

    if (channel.getTargetPath() === "rotation") {
      const away = conjugate(from.getRotation());

      for (let i = 0; i < output.getCount(); i += 1) {
        const turn = mirror(multiply(away, quat(output.getElement(i, []))));
        output.setElement(i, multiply(to.getRotation(), turn));
      }
    }

    const copy = doc
      .createAnimationSampler()
      .setInput(sampler.getInput())
      .setOutput(output)
      .setInterpolation(sampler.getInterpolation());

    flipped
      .addSampler(copy)
      .addChannel(
        doc
          .createAnimationChannel()
          .setTargetNode(to)
          .setTargetPath(need(channel.getTargetPath(), "target path"))
          .setSampler(copy),
      );
  }
}

const faceted = (mesh: Mesh) => {
  for (const part of mesh.listPrimitives()) {
    part.getAttribute("NORMAL")?.dispose();
    part.getAttribute("TANGENT")?.dispose();
  }
};

const smooth = (document: Document, mesh: Mesh) => {
  for (const part of mesh.listPrimitives()) {
    const points = need(part.getAttribute("POSITION"), "POSITION");
    const indices = need(part.getIndices()?.getArray(), "indices");
    const sums = new Map<string, vec3>();
    const keys: string[] = [];

    for (let i = 0; i < points.getCount(); i += 1) {
      keys.push(points.getElement(i, []).join(","));
    }

    for (let f = 0; f < indices.length; f += 3) {
      const corner = (k: number) => indices[f + k] ?? 0;
      const [a, b, c] = [0, 1, 2].map((k) => triple(points.getElement(corner(k), [])));
      const [ax, ay, az] = need(a, "corner a");
      const [bx, by, bz] = need(b, "corner b");
      const [cx, cy, cz] = need(c, "corner c");
      const [ux, uy, uz] = [bx - ax, by - ay, bz - az];
      const [vx, vy, vz] = [cx - ax, cy - ay, cz - az];
      const face: vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];

      for (let k = 0; k < 3; k += 1) {
        const at = keys[corner(k)] ?? "";
        const sum = sums.get(at) ?? [0, 0, 0];
        sums.set(at, [sum[0] + face[0], sum[1] + face[1], sum[2] + face[2]]);
      }
    }

    const array = new Float32Array(points.getCount() * 3);

    for (const [i, key] of keys.entries()) {
      const [x, y, z] = sums.get(key) ?? [0, 1, 0];
      const length = Math.hypot(x, y, z) || 1;
      array.set([x / length, y / length, z / length], i * 3);
    }

    part.setAttribute(
      "NORMAL",
      document.createAccessor().setType("VEC3").setArray(array).setBuffer(points.getBuffer()),
    );
  }
};

faceted(body);

await doc.transform(
  weld(),
  simplify({
    error: SIMPLIFY_ERROR,
    ratio:
      SOLDIER_TRIANGLES /
      (need(body.listPrimitives()[0]?.getIndices(), "soldier indices").getCount() / 3),
    simplifier: MeshoptSimplifier,
  }),
);

smooth(doc, body);

const primitive = need(body.listPrimitives()[0], "soldier primitive");
const position = need(primitive.getAttribute("POSITION"), "soldier POSITION");
const normal = need(primitive.getAttribute("NORMAL"), "soldier NORMAL");

for (const grip of GRIPS) {
  const hand = need(bones.get(grip.bone), grip.bone);
  const wrist = hand.getWorldTranslation();

  for (let i = 0; i < position.getCount(); i += 1) {
    const [px, py] = triple(position.getElement(i, []));

    if ((px - wrist[0]) * grip.side < 0.08 || Math.abs(py - wrist[1]) > 0.15) {
      continue;
    }

    let p = triple(position.getElement(i, []));
    let n = triple(normal.getElement(i, []));

    for (const k of [1, 0] as const) {
      const crease = grip.creases[k];
      const along = (p[0] - wrist[0]) * grip.side;

      const angle =
        -grip.side *
        grip.turns[k] *
        smoothstep(crease - CREASE_WIDTH, crease + CREASE_WIDTH, along);

      const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
      const [x, y] = [p[0] - (wrist[0] + grip.side * crease), p[1] - wrist[1]];
      p = [wrist[0] + grip.side * crease + x * cos - y * sin, wrist[1] + x * sin + y * cos, p[2]];
      n = [n[0] * cos - n[1] * sin, n[0] * sin + n[1] * cos, n[2]];
    }

    position.setElement(i, p);
    normal.setElement(i, n);
  }
}

const armory = await io.read(path.join(source, "carbine-raw.glb"));

const carbineRaw = need(armory.getRoot().listMeshes()[0], "carbine mesh");

faceted(carbineRaw);

await armory.transform(
  weld(),
  simplify({
    error: SIMPLIFY_ERROR,
    ratio:
      CARBINE_TRIANGLES /
      (need(carbineRaw.listPrimitives()[0]?.getIndices(), "carbine indices").getCount() / 3),
    simplifier: MeshoptSimplifier,
  }),
);

smooth(armory, carbineRaw);

mergeDocuments(doc, armory);

oneBuffer();

const carbine = need(
  root.listMeshes().find((mesh) => mesh !== body),
  "merged carbine",
);

carbine.setName("carbine");

need(carbine.listPrimitives()[0]?.getMaterial(), "carbine material").setName("carbine");

const holder = need(
  root.listNodes().find((node) => node.getMesh() === carbine),
  "carbine node",
);

holder.setName("carbine");

scene.addChild(holder);

for (const extra of root.listScenes().slice(1)) {
  extra.dispose();
}

{
  const part = need(carbine.listPrimitives()[0], "carbine primitive");
  const points = need(part.getAttribute("POSITION"), "carbine POSITION");
  const normals = need(part.getAttribute("NORMAL"), "carbine NORMAL");
  const [min, max] = [triple(points.getMin([])), triple(points.getMax([]))];
  const scale = CARBINE_LENGTH / (max[0] - min[0]);
  let bore = 0;
  let count = 0;

  for (let i = 0; i < points.getCount(); i += 1) {
    const [x, y] = triple(points.getElement(i, []));

    if (x < min[0] + (max[0] - min[0]) * 0.03) {
      bore += y;
      count += 1;
    }
  }

  bore /= count;

  for (let i = 0; i < points.getCount(); i += 1) {
    const [x, y, z] = triple(points.getElement(i, []));
    points.setElement(i, [-z * scale, (y - bore) * scale, (x - max[0]) * scale]);
    const [nx, ny, nz] = triple(normals.getElement(i, []));
    normals.setElement(i, [-nz, ny, nx]);
  }
}

const shrink = (slots: RegExp, size: number, pattern = /.*/u) =>
  textureCompress({
    encoder: sharp,
    pattern,
    quality: 80,
    resize: [size, size],
    slots,
    targetFormat: "webp",
  });

for (const material of root.listMaterials()) {
  material.getBaseColorTexture()?.setName(`${material.getName()}-base`);
  material.getNormalTexture()?.setName(`${material.getName()}-normal`);
  material.getMetallicRoughnessTexture()?.setName(`${material.getName()}-surface`);
}

await doc.transform(
  prune(),
  dedup(),
  resample({ tolerance: 1e-4 }),
  shrink(/^baseColorTexture$/u, 2048, /^soldier-base$/u),
  shrink(/^baseColorTexture$/u, 1024, /^carbine-base$/u),
  shrink(/^(?:normalTexture|metallicRoughnessTexture)$/u, 1024),
  meshopt({ encoder: MeshoptEncoder, level: "medium" }),
);

await io.write(packed, doc);
