import Phaser from "phaser";
import { TILE, DEPTH } from "../config";
import {
  type TracedMap,
  type TracedTileLayer,
  type TracedSprite,
  tileIndex,
  tileFlipX,
  tileFlipY,
  tileRotate,
  isDecoSolidIndex,
  inField,
  layerByName,
} from "../world/traced";

// Extra depths used only by the traced renderer. Entities y-sort in
// [DEPTH.entityBase .. ~entityBase + mapHeightPx]; overlays sit above them.
const D = {
  sea: DEPTH.ground, // 0
  cloudsUnder: DEPTH.ground + 0.2, // clouds peeking out under the island
  land: DEPTH.ground + 0.4,
  paths: DEPTH.ground + 0.6,
  shadows: DEPTH.ground + 0.8, // baked prop shadows (under tilled soil)
  decoFlat: DEPTH.decalLow, // walk-over dressing
  groundProps: DEPTH.decalLow + 0.5, // Assets_2: rugs, oars, small floor props
  overlayFx: 700_000, // chimney smoke, glints — above all entities
  cloudShadow: 800_000,
  clouds: 850_000,
} as const;

type AnimatedTile = { tile: Phaser.Tilemaps.Tile; seq: number[] };

export type TracedRenderResult = { skippedSprites: number };

export function buildTracedMap(
  scene: Phaser.Scene,
  map: TracedMap,
  skipSprites: ReadonlySet<TracedSprite>,
): TracedRenderResult {
  // member tile index -> animation sequence
  const animBySeqMember = new Map<number, number[]>();
  for (const seq of map.animations)
    for (const f of seq) if (!animBySeqMember.has(f)) animBySeqMember.set(f, seq);
  const animated: AnimatedTile[] = [];

  const makeLayer = (
    layer: TracedTileLayer,
    depth: number,
    keep?: (idx: number, tx: number, ty: number) => boolean,
  ): Phaser.Tilemaps.TilemapLayer | null => {
    const rows: number[][] = [];
    let any = false;
    for (let y = 0; y < map.h; y++) {
      const row: number[] = [];
      for (let x = 0; x < map.w; x++) {
        const v = layer.grid[y * map.w + x] ?? -1;
        const idx = v >= 0 ? tileIndex(v) : -1;
        if (v >= 0 && (!keep || keep(idx, x, y))) {
          row.push(idx);
          any = true;
        } else row.push(-1);
      }
      rows.push(row);
    }
    if (!any) return null;
    const tm = scene.make.tilemap({ data: rows, tileWidth: TILE, tileHeight: TILE });
    const tileset = tm.addTilesetImage("atlas");
    if (!tileset) return null;
    const created = tm.createLayer(0, tileset, 0, 0);
    if (!(created instanceof Phaser.Tilemaps.TilemapLayer)) return null;
    const tl = created;
    tl.setDepth(depth);
    // transforms + animation registration
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const v = layer.grid[y * map.w + x] ?? -1;
        if (v < 0) continue;
        const idx = tileIndex(v);
        if (keep && !keep(idx, x, y)) continue;
        const fx = tileFlipX(v);
        const fy = tileFlipY(v);
        const rot = tileRotate(v);
        const seq = animBySeqMember.get(idx);
        if (!fx && !fy && !rot && !seq) continue;
        const t = tl.getTileAt(x, y);
        if (!t) continue;
        // Phaser 4.1's tile transformer offsets flipY tiles by a tile; since
        // flips apply before rotation, flipY ≡ flipX + 180° — never set flipY.
        let rotation = rot ? Math.PI / 2 : 0;
        let flipX = fx;
        if (fy) {
          flipX = !fx;
          rotation += Math.PI;
        }
        if (flipX) t.flipX = true;
        if (rotation !== 0) t.rotation = rotation;
        if (seq) animated.push({ tile: t, seq });
      }
    }
    return tl;
  };

  // Individual y-sorted images for tiles that must sort against entities.
  // `bottomTy` overrides the sort row (component bottom for buildings).
  const imageTile = (v: number, tx: number, ty: number, depth: number): void => {
    const idx = tileIndex(v);
    // centre origin so the 90° rotation stays inside the cell
    const img = scene.add.image(tx * TILE + TILE / 2, ty * TILE + TILE / 2, "atlas-sheet", idx);
    img.setFlip(tileFlipX(v), tileFlipY(v));
    if (tileRotate(v)) img.setRotation(Math.PI / 2);
    img.setDepth(depth);
  };

  // ---- flat tilemap layers ----
  const sea = layerByName(map, "sea");
  if (sea) makeLayer(sea, D.sea);
  const cloudsUnder = layerByName(map, "clouds_02");
  if (cloudsUnder) makeLayer(cloudsUnder, D.cloudsUnder);
  const land = layerByName(map, "land");
  if (land) makeLayer(land, D.land);
  const paths = layerByName(map, "paths");
  if (paths) makeLayer(paths, D.paths);
  const shadows = layerByName(map, "shadows");
  if (shadows) makeLayer(shadows, D.shadows);

  // decoration_01: flat dressing stays a tilemap; solid props y-sort as images.
  const deco1 = layerByName(map, "decoration_01");
  if (deco1) {
    makeLayer(deco1, D.decoFlat, (idx, tx, ty) => !isDecoSolidIndex(idx) && !inField(tx, ty));
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        const v = deco1.grid[y * map.w + x] ?? -1;
        if (v < 0 || !isDecoSolidIndex(tileIndex(v)) || inField(x, y)) continue;
        imageTile(v, x, y, DEPTH.entityBase + (y + 1) * TILE);
      }
  }

  // ---- structures: connected components across the tall layers ----
  // building/walls/decoration_02/decoration_03 fuse into one component per
  // structure; forest canopies cluster separately. Components y-sort by their
  // bottom row so the player walks behind and in front correctly.
  const structureLayers = ["building", "walls", "decoration_02", "decoration_03"]
    .map((n) => layerByName(map, n))
    .filter((l): l is TracedTileLayer => l !== null);
  const structures = renderComponents(map, structureLayers, (x, y) => !inField(x, y), imageTile);
  const forest = layerByName(map, "forest");
  if (forest) renderComponents(map, [forest], () => true, imageTile);

  // ---- placed sprites (anims pre-created by BootScene) ----
  let skipped = 0;
  for (const s of map.sprites) {
    if (skipSprites.has(s)) {
      skipped++;
      continue;
    }
    const def = map.deco[s.sprite];
    if (!def) continue;
    const key = `deco-${s.sprite}`;
    if (!scene.textures.get("deco-atlas").has(`${s.sprite}/0`)) continue;
    const spr = scene.add.sprite(s.x, s.y, "deco-atlas", `${s.sprite}/0`);
    spr.setOrigin(def.fw > 0 ? def.ox / def.fw : 0.5, def.fh > 0 ? def.oy / def.fh : 0.5);
    spr.setScale(s.sx, s.sy);
    // shadow frames are baked opaque; the soft look is object alpha (tunable)
    const isPureShadow = s.sprite.endsWith("shadow") && !s.sprite.endsWith("withshadow");
    if (isPureShadow) spr.setAlpha(0.3);
    const bottomY = s.y - def.oy + def.fh;
    const isOverlay = s.sprite.startsWith("chimneysmoke") || s.sprite.startsWith("spr_deco_glint");
    if (isOverlay) spr.setDepth(D.overlayFx);
    else if (s.layer === "Assets_2") spr.setDepth(D.groundProps);
    else {
      // Sprites whose base sits inside a structure are mounted on it (windmill
      // blades, roof props) — GM draws asset layers above building tiles, so
      // lift them just over their structure instead of y-sorting underneath it.
      let depth = DEPTH.entityBase + bottomY;
      if (!isPureShadow) {
        const ax = Math.floor((s.x - def.ox + def.fw / 2) / TILE);
        const ay = Math.floor((bottomY - 1) / TILE);
        if (ax >= 0 && ax < map.w && ay >= 0 && ay < map.h) {
          const ci = structures.compId[ay * map.w + ax] ?? -1;
          const bottom = ci >= 0 ? structures.bottoms[ci] : undefined;
          if (bottom !== undefined) depth = DEPTH.entityBase + (bottom + 1) * TILE + 0.5;
        }
      }
      spr.setDepth(depth);
    }
    if (def.frames > 1 && scene.anims.exists(key)) {
      spr.play(key);
      spr.anims.setProgress(Math.random());
    }
  }

  // ---- top clouds + their cast shadows, with a slow drift ----
  const cloudTargets: Phaser.Tilemaps.TilemapLayer[] = [];
  const cloudShadow = layerByName(map, "cloud_shadow");
  if (cloudShadow) {
    const l = makeLayer(cloudShadow, D.cloudShadow);
    if (l) cloudTargets.push(l);
  }
  const clouds = layerByName(map, "clouds_01");
  if (clouds) {
    const l = makeLayer(clouds, D.clouds);
    if (l) cloudTargets.push(l);
  }
  if (cloudTargets.length > 0) {
    scene.tweens.add({
      targets: cloudTargets,
      x: { from: -10, to: 10 },
      duration: 26_000,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  // ---- tile animations (water foam, waterfalls, sparkles) ----
  if (animated.length > 0) {
    let tick = 0;
    scene.time.addEvent({
      delay: 1000 / Math.max(1, map.animationFps),
      loop: true,
      callback: () => {
        tick++;
        for (const a of animated) {
          const f = a.seq[tick % a.seq.length];
          if (f !== undefined) a.tile.index = f;
        }
      },
    });
  }

  return { skippedSprites: skipped };
}

type Components = { compId: Int32Array; bottoms: number[] };

// Flood-fill (8-neighbour) connected components over a set of layers; render
// each component's tiles in layer paint order at a shared bottom-row depth.
function renderComponents(
  map: TracedMap,
  layers: TracedTileLayer[],
  keep: (x: number, y: number) => boolean,
  imageTile: (v: number, tx: number, ty: number, depth: number) => void,
): Components {
  const { w, h } = map;
  const occupied = new Uint8Array(w * h);
  for (const l of layers)
    for (let i = 0; i < w * h; i++)
      if ((l.grid[i] ?? -1) >= 0 && keep(i % w, (i / w) | 0)) occupied[i] = 1;

  const compId = new Int32Array(w * h).fill(-1);
  const bottoms: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!occupied[start] || compId[start] !== -1) continue;
      const id = bottoms.length;
      let bottom = y;
      const queue = [start];
      compId[start] = id;
      while (queue.length > 0) {
        const cur = queue.pop();
        if (cur === undefined) break;
        const cx = cur % w;
        const cy = (cur / w) | 0;
        bottom = Math.max(bottom, cy);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (occupied[ni] && compId[ni] === -1) {
              compId[ni] = id;
              queue.push(ni);
            }
          }
      }
      bottoms.push(bottom);
    }
  }

  // draw per layer (paint order), each tile at its component's bottom depth
  for (const l of layers) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = l.grid[y * w + x] ?? -1;
        const id = compId[y * w + x] ?? -1;
        if (v < 0 || id < 0) continue;
        const bottom = bottoms[id] ?? y;
        imageTile(v, x, y, DEPTH.entityBase + (bottom + 1) * TILE);
      }
  }
  return { compId, bottoms };
}
