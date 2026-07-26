import * as THREE from "three";

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

// Ferry Building — long arcade with a central clock tower. Kept short enough
// (26 × scale ≈ 36u ≈ 3 cells) that its footprint stays off the road grid.
function ferryBuilding(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(26, 7, 7, MAT.cream, 0, 3.5, 0));
  g.add(box(4.5, 22, 4.5, MAT.cream, 0, 11, 0));
  g.add(box(3, 3, 0.4, MAT.steel, 0, 18, 2.3)); // clock face
  g.add(mesh(new THREE.ConeGeometry(3, 4, 4), MAT.cream, 0, 24, 0));
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

const BAY_DECK_Y = 13; // ~60 m of shipping clearance
const BAY_TOWER_H = 36; // 160 m towers, true scale
const BAY_HALF_W = 5.5;
// Chainage east from the Rincon Hill anchorage at the Embarcadero seawall.
// The real western crossing is 2.8 km; only ~650u of bay fit between the
// seawall and the map's east edge, so the two suspension spans are
// compressed to ~110u each while keeping the real ARRANGEMENT: shore
// anchorage, tower, centre anchorage, tower, Yerba Buena — then the
// self-anchored eastern span with its single asymmetric tower.
const BAY_ANCHOR_W = 8;
const BAY_TOWER_1 = 118;
const BAY_ANCHOR_MID = 232;
const BAY_TOWER_2 = 346;
const BAY_YERBA = 462;
const BAY_SAS_TOWER = 528;
const BAY_EAST_END = 700; // runs off the map edge into the fog, as it should

/** Deck slab + parapets + the light string, from x0 to x1 at height y. */
function bayDeck(g: THREE.Group, x0: number, x1: number, y: number): void {
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  g.add(box(len, 1.1, BAY_HALF_W * 2, MAT.steel, cx, y - 0.55, 0)); // upper deck
  g.add(box(len, 1.0, BAY_HALF_W * 2 - 0.6, MAT.steel, cx, y - 4.2, 0)); // lower deck
  for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
    g.add(box(len, 3.4, 0.5, MAT.steel, cx, y - 2.4, sz)); // side truss
    g.add(box(len, 0.9, 0.35, MAT.steel, cx, y + 0.45, sz)); // parapet
  }
  // Deck lighting: unlit warm boxes on the parapet, one every ~15u. They are
  // the only thing that keeps the crossing legible after dark.
  const step = 15;
  const n = Math.max(1, Math.round(len / step));
  for (let i = 0; i < n; i++) {
    const x = x0 + (len * (i + 0.5)) / n;
    for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
      g.add(box(0.55, 0.55, 0.55, MAT.lamp, x, y + 1.5, sz));
      g.add(box(0.16, 1.4, 0.16, MAT.steel, x, y + 0.9, sz));
    }
  }
}

/** One western-span tower: two shafts either side of the roadway, braced. */
function bayTower(g: THREE.Group, x: number): void {
  const top = BAY_DECK_Y + BAY_TOWER_H;
  for (const sz of [-(BAY_HALF_W + 1.4), BAY_HALF_W + 1.4]) {
    g.add(box(3.4, top + 8, 3.4, MAT.steel, x, (top - 8) / 2, sz));
  }
  for (const by of [BAY_DECK_Y - 6, BAY_DECK_Y + 9, BAY_DECK_Y + 22, top - 2]) {
    g.add(box(2.4, 1.6, BAY_HALF_W * 2 + 3.4, MAT.steel, x, by, 0));
  }
}

// The Bay Bridge: the west double suspension (shore anchorage → tower →
// centre anchorage → tower → Yerba Buena) and the self-anchored eastern span
// with its single asymmetric tower. Authored in world units along +X from
// the SF landfall, which is the point the (u,v) in the table names.
function bayBridge(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const D = BAY_DECK_Y;

  // --- SF landfall: the anchorage block on the seawall, plus the elevated
  // approach viaduct running back west over the Embarcadero, so the crossing
  // reads as arriving FROM the city instead of starting in mid-air. Every
  // pier hunts for ground that is not a live street — a column standing in
  // the roadway is worse than no column. ---
  g.add(box(26, D + 16, 26, MAT.concrete, BAY_ANCHOR_W, (D + 6) / 2 - 5, 0));
  g.add(box(20, 5, 20, MAT.concrete, BAY_ANCHOR_W, D + 12, 0)); // stepped crown
  for (const sz of [-(BAY_HALF_W + 1.4), BAY_HALF_W + 1.4]) {
    g.add(box(7, 4, 4, MAT.steel, BAY_ANCHOR_W + 11, D + 8, sz)); // cable saddle
  }
  const approachEnd = -58;
  bayDeck(g, approachEnd, BAY_ANCHOR_W, D);
  // Piers hunt sideways for ground clear of the roadway before giving up: the
  // real viaduct straddles the streets it crosses, it does not stand in them.
  for (let px = approachEnd + 4; px < BAY_ANCHOR_W - 12; px += 9) {
    const pz = [0, -8, 8].find((z) => !ctx.onAsphalt(px, z, 1.6));
    if (pz === undefined) continue;
    g.add(box(5, D + 8, 5, MAT.concrete, px, D / 2 - 5, pz));
    g.add(box(7, 1.6, BAY_HALF_W * 2 + 2, MAT.concrete, px, D - 5.6, pz * 0.35));
  }

  // --- Western crossing ---
  bayDeck(g, BAY_ANCHOR_W, BAY_YERBA, D);
  bayTower(g, BAY_TOWER_1);
  bayTower(g, BAY_TOWER_2);
  // Centre anchorage at the hinge of the two suspension spans: the block the
  // four main cables actually pull against, rising well above the deck.
  g.add(box(18, D + 30, 22, MAT.concrete, BAY_ANCHOR_MID, (D + 16) / 2 - 4, 0));

  const top = D + BAY_TOWER_H;
  for (const sz of [-(BAY_HALF_W + 1.4), BAY_HALF_W + 1.4]) {
    const key = [
      new THREE.Vector3(BAY_ANCHOR_W + 4, D + 8, sz),
      new THREE.Vector3(BAY_TOWER_1, top, sz),
      new THREE.Vector3(BAY_ANCHOR_MID, D + 12, sz),
      new THREE.Vector3(BAY_TOWER_2, top, sz),
      new THREE.Vector3(BAY_YERBA - 8, D + 8, sz),
    ];
    const curve = new THREE.CatmullRomCurve3(key);
    g.add(mesh(new THREE.TubeGeometry(curve, 56, 0.5, 5), MAT.steel));
    for (let i = 1; i < 28; i++) {
      const p = curve.getPoint(i / 28);
      const h = p.y - (D + 1);
      if (h < 1.2) continue;
      g.add(box(0.22, h, 0.22, MAT.steel, p.x, D + 1 + h / 2, p.z));
    }
  }

  // --- Yerba Buena: the mid-bay island the two crossings hand off across ---
  const rock = cyl(16, 26, 22, 12, MAT.rock, BAY_YERBA, 1, 0);
  rock.scale.set(1.5, 1, 1);
  g.add(rock);
  g.add(box(20, 12, 16, MAT.rock, BAY_YERBA, 12, 0)); // tunnel headland
  g.add(box(6, 9, BAY_HALF_W * 2 + 2, MAT.concrete, BAY_YERBA, D + 1.5, 0)); // tunnel portal
  bayDeck(g, BAY_YERBA, BAY_EAST_END, D);

  // --- Eastern self-anchored suspension span: ONE tower, all the cable on
  // its west face, the deck hung from a single looping strand. ---
  const sasTop = D + 46;
  for (const sx of [-1.6, 1.6]) {
    for (const sz of [-1.6, 1.6]) {
      g.add(box(2, sasTop + 6, 2, MAT.white, BAY_SAS_TOWER + sx, (sasTop - 6) / 2, sz));
    }
  }
  for (const by of [D + 12, D + 26, sasTop - 4]) {
    g.add(box(5.6, 1.2, 5.6, MAT.white, BAY_SAS_TOWER, by, 0));
  }
  const sasTip = new THREE.Vector3(BAY_SAS_TOWER, sasTop, 0);
  for (let i = 1; i <= 9; i++) {
    for (const dir of [-1, 1] as const) {
      const reach = dir < 0 ? BAY_SAS_TOWER - BAY_YERBA - 10 : BAY_EAST_END - BAY_SAS_TOWER - 10;
      const x = BAY_SAS_TOWER + (dir * (reach * i)) / 9;
      for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
        g.add(strut(sasTip, new THREE.Vector3(x, D + 0.6, sz), 0.22, MAT.steel, 4));
      }
    }
  }
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

// Oracle Park — the raked bowl, the brick facade, the right-field wall over
// the water and four light masts. True scale (~200 m across).
function oraclePark(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const R = 19;
  const foot = lowestUnder(ctx, 24, 24);
  g.add(cyl(26, 27, 0.4 - foot, 24, MAT.concrete, 0, (0.4 + foot) / 2 - 0.2, 0)); // footing
  // Playing surface: turf disc, dirt infield, backstop.
  const turf = cyl(15.5, 15.5, 0.6, 24, MAT.field, 0, 0.3, 0);
  turf.scale.set(1.15, 1, 1);
  g.add(turf);
  g.add(cyl(5.5, 5.5, 0.7, 14, MAT.rock, -4, 0.4, 6));
  // Raked seating decks around 265°, open to the bay on the east.
  arc(22, R, 200, 265, (x, z, yaw) => {
    const deck = box(6.1, 9, 8.5, MAT.concrete, x, 4, z, yaw);
    deck.rotation.order = "YXZ";
    deck.rotation.x = -0.34;
    g.add(deck);
  });
  // Brick outer facade + the arcade wall along the water.
  arc(22, R + 4.4, 200, 265, (x, z, yaw) => {
    g.add(box(6.9, 12, 2, MAT.brick, x, 6, z, yaw));
  });
  arc(7, R + 2, 105, 92, (x, z, yaw) => {
    g.add(box(6.4, 7, 1.6, MAT.brick, x, 3.5, z, yaw)); // right-field wall
    g.add(box(6.4, 0.5, 2.6, MAT.concrete, x, 7.2, z, yaw)); // promenade coping
  });
  // Scoreboard over the left-field stands.
  g.add(box(15, 7, 1.4, MAT.slate, 6, 16, -R - 4));
  g.add(box(13.5, 5.4, 0.4, MAT.lamp, 6, 16, -R - 4.9));
  // Light masts.
  arc(4, R + 3, 210, 250, (x, z, yaw) => {
    g.add(box(1.2, 22, 1.2, MAT.slate, x, 11, z));
    g.add(box(7, 2.2, 1, MAT.slate, x, 22.5, z, yaw));
    g.add(box(6.4, 1.4, 0.5, MAT.lamp, x, 22.5, z - 0.5, yaw));
  });
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
  ferrybuilding: { build: ferryBuilding, seat: "ground", scale: KIT_SCALE },
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
// A landmark with none of the three is pure scenery: it reserves nothing and
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
};

// (The Golden Gate is no longer a landmark prop — it's the DRIVABLE bridge
// built by world/golden-gate.ts.)
const LANDMARKS: readonly Landmark[] = [
  // The crossing lands ON the Embarcadero seawall (shoreU(0.205) ≈ 0.797)
  // and runs east off the map. Only the anchorage is protected — the deck is
  // 13u up, over open water.
  {
    kind: "baybridge",
    name: "the Bay Bridge",
    u: 0.7986,
    v: 0.205,
    rotDeg: 6,
    protHalf: [22, 15],
    // The approach viaduct's corridor: reserved so nothing grows through the
    // deck, drivable so the Embarcadero still runs under it. Symmetric about
    // the anchorage — the eastern half falls on water and reserves nothing.
    clearHalf: [58, 13],
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
  {
    kind: "ferrybuilding",
    name: "the Ferry Building",
    u: 0.756,
    v: 0.15,
    rotDeg: 270,
    protHalf: [5.7, 21.2],
  }, // ON the new shore edge
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
  {
    kind: "oraclepark",
    name: "Oracle Park",
    u: 0.775,
    v: 0.274,
    rotDeg: 20,
    clearR: 14,
    protHalf: [26, 26],
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
    if (lm.clearHalf) protect(x, z, lm.clearHalf[0], lm.clearHalf[1], false);
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
    };
    const node = packLandmark(def.build(ctx));
    node.position.set(x, y, z);
    node.rotation.y = rot;
    node.scale.multiplyScalar(s);
    root.add(node);
  }
  return root;
}
