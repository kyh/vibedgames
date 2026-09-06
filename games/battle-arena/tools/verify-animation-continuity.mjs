import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { AnimatedCharacter, ModelLibrary } from "../src/render/models.ts";
import { AnimationEvents, animationWindow } from "../src/render/animation-events.ts";
import { WorldView } from "../src/render/world-view.ts";
import { createWorld, spawnHero } from "../src/sim/world.ts";

// Real GLB geometry, skeletons, tracks and Three mixer. Texture decoding is not
// part of this headless check; one loader plugin substitutes plain materials.
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
class LoadedLibrary extends ModelLibrary {
  loadedModels = new Map();
  loadedClips = new Map();
  instance(name) {
    const model = this.loadedModels.get(name);
    return model ? clone(model) : new THREE.Group();
  }
  getClip(name) {
    return this.loadedClips.get(name);
  }
}
const lib = new LoadedLibrary();
const medium = [
  "General",
  "MovementBasic",
  "MovementAdvanced",
  "CombatMelee",
  "CombatRanged",
  "Special",
];
const large = ["General", "MovementBasic", "MovementAdvanced", "CombatMelee", "Simulation"];
const models = [
  "Knight",
  "Ranger",
  "Mage",
  "Rogue_Hooded",
  "Paladin_with_Helmet",
  "Witch",
  "FrostGolem",
];
await Promise.all([
  ...models.map(async (name) =>
    lib.loadedModels.set(name, (await load(`characters/${name}.glb`)).scene),
  ),
  ...medium.map(async (name) => {
    const gltf = await load(`animations/Rig_Medium_${name}.glb`);
    for (const clip of gltf.animations) lib.loadedClips.set(clip.name, clip);
  }),
  ...large.map(async (name) => {
    const gltf = await load(`animations/Rig_Large_${name}.glb`);
    for (const clip of gltf.animations) lib.loadedClips.set(`Large/${clip.name}`, clip);
  }),
]);
let groups = 0;
{
  const edges = new AnimationEvents();
  assert.equal(edges.observe({ lastCastAt: 0, lastAttackAt: 0 }, 0), null);
  assert.equal(edges.observe({ lastCastAt: 1100, lastAttackAt: 1000 }, 1200)?.kind, "cast");
  assert.equal(
    edges.observe({ lastCastAt: 1100, lastAttackAt: 1000 }, 1216),
    null,
    "older attack consumed with newer cast",
  );
  assert.equal(edges.observe({ lastCastAt: 1300, lastAttackAt: 1350 }, 1400)?.kind, "attack");
  assert.equal(
    edges.observe({ lastCastAt: 5000, lastAttackAt: 5000 }, 2000),
    null,
    "future stamps are not events",
  );
  assert.equal(
    edges.observe({ lastCastAt: 1500, lastAttackAt: 1500 }, 2020),
    null,
    "stale stamps stay quiet",
  );
  for (const age of [0, 100, 300]) {
    const w = animationWindow(1.2, 1.5, { kind: "attack", at: 1000, age });
    assert.equal(w.until, 1800);
    assert.equal(w.offset, (age * 1.5) / 1000);
    assert.ok(Math.abs(w.remaining - (800 - age)) < 0.000001);
  }
  assert.equal(animationWindow(0.4, 1, { kind: "cast", at: 1000, age: 500 }).remaining, 0);
  groups++;
}
{
  for (const name of models) {
    const largeRig = name === "FrostGolem";
    const char = new AnimatedCharacter(lib, name, largeRig ? "Large/" : "");
    const skeletons = [];
    char.root.traverse((object) => {
      if (object instanceof THREE.SkinnedMesh) skeletons.push(object.skeleton);
    });
    assert.ok(skeletons.length > 0, `${name}: actual skinned rig`);
    char.play("Idle_B", { fade: 0 });
    char.update(0.1);
    const shot = largeRig ? "Melee_2H_Attack" : "Ranged_Magic_Shoot";
    char.play(shot, { loop: false, fade: 0.04, offset: 0.2 });
    assert.equal(char.current.time, 0.2);
    char.update(0.01);
    assert.ok(
      Math.abs(char.current.time - 0.21) < 0.000001,
      "render delta remains the only live mixer clock",
    );
    const first = char.current;
    char.play(shot, { loop: false, fade: 0.04 });
    assert.notEqual(char.current, first, "repeated one-shot blends between separate actions");
    assert.equal(char.mixer.stats.actions.inUse, 2);
    char.update(0.05);
    assert.equal(char.mixer.stats.actions.inUse, 1, "outgoing action deactivated after fade");
    const total = char.mixer.stats.actions.total;
    for (let i = 0; i < 40; i++) {
      char.play(shot, { loop: false, fade: 0.04 });
      char.update(0.005);
      assert.ok(
        char.mixer.stats.actions.inUse <= 2,
        "rapid interruptions have bounded active actions",
      );
    }
    assert.equal(
      char.mixer.stats.actions.total,
      total,
      "same-clip repeats reuse two cached actions",
    );
    char.play("Running_B", { fade: 0.1 });
    char.update(0.11);
    char.play("Idle_B", { fade: 0.1 });
    char.update(0.11);
    assert.equal(char.mixer.stats.actions.inUse, 1);
    char.root.updateMatrixWorld(true);
    for (const skeleton of skeletons)
      for (const bone of skeleton.bones)
        assert.ok(
          bone.matrixWorld.elements.every(Number.isFinite),
          `${name}: finite animated bone transforms`,
        );
    char.dispose();
    assert.equal(char.mixer.stats.actions.inUse, 0);
    assert.equal(char.mixer.stats.actions.total, 0);
  }
  groups++;
}
{
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ getContext: () => null }) },
  });
  try {
    const scene = new THREE.Scene();
    const view = new WorldView(scene, lib);
    const world = createWorld(42);
    world.units.clear();
    const unit = spawnHero(world, {
      id: "local",
      ownerId: "local",
      team: "local",
      champId: "mage",
      name: "Mage",
      isBot: false,
      slot: 0,
    });
    view.localId = unit.id;
    unit.x = 0;
    unit.y = 16;
    world.now = 5000;
    view.sync(world, 1 / 60);
    const initial = view.units.get(unit.id);
    assert.ok(initial);
    unit.lastHitAt = world.now;
    unit.lastHitDx = 1;
    unit.lastHitDy = 1;
    view.sync(world, 1 / 60);
    for (let i = 0; i < 180; i++) {
      world.now += 1000 / 60;
      view.sync(world, 1 / 60);
      assert.equal(initial.group.position.x, unit.x, "recoil cannot enter interpolated root");
      assert.equal(initial.group.position.z, unit.y);
      assert.ok(initial.pose.position.length() <= 0.340001);
    }
    assert.ok(initial.pose.position.length() < 0.000001, "recoil settles");
    unit.lastHitAt = world.now;
    view.sync(world, 1 / 60);
    view.sync(world, 1 / 60);
    unit.x += 10;
    view.sync(world, 1 / 60);
    assert.equal(initial.pose.position.length(), 0, "teleport clears recoil");
    unit.alive = false;
    view.sync(world, 1 / 60);
    assert.equal(initial.pose.position.length(), 0, "death clears recoil");
    unit.alive = true;
    view.sync(world, 1 / 60);
    assert.equal(initial.pose.position.length(), 0, "respawn clears recoil");
    unit.champId = "witch";
    view.sync(world, 1 / 60);
    const changed = view.units.get(unit.id);
    assert.notEqual(changed, initial, "same ID, different champion rebuilds model");
    assert.equal(changed.def.model, "Witch");
    assert.equal(initial.char.mixer.stats.actions.total, 0);
    view.localId = "missing";
    view.sync(world, 1 / 60);
    assert.notEqual(
      view.units.get(unit.id),
      changed,
      "local identity changes rebuild highlight owner",
    );
    view.resetCharacters();
    assert.equal(view.units.size, 0);
    world.now = 0;
    unit.lastCastAt = unit.lastAttackAt = unit.lastHitAt = 0;
    view.sync(world, 1 / 60);
    const fresh = view.units.get(unit.id);
    assert.equal(fresh.char.playing, "Spawn_Air", "zero stamps cannot override a fresh spawn");
    assert.equal(fresh.oneShotUntil, fresh.char.clipDuration("Spawn_Air") * 1000);
    world.now = 2000;
    view.sync(world, 1 / 60);
    unit.lastCastAt = 2050;
    unit.lastCastKey = "Q";
    unit.lastAttackAt = 2020;
    world.now = 2150;
    view.sync(world, 1 / 60);
    assert.equal(fresh.char.playing, "Ranged_Magic_Shoot");
    const cast = fresh.char.current;
    const until = fresh.oneShotUntil;
    assert.ok(
      cast.time > 0.1 && cast.time < 0.12,
      "actual view passes accepted event age into mixer",
    );
    world.now += 1000 / 60;
    view.sync(world, 1 / 60);
    assert.equal(fresh.char.current, cast, "older simultaneous attack never replays");
    assert.equal(fresh.oneShotUntil, until);
    view.resetCharacters();
    assert.equal(scene.children.length, 0, "character reset removes owned display objects");
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  }
  groups++;
}
{
  const scene = new THREE.Scene();
  const view = new WorldView(scene, lib);
  const world = createWorld(52);
  world.units.clear();
  world.now = 5000;
  const loot = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2), new THREE.MeshStandardMaterial());
  for (const name of [
    "sword_A",
    "sword_D",
    "axe_A",
    "hammer_B",
    "dagger_A",
    "spear_A",
    "staff_B",
    "wand_B",
  ])
    lib.loadedModels.set(name, loot);
  let lootDisposed = 0;
  loot.geometry.addEventListener("dispose", () => lootDisposed++);
  loot.material.addEventListener("dispose", () => lootDisposed++);
  world.coins = [
    { id: "gold", x: 1, y: 16, fromX: 0, fromY: 0, gold: 10, landAt: 5200, expireAt: 10000 },
    {
      id: "loot",
      x: 2,
      y: 16,
      fromX: 0,
      fromY: 0,
      gold: 10,
      landAt: 0,
      expireAt: 10000,
      loot: true,
    },
  ];
  world.deliveries = [{ id: "drop", x: 3, y: 16, expireAt: 10000 }];
  world.projectiles.set("shot", {
    id: "shot",
    x: 0,
    y: 16,
    vx: 1,
    vy: 0,
    traveled: 0,
    launchH: 0,
    kind: "fireball",
  });
  view.sync(world, 1 / 60);
  const owned = [];
  const gold = view.coins.get("gold");
  owned.push(gold.geometry, gold.material);
  for (const child of view.deliveries.get("drop").children)
    owned.push(child.geometry, child.material);
  const released = owned.map((resource) => {
    const record = { count: 0 };
    resource.addEventListener("dispose", () => record.count++);
    return record;
  });
  const shared = new Set();
  view.projectiles.get("shot").traverse((object) => {
    if (object instanceof THREE.Mesh) {
      shared.add(object.geometry);
      shared.add(object.material);
    }
  });
  let sharedDisposed = 0;
  for (const resource of shared) resource.addEventListener("dispose", () => sharedDisposed++);
  for (const cursor of [view.coinTrailAt, view.coinSparkleAt, view.deliveryEmitAt, view.emberNext])
    cursor.set("old", 5000);
  view.resetCharacters();
  view.resetCharacters();
  assert.equal(scene.children.length, 0);
  assert.equal(
    lootDisposed + sharedDisposed,
    0,
    "library loot and shared projectile resources survive reset",
  );
  for (const record of released)
    assert.equal(record.count, 1, "procedural coin/delivery own resources release once");
  for (const cursor of [
    view.seenCoins,
    view.flyingCoins,
    view.coinTrailAt,
    view.coinSparkleAt,
    view.deliveryEmitAt,
    view.emberNext,
  ])
    assert.equal(cursor.size, 0, "reused IDs start with clean emission/flight cursors");
  view.sync(world, 1 / 60);
  assert.notEqual(view.coins.get("gold"), gold);
  assert.equal(view.flyingCoins.has("gold"), true);
  const nextGold = view.coins.get("gold");
  let removedGold = 0;
  nextGold.geometry.addEventListener("dispose", () => removedGold++);
  world.coins = [];
  world.deliveries = [];
  world.projectiles.clear();
  view.sync(world, 1 / 60);
  assert.equal(removedGold, 1, "normal pickup removal also frees its procedural geometry");
  assert.equal(lootDisposed + sharedDisposed, 0);
  assert.equal(scene.children.length, 0);
  loot.geometry.dispose();
  loot.material.dispose();
  groups++;
}
console.log(
  `✓ ${groups} continuity groups: accepted event ages, seven loaded rigs/Three mixer, recoil, identity and fresh-round reset`,
);
