import type Phaser from "phaser";
import { Tilemaps } from "phaser";
import { TILE, DEPTH } from "../config";
import {
  tileIndex,
  tileFlipX,
  tileFlipY,
  tileRotate,
  isDecoSolidIndex,
  inField,
  layerByName,
} from "../world/worldmap";
import type { WorldMap, WorldMapTileLayer, WorldMapSprite, DecoDef } from "../world/worldmap";

// Extra depths used only by the world-map renderer. Entities y-sort in
// [DEPTH.entityBase .. ~entityBase + mapHeightPx]; overlays sit above them.
const D = {
  cloudShadow: 800_000,
  clouds: 850_000,
  // clouds peeking out under the island
  cloudsUnder: DEPTH.ground + 0.2,
  // walk-over dressing
  decoFlat: DEPTH.decalLow,
  // Assets_2: rugs, oars, small floor props
  groundProps: DEPTH.decalLow + 0.5,
  land: DEPTH.ground + 0.4,
  // chimney smoke, glints — above all entities
  overlayFx: 700_000,
  paths: DEPTH.ground + 0.6,
  // 0
  sea: DEPTH.ground,
  // baked prop shadows (under tilled soil),
  shadows: DEPTH.ground + 0.8,
} as const;

interface AnimatedTile {
  tile: Phaser.Tilemaps.Tile;
  seq: number[];
}

export interface WorldMapRenderResult {
  skippedSprites: number;
}

/** Whether a tile of the given atlas index at (tx, ty) belongs on the layer. */
type KeepTile = (idx: number, tx: number, ty: number) => boolean;

/** Draws one atlas tile as a standalone y-sorted image. */
type ImageTile = (v: number, tx: number, ty: number, depth: number) => void;

interface Components {
  compId: Int32Array;
  bottoms: number[];
}

const markOccupied = (
  map: WorldMap,
  layers: WorldMapTileLayer[],
  keep: (x: number, y: number) => boolean,
): Uint8Array => {
  const { w, h } = map;
  const occupied = new Uint8Array(w * h);
  for (const l of layers) {
    for (let i = 0; i < w * h; i += 1) {
      if ((l.grid[i] ?? -1) >= 0 && keep(i % w, Math.trunc(i / w))) {
        occupied[i] = 1;
      }
    }
  }
  return occupied;
};

// Flood-fill (8-neighbour) connected components over the occupancy grid.
const labelComponents = (w: number, h: number, occupied: Uint8Array): Components => {
  const compId = new Int32Array(w * h).fill(-1);
  const bottoms: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const start = y * w + x;
      if (!occupied[start] || compId[start] !== -1) {
        continue;
      }
      const id = bottoms.length;
      let bottom = y;
      const queue = [start];
      compId[start] = id;
      while (queue.length > 0) {
        const cur = queue.pop();
        if (cur === undefined) {
          break;
        }
        const cx = cur % w;
        const cy = Math.trunc(cur / w);
        bottom = Math.max(bottom, cy);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) {
              continue;
            }
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
              continue;
            }
            const ni = ny * w + nx;
            if (occupied[ni] && compId[ni] === -1) {
              compId[ni] = id;
              queue.push(ni);
            }
          }
        }
      }
      bottoms.push(bottom);
    }
  }
  return { bottoms, compId };
};

// draw per layer (paint order), each tile at its component's bottom depth
const drawComponents = (
  map: WorldMap,
  layers: WorldMapTileLayer[],
  components: Components,
  imageTile: ImageTile,
): void => {
  const { w, h } = map;
  const { compId, bottoms } = components;
  for (const l of layers) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const v = l.grid[y * w + x] ?? -1;
        const id = compId[y * w + x] ?? -1;
        if (v < 0 || id < 0) {
          continue;
        }
        const bottom = bottoms[id] ?? y;
        imageTile(v, x, y, DEPTH.entityBase + (bottom + 1) * TILE);
      }
    }
  }
};

// Fuse a set of layers into connected components and render each component's
// tiles in layer paint order at a shared bottom-row depth.
const renderComponents = (
  map: WorldMap,
  layers: WorldMapTileLayer[],
  keep: (x: number, y: number) => boolean,
  imageTile: ImageTile,
): Components => {
  const occupied = markOccupied(map, layers, keep);
  const components = labelComponents(map.w, map.h, occupied);
  drawComponents(map, layers, components, imageTile);
  return components;
};

/** The layer's tile indices as tilemap rows, or null when nothing survives `keep`. */
const buildLayerRows = (
  map: WorldMap,
  layer: WorldMapTileLayer,
  keep?: KeepTile,
): number[][] | null => {
  const rows: number[][] = [];
  let any = false;
  for (let y = 0; y < map.h; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < map.w; x += 1) {
      const v = layer.grid[y * map.w + x] ?? -1;
      const idx = v >= 0 ? tileIndex(v) : -1;
      if (v >= 0 && (!keep || keep(idx, x, y))) {
        row.push(idx);
        any = true;
      } else {
        row.push(-1);
      }
    }
    rows.push(row);
  }
  return any ? rows : null;
};

const applyTileTransform = (t: Phaser.Tilemaps.Tile, v: number): void => {
  // Phaser 4.1's tile transformer offsets flipY tiles by a tile; since flips
  // apply before rotation, flipY ≡ flipX + 180° — never set flipY.
  const fx = tileFlipX(v);
  let rotation = tileRotate(v) ? Math.PI / 2 : 0;
  let flipX = fx;
  if (tileFlipY(v)) {
    flipX = !fx;
    rotation += Math.PI;
  }
  if (flipX) {
    t.flipX = true;
  }
  if (rotation !== 0) {
    t.rotation = rotation;
  }
};

// transforms + animation registration
const decorateLayer = (
  map: WorldMap,
  layer: WorldMapTileLayer,
  tl: Phaser.Tilemaps.TilemapLayer,
  animBySeqMember: ReadonlyMap<number, number[]>,
  animated: AnimatedTile[],
  keep?: KeepTile,
): void => {
  for (let y = 0; y < map.h; y += 1) {
    for (let x = 0; x < map.w; x += 1) {
      const v = layer.grid[y * map.w + x] ?? -1;
      if (v < 0) {
        continue;
      }
      const idx = tileIndex(v);
      if (keep && !keep(idx, x, y)) {
        continue;
      }
      const seq = animBySeqMember.get(idx);
      if (!tileFlipX(v) && !tileFlipY(v) && !tileRotate(v) && !seq) {
        continue;
      }
      const t = tl.getTileAt(x, y);
      if (!t) {
        continue;
      }
      applyTileTransform(t, v);
      if (seq) {
        animated.push({ seq, tile: t });
      }
    }
  }
};

/** member tile index -> animation sequence */
const animationIndex = (map: WorldMap): Map<number, number[]> => {
  const animBySeqMember = new Map<number, number[]>();
  for (const seq of map.animations) {
    for (const f of seq) {
      if (!animBySeqMember.has(f)) {
        animBySeqMember.set(f, seq);
      }
    }
  }
  return animBySeqMember;
};

// decoration_01's solid props y-sort as images rather than flat tilemap cells.
const renderSolidDeco = (map: WorldMap, deco1: WorldMapTileLayer, imageTile: ImageTile): void => {
  for (let y = 0; y < map.h; y += 1) {
    for (let x = 0; x < map.w; x += 1) {
      const v = deco1.grid[y * map.w + x] ?? -1;
      if (v < 0 || !isDecoSolidIndex(tileIndex(v)) || inField(x, y)) {
        continue;
      }
      imageTile(v, x, y, DEPTH.entityBase + (y + 1) * TILE);
    }
  }
};

// Sprites whose base sits inside a structure are mounted on it (windmill
// blades, roof props) — GM draws asset layers above building tiles, so lift
// them just over their structure instead of y-sorting underneath it.
const mountedDepth = (
  map: WorldMap,
  structures: Components,
  s: WorldMapSprite,
  def: DecoDef,
  bottomY: number,
): number => {
  const ax = Math.floor((s.x - def.ox + def.fw / 2) / TILE);
  const ay = Math.floor((bottomY - 1) / TILE);
  if (ax < 0 || ax >= map.w || ay < 0 || ay >= map.h) {
    return DEPTH.entityBase + bottomY;
  }
  const ci = structures.compId[ay * map.w + ax] ?? -1;
  const bottom = ci >= 0 ? structures.bottoms[ci] : undefined;
  if (bottom === undefined) {
    return DEPTH.entityBase + bottomY;
  }
  return DEPTH.entityBase + (bottom + 1) * TILE + 0.5;
};

/** Placed sprites (anims pre-created by BootScene). Returns how many were skipped. */
const placeSprites = (
  scene: Phaser.Scene,
  map: WorldMap,
  skipSprites: ReadonlySet<WorldMapSprite>,
  structures: Components,
): number => {
  let skipped = 0;
  for (const s of map.sprites) {
    if (skipSprites.has(s)) {
      skipped += 1;
      continue;
    }
    const def = map.deco[s.sprite];
    if (!def) {
      continue;
    }
    const key = `deco-${s.sprite}`;
    if (!scene.textures.get("deco-atlas").has(`${s.sprite}/0`)) {
      continue;
    }
    const spr = scene.add.sprite(s.x, s.y, "deco-atlas", `${s.sprite}/0`);
    spr.setOrigin(def.fw > 0 ? def.ox / def.fw : 0.5, def.fh > 0 ? def.oy / def.fh : 0.5);
    spr.setScale(s.sx, s.sy);
    // shadow frames are baked opaque; the soft look is object alpha (tunable)
    const isPureShadow = s.sprite.endsWith("shadow") && !s.sprite.endsWith("withshadow");
    if (isPureShadow) {
      spr.setAlpha(0.3);
    }
    const bottomY = s.y - def.oy + def.fh;
    const isOverlay = s.sprite.startsWith("chimneysmoke") || s.sprite.startsWith("spr_deco_glint");
    if (isOverlay) {
      spr.setDepth(D.overlayFx);
    } else if (s.layer === "Assets_2") {
      spr.setDepth(D.groundProps);
    } else {
      spr.setDepth(
        isPureShadow ? DEPTH.entityBase + bottomY : mountedDepth(map, structures, s, def, bottomY),
      );
    }
    if (def.frames > 1 && scene.anims.exists(key)) {
      spr.play(key);
      spr.anims.setProgress(Math.random());
    }
  }
  return skipped;
};

export const buildWorldMap = (
  scene: Phaser.Scene,
  map: WorldMap,
  skipSprites: ReadonlySet<WorldMapSprite>,
): WorldMapRenderResult => {
  const animBySeqMember = animationIndex(map);
  const animated: AnimatedTile[] = [];

  const makeLayer = (
    layer: WorldMapTileLayer,
    depth: number,
    keep?: KeepTile,
  ): Phaser.Tilemaps.TilemapLayer | null => {
    const rows = buildLayerRows(map, layer, keep);
    if (!rows) {
      return null;
    }
    const tm = scene.make.tilemap({ data: rows, tileHeight: TILE, tileWidth: TILE });
    const tileset = tm.addTilesetImage("atlas");
    if (!tileset) {
      return null;
    }
    const created = tm.createLayer(0, tileset, 0, 0);
    if (!(created instanceof Tilemaps.TilemapLayer)) {
      return null;
    }
    const tl = created;
    tl.setDepth(depth);
    decorateLayer(map, layer, tl, animBySeqMember, animated, keep);
    return tl;
  };

  // Individual y-sorted images for tiles that must sort against entities.
  // `bottomTy` overrides the sort row (component bottom for buildings).
  const imageTile: ImageTile = (v, tx, ty, depth) => {
    const idx = tileIndex(v);
    // centre origin so the 90° rotation stays inside the cell
    const img = scene.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, "atlas", idx);
    img.setFlip(tileFlipX(v), tileFlipY(v));
    if (tileRotate(v)) {
      img.setRotation(Math.PI / 2);
    }
    img.setDepth(depth);
  };

  // ---- flat tilemap layers ----
  const sea = layerByName(map, "sea");
  if (sea) {
    makeLayer(sea, D.sea);
  }
  const cloudsUnder = layerByName(map, "clouds_02");
  if (cloudsUnder) {
    makeLayer(cloudsUnder, D.cloudsUnder);
  }
  const land = layerByName(map, "land");
  if (land) {
    makeLayer(land, D.land);
  }
  const paths = layerByName(map, "paths");
  if (paths) {
    makeLayer(paths, D.paths);
  }
  const shadows = layerByName(map, "shadows");
  if (shadows) {
    makeLayer(shadows, D.shadows);
  }

  // decoration_01: flat dressing stays a tilemap; solid props y-sort as images.
  const deco1 = layerByName(map, "decoration_01");
  if (deco1) {
    makeLayer(deco1, D.decoFlat, (idx, tx, ty) => !isDecoSolidIndex(idx) && !inField(tx, ty));
    renderSolidDeco(map, deco1, imageTile);
  }

  // ---- structures: connected components across the tall layers ----
  // building/walls/decoration_02/decoration_03 fuse into one component per
  // structure; forest canopies cluster separately. Components y-sort by their
  // bottom row so the player walks behind and in front correctly.
  const structureLayers = ["building", "walls", "decoration_02", "decoration_03"]
    .map((n) => layerByName(map, n))
    .filter((l): l is WorldMapTileLayer => l !== null);
  const structures = renderComponents(map, structureLayers, (x, y) => !inField(x, y), imageTile);
  const forest = layerByName(map, "forest");
  if (forest) {
    renderComponents(map, [forest], () => true, imageTile);
  }

  const skipped = placeSprites(scene, map, skipSprites, structures);

  // ---- top clouds + their cast shadows, with a slow drift ----
  const cloudTargets: Phaser.Tilemaps.TilemapLayer[] = [];
  const cloudShadow = layerByName(map, "cloud_shadow");
  if (cloudShadow) {
    const l = makeLayer(cloudShadow, D.cloudShadow);
    if (l) {
      cloudTargets.push(l);
    }
  }
  const clouds = layerByName(map, "clouds_01");
  if (clouds) {
    const l = makeLayer(clouds, D.clouds);
    if (l) {
      cloudTargets.push(l);
    }
  }
  if (cloudTargets.length > 0) {
    scene.tweens.add({
      duration: 26_000,
      ease: "Sine.easeInOut",
      repeat: -1,
      targets: cloudTargets,
      x: { from: -10, to: 10 },
      yoyo: true,
    });
  }

  // ---- tile animations (water foam, waterfalls, sparkles) ----
  if (animated.length > 0) {
    let tick = 0;
    scene.time.addEvent({
      callback: () => {
        tick += 1;
        for (const a of animated) {
          const f = a.seq[tick % a.seq.length];
          if (f !== undefined) {
            a.tile.index = f;
          }
        }
      },
      delay: 1000 / Math.max(1, map.animationFps),
      loop: true,
    });
  }

  return { skippedSprites: skipped };
};
