import assert from "node:assert/strict";
import * as THREE from "three";
import { Fx } from "../src/render/fx.ts";
import { ParticlePools } from "../src/render/fx-particles.ts";
import { ChunkPool } from "../src/render/fx-chunks.ts";
import { SpikePool } from "../src/render/fx-spikes.ts";
import { BoltPool } from "../src/render/fx-bolt.ts";
import { PillarPool } from "../src/render/fx-pillar.ts";
import { VoidPool } from "../src/render/fx-void.ts";
import { RibbonPool } from "../src/render/fx-ribbon.ts";
import { createBrewPoolMaterial } from "../src/render/fx-pool.ts";
import { Telegraphs } from "../src/render/telegraph.ts";

// Real Three pools and the actual Fx reset method. DOM numbers/audio/camera
// are explicit collaborators; no renderer or speaker claim from this fixture.
const scene = new THREE.Scene();
const pools = new ParticlePools(scene);
const chunks = new ChunkPool(scene);
const spikes = new SpikePool(scene);
const bolts = new BoltPool(scene, { value: 0 });
const pillars = new PillarPool(scene, { value: 0 });
const voids = new VoidPool(scene, { value: 0 });
const ribbons = new RibbonPool(scene, { value: 0 });
const spellMeshes = [
  ...pillars.pillars.flatMap((p) => [p.column, p.star, ...p.halos.map((h) => h.mesh)]),
  ...voids.holes.map((h) => h.mesh),
  ...ribbons.ribbons.map((r) => r.mesh),
];
const spellResources = new Map();
for (const mesh of spellMeshes) {
  for (const resource of [mesh.geometry, mesh.material]) {
    if (spellResources.has(resource)) continue;
    spellResources.set(resource, 0);
    resource.addEventListener("dispose", () =>
      spellResources.set(resource, spellResources.get(resource) + 1),
    );
  }
}
const brewGeo = new THREE.PlaneGeometry(2, 2);
const brewMaterials = [];
const brewDisposals = new Map();
const telegraphs = new Telegraphs(scene);
let numberClears = 0;
let cameraClears = 0;
let actorDisposals = 0;
let zoneDisposals = 0;
let oldDelayedCalls = 0;
const transient = (key) => {
  const object = new THREE.Group();
  scene.add(object);
  return { life: 3, [key]: object };
};
const actor = new THREE.Group();
const zone = new THREE.Group();
scene.add(actor, zone);
const actorMaterial = new THREE.MeshBasicMaterial();
actorMaterial.addEventListener("dispose", () => actorDisposals++);
const zoneMaterial = new THREE.MeshBasicMaterial();
zoneMaterial.addEventListener("dispose", () => zoneDisposals++);
const fx = Object.assign(Object.create(Fx.prototype), {
  disposed: false,
  scene,
  pools,
  chunks,
  spikes,
  bolts,
  pillars,
  voids,
  ribbons,
  brewPools: new Map(),
  telegraphs,
  numbers: { clear: () => numberClears++ },
  view: { resetImpulses: () => cameraClears++ },
  audio: { identity: "retained" },
  delayed: [{ at: 999, run: () => oldDelayedCalls++ }],
  feed: [{}],
  toasts: [{}],
  localHits: [{}],
  zoneAnim: new Map([["old-zone", { next: 10000 }]]),
  zonePieces: new Map([["old-zone", { obj: zone, ownMat: zoneMaterial }]]),
  clock: 100,
  nowMs: 100000,
  zoneSweepAt: 102,
  hardFreeze: 1,
  slowMo: 1,
  bestStreak: 8,
  hitsThisFrame: 2,
  heavyThisFrame: true,
  lastDeath: { killerName: "old" },
  rings: [transient("mesh")],
  beams: [transient("mesh")],
  domes: [transient("mesh")],
  cracks: [transient("mesh")],
  cones: [transient("pivot")],
  slashes: [transient("pivot")],
  flares: [transient("sprite")],
  texActors: [
    { obj: actor, mats: [actorMaterial], life: 2, tick: () => assert.fail("old actor tick") },
  ],
});
const audio = fx.audio;
const spawn = () => {
  for (let i = 0; i < 600; i++)
    pools.spawn("add", { x: 1, y: 1, z: 1, size: 1, life: 5, priority: "major" });
  pools.spawn("normal", { x: 1, y: 1, z: 1, size: 1, life: 5 });
  chunks.burst(0, 0, 64, 0xffffff);
  spikes.erupt(0, 0, 4, 20, 0xffffff);
  bolts.strike(new THREE.Vector3(0, 8, 0), new THREE.Vector3(), { life: 3 });
  for (let i = 0; i < pillars.pillars.length; i++) pillars.strike(i, 0, 2, 3);
  for (let i = 0; i < voids.holes.length; i++) voids.open(i, 0, 3, 4);
  for (let i = 0; i < ribbons.ribbons.length; i++) ribbons.follow(`bolt-${i}`, i, 1, 4, 1, 0, 3);
  assert.ok(
    ribbons.ribbons.every((r) => r.uni.uFade.value === 1),
    "new round wakes start fully lit",
  );
  pillars.update(0.4);
  voids.update(0.4);
  ribbons.update(0.1);
  ribbons.update(0.1); // reset must reclaim both followed and dissolving wakes
  ribbons.follow("bolt-0", 9, 1, 4, 1, 0, 3);
  const brewMaterial = createBrewPoolMaterial({ value: 100 });
  const brewMesh = new THREE.Mesh(brewGeo, brewMaterial);
  scene.add(brewMesh);
  brewMaterials.push(brewMaterial);
  brewDisposals.set(brewMaterial, 0);
  brewMaterial.addEventListener("dispose", () =>
    brewDisposals.set(brewMaterial, brewDisposals.get(brewMaterial) + 1),
  );
  fx.zonePieces.set("same-brew-id", { obj: brewMesh, ownMat: brewMaterial, seenAt: 100000 });
  fx.brewPools.set("same-brew-id", brewMaterial);
  telegraphs.mark("same-round-id", 0, 0, 3, 0xffffff, 1);
  telegraphs.spawnResidue(1, 1, 2, 0xffffff, 4);
  chunks.update(0.016);
  spikes.update(0.016);
};
for (let round = 0; round < 3; round++) {
  spawn();
  assert.equal(pools.counts().add.active, 512);
  assert.ok(chunks.active.length > 0 && spikes.active.length > 0);
  assert.ok(bolts.bolts.some((b) => b.core.visible));
  assert.ok(
    spellMeshes.every((mesh) => mesh.visible),
    "all added spell slots reusable before reset",
  );
  fx.resetMatch();
  assert.ok(
    spellMeshes.every((mesh) => !mesh.visible),
    "rematch hides pillar, void and ribbon effects immediately",
  );
  assert.ok(pillars.pillars.every((p) => !p.live && p.t === 0));
  assert.ok(voids.holes.every((h) => !h.live && h.t === 0 && h.life === 0));
  assert.ok(ribbons.ribbons.every((r) => r.id === "" && !r.fed && r.loose === 0));
  assert.equal(fx.brewPools.size, 0, "no stale disposed material lookup across reused zone ids");
  pillars.update(0.2);
  voids.update(0.2);
  ribbons.update(0.2);
  assert.ok(
    spellMeshes.every((mesh) => !mesh.visible),
    "old effects cannot resume after the clock restarts",
  );
  assert.ok(
    [...spellResources.values()].every((count) => count === 0),
    "reset retains all pooled resources",
  );
  assert.ok(
    [...brewDisposals.values()].every((count) => count === 1),
    "zone owns each brew material once",
  );
  fx.resetMatch();
  assert.equal(pools.counts().add.active + pools.counts().normal.active, 0);
  assert.equal(chunks.active.length + spikes.active.length, 0);
  assert.ok(bolts.bolts.every((b) => b.life === 0 && !b.core.visible && !b.glow.visible));
  assert.ok(
    telegraphs.decals.every((d) => !d.mesh.visible && d.zoneId === null && d.residueLife === 0),
  );
  assert.equal(new Set(telegraphs.free).size, telegraphs.decals.length);
  assert.equal(telegraphs.zoneById.size, 0);
  assert.equal(fx.delayed.length + fx.feed.length + fx.toasts.length + fx.localHits.length, 0);
  assert.equal(fx.zoneAnim.size + fx.zonePieces.size + fx.texActors.length, 0);
  assert.equal(fx.scaleNow(), 1);
  assert.equal(fx.clock + fx.nowMs + fx.zoneSweepAt + fx.bestStreak, 0);
  assert.equal(fx.lastDeath, null);
  assert.equal(fx.audio, audio);
  assert.ok(
    scene.children.filter((o) => o instanceof THREE.InstancedMesh).every((o) => o.count === 0),
  );
}
for (const kind of ["rings", "beams", "domes", "cracks", "cones", "slashes", "flares"])
  for (const item of fx[kind])
    assert.equal((item.mesh ?? item.pivot ?? item.sprite).visible, false);
assert.equal(actor.parent, null);
assert.equal(zone.parent, null);
assert.equal(actorDisposals, 1);
assert.equal(zoneDisposals, 1);
assert.equal(oldDelayedCalls, 0);
assert.equal(numberClears, 6);
assert.equal(cameraClears, 6);
assert.equal(new Set(brewMaterials).size, 3);
for (const resource of [pools, chunks, spikes, bolts, pillars, voids, ribbons, telegraphs])
  resource.dispose();
assert.ok(
  [...spellResources.values()].every((count) => count === 1),
  "final disposal releases retained resources once",
);
assert.ok(spellMeshes.every((mesh) => mesh.parent === null));
brewGeo.dispose();
console.log(
  "✓ real rematch FX: three saturated reuse cycles including pillar/void/ribbon/brew, stale clocks/queues cleared, pooled resources retained then freed once, audio retained",
);
