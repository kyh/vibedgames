import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ArenaMaterials, arenaSurface, floorVariation } from "../src/render/arena-materials.ts";
import { Environment } from "../src/render/environment.ts";
import { ModelLibrary } from "../src/render/models.ts";
import { View } from "../src/render/view.ts";

let groups = 0;
{
  const owner = new ArenaMaterials();
  const texture = new THREE.Texture();
  const source = new THREE.MeshStandardMaterial({ color: 0xcabb9f, roughness: 0.45, map: texture });
  let sourceDisposed = 0;
  source.addEventListener("dispose", () => sourceDisposed++);
  const before = {
    color: source.color.getHex(),
    roughness: source.roughness,
    env: source.envMapIntensity,
  };
  const floor = owner.grade(source, "floor");
  const wall = owner.grade(source, "stone");
  assert.notEqual(floor, source);
  assert.notEqual(floor, wall);
  assert.equal(owner.grade(source, "floor"), floor);
  assert.equal(floor.map, texture);
  assert.deepEqual(
    { color: source.color.getHex(), roughness: source.roughness, env: source.envMapIntensity },
    before,
  );
  const metal = new THREE.MeshStandardMaterial({ color: 0xffcc66, metalness: 1, roughness: 0.25 });
  assert.equal(owner.grade(metal, "stone"), metal, "authored metallic response retained");
  for (const name of [
    "Knight",
    "Paladin_with_Helmet",
    "Witch",
    "sword_2handed",
    "rocks_gold",
    "banner_red",
  ])
    assert.equal(arenaSurface(name), null);
  assert.equal(arenaSurface("wall_arched"), "stone");
  assert.equal(arenaSurface("floor_dirt_large"), "dirt");
  const colors = new Set();
  for (let x = -40; x <= 40; x += 4)
    for (let z = -40; z <= 40; z += 4) {
      const color = floorVariation(x, z, new THREE.Color());
      assert.deepEqual(color, floorVariation(x, z, new THREE.Color()));
      for (const component of color.toArray()) assert.ok(component >= 0.954 && component <= 1.046);
      colors.add(color.r);
    }
  assert.ok(colors.size > 100, "deterministic small variation, not a constant tint");
  let floorDisposed = 0;
  let wallDisposed = 0;
  floor.addEventListener("dispose", () => floorDisposed++);
  wall.addEventListener("dispose", () => wallDisposed++);
  owner.dispose();
  owner.dispose();
  assert.equal(floorDisposed, 1);
  assert.equal(wallDisposed, 1);
  assert.equal(sourceDisposed, 0);
  source.dispose();
  metal.dispose();
  texture.dispose();
  groups++;
}

// Real floor vertex/index data. Plain loader materials replace image decoding
// only; this is geometry/resource verification, not a lighting screenshot.
const loader = new GLTFLoader();
const originalProgress = Object.getOwnPropertyDescriptor(globalThis, "ProgressEvent");
Object.defineProperty(globalThis, "ProgressEvent", {
  configurable: true,
  value: class extends Event {
    constructor(type, details) {
      super(type);
      Object.assign(this, details);
    }
  },
});
loader.register(() => ({
  name: "headless-materials",
  loadMaterial: () =>
    Promise.resolve(new THREE.MeshStandardMaterial({ color: 0xcabb9f, roughness: 0.45 })),
}));
const templates = new Map();
for (const name of [
  "floor_tile_large",
  "floor_tile_large_rocks",
  "floor_dirt_large",
  "floor_tile_big_grate",
]) {
  const url = new URL(`../public/models/dungeon/${name}.gltf`, import.meta.url);
  const json = JSON.parse(await readFile(url, "utf8"));
  for (const buffer of json.buffers ?? []) {
    if (!buffer.uri || buffer.uri.startsWith("data:")) continue;
    buffer.uri = `data:application/octet-stream;base64,${(await readFile(new URL(buffer.uri, url))).toString("base64")}`;
  }
  templates.set(name, (await loader.parseAsync(JSON.stringify(json), "")).scene);
}
class FloorLibrary extends ModelLibrary {
  fallback = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ roughness: 0.45 }),
  );
  instance(name) {
    return (templates.get(name) ?? this.fallback).clone(true);
  }
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const query = { matches: false };
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { matchMedia: () => query },
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { createElement: () => ({ getContext: () => null }) },
});
try {
  const lib = new FloorLibrary();
  const sourceColors = new Map();
  for (const model of templates.values())
    model.traverse((object) => {
      if (object instanceof THREE.Mesh)
        sourceColors.set(object.material, object.material.color.getHex());
    });
  const scene = new THREE.Scene();
  const env = new Environment(scene, lib, { decor: false, obstacles: false });
  // Late architecture I/O has its own disposal guard; omitted from this local
  // ownership fixture. Actual floor/platform/lights/ambient builders still run.
  env.initArchitecture = async () => {};
  env.setup();
  assert.equal(scene.children.filter((object) => object instanceof THREE.PointLight).length, 7);
  const counts = env.floorMeshes.map((mesh) => mesh.count);
  assert.equal(counts.length, 4);
  const matrices = env.floorMeshes.map((mesh) => Array.from(mesh.instanceMatrix.array));
  const colors = env.floorMeshes.map((mesh) => Array.from(mesh.instanceColor.array));
  const materials = env.floorMeshes.map((mesh) => mesh.material);
  const totalGeometry = env.ownedGeos.length;
  const totalObjects = env.added.length;
  const retired = [];
  for (let i = 0; i < 3; i++) {
    for (const geometry of env.floorGeos) {
      const record = { count: 0 };
      geometry.addEventListener("dispose", () => record.count++);
      retired.push(record);
    }
    env.rebuildFloor();
    assert.deepEqual(
      env.floorMeshes.map((mesh) => mesh.count),
      counts,
    );
    assert.deepEqual(
      env.floorMeshes.map((mesh) => Array.from(mesh.instanceMatrix.array)),
      matrices,
    );
    assert.deepEqual(
      env.floorMeshes.map((mesh) => Array.from(mesh.instanceColor.array)),
      colors,
    );
    assert.deepEqual(
      env.floorMeshes.map((mesh) => mesh.material),
      materials,
      "rebuild retains owned category materials",
    );
    assert.equal(env.ownedGeos.length, totalGeometry);
    assert.equal(env.added.length, totalObjects);
  }
  for (const record of retired)
    assert.equal(record.count, 1, "retired floor geometry released once");
  for (const [material, color] of sourceColors) assert.equal(material.color.getHex(), color);
  env.update(1);
  query.matches = true;
  env.update(2);
  const lights = env.flames.map((light) => light.intensity);
  const motes = Array.from(env.motePos);
  env.update(3);
  assert.deepEqual(
    env.flames.map((light) => light.intensity),
    lights,
    "live reduced motion settles flicker",
  );
  assert.deepEqual(Array.from(env.motePos), motes);
  const owned = [...env.ownedGeos, ...env.ownedMats, ...materials];
  const released = owned.map((resource) => {
    const record = { count: 0 };
    resource.addEventListener("dispose", () => record.count++);
    return record;
  });
  env.dispose();
  env.dispose();
  assert.equal(scene.children.length, 0);
  for (const record of released) assert.equal(record.count, 1);
  const second = new Environment(scene, lib, { decor: false, obstacles: false });
  second.buildFloor();
  assert.deepEqual(
    second.floorMeshes.map((mesh) => mesh.count),
    counts,
  );
  assert.notEqual(
    second.floorMeshes[0].material,
    materials[0],
    "new scene owns a new material generation",
  );
  second.dispose();
  for (const [material, color] of sourceColors) assert.equal(material.color.getHex(), color);
  groups++;

  const camera = new THREE.PerspectiveCamera();
  camera.position.set(3, 4, 5);
  const view = Object.assign(Object.create(View.prototype), {
    reducedMotion: query,
    camera,
    introT: 1.2,
    shake: 1,
    shakeT: 3,
    fovPunch: 4,
    flashAmt: 0.3,
    vigPunch: 0.2,
    kickVec: new THREE.Vector3(1, 2, 3),
    shakeOff: new THREE.Vector3(2, 3, 4),
    bloom: { strength: 1.1 },
    grade: { uniforms: { uFlash: { value: 0.3 }, uVignette: { value: 0.4 } } },
  });
  view.resetImpulses();
  assert.deepEqual(camera.position.toArray(), [3, 4, 5]);
  assert.equal(view.introT, 1.2);
  assert.equal(view.kickVec.length(), 0);
  assert.equal(view.shakeOff.length(), 0);
  assert.equal(view.fovPunch + view.flashAmt + view.vigPunch + view.shake + view.shakeT, 0);
  view.addTrauma(1);
  view.kick(1, 0, 2);
  view.punchFov(4);
  view.screenPulse(0.3, 0.2);
  assert.equal(view.fovPunch + view.flashAmt + view.vigPunch + view.shake, 0);
  assert.equal(view.kickVec.length(), 0);
  query.matches = false;
  view.addTrauma(0.4);
  view.kick(1, 0, 0.5);
  view.punchFov(2);
  view.screenPulse(0.1, 0.1);
  assert.equal(view.shake, 0.4);
  assert.equal(view.kickVec.length(), 0.5);
  assert.equal(view.fovPunch, 2);
  groups++;

  for (const initialRatio of [0.8, 1, 1.1, 1.5, 2]) {
    const rendererRatios = [];
    const composerRatios = [];
    const adaptive = Object.assign(Object.create(View.prototype), {
      prNow: initialRatio,
      prStep: 0,
      dtAvg: 1 / 30,
      renderer: { setPixelRatio: (ratio) => rendererRatios.push(ratio) },
      composer: { setPixelRatio: (ratio) => composerRatios.push(ratio) },
      fxaa: null,
    });
    for (let i = 0; i < 6; i++) adaptive.samplePerf(1 / 30);
    assert.deepEqual(rendererRatios, [Math.min(1.5, initialRatio), Math.min(1.25, initialRatio)]);
    assert.deepEqual(composerRatios, rendererRatios);
    assert.equal(adaptive.prNow, Math.min(1.25, initialRatio));
    assert.equal(adaptive.prStep, 2);
    assert.ok(
      rendererRatios.every((ratio) => ratio <= initialRatio),
      "low FPS never adds pixels",
    );
  }
  groups++;
} finally {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete globalThis.document;
  if (originalProgress) Object.defineProperty(globalThis, "ProgressEvent", originalProgress);
  else delete globalThis.ProgressEvent;
}
console.log(
  `✓ ${groups} arena material groups: source ownership, actual floor geometry/rebuild, 7 lights, disposal, live reduced motion, camera reset and monotonic adaptive DPR`,
);
