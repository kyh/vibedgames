// Packs the soldier for the web: the rigged mesh and clips Meshy returned for
// our own generated soldier, the atlas graded and compressed.
//
//   node tools/build-soldier.mjs <dir> public/models/soldier.glb
//
// <dir> holds Meshy's downloads — clips.glb (the merged animation task),
// walking.glb and running.glb (the rigging task's basic animations) — and
// atlas.png, the model's original 4096² texture.
import path from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTTextureWebP } from "@gltf-transform/extensions";
import { dedup, meshopt, mergeDocuments, prune, resample } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

const ATLAS_SIZE = 1024;

/** Meshy's clip names → ours. Anything else in the files is dropped. */
const CLIPS = {
  "Armature|running|baselayer": "jog",
  "Armature|walking_man|baselayer": "walk",
  Cautious_Crouch_Walk_Forward: "crouch-walk",
  Hit_Reaction: "hit",
  RunFast: "sprint",
  Shot_and_Fall_Backward: "death",
  Walk_Backward_with_Gun: "back",
};
// The carbine is part of the mesh, weighted across both hands and the chest:
// it only keeps its shape while the arms hold the pose they were rigged in.
const ARMS = /^(?:Left|Right)(?:Shoulder|Arm|ForeArm|Hand)$/u;
/** The fall travels; everything else is played on the spot. */
const TRAVELS = new Set(["death"]);

/**
 * The bake left an iridescent pink, purple and teal sheen over black gear.
 * Drain it to neutral; keep some of the warm hues (leather, wood, skin).
 */
const gradeAtlas = async (file) => {
  const { data, info } = await sharp(file)
    .resize(ATLAS_SIZE, ATLAS_SIZE)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 3) {
    const [r, g, b] = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
    const max = Math.max(r, g, b);
    const spread = max - Math.min(r, g, b);
    if (spread < 0.02) {
      continue;
    }
    let hue = 0;
    if (max === r) {
      hue = ((g - b) / spread + 6) % 6;
    } else if (max === g) {
      hue = (b - r) / spread + 2;
    } else {
      hue = (r - g) / spread + 4;
    }
    const keep = hue * 60 >= 8 && hue * 60 <= 52 ? 0.55 : 0.1;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    data[i] = Math.round(255 * (luma + (r - luma) * keep));
    data[i + 1] = Math.round(255 * (luma + (g - luma) * keep));
    data[i + 2] = Math.round(255 * (luma + (b - luma) * keep));
  }
  return sharp(data, { raw: info }).webp({ quality: 82 }).toBuffer();
};

const [source, packed] = process.argv.slice(2);
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

const doc = await io.read(path.join(source, "clips.glb"));
const root = doc.getRoot();
const [scene] = root.listScenes();
const bones = new Map();
scene.traverse((node) => bones.set(node.getName(), node));

// The basic walk and run come as whole files of their own: keep their clips,
// pointed at this skeleton, and drop the rest of each.
for (const file of ["walking.glb", "running.glb"]) {
  mergeDocuments(doc, await io.read(path.join(source, file)));
}
for (const animation of root.listAnimations()) {
  for (const channel of animation.listChannels()) {
    channel.setTargetNode(bones.get(channel.getTargetNode()?.getName() ?? "") ?? null);
  }
}
for (const extra of root.listScenes().slice(1)) {
  extra.traverse((node) => node.dispose());
  extra.dispose();
}
const [buffer, ...spare] = root.listBuffers();
for (const accessor of root.listAccessors()) {
  accessor.setBuffer(buffer);
}
for (const other of spare) {
  other.dispose();
}

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
    } else if (property === "translation" && !TRAVELS.has(name)) {
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

const [texture] = root.listTextures();
texture.setImage(await gradeAtlas(path.join(source, "atlas.png"))).setMimeType("image/webp");
doc.createExtension(EXTTextureWebP).setRequired(true);
for (const material of root.listMaterials()) {
  material.setName("soldier");
}

await doc.transform(
  prune(),
  dedup(),
  resample({ tolerance: 1e-4 }),
  meshopt({ encoder: MeshoptEncoder, level: "medium" }),
);
await io.write(packed, doc);
