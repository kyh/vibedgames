import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { BRIDGE_PILLAR_WIDE, modelUrl, PARK_TREES, ROAD_BRIDGE } from "../assets/manifest";
import type { Beacon } from "../fx/beacon-lights";
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
// The real towers stand 227 m above the water, which at this map's 4.45 m/u is
// 51u — so 44u above a 7u deck. The old 26u put the tops at 33u/147 m and the
// bridge lost its silhouette from anywhere in the city: a red bar with two
// stubs on it. Height is the whole reason this thing is a navigation beacon.
const TOWER_H = 44;
const LAMP_H = 2.4; // parapet lamp head above the deck
// Cable plane / tower leg centres: outboard of the carriageway, so the deck
// runs BETWEEN the legs the way it does through the real portals.
const LEG_OFF = 2.6;
const LEG_BASE = 3.6; // leg section at the deck
const LEG_TOP = 2.1; // leg section at the saddle
const LEG_BASE_Y = -7; // a footing under the waterline, not a leg in mid-air
/** Leg section width at t, 0 = footing, 1 = saddle. */
const legWidthAt = (t: number): number => THREE.MathUtils.lerp(LEG_BASE, LEG_TOP, t);
// Art-deco setbacks up each leg. FOUR, not six: city.ts gives an instance a
// long-range box imposter only when it stands 13u or more, and a leg cut into
// six 9.7u sections drops out of the skyline at the 700u model band — from
// downtown the bridge is 1200u away, which is exactly the read this pass
// exists to buy. Four 14.5u sections keep the imposter AND the stepped
// silhouette; the ledges and the portal bracing carry the fine articulation.
const TOWER_STEPS = 4;
// Main-span sag, expressed as the cable's height above the deck at midspan.
// The read everyone knows is the cable sweeping all the way DOWN to the
// roadway at centre span and back up to the tower tops; a shallow arc is a
// gantry with a wire on it.
const CABLE_LOW = 5;
// Hunt for the shore anchor around u≈0.25 (map fractions, not world units —
// the map rescales).
const APPROACH_U_MIN = 0.19;
const APPROACH_U_MAX = 0.35;

const ORANGE = new THREE.MeshStandardMaterial({ color: 0xc0362c, roughness: 0.6 });
const RAIL_ORANGE = new THREE.MeshStandardMaterial({ color: 0xa93227, roughness: 0.7 });
// Tower marker lights are light SOURCES, not lit surfaces: unlit and
// untonemapped, like the traffic signals, so they survive the night grade. The
// beacon sprites give the halo; these give the tower its own dotted structure
// after dark, which is what stopped it reading as a black stick over a lit deck.
const TOWER_LAMP = new THREE.MeshBasicMaterial({ color: 0xffd9a0, toneMapped: false });

// Deterministic 0..1 jitter (world gen must not consume Math.random).
const jit = (i: number, k: number): number => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Everything the placement solve needs — no model cache, so it is callable
 * from the baked-bin load path where no geometry is being built. */
export type GoldenGatePlanCtx = {
  readonly plan: CityPlan;
  readonly terrain: Terrain;
  readonly worldX: (gx: number) => number;
  readonly worldZ: (gz: number) => number;
};

export type GoldenGateCtx = GoldenGatePlanCtx & {
  readonly cache: ModelCache;
};

export type GoldenGateResult = {
  readonly objects: THREE.Object3D[];
  readonly solids: Solid[];
  readonly decks: readonly SurfaceDeck[];
  readonly openWaterCells: ReadonlySet<string>;
};

// The geometry-free half of the bridge: where it starts, how high it runs and
// where it lands. Split out because the MESHES are baked into the world bins
// (buildGoldenGate only runs on a cold generation) while the night lights are
// runtime-only and must be published on BOTH load paths — see city.ts.
export type GoldenGatePlan = {
  readonly ax: number;
  readonly anchorGx: number;
  readonly anchorGz: number;
  readonly shoreZ: number;
  readonly shoreH: number;
  readonly endZ: number;
  readonly rampLen: number;
  readonly rampTopZ: number;
  readonly kneeZ: number;
  readonly kneeY: number;
  readonly deckY: number;
  readonly half: number;
  readonly landfallZ: number | null;
  readonly northEndZ: number;
  readonly railMinZ: number;
  readonly railMaxZ: number;
  /** North (Marin) tower. */
  readonly towerZ: number;
  /** South (Presidio) tower — the pair is what makes the bridge readable. */
  readonly towerZ2: number;
  readonly topY: number;
};

// The plan the world last solved, published for RUNTIME-ONLY consumers.
//
// `buildGoldenGate` runs on a cold generation only — the meshes live in
// rest.bin — so nothing on the normal load path can ask the builder anything.
// What BOTH paths do call is `goldenGatePlan` (city.ts lightGoldenGate), so the
// solve itself is the seam: it records its answer here and the long-range
// silhouette (render/far-terrain.ts) picks it up on its next frame. Publishing
// from inside the gen-only builder instead would give the far read to exactly
// one of the two load paths — i.e. to nobody who plays the shipped game.
let solvedPlan: GoldenGatePlan | null = null;

/** The bridge as the running world placed it, or null before the world loads. */
export function goldenGateSolvedPlan(): GoldenGatePlan | null {
  return solvedPlan;
}

/** Height along the two-stage ramp, t = 0 at the shore, 1 at the deck. */
function rampProfile(plan: GoldenGatePlan, t: number): number {
  const tc = THREE.MathUtils.clamp(t, 0, 1);
  return tc < 0.68
    ? THREE.MathUtils.lerp(plan.shoreH, plan.kneeY, tc / 0.68)
    : THREE.MathUtils.lerp(plan.kneeY, plan.deckY, (tc - 0.68) / 0.32);
}

/**
 * Main-cable saddles from the south anchorage to the north one, as
 * `[z, y, sag to the NEXT saddle]`. A suspension cable is a chain of PARABOLAS
 * hung between fixed saddles — it rises to each tower top and sags between
 * them. Sampling a spline through a handful of loose control points instead
 * (what this used to do) both overshoots the saddles and, on the side spans,
 * dives UNDER the roadway on its way to a low anchorage: the audit measured
 * ~20u of cable running below the deck it is supposed to be carrying.
 */
function cableSaddles(plan: GoldenGatePlan): readonly (readonly [number, number, number])[] {
  const main = plan.towerZ2 - plan.towerZ; // north is −Z, so this is positive
  return [
    // South anchorage: on TOP of the shore block, above deck height, so the
    // side span climbs from the anchorage to the tower and never dips under.
    [plan.shoreZ + 3, plan.deckY + 4.6, 2.6],
    [plan.towerZ2, plan.topY, plan.topY - (plan.deckY + CABLE_LOW)],
    [plan.towerZ, plan.topY, 2.4],
    [plan.northEndZ - 14, Math.max(plan.deckY + 7, plan.topY - main * 0.24), 0],
  ] as const;
}

/** Cable height at a chainage, or null off the ends of the cable. */
function cableY(saddles: readonly (readonly [number, number, number])[], z: number): number | null {
  for (let i = 0; i < saddles.length - 1; i++) {
    const a = saddles[i];
    const b = saddles[i + 1];
    if (!a || !b) continue;
    const [az, ay, sag] = a;
    const [bz, by] = b;
    if (z > az || z < bz) continue; // saddles run south → north, i.e. z falling
    const t = (az - z) / (az - bz);
    return ay + (by - ay) * t - 4 * sag * t * (1 - t);
  }
  return null;
}

/**
 * Solve the bridge's placement. Cheap — one grid scan plus arithmetic, no
 * meshes — so both the cold-gen path and the baked-bin path can call it.
 * Null when the Presidio coast road the ramp needs does not exist.
 */
export function goldenGatePlan(ctx: GoldenGatePlanCtx): GoldenGatePlan | null {
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
  if (!anchor) {
    solvedPlan = null;
    return null;
  }

  const ax = ctx.worldX(anchor.gx);
  const shoreZ = ctx.worldZ(anchor.gz);
  const shoreH = ctx.terrain.heightAt(ax, shoreZ) + 0.04;
  const endZ = -WORLD_HALF_Z + 3.5; // fallback dead-end just inside the border wall
  // Fit the ramp to the water span actually available; cap the climb at ~20°.
  const span = shoreZ - endZ;
  const rampLen = THREE.MathUtils.clamp(span * 0.6, 10, RAMP_LEN);
  const deckY = Math.min(DECK_Y, shoreH + rampLen * 0.36);
  const rampTopZ = shoreZ - rampLen; // north = -Z
  // Two-stage ramp (steep, then a gentle crown) so cresting onto the deck at
  // speed pops a small hop instead of launching you into the end barrier.
  const kneeZ = shoreZ - rampLen * 0.68;
  const kneeY = shoreH + (deckY - shoreH) * 0.8;

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
  // With a Marin landfall the tower stands in the water just off the headland
  // (where the real north tower lives); the fallback keeps it near the border.
  const towerZ = landfallZ !== null ? Math.min(landfallZ + 18, rampTopZ - 10) : -WORLD_HALF_Z + 14;
  // The SOUTH tower. A suspension bridge with one portal is a gantry: the
  // shape everybody recognises is TWO towers with the main span slung between
  // them, and the audit's vertex scan proved we were shipping one. It stands
  // in the water off the Presidio shore (where the real south tower is), one
  // seventh of the way out so the MAIN SPAN is the long one, and it is kept at
  // least 30u off the north tower so the pair never degenerates into a portal.
  const towerZ2 = Math.min(
    rampTopZ - 8,
    Math.max(towerZ + 30, rampTopZ - (rampTopZ - towerZ) * 0.14),
  );

  solvedPlan = {
    ax,
    anchorGx: anchor.gx,
    anchorGz: anchor.gz,
    shoreZ,
    shoreH,
    endZ,
    rampLen,
    rampTopZ,
    kneeZ,
    kneeY,
    deckY,
    half: DECK_W / 2,
    landfallZ,
    northEndZ,
    railMinZ: landfallZ !== null ? landfallZ - 1 : endZ,
    railMaxZ: shoreZ - 1,
    towerZ,
    towerZ2,
    topY: deckY + TOWER_H,
  };
  return solvedPlan;
}

// Parapet lamp stations, one entry per post: both sides of the deck, spaced
// ~11u along the run. The beacons and the baked fixtures are both derived from
// this, so a halo can never end up without a post under it.
function lampStations(plan: GoldenGatePlan): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  const span = plan.railMaxZ - plan.railMinZ;
  const n = Math.max(2, Math.round(span / 11));
  for (let i = 0; i < n; i++) {
    const lz = plan.railMaxZ - (span * (i + 0.5)) / n;
    const ly =
      lz > plan.rampTopZ ? rampProfile(plan, (plan.shoreZ - lz) / plan.rampLen) : plan.deckY;
    for (const sx of [-(plan.half + RAIL_T / 2), plan.half + RAIL_T / 2]) {
      out.push({ x: plan.ax + sx, y: ly, z: lz });
    }
  }
  return out;
}

/**
 * Night lights for the bridge — warm deck string plus red aviation beacons on
 * the tower tops. Same colours as the Bay Bridge (landmarks.ts) so the two
 * crossings read as one city after dark.
 */
export function goldenGateBeacons(plan: GoldenGatePlan): readonly Beacon[] {
  const beacons: Beacon[] = [];
  for (const tz of [plan.towerZ, plan.towerZ2]) {
    for (const sx of [-(plan.half + LEG_OFF), plan.half + LEG_OFF]) {
      beacons.push({
        x: plan.ax + sx,
        y: plan.topY + 1.6,
        z: tz,
        color: 0xff4436,
        size: 3.4,
        blinkS: 2.6,
      });
      // Tower floodlighting. The audit's night pass found the deck string lit
      // and the towers matte black above it, so the bridge read as a dotted
      // line with a dark stick on it. A warm wash at each portal beam gives
      // the pair their own silhouette after dark — spaced up the whole 44u
      // leg, so the taller tower does not go dark above the third brace.
      for (let i = 1; i <= 4; i++) {
        const wy = plan.deckY + (TOWER_H * i) / 4.6;
        beacons.push({ x: plan.ax + sx, y: wy, z: tz, color: 0xffb066, size: 5.2 });
      }
    }
  }
  for (const st of lampStations(plan)) {
    beacons.push({
      x: st.x,
      y: st.y + LAMP_H,
      z: st.z,
      color: 0xffd9a0,
      size: 2.1,
      groundY: st.y + 0.05,
    });
  }
  return beacons;
}

/** One member of the long-range silhouette: a segment with a half-thickness. */
export type SilhouetteBar = {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly halfA: number;
  readonly halfB: number;
  /**
   * Share of the minimum SCREEN width this member holds at range (1 = a tower
   * leg). Not every member is worth the same number of pixels: give the deck
   * chords a tower's floor and the two of them fuse into a slab three times the
   * truss's real depth, and the crossing reads as a luggage handle. The tower
   * carries the silhouette, so it holds the most.
   */
  readonly minScale: number;
};

// How much thinner the stand-in is than the member it stands for. The whole
// hand-off rests on this: a bar that lives strictly INSIDE the real geometry is
// covered by it exactly, so the silhouette can be drawn at EVERY distance and
// still be invisible until the LOD has thrown the real member away. Nothing
// switches on, so nothing can pop.
const SIL_INSET = 0.8;

/**
 * The bridge reduced to ~70 bars — both towers, their portal bracing, the deck
 * truss chords and the two main cables — for the long-range silhouette that
 * render/far-terrain.ts draws. Data only: no meshes, no model cache, so the
 * baked load path (where `buildGoldenGate` never runs) can build it too.
 *
 * Why it exists: past DETAIL_DISTANCE the city keeps a box imposter only for
 * instances 13u or taller, which on this bridge is the four tower legs and
 * nothing else. The cables, the truss, the deck and the bracing are all gone by
 * 440u — measured at 700u the crossing is four orange sticks with no form, at
 * 1200u a grey smudge, at 2000u nothing. A landmark you steer by cannot be the
 * one thing that disappears from the far half of the map.
 */
export function goldenGateSilhouette(plan: GoldenGatePlan): readonly SilhouetteBar[] {
  const bars: SilhouetteBar[] = [];
  const add = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    minScale: number,
    halfA: number,
    halfB = halfA,
  ): void => {
    bars.push({ a, b, halfA: halfA * SIL_INSET, halfB: halfB * SIL_INSET, minScale });
  };
  const legX = plan.half + LEG_OFF;
  const legHalf = (y: number): number =>
    legWidthAt(THREE.MathUtils.clamp((y - LEG_BASE_Y) / (plan.topY - LEG_BASE_Y), 0, 1)) / 2;

  // Two bars per leg, so the art-deco taper survives the reduction: one
  // straight column from footing to saddle would read fatter at the top than
  // the tower it stands in, and poke out of it at close range.
  const kneeY = plan.deckY + (plan.topY - plan.deckY) * 0.45;
  for (const tz of [plan.towerZ, plan.towerZ2]) {
    for (const sx of [-legX, legX]) {
      const x = plan.ax + sx;
      add(
        new THREE.Vector3(x, 0, tz),
        new THREE.Vector3(x, kneeY, tz),
        1,
        legHalf(0),
        legHalf(kneeY),
      );
      add(
        new THREE.Vector3(x, kneeY, tz),
        // Stops SHORT of the saddle top: the ribbon runs on past its endpoint
        // by its own half-width to close the joints, and at close range that
        // overshoot was the one part of the stand-in visible over the real
        // tower — a brighter cap on each saddle, ~170 pixels at 300u.
        new THREE.Vector3(x, plan.topY + 0.4, tz),
        1,
        legHalf(kneeY),
        legHalf(plan.topY),
      );
    }
    // Portal bracing: the rungs between the legs. Invisible broadside (the legs
    // hide them) and the whole difference between a tower and two sticks when
    // the crossing is seen end-on, which is exactly how it looks from the city.
    for (let i = 0; i < 3; i++) {
      const by = THREE.MathUtils.lerp(plan.deckY + 8, plan.topY - 3.4, i / 2);
      add(
        new THREE.Vector3(plan.ax - legX, by, tz),
        new THREE.Vector3(plan.ax + legX, by, tz),
        0.5,
        0.75,
      );
    }
  }

  // Deck: the two truss chords, which are the orange the deck reads as. They
  // thicken into one band at range, which is the correct far read — the truss
  // web between them is below a pixel long before that. Both ends are pulled in
  // by more than the ribbon's own end-cap, for the same reason the legs stop
  // under the saddle.
  const trussZ0 = plan.northEndZ - 1.4;
  const trussZ1 = plan.rampTopZ - 0.6;
  for (const sx of [-(plan.half + RAIL_T / 2), plan.half + RAIL_T / 2]) {
    for (const cy of [plan.deckY - 0.55, plan.deckY - 2.85]) {
      add(
        new THREE.Vector3(plan.ax + sx, cy, trussZ0),
        new THREE.Vector3(plan.ax + sx, cy, trussZ1),
        0.42,
        0.4,
      );
    }
  }

  // Main cables, sampled off the same saddles the built cable hangs from. The
  // sag is the read everyone recognises; a straight line between tower tops
  // would be a gantry.
  const saddles = cableSaddles(plan);
  const z0 = saddles[0]?.[0] ?? plan.shoreZ;
  const z1 = saddles[saddles.length - 1]?.[0] ?? plan.northEndZ;
  // 40 steps, not 26, and a thinner bar than the cable it stands in. A chord
  // across a sagging cable lies ABOVE the arc — coarsely sampled, the stand-in
  // rose ~0.1u out of the top of the real cable and drew a brighter red edge
  // along the whole curve at 300u. Deviation falls as 1/steps².
  const steps = 40;
  for (const sx of [-legX, legX]) {
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= steps; i++) {
      const cz = z0 - ((z0 - z1) * i) / steps;
      const cy = cableY(saddles, cz);
      if (cy === null) {
        prev = null;
        continue;
      }
      const p = new THREE.Vector3(plan.ax + sx, cy, cz);
      if (prev) add(prev, p, 0.5, 0.14);
      prev = p;
    }
  }
  return bars;
}

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

  const plan = goldenGatePlan(ctx);
  if (!plan) return { objects, solids, decks, openWaterCells };
  const {
    ax,
    shoreZ,
    shoreH,
    endZ,
    rampLen,
    rampTopZ,
    kneeZ,
    kneeY,
    deckY,
    half,
    landfallZ,
    northEndZ,
    railMinZ,
    railMaxZ,
    towerZ,
    towerZ2,
    topY,
  } = plan;

  // --- Drivable surface ---
  decks.push({ minX: ax - half, maxX: ax + half, minZ: kneeZ, maxZ: shoreZ, y: kneeY, y2: shoreH });
  decks.push({
    minX: ax - half,
    maxX: ax + half,
    minZ: rampTopZ,
    maxZ: kneeZ,
    y: deckY,
    y2: kneeY,
  });
  // Landfall transition ramp: a planar blend from the flat deck up onto the
  // hillside. Without it the deck abuts the rising slope in one kink and a
  // full-speed crossing slams the nose and scrubs to a crawl.
  //
  // ORDER AND EXTENT BOTH MATTER. `surface.ts heightAt` returns the FIRST deck
  // that matches, so the flat span used to win over the 12u of blend it
  // overlapped — the blend was dead exactly where it does its work, and the
  // crossing landed on Marin over a ~1.8u lip. The flat span now STOPS where
  // the blend starts, so the two are contiguous rather than stacked.
  let spanMinZ = northEndZ - 4;
  if (landfallZ !== null) {
    const blendTopZ = landfallZ - 18;
    const blendTopY = ctx.terrain.heightAt(ax, blendTopZ) + 0.05;
    if (blendTopY > deckY) {
      spanMinZ = landfallZ + 8;
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
  // Deck out across the strait to the Marin landfall (or the fallback pad).
  decks.push({ minX: ax - half, maxX: ax + half, minZ: spanMinZ, maxZ: rampTopZ, y: deckY });

  // --- Rails ---
  // THESE DO NOT HOLD THE CAR, and the reason is not in this file. When the
  // Rapier RaycastVehicle is attached — i.e. always, in the shipped game —
  // `car.update` returns at its first line into `updatePhysicsControls`, so
  // the arcade 2-D `resolveCollisions` that treats a Solid as infinitely tall
  // never runs. The taxi meets these boxes ONLY as Rapier static colliders,
  // and `physics-world.addStaticSolids` anchors every one of them to
  // `terrain.heightAt` — which under the water crossing is the seabed at -5.
  // The rail box therefore tops out ~6u below the carriageway and a straight
  // run across the 222u span drives clean off the edge into the bay.
  //
  // Three fixes were built and MEASURED in the running game (mid-span
  // teleport, throttle + full lock, telemetry every 400ms); all three are
  // worse than the bug, so none of them is here:
  //   • deck-anchored 12u box (base = deck−1, and again at deck−5): the car
  //     now contacts the rail, and Rapier ejects the chassis out of the box's
  //     BOTTOM face — it sinks through the deck and comes to rest at y≈4.2
  //     under the bridge.
  //   • parapet-height box (base = deck, maxY = deck+2.4): too shallow to
  //     engage the chassis at all; identical to the bug.
  // The root cause is that a SurfaceDeck is NOT a physics collider — nothing
  // resists a downward ejection — so the honest fixes are to give the decks
  // colliders, or to clamp the chassis to `surface.heightAt` after the step.
  // Both are drive-feel changes in vehicle/raycast-vehicle.ts and want a real
  // driving pass, not a world-gen edit. A straight crossing is unaffected
  // (measured: flat y 7.06 the whole 190u span, onto the Marin landfall).
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
  for (let gz = plan.anchorGz; gz >= 0; gz--) {
    if (ctx.plan.cells[plan.anchorGx]?.[gz] === "water")
      openWaterCells.add(`${plan.anchorGx},${gz}`);
  }

  // --- Visuals ---
  // Deck boards: kit bridge segments, flat along the deck + pitched on the ramp.
  const deckUrl = modelUrl("roads", ROAD_BRIDGE);
  const db = ctx.cache.bounds(deckUrl);
  const segLen = 8;
  const boardScaleX = (DECK_W + 1.6) / Math.max(db.size.x, 0.001);
  const boardScaleZ = segLen / Math.max(db.size.z, 0.001);
  const rampSegs = Math.ceil(rampLen / 4);
  const rampSegLen = rampLen / rampSegs;
  for (let i = 0; i < rampSegs; i++) {
    const t0 = i / rampSegs;
    const t1 = (i + 1) / rampSegs;
    const h0 = rampProfile(plan, t0);
    const h1 = rampProfile(plan, t1);
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

  // Transition pier where the deck leaves the ramp. There is exactly ONE: the
  // old build also dropped a pier at MID-SPAN, which is the one place a
  // suspension bridge cannot have one — a column under the middle of the main
  // span says "this is a causeway with decoration on it".
  const pillarUrl = modelUrl("roads", BRIDGE_PILLAR_WIDE);
  const pb = ctx.cache.bounds(pillarUrl);
  {
    const p = ctx.cache.instance(pillarUrl);
    p.scale.set(
      (DECK_W + 2) / Math.max(pb.size.x, 0.001),
      (deckY + 0.5) / Math.max(pb.size.y, 0.001),
      4 / Math.max(pb.size.z, 0.001),
    );
    p.position.set(ax, -0.6, rampTopZ - 6);
    p.updateMatrixWorld(true);
    objects.push(p);
  }

  // Parapet lamp posts. The halos come from goldenGateBeacons (runtime), the
  // fixtures from here (baked) — both off the same lampStations list, so a
  // glow never floats without a post under it.
  const postGeo = new THREE.BoxGeometry(0.16, LAMP_H, 0.16);
  const headGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
  for (const st of lampStations(plan)) {
    objects.push(mesh(postGeo, RAIL_ORANGE, st.x, st.y + LAMP_H / 2, st.z));
    objects.push(mesh(headGeo, RAIL_ORANGE, st.x, st.y + LAMP_H, st.z));
  }

  // Orange stiffening truss under the deck. The deck itself is a grey kit
  // board (the real roadway IS grey asphalt), so from the side the crossing
  // read as a city causeway with a red gantry over it — international orange
  // has to be on the SPAN, not only on the tower. A two-chord truss with
  // verticals, diagonals and floorbeams gives the deck its colour, its depth
  // and the fine detail that keeps it from flattening into a bar at range.
  {
    const trussZ0 = northEndZ - 2; // north
    const trussZ1 = rampTopZ; // south (the ramp sits on the ground)
    const spanLen = trussZ1 - trussZ0;
    const chord = new THREE.BoxGeometry(1.0, 0.8, spanLen);
    const sides = [-(half + RAIL_T / 2), half + RAIL_T / 2] as const;
    for (const sx of sides) {
      for (const cy of [deckY - 0.55, deckY - 2.85]) {
        objects.push(mesh(chord, ORANGE, ax + sx, cy, (trussZ0 + trussZ1) / 2));
      }
    }
    const panels = Math.max(4, Math.round(spanLen / 7.5));
    const panelLen = spanLen / panels;
    const post = new THREE.BoxGeometry(0.55, 2.3, 0.55);
    const beam = new THREE.BoxGeometry(DECK_W + RAIL_T * 2, 0.55, 0.55);
    const diagLen = Math.hypot(panelLen, 2.3);
    const diag = new THREE.BoxGeometry(0.4, diagLen, 0.4);
    const diagTilt = Math.atan2(panelLen, 2.3);
    for (let i = 0; i <= panels; i++) {
      const bz = trussZ1 - panelLen * i;
      for (const sx of sides) objects.push(mesh(post, ORANGE, ax + sx, deckY - 1.7, bz));
      if (i === panels) continue;
      objects.push(mesh(beam, ORANGE, ax, deckY - 2.85, bz - panelLen / 2));
      // Web diagonals, alternating lean — the zig-zag is what reads as a
      // truss rather than as a solid orange skirt.
      for (const sx of sides) {
        const d = mesh(diag, ORANGE, ax + sx, deckY - 1.7, bz - panelLen / 2);
        d.rotation.x = i % 2 === 0 ? diagTilt : -diagTilt;
        d.updateMatrixWorld(true);
        objects.push(d);
      }
    }
  }

  // Towers: BOTH of them (south in the strait off the Presidio, north off the
  // Marin headland) — one portal is a football goal, two is the Golden Gate.
  // Legs stand outside the carriageway so the deck runs THROUGH the portal,
  // step back art-deco fashion as they rise, and carry the stepped portal
  // bracing that is the bridge's other signature.
  const legX = half + LEG_OFF;
  {
    const legBaseY = LEG_BASE_Y;
    const secH = (topY - legBaseY) / TOWER_STEPS;
    const markerGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const saddleGeo = new THREE.BoxGeometry(LEG_TOP + 1.5, 1.6, LEG_TOP + 1.5);
    for (const tz of [towerZ2, towerZ]) {
      for (const sx of [-legX, legX]) {
        for (let i = 0; i < TOWER_STEPS; i++) {
          const y0 = legBaseY + secH * i;
          const w = legWidthAt((i + 0.5) / TOWER_STEPS);
          objects.push(mesh(new THREE.BoxGeometry(w, secH, w), ORANGE, ax + sx, y0 + secH / 2, tz));
          // The setback ledge at each step: a thin slab a touch WIDER than the
          // section below it. Those shadow lines up the shaft are the whole
          // art-deco read, and a plain taper has none of them.
          if (i > 0) {
            objects.push(
              mesh(new THREE.BoxGeometry(w + 0.55, 0.42, w + 0.55), ORANGE, ax + sx, y0, tz),
            );
          }
          // Vertical pilaster reeding on the two broad (along-strait) faces.
          for (const fz of [-1, 1] as const) {
            for (const off of [-w * 0.26, w * 0.26]) {
              objects.push(
                mesh(
                  new THREE.BoxGeometry(w * 0.19, secH - 0.9, 0.24),
                  ORANGE,
                  ax + sx + off,
                  y0 + secH / 2,
                  tz + (fz * w) / 2,
                ),
              );
            }
          }
        }
        objects.push(mesh(saddleGeo, ORANGE, ax + sx, topY + 0.8, tz));
        // Marker lights up the leg.
        for (let i = 0; i < 7; i++) {
          const my = deckY + 3 + (i * (TOWER_H - 5)) / 6;
          objects.push(mesh(markerGeo, TOWER_LAMP, ax + sx + Math.sign(sx) * 1.3, my, tz));
        }
      }
      // Portal bracing. Each brace is a ZIGGURAT — a main bar with a narrower
      // step under it and a narrower one over it — and the braces step inward
      // going up, so the openings between them shorten and narrow toward the
      // saddle. That stack of tapering portals is the tower's signature; four
      // plain bars read as a ladder.
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const by = THREE.MathUtils.lerp(deckY + 8, topY - 3.4, t);
        const w = legX * 2 + legWidthAt((by - legBaseY) / (topY - legBaseY)) - t * 1.6;
        objects.push(mesh(new THREE.BoxGeometry(w, 1.5, 1.5), ORANGE, ax, by, tz));
        objects.push(mesh(new THREE.BoxGeometry(w - 3.2, 0.8, 1.15), ORANGE, ax, by - 1.1, tz));
        objects.push(mesh(new THREE.BoxGeometry(w - 1.6, 0.7, 1.3), ORANGE, ax, by + 1.05, tz));
      }
      // The strut under the roadway, closing the portal below the deck.
      objects.push(
        mesh(new THREE.BoxGeometry(legX * 2 + LEG_BASE, 1.3, 1.6), ORANGE, ax, deckY - 3.6, tz),
      );
    }
  }

  // Main cables: shore anchorage → south tower → the slung main span → north
  // tower → the Marin anchorage, with suspenders down to the deck. Each bay is
  // a real parabola between fixed saddles (see cableSaddles), so the cable
  // rises to BOTH tower tops and sags to just above the roadway at midspan —
  // the shape the whole silhouette lives on.
  const saddles = cableSaddles(plan);
  const cableZ0 = saddles[0]?.[0] ?? shoreZ;
  const cableZ1 = saddles[saddles.length - 1]?.[0] ?? northEndZ;
  const ropeGeo = new THREE.BoxGeometry(0.2, 1, 0.2);
  // The cable is a CHAIN of short straight links, not one long tube, and every
  // link is a separately positioned instance. Two reasons, both learned the
  // hard way on this bridge:
  //  1. The batch streamer files an instance by its MATRIX position. A tube
  //     whose vertices carry world coordinates has an identity matrix, so the
  //     old cable was filed at (0, 0, 0) — a chunk out at Twin Peaks — and
  //     streamed in only when the player stood there. The bridge shipped with
  //     suspender ropes hanging off nothing.
  //  2. Anything 13u tall or more earns a box IMPOSTER past the detail ring.
  //     One 243 × 40u cable's imposter is a 243 × 40u slab, and the bridge
  //     read from the Marina as a solid red billboard over the strait.
  // Short links solve both: each is filed on the bridge's own chunk, and each
  // one's imposter is the link.
  const linkGeo = new THREE.BoxGeometry(0.5, 1, 0.5);
  for (const sx of [-legX, legX]) {
    const pts: THREE.Vector3[] = [];
    const steps = Math.max(24, Math.round((cableZ0 - cableZ1) / 2.5));
    for (let i = 0; i <= steps; i++) {
      const cz = cableZ0 - ((cableZ0 - cableZ1) * i) / steps;
      const cy = cableY(saddles, cz);
      if (cy !== null) pts.push(new THREE.Vector3(ax + sx, cy, cz));
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const len = Math.hypot(dy, dz);
      if (len < 0.001) continue;
      const link = mesh(linkGeo, ORANGE, a.x, (a.y + b.y) / 2, (a.z + b.z) / 2);
      link.scale.y = len + 0.12; // overlap, so the chain has no daylight in it
      link.rotation.x = Math.atan2(dz, dy);
      link.updateMatrixWorld(true);
      objects.push(link);
    }
    // Suspender ropes at a ~5u pitch (the real ones are 15 m apart). The old
    // build hung 20 of them across the whole crossing, which reads as a row of
    // detached sticks rather than as a curtain under a cable.
    const ropes = Math.round((cableZ0 - cableZ1) / 5);
    for (let i = 1; i < ropes; i++) {
      const rz = cableZ0 - ((cableZ0 - cableZ1) * i) / ropes;
      if (rz > railMaxZ || rz < railMinZ) continue;
      const cy = cableY(saddles, rz);
      if (cy === null) continue;
      const h = cy - (deckY + 0.9);
      if (h < 0.8) continue;
      const rope = mesh(ropeGeo, ORANGE, ax + sx, deckY + 0.9 + h / 2, rz);
      rope.scale.y = h;
      rope.updateMatrixWorld(true);
      objects.push(rope);
    }
  }

  // South anchorage: the block the two main cables actually pull against,
  // flanking the ramp entry and rising to the cable's saddle height. It used
  // to be a 3.2u lump with the cable passing well above it.
  {
    const anchorTop = deckY + 5.2;
    const anchorZ = shoreZ + 1;
    for (const sx of [-legX, legX]) {
      objects.push(
        mesh(
          new THREE.BoxGeometry(4.6, anchorTop - shoreH + 2, 8),
          ORANGE,
          ax + sx,
          (anchorTop + shoreH - 2) / 2,
          anchorZ,
        ),
      );
      objects.push(
        mesh(new THREE.BoxGeometry(5.4, 0.9, 8.8), ORANGE, ax + sx, anchorTop + 0.2, anchorZ),
      );
    }
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
