// Actual dressing + actual map generator. No browser, texture mocks or new RNG.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { buildMineWorld } from "../src/render/mine-world.ts";
import { DEPTH, TILE } from "../src/config.ts";

const require = createRequire(import.meta.url);
const RandomDataGenerator = require(
  resolve(
    dirname(require.resolve("phaser/package.json")),
    "src/math/random-data-generator/RandomDataGenerator.js",
  ),
);
const source = readFileSync(new URL("../src/scenes/mine-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const text = new RegExp(`^  private ${name}\\([^]*?^  }`, "m").exec(source)?.[0];
  assert.ok(text, `actual ${name}`);
  return text;
};
const code = stripTypeScriptTypes(
  `class Mine { ${["generate", "idx", "isWall", "clearAround"].map(method).join("\n")} }`,
);
function generator(seed, depth) {
  const rng = new RandomDataGenerator([seed]);
  const Type = new Function("Phaser", "MW", "MH", `${code}; return Mine;`)(
    { Math: { RND: rng } },
    32,
    24,
  );
  const mine = new Type();
  Object.assign(mine, {
    walls: new Uint8Array(32 * 24),
    depth,
    enemies: [],
    spawnSkeleton(tx, ty, hp) {
      this.enemies.push({ tx, ty, hp });
    },
  });
  return { mine, rng };
}
function drawing() {
  const layers = [];
  const graphics = [];
  return {
    layers,
    graphics,
    make: {
      tilemap(options) {
        assert.equal(options.tileWidth, TILE);
        assert.equal(options.tileHeight, TILE);
        const rows = options.data.map((row) => row.map((index) => ({ index, tint: 0 })));
        const layer = {
          rows,
          setDepth(depth) {
            this.depth = depth;
            return this;
          },
          forEachTile(callback) {
            rows.flat().forEach(callback);
          },
        };
        layers.push(layer);
        return {
          addTilesetImage(key) {
            assert.equal(key, "atlas");
            return {};
          },
          createLayer(index, _atlas, x, y) {
            assert.deepEqual([index, x, y], [0, 0, 0]);
            return layer;
          },
        };
      },
    },
    add: {
      graphics() {
        const graphic = {
          rectangles: [],
          setDepth(depth) {
            this.depth = depth;
            return this;
          },
          fillStyle(color, alpha = 1) {
            this.color = color;
            this.alpha = alpha;
            return this;
          },
          fillRect(x, y, w, h) {
            this.rectangles.push({ x, y, w, h, color: this.color, alpha: this.alpha });
            return this;
          },
        };
        graphics.push(graphic);
        return graphic;
      },
    },
  };
}
const savedRandom = Math.random;
function draw(walls, width, height) {
  const scene = drawing();
  const before = walls.slice();
  Math.random = () => assert.fail("dressing consumed gameplay randomness");
  try {
    buildMineWorld(scene, walls, width, height);
  } finally {
    Math.random = savedRandom;
  }
  assert.deepEqual(walls, before);
  assert.equal(scene.layers.length, 2);
  assert.equal(scene.graphics.length, 2);
  const [floor, stone] = scene.layers;
  assert.equal(floor.depth, DEPTH.ground);
  assert.equal(stone.depth, DEPTH.entityBase);
  assert.ok(scene.graphics[0].depth < DEPTH.soil);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      assert.ok([1032, 1037].includes(floor.rows[y][x].index));
      assert.equal(stone.rows[y][x].index, walls[y * width + x] ? 961 : -1);
    }
  }
  // Every face is inside a blocked cell; every cast shadow is on open floor.
  for (const [graphic, wall] of [
    [scene.graphics[0], 0],
    [scene.graphics[1], 1],
  ]) {
    for (const r of graphic.rectangles) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          assert.equal(walls[Math.floor(y / TILE) * width + Math.floor(x / TILE)], wall);
        }
      }
    }
  }
  return scene;
}

for (const depth of [1, 5, 12]) {
  for (const seed of ["mine-a", "mine-b", "mine-c"]) {
    const { mine, rng } = generator(seed, depth);
    const seeds = mine.generate();
    const state = rng.state();
    const before = JSON.stringify({
      seeds,
      enemies: mine.enemies,
      up: mine.ladderUp,
      down: mine.ladderDown,
    });
    const scene = draw(mine.walls, 32, 24);
    const repeat = draw(mine.walls, 32, 24);
    assert.equal(rng.state(), state);
    assert.equal(
      JSON.stringify({ seeds, enemies: mine.enemies, up: mine.ladderUp, down: mine.ladderDown }),
      before,
    );
    assert.deepEqual(
      scene.layers.map((l) => l.rows),
      repeat.layers.map((l) => l.rows),
    );
    assert.deepEqual(
      scene.graphics.map((g) => g.rectangles),
      repeat.graphics.map((g) => g.rectangles),
    );
    const reference = generator(seed, depth);
    reference.mine.generate();
    mine.enemies = [];
    reference.mine.enemies = [];
    assert.deepEqual(mine.generate(), reference.mine.generate());
    assert.deepEqual(mine.walls, reference.mine.walls);
    assert.deepEqual(mine.enemies, reference.mine.enemies);
  }
}
console.log(
  "PASS 9 actual maps: unchanged wall mask, node/enemy positions, RNG state and next floor",
);

// An L of three cells has eight exposed edges; adjoining cells have no rim.
const walls = new Uint8Array(5 * 5);
for (const [x, y] of [
  [1, 1],
  [2, 1],
  [1, 2],
])
  walls[y * 5 + x] = 1;
const l = draw(walls, 5, 5);
assert.equal(l.graphics[1].rectangles.length, 12); // six side/top + two three-line faces
const southFaces = l.graphics[1].rectangles.filter((r) => r.h === 5);
assert.deepEqual(
  southFaces.map(({ x, y }) => [x, y]),
  [
    [32, 27],
    [16, 43],
  ],
);
const filled = draw(new Uint8Array(25).fill(1), 5, 5);
assert.equal(filled.graphics.flatMap((g) => g.rectangles).length, 0);
const empty = draw(new Uint8Array(25), 5, 5);
assert.equal(empty.graphics.flatMap((g) => g.rectangles).length, 0);
console.log(
  "PASS connected contours, shadows only on floor; four static display owners, no timers/textures",
);
