import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { BRIDGE_PILLAR_WIDE, modelUrl, PARK_TREES, ROAD_BRIDGE } from "../assets/manifest";
import { GRID_X, GRID_Z, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { CityPlan } from "./grid";
import type { Solid, SurfaceDeck } from "./city";
import type { Terrain } from "./terrain";

// The DRIVABLE Golden Gate: a ramp climbs from the northernmost Presidio road
// onto an international-orange deck that runs out over the strait and lands
// on the Marin side — Battery Ridge (see sf-map's headland strip), a grass
// hill crowned by a parapet-ringed overlook turnaround. Surface overrides
// (SurfaceDeck) carry the car over the water; on the headland it simply
// drives the terrain. The visual bridge (towers, catenary cables, kit deck
// boards) is built to match the decks exactly.

const DECK_Y = 7; // drive height over the water
const DECK_W = 10; // drivable width
const RAMP_LEN = 26;
const RAIL_T = 0.8;
const TOWER_H = 26; // above deck
// Hunt for the shore anchor around u≈0.25 (map fractions, not world units —
// the map rescales).
const APPROACH_U_MIN = 0.19;
const APPROACH_U_MAX = 0.35;

const ORANGE = new THREE.MeshStandardMaterial({ color: 0xc0362c, roughness: 0.6 });
const RAIL_ORANGE = new THREE.MeshStandardMaterial({ color: 0xa93227, roughness: 0.7 });

// Deterministic 0..1 jitter (world gen must not consume Math.random).
const jit = (i: number, k: number): number => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export type GoldenGateCtx = {
  readonly plan: CityPlan;
  readonly terrain: Terrain;
  readonly cache: ModelCache;
  readonly worldX: (gx: number) => number;
  readonly worldZ: (gz: number) => number;
};

export type GoldenGateResult = {
  readonly objects: THREE.Object3D[];
  readonly solids: Solid[];
  readonly decks: readonly SurfaceDeck[];
  readonly openWaterCells: ReadonlySet<string>;
};

function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  m.updateMatrixWorld(true);
  return m;
}

export function buildGoldenGate(ctx: GoldenGateCtx): GoldenGateResult {
  const objects: THREE.Object3D[] = [];
  const solids: Solid[] = [];
  const decks: SurfaceDeck[] = [];
  const openWaterCells = new Set<string>();

  // --- Anchor: the northernmost road cell on the Presidio coast near u 0.25 ---
  let anchor: { gx: number; gz: number } | null = null;
  for (let gx = 0; gx < GRID_X; gx++) {
    const wx = ctx.worldX(gx);
    const u = wx / WORLD_W + 0.5;
    if (u < APPROACH_U_MIN || u > APPROACH_U_MAX) continue;
    for (let gz = 8; gz < GRID_Z; gz++) {
      // gz >= 8 skips the Marin headland strip (v < 0.04): the anchor must
      // stay on the Presidio shore even now that land exists across the water.
      if (ctx.plan.cells[gx]?.[gz] !== "road") continue;
      if (!anchor || gz < anchor.gz) anchor = { gx, gz };
      break; // first road in this column is the northernmost
    }
  }
  if (!anchor) return { objects, solids, decks, openWaterCells };

  const ax = ctx.worldX(anchor.gx);
  const shoreZ = ctx.worldZ(anchor.gz);
  const shoreH = ctx.terrain.heightAt(ax, shoreZ) + 0.04;
  const endZ = -WORLD_HALF_Z + 3.5; // fallback dead-end just inside the border wall
  // Fit the ramp to the water span actually available; cap the climb at ~20°.
  const span = shoreZ - endZ;
  const rampLen = THREE.MathUtils.clamp(span * 0.6, 10, RAMP_LEN);
  const deckY = Math.min(DECK_Y, shoreH + rampLen * 0.36);
  const rampTopZ = shoreZ - rampLen; // north = -Z
  const half = DECK_W / 2;

  // --- Marin landfall: where Battery Ridge climbs through deck height. The
  // deck overlaps the rising ground a touch and max(deck, terrain) hands the
  // car to the hill seamlessly. If the ridge is somehow missing (terrain
  // never reaches deck height), fall back to the old railed dead-end. ---
  let landfallZ: number | null = null;
  for (let z = rampTopZ - 8; z >= -WORLD_HALF_Z + 6; z -= 2) {
    if (ctx.terrain.heightAt(ax, z) >= deckY - 0.2) {
      landfallZ = z;
      break;
    }
  }
  const northEndZ = landfallZ ?? endZ;

  // --- Drivable surface ---
  // Two-stage ramp (steep, then a gentle crown) so cresting onto the deck at
  // speed pops a small hop instead of launching you into the end barrier.
  const kneeZ = shoreZ - rampLen * 0.68;
  const kneeY = shoreH + (deckY - shoreH) * 0.8;
  decks.push({ minX: ax - half, maxX: ax + half, minZ: kneeZ, maxZ: shoreZ, y: kneeY, y2: shoreH });
  decks.push({
    minX: ax - half,
    maxX: ax + half,
    minZ: rampTopZ,
    maxZ: kneeZ,
    y: deckY,
    y2: kneeY,
  });
  // Deck out across the strait to the Marin landfall (or the fallback pad).
  decks.push({ minX: ax - half, maxX: ax + half, minZ: northEndZ - 4, maxZ: rampTopZ, y: deckY });
  // Landfall transition ramp: a planar blend from the flat deck up onto the
  // hillside. Without it the deck abuts the rising slope in one kink and a
  // full-speed crossing slams the nose and scrubs to a crawl.
  if (landfallZ !== null) {
    const blendTopZ = landfallZ - 18;
    const blendTopY = ctx.terrain.heightAt(ax, blendTopZ) + 0.05;
    if (blendTopY > deckY) {
      decks.push({
        minX: ax - half,
        maxX: ax + half,
        minZ: blendTopZ,
        maxZ: landfallZ + 8,
        y: blendTopY,
        y2: deckY,
      });
    }
  }

  // --- Rails (full height; you do not fall off the Golden Gate) ---
  const railMinZ = landfallZ !== null ? landfallZ - 1 : endZ;
  const railMaxZ = shoreZ - 1;
  solids.push({ minX: ax - half - RAIL_T, maxX: ax - half, minZ: railMinZ, maxZ: railMaxZ });
  solids.push({ minX: ax + half, maxX: ax + half + RAIL_T, minZ: railMinZ, maxZ: railMaxZ });
  // End barrier only on the dead-end fallback — landfall is an open road.
  if (landfallZ === null) {
    solids.push({
      minX: ax - half - RAIL_T,
      maxX: ax + half + RAIL_T,
      minZ: endZ - 1.2,
      maxZ: endZ,
    });
  }

  // --- Open the water cells the span crosses (no invisible shoreline walls) ---
  for (let gz = anchor.gz; gz >= 0; gz--) {
    if (ctx.plan.cells[anchor.gx]?.[gz] === "water") openWaterCells.add(`${anchor.gx},${gz}`);
  }

  // --- Visuals ---
  // Deck boards: kit bridge segments, flat along the deck + pitched on the ramp.
  const deckUrl = modelUrl("roads", ROAD_BRIDGE);
  const db = ctx.cache.bounds(deckUrl);
  const segLen = 8;
  const boardScaleX = (DECK_W + 1.6) / Math.max(db.size.x, 0.001);
  const boardScaleZ = segLen / Math.max(db.size.z, 0.001);
  // Height along the two-stage ramp, t = 0 at the shore, 1 at the deck.
  const rampProfile = (t: number): number => {
    const tc = THREE.MathUtils.clamp(t, 0, 1);
    return tc < 0.68
      ? THREE.MathUtils.lerp(shoreH, kneeY, tc / 0.68)
      : THREE.MathUtils.lerp(kneeY, deckY, (tc - 0.68) / 0.32);
  };
  const rampSegs = Math.ceil(rampLen / 4);
  const rampSegLen = rampLen / rampSegs;
  for (let i = 0; i < rampSegs; i++) {
    const t0 = i / rampSegs;
    const t1 = (i + 1) / rampSegs;
    const h0 = rampProfile(t0);
    const h1 = rampProfile(t1);
    const pitch = Math.atan((h1 - h0) / rampSegLen);
    const seg = ctx.cache.instance(deckUrl);
    seg.scale.set(boardScaleX, 1.6, rampSegLen / Math.max(db.size.z, 0.001) / Math.cos(pitch));
    seg.position.set(ax, (h0 + h1) / 2 - 0.32, shoreZ - rampSegLen * (i + 0.5));
    seg.rotation.x = pitch;
    seg.updateMatrixWorld(true);
    objects.push(seg);
  }
  for (let z = rampTopZ; z > northEndZ - segLen; z -= segLen) {
    const seg = ctx.cache.instance(deckUrl);
    seg.scale.set(boardScaleX, 1.6, boardScaleZ);
    seg.position.set(ax, deckY - 0.32, z - segLen / 2);
    seg.updateMatrixWorld(true);
    objects.push(seg);
  }
  // Boards over the landfall transition ramp — the drive surface there is a
  // planar blend floating up to ~0.5u above the grass chord, so it must LOOK
  // paved or the car reads as hovering.
  if (landfallZ !== null) {
    const blendTopZ = landfallZ - 18;
    const blendTopY = ctx.terrain.heightAt(ax, blendTopZ) + 0.05;
    if (blendTopY > deckY) {
      const runLen = landfallZ + 8 - blendTopZ;
      const pitch = Math.atan((blendTopY - deckY) / runLen);
      const nSegs = Math.ceil(runLen / 6);
      const segZ = runLen / nSegs;
      for (let i = 0; i < nSegs; i++) {
        const zMid = landfallZ + 8 - segZ * (i + 0.5);
        const t = (landfallZ + 8 - zMid) / runLen;
        const seg = ctx.cache.instance(deckUrl);
        seg.scale.set(boardScaleX, 1.6, segZ / Math.max(db.size.z, 0.001) / Math.cos(pitch));
        seg.position.set(ax, deckY + (blendTopY - deckY) * t - 0.32, zMid);
        seg.rotation.x = pitch;
        seg.updateMatrixWorld(true);
        objects.push(seg);
      }
    }
  }

  // Side rails (visual, matches the solids).
  const railLen = railMaxZ - railMinZ;
  const railGeo = new THREE.BoxGeometry(RAIL_T, 1.1, railLen);
  for (const sx of [-(half + RAIL_T / 2), half + RAIL_T / 2]) {
    objects.push(mesh(railGeo, RAIL_ORANGE, ax + sx, deckY + 0.55, (railMinZ + railMaxZ) / 2));
  }
  if (landfallZ === null) {
    objects.push(
      mesh(
        new THREE.BoxGeometry(DECK_W + RAIL_T * 2, 1.6, 1.2),
        RAIL_ORANGE,
        ax,
        deckY + 0.8,
        endZ - 0.6,
      ),
    );
  }

  // Piers under the deck.
  const pillarUrl = modelUrl("roads", BRIDGE_PILLAR_WIDE);
  const pb = ctx.cache.bounds(pillarUrl);
  for (const pz of [rampTopZ - 6, (rampTopZ + northEndZ) / 2]) {
    const p = ctx.cache.instance(pillarUrl);
    p.scale.set(
      (DECK_W + 2) / Math.max(pb.size.x, 0.001),
      (deckY + 0.5) / Math.max(pb.size.y, 0.001),
      4 / Math.max(pb.size.z, 0.001),
    );
    p.position.set(ax, -0.6, pz);
    p.updateMatrixWorld(true);
    objects.push(p);
  }

  // Tower: legs OUTSIDE the drivable width, portal beams the car passes under.
  // With a Marin landfall the tower stands in the water just off the headland
  // (where the real north tower lives); the fallback keeps it near the border.
  const towerZ =
    landfallZ !== null ? Math.min(landfallZ + 18, rampTopZ - 10) : -WORLD_HALF_Z + 14;
  const topY = deckY + TOWER_H;
  for (const sx of [-(half + 2.2), half + 2.2]) {
    objects.push(
      mesh(
        new THREE.BoxGeometry(2, TOWER_H + deckY + 2, 2),
        ORANGE,
        ax + sx,
        (topY + 1) / 2 - 1,
        towerZ,
      ),
    );
  }
  for (const by of [deckY + 8.5, deckY + 17, topY - 1.5]) {
    objects.push(mesh(new THREE.BoxGeometry(DECK_W + 6.4, 1.4, 1.4), ORANGE, ax, by, towerZ));
  }

  // Main cables: catenary from the shore anchorage over the tower top, plus
  // suspenders down to the deck.
  for (const sx of [-(half + 2.2), half + 2.2]) {
    // North cable end: buried into the Battery Ridge hillside (a real
    // anchorage) when the bridge lands; run off-map on the fallback.
    const cableEnd =
      landfallZ !== null
        ? new THREE.Vector3(
            ax + sx,
            ctx.terrain.heightAt(ax + sx, northEndZ - 14) + 0.8,
            northEndZ - 14,
          )
        : new THREE.Vector3(ax + sx, topY - 6, -WORLD_HALF_Z - 8);
    const pts = [
      new THREE.Vector3(ax + sx, shoreH + 1.5, shoreZ + 2),
      new THREE.Vector3(ax + sx, deckY + 5, (rampTopZ + towerZ) / 2),
      new THREE.Vector3(ax + sx, topY - 0.5, towerZ),
      cableEnd,
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.22, 6), ORANGE);
    cable.castShadow = true;
    cable.updateMatrixWorld(true);
    objects.push(cable);
    for (let i = 1; i <= 8; i++) {
      const t = i / 9;
      const p = curve.getPoint(t);
      if (p.z < railMinZ || p.z > railMaxZ) continue;
      const h = p.y - (deckY + 1);
      if (h < 1) continue;
      objects.push(mesh(new THREE.BoxGeometry(0.14, h, 0.14), ORANGE, p.x, deckY + 1 + h / 2, p.z));
    }
  }

  // Anchorage blocks flanking the ramp entry.
  for (const sx of [-(half + 1.6), half + 1.6]) {
    objects.push(
      mesh(new THREE.BoxGeometry(2.6, 3.2, 4.5), ORANGE, ax + sx, shoreH + 1.2, shoreZ - 3),
    );
  }

  // --- Battery Ridge Overlook: a parapet-ringed turnaround on the Marin
  // crest. The car climbs the grass from the landfall; the stone arc opens
  // south so the drive rolls straight onto the terrace, U-turns at the rim
  // and heads back over the bridge. Every wall segment emits its solid and
  // its visual in one breath (the seawall rule), and every seated tree
  // carries its own trunk solid — nothing here can become an invisible wall.
  if (landfallZ !== null) {
    const STONE = new THREE.MeshStandardMaterial({ color: 0x9aa2a6, roughness: 1 });
    const ox = ax;
    const oz = -WORLD_HALF_Z + 20;
    const R = 16;
    const SEGS = 14;
    const ARC = (Math.PI * 260) / 180; // open wedge faces south (the entry)
    const wallLen = 4.6;
    for (let i = 0; i < SEGS; i++) {
      const a = -ARC / 2 + (ARC * (i + 0.5)) / SEGS; // 0 = due north (rim)
      const px = ox + R * Math.sin(a);
      const pz = oz - R * Math.cos(a);
      const py = ctx.terrain.heightAt(px, pz);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(wallLen, 1.05, 0.66), STONE);
      wall.position.set(px, py + 0.38, pz);
      wall.rotation.y = -a; // long axis along the arc tangent
      wall.castShadow = true;
      wall.receiveShadow = true;
      wall.updateMatrixWorld(true);
      objects.push(wall);
      solids.push({
        minX: px - wallLen / 2,
        maxX: px + wallLen / 2,
        minZ: pz - 0.33,
        maxZ: pz + 0.33,
        yaw: -a,
      });
    }

    // Terrace furniture (solid-free, drive-through): benches under the north
    // rim looking back at the bridge and the city, lamps at the arc ends,
    // planters flanking the entry.
    const seatProp = (url: string, px: number, pz: number, yaw: number, h: number): void => {
      const node = ctx.cache.instance(url);
      node.scale.setScalar(h / Math.max(ctx.cache.bounds(url).size.y, 0.001));
      node.rotation.y = yaw;
      node.position.set(px, ctx.terrain.heightAt(px, pz), pz);
      node.updateMatrixWorld(true);
      objects.push(node);
    };
    for (const deg of [-46, 0, 46]) {
      const a = (deg * Math.PI) / 180;
      const px = ox + (R - 2.4) * Math.sin(a);
      const pz = oz - (R - 2.4) * Math.cos(a);
      seatProp(modelUrl("props", "kk-bench"), px, pz, -a + Math.PI, 0.85);
    }
    for (const s of [-1, 1] as const) {
      const aEnd = (s * ARC) / 2;
      seatProp(
        modelUrl("props", "kk-lamp-old-double"),
        ox + (R - 1.2) * Math.sin(aEnd),
        oz - (R - 1.2) * Math.cos(aEnd),
        -aEnd,
        4.2,
      );
      const aIn = (s * 155 * Math.PI) / 180;
      seatProp(
        modelUrl("props", "planter"),
        ox + (R - 0.5) * Math.sin(aIn),
        oz - (R - 0.5) * Math.cos(aIn),
        0,
        0.8,
      );
    }

    // Wind-bent kit trees scatter the flanks around the terrace (never the
    // south entry corridor); the ones past the border wall are backdrop.
    for (let i = 0; i < 12; i++) {
      const a = ((-148 + i * 27) * Math.PI) / 180;
      if (Math.abs(a) > (148 * Math.PI) / 180) continue;
      const r = R + 7 + jit(i, 1) * 14;
      const px = ox + r * Math.sin(a) + (jit(i, 2) - 0.5) * 5;
      const pz = Math.max(oz - r * Math.cos(a) + (jit(i, 3) - 0.5) * 5, -WORLD_HALF_Z - 16);
      if (ctx.terrain.heightAt(px, pz) < 3) continue; // stay off the waterline
      const treeName = PARK_TREES[i % PARK_TREES.length];
      if (!treeName) continue;
      const url = modelUrl("props", treeName);
      seatProp(url, px, pz, jit(i, 4) * Math.PI * 2, 3.8 + jit(i, 5) * 1.7);
      solids.push({
        minX: px - 0.55,
        maxX: px + 0.55,
        minZ: pz - 0.55,
        maxZ: pz + 0.55,
        noBody: true,
      });
    }
  }

  return { objects, solids, decks, openWaterCells };
}
