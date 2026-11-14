// Packs the soldier and its carbine for the web, from what Meshy returned for
// our own generated models.
//
//   node tools/build-soldier.mjs <dir> public/models/soldier.glb
//
// <dir> holds Meshy's downloads. They are 102 MB, so not in the repo: they
// live in tools/soldier-src/ (git-ignored), and the README lists the Meshy
// tasks to fetch them from again.
//   rigged.glb             the rigging task's character, T-pose, 4K PBR
//   clips.glb              the animation task's merged clips
//   walking-armature.glb   the rigging task's free walk
//   running-armature.glb   ... and run
//   carbine-raw.glb        the carbine, 4K PBR
//
// Out comes one GLB: the soldier decimated and skinned, the carbine as a mesh
// of its own, both with base colour, normal and metal/rough maps as WebP, and
// the clips renamed, played on the spot, and mirrored where Meshy only has a
// left-handed one.
import path from "node:path";

import { NodeIO } from "@gltf-transform/core";
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
/** How far a decimated surface may stray, as a fraction of the mesh's size. */
const SIMPLIFY_ERROR = 0.01;
/** Butt plate to muzzle, metres. */
const CARBINE_LENGTH = 0.78;

/** Meshy's clip names → ours. Anything else in the files is dropped. */
const CLIPS = {
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
/** Left-handed clips to mirror into right-handed ones. */
const MIRRORED = { "crouch-left": "crouch-right", "strafe-left": "strafe-right" };
// The arms are placed on the carbine by IK, so no clip keeps its arm tracks.
const ARMS = /^(?:Left|Right)(?:Shoulder|Arm|ForeArm|Hand)$/u;

/**
 * The rig has no finger bones: the hands are flat, as modelled. Roll each
 * closed about two creases across the fingers, so it reads as a grip. The
 * body faces +Z in a T-pose, so fingers run along ±X and close downwards.
 */
const GRIPS = [
  { bone: "LeftHand", creases: [0.132, 0.178], side: 1, turns: [0.9, 1.1] },
  { bone: "RightHand", creases: [0.132, 0.178], side: -1, turns: [1.15, 1.3] },
];
const CREASE_WIDTH = 0.014;

const smoothstep = (lo, hi, v) => {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

const multiply = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const conjugate = ([x, y, z, w]) => [-x, -y, -z, w];
/** A rotation as seen in a mirror across the body's left/right plane. */
const mirror = ([x, y, z, w]) => [x, -y, -z, w];
const twin = (name) =>
  name.startsWith("Left") ? name.replace("Left", "Right") : name.replace(/^Right/u, "Left");

const [source, packed] = process.argv.slice(2);
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

const doc = await io.read(path.join(source, "rigged.glb"));
const root = doc.getRoot();
const [scene] = root.listScenes();
const bones = new Map();
scene.traverse((node) => bones.set(node.getName(), node));
for (const animation of root.listAnimations()) {
  animation.dispose();
}
const [body] = root.listMeshes();
body.setName("soldier");
root
  .listNodes()
  .find((node) => node.getMesh() === body)
  .setName("soldier");
root.listMaterials()[0].setName("soldier");

/** Fold everything merged in so far into the first buffer: a GLB has one. */
const oneBuffer = () => {
  const [buffer, ...spare] = root.listBuffers();
  for (const accessor of root.listAccessors()) {
    accessor.setBuffer(buffer);
  }
  for (const other of spare) {
    other.dispose();
  }
};

// Clips come as whole files of their own: keep their animations, pointed at
// this skeleton, and drop the rest of each.
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

const hips = bones.get("Hips");
const rest = hips.getTranslation();
for (const animation of root.listAnimations()) {
  const name = CLIPS[animation.getName()];
  for (const channel of animation.listChannels()) {
    const bone = channel.getTargetNode();
    const property = channel.getTargetPath();
    const posed = property === "rotation" || (property === "translation" && bone === hips);
    if (!name || !bone || !posed || ARMS.test(bone.getName())) {
      channel.getSampler()?.dispose();
      channel.dispose();
    } else if (property === "translation") {
      // Every clip is played on the spot: the hips keep only their bob.
      const output = channel.getSampler().getOutput();
      for (let i = 0; i < output.getCount(); i += 1) {
        output.setElement(i, [rest[0], output.getElement(i, [])[1], rest[2]]);
      }
    }
  }
  if (name) {
    animation.setName(name);
  } else {
    animation.dispose();
  }
}

// A mirrored clip drives each bone with its twin's track, reflected. The rig
// is not quite symmetric, so reflect the turn away from the twin's rest pose
// and lay it on this bone's own.
for (const animation of root.listAnimations()) {
  const name = MIRRORED[animation.getName()];
  if (!name) {
    continue;
  }
  const flipped = doc.createAnimation(name);
  for (const channel of animation.listChannels()) {
    const from = channel.getTargetNode();
    const to = bones.get(twin(from.getName())) ?? from;
    const sampler = channel.getSampler();
    const output = sampler.getOutput().clone();
    if (channel.getTargetPath() === "rotation") {
      const away = conjugate(from.getRotation());
      for (let i = 0; i < output.getCount(); i += 1) {
        const turn = mirror(multiply(away, output.getElement(i, [])));
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
          .setTargetPath(channel.getTargetPath())
          .setSampler(copy),
      );
  }
}

// Meshy splits a vertex wherever its normal or UV island changes, which
// leaves the simplifier little to collapse. Weld on position and UV alone
// and let the normals be recomputed smooth; the normal map carries the rest.
const faceted = (mesh) => {
  for (const part of mesh.listPrimitives()) {
    part.getAttribute("NORMAL")?.dispose();
    part.getAttribute("TANGENT")?.dispose();
  }
};

/** Area-weighted normals, shared by every vertex at one position so UV seams do not show. */
const smooth = (document, mesh) => {
  for (const part of mesh.listPrimitives()) {
    const points = part.getAttribute("POSITION");
    const indices = part.getIndices().getArray();
    const sums = new Map();
    const keys = [];
    for (let i = 0; i < points.getCount(); i += 1) {
      keys.push(points.getElement(i, []).join(","));
    }
    for (let f = 0; f < indices.length; f += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => points.getElement(indices[f + k], []));
      const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const face = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (let k = 0; k < 3; k += 1) {
        const sum = sums.get(keys[indices[f + k]]) ?? [0, 0, 0];
        sums.set(keys[indices[f + k]], [sum[0] + face[0], sum[1] + face[1], sum[2] + face[2]]);
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
    ratio: SOLDIER_TRIANGLES / (body.listPrimitives()[0].getIndices().getCount() / 3),
    simplifier: MeshoptSimplifier,
  }),
);
smooth(doc, body);

// Close the hands. Bone positions are in the armature's centimetres.
const [primitive] = body.listPrimitives();
const position = primitive.getAttribute("POSITION");
const normal = primitive.getAttribute("NORMAL");
for (const grip of GRIPS) {
  const hand = bones.get(grip.bone);
  const wrist = hand.getWorldTranslation();
  for (let i = 0; i < position.getCount(); i += 1) {
    const [px, py] = position.getElement(i, []);
    // Out past the wrist, at arm height: in a T-pose that is this hand and nothing else.
    if ((px - wrist[0]) * grip.side < 0.08 || Math.abs(py - wrist[1]) > 0.15) {
      continue;
    }
    let p = position.getElement(i, []);
    let n = normal.getElement(i, []);
    // Fingertip crease first, then the knuckles: each turns what lies beyond it.
    for (const k of [1, 0]) {
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

// The carbine: decimated, then stood in its own space — butt plate at the
// origin, bore along -Z, sights up — and scaled to a carbine's length.
const armory = await io.read(path.join(source, "carbine-raw.glb"));
faceted(armory.getRoot().listMeshes()[0]);
await armory.transform(
  weld(),
  simplify({
    error: SIMPLIFY_ERROR,
    ratio:
      CARBINE_TRIANGLES /
      (armory.getRoot().listMeshes()[0].listPrimitives()[0].getIndices().getCount() / 3),
    simplifier: MeshoptSimplifier,
  }),
);
smooth(armory, armory.getRoot().listMeshes()[0]);
mergeDocuments(doc, armory);
oneBuffer();
const carbine = root.listMeshes().find((mesh) => mesh !== body);
carbine.setName("carbine");
carbine.listPrimitives()[0].getMaterial().setName("carbine");
const holder = root.listNodes().find((node) => node.getMesh() === carbine);
holder.setName("carbine");
scene.addChild(holder);
for (const extra of root.listScenes().slice(1)) {
  extra.dispose();
}
{
  // Meshy lays it along X, muzzle towards -X, sights up.
  const [part] = carbine.listPrimitives();
  const points = part.getAttribute("POSITION");
  const normals = part.getAttribute("NORMAL");
  const [min, max] = [points.getMin([]), points.getMax([])];
  const scale = CARBINE_LENGTH / (max[0] - min[0]);
  let bore = 0;
  let count = 0;
  for (let i = 0; i < points.getCount(); i += 1) {
    const [x, y] = points.getElement(i, []);
    if (x < min[0] + (max[0] - min[0]) * 0.03) {
      bore += y;
      count += 1;
    }
  }
  bore /= count;
  for (let i = 0; i < points.getCount(); i += 1) {
    const [x, y, z] = points.getElement(i, []);
    points.setElement(i, [-z * scale, (y - bore) * scale, (x - max[0]) * scale]);
    const [nx, ny, nz] = normals.getElement(i, []);
    normals.setElement(i, [-nz, ny, nx]);
  }
}

/** The soldier's base colour carries the look; everything else holds up at half the size. */
const shrink = (slots, size, pattern = /.*/u) =>
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
