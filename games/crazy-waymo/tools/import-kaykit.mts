import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { inOrder } from "../src/shared/paced.ts";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const args = process.argv.slice(2);

const pairs = args.flatMap((from, i) => {
  const to = args[i + 1];

  return i % 2 === 0 && to !== undefined ? [{ from, to }] : [];
});

for await (const { from, to } of inOrder(pairs)) {
  const doc = await io.read(from);
  await io.write(to, doc);
  console.log(`${from.split("/").pop()} -> ${to}`);
}
