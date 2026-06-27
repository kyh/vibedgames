import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import { BUILDINGS_SUBURBAN, modelUrl } from "../assets/manifest";
import { WORLD_SIZE } from "../shared/constants";
import { Rng } from "../shared/rng";
import type { Terrain } from "./terrain";

// Iconic SF landmarks at traced (u,v) positions (from the sf-trace research).
type Landmark = { kind: string; u: number; v: number; rotDeg: number };
const LANDMARKS: readonly Landmark[] = [
  { kind: "ggbridge", u: 0.25, v: 0.025, rotDeg: 352 },
  { kind: "baybridge", u: 0.82, v: 0.205, rotDeg: 88 },
  { kind: "pyramid", u: 0.701, v: 0.15, rotDeg: 0 },
  { kind: "salesforce", u: 0.736, v: 0.203, rotDeg: 0 },
  { kind: "coittower", u: 0.683, v: 0.082, rotDeg: 0 },
  { kind: "ferrybuilding", u: 0.772, v: 0.15, rotDeg: 270 },
  { kind: "paintedladies", u: 0.513, v: 0.33, rotDeg: 90 },
];

const ORANGE = new THREE.MeshStandardMaterial({ color: 0xc0362c, roughness: 0.6 });
const WHITE = new THREE.MeshStandardMaterial({ color: 0xeceff2, roughness: 0.7 });
const CREAM = new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.75 });
const GLASS = new THREE.MeshStandardMaterial({ color: 0xbfd4dd, roughness: 0.25, metalness: 0.5 });
const STEEL = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.4 });

function uWorld(u: number): number {
  return (u - 0.5) * WORLD_SIZE;
}
function vWorld(v: number): number {
  return (v - 0.5) * WORLD_SIZE;
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
  const H = 42;
  const cone = mesh(new THREE.ConeGeometry(4.4, H, 4), WHITE, 0, H / 2, 0);
  cone.rotation.y = Math.PI / 4;
  g.add(cone);
  g.add(mesh(new THREE.BoxGeometry(1.4, 14, 3), WHITE, -3.2, 7, 0));
  g.add(mesh(new THREE.BoxGeometry(1.4, 14, 3), WHITE, 3.2, 7, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.18, 0.18, 7), WHITE, 0, H + 3, 0));
  return g;
}

// Salesforce Tower — the tallest, a tapered octagonal glass shaft.
function salesforce(): THREE.Group {
  const g = new THREE.Group();
  const H = 60;
  g.add(mesh(new THREE.CylinderGeometry(2.3, 4.2, H, 10), GLASS, 0, H / 2, 0));
  g.add(mesh(new THREE.CylinderGeometry(0.1, 1.6, 6, 10), GLASS, 0, H + 2.5, 0));
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

// Ferry Building — long arcade with a central clock tower.
function ferryBuilding(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(34, 7, 7), CREAM, 0, 3.5, 0));
  const tower = mesh(new THREE.BoxGeometry(4.5, 22, 4.5), CREAM, 0, 11, 0);
  g.add(tower);
  g.add(mesh(new THREE.BoxGeometry(3, 3, 0.4), STEEL, 0, 18, 2.3)); // clock face
  g.add(mesh(new THREE.ConeGeometry(3, 4, 4), CREAM, 0, 24, 0));
  return g;
}

// A suspension bridge spanning along +Z (north–south): two towers, a deck, and
// main cables that peak at the tower tops and sag (above the deck) between them,
// with vertical suspenders hanging to the deck. Rotated into place by the caller.
function suspensionBridge(
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
  g.add(mesh(new THREE.BoxGeometry(8, 0.8, span), mat, 0, deckY, 0)); // deck

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

export function buildLandmarks(terrain: Terrain, cache: ModelCache): THREE.Group {
  const root = new THREE.Group();
  const rng = new Rng(4242);
  for (const lm of LANDMARKS) {
    const x = uWorld(lm.u);
    const z = vWorld(lm.v);
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
      case "ggbridge":
        node = suspensionBridge(58, 30, ORANGE, 9);
        y = 0; // spans the strait at a fixed deck height above the water
        break;
      case "baybridge":
        node = suspensionBridge(90, 22, STEEL, 8);
        y = 0;
        break;
      default:
        continue;
    }
    node.position.set(x, y, z);
    node.rotation.y = THREE.MathUtils.degToRad(lm.rotDeg);
    root.add(node);
  }
  return root;
}
