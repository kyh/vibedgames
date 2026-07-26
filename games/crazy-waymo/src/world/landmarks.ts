import * as THREE from "three";

import { type Beacon, registerBeacons } from "../fx/beacon-lights";
import type { ModelCache } from "../assets/loader";
import { BUILDINGS_SUBURBAN, modelUrl } from "../assets/manifest";
import {
  GRID_X,
  GRID_Z,
  ROAD_TILE,
  WORLD_H,
  WORLD_HALF_X,
  WORLD_HALF_Z,
  WORLD_W,
} from "../shared/constants";
import { Rng } from "../shared/rng";
import type { Solid } from "./city";
import type { CityPlan } from "./grid";
import { arc, box, cyl, dome, MAT, mesh, packLandmark, strut } from "./landmark-geo";
import type { RoadNetwork } from "./network";
import type { Terrain } from "./terrain";

// Iconic SF landmarks at traced (u,v) positions (from the sf-trace research).
//
// SCALE. One world unit ≈ 4.45 m (the map spans SF's real 14.1 km east-west),
// so the big monuments are authored at true size: Salesforce Tower's 326 m is
// 73u, the Bay Bridge's western crossing is ~600u of deck. The SMALL ones are
// deliberately oversized ~1.6× (Coit Tower's 64 m reads as 26u) — at true
// scale a 40 m building is a third of a city block and reads as scenery
// rather than a landmark from a car at 30 u/s. Each builder says which it is.
//
// Monuments authored in world units use `scale: 1`; the older set was drawn
// against `KIT_SCALE` and keeps it.
const KIT_SCALE = ROAD_TILE / 8;

// --- Build context -------------------------------------------------------

export type LandmarkCtx = {
  readonly terrain: Terrain;
  readonly cache: ModelCache;
  readonly network: RoadNetwork | null;
  readonly rng: Rng;
  /** Resolved world position of the monument's origin (x, z). */
  readonly origin: readonly [number, number];
  /**
   * Terrain height under a landmark-LOCAL point, expressed in local units
   * relative to the monument's own origin (accounts for the placement
   * rotation and scale). Terrain-following parts — parapets on a summit,
   * ruins on a bluff — seat through this so they never float downhill.
   */
  readonly groundAt: (lx: number, lz: number) => number;
  /**
   * True when a landmark-local point sits within `margin` of street asphalt.
   * Set dressing that would land in the roadway is dropped instead of
   * fighting the drape.
   */
  readonly onAsphalt: (lx: number, lz: number, margin: number) => boolean;
  /**
   * A landmark-LOCAL point in world space, placement rotation, scale and seat
   * height applied. Geometry never needs this — it is authored in local space
   * and the group carries the transform — but anything a monument publishes to
   * a world-space registry does (the night beacons in fx/beacon-lights.ts).
   */
  readonly worldPoint: (lx: number, ly: number, lz: number) => readonly [number, number, number];
};

/**
 * Lowest terrain under a landmark-local rect, clamped at 0 (its own origin).
 * A monument seats on the height at its CENTRE, so on any slope its downhill
 * corner shows daylight underneath — every ground-seated builder sinks a
 * footing to this depth instead.
 */
function lowestUnder(ctx: LandmarkCtx, halfX: number, halfZ: number, x = 0, z = 0): number {
  let lo = 0;
  for (const dx of [-halfX, 0, halfX]) {
    for (const dz of [-halfZ, 0, halfZ]) lo = Math.min(lo, ctx.groundAt(x + dx, z + dz));
  }
  return lo;
}

/** Where a monument's origin sits vertically. */
type Seat = "ground" | "sea";

type LandmarkDef = {
  readonly build: (ctx: LandmarkCtx) => THREE.Group;
  readonly seat: Seat;
  readonly scale: number;
};

// --- The historic set (authored against KIT_SCALE) -----------------------

// Transamerica Pyramid — slender white 4-sided pyramid with shoulder wings.
function pyramid(): THREE.Group {
  const g = new THREE.Group();
  const H = 36; // real 260 m at world scale
  const cone = mesh(new THREE.ConeGeometry(4.4, H, 4), MAT.white, 0, H / 2, 0);
  cone.rotation.y = Math.PI / 4;
  g.add(cone);
  g.add(box(1.4, 14, 3, MAT.white, -3.2, 7, 0));
  g.add(box(1.4, 14, 3, MAT.white, 3.2, 7, 0));
  g.add(cyl(0.18, 0.18, 7, 8, MAT.white, 0, H + 3, 0));
  return g;
}

// Salesforce Tower — the tallest, a tapered octagonal glass shaft. H matches
// the real 326 m at world scale (45 × KIT_SCALE ≈ 73u) — the old 60 (97u)
// washed into the fog as a featureless beam.
function salesforce(): THREE.Group {
  const g = new THREE.Group();
  const H = 45;
  g.add(cyl(2.3, 4.2, H, 10, MAT.towerGlass, 0, H / 2, 0));
  g.add(cyl(0.1, 1.6, 5, 10, MAT.towerGlass, 0, H + 2, 0));
  return g;
}

// Coit Tower — fluted white column on the Telegraph Hill summit (its (u,v)
// IS the hill's, so it crowns the crest). Deliberately ~1.8× real height:
// a true-scale 64 m column disappears behind North Beach's rooftops.
function coitTower(): THREE.Group {
  const g = new THREE.Group();
  const H = 16;
  g.add(cyl(3.4, 3.7, 1.3, 16, MAT.cream, 0, 0.5, 0)); // plinth: no floating on the crest
  g.add(cyl(2.1, 2.4, H, 16, MAT.white, 0, H / 2, 0));
  // Flutes: the shallow vertical reeding that makes the shaft read as a
  // COLUMN rather than a white pipe at distance.
  arc(16, 2.22, 0, 360, (x, z) => {
    g.add(cyl(0.2, 0.24, H - 1.4, 5, MAT.white, x, (H - 1.4) / 2, z));
  });
  g.add(cyl(2.5, 2.2, 2.6, 16, MAT.white, 0, H + 1, 0));
  // Observation arches under the crown.
  arc(8, 2.3, 0, 360, (x, z, yaw) => {
    g.add(box(1.1, 1.7, 0.5, MAT.slate, x, H + 1.1, z, yaw));
  });
  g.add(cyl(1.4, 2.2, 2, 16, MAT.white, 0, H + 3, 0));
  return g;
}

// Ferry Building — the long arcade and its clock tower, authored in world
// units at MEASURED size. The marine extract puts the tower at 16.2u (72 m,
// against the real 74.7 m); the old KIT_SCALE version topped out at 42u/188 m,
// two and a half times over, which made the waterfront's calmest landmark the
// tallest thing on it. The arcade block is the real 201 m × 34 m footprint.
const FERRY_LEN = 45.2; // 201 m of arcade, long axis local +X
const FERRY_DEPTH = 7.6; // 34 m
const FERRY_EAVES = 4.2; // ~19 m to the cornice
const FERRY_TOWER = 16.2; // measured tower top
function ferryBuilding(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const W = FERRY_LEN;
  const D = FERRY_DEPTH;
  const H = FERRY_EAVES;
  // It stands ON the shore edge, so the seaward half is over falling ground —
  // the plinth reaches the lowest point it covers or the block shows daylight.
  const foot = lowestUnder(ctx, W / 2, D / 2);
  g.add(box(W + 1.4, 0.8 - foot, D + 1.4, MAT.rock, 0, (0.8 + foot) / 2 - 0.4, 0));
  g.add(box(W, H, D, MAT.cream, 0, H / 2, 0));
  g.add(box(W + 0.8, 0.6, D + 0.8, MAT.cream, 0, H + 0.3, 0)); // cornice
  g.add(box(W - 1.2, 0.5, D - 1.2, MAT.slate, 0, H + 0.8, 0)); // roof
  // The arcade: a run of tall arched openings on both long faces. It is the
  // only thing that stops a 45u block reading as a shipping container.
  const bays = 22;
  for (let i = 0; i < bays; i++) {
    const bx = -W / 2 + (W * (i + 0.5)) / bays;
    for (const sz of [-D / 2, D / 2]) {
      g.add(box(1.1, 2.6, 0.35, MAT.slate, bx, 1.6, sz));
    }
  }
  // Tower: shaft, colonnaded clock stage, pyramidal cap.
  const shaft = FERRY_TOWER - 3.8;
  g.add(box(D, shaft, D, MAT.cream, 0, shaft / 2, 0));
  g.add(box(D + 0.7, 2.2, D + 0.7, MAT.cream, 0, shaft + 1.1, 0)); // clock stage
  for (const [cx, cz] of [
    [0, (D + 0.7) / 2],
    [0, -(D + 0.7) / 2],
    [(D + 0.7) / 2, 0],
    [-(D + 0.7) / 2, 0],
  ] as const) {
    g.add(box(cz === 0 ? 0.3 : 2.0, 2.0, cz === 0 ? 2.0 : 0.3, MAT.steel, cx, shaft + 1.1, cz));
  }
  g.add(mesh(new THREE.ConeGeometry(D * 0.72, 1.6, 4), MAT.slate, 0, shaft + 3.0, 0));
  return g;
}

// Sutro Tower — the three-pronged antenna visible from all of SF; the map's
// central orientation weenie on the saddle between Twin Peaks and Mt Sutro.
function sutroTower(): THREE.Group {
  const g = new THREE.Group();
  const H = 26; // legs
  const lean = 0.1;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const bx = Math.cos(a) * 3.4;
    const bz = Math.sin(a) * 3.4;
    const leg = cyl(0.32, 0.5, H, 6, MAT.orange, bx, H / 2, bz);
    leg.rotation.z = Math.cos(a) * lean;
    leg.rotation.x = -Math.sin(a) * lean;
    g.add(leg);
    // Antenna prongs rise from the waist, white above.
    g.add(cyl(0.16, 0.22, 14, 6, MAT.white, Math.cos(a) * 2.2, H + 6.5, Math.sin(a) * 2.2));
  }
  // Waist platforms.
  g.add(cyl(2.9, 2.9, 0.7, 8, MAT.orange, 0, H * 0.62, 0));
  g.add(cyl(2.4, 2.4, 0.7, 8, MAT.orange, 0, H, 0));
  // Crossbar joining the prong tips.
  g.add(cyl(0.14, 0.14, 5.4, 6, MAT.white, 0, H + 13, 0));
  return g;
}

// Chinatown Dragon Gate — pillars + tiered pagoda roofs over the road.
function dragonGate(): THREE.Group {
  const g = new THREE.Group();
  for (const sx of [-4.6, 4.6]) {
    g.add(cyl(0.55, 0.65, 5.6, 10, MAT.gateRed, sx, 2.8, 0));
  }
  // Main span roof (three stacked tiers, green tile).
  g.add(box(11.4, 0.5, 2.2, MAT.gateRed, 0, 5.8, 0));
  g.add(box(10, 0.9, 2.8, MAT.gateGreen, 0, 6.5, 0));
  g.add(box(6.5, 0.8, 2.4, MAT.gateGreen, 0, 7.6, 0));
  g.add(box(3.2, 0.9, 2.0, MAT.gateGreen, 0, 8.6, 0));
  g.add(mesh(new THREE.SphereGeometry(0.5, 8, 6), MAT.gateRed, 0, 9.4, 0));
  return g;
}

function paintedLadies(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const colors = [0xf6c8d4, 0x9ec6e0, 0xf2e0a0, 0xb8dcc0, 0xe8b48a, 0xd8c0e0];
  for (let i = 0; i < 6; i++) {
    const url = modelUrl("buildings", BUILDINGS_SUBURBAN[i % BUILDINGS_SUBURBAN.length] ?? "");
    const bounds = ctx.cache.bounds(url);
    const scale = 5.5 / Math.max(bounds.size.x, bounds.size.z, 0.001);
    const node = ctx.cache.instance(url);
    node.scale.set(scale, scale * (1.3 + ctx.rng.range(0, 0.25)), scale);
    node.position.set((i - 2.5) * 6.4, 0, 0);
    const tint = colors[i] ?? 0xffffff;
    node.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
        const m = c.material.clone();
        m.color.lerp(new THREE.Color(tint), 0.7);
        c.material = m;
      }
    });
    g.add(node);
  }
  return g;
}

// --- The Bay Bridge ------------------------------------------------------

// Alignment MEASURED off the licensed downtown model (the marine extract in
// tools/sf-data): the western crossing bears 40.5° from north, not the 84°
// this was first authored at — a 43.5° error that aimed it out to sea parallel
// to the shore. It runs 675u from the Rincon Hill anchorage on the Embarcadero
// seawall to Yerba Buena, with FOUR towers (two suspension bridges end to end,
// hinged on a centre anchorage) at the measured 160/175/160u spacing.
//
// On the map budget: the crossing is NOT compressed. The old note that "only
// ~650u of bay fit" was an artefact of the wrong bearing — due east the map
// edge is 649u away, but on the true north-east heading the full 675u lands
// Yerba Buena at u 0.934 / v 0.015, inside the map's north-east corner. What
// does NOT fit is the eastern self-anchored span: its tower would stand ~50u
// off the north edge, so east of the island only a deck stub runs into the
// fog. Better an honest true-scale west crossing than a shrunken whole bridge.
//
// Local +X runs along the crossing from the shore anchorage; every chainage
// below is the model's own station minus 305 (the anchorage's station).
const BAY_DECK_Y = 13; // ~58 m of shipping clearance
// The model authors its towers at 132 m over a 47 m deck; the real pair is
// 160 m over ~67 m. Keep the true-scale deck we already had and take the
// model's PROPORTION instead of its absolute — 93 m of tower above the road.
// The old 36u tower put the tops at 218 m.
const BAY_TOWER_H = 21;
const BAY_HALF_W = 3; // measured roadway 4.7u, plus truss and walkways
const BAY_CABLE_Z = 4.2; // cable planes = tower leg centres (base ≈ measured 12.9u)
const BAY_APPROACH = -62; // west end of the descending city approach
const BAY_RAMP_TOP = -14; // where the approach reaches deck height
const BAY_ANCHOR_W = 8;
const BAY_TOWER_1 = 65;
const BAY_TOWER_2 = 225;
const BAY_ANCHOR_MID = 312;
const BAY_TOWER_3 = 400;
const BAY_TOWER_4 = 560;
const BAY_YERBA = 675;
const BAY_EAST_END = 760; // off the map's north-east corner, into the fog
const BAY_ANCHOR_TOP = BAY_DECK_Y + 11;

/**
 * Main-cable saddles: `[chainage, height, sag to the NEXT saddle]`. Sag is
 * measured at 18u below the tower tops on a 19.2u tower, so it scales with
 * BAY_TOWER_H and leaves the cable just clear of the deck at midspan.
 */
const BAY_CABLE_SADDLES: readonly (readonly [number, number, number])[] = [
  [BAY_ANCHOR_W + 4, BAY_ANCHOR_TOP - 1, 1.5],
  [BAY_TOWER_1, BAY_DECK_Y + BAY_TOWER_H, BAY_TOWER_H - 1.6],
  [BAY_TOWER_2, BAY_DECK_Y + BAY_TOWER_H, 2.5],
  [BAY_ANCHOR_MID, BAY_DECK_Y + 13, 2.5],
  [BAY_TOWER_3, BAY_DECK_Y + BAY_TOWER_H, BAY_TOWER_H - 1.6],
  [BAY_TOWER_4, BAY_DECK_Y + BAY_TOWER_H, 2],
  [BAY_YERBA - 10, BAY_ANCHOR_TOP - 1, 0],
];

/** Deck slab + parapets + the light string, from x0 to x1 at height y. */
function bayDeck(g: THREE.Group, x0: number, x1: number, y: number, lamps: THREE.Vector3[]): void {
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  g.add(box(len, 1.1, BAY_HALF_W * 2, MAT.steel, cx, y - 0.55, 0)); // upper deck
  g.add(box(len, 1.0, BAY_HALF_W * 2 - 0.6, MAT.steel, cx, y - 4.2, 0)); // lower deck
  for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
    g.add(box(len, 3.4, 0.5, MAT.steel, cx, y - 2.4, sz)); // side truss
    g.add(box(len, 0.9, 0.35, MAT.steel, cx, y + 0.45, sz)); // parapet
  }
  // Deck lighting: warm boxes on the parapet, one every ~15u. They are the
  // only thing that keeps the crossing legible after dark; each also publishes
  // a beacon so the string carries a halo and a pool on the roadway.
  const step = 15;
  const n = Math.max(1, Math.round(len / step));
  for (let i = 0; i < n; i++) {
    const x = x0 + (len * (i + 0.5)) / n;
    for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
      g.add(box(0.55, 0.55, 0.55, MAT.lamp, x, y + 1.5, sz));
      g.add(box(0.16, 1.4, 0.16, MAT.steel, x, y + 0.9, sz));
      lamps.push(new THREE.Vector3(x, y + 1.5, sz));
    }
  }
}

/** One western-span tower: two shafts either side of the roadway, braced. */
function bayTower(g: THREE.Group, x: number): void {
  const top = BAY_DECK_Y + BAY_TOWER_H;
  for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
    g.add(box(2.6, top + 8, 2.6, MAT.steel, x, (top - 8) / 2, sz));
  }
  for (const by of [BAY_DECK_Y - 6, BAY_DECK_Y + 6, BAY_DECK_Y + 14, top - 1.5]) {
    g.add(box(2.0, 1.4, BAY_CABLE_Z * 2 + 2.6, MAT.steel, x, by, 0));
  }
}

/** One main cable, sampled parabolically between the measured saddles. */
function bayCablePoints(z: number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < BAY_CABLE_SADDLES.length - 1; i++) {
    const a = BAY_CABLE_SADDLES[i];
    const b = BAY_CABLE_SADDLES[i + 1];
    if (!a || !b) continue;
    const [ax, ay, sag] = a;
    const [bx, by] = b;
    const steps = Math.max(2, Math.round((bx - ax) / 8));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      pts.push(
        new THREE.Vector3(ax + (bx - ax) * t, ay + (by - ay) * t - 4 * sag * t * (1 - t), z),
      );
    }
  }
  const last = BAY_CABLE_SADDLES[BAY_CABLE_SADDLES.length - 1];
  if (last) pts.push(new THREE.Vector3(last[0], last[1], z));
  return pts;
}

/**
 * The western approach: a pitched viaduct dropping off the anchorage deck to
 * the measured 2.4u touchdown on the city grid, instead of the old flat run
 * that ended 13u up in mid-air. Piers hunt sideways for ground clear of the
 * roadway before giving up — the real viaduct straddles the streets it
 * crosses, it does not stand in them.
 */
function bayApproach(g: THREE.Group, ctx: LandmarkCtx): void {
  const D = BAY_DECK_Y;
  const x0 = BAY_APPROACH;
  const x1 = BAY_RAMP_TOP;
  // Clamped at the deck: Rincon Hill already stands ~12u here, so on this
  // terrain the "ramp" is mostly a short touchdown, never an uphill run.
  const y0 = THREE.MathUtils.clamp(ctx.groundAt(x0, 0) + 1.4, 2.4, D);
  const segs = 7;
  for (let i = 0; i < segs; i++) {
    const sx0 = x0 + ((x1 - x0) * i) / segs;
    const sx1 = x0 + ((x1 - x0) * (i + 1)) / segs;
    const sy0 = y0 + ((D - y0) * i) / segs;
    const sy1 = y0 + ((D - y0) * (i + 1)) / segs;
    const len = Math.hypot(sx1 - sx0, sy1 - sy0);
    const pitch = Math.atan2(sy1 - sy0, sx1 - sx0);
    const mx = (sx0 + sx1) / 2;
    const my = (sy0 + sy1) / 2;
    const slab = box(len, 1.1, BAY_HALF_W * 2, MAT.steel, mx, my - 0.55, 0);
    slab.rotation.z = pitch;
    g.add(slab);
    for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
      const rail = box(len, 0.9, 0.35, MAT.steel, mx, my + 0.45, sz);
      rail.rotation.z = pitch;
      g.add(rail);
    }
  }
  for (let px = x0 + 8; px < BAY_ANCHOR_W - 12; px += 9) {
    const pz = [0, -8, 8].find((z) => !ctx.onAsphalt(px, z, 1.6));
    if (pz === undefined) continue;
    const deckY = px < x1 ? y0 + ((D - y0) * (px - x0)) / (x1 - x0) : D;
    const gy = ctx.groundAt(px, pz);
    const h = deckY - 1.1 - gy;
    if (h < 2) continue;
    g.add(box(5, h, 5, MAT.concrete, px, gy + h / 2, pz));
    g.add(box(7, 1.6, BAY_HALF_W * 2 + 2, MAT.concrete, px, deckY - 1.5, pz * 0.35));
  }
}

// The Bay Bridge: the west double suspension (shore anchorage → two towers →
// centre anchorage → two towers → Yerba Buena), its descending city approach,
// and a deck stub running east off the map corner. Authored in world units
// along +X from the SF landfall, which is the point the (u,v) in the table
// names.
function bayBridge(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const D = BAY_DECK_Y;
  const lamps: THREE.Vector3[] = [];

  // --- SF landfall: the anchorage block on the seawall, plus the approach
  // viaduct running back west over the Embarcadero, so the crossing reads as
  // arriving FROM the city instead of starting in mid-air. ---
  const anchH = BAY_ANCHOR_TOP + 10;
  g.add(box(26, anchH, 26, MAT.concrete, BAY_ANCHOR_W, BAY_ANCHOR_TOP - anchH / 2, 0));
  g.add(box(20, 4, 20, MAT.concrete, BAY_ANCHOR_W, BAY_ANCHOR_TOP + 1, 0)); // stepped crown
  for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
    g.add(box(7, 4, 4, MAT.steel, BAY_ANCHOR_W + 11, BAY_ANCHOR_TOP + 1, sz)); // cable saddle
  }
  bayApproach(g, ctx);
  bayDeck(g, BAY_RAMP_TOP, BAY_ANCHOR_W, D, lamps);

  // --- Western crossing: four towers, hinged on the centre anchorage ---
  bayDeck(g, BAY_ANCHOR_W, BAY_YERBA, D, lamps);
  for (const tx of [BAY_TOWER_1, BAY_TOWER_2, BAY_TOWER_3, BAY_TOWER_4]) bayTower(g, tx);
  // Centre anchorage: the block the four main cables actually pull against.
  g.add(box(18, D + 27, 22, MAT.concrete, BAY_ANCHOR_MID, D + 15 - (D + 27) / 2, 0));

  for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
    const curve = new THREE.CatmullRomCurve3(bayCablePoints(sz));
    g.add(mesh(new THREE.TubeGeometry(curve, 96, 0.5, 4), MAT.steel));
    for (let i = 1; i < 56; i++) {
      const p = curve.getPoint(i / 56);
      const h = p.y - (D + 1);
      if (h < 1.5) continue;
      g.add(box(0.22, h, 0.22, MAT.steel, p.x, D + 1 + h / 2, p.z));
    }
  }

  // --- Yerba Buena: the island the crossing hands off across, right in the
  // map's north-east corner. The eastern span leaves as a deck stub. ---
  const rock = cyl(16, 26, 22, 12, MAT.rock, BAY_YERBA, 1, 0);
  rock.scale.set(1.5, 1, 1);
  g.add(rock);
  g.add(box(20, 12, 16, MAT.rock, BAY_YERBA, 12, 0)); // tunnel headland
  g.add(box(6, 9, BAY_HALF_W * 2 + 2, MAT.concrete, BAY_YERBA, D + 1.5, 0)); // tunnel portal
  bayDeck(g, BAY_YERBA, BAY_EAST_END, D, lamps);

  // --- Night lights: the deck string plus a red aviation beacon on each
  // tower top (fx/beacon-lights.ts; runtime registry, no bake). ---
  const beacons: Beacon[] = [];
  for (const p of lamps) {
    const [wx, wy, wz] = ctx.worldPoint(p.x, p.y, p.z);
    beacons.push({ x: wx, y: wy, z: wz, color: 0xffd9a0, size: 2.2, groundY: wy - 1.5 });
  }
  for (const tx of [BAY_TOWER_1, BAY_TOWER_2, BAY_TOWER_3, BAY_TOWER_4]) {
    for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
      const [wx, wy, wz] = ctx.worldPoint(tx, D + BAY_TOWER_H + 5.5, sz);
      beacons.push({ x: wx, y: wy, z: wz, color: 0xff4436, size: 3.4, blinkS: 2.6 });
    }
  }
  registerBeacons("baybridge", beacons);
  return g;
}

// --- Alcatraz ------------------------------------------------------------

// Alcatraz: the rock (cliff skirt + plateau), the cellhouse block, the water
// tower, and the lighthouse with a beacon that burns after dark. True scale —
// the real island is ~500 m long, which is 110u here.
function alcatraz(): THREE.Group {
  const g = new THREE.Group();
  // Cliff skirt: a squat cone stretched east-west, so the island has real
  // faces instead of the old floating pancake.
  const cliff = cyl(17, 25, 17, 14, MAT.rock, 0, 1.5, 0);
  cliff.scale.set(2.2, 1, 1);
  g.add(cliff);
  const plateau = cyl(15, 18, 4, 14, MAT.rock, -2, 11, 0);
  plateau.scale.set(2.1, 1, 1);
  g.add(plateau);
  // Broken outcrops at the ends (the island is not a wedding cake).
  for (const [ox, oz, s] of [
    [-44, 3, 8],
    [42, -4, 7],
    [16, 9, 5],
  ] as const) {
    const r = mesh(new THREE.IcosahedronGeometry(s, 0), MAT.rock, ox, 6, oz);
    r.scale.set(1.4, 0.7, 1);
    r.rotation.y = ox;
    g.add(r);
  }

  // Cellhouse: the long block that IS the island's silhouette.
  g.add(box(46, 11, 15, MAT.cream, -3, 18.5, 0));
  g.add(box(48, 1.4, 17, MAT.slate, -3, 24.7, 0));
  g.add(box(9, 7, 9, MAT.cream, -3, 27, 0)); // roof lantern / guard post
  g.add(box(9, 1.2, 10, MAT.slate, -3, 30.8, 0));
  // Recessed window bays along the south face.
  for (let i = 0; i < 11; i++) {
    g.add(box(2.2, 5, 0.5, MAT.slate, -22 + i * 3.9, 18.5, 7.6));
  }

  // Water tower: legs, tank, conical cap — the west-end silhouette.
  const tankY = 26;
  for (const sx of [-3, 3]) {
    for (const sz of [-3, 3]) {
      g.add(
        strut(
          new THREE.Vector3(-36 + sx * 1.6, 13, sz * 1.6),
          new THREE.Vector3(-36 + sx, tankY, sz),
          0.32,
          MAT.steel,
          5,
        ),
      );
    }
  }
  g.add(cyl(4, 4, 7, 10, MAT.steel, -36, tankY + 3.5, 0));
  g.add(mesh(new THREE.ConeGeometry(4.3, 2.6, 10), MAT.steel, -36, tankY + 8.3, 0));

  // Lighthouse + beacon.
  g.add(cyl(1.5, 2.1, 17, 10, MAT.white, 26, 21.5, 2));
  g.add(cyl(2.6, 2.6, 0.6, 10, MAT.white, 26, 30.3, 2));
  g.add(cyl(2, 2, 3.2, 8, MAT.lamp, 26, 32.2, 2)); // the beacon: lit after dark
  g.add(mesh(new THREE.ConeGeometry(2.3, 1.8, 8), MAT.slate, 26, 34.7, 2));

  // Dock sheds on the east landing.
  g.add(box(11, 6, 8, MAT.cream, 30, 14, -8));
  g.add(box(12, 1, 9, MAT.slate, 30, 17.3, -8));
  for (const lz of [-13, -3]) {
    g.add(cyl(0.2, 0.26, 5, 6, MAT.steel, 36, 13.5, lz));
    g.add(box(0.7, 0.7, 0.7, MAT.lamp, 36, 16.3, lz));
  }
  return g;
}

// --- Civic Center --------------------------------------------------------

// City Hall — the beaux-arts block and the gold-ribbed dome (the tallest in
// the US, 91 m, true scale). Granite body, oxidised copper shell, gilded
// ribs, ring and lantern.
function cityHall(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 19, 13);
  g.add(box(40, 1.4 - foot, 26, MAT.rock, 0, (0.6 + foot) / 2, 0)); // footing
  g.add(box(34, 12, 20, MAT.cream, 0, 6, 0));
  g.add(box(9, 15, 22, MAT.cream, -14, 7.5, 0)); // end pavilions
  g.add(box(9, 15, 22, MAT.cream, 14, 7.5, 0));
  g.add(box(36, 1.3, 22, MAT.slate, 0, 15.2, 0)); // cornice

  // South portico: it must PROJECT past the block face (z 10) or the columns
  // read as pilasters scratched into a plain wall.
  g.add(box(21, 1.6, 5, MAT.rock, 0, 0.8, 12.4)); // steps
  for (let i = 0; i < 8; i++) {
    g.add(cyl(0.75, 0.85, 9.4, 8, MAT.cream, -7.7 + i * 2.2, 6.3, 12.6));
  }
  g.add(box(19, 1.8, 3.4, MAT.cream, 0, 11.9, 12.6));
  g.add(box(16, 1.6, 3, MAT.cream, 0, 13.5, 12.6));
  g.add(box(8, 1.2, 2.6, MAT.cream, 0, 14.8, 12.6));

  // Drum: a ring of columns under the dome.
  g.add(cyl(6, 6.4, 7, 20, MAT.cream, 0, 19, 0));
  arc(20, 6.6, 0, 360, (x, z) => {
    g.add(cyl(0.36, 0.4, 6, 5, MAT.cream, x, 19, z));
  });
  g.add(cyl(7, 7, 1.2, 20, MAT.cream, 0, 23, 0));

  // Dome: patina shell, gilded base ring, gilded ribs, gilded lantern.
  g.add(dome(6.6, 9, MAT.patina, 0, 23.6, 0, 20));
  g.add(mesh(new THREE.TorusGeometry(6.8, 0.3, 4, 22), MAT.gold, 0, 23.8, 0).rotateX(Math.PI / 2));
  for (let i = 0; i < 6; i++) {
    // Ribs ride PROUD of the shell — flush with it they would be swallowed.
    const rib = mesh(new THREE.TorusGeometry(6.95, 0.26, 4, 14, Math.PI), MAT.gold, 0, 23.6, 0);
    rib.scale.set(1, 9 / 6.6, 1);
    rib.rotation.y = (i * Math.PI) / 6;
    g.add(rib);
  }
  g.add(cyl(1.7, 2, 3.6, 10, MAT.cream, 0, 34.4, 0));
  g.add(dome(1.8, 1.6, MAT.gold, 0, 36.2, 0, 10));
  g.add(cyl(0.12, 0.12, 3, 6, MAT.gold, 0, 39, 0));
  return g;
}

// --- The Marina ----------------------------------------------------------

// Palace of Fine Arts — the open rotunda and its curved colonnade. Sized
// ~1.5× real so the rotunda still reads over the Marina's rooflines.
function palaceOfFineArts(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 26, 26);
  g.add(cyl(10, 10.6, 2.4 - foot, 16, MAT.rock, 0, (1.2 + foot) / 2, 0)); // stylobate
  arc(8, 7.4, 0, 360, (x, z) => {
    g.add(cyl(1, 1.15, 12, 8, MAT.cream, x, 7.4, z));
    g.add(box(2.4, 1, 2.4, MAT.cream, x, 13.6, z)); // capital blocks
  });
  // Ring beam left OPEN (a torus, not a drum) so the rotunda keeps the
  // see-through peristyle it is famous for.
  g.add(mesh(new THREE.TorusGeometry(7.6, 1.1, 4, 22), MAT.cream, 0, 14.6, 0).rotateX(Math.PI / 2));
  g.add(dome(7.4, 6.4, MAT.cream, 0, 15.2, 0, 18));
  g.add(cyl(1.1, 1.4, 2.4, 8, MAT.cream, 0, 22.6, 0));

  // The two colonnade arcs sweeping away from the rotunda, each capped by a
  // pergola beam running column to column.
  for (const deg0 of [46, 226]) {
    arc(9, 26, deg0, 88, (x, z, yaw) => {
      g.add(cyl(0.85, 1, 8.6, 8, MAT.cream, x, 4.3, z));
      g.add(box(2.6, 1.1, 2.6, MAT.cream, x, 9.2, z, yaw)); // capital
      g.add(box(5.4, 0.9, 1.4, MAT.cream, x, 10.1, z, yaw)); // pergola beam
    });
  }
  return g;
}

// --- Twin Peaks ----------------------------------------------------------

// Twin Peaks overlook — the parapet turnaround on the summit. THE vista of
// the map: a stone terrace cut into the crest, ringed by a wall that opens
// south for the approach, with viewing scopes on the north rim.
function twinPeaks(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const R = 13;
  // The terrace top rides just under the crest and its cylinder skirt sinks
  // into the hill uphill / shows a retaining face downhill.
  const top = ctx.groundAt(0, 0) + 0.5;
  g.add(cyl(R, R + 1.4, 12, 24, MAT.concrete, 0, top - 6, 0));
  g.add(cyl(R - 0.6, R - 0.6, 0.5, 24, MAT.rock, 0, top + 0.2, 0)); // paving

  // Parapet: 20 blocks around the rim, a 70° gap facing south for the entry.
  arc(20, R - 0.5, 215, 290, (x, z, yaw) => {
    g.add(box(4.4, 1.1, 0.8, MAT.rock, x, top + 0.75, z, yaw));
  });
  // Coin-op scopes on the north rim, aimed at the city.
  for (const sx of [-4.5, 0, 4.5]) {
    g.add(cyl(0.22, 0.3, 1.5, 6, MAT.steel, sx, top + 0.75, -(R - 2.6)));
    g.add(box(0.5, 0.5, 1.1, MAT.steel, sx, top + 1.6, -(R - 2.6)));
  }
  // Lamps at the two parapet ends.
  for (const sx of [-1, 1] as const) {
    const a = THREE.MathUtils.degToRad(215 + (sx > 0 ? 290 : 0));
    const px = Math.sin(a) * (R - 1.6);
    const pz = -Math.cos(a) * (R - 1.6);
    g.add(cyl(0.16, 0.22, 5, 6, MAT.steel, px, top + 2.5, pz));
    g.add(box(0.6, 0.6, 0.6, MAT.lamp, px, top + 5.2, pz));
  }
  // Summit marker.
  g.add(box(2.6, 1.3, 0.7, MAT.rock, 0, top + 0.85, R - 3.4));
  return g;
}

// --- Golden Gate Park ----------------------------------------------------

// The de Young — the long copper-clad museum and its twisting observation
// tower. The twist is the whole point of the silhouette, so it is built as a
// stack of boxes each yawed a few degrees further than the last.
function deYoung(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  // The museum sits on the park's east slope: its terrace has to reach the
  // lowest ground it covers or the west end floats.
  const foot = lowestUnder(ctx, 20, 12);
  g.add(box(38, 1.2 - foot, 22, MAT.rock, 0, (0.4 + foot) / 2, 0));
  g.add(box(34, 8, 18, MAT.copper, 0, 4, 0));
  g.add(box(16, 6, 12, MAT.copper, -22, 3, 5));
  g.add(box(36, 0.7, 20, MAT.slate, 0, 8.3, 0));
  g.add(box(20, 4, 1, MAT.glass, 0, 4.6, 9.3)); // entrance glazing
  // The tower stands on its own footing at the museum's east end (a stack
  // starting at deck height would float off the block's corner).
  g.add(box(9.4, 8, 9.4, MAT.copper, 20, 4, -1));
  const floors = 8;
  for (let i = 0; i < floors; i++) {
    const t = i / (floors - 1);
    g.add(
      box(
        9.2 - t * 1.4,
        2.6,
        9.2 - t * 1.4,
        MAT.copper,
        20 + t * 1.4,
        9.3 + i * 2.5,
        -1 - t * 2,
        t * 0.5,
      ),
    );
  }
  g.add(box(9, 2.4, 9, MAT.glass, 21.4, 30.6, -3, 0.5)); // observation floor
  g.add(box(9.6, 0.7, 9.6, MAT.slate, 21.4, 32, -3, 0.5));
  return g;
}

// Conservatory of Flowers — the white glasshouse: a central dome flanked by
// two barrel-vaulted wings. ~1.6× real size.
function conservatory(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 16, 7);
  g.add(box(32, 1.2 - foot, 15, MAT.concrete, 0, (0.6 + foot) / 2, 0)); // podium
  // Wings: half-cylinders laid along X (rotate the axis onto X, the open half
  // then faces up).
  const VAULT_Y = 4; // the vaults spring from the top of the glazed wall
  for (const sx of [-10.5, 10.5]) {
    g.add(box(9.2, 2.8, 7, MAT.white, sx, 2.6, 0));
    const vault = mesh(
      new THREE.CylinderGeometry(3.5, 3.5, 9, 12, 1, false, 0, Math.PI),
      MAT.glass,
      sx,
      VAULT_Y,
      0,
    );
    vault.rotation.z = Math.PI / 2;
    g.add(vault);
    for (let i = 0; i < 4; i++) {
      const rib = mesh(
        new THREE.TorusGeometry(3.62, 0.14, 4, 10, Math.PI),
        MAT.white,
        sx - 3.6 + i * 2.4,
        VAULT_Y,
        0,
      );
      rib.rotation.y = Math.PI / 2;
      g.add(rib);
    }
  }
  // Central rotunda + dome + cupola.
  g.add(cyl(5, 5.4, 5, 14, MAT.white, 0, 3.7, 0));
  g.add(dome(5.2, 6.4, MAT.glass, 0, 6.2, 0, 16));
  for (let i = 0; i < 5; i++) {
    const rib = mesh(new THREE.TorusGeometry(5.32, 0.15, 4, 12, Math.PI), MAT.white, 0, 6.2, 0);
    rib.scale.set(1, 6.4 / 5.2, 1);
    rib.rotation.y = (i * Math.PI) / 5;
    g.add(rib);
  }
  g.add(cyl(1.2, 1.5, 2.6, 8, MAT.white, 0, 13.6, 0));
  g.add(mesh(new THREE.ConeGeometry(1.6, 2.2, 8), MAT.white, 0, 16, 0));
  // Entry portico.
  g.add(box(6, 4.4, 3, MAT.white, 0, 3.4, 7.4));
  return g;
}

// A Dutch windmill at the park's ocean end: shingled taper, cap, four sails.
// ~1.6× real (the towers are only 23 m).
function windmill(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const H = 14;
  const SAIL = 15; // blade length: a 30u sail span, the read from the highway
  const foot = lowestUnder(ctx, 6, 6);
  g.add(cyl(3.6, 5.8, H - foot, 14, MAT.rock, 0, (H + foot) / 2, 0));
  g.add(dome(4.2, 3.6, MAT.slate, 0, H, 0, 14));
  g.add(cyl(0.5, 0.5, 4.4, 8, MAT.slate, 0, H + 2.4, 2.6).rotateX(Math.PI / 2));
  // Sails: two crossed pairs on the hub, canted off the tower face. Each is a
  // dark spine with a pale canvas panel — a bare white slab washes out
  // against the Ocean Beach haze.
  const hubY = H + 2.4;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.35;
    const px = Math.sin(a) * (SAIL / 2);
    const py = hubY + Math.cos(a) * (SAIL / 2);
    const spine = box(0.6, SAIL, 0.6, MAT.slate, px, py, 4.6);
    spine.rotation.z = -a;
    g.add(spine);
    const canvas = box(2.4, SAIL - 1.6, 0.3, MAT.white, px, py, 4.9);
    canvas.rotation.z = -a;
    g.add(canvas);
    // Lattice bars across the canvas.
    for (const t of [-0.3, 0, 0.3]) {
      const bar = box(2.8, 0.4, 0.4, MAT.slate, 0, 0, 5.1);
      bar.position.x = Math.sin(a) * (SAIL / 2 + t * SAIL);
      bar.position.y = hubY + Math.cos(a) * (SAIL / 2 + t * SAIL);
      bar.rotation.z = -a;
      g.add(bar);
    }
  }
  g.add(cyl(1.1, 1.1, 1.6, 8, MAT.slate, 0, hubY, 4.6).rotateX(Math.PI / 2));
  return g;
}

// --- Lands End -----------------------------------------------------------

// Cliff House + Sutro Baths — the white cliff-edge restaurant on a rock
// bluff, with the concrete basins of the ruined baths stepping down the
// shelf to the north. The bluff is BUILT (the height field is flat here);
// without it the pair sits on a beach instead of a headland.
function cliffHouse(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const bluff = cyl(15, 23, 20, 12, MAT.rock, 0, -2.4, 0);
  bluff.scale.set(1.4, 1, 1);
  g.add(bluff);
  for (const [ox, oz, s] of [
    [-19, 8, 7],
    [17, -10, 6],
  ] as const) {
    const r = mesh(new THREE.IcosahedronGeometry(s, 0), MAT.rock, ox, 1, oz);
    r.scale.set(1.2, 0.8, 1);
    g.add(r);
  }
  // The house: three storeys of white, all glass on the ocean (−X) face.
  g.add(box(17, 10, 12, MAT.white, 0, 12.6, 0));
  g.add(box(0.6, 7.6, 11, MAT.glass, -8.6, 12.6, 0));
  for (const sz of [-6.2, 6.2]) {
    for (const sy of [9.6, 13, 16.4]) {
      g.add(box(14, 1.9, 0.4, MAT.glass, 0, sy, sz)); // storey window bands
    }
  }
  g.add(box(18, 0.8, 13, MAT.slate, 0, 18, 0));
  g.add(box(6, 4, 6, MAT.white, 5, 19.8, 0));
  g.add(cyl(0.5, 0.5, 3, 6, MAT.steel, -6, 19.5, 4));
  g.add(box(0.5, 0.5, 0.5, MAT.lamp, -6, 21.2, 4));

  // Sutro Baths: rectangular basins outlined by broken concrete walls on the
  // shelf north of the bluff, each seated on the terrain it stands on.
  const basins = [
    [-14, -30, 11, 8],
    [-1, -32, 9, 7],
    [10, -28, 8, 6],
    [-8, -42, 10, 6],
  ] as const;
  for (const [bx, bz, bw, bd] of basins) {
    const y = ctx.groundAt(bx, bz) + 0.9;
    g.add(box(bw, 1.8, 0.7, MAT.concrete, bx, y, bz - bd / 2));
    g.add(box(bw, 1.8, 0.7, MAT.concrete, bx, y, bz + bd / 2));
    g.add(box(0.7, 1.8, bd, MAT.concrete, bx - bw / 2, y, bz));
    g.add(box(0.7, 1.8, bd, MAT.concrete, bx + bw / 2, y, bz));
  }
  // Snapped columns and a stair down from the bluff.
  for (let i = 0; i < 6; i++) {
    const cx = -18 + i * 6.5;
    const cz = -22 - (i % 3) * 3;
    g.add(cyl(0.7, 0.85, 3 + (i % 3) * 1.6, 7, MAT.concrete, cx, ctx.groundAt(cx, cz) + 1.5, cz));
  }
  g.add(box(4, 1, 14, MAT.concrete, -6, ctx.groundAt(-6, -16) + 3, -16).rotateX(-0.32));
  return g;
}

// --- The Presidio shore --------------------------------------------------

// Fort Point — the brick casemate fort under the Golden Gate's south
// anchorage: a hollow square of arched gun galleries on a granite wharf,
// with the harbour light on the seaward parapet. ~1.6× real.
function fortPoint(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, 15, 14);
  g.add(box(30, 2.4 - foot, 28, MAT.rock, 0, (2.4 + foot) / 2 - 1.2, 0)); // granite wharf
  const H = 11;
  const OUT = 13; // half-extent of the outer wall face
  const T = 4; // wall thickness
  g.add(box(OUT * 2, H, T, MAT.brick, 0, 2.4 + H / 2, -(OUT - T / 2)));
  g.add(box(OUT * 2, H, T, MAT.brick, 0, 2.4 + H / 2, OUT - T / 2));
  g.add(box(T, H, (OUT - T) * 2, MAT.brick, -(OUT - T / 2), 2.4 + H / 2, 0));
  g.add(box(T, H, (OUT - T) * 2, MAT.brick, OUT - T / 2, 2.4 + H / 2, 0));
  // Two tiers of casemate arches on every outer face.
  for (const tier of [5.4, 9.6]) {
    for (let i = 0; i < 7; i++) {
      const t = -OUT + 2.2 + i * ((OUT * 2 - 4.4) / 6);
      g.add(box(1.9, 2.6, 0.5, MAT.slate, t, tier, -(OUT - 0.2)));
      g.add(box(1.9, 2.6, 0.5, MAT.slate, t, tier, OUT - 0.2));
      g.add(box(0.5, 2.6, 1.9, MAT.slate, -(OUT - 0.2), tier, t));
      g.add(box(0.5, 2.6, 1.9, MAT.slate, OUT - 0.2, tier, t));
    }
  }
  // Parapet coping + the corner bastion.
  for (const sz of [-1, 1] as const) {
    g.add(box(OUT * 2 + 1, 1.2, T + 1, MAT.brick, 0, 2.4 + H + 0.6, sz * (OUT - T / 2)));
    g.add(box(T + 1, 1.2, (OUT - T) * 2, MAT.brick, sz * (OUT - T / 2), 2.4 + H + 0.6, 0));
  }
  g.add(cyl(5, 5.4, H + 3, 8, MAT.brick, -OUT + 2, 2.4 + (H + 3) / 2, -OUT + 2));
  // Harbour light on the seaward parapet.
  g.add(cyl(1.1, 1.4, 5, 8, MAT.white, OUT - 3, 2.4 + H + 3, -OUT + 3));
  g.add(cyl(1, 1, 1.4, 8, MAT.lamp, OUT - 3, 2.4 + H + 6.2, -OUT + 3));
  return g;
}

// --- China Basin ---------------------------------------------------------

// Oracle Park, rebuilt on the marine extract's measurements. It used to stand
// 101u (451 m) north-west of the real ballpark — the Wave 0 author pushed it
// there because the old China Basin water box swallowed the true site. The
// box is being replaced by the measured creek polygon, so the park goes back
// where it belongs, on the basin's north bank.
//
// Authored in COMPASS BEARINGS with `rotDeg: 0`, so the measurements read
// straight off the tables below. The model's two roof-edge rows radiate from
// home plate at bearing 262°; the bowl opens onto McCovey Cove between 55°
// and 155°; the 24-bin sector profile gives the grandstand ceiling. The
// 65.8 × 56.8u rim is the OSM parcel (plazas and all) — the bowl is kept
// inside it at the real 235 × 210 m.
const OP_PARCEL_A = 32.9; // measured 65.8u east-west
const OP_PARCEL_B = 28.4; // measured 56.8u north-south
const OP_BOWL_A = 26.5; // the real bowl, 235 m
const OP_BOWL_B = 23.6; // the real bowl, 210 m
const OP_OPEN_FROM = 55; // bearings of the outfield gap onto the Cove
const OP_OPEN_TO = 155;
// Field centre, pushed toward the Cove: home plate sits at bearing 262°.
const OP_FIELD_X = 5;
const OP_FIELD_Z = -0.7;
/**
 * Measured grandstand ceiling per 15° bearing bin (`sectorProfile`, converted
 * out of the extract's east-CCW frame). The 330° bin has no faces in the
 * model and inherits the modal 6.6u; single-bin dropouts elsewhere are what
 * `opCeiling` smooths over.
 */
const OP_SECTOR: readonly number[] = [
  4.0, 6.7, 6.6, 6.6, 0.6, 4.4, 4.4, 0.6, 0.2, -0.2, 4.0, 6.6, 2.2, 6.6, 6.6, 6.6, 6.6, 6.6, 6.6,
  6.6, 6.6, 4.0, 6.6, 6.6,
];
/**
 * The 16 measured light standards as `[dx, dz, top, height]` offsets from the
 * bowl centre — two roof-edge rows converging on home plate, two tall poles on
 * the water side, and the low block behind first base.
 */
const OP_MASTS: readonly (readonly [number, number, number, number])[] = [
  [-7.8, -10.9, 9.7, 6],
  [-6.1, -12.6, 9.7, 6],
  [-4.1, -14.6, 9.7, 6],
  [-2.4, -16.3, 9.7, 6],
  [0.6, -18.5, 9.7, 6],
  [2.5, -19.9, 9.7, 6],
  [4.9, -21.6, 9.7, 6],
  [6.8, -22.9, 9.7, 6],
  [33.5, -6.5, 8.5, 8.6],
  [34.4, 5.7, 8.5, 8.6],
  [1.4, 22.9, 9.7, 6],
  [-0.5, 21.5, 9.7, 6],
  [-2.9, 19.8, 9.7, 6],
  [-5.3, 18.1, 9.7, 6],
  [-7.1, 16.7, 9.7, 6],
  [-18.7, 8.7, 3.0, 3.9],
];

/** Smoothed sector ceiling at a bin index (the raw walk drops single bins). */
function opBin(i: number): number {
  const n = OP_SECTOR.length;
  const at = (k: number): number => OP_SECTOR[((k % n) + n) % n] ?? 6.6;
  return at(i - 1) * 0.25 + at(i) * 0.5 + at(i + 1) * 0.25;
}

/** Grandstand ceiling at a compass bearing, floored so the horseshoe holds. */
function opCeiling(deg: number): number {
  const t = deg / 15;
  const i = Math.floor(t);
  return Math.max(4.4, THREE.MathUtils.lerp(opBin(i), opBin(i + 1), t - i));
}

/**
 * Walk an ELLIPSE by compass bearing (the bowl is 1.16:1, so a circle puts the
 * stands 6u out of place on the long axis). `yaw` is the true elliptical
 * tangent, not the circular one.
 */
function opRing(
  count: number,
  a: number,
  b: number,
  deg0: number,
  sweep: number,
  cb: (x: number, z: number, yaw: number, deg: number) => void,
): void {
  for (let i = 0; i < count; i++) {
    const deg = deg0 + (sweep * (i + 0.5)) / count;
    const r = THREE.MathUtils.degToRad(deg);
    const sn = Math.sin(r);
    const cs = Math.cos(r);
    cb(sn * a, -cs * b, -Math.atan2(b * sn, a * cs), deg);
  }
}

function oraclePark(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const foot = lowestUnder(ctx, OP_PARCEL_A, OP_PARCEL_B);
  // Parcel apron: the OSM way, plazas included.
  const apron = cyl(OP_PARCEL_A, OP_PARCEL_A + 1, 0.5 - foot, 28, MAT.concrete, 0, foot / 2, 0);
  apron.scale.set(1, 1, OP_PARCEL_B / OP_PARCEL_A);
  g.add(apron);
  // Playing surface: turf, then the dirt infield out at home plate.
  const turf = cyl(19, 19, 0.6, 26, MAT.field, OP_FIELD_X, 0.3, OP_FIELD_Z);
  turf.scale.set(1, 1, 16.5 / 19);
  g.add(turf);
  g.add(cyl(6, 6, 0.7, 14, MAT.rock, -15.8, 0.4, 2.2));

  const closed = 360 - (OP_OPEN_TO - OP_OPEN_FROM);
  // Raked seating decks, ceiling from the measured sector profile.
  opRing(26, OP_BOWL_A * 0.88, OP_BOWL_B * 0.88, OP_OPEN_TO, closed, (x, z, yaw, deg) => {
    const h = opCeiling(deg);
    const deck = box(5.6, h, 9, MAT.concrete, x, h / 2 - 0.3, z, yaw);
    deck.rotation.order = "YXZ";
    deck.rotation.x = -0.34;
    g.add(deck);
  });
  // Brick outer facade on the bowl rim.
  opRing(26, OP_BOWL_A, OP_BOWL_B, OP_OPEN_TO, closed, (x, z, yaw, deg) => {
    const h = opCeiling(deg) + 1.4;
    g.add(box(6.2, h, 2, MAT.brick, x, h / 2, z, yaw));
  });
  // The gap: the right-field arcade wall and its promenade, low enough that
  // the bowl reads as open onto the water.
  opRing(11, OP_BOWL_A, OP_BOWL_B, OP_OPEN_FROM, OP_OPEN_TO - OP_OPEN_FROM, (x, z, yaw) => {
    g.add(box(6.2, 3.8, 1.8, MAT.brick, x, 1.9, z, yaw));
    g.add(box(6.2, 0.5, 2.8, MAT.concrete, x, 4.0, z, yaw));
  });
  // Scoreboard on the stands opposite the gap, lit face turned in on the field.
  {
    const r = THREE.MathUtils.degToRad((OP_OPEN_FROM + OP_OPEN_TO) / 2 + 180);
    const nx = Math.sin(r);
    const nz = -Math.cos(r);
    const sx = nx * (OP_BOWL_A + 1.5);
    const sz = nz * (OP_BOWL_B + 1.5);
    const yaw = -Math.atan2(OP_BOWL_B * Math.sin(r), OP_BOWL_A * Math.cos(r));
    g.add(box(16, 6.5, 1.4, MAT.slate, sx, 11, sz, yaw));
    g.add(box(14.5, 5, 0.4, MAT.lamp, sx - nx * 0.9, 11, sz - nz * 0.9, yaw));
  }
  // Light standards: pole, bank, and the bank's lit face aimed at the field.
  const beacons: Beacon[] = [];
  for (const [mx, mz, top, mh] of OP_MASTS) {
    const fx = OP_FIELD_X - mx;
    const fz = OP_FIELD_Z - mz;
    const fl = Math.hypot(fx, fz) || 1;
    const dx = fx / fl;
    const dz = fz / fl;
    const yaw = Math.atan2(-dx, -dz);
    g.add(box(0.9, mh, 0.9, MAT.slate, mx, top - mh / 2, mz));
    g.add(box(4.4, 1.4, 0.8, MAT.slate, mx, top + 0.6, mz, yaw));
    g.add(box(4.0, 0.9, 0.3, MAT.lamp, mx + dx * 0.5, top + 0.6, mz + dz * 0.5, yaw));
    const [wx, wy, wz] = ctx.worldPoint(mx + dx * 0.5, top + 0.6, mz + dz * 0.5);
    beacons.push({ x: wx, y: wy, z: wz, color: 0xfff2d2, size: 4.6 });
  }
  registerBeacons("oraclepark", beacons);
  return g;
}

// --- Russian Hill --------------------------------------------------------

// Lombard Street set dressing: the switchback retaining walls, hedge beds
// and brick paving of the crooked block. The hairpin ROADWAY itself is
// street-network work; this is the landscaping that makes the block read as
// the crooked street even while the road under it is straight. Anything that
// would land on asphalt is dropped rather than fought with.
function lombard(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const BEDS = 9;
  const RUN = 52; // the crooked block descends over ~52u
  // Lay the run along the STREET, not along +X: a hardcoded axis puts half
  // the beds in the asphalt and the other half in someone's back yard.
  const [ox, oz] = ctx.origin;
  const hit = ctx.network?.nearest(ox, oz, ROAD_TILE * 2) ?? null;
  const tx = hit ? hit.tx : 1;
  const tz = hit ? hit.tz : 0;
  const off = (hit ? hit.edge.half : 5) + 2.6; // bed centres flank the roadway
  for (let i = 0; i < BEDS; i++) {
    const s = -RUN / 2 + (RUN * (i + 0.5)) / BEDS;
    const side = i % 2 === 0 ? -1 : 1;
    // Local frame: tangent (tx,tz) along the street, normal (-tz,tx) across.
    const x = tx * s - tz * off * side;
    const z = tz * s + tx * off * side;
    if (ctx.onAsphalt(x, z, 0.8)) continue;
    const y = ctx.groundAt(x, z);
    // rotation.y maps local +X to (cos, -sin) in (x, z) — this aims it along the tangent.
    const yaw = Math.atan2(-tz, tx);
    g.add(box(6, 1.7, 4, MAT.brick, x, y + 0.85, z, yaw)); // retaining planter
    g.add(box(5.2, 1.6, 3.2, MAT.hedge, x, y + 2.45, z, yaw));
    // The switchback kerb: a brick wall angling back across to the next bed.
    const sMid = s + RUN / BEDS / 2;
    const mx = tx * sMid - tz * off * side * 0.45;
    const mz = tz * sMid + tx * off * side * 0.45;
    if (ctx.onAsphalt(mx, mz, 0.8)) continue;
    g.add(box(1.1, 1.5, 7, MAT.brick, mx, ctx.groundAt(mx, mz) + 0.75, mz, yaw + side * 0.6));
  }
  // Kerb walls closing the block at both ends.
  for (const end of [-1, 1] as const) {
    const s = (end * RUN) / 2 + end * 3;
    const x = tx * s;
    const z = tz * s;
    if (ctx.onAsphalt(x, z, 0.8)) continue;
    g.add(box(1.6, 2.4, 13, MAT.brick, x, ctx.groundAt(x, z) + 1.2, z, Math.atan2(-tz, tx)));
  }
  return g;
}

// --- Registry ------------------------------------------------------------

// Each kind knows how it is authored and how it seats; the table below only
// says WHERE. `seat: "sea"` pins the origin to the waterline.
const DEFS = {
  pyramid: { build: pyramid, seat: "ground", scale: KIT_SCALE },
  salesforce: { build: salesforce, seat: "ground", scale: KIT_SCALE },
  coittower: { build: coitTower, seat: "ground", scale: KIT_SCALE },
  ferrybuilding: { build: ferryBuilding, seat: "ground", scale: 1 },
  paintedladies: { build: paintedLadies, seat: "ground", scale: KIT_SCALE },
  sutro: { build: sutroTower, seat: "ground", scale: KIT_SCALE },
  dragongate: { build: dragonGate, seat: "ground", scale: KIT_SCALE },
  baybridge: { build: bayBridge, seat: "sea", scale: 1 },
  alcatraz: { build: alcatraz, seat: "sea", scale: 1 },
  cityhall: { build: cityHall, seat: "ground", scale: 1 },
  palace: { build: palaceOfFineArts, seat: "ground", scale: 1 },
  twinpeaks: { build: twinPeaks, seat: "ground", scale: 1 },
  deyoung: { build: deYoung, seat: "ground", scale: 1 },
  conservatory: { build: conservatory, seat: "ground", scale: 1 },
  windmill: { build: windmill, seat: "ground", scale: 1 },
  cliffhouse: { build: cliffHouse, seat: "ground", scale: 1 },
  fortpoint: { build: fortPoint, seat: "ground", scale: 1 },
  oraclepark: { build: oraclePark, seat: "ground", scale: 1 },
  lombard: { build: lombard, seat: "ground", scale: 1 },
} as const satisfies Record<string, LandmarkDef>;

type LandmarkKind = keyof typeof DEFS;

// `clearR` (world units) is the monument's ground-footprint radius: those
// landmarks are nudged off vector asphalt at build time (a hardcoded (u,v)
// has no idea where the baked streets landed — Salesforce stood in the road).
// `protHalf` are the reservation-rect half-extents, sized to the VISUAL base
// (they were smaller than the meshes, letting buildings clip the monuments).
// `clearHalf` is the same reservation WITHOUT the collision boxes: an
// ELEVATED structure (the Bay Bridge approach viaduct) must keep procedural
// towers out of its deck while leaving the streets underneath drivable.
// `clearOffset` moves that rect off the monument's origin, which a corridor
// running to ONE side needs — centred on the origin, a diagonal viaduct's
// axis-aligned box reserves four times the city it actually covers.
// A landmark with none of them is pure scenery: it reserves nothing and
// collides with nothing.
type Landmark = {
  readonly kind: LandmarkKind;
  readonly name: string;
  readonly u: number;
  readonly v: number;
  readonly rotDeg: number;
  readonly clearR?: number;
  readonly protHalf?: readonly [number, number];
  readonly clearHalf?: readonly [number, number];
  readonly clearOffset?: readonly [number, number];
};

// (The Golden Gate is no longer a landmark prop — it's the DRIVABLE bridge
// built by world/golden-gate.ts.)
const LANDMARKS: readonly Landmark[] = [
  // The measured Rincon Hill anchorage on the Embarcadero seawall. rotDeg 49.5
  // puts the crossing on its true 40.5° bearing (rotation.y maps local +X to
  // (cos r, −sin r), so bearing = 90 − rotDeg). Only the anchorage is
  // protected — everything east of it is deck, 13u up over open water.
  {
    kind: "baybridge",
    name: "the Bay Bridge",
    u: 0.7954,
    v: 0.2127,
    rotDeg: 49.5,
    protHalf: [20, 20],
    // The approach viaduct's corridor: reserved so nothing grows through the
    // deck, drivable so the Embarcadero still runs under it. It runs to ONE
    // side now (62u back into SoMa on bearing 220.5°), so the rect is offset
    // instead of straddling the anchorage.
    clearHalf: [30, 32],
    clearOffset: [-20, 24],
  },
  {
    kind: "pyramid",
    name: "the Transamerica Pyramid",
    u: 0.701,
    v: 0.15,
    rotDeg: 0,
    clearR: 7.2,
    protHalf: [7.2, 7.2],
  },
  // 415 Mission projected through the calibrated lon/lat→(u,v) fit.
  {
    kind: "salesforce",
    name: "Salesforce Tower",
    u: 0.7396,
    v: 0.2038,
    rotDeg: 0,
    clearR: 6.9,
    protHalf: [6.9, 6.9],
  },
  {
    kind: "coittower",
    name: "Coit Tower",
    u: 0.683,
    v: 0.082,
    rotDeg: 0,
    clearR: 6,
    protHalf: [6, 6],
  },
  // ON the new shore edge. The measured centroid is 22u further out (u 0.7625
  // / v 0.1464) but reads 92% wet against our land test, so the placement
  // stays; only the massing was corrected.
  {
    kind: "ferrybuilding",
    name: "the Ferry Building",
    u: 0.756,
    v: 0.15,
    rotDeg: 270,
    protHalf: [5.5, 23.5],
  },
  {
    kind: "paintedladies",
    name: "the Painted Ladies",
    u: 0.513,
    v: 0.33,
    rotDeg: 90,
    protHalf: [4, 20],
  },
  {
    kind: "sutro",
    name: "Sutro Tower",
    u: 0.402,
    v: 0.52,
    rotDeg: 0,
    clearR: 6.5,
    protHalf: [6.5, 6.5],
  },
  { kind: "dragongate", name: "the Dragon Gate", u: 0.6725, v: 0.228, rotDeg: 0 },
  // NNE of Fisherman's Wharf, just inside the map's north edge.
  { kind: "alcatraz", name: "Alcatraz", u: 0.62, v: 0.006, rotDeg: 14 },
  {
    kind: "cityhall",
    name: "City Hall",
    u: 0.62,
    v: 0.28,
    rotDeg: 0,
    clearR: 12,
    protHalf: [20, 13],
  },
  {
    kind: "palace",
    name: "the Palace of Fine Arts",
    u: 0.46,
    v: 0.06,
    rotDeg: 200,
    clearR: 11,
    protHalf: [30, 26],
  },
  // Pulled a touch east of the true summit so the terrace is a short grass
  // climb from Twin Peaks Blvd instead of a 47u hike.
  {
    kind: "twinpeaks",
    name: "the Twin Peaks overlook",
    u: 0.412,
    v: 0.56,
    rotDeg: 0,
    clearR: 14,
    protHalf: [15, 15],
  },
  // The park set sits toward the drives at the park's edges — dead centre
  // they are skyline only, never something you pull up in front of.
  {
    kind: "deyoung",
    name: "the de Young Museum",
    u: 0.33,
    v: 0.414,
    rotDeg: 0,
    clearR: 12,
    protHalf: [28, 12],
  },
  {
    kind: "conservatory",
    name: "the Conservatory of Flowers",
    u: 0.368,
    v: 0.386,
    rotDeg: 0,
    clearR: 10,
    protHalf: [16, 9],
  },
  {
    kind: "windmill",
    name: "the Dutch Windmill",
    u: 0.055,
    v: 0.373,
    rotDeg: 250,
    clearR: 7,
    protHalf: [8, 8],
  },
  {
    kind: "windmill",
    name: "the Murphy Windmill",
    u: 0.055,
    v: 0.437,
    rotDeg: 250,
    clearR: 7,
    protHalf: [8, 8],
  },
  {
    kind: "cliffhouse",
    name: "the Cliff House",
    u: 0.049,
    v: 0.281,
    rotDeg: 0,
    clearR: 12,
    protHalf: [20, 34],
  },
  {
    kind: "fortpoint",
    name: "Fort Point",
    u: 0.243,
    v: 0.056,
    rotDeg: 0,
    clearR: 14,
    protHalf: [17, 16],
  },
  // The measured centroid. DEPENDS ON the China Basin water polygon replacing
  // the old box — until it lands, this site is inside the flooded rect.
  {
    kind: "oraclepark",
    name: "Oracle Park",
    u: 0.7838,
    v: 0.3115,
    rotDeg: 0,
    clearR: 14,
    protHalf: [33, 29],
  },
  // Pure set dressing: no reservation, no collision — the crooked block's
  // roadway belongs to the street network, not to a monument.
  { kind: "lombard", name: "Lombard Street", u: 0.602, v: 0.088, rotDeg: 0 },
];

// Final world position of a landmark: the traced (u,v), pushed off any street
// whose asphalt the ground footprint would overlap. Deterministic per network,
// so protection rects and visuals always agree.
function resolvePosition(lm: Landmark, network: RoadNetwork | null): readonly [number, number] {
  let x = uWorld(lm.u);
  let z = vWorld(lm.v);
  const r = lm.clearR;
  if (!network || r === undefined) return [x, z];
  for (let i = 0; i < 4; i++) {
    const hit = network.nearest(x, z, r + ROAD_TILE * 1.6);
    if (!hit) break;
    const want = hit.edge.half + r + 0.6;
    if (hit.dist >= want) break;
    let nx = -hit.tz;
    let nz = hit.tx;
    if (nx * (x - hit.x) + nz * (z - hit.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    x = hit.x + nx * want;
    z = hit.z + nz * want;
  }
  return [x, z];
}

function uWorld(u: number): number {
  return (u - 0.5) * WORLD_W;
}
function vWorld(v: number): number {
  return (v - 0.5) * WORLD_H;
}

// --- Display names -------------------------------------------------------

export type LandmarkMarker = {
  readonly name: string;
  readonly x: number;
  readonly z: number;
};

/**
 * Every landmark's display name at its RESOLVED world position (the same
 * street-avoidance pass the visuals use), so a caption/minimap layer and the
 * monument it labels can never disagree.
 */
export function landmarkMarkers(network: RoadNetwork | null = null): readonly LandmarkMarker[] {
  return LANDMARKS.map((lm) => {
    const [x, z] = resolvePosition(lm, network);
    return { name: lm.name, x, z };
  });
}

/** Name of the landmark nearest (x, z) within `radius`, else null. */
export function landmarkNameAt(
  x: number,
  z: number,
  radius: number,
  network: RoadNetwork | null = null,
): string | null {
  let best: string | null = null;
  let bestD = radius * radius;
  for (const m of landmarkMarkers(network)) {
    const d = (m.x - x) * (m.x - x) + (m.z - z) * (m.z - z);
    if (d > bestD) continue;
    bestD = d;
    best = m.name;
  }
  return best;
}

// --- Footprint protection: cells the procedural city must leave to the
// landmarks, park cells forced green, and collision boxes so the taxi can't
// drive through a monument. ---
export type LandmarkProtection = {
  readonly reserved: ReadonlySet<string>;
  readonly parkGreen: ReadonlySet<string>;
  readonly solids: readonly Solid[];
};

function cellKey(gx: number, gz: number): string {
  return `${gx},${gz}`;
}
function gxOf(u: number): number {
  return Math.min(GRID_X - 1, Math.max(0, Math.floor(u * GRID_X)));
}
function gzOf(v: number): number {
  return Math.min(GRID_Z - 1, Math.max(0, Math.floor(v * GRID_Z)));
}

export function landmarkProtection(
  plan: CityPlan,
  network: RoadNetwork | null = null,
): LandmarkProtection {
  const reserved = new Set<string>();
  const parkGreen = new Set<string>();
  const solids: Solid[] = [];

  // Reserve every cell a landmark's rect touches (no procedural buildings or
  // furniture there), but emit collision boxes ONLY on lot cells, clamped to
  // each cell — a monument must never wall off a road or strand a fare.
  // `solid: false` reserves without walling (see `clearHalf`).
  const protect = (x: number, z: number, halfX: number, halfZ: number, solid: boolean): void => {
    const minX = x - halfX;
    const maxX = x + halfX;
    const minZ = z - halfZ;
    const maxZ = z + halfZ;
    const g0x = Math.max(0, Math.floor((minX + WORLD_HALF_X) / ROAD_TILE));
    const g1x = Math.min(GRID_X - 1, Math.floor((maxX + WORLD_HALF_X) / ROAD_TILE));
    const g0z = Math.max(0, Math.floor((minZ + WORLD_HALF_Z) / ROAD_TILE));
    const g1z = Math.min(GRID_Z - 1, Math.floor((maxZ + WORLD_HALF_Z) / ROAD_TILE));
    for (let gx = g0x; gx <= g1x; gx++) {
      for (let gz = g0z; gz <= g1z; gz++) {
        reserved.add(cellKey(gx, gz));
        if (!solid || plan.cells[gx]?.[gz] !== "lot") continue;
        const cMinX = gx * ROAD_TILE - WORLD_HALF_X;
        const cMinZ = gz * ROAD_TILE - WORLD_HALF_Z;
        solids.push({
          minX: Math.max(minX, cMinX),
          maxX: Math.min(maxX, cMinX + ROAD_TILE),
          minZ: Math.max(minZ, cMinZ),
          maxZ: Math.min(maxZ, cMinZ + ROAD_TILE),
        });
      }
    }
  };

  for (const lm of LANDMARKS) {
    if (!lm.protHalf && !lm.clearHalf) continue;
    const [x, z] = resolvePosition(lm, network);
    if (lm.clearHalf) {
      const off = lm.clearOffset ?? [0, 0];
      protect(x + off[0], z + off[1], lm.clearHalf[0], lm.clearHalf[1], false);
    }
    if (lm.protHalf) protect(x, z, lm.protHalf[0], lm.protHalf[1], true);
  }

  // Alamo Square green faces the Painted Ladies one column west.
  {
    const gx = gxOf(0.513);
    const gz = gzOf(0.33);
    for (let dz = -2; dz <= 2; dz++) parkGreen.add(cellKey(gx - 1, gz + dz));
  }

  return { reserved, parkGreen, solids };
}

export function buildLandmarks(
  terrain: Terrain,
  cache: ModelCache,
  network: RoadNetwork | null = null,
): THREE.Group {
  const root = new THREE.Group();
  const rng = new Rng(4242);
  for (const lm of LANDMARKS) {
    const def = DEFS[lm.kind];
    const [x, z] = resolvePosition(lm, network);
    const y = def.seat === "sea" ? 0 : terrain.heightAt(x, z);
    const rot = THREE.MathUtils.degToRad(lm.rotDeg);
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const s = def.scale;
    const worldOf = (lx: number, lz: number): readonly [number, number] => [
      x + s * (lx * cos + lz * sin),
      z + s * (-lx * sin + lz * cos),
    ];
    const ctx: LandmarkCtx = {
      terrain,
      cache,
      network,
      rng,
      origin: [x, z],
      groundAt: (lx, lz) => {
        const [wx, wz] = worldOf(lx, lz);
        return (terrain.heightAt(wx, wz) - y) / s;
      },
      onAsphalt: (lx, lz, margin) => {
        if (!network) return false;
        const [wx, wz] = worldOf(lx, lz);
        const hit = network.nearest(wx, wz, ROAD_TILE * 1.6);
        return hit !== null && hit.dist < hit.edge.half + margin;
      },
      worldPoint: (lx, ly, lz) => {
        const [wx, wz] = worldOf(lx, lz);
        return [wx, y + ly * s, wz];
      },
    };
    const node = packLandmark(def.build(ctx));
    node.position.set(x, y, z);
    node.rotation.y = rot;
    node.scale.multiplyScalar(s);
    root.add(node);
  }
  return root;
}
