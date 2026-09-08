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

test("haze keeps three original color fields through camera resize and scene cleanup", () => {
  const { scene, graphics, images } = fixture();
  const backdrop = new BattleBackdrop(scene);
  backdrop.update("crest");
  const nodes = [...images];
  assert.deepEqual(
    images.map((node) => node.tint),
    [0x244d86, 0x352765, 0x285260],
  );
  assert.ok(
    images.every((node) => node.depth === -4 && node.scroll === 0.22 && node.alpha === 0.2),
  );
  const beforeX = images[0].position[0];
  scene.cameras.main.scrollX += 100;
  backdrop.update("build");
  assert.ok(Math.abs(images[0].position[0] - beforeX - 22) < 1e-9);
  assert.ok(images.every((node) => node.alpha === 0.17));
  scene.cameras.main.width = 390;
  scene.cameras.main.height = 844;
  scene.cameras.main.zoom = 0.8;
  backdrop.update("quiet");
  assert.equal(graphics.length, 0);
  assert.equal(images.length, 3);
  for (const [i, node] of images.entries()) {
    assert.equal(node, nodes[i]);
    assert.deepEqual(node.size, [(390 / 0.8) * 1.3, (844 / 0.8) * 1.2]);
    assert.equal(node.alpha, 0.14);
  }
  for (const event of ["shutdown", "destroy"]) {
    const { scene: ownedScene } = fixture();
    const owned = new BattleBackdrop(ownedScene);
    owned.update("crest");
    ownedScene.events.emit(event);
    assert.equal(owned.haze.length, 0);
    assert.equal(ownedScene.events.listenerCount("shutdown"), 0);
    assert.equal(ownedScene.events.listenerCount("destroy"), 0);
  }
});
