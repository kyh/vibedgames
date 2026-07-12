import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import {
  BRIDGE_PILLAR_WIDE,
  BUILDINGS_INDUSTRIAL,
  BUILDINGS_SUBURBAN,
  modelUrl,
  ROAD_BRIDGE,
} from "../assets/manifest";
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
import type { RoadNetwork } from "./network";
import type { Terrain } from "./terrain";

const LANDMARK_SCALE = ROAD_TILE / 8; // keep landmarks proportional to the world

// Iconic SF landmarks at traced (u,v) positions (from the sf-trace research).
// `clearR` (world units) is the monument's ground-footprint radius: those
// landmarks are nudged off vector asphalt at build time (a hardcoded (u,v)
// has no idea where the baked streets landed — Salesforce stood in the road).
// `protHalf` are the reservation-rect half-extents, sized to the VISUAL base
// (they were smaller than the meshes, letting buildings clip the monuments).
type Landmark = {
  kind: string;
  u: number;
  v: number;
  rotDeg: number;
  clearR?: number;
  protHalf?: readonly [number, number];
};
// (The Golden Gate is no longer a landmark prop — it's the DRIVABLE bridge
// built by world/golden-gate.ts.)
const LANDMARKS: readonly Landmark[] = [
  { kind: "baybridge", u: 0.93, v: 0.205, rotDeg: 90 },
  { kind: "pyramid", u: 0.701, v: 0.15, rotDeg: 0, clearR: 7.2, protHalf: [7.2, 7.2] },
  // 415 Mission projected through the calibrated lon/lat→(u,v) fit.
  { kind: "salesforce", u: 0.7396, v: 0.2038, rotDeg: 0, clearR: 6.9, protHalf: [6.9, 6.9] },
  { kind: "coittower", u: 0.683, v: 0.082, rotDeg: 0, clearR: 4.1, protHalf: [4.1, 4.1] },
  { kind: "ferrybuilding", u: 0.756, v: 0.15, rotDeg: 270, protHalf: [5.7, 21.2] }, // ON the new shore edge
  { kind: "paintedladies", u: 0.513, v: 0.33, rotDeg: 90, protHalf: [4, 20] },
  { kind: "sutro", u: 0.402, v: 0.52, rotDeg: 0, clearR: 6.5, protHalf: [6.5, 6.5] },
  { kind: "dragongate", u: 0.6725, v: 0.228, rotDeg: 0 },
  { kind: "alcatraz", u: 0.52, v: 0.008, rotDeg: 20 },
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

const ORANGE = new THREE.MeshStandardMaterial({ color: 0xc0362c, roughness: 0.6 });
const WHITE = new THREE.MeshStandardMaterial({ color: 0xeceff2, roughness: 0.7 });
const CREAM = new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.75 });
const GLASS = new THREE.MeshStandardMaterial({ color: 0xbfd4dd, roughness: 0.25, metalness: 0.5 });
// Deeper glass for the big towers — the pale GLASS + distance fog read as a
// featureless beam of sky.
const TOWER_GLASS = new THREE.MeshStandardMaterial({
  color: 0x7d9cb2,
  roughness: 0.4,
  metalness: 0.35,
});
const STEEL = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.4 });
const GATE_RED = new THREE.MeshStandardMaterial({ color: 0xb5382e, roughness: 0.6 });
const GATE_GREEN = new THREE.MeshStandardMaterial({ color: 0x3e7d54, roughness: 0.6 });
const ROCK = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 1 });

function uWorld(u: number): number {
  return (u - 0.5) * WORLD_W;
}
function vWorld(v: number): number {
  return (v - 0.5) * WORLD_H;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Transamerica Pyramid — slender white 4-sided pyramid with shoulder wings.
function pyramid(): THREE.Group {
  const g = new THREE.Group();
  const H = 36; // real 260 m at world scale
  const cone = mesh(new THREE.ConeGeometry(4.4, H, 4), WHITE, 0, H / 2, 0);
  cone.rotation.y = Math.PI / 4;
  g.add(cone);
  g.add(mesh(new THREE.BoxGeometry(1.4, 14, 3), WHITE, -3.2, 7, 0));
  g.add(mesh(new THREE.BoxGeometry(1.4, 14, 3), WHITE, 3.2, 7, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.18, 0.18, 7), WHITE, 0, H + 3, 0));
  return g;
}

// Salesforce Tower — the tallest, a tapered octagonal glass shaft. H matches
// the real 326 m at world scale (45 × LANDMARK_SCALE ≈ 73u) — the old 60
// (97u) washed into the fog as a featureless beam.
function salesforce(): THREE.Group {
  const g = new THREE.Group();
  const H = 45;
  g.add(mesh(new THREE.CylinderGeometry(2.3, 4.2, H, 10), TOWER_GLASS, 0, H / 2, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.1, 1.6, 5, 10), TOWER_GLASS, 0, H + 2, 0));
  return g;
}

// Coit Tower — fluted white column on Telegraph Hill.
function coitTower(): THREE.Group {
  const g = new THREE.Group();
  const H = 16;
  g.add(mesh(new THREE.CylinderGeometry(2.1, 2.4, H, 16), WHITE, 0, H / 2, 0));
  g.add(mesh(new THREE.CylinderGeometry(2.5, 2.2, 2.6, 16), WHITE, 0, H + 1, 0));
  g.add(mesh(new THREE.CylinderGeometry(1.4, 2.2, 2, 16, 1, true), WHITE, 0, H + 3, 0));
  return g;
}

// Ferry Building — long arcade with a central clock tower. Kept short enough
// (26 × scale ≈ 36u ≈ 3 cells) that its footprint stays off the road grid.
function ferryBuilding(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(26, 7, 7), CREAM, 0, 3.5, 0));
  const tower = mesh(new THREE.BoxGeometry(4.5, 22, 4.5), CREAM, 0, 11, 0);
  g.add(tower);
  g.add(mesh(new THREE.BoxGeometry(3, 3, 0.4), STEEL, 0, 18, 2.3)); // clock face
  g.add(mesh(new THREE.ConeGeometry(3, 4, 4), CREAM, 0, 24, 0));
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
    const leg = mesh(new THREE.CylinderGeometry(0.32, 0.5, H, 6), ORANGE, bx, H / 2, bz);
    leg.rotation.z = Math.cos(a) * lean;
    leg.rotation.x = -Math.sin(a) * lean;
    g.add(leg);
    // Antenna prongs rise from the waist, white above.
    const px = Math.cos(a) * 2.2;
    const pz = Math.sin(a) * 2.2;
    g.add(mesh(new THREE.CylinderGeometry(0.16, 0.22, 14, 6), WHITE, px, H + 6.5, pz));
  }
  // Waist platforms.
  g.add(mesh(new THREE.CylinderGeometry(2.9, 2.9, 0.7, 8), ORANGE, 0, H * 0.62, 0));
  g.add(mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.7, 8), ORANGE, 0, H, 0));
  // Crossbar joining the prong tips.
  g.add(mesh(new THREE.CylinderGeometry(0.14, 0.14, 5.4, 6), WHITE, 0, H + 13, 0));
  return g;
}

// Chinatown Dragon Gate — pillars + tiered pagoda roofs over the road.
function dragonGate(): THREE.Group {
  const g = new THREE.Group();
  for (const sx of [-4.6, 4.6]) {
    g.add(mesh(new THREE.CylinderGeometry(0.55, 0.65, 5.6, 10), GATE_RED, sx, 2.8, 0));
  }
  // Main span roof (three stacked tiers, green tile).
  g.add(mesh(new THREE.BoxGeometry(11.4, 0.5, 2.2), GATE_RED, 0, 5.8, 0));
  g.add(mesh(new THREE.BoxGeometry(10, 0.9, 2.8), GATE_GREEN, 0, 6.5, 0));
  g.add(mesh(new THREE.BoxGeometry(6.5, 0.8, 2.4), GATE_GREEN, 0, 7.6, 0));
  g.add(mesh(new THREE.BoxGeometry(3.2, 0.9, 2.0), GATE_GREEN, 0, 8.6, 0));
  g.add(mesh(new THREE.SphereGeometry(0.5, 8, 6), GATE_RED, 0, 9.4, 0));
  return g;
}

// Alcatraz — rock, cellhouse, lighthouse; sits in the bay off the wharf.
function alcatraz(cache: ModelCache): THREE.Group {
  const g = new THREE.Group();
  const rock = mesh(new THREE.DodecahedronGeometry(7, 1), ROCK, 0, -1.5, 0);
  rock.scale.set(1.6, 0.55, 1);
  g.add(rock);
  const cellUrl = modelUrl("buildings", BUILDINGS_INDUSTRIAL[0] ?? "");
  const b = cache.bounds(cellUrl);
  const cell = cache.instance(cellUrl);
  const s = 9 / Math.max(b.size.x, 0.001);
  cell.scale.set(s, s * 0.8, s);
  cell.position.set(-1, 2.1, 0);
  cell.traverse((c) => {
    if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
      const m = c.material.clone();
      m.color.lerp(new THREE.Color(0xd8d0b8), 0.75);
      c.material = m;
    }
  });
  g.add(cell);
  g.add(mesh(new THREE.CylinderGeometry(0.4, 0.55, 6.5, 8), WHITE, 4.2, 5.2, 1.5));
  g.add(mesh(new THREE.SphereGeometry(0.55, 8, 6), GLASS, 4.2, 8.7, 1.5));
  return g;
}

// A suspension bridge spanning along +Z: Kenney bridge-deck segments riding on
// wide kit pillars, with procedural towers and catenary cables (the good part
// of the old build). `mat` tints the towers/cables; the deck keeps kit colors.
function suspensionBridge(
  cache: ModelCache,
  span: number,
  towerH: number,
  mat: THREE.Material,
  deckY: number,
): THREE.Group {
  const g = new THREE.Group();
  const half = span / 2;
  const towerZ = half * 0.5; // towers at the ±25% points
  const topY = deckY + towerH;
  const sagY = deckY + 4;
  const legX = 2.8;

  // Deck: tiled kit bridge segments (they read as roadway with railings).
  const deckUrl = modelUrl("roads", ROAD_BRIDGE);
  const db = cache.bounds(deckUrl);
  const segLen = 8;
  const segs = Math.ceil(span / segLen);
  for (let i = 0; i < segs; i++) {
    const seg = cache.instance(deckUrl);
    const s = segLen / Math.max(db.size.z, 0.001);
    seg.scale.set(8 / Math.max(db.size.x, 0.001), s, s);
    seg.position.set(0, deckY - 0.35, -half + segLen * (i + 0.5));
    tintNode(seg, mat);
    g.add(seg);
  }

  // Piers under the deck between the towers and at the ends.
  const pillarUrl = modelUrl("roads", BRIDGE_PILLAR_WIDE);
  const pb = cache.bounds(pillarUrl);
  for (const pz of [-half + 4, 0, half - 4]) {
    const p = cache.instance(pillarUrl);
    const ps = deckY / Math.max(pb.size.y, 0.001);
    p.scale.set(9 / Math.max(pb.size.x, 0.001), ps, 3 / Math.max(pb.size.z, 0.001));
    p.position.set(0, 0, pz);
    tintNode(p, mat);
    g.add(p);
  }

  for (const tz of [-towerZ, towerZ]) {
    g.add(mesh(new THREE.BoxGeometry(1.6, towerH + 2, 1.6), mat, legX, deckY + towerH / 2, tz));
    g.add(mesh(new THREE.BoxGeometry(1.6, towerH + 2, 1.6), mat, -legX, deckY + towerH / 2, tz));
    g.add(mesh(new THREE.BoxGeometry(2 * legX + 1.6, 1.1, 0.8), mat, 0, deckY + towerH - 4, tz));
    g.add(mesh(new THREE.BoxGeometry(2 * legX + 1.6, 1.1, 0.8), mat, 0, deckY + towerH - 13, tz));
  }

  for (const sx of [legX, -legX]) {
    const key = [
      new THREE.Vector3(sx, deckY + 0.5, -half),
      new THREE.Vector3(sx, topY, -towerZ),
      new THREE.Vector3(sx, sagY, 0),
      new THREE.Vector3(sx, topY, towerZ),
      new THREE.Vector3(sx, deckY + 0.5, half),
    ];
    const curve = new THREE.CatmullRomCurve3(key);
    g.add(mesh(new THREE.TubeGeometry(curve, 48, 0.18, 6), mat));
    // Vertical suspenders from the main span cable down to the deck.
    for (let i = -4; i <= 4; i++) {
      const z = (i / 4) * towerZ;
      const t = Math.abs(z) / towerZ; // 0 mid .. 1 tower
      const cy = sagY + (topY - sagY) * t * t;
      g.add(mesh(new THREE.BoxGeometry(0.1, cy - deckY, 0.1), mat, sx, (cy + deckY) / 2, z));
    }
  }
  return g;
}

// Tint every mesh of a kit instance toward the bridge material color.
function tintNode(node: THREE.Object3D, mat: THREE.Material): void {
  if (!(mat instanceof THREE.MeshStandardMaterial)) return;
  node.traverse((c) => {
    if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
      const m = c.material.clone();
      m.color.lerp(mat.color, 0.75);
      c.material = m;
    }
  });
}

function paintedLadies(cache: ModelCache, rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const colors = [0xf6c8d4, 0x9ec6e0, 0xf2e0a0, 0xb8dcc0, 0xe8b48a, 0xd8c0e0];
  for (let i = 0; i < 6; i++) {
    const url = modelUrl("buildings", BUILDINGS_SUBURBAN[i % BUILDINGS_SUBURBAN.length] ?? "");
    const bounds = cache.bounds(url);
    const scale = 5.5 / Math.max(bounds.size.x, bounds.size.z, 0.001);
    const node = cache.instance(url);
    node.scale.set(scale, scale * (1.3 + rng.range(0, 0.25)), scale);
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
  const protect = (x: number, z: number, halfX: number, halfZ: number): void => {
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
        if (plan.cells[gx]?.[gz] !== "lot") continue;
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
    if (!lm.protHalf) continue;
    const [x, z] = resolvePosition(lm, network);
    protect(x, z, lm.protHalf[0], lm.protHalf[1]);
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
    const [x, z] = resolvePosition(lm, network);
    let node: THREE.Group;
    let y = terrain.heightAt(x, z);
    switch (lm.kind) {
      case "pyramid":
        node = pyramid();
        break;
      case "salesforce":
        node = salesforce();
        break;
      case "coittower":
        node = coitTower();
        break;
      case "ferrybuilding":
        node = ferryBuilding();
        break;
      case "paintedladies":
        node = paintedLadies(cache, rng);
        break;
      case "sutro":
        node = sutroTower();
        break;
      case "dragongate":
        node = dragonGate();
        break;
      case "alcatraz":
        node = alcatraz(cache);
        y = 0; // rises from the bay
        break;
      case "ggbridge":
        node = suspensionBridge(cache, 58, 30, ORANGE, 9);
        y = 0; // spans the strait at a fixed deck height above the water
        break;
      case "baybridge":
        node = suspensionBridge(cache, 66, 22, STEEL, 8);
        y = 0;
        break;
      default:
        continue;
    }
    node.position.set(x, y, z);
    node.rotation.y = THREE.MathUtils.degToRad(lm.rotDeg);
    node.scale.multiplyScalar(LANDMARK_SCALE);
    root.add(node);
  }
  return root;
}
