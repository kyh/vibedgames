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

const D = {
  cloudShadow: 800_000,
  clouds: 850_000,
  cloudsUnder: DEPTH.ground + 0.2,
  decoFlat: DEPTH.decalLow,
  groundProps: DEPTH.decalLow + 0.5,
  land: DEPTH.ground + 0.4,
  overlayFx: 700_000,
  paths: DEPTH.ground + 0.6,
  sea: DEPTH.ground,
  shadows: DEPTH.ground + 0.8,
} as const;

interface AnimatedTile {
  tile: Phaser.Tilemaps.Tile;
  seq: number[];
}

export interface WorldMapRenderResult {
  skippedSprites: number;
}

type KeepTile = (idx: number, tx: number, ty: number) => boolean;

type ImageTile = (v: number, tx: number, ty: number, depth: number) => void;

interface Components {
  compId: Int32Array;
  bottoms: number[];
}

const markOccupied = (
  map: WorldMap,
  layers: WorldMapTileLayer[],
  keep: (x: number, y: number) => boolean,
) => {
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

const labelComponents = (w: number, h: number, occupied: Uint8Array) => {
  const compId = new Int32Array(w * h).fill(-1);
  const bottoms: number[] = [];

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const start = y * w + x;

      if ((occupied[start] ?? 0) === 0 || compId[start] !== -1) {
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

            if ((occupied[ni] ?? 0) !== 0 && compId[ni] === -1) {
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

const drawComponents = (
  map: WorldMap,
  layers: WorldMapTileLayer[],
  components: Components,
  imageTile: ImageTile,
) => {
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

const renderComponents = (
  map: WorldMap,
  layers: WorldMapTileLayer[],
  keep: (x: number, y: number) => boolean,
  imageTile: ImageTile,
) => {
  const occupied = markOccupied(map, layers, keep);
  const components = labelComponents(map.w, map.h, occupied);
  drawComponents(map, layers, components, imageTile);

  return components;
};

const buildLayerRows = (map: WorldMap, layer: WorldMapTileLayer, keep?: KeepTile) => {
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

const applyTileTransform = (t: Phaser.Tilemaps.Tile, v: number) => {
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

const decorateLayer = (
  map: WorldMap,
  layer: WorldMapTileLayer,
  tl: Phaser.Tilemaps.TilemapLayer,
  animBySeqMember: ReadonlyMap<number, number[]>,
  animated: AnimatedTile[],
  keep?: KeepTile,
) => {
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

const animationIndex = (map: WorldMap) => {
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

const renderSolidDeco = (map: WorldMap, deco1: WorldMapTileLayer, imageTile: ImageTile) => {
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

const mountedDepth = (
  map: WorldMap,
  structures: Components,
  s: WorldMapSprite,
  def: DecoDef,
  bottomY: number,
) => {
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

const placeSprites = (
  scene: Phaser.Scene,
  map: WorldMap,
  skipSprites: ReadonlySet<WorldMapSprite>,
  structures: Components,
) => {
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
) => {
  const animBySeqMember = animationIndex(map);
  const animated: AnimatedTile[] = [];

  const makeLayer = (layer: WorldMapTileLayer, depth: number, keep?: KeepTile) => {
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

  const imageTile: ImageTile = (v, tx, ty, depth) => {
    const idx = tileIndex(v);
    const img = scene.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, "atlas", idx);
    img.setFlip(tileFlipX(v), tileFlipY(v));

    if (tileRotate(v)) {
      img.setRotation(Math.PI / 2);
    }

    img.setDepth(depth);
  };

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

  const deco1 = layerByName(map, "decoration_01");

  if (deco1) {
    makeLayer(deco1, D.decoFlat, (idx, tx, ty) => !isDecoSolidIndex(idx) && !inField(tx, ty));
    renderSolidDeco(map, deco1, imageTile);
  }

  const structureLayers = ["building", "walls", "decoration_02", "decoration_03"].flatMap((n) => {
    const l = layerByName(map, n);

    return l === null ? [] : [l];
  });

  const structures = renderComponents(map, structureLayers, (x, y) => !inField(x, y), imageTile);
  const forest = layerByName(map, "forest");

  if (forest) {
    renderComponents(map, [forest], () => true, imageTile);
  }

  const skipped = placeSprites(scene, map, skipSprites, structures);

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
