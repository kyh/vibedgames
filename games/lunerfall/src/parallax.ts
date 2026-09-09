import type Phaser from "phaser";

import { TILE } from "./config";
import { biomePalette, mulColor } from "./data/biomes";
import type { BiomePalette } from "./data/biomes";

// 4-layer parallax scenery built from the Luneblade tree set (env:tree). The
// sheet is a 8×4 grid of 118×148 tree silhouettes, pre-tinted by depth:
//   row 0 = foreground (darkest) · 1 = midground (dark + teal) · 2 = bg1 (grey)
//   · 3 = bg2 (lightest). Far layers scroll slower (smaller scrollFactor) and sit
// behind the play layer; near trees frame the edges in front. Plus soft grey
// ruin-pillars in the deep distance, matching the promo screenshots.
const TW = 118;
const TH = 148;
const TCOLS = 8;

const registerTrees = (scene: Phaser.Scene) => {
  const tex = scene.textures.get("env:tree");
  if (tex.has("tree-0-0")) {
    return;
  }
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < TCOLS; c += 1) {
      tex.add(`tree-${r}-${c}`, 0, c * TW, r * TH, TW, TH);
    }
  }
};

// Deterministic-ish jitter from an index (view-only, so Math.random is fine but
// index hashing keeps a room's scenery stable across re-renders).
const hash = (n: number) => {
  const s = Math.sin(n * 12.9898) * 43_758.5453;
  return s - Math.floor(s);
};

interface Layer {
  row: number;
  depth: number;
  sf: number;
  step: number;
  scale: number;
  alpha: number;
  tint: number;
}

// From deepest to nearest. `sf` = scrollFactor, `step` = px between trees.
const LAYERS: Layer[] = [
  { alpha: 0.55, depth: -33, row: 3, scale: 1.15, sf: 0.18, step: 150, tint: 0x8b_97_ad },
  { alpha: 0.7, depth: -24, row: 2, scale: 1.05, sf: 0.34, step: 128, tint: 0x6d_7a_90 },
  { alpha: 0.92, depth: -12, row: 1, scale: 1, sf: 0.58, step: 150, tint: 0xff_ff_ff },
];

/** Name tag on the in-front layer, so a caller can pick it out of the returned
 * list (the trailer drops it on combat shots — see GameScene.trailerStage). */
export const FG_TREE_NAME = "fg-tree";

const FG_LAYER: Layer = {
  alpha: 1,
  depth: 40,
  row: 0,
  scale: 1.25,
  sf: 1.12,
  step: 320,
  tint: 0xff_ff_ff,
};

export const buildParallax = (
  scene: Phaser.Scene,
  roomW: number,
  roomH: number,
  pal: BiomePalette = biomePalette(1),
): Phaser.GameObjects.GameObject[] => {
  registerTrees(scene);
  const out: Phaser.GameObjects.GameObject[] = [];
  // top of the floor in px
  const groundY = (roomH / TILE - 2) * TILE;

  // Deep ruin-pillars — soft grey verticals receding into the mist.
  const pillarN = Math.max(4, Math.round(roomW / 150));
  for (let i = 0; i < pillarN; i += 1) {
    const px = 40 + (i / pillarN) * (roomW - 80) + (hash(i * 3.1) - 0.5) * 90;
    const h = 90 + hash(i * 7.7) * 150;
    const w = 10 + Math.round(hash(i * 2.3) * 8);
    const p = scene.add
      .rectangle(px, groundY, w, h, pal.horizon, 0.5)
      .setOrigin(0.5, 1)
      .setScrollFactor(0.12)
      .setDepth(-36);
    out.push(p);
  }

  for (const L of LAYERS) {
    const n = Math.ceil(roomW / L.step) + 2;
    for (let i = 0; i < n; i += 1) {
      const seed = L.row * 100 + i;
      const col = Math.floor(hash(seed * 1.7) * TCOLS);
      const x = i * L.step + (hash(seed * 4.2) - 0.5) * L.step * 0.7;
      const y = groundY + 6 + (hash(seed * 9.1) - 0.5) * 8 - L.depth * 0.25;
      const s = L.scale * (0.82 + hash(seed * 3.3) * 0.4);
      const t = scene.add
        .image(x, y, "env:tree", `tree-${L.row}-${col}`)
        .setOrigin(0.5, 1)
        .setScrollFactor(L.sf)
        .setDepth(L.depth)
        .setScale(s)
        .setAlpha(L.alpha)
        .setTint(mulColor(L.tint, pal.tree));
      if (hash(seed * 5.5) > 0.5) {
        t.setFlipX(true);
      }
      out.push(t);
    }
  }

  // Sparse foreground trees framing the very edges (darkest, in front of play).
  const fgN = Math.ceil(roomW / FG_LAYER.step) + 1;
  for (let i = 0; i < fgN; i += 1) {
    const seed = 900 + i;
    const col = Math.floor(hash(seed * 2.1) * TCOLS);
    const x = i * FG_LAYER.step + hash(seed * 6.4) * FG_LAYER.step * 0.6;
    const t = scene.add
      .image(x, groundY + 14, "env:tree", `tree-0-${col}`)
      .setOrigin(0.5, 1)
      .setScrollFactor(FG_LAYER.sf)
      .setDepth(FG_LAYER.depth)
      .setScale(FG_LAYER.scale)
      .setAlpha(0.96)
      .setTint(mulColor(FG_LAYER.tint, pal.tree))
      .setName(FG_TREE_NAME);
    if (hash(seed * 8.8) > 0.5) {
      t.setFlipX(true);
    }
    out.push(t);
  }

  return out;
};
