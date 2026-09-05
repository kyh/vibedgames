import * as THREE from "three";
import type { WaterBody } from "./water";

import { type Beacon, registerBeacons } from "../fx/beacon-lights";
import type { ModelCache } from "../assets/loader";
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
import { arc, box, cyl, dome, facet, MAT, mesh, packLandmark, paint, strut } from "./landmark-geo";
import { MASONRY, seatMasonry } from "./masonry";
import type { RoadNetwork } from "./network";
import { createSalesforceModel } from "./sf-salesforce";
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
  /** Paired local water-wall geometry/collision. Cold generation captures the
   * transformed solids; runtime landmark rebuilds reuse those baked solids. */
  readonly addWaterWall: (wall: Solid & { readonly minY: number; readonly maxY: number }) => void;
  readonly addWaterBody: (body: WaterBody) => void;
};

/**
 * Lowest terrain under a landmark-local rect, clamped at 0 (its own origin).
 * A monument seats on the height at its CENTRE, so on any slope its downhill
 * corner shows daylight underneath — every ground-seated builder sinks a
 * footing to this depth instead.
 */
/**
 * Landmark night beacons, collected per build and published in one registry
 * entry (see fx/beacon-lights.ts — runtime only, no bake).
 *
 * The audit's night pass found every monument except the two bridges going
 * completely dark: City Hall was LESS legible than the office block beside it,
 * Alcatraz's lighthouse did not burn, and Coit and the Pyramid vanished. A
 * landmark that only works in daylight is not a beacon.
 */
let landmarkBeacons: Beacon[] = [];

function beaconAt(
  ctx: LandmarkCtx,
  lx: number,
  ly: number,
  lz: number,
  color: number,
  size: number,
  blinkS?: number,
): void {
  const [x, y, z] = ctx.worldPoint(lx, ly, lz);
  landmarkBeacons.push(
    blinkS === undefined ? { x, y, z, color, size } : { x, y, z, color, size, blinkS },
  );
}

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
//
// Two things stop it reading. (1) three averages a cone's vertex normals AROUND
// the ring, so a 4-segment `ConeGeometry` shades as a smooth horn with no
// visible arrises — the audit called it "a near-circular-section white cone".
// `facet` flat-shades it, and the four faces come back. (2) At noon a pale
// shaft against a pale sky is invisible, so the base carries the real
// building's dark banded podium: a value anchor the eye can find the spire on.
function pyramid(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const H = 36; // real 260 m at world scale
  const cone = mesh(facet(new THREE.ConeGeometry(4.4, H, 4)), MAT.white, 0, H / 2, 0);
  cone.rotation.y = Math.PI / 4;
  g.add(cone);
  g.add(box(1.4, 14, 3, MAT.white, -3.2, 7, 0));
  g.add(box(1.4, 14, 3, MAT.white, 3.2, 7, 0));
  // Dark podium and the setback band above it.
  g.add(box(9.6, 3.4, 9.6, MAT.slate, 0, 1.7, 0, Math.PI / 4));
  g.add(box(8.4, 0.5, 8.4, MAT.steel, 0, 3.6, 0, Math.PI / 4));
  // Floor bands up the slope: a 36u blank taper is exactly the featureless
  // prism the podium alone does not solve, and the bands also give the tower a
  // sense of storeys (hence of size) from the street.
  for (let i = 1; i <= 7; i++) {
    const y = (H * i) / 8;
    const r = 4.4 * (1 - y / H) * 1.04;
    const band = cyl(r * 0.94, r, 0.4, 4, MAT.steel, 0, y, 0);
    band.rotation.y = Math.PI / 4;
    g.add(band);
  }
  g.add(cyl(0.18, 0.18, 7, 8, MAT.white, 0, H + 3, 0));
  // Aviation light on the spire — the tallest thing downtown must be findable
  // after dark, and nothing on it emitted before.
  g.add(box(0.7, 0.7, 0.7, MAT.lamp, 0, H + 6.6, 0));
  beaconAt(ctx, 0, H + 6.6, 0, 0xff5a48, 3.2, 2.4);
  return g;
}

// Shared curved curtain wall, sunshade grid, airy crown and recessed lobby.
// Original local radius4.2/height49.5 and KIT_SCALE placement remain intact.
function salesforce(): THREE.Group {
  return createSalesforceModel();
}

// Coit Tower — fluted white column on the Telegraph Hill summit (its (u,v)
// IS the hill's, so it crowns the crest). Deliberately ~1.8× real height:
// a true-scale 64 m column disappears behind North Beach's rooftops.
function coitTower(ctx: LandmarkCtx): THREE.Group {
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
  // Floodlit crown: Coit is the north-east's one navigation beacon and it went
  // fully dark at night.
  g.add(cyl(1.5, 1.5, 0.5, 12, MAT.lamp, 0, H + 4.1, 0));
  beaconAt(ctx, 0, H + 4.1, 0, 0xffe0a8, 6.5);
  beaconAt(ctx, 0, H + 1, 0, 0xffd9a0, 5);
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
  // THE CLOCK. Four faces on the stage, which is the single feature that makes
  // this building the Ferry Building rather than a long shed with a turret —
  // and it was not there. Pale dial, dark bezel, gold hands.
  const clockR = (D + 0.7) / 2 + 0.18;
  for (let f = 0; f < 4; f++) {
    // Each face is authored FLAT in local XY (dial plane = XY, thickness Z),
    // then the whole sub-group is yawed onto its elevation. Rotating the
    // primitives one by one is how clock hands end up pointing into a wall.
    const face = new THREE.Group();
    face.add(cyl(2.05, 2.05, 0.24, 16, MAT.slate, 0, 0, 0).rotateX(Math.PI / 2));
    face.add(cyl(1.72, 1.72, 0.3, 16, MAT.white, 0, 0, 0.04).rotateX(Math.PI / 2));
    face.add(box(0.16, 1.4, 0.34, MAT.gold, 0, 0.6, 0.1)); // minute hand, straight up
    face.add(box(0.9, 0.16, 0.34, MAT.gold, 0.38, 0, 0.1)); // hour hand, at three
    const yaw = (f * Math.PI) / 2;
    face.position.set(Math.sin(yaw) * clockR, shaft + 1.1, Math.cos(yaw) * clockR);
    face.rotation.y = yaw;
    g.add(face);
  }
  g.add(mesh(new THREE.ConeGeometry(D * 0.72, 1.6, 4), MAT.slate, 0, shaft + 3.0, 0));
  // The clock stage burns at night — a lit dial over the Embarcadero is the
  // waterfront's own beacon.
  beaconAt(ctx, 0, shaft + 1.1, 0, 0xffe9bc, 8);
  beaconAt(ctx, 0, shaft + 3.4, 0, 0xffd9a0, 4);
  return g;
}

// Sutro Tower — the three-pronged antenna visible from all of SF; the map's
// central orientation weenie on the saddle between Twin Peaks and Mt Sutro.
function sutroTower(ctx: LandmarkCtx): THREE.Group {
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
  // Lattice bracing between the legs. Three bare cylinders read from the road
  // beneath as ONE giant red pipe — the audit's word — because there is
  // nothing at leg-to-leg scale to say "tower". Horizontal rings plus X-braces
  // give it the openwork the real mast is entirely made of.
  const legAt = (i: number, y: number): THREE.Vector3 => {
    const a = (i / 3) * Math.PI * 2;
    const r = 3.4 + (y / H) * lean * 3.4;
    return new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  };
  for (let lvl = 0; lvl < 5; lvl++) {
    const y0 = 2 + (lvl * (H - 4)) / 5;
    const y1 = 2 + ((lvl + 1) * (H - 4)) / 5;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      g.add(strut(legAt(i, y0), legAt(j, y0), 0.14, MAT.orange, 5));
      g.add(strut(legAt(i, y0), legAt(j, y1), 0.11, MAT.orange, 5));
      g.add(strut(legAt(j, y0), legAt(i, y1), 0.11, MAT.orange, 5));
    }
  }
  // Waist platforms.
  g.add(cyl(2.9, 2.9, 0.7, 8, MAT.orange, 0, H * 0.62, 0));
  g.add(cyl(2.4, 2.4, 0.7, 8, MAT.orange, 0, H, 0));
  // Crossbar joining the prong tips.
  g.add(cyl(0.14, 0.14, 5.4, 6, MAT.white, 0, H + 13, 0));
  // Red aviation lights on the prong tips — the real tower's night read, and
  // the only thing that finds it once the haze takes the orange.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    beaconAt(ctx, Math.cos(a) * 2.2, H + 13.5, Math.sin(a) * 2.2, 0xff4436, 3.2, 2.2);
  }
  return g;
}

// Chinatown Dragon Gate — pillars + tiered pagoda roofs OVER the road.
//
// A gate spans a street; it does not stand in one. Authored on the local +X
// axis and then yawed onto the real street it straddles, with the pillars
// pushed just past the kerb so the car drives THROUGH the gate instead of
// into a red column planted on the centreline.
function dragonGate(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const [ox, oz] = ctx.origin;
  const hit = ctx.network?.nearest(ox, oz, ROAD_TILE * 2) ?? null;
  // Local +X must run ACROSS the street: that is the road's NORMAL, and the
  // group is only scaled/translated (rotDeg 0), so local axes are world axes.
  const yaw = hit ? Math.atan2(-hit.tx, -hit.tz) : 0;
  const span = ((hit ? hit.edge.half : 5) + 1.9) / KIT_SCALE;
  const gate = new THREE.Group();
  // The gate straddles the ROADWAY, so it is centred on the nearest point on
  // the street centreline — NOT on the landmark's traced (u, v). The traced
  // point sits ~7u off the centreline here, and spanning ±(half + gap) from it
  // planted one pillar exactly where the car drives.
  if (hit) gate.position.set((hit.x - ox) / KIT_SCALE, 0, (hit.z - oz) / KIT_SCALE);
  for (const sx of [-span, span]) {
    gate.add(cyl(0.45, 0.62, 5.6, 10, MAT.gateRed, sx, 2.8, 0));
    gate.add(box(1.8, 0.8, 1.8, MAT.rock, sx, 0.4, 0)); // pillar base
  }
  const W = span * 2 + 2.2;
  // Main span roof (three stacked tiers, green tile).
  gate.add(box(W, 0.5, 2.2, MAT.gateRed, 0, 5.8, 0));
  gate.add(box(W - 1.4, 0.9, 2.8, MAT.gateGreen, 0, 6.5, 0));
  gate.add(box(W * 0.57, 0.8, 2.4, MAT.gateGreen, 0, 7.6, 0));
  gate.add(box(W * 0.28, 0.9, 2.0, MAT.gateGreen, 0, 8.6, 0));
  gate.add(mesh(new THREE.SphereGeometry(0.5, 8, 6), MAT.gateRed, 0, 9.4, 0));
  gate.rotation.y = yaw;
  g.add(gate);
  return g;
}

// The Painted Ladies — Postcard Row: SIX ATTACHED Italianate Victorians with
// a shared eaves line, matching bay windows and stoops down to the pavement.
//
// This used to be `BUILDINGS_SUBURBAN[i % n]` scaled to 5.5 at a pitch of 6.4
// — detached tract houses with a ~0.9u daylight gap between every "Lady" and
// an independent random height each, i.e. the most photographed row in San
// Francisco rendered as a cul-de-sac. It is authored now, out of the landmark
// palette plus its own one paint material, because the whole point of the row
// is that it is ONE terrace: the bays line up, the cornice is level, and there
// is no gap.
// Authored in WORLD units (`scale: 1`), matched to the neighbouring fabric so
// the terrace reads as the best block on the street rather than as a monument
// dropped on it.
const PL_BAY = 8.2; // frontage per house — attached, so pitch == width
const PL_DEPTH = 9.4;
const PL_H = 12.2; // three storeys to a cornice that is LEVEL across the row

/**
 * The terrace's ONE painted-timber material. Every body colour, every picked-out
 * moulding and every accent on all six houses is a VERTEX colour on it, so the
 * whole row still collapses to a single draw call (see `landmark-geo.paint`).
 *
 * That is what buys the detail below. "Painted lady" means trim picked out FROM
 * the body colour, so the row needs three tints per house; as materials that is
 * eighteen draw calls, and the six body materials this replaces already cost
 * six. One material carrying eighteen colours is strictly cheaper than the six
 * flat pastel slabs it replaces.
 */
const PL_PAINT = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.85,
  vertexColors: true,
});
/** Admitted into `packLandmark`'s pack set — see `buildLandmarks`. The six
 *  masonry tones are shared across every monument that stands on stone, so
 *  they earn their place the same way `PL_PAINT` does. */
const PL_MATS: readonly THREE.Material[] = [PL_PAINT, ...Object.values(MASONRY)];

/**
 * Six houses, three tints each: the body, the light trim every moulding and
 * sash frame is picked out in, and a saturated accent for the doors, the garage
 * leaves, the bay aprons and the dentil course.
 *
 * The VALUE structure is identical house to house — bodies all mid, trims all
 * high, accents all low — and only the hue rotates. That is what keeps six
 * voices reading as one terrace instead of as confetti, and it is also what
 * holds the row inside the city's three-band separation (ground < buildings <
 * sky) now that it has darks in it at all.
 */
type LadyPaint = { readonly body: number; readonly trim: number; readonly accent: number };
const PL_FALLBACK: LadyPaint = { body: 0xe0c99a, trim: 0xf4ecd8, accent: 0x8e6f40 };
const PL_PALETTE: readonly LadyPaint[] = [
  { body: 0xe0c99a, trim: 0xf6efdb, accent: 0x8e6f40 }, // ochre
  { body: 0xb9cfdd, trim: 0xeef5f8, accent: 0x466274 }, // harbour blue
  { body: 0xe6bfa6, trim: 0xf9ebe0, accent: 0x9b5638 }, // terracotta
  { body: 0xc6d2ae, trim: 0xf0f4e4, accent: 0x5b7040 }, // sage
  { body: 0xdcb9c6, trim: 0xf8e8ee, accent: 0x8c4a63 }, // rose
  { body: 0xb6bcd2, trim: 0xecedf7, accent: 0x4c5478 }, // lavender
];

/** Storey lines. Level across the row — that is what makes it a terrace. */
const PL_S1 = 4.2; // top of the ground (garage/entry) storey
const PL_S2 = 8.2; // top of the first floor
const PL_FRONT = PL_DEPTH / 2; // the street elevation
const PL_REAR = -PL_DEPTH / 2; // the elevation that faces the roadway
const PL_REAR_FACE = PL_REAR - 1; // face of the squared-off rear projection
/** Top of the cornice — every roof form starts here, level across the row. */
const PL_EAVES = PL_H + 0.875;

/** A painted-timber box on the terrace's one shared material. */
function pl(
  color: number,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  yaw = 0,
): THREE.Mesh {
  return paint(box(w, h, d, PL_PAINT, x, y, z, yaw), color);
}

/**
 * A sash opening: a trim-coloured architrave slab against the wall, the pane
 * proud of it, and the two bars that make it read as a SASH rather than a hole.
 * `out` is the outward normal along z (+1 street side, −1 rear), so one helper
 * serves both elevations.
 */
function sash(
  g: THREE.Group,
  p: LadyPaint,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  out: 1 | -1,
): void {
  g.add(pl(p.trim, w + 0.55, h + 0.55, 0.26, x, y, z + out * 0.13));
  g.add(box(w, h, 0.2, MAT.glass, x, y, z + out * 0.29));
  g.add(pl(p.trim, 0.15, h, 0.24, x, y, z + out * 0.37));
  g.add(pl(p.trim, w, 0.15, 0.24, x, y + h * 0.16, z + out * 0.37));
}

/**
 * One Lady, both elevations. Attached on both sides, so everything that
 * distinguishes her from her neighbour has to happen ON the facade: an angled
 * two-storey bay over the garage, sash windows over the entry, a stoop with a
 * pedimented door, a dentilled cornice, her own roof form and her own three
 * paint tints.
 *
 * BOTH elevations, because the front alone was not enough. The audit that called
 * this row "one slab, six pastel bands, zero windows" photographed the REAR: the
 * postcard front looks across Alamo Square, which is grass, so the only side a
 * car ever passes is the back, and the back was a blank 8 × 12u panel per house.
 * A landmark whose good side faces the one direction the player cannot drive is
 * a landmark nobody sees.
 */
function paintedLady(g: THREE.Group, i: number, base: number): void {
  const cx = (i - 2.5) * PL_BAY;
  const p = PL_PALETTE[i] ?? PL_FALLBACK;
  const bayX = cx + 1.4; // the bay sits over the garage
  const entryX = cx - 2.4; // the stoop, door and sash windows

  g.add(pl(p.body, PL_BAY, PL_H, PL_DEPTH, cx, PL_H / 2, 0));
  // Basement course, carried down to the lowest ground under the row: the
  // terrace seats on the height at its own centre and Alamo Square is a hill,
  // so a course of fixed depth shows daylight at the downhill end.
  g.add(box(PL_BAY, 0.7 - base, PL_DEPTH + 0.4, MAT.slate, cx, (0.7 + base) / 2, 0));

  // Ground storey: garage bay in a moulded surround, its leaf picked out in the
  // house's accent and scored with panel lines. It used to be a flat slate
  // rectangle, i.e. a black hole punched in the pastel — the darkest thing on
  // the frontage and the least legible.
  g.add(pl(p.trim, 3.9, 3.35, 0.3, bayX, 1.85, PL_FRONT + 0.14));
  g.add(pl(p.accent, 3.2, 2.7, 0.34, bayX, 1.7, PL_FRONT + 0.26));
  for (let d = 0; d < 3; d++) {
    g.add(pl(p.trim, 2.9, 0.14, 0.4, bayX, 0.85 + d * 0.82, PL_FRONT + 0.3));
  }

  // Stoop: the long straight stair down to the pavement. Treads, newels at the
  // foot, and the door at its head — 3u of projection, which keeps it inside
  // the row's reserved footprint.
  for (let s = 0; s < 6; s++) {
    g.add(pl(p.trim, 2.3, 0.46, 0.55, entryX, 0.23 + s * 0.42, PL_FRONT + 3.05 - s * 0.5));
  }
  g.add(pl(p.trim, 2.4, 0.5, 1.2, entryX, 2.75, PL_FRONT + 0.8));
  for (const sx of [-1.15, 1.15]) {
    g.add(pl(p.trim, 0.42, 1.1, 0.42, entryX + sx, 3.25, PL_FRONT + 2.85));
  }
  // Door: the leaf in the house's accent (a coloured front door is the loudest
  // note a painted lady has), in a pilastered surround under a pediment.
  g.add(pl(p.trim, 2.4, 3.6, 0.32, entryX, 4.3, PL_FRONT + 0.16));
  g.add(pl(p.accent, 1.3, 2.5, 0.36, entryX, 3.85, PL_FRONT + 0.3));
  g.add(pl(p.trim, 1.4, 0.14, 0.4, entryX, 4.35, PL_FRONT + 0.34));
  for (const sx of [-0.95, 0.95]) {
    g.add(pl(p.trim, 0.28, 2.9, 0.34, entryX + sx, 4.15, PL_FRONT + 0.36));
  }
  g.add(pl(p.trim, 2.7, 0.42, 0.62, entryX, 5.85, PL_FRONT + 0.4));

  // The angled two-storey bay — the single element that makes a house
  // Victorian rather than a box. Front sash plus two canted cheeks, on an
  // accent apron so the projection casts a read even head-on into flat light.
  for (const sy of [PL_S1 + 2.1, PL_S2 + 2.1]) {
    g.add(pl(p.body, 2.7, 3.3, 1.8, bayX, sy, PL_FRONT + 0.9));
    sash(g, p, bayX, sy, PL_FRONT + 1.8, 2.0, 2.25, 1);
    for (const s of [-1, 1] as const) {
      // The cheek's glazed face is its −Z side, so the architrave and the pane
      // step OUT along (s·0.66, 0.75) — the same axis the pane already used,
      // just far enough to clear the 0.2u half-depth instead of sinking into it.
      g.add(pl(p.body, 1.5, 3.3, 0.4, bayX + s * 1.78, sy, PL_FRONT + 0.46, -s * 0.72));
      g.add(pl(p.trim, 1.35, 2.75, 0.22, bayX + s * 1.88, sy, PL_FRONT + 0.575, -s * 0.72));
      g.add(box(1.0, 2.25, 0.2, MAT.glass, bayX + s * 1.935, sy, PL_FRONT + 0.637, -s * 0.72));
    }
    g.add(pl(p.trim, 4.0, 0.42, 2.2, bayX, sy + 1.86, PL_FRONT + 0.8)); // bay cornice
    g.add(pl(p.accent, 3.8, 0.36, 2.1, bayX, sy - 1.78, PL_FRONT + 0.8)); // bay apron
  }

  // Sash windows over the entry, one per upper storey, with sill and lintel.
  for (const sy of [PL_S1 + 2.1, PL_S2 + 2.1]) {
    sash(g, p, entryX, sy, PL_FRONT, 1.25, 2.2, 1);
    g.add(pl(p.trim, 2.1, 0.24, 0.5, entryX, sy - 1.5, PL_FRONT + 0.3));
    g.add(pl(p.accent, 2.1, 0.26, 0.42, entryX, sy + 1.5, PL_FRONT + 0.28));
  }

  // Storey bands and the party-wall pilaster: level lines across the whole row,
  // vertical joints between the colours. Both are what hold six different
  // facades together as ONE terrace — the bands wrap the flanks and the rear,
  // so the tie survives from every side.
  for (const by of [PL_S1, PL_S2]) {
    g.add(pl(p.trim, PL_BAY, 0.34, PL_DEPTH + 0.7, cx, by, 0));
  }
  for (const s of [-1, 1] as const) {
    g.add(pl(p.trim, 0.5, PL_H, 0.55, cx + (s * PL_BAY) / 2, PL_H / 2, PL_FRONT + 0.2));
    g.add(
      pl(p.trim, 0.44, PL_H - 1.2, 0.5, cx + (s * PL_BAY) / 2, (PL_H - 1.2) / 2, PL_REAR - 0.2),
    );
  }

  // Cornice on an accent dentil course, and a plain eaves band at the back.
  // The bracket row is the detail that reads first at 60u and the last thing
  // that survives at 300u. The cornice used to be a TRIM-COLOURED box the full
  // 10.7u depth of the plan — a pale lid that turned the whole terrace into a
  // flat white slab from any elevated camera, which is every camera a driving
  // game has. It is a band at the front now; the roof above it is dark.
  g.add(pl(p.trim, PL_BAY + 0.35, 0.85, 2.4, cx, PL_H + 0.45, PL_FRONT - 0.3));
  g.add(pl(p.trim, PL_BAY, 0.5, 1.2, cx, PL_H + 0.25, PL_REAR + 0.2));
  for (let d = 0; d < 11; d++) {
    g.add(pl(p.accent, 0.34, 0.7, 0.5, cx - 3.5 + d * 0.7, PL_H - 0.35, PL_FRONT + 0.62));
  }

  // Roof: a dark deck over the plan, then one of two crowns per house, each set
  // back inside the party walls so the row keeps six separate silhouettes
  // instead of one continuous hip.
  g.add(box(PL_BAY, 0.9, PL_DEPTH + 0.2, MAT.slate, cx, PL_H + 0.35, -0.5));
  if (i % 2 === 0) {
    // False-front gable: a thin triangular pediment standing on the cornice,
    // facing the street. `scale.z` squashes the triangle's HEIGHT (local +Z
    // becomes world up after the −90° x-rotation) and `scale.y` its depth.
    const ped = mesh(
      facet(new THREE.CylinderGeometry(3.5, 3.5, 2.4, 3)),
      MAT.slate,
      cx,
      PL_EAVES + 1.09,
      PL_FRONT - 0.3,
    );
    ped.rotation.x = -Math.PI / 2;
    ped.scale.set(1, 1, 0.62);
    g.add(ped);
    // Attic light in the tympanum: without it the pediment is a dark triangle.
    g.add(pl(p.trim, 1.25, 0.95, 0.3, cx, PL_EAVES + 1.0, PL_FRONT + 0.85));
    g.add(box(0.85, 0.6, 0.24, MAT.glass, cx, PL_EAVES + 1.0, PL_FRONT + 1.0));
  } else {
    // Mansard: a TRUNCATED pyramid (a cone is a spike, and the old flat deck
    // floated 2u above its apex) with a flat deck and a front dormer.
    g.add(
      mesh(
        facet(new THREE.CylinderGeometry(1.6, 3.9, 2.4, 4)),
        MAT.slate,
        cx,
        PL_EAVES + 1.2,
        -0.5,
      ).rotateY(Math.PI / 4),
    );
    g.add(box(2.2, 0.4, 2.2, MAT.slate, cx, PL_EAVES + 2.5, -0.5));
    g.add(pl(p.trim, 1.9, 1.7, 1.1, cx, PL_EAVES + 1.1, PL_FRONT - 1.5));
    g.add(box(1.25, 1.05, 0.24, MAT.glass, cx, PL_EAVES + 1.1, PL_FRONT - 0.9));
    g.add(box(2.2, 0.3, 1.4, MAT.slate, cx, PL_EAVES + 2.0, PL_FRONT - 1.5));
  }

  // --- The rear elevation ------------------------------------------------
  // This is the side the PLAYER sees. The postcard front looks across Alamo
  // Square, which is grass, so the only roadway a car can drive is behind the
  // row — and the rear was a blank 8 × 12u panel per house. Six of them in a
  // line is the "one slab in six pastel bands with zero windows" the audit
  // photographed. A Victorian rear is PLAIN, not blank: a squared-off rear
  // projection, plain sashes in the same storey rhythm as the front, and a
  // back stair. No bays and no brackets — those stay the front's alone.
  g.add(pl(p.body, 4.6, PL_H - 1.1, 1.0, cx - 0.8, (PL_H - 1.1) / 2, PL_REAR - 0.5));
  g.add(pl(p.trim, 4.8, 0.3, 1.2, cx - 0.8, PL_H - 1.1, PL_REAR - 0.5));
  for (const sy of [PL_S1 + 2.1, PL_S2 + 2.1]) {
    sash(g, p, cx - 0.8, sy, PL_REAR_FACE, 1.1, 2.1, -1);
    sash(g, p, cx + 2.9, sy, PL_REAR, 1.0, 1.9, -1);
  }
  sash(g, p, cx + 2.9, 1.9, PL_REAR, 1.0, 1.9, -1);
  // Back door onto a landing, with the two steps down to the pavement.
  g.add(pl(p.trim, 1.9, 3.0, 0.28, cx - 0.8, 1.75, PL_REAR_FACE - 0.14));
  g.add(pl(p.accent, 1.15, 2.4, 0.3, cx - 0.8, 1.55, PL_REAR_FACE - 0.28));
  for (let s = 0; s < 2; s++) {
    g.add(pl(p.trim, 2.2, 0.34, 0.7, cx - 0.8, 0.17 + s * 0.32, PL_REAR_FACE - 0.85 + s * 0.34));
  }
}

function paintedLadies(ctx: LandmarkCtx): THREE.Group {
  const g = new THREE.Group();
  const base = lowestUnder(ctx, 3 * PL_BAY, PL_DEPTH / 2);
  for (let i = 0; i < 6; i++) paintedLady(g, i, base);
  // Party-wall chimneys, one on every division INCLUDING the two ends: seven
  // brick stacks breaking the roofline is how a real terrace reads from the
  // park, and the row had none.
  for (let i = 0; i <= 6; i++) {
    const px = (i - 3) * PL_BAY;
    g.add(box(1.0, 3.2, 1.5, MAT.brick, px, PL_EAVES + 1.6, -1.4));
    g.add(box(1.3, 0.35, 1.8, MAT.slate, px, PL_EAVES + 3.35, -1.4));
  }
  // The two end elevations face down the cross streets, so they get windows
  // too — a blank 12 × 9u gable wall is what the kit houses look like. Yawed a
  // quarter turn so the shared `sash` helper's z-normal points along ±X.
  for (const s of [-1, 1] as const) {
    const end = s < 0 ? PL_PALETTE[0] : PL_PALETTE[5];
    const p = end ?? PL_FALLBACK;
    const flank = new THREE.Group();
    flank.rotation.y = (s * Math.PI) / 2;
    for (const wy of [1.9, PL_S1 + 2.1, PL_S2 + 2.1]) {
      for (const wz of [-2.8, 0.6]) sash(flank, p, -s * wz, wy, 3 * PL_BAY, 1.0, 1.9, 1);
    }
    g.add(flank);
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
const BAY_APPROACH = -62; // furthest west the city approach may reach
// Below this much daylight under the slab the corridor is fill, not a viaduct
// (a truck is ~2.6u), so the deck stops and an abutment takes over.
const BAY_ABUTMENT_CLEAR = 4.6;
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

/**
 * Vertical room an overhead structure has to leave over drawn asphalt: the car
 * plus the 6.8u the chase camera rides above it, plus a margin. Below this the
 * camera ends up INSIDE the bridge — and the avoidClip march cannot save it,
 * because the crossing emits no Solid for the march to find.
 */
const BAY_HEADROOM = 9;

/**
 * True when a structure whose soffit is at `soffit` clears the ground under
 * the corridor at chainage `x` by the headroom rule. Only asks where the
 * corridor is actually over drawn asphalt — over water or a back lot a low
 * truss is free.
 */
function bayClears(ctx: LandmarkCtx, x: number, soffit: number): boolean {
  for (const lz of [-BAY_HALF_W, 0, BAY_HALF_W]) {
    if (!ctx.onAsphalt(x, lz, 1.5)) continue;
    if (soffit - ctx.groundAt(x, lz) < BAY_HEADROOM) return false;
  }
  return true;
}

/**
 * Deck slab + parapets + the light string, from x0 to x1 at height y.
 *
 * The crossing is a DOUBLE deck, and over the Embarcadero the lower one ran
 * 4.7u under the roadway — 5.2u over the street, which put the chase camera
 * inside it every time the player drove the waterfront. The low half of the
 * structure is therefore emitted per bay and dropped where the bay is over
 * drawn asphalt without the headroom, leaving a portal whose soffit is the
 * deck slab itself. That is what a real elevated crossing does at a street.
 */
function bayDeck(
  g: THREE.Group,
  ctx: LandmarkCtx,
  x0: number,
  x1: number,
  y: number,
  lamps: THREE.Vector3[],
): void {
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  g.add(box(len, 1.1, BAY_HALF_W * 2, MAT.steel, cx, y - 0.55, 0)); // upper deck
  for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
    g.add(box(len, 0.9, 0.35, MAT.steel, cx, y + 0.45, sz)); // parapet
  }
  const bays = Math.max(1, Math.round(len / 6));
  const bayLen = len / bays;
  for (let i = 0; i < bays; i++) {
    const bx = x0 + bayLen * (i + 0.5);
    if (bayClears(ctx, bx, y - 4.7)) {
      g.add(box(bayLen, 1.0, BAY_HALF_W * 2 - 0.6, MAT.steel, bx, y - 4.2, 0)); // lower deck
      for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
        g.add(box(bayLen, 3.4, 0.5, MAT.steel, bx, y - 2.4, sz)); // side truss
      }
      continue;
    }
    // Portal bay: the truss collapses into a fascia flush with the slab, so
    // nothing at all hangs below the deck over the street.
    for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
      g.add(box(bayLen, 1.1, 0.5, MAT.steel, bx, y - 0.55, sz));
    }
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
 * The western approach: the viaduct that carries the deck off the anchorage
 * back into the city, ON PIERS that hunt sideways for ground clear of the
 * roadway — the real viaduct straddles the streets it crosses, it does not
 * stand in them — and ending at an abutment where Rincon Hill rises to meet it.
 *
 * It used to be a PITCHED ramp running the full 48u back to BAY_APPROACH, and
 * that is geometrically impossible here: the hill stands 12.5u at the west end
 * against a 13u deck, so the last 25u of "approach" was a slab lying 0.4u
 * UNDER to 1.9u over live streets, plus a pier cross-head 1.2u lower still.
 * Measured on the drawn drape, 41 m² of Rincon Hill roadway had bridge
 * structure inside a car's height of the asphalt. The deck therefore stays
 * FLAT at deck height and simply stops where it can no longer fly.
 */
function bayApproach(g: THREE.Group, ctx: LandmarkCtx): void {
  const D = BAY_DECK_Y;
  const x1 = BAY_RAMP_TOP;
  const soffit = D - 1.1;
  // Walk west from the crossing and stop at the first station the deck no
  // longer clears the ground: that is the abutment, and west of it the
  // crossing comes out of the hill, which is what it does in the real city.
  // Abutment: the masonry the deck's west end lands on. Whether or not the
  // viaduct survives the clearance test, the deck must END on something — the
  // pitched ramp existed because a bare deck end 13u up in mid-air is worse
  // than anything else on the crossing.
  //
  // It is MASONRY, not a concrete box. This block is the "Embarcadero slab"
  // the last two audits both filed: an untextured mass standing across the
  // waterfront street, which 12 of 16 centre-grid raycasts land on from the
  // chase camera. Same coursing, cornice and staining as the anchorages it
  // belongs to (world/masonry.ts) — the whole crossing is one material.
  const abutment = (x: number): void => {
    const gy = ctx.groundAt(x - 3, 0);
    const h = Math.max(2.4, soffit - gy + 2.4);
    g.add(
      seatMasonry({
        w: 9,
        d: BAY_HALF_W * 2 + 4,
        h,
        x: x - 3.5,
        y: soffit - h,
        z: 0,
        seed: x,
        batter: 0.05,
      }),
    );
  };
  let x0 = x1;
  for (let px = x1; px >= BAY_APPROACH; px -= 2) {
    let ground = -Infinity;
    for (const lz of [-BAY_HALF_W, 0, BAY_HALF_W]) ground = Math.max(ground, ctx.groundAt(px, lz));
    if (soffit - ground < BAY_ABUTMENT_CLEAR) break;
    x0 = px;
  }
  if (x1 - x0 < 10) {
    // Nothing left to fly — the hill IS the approach, so the deck lands here.
    abutment(x1);
    return;
  }
  const slabLen = x1 - x0;
  g.add(box(slabLen, 1.1, BAY_HALF_W * 2, MAT.steel, (x0 + x1) / 2, soffit + 0.55, 0));
  for (const sz of [-BAY_HALF_W, BAY_HALF_W]) {
    g.add(box(slabLen, 0.9, 0.35, MAT.steel, (x0 + x1) / 2, D + 0.45, sz));
  }
  abutment(x0);
  for (let px = x0 + 7; px < BAY_ANCHOR_W - 12; px += 9) {
    const pz = [0, -8, 8].find((z) => !ctx.onAsphalt(px, z, 1.6));
    if (pz === undefined) continue;
    const gy = ctx.groundAt(px, pz);
    const h = soffit - gy;
    if (h < 2) continue;
    g.add(box(5, h, 5, MAT.concrete, px, gy + h / 2, pz));
    // Pier cap FLUSH with the deck: a cross-head hung below the soffit is the
    // lowest thing over the roadway and it took 1.2u off an already tight
    // clearance for nothing. The cap now lives inside the slab's own depth, so
    // the deck soffit is the whole of what passes overhead.
    g.add(box(7, 1.1, BAY_HALF_W * 2 + 2, MAT.concrete, px, soffit + 0.55, pz * 0.35));
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
  // The anchorage is a MASS ON LEGS, not a solid block to the ground. A 26u
  // cube dropped on the Rincon Hill landfall stood squarely across the
  // Embarcadero — you could not drive past the bridge, and teleporting to the
  // lane centreline put the car inside it. The real crossing straddles the
  // waterfront street; so does this one now. The block above head height is
  // unchanged; below it only the footings that clear the asphalt are emitted,
  // which opens a portal wherever the street actually runs.
  // The block's soffit — deck height, so the street runs clear underneath.
  // It did NOT: the block was authored `BAY_ANCHOR_TOP + 10 - PORTAL_Y` tall
  // about the midpoint of PORTAL_Y..BAY_ANCHOR_TOP, i.e. 21u of block hung on
  // an 11u centre, so the real soffit came out at 8.0 — five units below the
  // portal this comment promises, and the thing the chase camera was actually
  // burying itself in over the Embarcadero. Height is now the portal band.
  const PORTAL_Y = D;
  const PORTAL_H = BAY_ANCHOR_TOP - PORTAL_Y;
  // 26 × 11u of unbroken concrete right beside a street was the biggest blank
  // surface on the waterfront. It used to be given a scale by APPLIED relief —
  // steel pilaster strips down the faces and a steel cornice band — which is a
  // second material stuck onto a flat mass rather than the mass having a
  // surface. It is now coursed masonry with its own cornice profile
  // (world/masonry.ts), the same stone the Golden Gate's anchorages are cut
  // from, so the two crossings really are built out of one vocabulary instead
  // of only claiming to be. The applied strips and the band go with it — the
  // coursing and the cornice do their job.
  g.add(
    seatMasonry({
      w: 26,
      d: 26,
      h: PORTAL_H,
      x: BAY_ANCHOR_W,
      y: PORTAL_Y,
      z: 0,
      seed: 11,
      batter: 0.04,
    }),
  );
  // Stepped crown.
  g.add(
    seatMasonry({
      w: 20,
      d: 20,
      h: 4,
      x: BAY_ANCHOR_W,
      y: BAY_ANCHOR_TOP - 1,
      z: 0,
      seed: 23,
    }),
  );
  // The footing grid is pulled INSIDE the block's own footprint (±7 of a ±13
  // block): the outer ring is the part that reaches toward the waterfront
  // street, and the block above already oversails it, so a real anchorage
  // reads correctly while the kerbside stays open.
  for (let fx = -7; fx <= 7; fx += 7) {
    for (let fz = -7; fz <= 7; fz += 7) {
      const px = BAY_ANCHOR_W + fx;
      // 8u of clearance beyond the kerb: the footing must not just miss the
      // painted lane, it must leave a corridor wide enough that the CHASE
      // CAMERA does not end up inside it either — at 5u the car drove past
      // fine and the camera spent the whole pass buried in concrete.
      if (ctx.onAsphalt(px, fz, 8)) continue;
      const gy = ctx.groundAt(px, fz);
      if (gy >= PORTAL_Y - 1) continue;
      g.add(box(6, PORTAL_Y - gy, 6, MAT.concrete, px, (gy + PORTAL_Y) / 2, fz));
    }
  }
  for (const sz of [-BAY_CABLE_Z, BAY_CABLE_Z]) {
    g.add(box(7, 4, 4, MAT.steel, BAY_ANCHOR_W + 11, BAY_ANCHOR_TOP + 1, sz)); // cable saddle
  }
  bayApproach(g, ctx);
  bayDeck(g, ctx, BAY_RAMP_TOP, BAY_ANCHOR_W, D, lamps);

  // --- Western crossing: four towers, hinged on the centre anchorage ---
  bayDeck(g, ctx, BAY_ANCHOR_W, BAY_YERBA, D, lamps);
  for (const tx of [BAY_TOWER_1, BAY_TOWER_2, BAY_TOWER_3, BAY_TOWER_4]) bayTower(g, tx);
  // Centre anchorage: the block the four main cables actually pull against.
  //
  // Stepped, like the SF landfall block above it and like the Golden Gate's
  // anchorages (world/golden-gate.ts) — one 18 × 40u prism of unbroken
  // concrete standing in open water was the biggest untextured mass left on
  // the crossing, and the two bridges have to be built out of the same
  // masonry vocabulary or the city has two grammars for the same object. The
  // tiers step IN as they rise and a steel cornice marks every setback, which
  // is the whole difference between a mass and a slab at any range.
  {
    const tiers = [
      { w: 24, d: 28, top: D - 6 },
      { w: 21, d: 25, top: D + 4 },
      { w: 18, d: 22, top: D + 15 },
    ] as const;
    let base = D - 12;
    for (const t of tiers) {
      // Sized to the old steel setback band, which `masonryBlock` reproduces as
      // the outermost course of its own cornice — same silhouette, and the
      // applied band and the applied panels are both gone: a stone mass gets
      // its scale from being CUT, not from strips glued to it.
      g.add(
        seatMasonry({
          w: t.w + 0.9,
          d: t.d + 0.9,
          h: t.top - base,
          x: BAY_ANCHOR_MID,
          y: base,
          z: 0,
          seed: t.w,
        }),
      );
      base = t.top;
    }
  }

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
  bayDeck(g, ctx, BAY_YERBA, BAY_EAST_END, D, lamps);

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
function alcatraz(ctx: LandmarkCtx): THREE.Group {
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
    beaconAt(ctx, 36, 16.3, lz, 0xffd9a0, 3.4);
  }
  // THE lighthouse. An island in the middle of the bay that emits nothing
  // after dark is not a landmark — it is a hole in the water.
  beaconAt(ctx, 26, 32.2, 2, 0xfff4d6, 9, 3.4);
  // A wash on the cellhouse so the silhouette survives the night too.
  beaconAt(ctx, -3, 25.4, 0, 0xbfd0e0, 7);
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

  // FENESTRATION. The block carried zero detail on any elevation — 37 × 28 ×
  // 20u of blank cream, the largest untextured surface in the region and the
  // whole of the view at chase-cam height. Two storeys of recessed windows
  // with pilasters between them on all four elevations is the minimum that
  // makes it read as a building rather than a placeholder.
  for (let i = 0; i < 13; i++) {
    const wx = -15 + i * 2.5;
    for (const sy of [4.4, 8.4, 12.2]) {
      g.add(box(1.5, 2.4, 0.5, MAT.slate, wx, sy, 10.1));
      g.add(box(1.5, 2.4, 0.5, MAT.slate, wx, sy, -10.1));
    }
    if (i % 2 === 0) g.add(box(0.6, 12, 0.7, MAT.cream, wx + 1.25, 6.6, 10.2));
  }
  for (let i = 0; i < 7; i++) {
    const wz = -9 + i * 3;
    for (const sy of [4.4, 8.4, 12.2]) {
      g.add(box(0.5, 2.4, 1.6, MAT.slate, -18.6, sy, wz));
      g.add(box(0.5, 2.4, 1.6, MAT.slate, 18.6, sy, wz));
    }
  }

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

  // Civic floodlighting. The tallest dome in Civic Center rendered DARKER than
  // the office blocks around it after dark; a ring of uplights on the drum and
  // a lantern glow put it back at the top of the night value order.
  arc(6, 8, 0, 360, (x, z) => {
    g.add(box(0.7, 0.4, 0.7, MAT.lamp, x, 24.2, z));
    beaconAt(ctx, x, 25.4, z, 0xffe9bc, 7);
  });
  beaconAt(ctx, 0, 37, 0, 0xfff0cc, 5, 4.5);
  for (const sx of [-13, 13]) beaconAt(ctx, sx, 16, 11, 0xffdda8, 6);
  return g;
}

// --- The Marina ----------------------------------------------------------

// Palace of Fine Arts — the open rotunda and its curved colonnade. Sized
// ~1.5× real so the rotunda still reads over the Marina's rooflines.
function fitPalaceLagoon(ctx: LandmarkCtx): { x: number; z: number; scale: number } | null {
  // The original oversized ellipse crossed three streets. Fit the complete
  // water and rim together; skipping a road-facing wall would reopen the lake.
  for (const scale of [1, 0.85, 0.7, 0.55, 0.4, 0.3]) {
    for (const x of [2, -10, 14, -20, 20]) {
      for (const z of [20, 14, 26, 0, -14, -20]) {
        let clear = true;
        for (const radius of [0, 0.5, 1]) {
          for (let i = 0; i < 48; i++) {
            const angle = (i * Math.PI * 2) / 48;
            const px = x + Math.cos(angle) * 22.5 * scale * radius;
            const pz = z + Math.sin(angle) * 10.8 * scale * radius;
            if (ctx.onAsphalt(px, pz, 1.1) || Math.hypot(px, pz) < 9) clear = false;
          }
        }
        if (clear) return { x, z, scale };
      }
    }
  }
  return null;
}

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

  // The lagoon. The reflection IS the picture everybody has of this building;
  // without it the rotunda stands on a khaki apron and only half the landmark
  // is there. A shallow water disc beside the rotunda with a stone rim.
  const lagoon = fitPalaceLagoon(ctx);
  if (lagoon) {
    const lagY = lowestUnder(ctx, 22.5 * lagoon.scale, 10.8 * lagoon.scale, lagoon.x, lagoon.z);
    const rim = cyl(15, 15, 1.2, 28, MAT.rock, lagoon.x, lagY + 0.1, lagoon.z);
    rim.scale.set(1.5 * lagoon.scale, 1, 0.72 * lagoon.scale);
    g.add(rim);
    const water = cyl(13.4, 13.4, 1.2, 28, MAT.lagoon, lagoon.x, lagY + 0.34, lagoon.z);
    water.scale.set(1.5 * lagoon.scale, 1, 0.72 * lagoon.scale);
    g.add(water);
    ctx.addWaterBody({
      kind: "ellipse",
      x: lagoon.x,
      z: lagoon.z,
      y: lagY + 0.94,
      halfX: 13.4 * 1.5 * lagoon.scale,
      halfZ: 13.4 * 0.72 * lagoon.scale,
      yaw: 0,
    });
    // A visible parapet above the lagoon, rather than the old submerged rim.
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2,
        b = ((i + 1) / 48) * Math.PI * 2;
      const ax = lagoon.x + Math.cos(a) * 22.05 * lagoon.scale,
        az = lagoon.z + Math.sin(a) * 10.584 * lagoon.scale;
      const bx = lagoon.x + Math.cos(b) * 22.05 * lagoon.scale,
        bz = lagoon.z + Math.sin(b) * 10.584 * lagoon.scale;
      const x = (ax + bx) / 2,
        z = (az + bz) / 2;
      const length = Math.hypot(bx - ax, bz - az) + 0.3;
      const yaw = Math.atan2(-(bz - az), bx - ax);
      g.add(box(length, 2, 0.65, MAT.rock, x, lagY + 1.5, z, yaw));
      ctx.addWaterWall({
        minX: x - length / 2,
        maxX: x + length / 2,
        minZ: z - 0.325,
        maxZ: z + 0.325,
        minY: lagY + 0.5,
        maxY: lagY + 2.5,
        yaw,
      });
    }
  }

  // The two colonnade arcs sweeping away from the rotunda, each capped by a
  // pergola beam running column to column.
  //
  // Every piece is tested against the drawn asphalt first. The arcs sweep out
  // to r = 26 and the Marina boulevard clips the north one — the audit found
  // 102 column vertices inside a live travel lane, one of them effectively on
  // the centreline with a lane arrow painted beside its base. A colonnade is
  // set dressing; where the street won, the street wins.
  for (const deg0 of [46, 226]) {
    arc(9, 26, deg0, 88, (x, z, yaw) => {
      if (ctx.onAsphalt(x, z, 2.2)) return;
      g.add(cyl(0.85, 1, 8.6, 8, MAT.cream, x, 4.3, z));
      g.add(box(2.6, 1.1, 2.6, MAT.cream, x, 9.2, z, yaw)); // capital
      g.add(box(5.4, 0.9, 1.4, MAT.cream, x, 10.1, z, yaw)); // pergola beam
    });
  }
  // Uplights at the peristyle feet, which is how the real rotunda reads after
  // dark and what makes the new lagoon carry a reflection.
  arc(6, 11, 0, 360, (x, z) => {
    g.add(box(0.6, 0.35, 0.6, MAT.lamp, x, 1.4, z));
    beaconAt(ctx, x, 2.4, z, 0xffdca6, 8);
  });
  beaconAt(ctx, 0, 18, 0, 0xffe6c0, 6);
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
  // Retaining drum in concrete, but the TERRACE is warm stone with a red-tile
  // compass inlay. A flat mid-grey disc with a grey parapet was the whole
  // destination for the map's signature climb and read as an unfinished car
  // park; the deck the player parks on has to be worth arriving at.
  g.add(cyl(R, R + 1.4, 12, 24, MAT.concrete, 0, top - 6, 0));
  g.add(cyl(R - 0.6, R - 0.6, 0.5, 24, MAT.cream, 0, top + 0.2, 0)); // paving
  g.add(cyl(4.6, 4.6, 0.56, 24, MAT.brick, 0, top + 0.26, 0)); // compass inlay
  g.add(cyl(1.5, 1.5, 0.62, 16, MAT.gold, 0, top + 0.3, 0));
  for (let i = 0; i < 4; i++) {
    g.add(box(0.5, 0.62, 8.6, MAT.cream, 0, top + 0.28, 0, (i * Math.PI) / 4));
  }

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
    beaconAt(ctx, px, top + 5.2, pz, 0xffd9a0, 3.6, undefined);
  }
  // Guard rail across the SOUTH entry gap — the one stretch of rim the parapet
  // deliberately leaves open — so the terrace is enclosed without walling off
  // the approach.
  arc(6, R - 0.2, 150, 60, (x, z, yaw) => {
    g.add(cyl(0.1, 0.12, 1.1, 5, MAT.steel, x, top + 0.75, z));
    g.add(box(2.6, 0.12, 0.12, MAT.steel, x, top + 1.25, z, yaw));
  });
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
  // The DIMPLED, PERFORATED copper skin is the de Young's entire identity, and
  // the block was shipping as a flat brown prism with no surface treatment
  // whatsoever — the audit could not tell it was a museum. Horizontal seams
  // plus a punched window rhythm give the cladding a scale to read at.
  for (const sy of [1.9, 4.0, 6.1]) {
    for (const sz of [-9.1, 9.1]) g.add(box(34.2, 0.34, 0.5, MAT.slate, 0, sy, sz));
    for (const sx of [-17.1, 17.1]) g.add(box(0.5, 0.34, 18.2, MAT.slate, sx, sy, 0));
  }
  for (let i = 0; i < 11; i++) {
    const wx = -15 + i * 3;
    g.add(box(1.5, 1.3, 0.5, MAT.glass, wx, 5.2, 9.15));
    g.add(box(1.5, 1.3, 0.5, MAT.glass, wx, 5.2, -9.15));
  }
  // Sculpture-garden lighting; the museum was a black cutout after dark.
  for (const sx of [-14, 0, 14]) beaconAt(ctx, sx, 2.2, 11.5, 0xffdca6, 5.4);
  beaconAt(ctx, 21.4, 31.5, -3, 0xd9e4ee, 6);
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
  // A glasshouse lit from inside — the cheapest, most legible night read any
  // of the park landmarks can have.
  beaconAt(ctx, 0, 7, 0, 0xd8f0e0, 9);
  for (const sx of [-10.5, 10.5]) beaconAt(ctx, sx, 4, 0, 0xd8f0e0, 6);
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
  // Warm cap lantern: the windmills went completely black at night, and out at
  // the ocean end of the park they are the only thing to steer by.
  g.add(box(0.6, 0.6, 0.6, MAT.lamp, 0, H + 3.4, 0));
  beaconAt(ctx, 0, H + 3.4, 0, 0xffdca6, 6, 5);
  beaconAt(ctx, 0, H * 0.5, 0, 0xffd0a0, 6);
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
  beaconAt(ctx, -6, 21.2, 4, 0xfff0cc, 6, 4);
  beaconAt(ctx, 0, 15, -6, 0xffdca6, 6);

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
    for (const side of [-1, 1]) {
      ctx.addWaterWall({
        minX: bx - bw / 2,
        maxX: bx + bw / 2,
        minZ: bz + (side * bd) / 2 - 0.35,
        maxZ: bz + (side * bd) / 2 + 0.35,
        minY: y - 0.9,
        maxY: y + 0.9,
      });
      ctx.addWaterWall({
        minX: bx + (side * bw) / 2 - 0.35,
        maxX: bx + (side * bw) / 2 + 0.35,
        minZ: bz - bd / 2,
        maxZ: bz + bd / 2,
        minY: y - 0.9,
        maxY: y + 0.9,
      });
    }
    // The basins are FLOODED — they are tidal pools, not foundations. Empty
    // rectangles lying on a lawn is exactly why the ruin read as a building
    // site rather than as Sutro Baths.
    g.add(box(bw - 0.9, 1.2, bd - 0.9, MAT.lagoon, bx, y - 0.1, bz));
    ctx.addWaterBody({
      kind: "rectangle",
      x: bx,
      z: bz,
      y: y + 0.5,
      halfX: (bw - 0.9) / 2,
      halfZ: (bd - 0.9) / 2,
      yaw: 0,
    });
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
  beaconAt(ctx, OUT - 3, 2.4 + H + 6.2, -OUT + 3, 0xfff0cc, 6, 3.8);
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
  const off = (hit ? hit.edge.half : 5) + 3.2; // bed centres flank the roadway
  const yaw = Math.atan2(-tz, tx);
  /** Landmark-local point at (along-street, across-street). */
  const at = (s: number, lat: number): readonly [number, number] => [
    tx * s - tz * lat,
    tz * s + tx * lat,
  ];
  // The block is dressed on BOTH flanks at EVERY station. It used to alternate
  // sides — one bed every 5.8u, half of them dropped by the asphalt guard —
  // so what survived was a handful of red-and-green crates scattered over an
  // otherwise bare block, and a driver had no way to know a landmark was
  // there. Continuous planting either side of the roadway, with the hairpin
  // wall zig-zagging between the beds, is the read.
  for (let i = 0; i < BEDS; i++) {
    const s = -RUN / 2 + (RUN * (i + 0.5)) / BEDS;
    for (const side of [-1, 1] as const) {
      const [x, z] = at(s, off * side);
      if (ctx.onAsphalt(x, z, 0.8)) continue;
      const y = ctx.groundAt(x, z);
      // rotation.y maps local +X to (cos, -sin) in (x, z) — aims it along the tangent.
      g.add(box(5.4, 1.7, 4.4, MAT.brick, x, y + 0.85, z, yaw)); // retaining planter
      g.add(box(4.8, 1.5, 3.8, MAT.hedge, x, y + 2.4, z, yaw));
      // Every other bed carries a bloom of colour — the block is famous for
      // the hydrangeas as much as for the bends.
      if (i % 2 === 0) {
        g.add(box(2.6, 0.35, 2.0, MAT.bloom, x, y + 3.15, z, yaw));
      }
      // Switchback kerb: a brick wall angling in toward the roadway, flipping
      // its lean every bed. That alternation IS the crooked read.
      const [mx, mz] = at(s + RUN / BEDS / 2, off * side * 0.62);
      if (ctx.onAsphalt(mx, mz, 0.8)) continue;
      g.add(
        box(
          1.2,
          1.6,
          6.4,
          MAT.brick,
          mx,
          ctx.groundAt(mx, mz) + 0.8,
          mz,
          yaw + side * (i % 2 === 0 ? 0.7 : -0.7),
        ),
      );
    }
  }
  // Kerb walls closing the block at both ends — on the FLANKS. Sitting them on
  // the tangent put them at lateral offset 0, i.e. on the centreline, so the
  // asphalt guard dropped both of them every single build.
  for (const end of [-1, 1] as const) {
    for (const side of [-1, 1] as const) {
      const [x, z] = at((end * RUN) / 2 + end * 3, off * side);
      if (ctx.onAsphalt(x, z, 0.8)) continue;
      g.add(box(2.6, 2.6, 8, MAT.brick, x, ctx.groundAt(x, z) + 1.3, z, yaw));
      // Lamp on the block's corners, so it is findable at night as well.
      g.add(cyl(0.14, 0.2, 4.4, 6, MAT.steel, x, ctx.groundAt(x, z) + 4.8, z));
      g.add(box(0.55, 0.55, 0.55, MAT.lamp, x, ctx.groundAt(x, z) + 7.2, z));
      beaconAt(ctx, x, ctx.groundAt(x, z) + 7.2, z, 0xffd9a0, 3.4);
    }
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
  paintedladies: { build: paintedLadies, seat: "ground", scale: 1 },
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
  // rotDeg 270 turns the FRONTAGE toward Alamo Square (the parkGreen column
  // below is one cell WEST): the whole point of Postcard Row is the view from
  // the park, and at 90° every visitor got the blank rear elevation.
  {
    kind: "paintedladies",
    name: "the Painted Ladies",
    u: 0.513,
    v: 0.33,
    rotDeg: 270,
    protHalf: [9, 26],
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
    // The terrace itself is R = 13, so a 15u half-extent left the outer ring of
    // paving unreserved and park vegetation grew up through the deck.
    protHalf: [17, 17],
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
  // Fort Point is only Fort Point because it sits DIRECTLY UNDER the Golden
  // Gate's south end, ON THE SHORE — that is the whole postcard. It was sited
  // on the OLD Presidio coast (v 0.0475); widening the strait moved the
  // waterline ~200u south and left the fort standing out in open water, a
  // brick Alcatraz under the span. v 0.107 is the new shore (the waterline is
  // v 0.1013 on this column), so the north face meets the water like the real
  // fort, and u 0.335 puts it 23u west of the deck axis (u 0.3422) — the span
  // passes overhead instead of beside it.
  {
    kind: "fortpoint",
    name: "Fort Point",
    u: 0.335,
    v: 0.107,
    rotDeg: 0,
    clearR: 14,
    protHalf: [17, 16],
  },
  // The measured centroid. DEPENDS ON the China Basin water polygon replacing
  // the old box — until it lands, this site is inside the flooded rect.
  // `clearR` must be the park's OWN footprint, not a token nudge: at 14 the
  // resolve pass was satisfied while 19u of a 33 × 29u ballpark still lay over
  // the roadway, so the car spawned inside the plinth and the chase view was a
  // blank 8u retaining wall.
  {
    kind: "oraclepark",
    name: "Oracle Park",
    u: 0.7838,
    v: 0.3115,
    rotDeg: 0,
    clearR: 31,
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
  // Vector asphalt runs THROUGH lot cells at diagonals and across wide
  // junctions, so "the cell is not a road cell" is not enough to prove a
  // collision box is out of the roadway — the Bay Bridge anchorage's
  // reservation reached 7u into the Embarcadero on cells the raster called
  // lot. Every emitted box is tested against the drawn centreline as well.
  const inRoadway = (minX: number, maxX: number, minZ: number, maxZ: number): boolean => {
    if (!network) return false;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    for (const [px, pz] of [
      [cx, cz],
      [minX, minZ],
      [maxX, minZ],
      [minX, maxZ],
      [maxX, maxZ],
    ] as const) {
      const hit = network.nearest(px, pz, ROAD_TILE * 1.6);
      if (hit && hit.dist < hit.edge.half + 0.4) return true;
    }
    return false;
  };

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
        const bx0 = Math.max(minX, cMinX);
        const bx1 = Math.min(maxX, cMinX + ROAD_TILE);
        const bz0 = Math.max(minZ, cMinZ);
        const bz1 = Math.min(maxZ, cMinZ + ROAD_TILE);
        if (inRoadway(bx0, bx1, bz0, bz1)) continue;
        // NOT a degenerate-box guard, deliberately. The one entry the
        // "invisible landmark box in the roadway" ratchet reports was read as
        // a zero-DEPTH clamp artifact; it is not — measured over all 127
        // reservation boxes it is 11.2 × 13.0u at u0.5141 v0.3375 (the Alamo
        // Square block), a whole cell of a real reservation whose edge lands
        // 1.6u inside the drawn asphalt, and the thinnest box the clamp ever
        // produces is 0.2u. Fixing that entry means moving the reservation,
        // not filtering the output.
        solids.push({ minX: bx0, maxX: bx1, minZ: bz0, maxZ: bz1 });
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

  // Alamo Square green faces the Painted Ladies. It is a whole BLOCK in the
  // real city and was one cell column here, so the postcard view — the row
  // seen across the park, which is the only reason the row is famous — was
  // taken by a kit house standing 15u off the terrace's front door. Two
  // columns × five rows is the real square at this cell size.
  {
    const gx = gxOf(0.513);
    const gz = gzOf(0.33);
    for (let dx = 1; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) parkGreen.add(cellKey(gx - dx, gz + dz));
    }
  }

  return { reserved, parkGreen, solids };
}

export function buildLandmarks(
  terrain: Terrain,
  cache: ModelCache,
  network: RoadNetwork | null = null,
  collectWaterWall?: (solid: Solid) => void,
  collectWaterBody?: (body: WaterBody) => void,
): THREE.Group {
  const root = new THREE.Group();
  const rng = new Rng(4242);
  landmarkBeacons = [];
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
      addWaterWall: (wall) => {
        const [wx, wz] = worldOf((wall.minX + wall.maxX) / 2, (wall.minZ + wall.maxZ) / 2);
        const hx = ((wall.maxX - wall.minX) * s) / 2,
          hz = ((wall.maxZ - wall.minZ) * s) / 2;
        collectWaterWall?.({
          minX: wx - hx,
          maxX: wx + hx,
          minZ: wz - hz,
          maxZ: wz + hz,
          minY: y + wall.minY * s,
          maxY: y + wall.maxY * s,
          yaw: rot + (wall.yaw ?? 0),
        });
      },
      addWaterBody: (body) => {
        const [wx, wz] = worldOf(body.x, body.z);
        collectWaterBody?.({
          ...body,
          x: wx,
          z: wz,
          y: y + body.y * s,
          halfX: body.halfX * s,
          halfZ: body.halfZ * s,
          yaw: rot + body.yaw,
        });
      },
    };
    const node = packLandmark(def.build(ctx), PL_MATS);
    node.position.set(x, y, z);
    node.rotation.y = rot;
    node.scale.multiplyScalar(s);
    root.add(node);
  }
  registerBeacons("landmarks", landmarkBeacons);
  return root;
}
