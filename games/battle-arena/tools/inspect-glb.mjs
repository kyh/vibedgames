// Read-only GLB introspection: parse the JSON chunk directly (no gltf-transform).
// Usage: node tools/inspect-glb.mjs <file.glb> [--clips] [--nodes]
import { readFileSync } from "node:fs";

function parseGlb(path) {
  const buf = readFileSync(path);
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error(`not a GLB: ${path}`);
  let off = 12;
  let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    off += 8 + len;
  }
  if (!json) throw new Error("no JSON chunk");
  return json;
}

const file = process.argv[2];
const wantClips = process.argv.includes("--clips");
const wantNodes = process.argv.includes("--nodes");
const g = parseGlb(file);
const nodeName = (i) => g.nodes?.[i]?.name ?? `#${i}`;

console.log(`\n== ${file} ==`);
console.log(
  `nodes: ${g.nodes?.length ?? 0}  meshes: ${g.meshes?.length ?? 0}  skins: ${g.skins?.length ?? 0}  anims: ${g.animations?.length ?? 0}`,
);
if (g.meshes) console.log(`mesh names: ${g.meshes.map((m) => m.name).join(", ")}`);
if (g.skins) {
  for (const s of g.skins) {
    const joints = s.joints.map(nodeName);
    console.log(`skin "${s.name ?? ""}" joints (${joints.length}): ${joints.join(", ")}`);
  }
}
if (wantNodes && g.nodes) {
  console.log(`all node names:\n  ${g.nodes.map((n, i) => `${i}:${n.name ?? "?"}`).join("  ")}`);
}
if (g.animations) {
  console.log(`clips (${g.animations.length}): ${g.animations.map((a) => a.name).join(", ")}`);
  if (wantClips && g.animations[0]) {
    const a = g.animations[0];
    const targets = [...new Set(a.channels.map((c) => nodeName(c.target.node)))];
    console.log(`  first clip "${a.name}" targets ${targets.length} nodes: ${targets.join(", ")}`);
  }
}
