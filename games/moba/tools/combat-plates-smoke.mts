import assert from "node:assert/strict";
import { layoutHeroPlates } from "../src/render/combat-plates";
import type { HeroPlate } from "../src/render/combat-plates";

const crowd: HeroPlate[] = [
  { id: "enemy", x: 100, y: 100, width: 76, height: 36, priority: "target" },
  { id: "ally", x: 108, y: 108, width: 86, height: 36, priority: "hero" },
  { id: "local", x: 100, y: 100, width: 64, height: 36, priority: "player" },
  { id: "distant", x: 320, y: 100, width: 76, height: 36, priority: "hero" },
];
const before = structuredClone(crowd);
const arranged = layoutHeroPlates(crowd);
assert.deepEqual(crowd, before, "presentation must not mutate its source positions");
assert.equal(arranged.find((p) => p.id === "local")?.lift, 0, "player keeps the primary anchor");
assert.equal(arranged.find((p) => p.id === "distant")?.lift, 0, "unrelated labels stay put");
for (const a of arranged) {
  for (const b of arranged) {
    if (a.id === b.id) continue;
    const overlap =
      Math.abs(a.x - b.x) < (a.width + b.width) / 2 && a.y < b.y + b.height && a.y + a.height > b.y;
    assert.equal(overlap, false, `${a.id} obscures ${b.id}`);
  }
}
assert.deepEqual(
  layoutHeroPlates(crowd.toReversed()),
  arranged,
  "snapshot order cannot swap labels",
);
assert.deepEqual(layoutHeroPlates([]), [], "empty or ended stage leaves no stale labels");
console.log("✓ combat plates: local anchor, crowded separation, stable order, immutable input");
