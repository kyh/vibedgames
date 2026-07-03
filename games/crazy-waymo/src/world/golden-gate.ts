import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { BRIDGE_PILLAR_WIDE, modelUrl, ROAD_BRIDGE } from "../assets/manifest";
import { GRID_X, GRID_Z, WORLD_HALF_Z, WORLD_W } from "../shared/constants";
import type { CityPlan } from "./grid";
import type { Solid, SurfaceDeck } from "./city";
import type { Terrain } from "./terrain";

// The DRIVABLE Golden Gate: a ramp climbs from the northernmost Presidio road
// onto an international-orange deck that runs out over the strait to a railed
// vista turnaround. Surface overrides (SurfaceDeck) carry the car; the visual
// bridge (towers, catenary cables, kit deck boards) is built to match exactly.

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

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
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
    for (let gz = 0; gz < GRID_Z; gz++) {
      if (ctx.plan.cells[gx]?.[gz] !== "road") continue;
      if (!anchor || gz < anchor.gz) anchor = { gx, gz };
      break; // first road in this column is the northernmost
    }
  }
  if (!anchor) return { objects, solids, decks, openWaterCells };

  const ax = ctx.worldX(anchor.gx);
  const shoreZ = ctx.worldZ(anchor.gz);
  const shoreH = ctx.terrain.heightAt(ax, shoreZ) + 0.04;
  const endZ = -WORLD_HALF_Z + 3.5; // vista pad stops just inside the border wall
  // Fit the ramp to the water span actually available; cap the climb at ~20°.
  const span = shoreZ - endZ;
  const rampLen = THREE.MathUtils.clamp(span * 0.6, 10, RAMP_LEN);
  const deckY = Math.min(DECK_Y, shoreH + rampLen * 0.36);
  const rampTopZ = shoreZ - rampLen; // north = -Z
  const half = DECK_W / 2;

  // --- Drivable surface ---
  // Two-stage ramp (steep, then a gentle crown) so cresting onto the deck at
  // speed pops a small hop instead of launching you into the end barrier.
  const kneeZ = shoreZ - rampLen * 0.68;
  const kneeY = shoreH + (deckY - shoreH) * 0.8;
  decks.push({ minX: ax - half, maxX: ax + half, minZ: kneeZ, maxZ: shoreZ, y: kneeY, y2: shoreH });
  decks.push({ minX: ax - half, maxX: ax + half, minZ: rampTopZ, maxZ: kneeZ, y: deckY, y2: kneeY });
  // Deck out to the vista pad.
  decks.push({ minX: ax - half, maxX: ax + half, minZ: endZ, maxZ: rampTopZ, y: deckY });

  // --- Rails + end barrier (full height; you do not fall off the Golden Gate) ---
  const railMinZ = endZ;
  const railMaxZ = shoreZ - 1;
  solids.push({ minX: ax - half - RAIL_T, maxX: ax - half, minZ: railMinZ, maxZ: railMaxZ });
  solids.push({ minX: ax + half, maxX: ax + half + RAIL_T, minZ: railMinZ, maxZ: railMaxZ });
  solids.push({ minX: ax - half - RAIL_T, maxX: ax + half + RAIL_T, minZ: endZ - 1.2, maxZ: endZ });

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
  for (let z = rampTopZ; z > -WORLD_HALF_Z - segLen; z -= segLen) {
    const seg = ctx.cache.instance(deckUrl);
    seg.scale.set(boardScaleX, 1.6, boardScaleZ);
    seg.position.set(ax, deckY - 0.32, z - segLen / 2);
    seg.updateMatrixWorld(true);
    objects.push(seg);
  }

  // Side rails (visual, matches the solids).
  const railLen = railMaxZ - railMinZ;
  const railGeo = new THREE.BoxGeometry(RAIL_T, 1.1, railLen);
  for (const sx of [-(half + RAIL_T / 2), half + RAIL_T / 2]) {
    objects.push(mesh(railGeo, RAIL_ORANGE, ax + sx, deckY + 0.55, (railMinZ + railMaxZ) / 2));
  }
  objects.push(
    mesh(new THREE.BoxGeometry(DECK_W + RAIL_T * 2, 1.6, 1.2), RAIL_ORANGE, ax, deckY + 0.8, endZ - 0.6),
  );

  // Piers under the deck.
  const pillarUrl = modelUrl("roads", BRIDGE_PILLAR_WIDE);
  const pb = ctx.cache.bounds(pillarUrl);
  for (const pz of [rampTopZ - 6, -WORLD_HALF_Z + 10]) {
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
  const towerZ = -WORLD_HALF_Z + 14;
  const topY = deckY + TOWER_H;
  for (const sx of [-(half + 2.2), half + 2.2]) {
    objects.push(
      mesh(new THREE.BoxGeometry(2, TOWER_H + deckY + 2, 2), ORANGE, ax + sx, (topY + 1) / 2 - 1, towerZ),
    );
  }
  for (const by of [deckY + 8.5, deckY + 17, topY - 1.5]) {
    objects.push(
      mesh(new THREE.BoxGeometry(DECK_W + 6.4, 1.4, 1.4), ORANGE, ax, by, towerZ),
    );
  }

  // Main cables: catenary from the shore anchorage over the tower top, plus
  // suspenders down to the deck.
  for (const sx of [-(half + 2.2), half + 2.2]) {
    const pts = [
      new THREE.Vector3(ax + sx, shoreH + 1.5, shoreZ + 2),
      new THREE.Vector3(ax + sx, deckY + 5, (rampTopZ + towerZ) / 2),
      new THREE.Vector3(ax + sx, topY - 0.5, towerZ),
      new THREE.Vector3(ax + sx, topY - 6, -WORLD_HALF_Z - 8),
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
      objects.push(
        mesh(new THREE.BoxGeometry(0.14, h, 0.14), ORANGE, p.x, deckY + 1 + h / 2, p.z),
      );
    }
  }

  // Anchorage blocks flanking the ramp entry.
  for (const sx of [-(half + 1.6), half + 1.6]) {
    objects.push(
      mesh(new THREE.BoxGeometry(2.6, 3.2, 4.5), ORANGE, ax + sx, shoreH + 1.2, shoreZ - 3),
    );
  }

  return { objects, solids, decks, openWaterCells };
}
