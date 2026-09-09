import type Phaser from "phaser";

import { TILE } from "./config";
import { type BiomePalette, biomePalette, mulColor } from "./data/biomes";

type Rect = readonly [x: number, y: number, width: number, height: number];

// Measured opaque bounds in the original sheet. Its four rows are irregularly
// spaced, not a uniform spritesheet; grid cuts included neighboring silhouettes.
const TREE_ROWS: readonly (readonly Rect[])[] = [
  [
    [55, 69, 84, 83],
    [163, 77, 97, 76],
    [300, 79, 76, 74],
    [394, 88, 64, 69],
    [479, 76, 70, 84],
    [562, 76, 63, 84],
    [639, 69, 90, 90],
    [745, 69, 105, 90],
  ],
  [
    [56, 180, 84, 83],
    [164, 188, 97, 76],
    [301, 190, 76, 74],
    [395, 199, 64, 69],
    [480, 187, 70, 84],
    [563, 187, 63, 84],
    [640, 180, 90, 90],
    [746, 180, 105, 90],
  ],
  [
    [53, 291, 84, 83],
    [161, 299, 97, 76],
    [298, 301, 76, 74],
    [392, 310, 64, 69],
    [477, 298, 70, 84],
    [560, 298, 63, 84],
    [637, 291, 90, 90],
    [743, 291, 105, 90],
  ],
  [
    [57, 397, 84, 83],
    [165, 405, 97, 76],
    [302, 407, 76, 74],
    [396, 416, 64, 69],
    [481, 404, 70, 84],
    [564, 404, 63, 84],
    [641, 397, 90, 90],
    [747, 397, 105, 90],
  ],
];

type Sheet = "rocks" | "bushes" | "bamboo";
const DRESSING_FRAMES = {
  rocks: [
    [48, 125, 81, 35],
    [49, 188, 81, 35],
    [392, 344, 204, 123],
    [608, 343, 204, 123],
    [434, 483, 51, 79],
    [514, 484, 46, 78],
    [645, 39, 81, 42],
    [768, 39, 81, 42],
  ],
  bushes: [
    [173, 192, 190, 35],
    [564, 195, 190, 35],
    [906, 195, 190, 35],
  ],
  bamboo: [
    [16, 73, 174, 149],
    [205, 72, 174, 149],
    [385, 59, 167, 162],
    [559, 42, 203, 179],
  ],
} satisfies Record<Sheet, readonly Rect[]>;

function registerScenery(scene: Phaser.Scene) {
  const tex = scene.textures.get("env:tree");
  TREE_ROWS.forEach((row, r) => {
    row.forEach((rect, c) => {
      const key = `tree-cut-${r}-${c}`;
      if (!tex.has(key)) tex.add(key, 0, ...rect);
    });
  });
  const sheets: readonly Sheet[] = ["rocks", "bushes", "bamboo"];
  for (const sheet of sheets) {
    const texture = scene.textures.get(`env:${sheet}`);
    DRESSING_FRAMES[sheet].forEach((rect, i) => {
      const key = `scenery-${i}`;
      if (!texture.has(key)) texture.add(key, 0, ...rect);
    });
  }
}

// View-only index jitter never consumes the simulation's random stream.
const hash = (n: number) => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

type Layer = {
  row: number;
  depth: number;
  sf: number;
  step: number;
  scale: number;
  alpha: number;
  tint: number;
};

// From deepest to nearest. `sf` = scrollFactor, `step` = px between trees.
const LAYERS: Layer[] = [
  { row: 3, depth: -33, sf: 0.18, step: 150, scale: 1.15, alpha: 0.55, tint: 0x8b97ad },
  { row: 2, depth: -24, sf: 0.34, step: 128, scale: 1.05, alpha: 0.7, tint: 0x6d7a90 },
  { row: 1, depth: -12, sf: 0.58, step: 150, scale: 1.0, alpha: 0.92, tint: 0xffffff },
];

/** Name tag on the near layer, so a caller can pick it out of the returned
 * list (the trailer drops it on combat shots — see GameScene.trailerStage). */
export const FG_TREE_NAME = "fg-tree";

const FG_LAYER: Layer = {
  row: 0,
  depth: -4,
  sf: 1.12,
  step: 320,
  scale: 1.25,
  alpha: 1,
  tint: 0xffffff,
};

type Dressing = {
  sheet: Sheet;
  frames: readonly number[];
  step: number;
  depth: number;
  sf: number;
  scale: number;
  alpha: number;
};

type Composition = { trees: number; far: Dressing; near: Dressing };

function composition(name: string): Composition {
  const ruins: Dressing = {
    sheet: "rocks",
    frames: [2, 3, 4, 5],
    step: 360,
    depth: -30,
    sf: 0.22,
    scale: 1.15,
    alpha: 0.48,
  };
  const stones: Dressing = {
    sheet: "rocks",
    frames: [0, 1],
    step: 270,
    depth: -9,
    sf: 0.72,
    scale: 0.9,
    alpha: 0.68,
  };
  const bushes: Dressing = {
    sheet: "bushes",
    frames: [0, 1],
    step: 350,
    depth: -8,
    sf: 0.72,
    scale: 0.8,
    alpha: 0.62,
  };
  switch (name) {
    case "EMBERDEEP":
      return { trees: 0.45, far: ruins, near: stones };
    case "FROSTVAULT":
      return { trees: 0.4, far: ruins, near: { ...stones, frames: [6], alpha: 0.62 } };
    case "VENOMHOLLOW":
      return {
        trees: 0.6,
        far: {
          sheet: "bamboo",
          frames: [2, 3],
          step: 330,
          depth: -29,
          sf: 0.27,
          scale: 0.95,
          alpha: 0.52,
        },
        near: bushes,
      };
    case "VOIDSANCTUM":
      return {
        trees: 0.3,
        far: { ...ruins, scale: 1.35, alpha: 0.57 },
        near: { ...stones, frames: [7], alpha: 0.64 },
      };
    default:
      return {
        trees: 1,
        far: {
          sheet: "bamboo",
          frames: [2],
          step: 580,
          depth: -31,
          sf: 0.2,
          scale: 0.8,
          alpha: 0.32,
        },
        near: bushes,
      };
  }
}

export function buildParallax(
  scene: Phaser.Scene,
  roomW: number,
  roomH: number,
  pal: BiomePalette = biomePalette(1),
): Phaser.GameObjects.GameObject[] {
  registerScenery(scene);
  const out: Phaser.GameObjects.GameObject[] = [];
  const scenery = composition(pal.name);
  const groundY = (roomH / TILE - 2) * TILE; // top of the floor in px
  // Parallax is horizontal: scenery feet must follow the floor when the camera climbs.

  // Deep ruin-pillars — soft grey verticals receding into the mist.
  const pillarN = Math.min(12, Math.max(4, Math.round(roomW / 150)));
  for (let i = 0; i < pillarN; i++) {
    const px = 40 + (i / pillarN) * (roomW - 80) + (hash(i * 3.1) - 0.5) * 90;
    const h = 90 + hash(i * 7.7) * 150;
    const w = 10 + Math.round(hash(i * 2.3) * 8);
    const p = scene.add
      .rectangle(px, groundY, w, h, pal.horizon, 0.25)
      .setOrigin(0.5, 1)
      .setScrollFactor(0.12, 1)
      .setDepth(-36);
    out.push(p);
  }

  for (const L of LAYERS) {
    const spacing = L.step / scenery.trees;
    const n = Math.min(24, Math.ceil(roomW / spacing) + 2);
    for (let i = 0; i < n; i++) {
      const seed = L.row * 100 + i;
      const col = Math.floor(hash(seed * 1.7) * 8);
      const x = i * spacing + (hash(seed * 4.2) - 0.5) * spacing * 0.7;
      const y = groundY + 6 + (hash(seed * 9.1) - 0.5) * 8 - L.depth * 0.25;
      const s = L.scale * (0.82 + hash(seed * 3.3) * 0.4);
      const t = scene.add
        .image(x, y, "env:tree", `tree-cut-${L.row}-${col}`)
        .setOrigin(0.5, 1)
        .setScrollFactor(L.sf, 1)
        .setDepth(L.depth)
        .setScale(s)
        .setAlpha(L.alpha)
        .setTint(mulColor(L.tint, pal.tree));
      if (hash(seed * 5.5) > 0.5) t.setFlipX(true);
      out.push(t);
    }
  }

  // Near silhouettes: faster parallax, but drawn behind actors so they never mask play.
  const nearSpacing = FG_LAYER.step / scenery.trees;
  const fgN = Math.min(12, Math.ceil(roomW / nearSpacing) + 1);
  for (let i = 0; i < fgN; i++) {
    const seed = 900 + i;
    const col = Math.floor(hash(seed * 2.1) * 8);
    const x = i * nearSpacing + hash(seed * 6.4) * nearSpacing * 0.6;
    const t = scene.add
      .image(x, groundY + 14, "env:tree", `tree-cut-0-${col}`)
      .setOrigin(0.5, 1)
      .setScrollFactor(FG_LAYER.sf, 1)
      .setDepth(FG_LAYER.depth)
      .setScale(FG_LAYER.scale)
      .setAlpha(0.96)
      .setTint(mulColor(FG_LAYER.tint, pal.tree))
      .setName(FG_TREE_NAME);
    if (hash(seed * 8.8) > 0.5) t.setFlipX(true);
    out.push(t);
  }

  for (const layer of [scenery.far, scenery.near]) {
    const count = Math.min(16, Math.ceil(roomW / layer.step) + 1);
    for (let i = 0; i < count; i++) {
      const seed = i + 1300 - layer.depth;
      const frame = layer.frames[Math.floor(hash(seed * 2.7) * layer.frames.length)] ?? 0;
      const x = (i + 0.35 + hash(seed * 4.1) * 0.35) * layer.step;
      const node = scene.add
        .image(x, groundY + 3, `env:${layer.sheet}`, `scenery-${frame}`)
        .setOrigin(0.5, 1)
        .setScrollFactor(layer.sf, 1)
        .setDepth(layer.depth)
        .setScale(layer.scale)
        .setAlpha(layer.alpha)
        .setTint(pal.tree);
      if (hash(seed * 8.3) > 0.5) node.setFlipX(true);
      out.push(node);
    }
  }

  return out;
}
