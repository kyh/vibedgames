// After a ?bake=1 run: split oversized world artifacts into <=9MB parts
// (the platform caps files at 10MB).  node tools/split-world-bin.mjs
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const PART = 9 * 1024 * 1024;
for (const name of ["rest.bin", "world.bin"]) {
  const path = `public/world/${name}`;
  if (!existsSync(path)) continue;
  const data = readFileSync(path);
  if (data.length <= PART) continue;
  const n = Math.ceil(data.length / PART);
  for (let i = 0; i < n; i++) {
    writeFileSync(`${path}.${i}`, data.subarray(i * PART, (i + 1) * PART));
  }
  rmSync(path);
  writeFileSync(path.replace(".bin", ".parts"), String(n));
  console.log(`${name}: ${n} parts`);
}
