import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { CHAMPIONS } from "../src/data/champions.ts";
import { HOP_HEIGHT, JUMP_MS } from "../src/data/config.ts";
import { ModelLibrary } from "../src/render/models.ts";
import { WorldView } from "../src/render/world-view.ts";
import { createWorld, spawnHero } from "../src/sim/world.ts";

// Original geometry and skeletons; material substitution avoids DOM texture
// decoding. This proves anchor ownership, not screen composition.
const loader = new GLTFLoader();
loader.register(() => ({
  name: "headless-materials",
  loadMaterial: () => Promise.resolve(new THREE.MeshStandardMaterial()),
}));
const bodies = new Map();
for (const champion of CHAMPIONS) {
  const bytes = await readFile(
    new URL(`../public/models/characters/${champion.model}.glb`, import.meta.url),
  );
  const gltf = await loader.parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  bodies.set(champion.model, gltf.scene);
}
class GeometryLibrary extends ModelLibrary {
  instance(name) {
    const body = bodies.get(name);
    return body ? clone(body) : new THREE.Group();
  }
}
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { createElement: () => ({ getContext: () => null }) },
});
const originalMeasure = THREE.Box3.prototype.setFromObject;
const originalTextureLoad = THREE.TextureLoader.prototype.load;
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
let measurements = 0;
THREE.Box3.prototype.setFromObject = function (...args) {
  measurements++;
  return originalMeasure.apply(this, args);
};
const view = new WorldView(new THREE.Scene(), new GeometryLibrary());
try {
  const world = createWorld(42);
  world.units.clear();
  const heroes = CHAMPIONS.map((champion, index) => {
    const unit = spawnHero(world, {
      id: champion.id,
      ownerId: champion.id,
      team: champion.id,
      champId: champion.id,
      name: champion.name,
      slot: index,
      isBot: false,
    });
    unit.x = index * 3;
    unit.y = 16;
    return unit;
  });
  world.now = 5000;
  const before = structuredClone([...world.units.values()]);
  view.sync(world, 1 / 60);
  assert.deepEqual([...world.units.values()], before, "anchor construction is render-only");
  const bodyHeights = [];
  for (const hero of heroes) {
    const rendered = view.units.get(hero.id);
    assert.ok(rendered);
    const anchor = view.plateAnchor(hero.id);
    assert.ok(anchor);
    assert.equal(view.plateAnchor(hero.id), anchor, "same cached point across reads");
    const body = bodies.get(rendered.def.model);
    assert.ok(body);
    const reference = clone(body);
    reference.scale.setScalar(rendered.def.scale ?? 1);
    reference.updateWorldMatrix(true, true);
    const bodyTop = new THREE.Box3().setFromObject(reference).max.y;
    assert.ok(
      Math.abs(anchor.y - rendered.group.position.y - bodyTop - 0.12) < 1e-6,
      `${hero.champId}: anchor follows original body top, without weapon bounds`,
    );
    bodyHeights.push(Number(bodyTop.toFixed(3)));
  }
  const measuredAtConstruction = measurements;
  for (let frame = 0; frame < 120; frame++) {
    world.now += 1000 / 60;
    for (const hero of heroes) hero.x += 0.01;
    view.sync(world, 1 / 60);
    for (const hero of heroes) {
      const anchor = view.plateAnchor(hero.id);
      const root = view.units.get(hero.id).group.position;
      assert.deepEqual([anchor.x, anchor.z], [root.x, root.z]);
    }
  }
  assert.equal(
    measurements,
    measuredAtConstruction,
    "no bounds traversals in live updates or plate reads",
  );
  const hero = heroes[0];
  const anchor = view.plateAnchor(hero.id);
  const restY = anchor.y;
  hero.jumpUntil = world.now + JUMP_MS / 2;
  view.sync(world, 1 / 60);
  assert.ok(
    Math.abs(view.plateAnchor(hero.id).y - restY - HOP_HEIGHT) < 1e-6,
    "actual hop arc carries plate",
  );
  hero.jumpUntil = 0;
  hero.x = -20;
  hero.y = 0;
  view.sync(world, 1 / 60);
  assert.equal(view.plateAnchor(hero.id).x, -20, "teleport snaps plate with the rendered actor");
  const retained = view.plateAnchor(hero.id);
  view.resetCharacters();
  assert.equal(view.plateAnchor(hero.id), null, "rematch removes old anchor owners");
  view.sync(world, 1 / 60);
  assert.notEqual(view.plateAnchor(hero.id), retained, "same ID obtains a fresh render owner");
  world.units.clear();
  view.sync(world, 1 / 60);
  assert.equal(
    view.plateAnchor(hero.id),
    null,
    "snapshot removal cannot expose stale plate points",
  );
  console.log(
    `Head anchors PASS: six actual GLBs; heights ${bodyHeights.join(", ")}; 120 live updates without remeasurement; hop/teleport/reset/removal.`,
  );
} finally {
  view.resetCharacters();
  THREE.Box3.prototype.setFromObject = originalMeasure;
  THREE.TextureLoader.prototype.load = originalTextureLoad;
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
}
