import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { blastFrame, fireCells, freshCue } from "../src/render/blast-frame.ts";
import * as constants from "../src/shared/constants.ts";

const source = readFileSync(new URL("../src/scenes/game-scene.ts", import.meta.url), "utf8");
const method = (name) => {
  const found = new RegExp(`^  private ${name}\\([^]*?^  }`, "m").exec(source)?.[0];
  assert.ok(found, name);
  return found;
};
const make = new Function(
  "env",
  `const {blastFrame,fireCells,freshCue,TILE,tileKey,simNow,sfx,Phaser}=env;
  const colX=c=>(c+.5)*TILE,rowY=r=>(r+.5)*TILE;
  return ${stripTypeScriptTypes(`class Scene {${["syncBlasts", "updateBlastFrames"].map(method).join("\n")}}`, { mode: "strip" })};`,
);

function fixture() {
  let now = 1000;
  const state = { blasts: {} };
  const calls = { images: [], sounds: [], impacts: [], shakes: [] };
  const Scene = make({
    ...constants,
    blastFrame,
    fireCells,
    freshCue,
    simNow: () => now,
    sfx: { blast: (...args) => calls.sounds.push(args) },
    Phaser: { BlendModes: { ADD: 1 } },
  });
  const scene = Object.assign(new Scene(), {
    shared: () => state,
    blastSprites: new Map(),
    blastSeen: new Set(),
    players: new Map(),
    myId: "local",
    feedbackEnabled: true,
    reducedMotion: false,
    cameras: { main: { width: 1280, height: 720, scrollX: 0, scrollY: 0, zoom: 1 } },
    battleFx: { blast: (tiles) => calls.impacts.push(tiles) },
    shakeIfNear: (tiles) => calls.shakes.push(tiles),
    add: {
      image(x, y, texture, frame) {
        const image = {
          x,
          y,
          texture,
          frame,
          visible: true,
          destroyed: false,
          setDepth() {
            return this;
          },
          setDisplaySize() {
            return this;
          },
          setAngle() {
            return this;
          },
          setTint() {
            return this;
          },
          setAlpha() {
            return this;
          },
          setBlendMode() {
            return this;
          },
          setFrame(value) {
            this.frame = value;
            return this;
          },
          setVisible(value) {
            this.visible = value;
            return this;
          },
          destroy() {
            assert.equal(this.destroyed, false);
            this.destroyed = true;
          },
        };
        calls.images.push(image);
        return image;
      },
    },
  });
  return {
    scene,
    state,
    calls,
    at: (value) => {
      now = value;
    },
  };
}
const blast = (id, placedAt, tiles) => ({ id, placedAt, tiles });
const row = Array.from({ length: 7 }, (_, col) => ({ col: col + 1, row: 5 }));
const column = Array.from({ length: 7 }, (_, row) => ({ col: 4, row: row + 2 }));
let groups = 0;

{
  const f = fixture();
  f.state.blasts = { a: blast("a", 1000, row), b: blast("b", 1000, column) };
  const before = JSON.stringify(f.state);
  f.scene.syncBlasts();
  assert.equal(f.scene.blastSprites.size, 13, "14 hazard entries have one shared cell");
  assert.equal(f.calls.images.length, 26, "one fire and footprint per unique cell");
  assert.equal(f.calls.impacts[0].length, 13, "chain debris is also deduplicated");
  assert.equal(f.calls.sounds.length, 1, "one nearest-chain phrase");
  f.scene.syncBlasts();
  assert.equal(f.calls.images.length, 26);
  assert.equal(f.calls.impacts.length, 1);
  assert.equal(f.calls.sounds.length, 1);
  assert.equal(JSON.stringify(f.state), before, "render never mutates shared hazards");
  groups++;
}

{
  const f = fixture();
  f.state.blasts.a = blast("a", 600, row);
  f.scene.syncBlasts();
  for (const cell of f.scene.blastSprites.values()) assert.equal(cell.fire.frame, 12);
  assert.equal(
    f.calls.sounds.length + f.calls.impacts.length + f.calls.shakes.length,
    0,
    "80ms remaining on reconnect cannot replay impact",
  );
  f.scene.updateBlastFrames(1079);
  for (const cell of f.scene.blastSprites.values()) {
    assert.equal(cell.fire.frame, 15);
    assert.equal(cell.footprint.visible, true);
  }
  f.scene.updateBlastFrames(1080);
  for (const cell of f.scene.blastSprites.values()) {
    assert.equal(cell.fire.visible, false);
    assert.equal(cell.footprint.visible, false);
  }
  f.at(1080);
  f.scene.syncBlasts();
  assert.equal(f.scene.blastSprites.size, 0);
  assert.ok(f.calls.images.every((image) => image.destroyed));
  groups++;
}

{
  const f = fixture();
  f.state.blasts.a = blast("a", 800, row);
  f.scene.syncBlasts();
  f.state.blasts.b = blast("b", 1000, column);
  f.scene.syncBlasts();
  assert.equal(f.scene.blastSprites.get("4,5").fire.frame, 0);
  f.at(1280);
  f.scene.syncBlasts();
  assert.equal(f.scene.blastSprites.size, 7, "newer intersecting blast outlives original row");
  assert.equal(f.scene.blastSprites.get("4,5").fire.frame, 8);
  const frames = [...f.scene.blastSprites.values()].map((v) => v.fire.frame);
  for (let i = 0; i < 100; i++) f.scene.updateBlastFrames(1280);
  assert.deepEqual(
    [...f.scene.blastSprites.values()].map((v) => v.fire.frame),
    frames,
    "frozen shared time consumes no animation",
  );
  f.at(1480);
  f.scene.syncBlasts();
  assert.equal(f.scene.blastSprites.size, 0);
  groups++;
}

{
  const f = fixture();
  f.scene.feedbackEnabled = false;
  f.state.blasts.a = blast("a", 1000, row);
  f.scene.syncBlasts();
  f.scene.feedbackEnabled = true;
  f.scene.syncBlasts();
  assert.equal(f.calls.sounds.length, 0, "join hydration stays silent after feedback arms");
  f.state.blasts = {};
  f.scene.syncBlasts();
  assert.equal(f.scene.blastSeen.size, 0);
  f.at(1200);
  f.state.blasts.a = blast("a", 1200, row);
  f.scene.syncBlasts();
  assert.equal(f.calls.sounds.length, 1, "later round can reuse a cleared id");
  groups++;
}

{
  let seed = 1973;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let sample = 0; sample < 200; sample++) {
    const blasts = Array.from({ length: 24 }, (_, id) =>
      blast(
        String(id),
        random(1100),
        Array.from({ length: 12 }, () => ({ col: random(19), row: random(15) })),
      ),
    );
    const expected = new Set(
      blasts
        .filter((b) => b.placedAt <= 1000 && b.placedAt > 520)
        .flatMap((b) => b.tiles.map((t) => `${t.col},${t.row}`)),
    );
    const actual = fireCells(blasts, 1000);
    assert.deepEqual(new Set(actual.keys()), expected, "render is exact active hazard union");
    assert.deepEqual(
      fireCells(blasts.toReversed(), 1000),
      actual,
      "order cannot change overlap age",
    );
    assert.ok(actual.size <= 19 * 15);
  }
  for (const [age, frame] of [
    [-1, null],
    [0, 0],
    [31, 0],
    [32, 1],
    [250, 8],
    [479, 15],
    [480, null],
  ])
    assert.equal(blastFrame(1000, 1000 + age), frame);
  assert.equal(freshCue(1000, 999), false);
  assert.equal(freshCue(1000, 1140), true);
  assert.equal(freshCue(1000, 1141), false);
  groups++;
}

console.log(
  `✓ ${groups} blast render groups: unique hazards, accepted video age, late impact silence, overlap expiry, pause, reset, 200 crowded worlds`,
);
