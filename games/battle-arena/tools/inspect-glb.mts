import { NodeIO } from "@gltf-transform/core";

const file = process.argv.at(2);

if (file === undefined || file === "") {
  throw new Error("usage: node tools/inspect-glb.mts <file.glb> [--clips] [--nodes]");
}

const wantClips = process.argv.includes("--clips");
const wantNodes = process.argv.includes("--nodes");
const doc = await new NodeIO().read(file);
const root = doc.getRoot();
const nodes = root.listNodes();
const meshes = root.listMeshes();
const skins = root.listSkins();
const animations = root.listAnimations();

console.log(`\n== ${file} ==`);

console.log(
  `nodes: ${nodes.length}  meshes: ${meshes.length}  skins: ${skins.length}  anims: ${animations.length}`,
);

if (meshes.length > 0) {
  console.log(`mesh names: ${meshes.map((m) => m.getName()).join(", ")}`);
}

for (const s of skins) {
  const joints = s.listJoints().map((joint) => joint.getName());
  console.log(`skin "${s.getName()}" joints (${joints.length}): ${joints.join(", ")}`);
}

if (wantNodes && nodes.length > 0) {
  console.log(`all node names:\n  ${nodes.map((n, i) => `${i}:${n.getName()}`).join("  ")}`);
}

if (animations.length > 0) {
  console.log(`clips (${animations.length}): ${animations.map((a) => a.getName()).join(", ")}`);
  const [first] = animations;

  if (wantClips && first !== undefined) {
    const targets = [
      ...new Set(first.listChannels().map((c) => c.getTargetNode()?.getName() ?? "?")),
    ];

    console.log(
      `  first clip "${first.getName()}" targets ${targets.length} nodes: ${targets.join(", ")}`,
    );
  }
}
