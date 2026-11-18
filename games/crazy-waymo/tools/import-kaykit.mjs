import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const args = process.argv.slice(2);

for (let i = 0; i + 1 < args.length; i += 2) {
  const doc = await io.read(args[i]);
  await io.write(args[i + 1], doc);
  console.log(`${args[i].split("/").pop()} -> ${args[i + 1]}`);
}
