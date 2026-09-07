import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { ModelLibrary } from "../src/render/models.ts";
import { WorldView } from "../src/render/world-view.ts";
import { createWorld } from "../src/sim/world.ts";
import { encodeWorld } from "../src/net/snapshot.ts";

// Real Large GLB rig, native attack tracks and Three mixer; plain materials
// avoid image decoding. This measures recovery seeking, not visual quality.
const loader = new GLTFLoader();
loader.register(() => ({
  name: "headless-materials",
  loadMaterial: () => Promise.resolve(new THREE.MeshStandardMaterial()),
}));
async function load(path) {
  const bytes = await readFile(new URL(`../public/models/${path}`, import.meta.url));
  return loader.parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
}
const model = (await load("characters/Skeleton_Golem.glb")).scene;
const clips = new Map();
for (const file of ["General", "CombatMelee", "Simulation"])
  for (const clip of (await load(`animations/Rig_Large_${file}.glb`)).animations)
    clips.set(`Large/${clip.name}`, clip);
class Library extends ModelLibrary {
  instance() {
    return clone(model);
  }
  getClip(name) {
    return clips.get(name);
  }
}
assert.equal(clips.has("Large/Throw"), false);
const duration = clips.get("Large/Melee_2H_Attack").duration;
assert.ok(Math.abs(duration - 1.3333333333) < 0.001);
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { createElement: () => ({ getContext: () => null }) },
});
const makeCoin = (id, launchAt, loot = false) => ({
  id,
  x: 5,
  y: 0,
  fromX: 0,
  fromY: 0,
  gold: 300,
  landAt: launchAt + 900,
  expireAt: launchAt + 9900,
  loot,
});
let groups = 0;
try {
  for (const age of [0, 100, 800]) {
    const view = new WorldView(new THREE.Scene(), new Library());
    view.setupBoss();
    const world = createWorld(32);
    world.now = 8000 + age;
    world.coins = [makeCoin("boss", 8000)];
    const before = encodeWorld(world);
    view.syncCoins(world, world.now);
    assert.equal(view.boss.playing, "Melee_2H_Attack");
    assert.ok(Math.abs(view.boss.current.time - (duration * 0.35 + age / 1000)) < 1e-9);
    assert.ok(Math.abs(view.bossReturnAt - (8000 + duration * 0.65 * 1000)) < 1e-9);
    const action = view.boss.current;
    view.boss.update(0.01);
    const time = action.time;
    view.syncCoins(world, world.now + 10);
    assert.equal(view.boss.current, action);
    assert.equal(action.time, time, "duplicate observation cannot restart recovery");
    assert.deepEqual(encodeWorld(world), before);
    view.resetCharacters();
    view.boss.dispose();
    groups++;
  }
  {
    const view = new WorldView(new THREE.Scene(), new Library());
    view.setupBoss();
    const world = createWorld(32);
    world.now = 8200;
    world.coins = [makeCoin("old", 7400), makeCoin("new", 8100), makeCoin("loot", 8200, true)];
    view.syncCoins(world, world.now);
    assert.equal(view.lastBossLaunchAt, 8100);
    assert.ok(Math.abs(view.boss.current.time - (duration * 0.35 + 0.1)) < 1e-9);
    const action = view.boss.current;
    world.coins = [];
    view.syncCoins(world, world.now);
    world.coins = [makeCoin("old-reintroduced", 8000)];
    view.syncCoins(world, world.now);
    assert.equal(view.boss.current, action, "older launch cannot interrupt a newer recovery");
    view.resetCharacters();
    assert.equal(view.lastBossLaunchAt, -Infinity);
    world.now = 8000;
    world.coins = [makeCoin("new-round", 8000)];
    view.syncCoins(world, world.now);
    assert.equal(view.lastBossLaunchAt, 8000);
    view.resetCharacters();
    view.boss.dispose();
    groups++;
  }
  {
    const view = new WorldView(new THREE.Scene(), new Library());
    view.setupBoss();
    const world = createWorld(32);
    world.now = 10000;
    world.coins = [makeCoin("landed", 8000), makeCoin("loot", 10000, true)];
    view.syncCoins(world, world.now);
    assert.equal(view.boss.playing, "Idle_B");
    assert.equal(view.bossReturnAt, 0);
    view.resetCharacters();
    view.boss.dispose();
    groups++;
  }
} finally {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete globalThis.document;
}
console.log(
  `✓ ${groups} boss groups: original Large rig, release/late recovery, duplicates, multi-coin ordering, rematch, landed/loot silence`,
);
