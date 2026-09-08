import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { admitFx } from "../src/render/fx-priority.ts";
import { burstLifetime, burstStage } from "../src/render/combat-visuals.ts";

const Phaser = {
  BlendModes: { ADD: 1 },
  Scenes: { Events: { SHUTDOWN: "shutdown", DESTROY: "destroy" } },
};
function load(name, path, scope = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const code = stripTypeScriptTypes(source.replace(/^import[^;]+;$/gm, ""), {
    mode: "transform",
  }).replace(/^export /gm, "");
  return new Function("Phaser", ...Object.keys(scope), `${code}; return ${name};`)(
    Phaser,
    ...Object.values(scope),
  );
}
const BattleFx = load("BattleFx", "../src/render/battle-fx.ts", {
  admitFx,
  burstLifetime,
  burstStage,
});
const BattleBackdrop = load("BattleBackdrop", "../src/render/battle-backdrop.ts");

function fixture() {
  const motion = { matches: false };
  globalThis.window = { matchMedia: () => motion };
  const graphics = [];
  const images = [];
  const scene = {
    time: { now: 0 },
    events: new EventEmitter(),
    cameras: {
      main: {
        scrollX: 0,
        scrollY: 0,
        width: 1280,
        height: 720,
        zoom: 1,
        worldView: { x: -1000, y: -1000, right: 3000, bottom: 3000 },
      },
    },
    add: {
      graphics() {
        const node = {
          calls: [],
          clear() {
            this.calls.length = 0;
            return this;
          },
        };
        for (const method of [
          "setDepth",
          "setScrollFactor",
          "setBlendMode",
          "lineStyle",
          "lineBetween",
          "fillStyle",
          "fillCircle",
          "strokeCircle",
          "beginPath",
          "moveTo",
          "lineTo",
          "closePath",
          "strokePath",
          "fillPath",
          "arc",
        ])
          node[method] = (...args) => {
            node.calls.push({ method, args });
            return node;
          };
        graphics.push(node);
        return node;
      },
      image() {
        const node = {};
        for (const [method, key] of [
          ["setDepth", "depth"],
          ["setScrollFactor", "scroll"],
          ["setTint", "tint"],
          ["setAlpha", "alpha"],
          ["setVisible", "visible"],
          ["setPosition", "position"],
          ["setDisplaySize", "size"],
        ])
          node[method] = (...args) => {
            node[key] = args.length === 1 ? args[0] : args;
            return node;
          };
        images.push(node);
        return node;
      },
    },
  };
  return { scene, graphics, images, motion };
}
const crest = { beat: "crest", accent: null, active: true, lockedWarning: false, reset: false };

test("real fracture renderer uses cool facets with no shock ring; ship/boss treatment stays warm", () => {
  const { scene, graphics, images, motion } = fixture();
  const fx = new BattleFx(scene);
  fx.burst(100, 100, 115, 0xff0000, "fracture");
  fx.update(20);
  const fracture = graphics[1].calls;
  assert.equal(
    fracture.some((call) => call.method === "strokeCircle"),
    false,
  );
  assert.equal(fracture.filter((call) => call.method === "closePath").length, 9);
  assert.equal(images.find((node) => node.visible).tint, 0xaec6dd);
  assert.ok(fracture.every((call) => !call.args.includes(0xffb35c)));
  motion.matches = true;
  fx.update(20);
  assert.equal(graphics[1].calls.filter((call) => call.method === "closePath").length, 4);
  fx.update(burstLifetime("fracture"));
  assert.equal(fx.counts().bursts, 0);
  assert.ok(images.every((node) => !node.visible));
  for (const kind of ["death", "boss"]) {
    fx.reset();
    fx.burst(100, 100, 80, 0xff0000, kind);
    fx.update(20);
    assert.equal(images.find((node) => node.visible).tint, 0xffb35c);
    assert.ok(graphics[1].calls.some((call) => call.method === "strokeCircle"));
  }
});

test("material traffic retains protected bursts and reuses the fixed36 nodes across resets", () => {
  const { scene, images } = fixture();
  const fx = new BattleFx(scene);
  for (let cycle = 0; cycle < 3; cycle++) {
    fx.burst(100, 100, 200, 0xffffff, "boss", 0, "important");
    for (let i = 0; i < 200; i++) fx.burst(100, 100, 100, 0xffffff, "fracture");
    assert.equal(fx.counts().important, 1);
    assert.ok(fx.counts().bursts <= 27);
    assert.equal(images.length, 36);
    fx.update(50);
    fx.reset();
    assert.equal(fx.counts().bursts, 0);
    assert.ok(images.every((node) => !node.visible));
  }
});

test("far hulls retain world anchors as camera moves, reframe only on resize and keep bounded nodes", () => {
  const { scene, graphics, images } = fixture();
  const backdrop = new BattleBackdrop(scene);
  backdrop.update(0, crest);
  const anchors = structuredClone(backdrop.fleets);
  scene.cameras.main.scrollX += 100;
  backdrop.update(16, crest);
  for (let i = 0; i < anchors.length; i++)
    assert.ok(
      Math.abs(backdrop.fleets[i].x - anchors[i].x) < 1e-9,
      "camera does not drag a far hull with it",
    );
  const beforeScreen = anchors[0].x;
  const afterScreen = backdrop.fleets[0].x - scene.cameras.main.scrollX * 0.22;
  assert.ok(Math.abs(beforeScreen - afterScreen - 22) < 1e-9);
  scene.cameras.main.width = 390;
  scene.cameras.main.height = 844;
  scene.cameras.main.zoom = 0.8;
  backdrop.update(32, crest);
  assert.equal(backdrop.fleets.length, 3);
  assert.equal(graphics.length, 1);
  assert.equal(images.length, 3);
  assert.equal(backdrop.centerFade(0, 0, 0, 0, 390, 844), 0.12);
});

test("actual far broadsides reach fleet anchors, stay within14/5, and never consume global RNG", () => {
  const { scene } = fixture();
  const backdrop = new BattleBackdrop(scene);
  const random = Math.random;
  Math.random = () => assert.fail("far formations must use their private cosmetic stream");
  try {
    backdrop.update(0, crest);
    assert.equal(backdrop.salvos.length, 6);
    for (const salvo of backdrop.salvos) {
      const endX = salvo.x + Math.cos(salvo.angle) * salvo.speed * 1.25;
      const endY = salvo.y + Math.sin(salvo.angle) * salvo.speed * 1.25;
      assert.ok(backdrop.fleets.some((fleet) => Math.hypot(fleet.x - endX, fleet.y - endY) < 1e-8));
    }
    for (let t = 16; t < 30000; t += 16) {
      scene.time.now = t;
      backdrop.update(t, { ...crest, accent: t % 160 === 0 ? "phase" : null });
      assert.ok(backdrop.counts().salvos <= 14);
      assert.ok(backdrop.counts().flashes <= 5);
    }
  } finally {
    Math.random = random;
  }
});

test("locked warnings/reduced motion/dropout clear far moving effects without queued replay", () => {
  const { scene, motion } = fixture();
  const backdrop = new BattleBackdrop(scene);
  backdrop.update(0, crest);
  assert.ok(backdrop.counts().salvos > 0);
  backdrop.update(16, { ...crest, lockedWarning: true });
  assert.deepEqual(backdrop.counts(), { salvos: 0, flashes: 0 });
  backdrop.update(32, crest);
  assert.equal(backdrop.counts().salvos, 0);
  scene.time.now = 800;
  backdrop.update(800, crest);
  assert.ok(backdrop.counts().salvos > 0);
  motion.matches = true;
  backdrop.update(816, crest);
  assert.deepEqual(backdrop.counts(), { salvos: 0, flashes: 0 });
  motion.matches = false;
  scene.time.now = 9000;
  backdrop.update(9000, crest);
  assert.deepEqual(backdrop.counts(), { salvos: 0, flashes: 0 });
  for (const event of ["shutdown", "destroy"]) {
    const { scene: ownedScene } = fixture();
    const owned = new BattleBackdrop(ownedScene);
    owned.update(0, crest);
    ownedScene.events.emit(event);
    assert.deepEqual(owned.counts(), { salvos: 0, flashes: 0 });
    assert.equal(owned.fleets.length, 0);
    assert.equal(ownedScene.events.listenerCount("shutdown"), 0);
    assert.equal(ownedScene.events.listenerCount("destroy"), 0);
  }
});
