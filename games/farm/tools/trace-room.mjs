#!/usr/bin/env node
// Traces the Sunnyside GameMaker example scene (Room1) into the game.
// - RLE-decodes every tile layer of Room1.yy into flat index grids
// - extracts asset-layer sprite placements (windmills, wells, barrels, ...)
// - packs every referenced GM sprite frame into public/assets/deco-atlas.png
//   (+ .json, Phaser atlas format; frame names are "<sprite>/<frame>")
// - copies the 16px tileset atlas
// - writes public/assets/map.json consumed by BootScene/worldbuild
//
// Usage: node tools/trace-room.mjs [--pack <asset pack root>]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GAME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packArg = process.argv.indexOf("--pack");
const PACK =
  packArg >= 0
    ? process.argv[packArg + 1]
    : "/Users/kyh/Desktop/vg/stardew/Sunnyside_World_ASSET_PACK_V2.1";
const GM = path.join(PACK, "Sunnyside_World_Gamemaker");
const ROOM = path.join(GM, "rooms", "Room1", "Room1.yy");
const ATLAS = path.join(
  PACK,
  "Sunnyside_World_Assets",
  "Tileset",
  "spr_tileset_sunnysideworld_16px.png",
);
const OUT_ASSETS = path.join(GAME_ROOT, "public", "assets");
const OUT_DECO = path.join(OUT_ASSETS, "deco");

const EMPTY = -2147483648; // GM "no tile"
const TILE_INDEX_MASK = 0x7ffff;
const TILE_MIRROR = 0x8000000; // flip X
const TILE_FLIP = 0x10000000; // flip Y
const TILE_ROTATE = 0x20000000; // 90° rotation

// GM .yy files are JSON with trailing commas.
function parseYY(file) {
  const txt = fs.readFileSync(file, "utf8");
  return JSON.parse(txt.replace(/,(\s*[}\]])/g, "$1"));
}

function decodeRLE(data, w, h) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const n = data[i++];
    if (n < 0) {
      const v = data[i++];
      for (let k = 0; k < -n; k++) out.push(v);
    } else {
      for (let k = 0; k < n; k++) out.push(data[i++]);
    }
  }
  if (out.length !== w * h)
    throw new Error(`RLE length mismatch: got ${out.length}, want ${w * h}`);
  return out;
}

// Sprites that are scene dressing in the GM demo but conflict with live game
// systems (player/NPC/animal managers, crops, item pickups) — not traced.
const SKIP_SPRITES = new Set([
  "spr_deco_charactershadow",
  "spr_deco_shadow",
  ...["idle", "walking", "run", "attack", "axe", "carry", "casting", "caught", "death", "dig"].map(
    (a) => `spr_${a}`,
  ),
  ...["doing", "hammering", "jump", "mining", "reeling", "roll", "swimming", "watering"].map(
    (a) => `spr_${a}`,
  ),
  "skeleton_attack",
  "skeleton_hurt",
  "skeleton_idle",
  "skeleton_jump",
  "expression_alerted",
  "expression_attack",
  "expression_chat",
  "expression_love",
  "expression_stress",
  "expression_working",
  "happiness_01",
  "happiness_03",
  // crop stages — the farm field is live gameplay
  "beetroot_00",
  "cabbage_05",
  "cauliflower_05",
  "kale_05",
  "parsnip_03",
  "pumpkin_05",
  "wheat_01",
  // item drops that would read as pickups
  "egg",
  "milk",
  "fish",
  "wood",
  "rock",
  "spr_deco_coin",
  "spr_deco_coins",
  "spr_deco_truffle",
  "spr_deco_wool",
  "spr_deco_acron",
  // livestock owned by AnimalManager (buyable animals)
  "spr_deco_chicken_01",
  "spr_deco_cow",
  "spr_deco_pig_01",
  "spr_deco_sheep_01",
]);

function walkLayers(layers, fn, depth = 0) {
  for (const l of layers) {
    fn(l, depth);
    if (l.layers) walkLayers(l.layers, fn, depth + 1);
  }
}

const room = parseYY(ROOM);
const tileLayers = [];
const sprites = [];
const instances = [];

walkLayers(room.layers, (l) => {
  if (
    l.resourceType === "GMRTileLayer" &&
    (l.tiles?.TileCompressedData || l.tiles?.TileSerialiseData)
  ) {
    const w = l.tiles.SerialiseWidth;
    const h = l.tiles.SerialiseHeight;
    const raw = l.tiles.TileCompressedData
      ? decodeRLE(l.tiles.TileCompressedData, w, h)
      : l.tiles.TileSerialiseData;
    const grid = raw.map((v) => {
      if (v === EMPTY || v === 0) return -1; // 0 = blank tile in this atlas
      const idx = v & TILE_INDEX_MASK;
      const fx = v & TILE_MIRROR ? 1 : 0;
      const fy = v & TILE_FLIP ? 1 : 0;
      const rot = v & TILE_ROTATE ? 1 : 0;
      return idx | (fx << 20) | (fy << 21) | (rot << 22);
    });
    tileLayers.push({ name: l.name, w, h, grid });
  }
  if (l.resourceType === "GMRAssetLayer" && l.assets) {
    for (const a of l.assets) {
      if (a.resourceType !== "GMRSpriteGraphic") continue;
      const name = a.spriteId?.name;
      if (!name || SKIP_SPRITES.has(name)) continue;
      sprites.push({
        layer: l.name,
        sprite: name,
        x: a.x,
        y: a.y,
        sx: a.scaleX ?? 1,
        sy: a.scaleY ?? 1,
        speed: a.animationSpeed ?? 1,
      });
    }
  }
  if (l.resourceType === "GMRInstanceLayer" && l.instances) {
    for (const inst of l.instances)
      instances.push({ object: inst.objectId?.name ?? "?", x: inst.x, y: inst.y });
  }
});

// ---- bake referenced sprites into ONE texture atlas -------------------------
// A single atlas keeps the whole deco set on one GL texture — Phaser 4's
// multi-texture batcher mis-samples when dozens of standalone textures
// interleave by depth, and it's faster besides.
const decoManifest = {};
// charactershadow is skipped as a placement but baked for the live entities
const uniqueSprites = [
  ...new Set([...sprites.map((s) => s.sprite), "spr_deco_charactershadow"]),
].toSorted();
const packEntries = []; // {frameName, file, w, h, shadow}
const tmpShadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "deco-shadow-"));
for (const name of uniqueSprites) {
  const dir = path.join(GM, "sprites", name);
  const yy = path.join(dir, `${name}.yy`);
  if (!fs.existsSync(yy)) {
    console.error(`!! missing GM sprite: ${name}`);
    continue;
  }
  const def = parseYY(yy);
  def.frames.forEach((f, i) => {
    let file = path.join(dir, `${f.name}.png`);
    // Pure-shadow sprites are ~30%-alpha black in the source; bake them
    // opaque and let the game apply the soft alpha per object (tunable).
    if (name.endsWith("shadow")) {
      const solid = path.join(tmpShadowDir, `${name}_${i}.png`);
      execFileSync("magick", [file, "-channel", "A", "-threshold", "1%", "+channel", solid]);
      file = solid;
    }
    packEntries.push({ frameName: `${name}/${i}`, file, w: def.width, h: def.height });
  });
  decoManifest[name] = {
    frames: def.frames.length,
    fw: def.width,
    fh: def.height,
    ox: def.sequence?.xorigin ?? 0,
    oy: def.sequence?.yorigin ?? 0,
    fps: (def.sequence?.playbackSpeed ?? 15) * (def.sequence?.playbackSpeedType === 1 ? 60 : 1),
  };
}

// shelf-pack (height-sorted, 2px padding) into a 1024-wide sheet
const ATLAS_W = 1024;
const PAD = 2;
packEntries.sort((a, b) => b.h - a.h || b.w - a.w);
let cursorX = PAD;
let cursorY = PAD;
let shelfH = 0;
for (const e of packEntries) {
  if (cursorX + e.w + PAD > ATLAS_W) {
    cursorX = PAD;
    cursorY += shelfH + PAD;
    shelfH = 0;
  }
  e.x = cursorX;
  e.y = cursorY;
  cursorX += e.w + PAD;
  shelfH = Math.max(shelfH, e.h);
}
const atlasH = 2 ** Math.ceil(Math.log2(cursorY + shelfH + PAD));
const compositeArgs = ["-size", `${ATLAS_W}x${atlasH}`, "xc:none"];
for (const e of packEntries)
  compositeArgs.push(e.file, "-geometry", `+${e.x}+${e.y}`, "-composite");
compositeArgs.push(path.join(OUT_ASSETS, "deco-atlas.png"));
execFileSync("magick", compositeArgs);
fs.rmSync(tmpShadowDir, { recursive: true, force: true });

const atlasJSON = {
  frames: Object.fromEntries(
    packEntries.map((e) => [
      e.frameName,
      {
        frame: { x: e.x, y: e.y, w: e.w, h: e.h },
        rotated: false,
        trimmed: false,
        sourceSize: { w: e.w, h: e.h },
        spriteSourceSize: { x: 0, y: 0, w: e.w, h: e.h },
      },
    ]),
  ),
  meta: { image: "deco-atlas.png", size: { w: ATLAS_W, h: atlasH }, scale: "1" },
};
fs.writeFileSync(path.join(OUT_ASSETS, "deco-atlas.json"), JSON.stringify(atlasJSON));
// the old per-sprite strip folder is superseded by the atlas
fs.rmSync(OUT_DECO, { recursive: true, force: true });

// ---- atlas + map.json ------------------------------------------------------
fs.mkdirSync(path.join(OUT_ASSETS, "tiles"), { recursive: true });
fs.copyFileSync(ATLAS, path.join(OUT_ASSETS, "tiles", "atlas.png"));

// The character shadow also ships as its own file for the live entities
// (player/NPCs/animals), separate from the traced-deco atlas.
{
  const src = path.join(GM, "sprites", "spr_deco_charactershadow");
  const def = parseYY(path.join(src, "spr_deco_charactershadow.yy"));
  const frame = path.join(src, `${def.frames[0].name}.png`);
  execFileSync("magick", [
    frame,
    "-channel",
    "A",
    "-threshold",
    "1%",
    "+channel",
    path.join(OUT_ASSETS, "obj", "charactershadow.png"),
  ]);
}

// tileset animations: head index (frames[0]) -> tick sequence, 5 ticks/sec
const tilesetDef = parseYY(
  path.join(GM, "tilesets", "tileset_sunnysideworld", "tileset_sunnysideworld.yy"),
);
const animations = tilesetDef.tileAnimationFrames.map((a) => a.frames);

const map = {
  w: tileLayers[0].w,
  h: tileLayers[0].h,
  // paint order: room.layers is listed top-most first — reverse for bottom-up
  tileLayers: tileLayers.toReversed(),
  sprites,
  instances,
  deco: decoManifest,
  animations,
  animationFps: tilesetDef.tileAnimationSpeed,
};
fs.writeFileSync(path.join(OUT_ASSETS, "map.json"), JSON.stringify(map));

// ---- report ----------------------------------------------------------------
console.log(`map ${map.w}x${map.h}, layers (bottom→top):`);
for (const l of map.tileLayers) {
  const used = new Set();
  let count = 0;
  for (const v of l.grid)
    if (v >= 0) {
      used.add(v & 0xfffff);
      count++;
    }
  console.log(`  ${l.name.padEnd(14)} tiles=${String(count).padStart(4)} uniq=${used.size}`);
}
console.log(`sprites placed: ${sprites.length} (${uniqueSprites.length} unique baked)`);
console.log(`instances: ${instances.length}`);
const flips = map.tileLayers.reduce(
  (n, l) => n + l.grid.filter((v) => v >= 0 && v >> 20 !== 0).length,
  0,
);
console.log(`tiles with flip/rotate bits: ${flips}`);
