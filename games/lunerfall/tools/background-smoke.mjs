// Actual background owner/build methods; mocked display plumbing, original WebP
// bounds, and the game's real biome palettes. Native composition is checked separately.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { BIOMES, biomePalette } from "../src/data/biomes.ts";
import { START } from "../src/data/rooms.ts";
import { TILE } from "../src/config.ts";
import { buildParallax, FG_TREE_NAME } from "../src/parallax.ts";

const root = new URL("../", import.meta.url);
const file = (path) => readFileSync(new URL(path, root));

function webpSize(name) {
  const bytes = file(`public/sprites/env/${name}.webp`);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WEBP");
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8L") {
    assert.equal(bytes[20], 0x2f);
    const bits = bytes.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  assert.equal(chunk, "VP8X");
  return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
}

class Display {
  constructor(scene, x, y, texture, frame) {
    Object.assign(this, { scene, x, y, texture, frame, destroyed: 0 });
  }
  setOrigin(x, y = x) {
    this.origin = [x, y];
    return this;
  }
  setScrollFactor(value, vertical = value) {
    this.scroll = value;
    this.scrollY = vertical;
    return this;
  }
  setDepth(value) {
    this.depth = value;
    return this;
  }
  setScale(value) {
    this.scale = value;
    return this;
  }
  setAlpha(value) {
    this.alpha = value;
    return this;
  }
  setTint(value) {
    this.tint = value;
    return this;
  }
  setName(value) {
    this.name = value;
    return this;
  }
  setFlipX(value) {
    this.flip = value;
    return this;
  }
  setDisplaySize(width, height) {
    this.size = [width, height];
    return this;
  }
  destroy() {
    assert.equal(this.destroyed++, 0);
    this.scene.nodes.delete(this);
    this.scene = undefined;
  }
}

function makeScene() {
  const source = new Map();
  const canvases = new Map();
  const scene = { events: new EventEmitter(), nodes: new Set(), source, canvases };
  for (const name of ["tree", "rocks", "bushes", "bamboo"]) {
    const [width, height] = webpSize(name);
    const frames = new Map();
    source.set(`env:${name}`, {
      width,
      height,
      frames,
      has: (key) => frames.has(key),
      add(key, page, x, y, w, h) {
        assert.equal(page, 0);
        assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0);
        assert.ok(x + w <= width && y + h <= height, `${name}/${key} inside original sheet`);
        assert.equal(frames.has(key), false);
        frames.set(key, [x, y, w, h]);
      },
    });
  }
  scene.textures = {
    get: (key) => source.get(key),
    createCanvas(key, width, height) {
      assert.equal(canvases.has(key), false);
      const rows = [];
      const texture = {
        width,
        height,
        rows,
        refreshes: 0,
        context: {
          fillStyle: "",
          fillRect(x, y, w, h) {
            assert.equal(x, 0);
            assert.equal(w, width);
            assert.equal(h, 1);
            rows[y] = this.fillStyle;
          },
        },
        setFilter(value) {
          this.filter = value;
        },
        refresh() {
          this.refreshes++;
        },
      };
      canvases.set(key, texture);
      return texture;
    },
    remove(key) {
      assert.ok(canvases.delete(key), "owned texture removed once");
    },
  };
  const add = (x, y, texture, frame) => {
    if (texture?.startsWith("env:")) assert.ok(source.get(texture).frames.has(frame));
    const node = new Display(scene, x, y, texture, frame);
    scene.nodes.add(node);
    return node;
  };
  scene.add = {
    image: add,
    rectangle(x, y, width, height, color, alpha) {
      const node = add(x, y);
      Object.assign(node, { width, height, color, alpha });
      return node;
    },
  };
  return scene;
}

const skySource = stripTypeScriptTypes(
  file("src/render/pixel-sky.ts")
    .toString()
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export class PixelSky", "class PixelSky"),
  { mode: "transform", sourceUrl: fileURLToPath(new URL("src/render/pixel-sky.ts", root)) },
);
const PixelSky = new Function("Phaser", "biomePalette", skySource + "\nreturn PixelSky;")(
  {
    Textures: { FilterMode: { NEAREST: 0 } },
    Scenes: { Events: { SHUTDOWN: "shutdown", DESTROY: "destroy" } },
  },
  biomePalette,
);

const signature = (list) =>
  JSON.stringify(
    list.map(({ x, y, texture, frame, scale, scroll, scrollY, depth, alpha, tint, flip }) => ({
      x,
      y,
      texture,
      frame,
      scale,
      scroll,
      scrollY,
      depth,
      alpha,
      tint,
      flip,
    })),
  );
const channels = (hex) =>
  [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));

test("measured tree frames retain complete rows and register once across room rebuilds", () => {
  const scene = makeScene();
  const first = buildParallax(scene, 1280, 270);
  const tree = scene.source.get("env:tree");
  assert.equal(tree.frames.size, 32);
  // Bounds measured against the original opaque silhouettes, not the old grid.
  assert.deepEqual(tree.frames.get("tree-cut-0-0"), [55, 69, 84, 83]);
  assert.deepEqual(tree.frames.get("tree-cut-3-7"), [747, 397, 105, 90]);
  for (const [key, [x, y, w, h]] of tree.frames) {
    const row = Number(key.split("-")[2]);
    const limits = [
      [69, 160],
      [180, 271],
      [291, 382],
      [397, 488],
    ][row];
    assert.ok(y >= limits[0] && y + h <= limits[1], key);
    assert.ok(w <= 105 && h <= 90);
    assert.ok(x + w <= tree.width);
  }
  const registered = [...scene.source.values()].map((t) => t.frames.size);
  first.forEach((node) => node.destroy());
  buildParallax(scene, 1280, 270).forEach((node) => node.destroy());
  assert.equal(scene.nodes.size, 0);
  assert.deepEqual(
    [...scene.source.values()].map((t) => t.frames.size),
    registered,
  );
});

test("biome scenery stays behind actors and on the floor through camera scroll, bounded without random draws", () => {
  const originalRandom = Math.random;
  Math.random = () => {
    throw new Error("background consumed random stream");
  };
  try {
    const room = START();
    const roomH = room.grid.rows * TILE;
    const floor = room.playerSpawn.y;
    const signatures = new Set();
    for (const pal of BIOMES) {
      const scene = makeScene();
      const nodes = buildParallax(scene, 1600, roomH, pal);
      assert.ok(nodes.some((node) => node.name === FG_TREE_NAME));
      assert.ok(nodes.every((node) => node.depth < 0 && node.depth > -42));
      for (const scrollY of [0, roomH - 270, 132]) {
        const screenFloor = floor - scrollY;
        for (const node of nodes) {
          const screenFeet = node.y - scrollY * node.scrollY;
          assert.ok(
            Math.abs(screenFeet - screenFloor - (node.y - floor)) < 1e-9,
            "camera height must not bury ground-attached art below terrain",
          );
        }
      }
      const horizontal = new Set(nodes.map((node) => node.scroll));
      for (const sf of [0.12, 0.18, 0.34, 0.58, 1.12]) assert.ok(horizontal.has(sf));
      assert.ok(
        nodes.filter((node) => node.texture === undefined).every((node) => node.alpha === 0.25),
      );
      const expected = signature(nodes);
      signatures.add(expected);
      nodes.forEach((node) => node.destroy());
      const repeat = buildParallax(scene, 1600, roomH, pal);
      assert.equal(signature(repeat), expected);
      repeat.forEach((node) => node.destroy());
      const maximum = buildParallax(scene, 100_000, 270, pal);
      assert.ok(maximum.length <= 128);
      maximum.forEach((node) => node.destroy());
      assert.equal(scene.nodes.size, 0);
    }
    assert.equal(signatures.size, 5);
  } finally {
    Math.random = originalRandom;
  }
});

test("pixel sky paints all original palettes continuously and reuses one texture", () => {
  const scene = makeScene();
  const sky = new PixelSky(scene, 480, 270);
  assert.equal(scene.canvases.size, 1);
  assert.equal(sky.image.depth, -42);
  assert.equal(sky.image.scroll, 0);
  assert.equal(sky.image.scrollY, 0);
  assert.deepEqual(sky.image.size, [480, 270]);
  const texture = [...scene.canvases.values()][0];
  assert.deepEqual([texture.width, texture.height, texture.filter], [240, 135, 0]);
  for (const pal of BIOMES) {
    sky.setPalette(pal);
    const count = texture.refreshes;
    for (let i = 0; i < 100; i++) sky.setPalette(pal);
    assert.equal(texture.refreshes, count);
    assert.equal(texture.rows[0], `#${pal.sky[0].toString(16).padStart(6, "0")}`);
    assert.equal(texture.rows[67], `#${pal.sky[1].toString(16).padStart(6, "0")}`);
    assert.equal(texture.rows[134], `#${pal.sky[2].toString(16).padStart(6, "0")}`);
    for (let y = 1; y < texture.height; y++) {
      const a = channels(texture.rows[y - 1]);
      const b = channels(texture.rows[y]);
      assert.ok(
        a.every((channel, index) => Math.abs(channel - b[index]) <= 2),
        "no hard color slab boundary",
      );
    }
    assert.equal(scene.canvases.size, 1);
  }
  sky.destroy();
  assert.equal(scene.canvases.size, 0);
});

test("sky releases once on shutdown, final destroy, and repeated manual scene ownership", () => {
  for (const firstEvent of ["shutdown", "destroy", "manual"]) {
    const scene = makeScene();
    for (let i = 0; i < 3; i++) {
      const sky = new PixelSky(scene, 480, 270);
      assert.equal(scene.events.listenerCount("shutdown"), 1);
      assert.equal(scene.events.listenerCount("destroy"), 1);
      if (firstEvent === "destroy") sky.image.destroy(); // Phaser display list may go first.
      if (firstEvent === "manual") sky.destroy();
      else scene.events.emit(firstEvent);
      sky.destroy();
      sky.setPalette(BIOMES[1]);
      scene.events.emit("shutdown");
      scene.events.emit("destroy");
      assert.equal(scene.nodes.size, 0);
      assert.equal(scene.canvases.size, 0);
      assert.equal(scene.events.listenerCount("shutdown"), 0);
      assert.equal(scene.events.listenerCount("destroy"), 0);
    }
  }
});
