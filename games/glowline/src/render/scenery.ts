// Everything beside the road. The circuit sits in a district: buildings on a
// street grid, a lawn in the infield, trees, a grandstand and a pit building
// on the start straight, a gantry over the line, barrier blocks down both
// rails, tyre walls on the outside of the bends, lamps, signs. All of it is
// instanced and all of it takes and casts the sun, so nothing floats.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import { curvatureAt, pointAt, wrapIndex } from "../sim/track";
import type { Track } from "../sim/track";
import type { PaintLayer } from "./paint-layer";
import { catchPaint } from "./road";
import type { Site } from "./site";
import {
  checker,
  concrete,
  facade,
  paintedPanel,
  seeded,
  signTexture,
  softDisc,
  softSquare,
} from "./textures";

/** Street grid pitch: one building plot per cell. */
export const BLOCK = 34;
/** How far the district reaches from the origin. */
export const REACH = 400;

const SIGNS = [
  "GLOWLINE GP",
  "KIKO TYRES",
  "VOLT COLA",
  "NIGHT SHIFT FM",
  "ZEST ENERGY",
  "MIRAGE OPTICS",
  "ONYX OIL",
] as const;

const SCRATCH = new THREE.Object3D();
const WHITE = new THREE.Color("#ffffff");
const TINT = new THREE.Color();

export interface Placement {
  x: number;
  y: number;
  z: number;
  /** Rotation about Y. */
  turn: number;
  sx: number;
  sy: number;
  sz: number;
  color?: THREE.Color;
}

/**
 * Give a geometry real tangents where it can have them. Without them a normal
 * map's frame is rebuilt per pixel from screen-space derivatives, which shows
 * as a seam along every triangle edge on large flat faces.
 */
const withTangents = (geometry: THREE.BufferGeometry): void => {
  const ready = geometry.index && geometry.getAttribute("uv") && geometry.getAttribute("normal");
  if (ready && !geometry.getAttribute("tangent")) {
    geometry.computeTangents();
  }
};

/** Collects what a circuit's scenery allocates, so one call frees it all. */
export class Kit {
  readonly group = new THREE.Group();
  readonly random: () => number;
  private readonly disposables: { dispose: () => void }[] = [];

  constructor(seed: number) {
    this.random = seeded(seed);
  }

  own<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  mesh(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): THREE.Mesh {
    withTangents(geometry);
    const mesh = new THREE.Mesh(this.own(geometry), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  /** One InstancedMesh from a list of placements; colours are optional per instance. */
  instances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
    placements: readonly Placement[],
    shadows = true,
  ): THREE.InstancedMesh {
    withTangents(geometry);
    const mesh = new THREE.InstancedMesh(
      this.own(geometry),
      material,
      Math.max(1, placements.length),
    );
    mesh.count = placements.length;
    for (const [i, p] of placements.entries()) {
      SCRATCH.position.set(p.x, p.y, p.z);
      SCRATCH.rotation.set(0, p.turn, 0);
      SCRATCH.scale.set(p.sx, p.sy, p.sz);
      SCRATCH.updateMatrix();
      mesh.setMatrixAt(i, SCRATCH.matrix);
      if (p.color) {
        mesh.setColorAt(i, p.color);
      }
    }
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const item of this.disposables) {
      item.dispose();
    }
  }
}

export const at = (
  x: number,
  y: number,
  z: number,
  turn = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): Placement => ({
  sx,
  sy,
  sz,
  turn,
  x,
  y,
  z,
});

// --- barriers ------------------------------------------------------------------

/** Rounded blocks nose to tail down both rails, in runs of colour. */
export const addBarriers = (kit: Kit, track: Track, paint: PaintLayer): void => {
  const { palette } = track.def;
  const colors = [palette.accent, "#f2f0ea", palette.accent2, "#ffd23f", "#f2f0ea"].map((style) =>
    new THREE.Color(style).multiplyScalar(0.9),
  );
  const maps = paintedPanel();
  kit.own(maps.map);
  kit.own(maps.normalMap);
  kit.own(maps.roughnessMap);
  const material = kit.own(new THREE.MeshStandardMaterial({ ...maps, roughness: 0.75 }));
  catchPaint(material, paint);
  const placements: Placement[] = [];
  // Walk each rail by its own arc length: the inside of a bend is shorter than
  // the centreline, so equal steps along the lap would ram blocks together.
  const pitch = 2.46;
  for (const side of [-1, 1]) {
    const lat = side * (track.rail + 0.55);
    let s = 0;
    let k = 0;
    while (s < track.n - pitch * 0.5) {
      const p = pointAt(track, s, lat);
      const colour = colors[Math.floor(k / 4) % colors.length];
      const block = at(p.x, 0.55, p.z, -p.a, 1, 1, 1);
      block.color = colour;
      placements.push(block);
      // A second course on top, half a block along, makes it a wall.
      const scale = Math.max(0.3, 1 - curvatureAt(track, s) * lat);
      const upper = pointAt(track, s + pitch / scale / 2, lat);
      const cap = at(upper.x, 1.58, upper.z, -upper.a, 1, 0.86, 0.9);
      cap.color = colors[(Math.floor(k / 4) + 2) % colors.length];
      placements.push(cap);
      s += pitch / scale;
      k += 1;
    }
  }
  kit.instances(new RoundedBoxGeometry(2.36, 1.1, 0.9, 3, 0.2), material, placements);
};

/** Tyre walls stacked on the outside of every real bend. */
export const addTyres = (kit: Kit, track: Track): void => {
  const placements: Placement[] = [];
  const white = new THREE.Color("#d8d8d8");
  const red = new THREE.Color(track.def.palette.accent2).multiplyScalar(0.8);
  for (let i = 0; i < track.n && placements.length < 900; i += 2) {
    const bend = curvatureAt(track, i);
    if (Math.abs(bend) > 0.03) {
      // +curve turns right, so the outside of the bend is the left rail.
      const p = pointAt(track, i, -Math.sign(bend) * (track.rail - 0.35));
      for (let layer = 0; layer < 3; layer += 1) {
        const tyre = at(p.x, 0.26 + layer * 0.5, p.z);
        tyre.color = (Math.floor(i / 8) + layer) % 2 === 0 ? white : red;
        placements.push(tyre);
      }
    }
  }
  const material = kit.own(new THREE.MeshStandardMaterial({ roughness: 0.9 }));
  kit.instances(
    new THREE.TorusGeometry(0.62, 0.26, 8, 14).rotateX(Math.PI / 2),
    material,
    placements,
  );
};

// --- buildings -----------------------------------------------------------------

interface Tier {
  rows: number;
  minHeight: number;
  maxHeight: number;
  minSize: number;
  maxSize: number;
}

const TIERS: readonly Tier[] = [
  { maxHeight: 15, maxSize: 24, minHeight: 7, minSize: 14, rows: 4 },
  { maxHeight: 38, maxSize: 22, minHeight: 18, minSize: 14, rows: 10 },
  { maxHeight: 105, maxSize: 20, minHeight: 44, minSize: 13, rows: 26 },
];

/** Which tier a plot gets: low beside the circuit, towers at the edge of town. */
const tierFor = (gap: number, roll: number): number => {
  if (gap < 52) {
    return 0;
  }
  if (gap < 120) {
    return roll < 0.25 ? 0 : 1;
  }
  return roll < 0.3 ? 1 : 2;
};

interface Roofscape {
  boxes: Placement[];
  tanks: Placement[];
  masts: Placement[];
  beacons: Placement[];
  /** Soft ground shade around each building's foot. */
  skirts: Placement[];
  /** Round towers and their crowns, pitched roofs, domes. */
  rounds: Placement[];
  crowns: Placement[];
  gables: Placement[];
  domes: Placement[];
}

/** Rooftops are never bare: plant, a stair hut, sometimes a tank. */
const dressRoof = (
  roofs: Roofscape,
  random: () => number,
  x: number,
  z: number,
  w: number,
  d: number,
  top: number,
): void => {
  const units = 1 + Math.floor(random() * 3);
  for (let u = 0; u < units; u += 1) {
    const s = 1.6 + random() * 2.4;
    roofs.boxes.push(
      at(
        x + (random() - 0.5) * (w - 5),
        top + s * 0.35,
        z + (random() - 0.5) * (d - 5),
        0,
        s * 1.3,
        s * 0.7,
        s,
      ),
    );
  }
  // A parapet lip, so the roofline is not a knife edge.
  roofs.boxes.push(at(x, top + 0.2, z, 0, w + 0.5, 0.4, d + 0.5));
  if (random() < 0.35) {
    roofs.tanks.push(at(x + w * 0.25, top + 1.6, z - d * 0.25, 0, 1.5, 3.2, 1.5));
  }
};

type AddBlock = (
  t: number,
  bx: number,
  bz: number,
  bw: number,
  bh: number,
  bd: number,
  y?: number,
) => void;

/** Low plots beside the circuit: a flat-roofed block, a row of gabled houses, or a domed hall. */
const massLow = (
  add: AddBlock,
  roofs: Roofscape,
  random: () => number,
  x: number,
  z: number,
  w: number,
  h: number,
  d: number,
  wall: THREE.Color,
): void => {
  const kind = random();
  if (kind < 0.45) {
    add(0, x, z, w, h, d);
    dressRoof(roofs, random, x, z, w, d, h);
  } else if (kind < 0.8) {
    // Three houses side by side, each with its own pitched roof.
    const tiles = [
      new THREE.Color("#b5533c"),
      new THREE.Color("#5c6b7a"),
      new THREE.Color("#7a4a3a"),
    ];
    for (let i = -1; i <= 1; i += 1) {
      const hw = w * 0.3;
      const hh = h * (0.55 + random() * 0.3);
      add(0, x + i * hw * 1.06, z, hw, hh, d * 0.7);
      const gable = at(x + i * hw * 1.06, hh, z, 0, hw * 1.08, hw * 0.45, d * 0.74);
      gable.color = tiles[Math.floor(random() * tiles.length)];
      roofs.gables.push(gable);
    }
  } else {
    // A hall under a dome.
    add(0, x, z, w, h * 0.7, d);
    const dome = at(x, h * 0.7, z, 0, w * 0.44, w * 0.3, d * 0.44);
    dome.color = wall.clone().multiplyScalar(0.9);
    roofs.domes.push(dome);
  }
};

/** One plot's massing: a single block, a podium with a tower, or two wings. */
const massPlot = (
  plots: Placement[][],
  roofs: Roofscape,
  random: () => number,
  tier: number,
  x: number,
  z: number,
  wall: THREE.Color,
): void => {
  const spec = TIERS[tier] ?? TIERS[0];
  if (!spec) {
    return;
  }
  const size = (): number => spec.minSize + random() * (spec.maxSize - spec.minSize);
  const w = size();
  const d = size();
  const h = spec.minHeight + random() * (spec.maxHeight - spec.minHeight);
  const add = (t: number, bx: number, bz: number, bw: number, bh: number, bd: number, y = 0) => {
    const block = at(bx, y, bz, 0, bw, bh, bd);
    block.color = wall.clone().multiplyScalar(0.82 + random() * 0.36);
    plots[t]?.push(block);
    if (y === 0) {
      // Ground-level blocks sit in a soft dark apron.
      roofs.skirts.push(at(bx, 0.015, bz, 0, bw + 7, 1, bd + 7));
    }
  };
  if (tier === 0) {
    massLow(add, roofs, random, x, z, w, h, d, wall);
    return;
  }
  const kind = random();
  let top = h;
  let mastX = x;
  if (kind < 0.26) {
    add(tier, x, z, w, h, d);
    dressRoof(roofs, random, x, z, w, d, h);
  } else if (kind < 0.46) {
    // Podium and a set-back tower.
    const podium = 6 + random() * 6;
    top = h + podium;
    add(0, x, z, w + 4, podium, d + 4);
    add(tier, x, z, w * 0.72, h, d * 0.72, podium);
    dressRoof(roofs, random, x, z, w * 0.72, d * 0.72, top);
  } else if (kind < 0.6) {
    // Two wings of different heights.
    mastX = x - w * 0.22;
    add(tier, mastX, z, w * 0.56, h, d);
    add(tier, x + w * 0.3, z + d * 0.1, w * 0.5, h * (0.5 + random() * 0.3), d * 0.8);
    dressRoof(roofs, random, mastX, z, w * 0.56, d, h);
  } else if (kind < 0.74) {
    // A stepped tower: three setbacks.
    add(tier, x, z, w, h * 0.5, d);
    add(tier, x, z, w * 0.74, h * 0.3, d * 0.74, h * 0.5);
    add(tier, x, z, w * 0.48, h * 0.28, d * 0.48, h * 0.8);
    top = h * 1.08;
    dressRoof(roofs, random, x, z, w * 0.48, d * 0.48, top);
  } else if (kind < 0.87) {
    // A round glass tower with a crown.
    roofs.rounds.push(at(x, 0, z, 0, w * 0.5, h, w * 0.5));
    roofs.crowns.push(at(x, h, z, 0, w * 0.56, 1.4, w * 0.56));
    roofs.skirts.push(at(x, 0.015, z, 0, w + 7, 1, w + 7));
  } else {
    // A glass slab.
    add(3, x, z, w * 1.1, h, d * 0.55);
    dressRoof(roofs, random, x, z, w * 1.1, d * 0.55, h);
  }
  if (tier === 2) {
    roofs.masts.push(at(mastX, top + 5, z, 0, 0.3, 10, 0.3));
    roofs.beacons.push(at(mastX, top + 10.2, z, 0, 0.55));
  }
};

export const addBuildings = (kit: Kit, site: Site): void => {
  const { track } = site;
  const { palette } = track.def;
  const { random } = kit;
  const walls = palette.walls.map((style) => new THREE.Color(style));
  const plots: Placement[][] = [[], [], [], []];
  const roofs: Roofscape = {
    beacons: [],
    boxes: [],
    crowns: [],
    domes: [],
    gables: [],
    masts: [],
    rounds: [],
    skirts: [],
    tanks: [],
  };
  for (let gx = -REACH; gx <= REACH; gx += BLOCK) {
    for (let gz = -REACH; gz <= REACH; gz += BLOCK) {
      const x = gx + BLOCK / 2 + (random() - 0.5) * 5;
      const z = gz + BLOCK / 2 + (random() - 0.5) * 5;
      const gap = site.distance(x, z) - track.rail;
      // Keep the infield mostly lawn, leave a verge beside the road, and leave
      // one plot in six open: a city has squares and car parks.
      const open = site.inside(x, z) ? random() < 0.8 : random() < 0.16;
      if (gap > 24 && Math.hypot(x, z) < REACH && !open) {
        const wall = walls[Math.floor(random() * walls.length)] ?? TINT;
        massPlot(plots, roofs, random, tierFor(gap, random()), x, z, wall);
      }
    }
  }

  const roofMaps = concrete("#7d7a86", 71);
  kit.own(roofMaps.map);
  kit.own(roofMaps.normalMap);
  kit.own(roofMaps.roughnessMap);
  const roof = kit.own(new THREE.MeshStandardMaterial({ ...roofMaps, roughness: 0.95 }));
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  let glass: THREE.MeshStandardMaterial | null = null;
  for (const [tier, placements] of plots.entries()) {
    // The fourth set is curtain wall: blue glass, glossy, a tighter grid.
    const curtain = tier === 3;
    const maps = facade(
      curtain ? "#6f9cc4" : "#e6e0e2",
      curtain ? "#e4f6ff" : palette.windows,
      90 + tier,
      TIERS[tier]?.rows ?? 30,
    );
    kit.own(maps.map);
    kit.own(maps.emissiveMap);
    const side = kit.own(
      new THREE.MeshStandardMaterial({
        emissive: "#ffffff",
        emissiveIntensity: 0.55,
        emissiveMap: maps.emissiveMap,
        map: maps.map,
        metalness: curtain ? 0.55 : 0,
        roughness: curtain ? 0.18 : 0.82,
      }),
    );
    glass = curtain ? side : glass;
    kit.instances(box.clone(), [side, side, roof, roof, side, side], placements);
  }
  if (glass) {
    const drum = new THREE.CylinderGeometry(1, 1, 1, 20).translate(0, 0.5, 0);
    kit.instances(drum, [glass, roof, roof], roofs.rounds);
  }
  kit.instances(
    new THREE.CylinderGeometry(1, 0.86, 1, 20).translate(0, 0.5, 0),
    roof,
    roofs.crowns,
  );
  const tile = kit.own(new THREE.MeshStandardMaterial({ roughness: 0.8 }));
  // A pitched roof: a three-sided prism lying along the house.
  const prism = new THREE.CylinderGeometry(0.5, 0.5, 1, 3, 1)
    .rotateX(Math.PI / 2)
    .rotateZ(Math.PI / 2)
    .scale(1, 2, 1)
    .translate(0, 0.5, 0);
  kit.instances(prism, tile, roofs.gables);
  kit.instances(
    new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    tile,
    roofs.domes,
  );
  kit.own(box);
  kit.instances(new THREE.BoxGeometry(1, 1, 1), roof, roofs.boxes);
  kit.instances(new THREE.CylinderGeometry(1, 1, 1, 12), roof, roofs.tanks);
  const metal = kit.own(new THREE.MeshStandardMaterial({ color: "#2b2b33", roughness: 0.6 }));
  kit.instances(new THREE.BoxGeometry(1, 1, 1), metal, roofs.masts, false);
  const beacon = kit.own(new THREE.MeshBasicMaterial({ color: "#ff3b30", toneMapped: false }));
  kit.instances(new THREE.SphereGeometry(1, 8, 6), beacon, roofs.beacons, false);
  const pad = kit.own(softSquare());
  const shade = kit.own(
    new THREE.MeshBasicMaterial({
      color: "#000000",
      depthWrite: false,
      map: pad,
      opacity: 0.55,
      transparent: true,
    }),
  );
  const skirts = kit.instances(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    shade,
    roofs.skirts,
    false,
  );
  skirts.renderOrder = 1;
};

// --- trees ---------------------------------------------------------------------

/**
 * Two species. Broadleaf: a tapered trunk under a canopy of five lobes, lighter
 * towards the top where the sun catches it. Conifer: three stacked cones.
 * Each stands in a pool of its own shade.
 */
export const addTrees = (kit: Kit, site: Site): Placement[] => {
  const { track } = site;
  const { random } = kit;
  const trunks: Placement[] = [];
  const leaves: Placement[] = [];
  const cones: Placement[] = [];
  const shade: Placement[] = [];
  const greens = ["#2f6b3a", "#3f8244", "#285a3a", "#4c8a3e", "#346f52", "#5a8f3a"].map(
    (style) => new THREE.Color(style),
  );
  for (let attempt = 0; attempt < 5000 && trunks.length < 260; attempt += 1) {
    const x = (random() - 0.5) * 430;
    const z = (random() - 0.5) * 430;
    const gap = site.distance(x, z) - track.rail;
    // Lawn trees anywhere in the infield; street trees in a band beside the road.
    const ok = gap > 4 && (site.inside(x, z) ? gap < 80 : gap < 17 && random() < 0.5);
    if (ok) {
      const size = 0.75 + random() * 1;
      const green = greens[Math.floor(random() * greens.length)] ?? WHITE;
      trunks.push(at(x, 0, z, random() * 6, size, size * (0.9 + random() * 0.5), size));
      shade.push(at(x, 0.02, z, 0, size * 7.5, 1, size * 7.5));
      if (random() < 0.3) {
        for (let tier = 0; tier < 3; tier += 1) {
          const r = size * (2 - tier * 0.5);
          const cone = at(x, size * (1.6 + tier * 1.5), z, random() * 6, r, size * 2.4, r);
          cone.color = green.clone().multiplyScalar(0.62 + tier * 0.16);
          cones.push(cone);
        }
      } else {
        const crown = 3 * size;
        for (let lobe = 0; lobe < 5; lobe += 1) {
          const high = lobe === 4;
          const angle = (lobe / 4) * Math.PI * 2 + random();
          const r = size * (high ? 1.5 : 1.25 + random() * 0.5);
          const leaf = at(
            x + (high ? 0 : Math.cos(angle) * size * 1.15),
            crown + (high ? size * 1.25 : random() * size * 0.6),
            z + (high ? 0 : Math.sin(angle) * size * 1.15),
            random() * 6,
            r,
            r * 0.86,
            r,
          );
          leaf.color = green.clone().multiplyScalar(high ? 1.22 : 0.74 + random() * 0.3);
          leaves.push(leaf);
        }
      }
    }
  }
  const bark = kit.own(new THREE.MeshStandardMaterial({ color: "#5a4030", roughness: 1 }));
  kit.instances(new THREE.CylinderGeometry(0.18, 0.42, 3.2, 8).translate(0, 1.6, 0), bark, trunks);
  const foliage = kit.own(new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.95 }));
  kit.instances(new THREE.IcosahedronGeometry(1, 1), foliage, leaves);
  kit.instances(new THREE.ConeGeometry(1, 1, 9).translate(0, 0.5, 0), foliage, cones);
  return shade;
};

// --- lamps, signs --------------------------------------------------------------

export const addLamps = (kit: Kit, track: Track): void => {
  const poles: Placement[] = [];
  const arms: Placement[] = [];
  const heads: Placement[] = [];
  const pools: Placement[] = [];
  const spacing = 30;
  for (let k = 0; k * spacing < track.n; k += 1) {
    const i = k * spacing + 12;
    const side = k % 2 === 0 ? 1 : -1;
    const base = pointAt(track, i, side * (track.rail + 1.7));
    const head = pointAt(track, i, side * (track.rail - 1.6));
    poles.push(at(base.x, 0, base.z));
    arms.push(at((base.x + head.x) / 2, 7.4, (base.z + head.z) / 2, -base.a + Math.PI / 2));
    heads.push(at(head.x, 7.25, head.z, -base.a));
    const pool = pointAt(track, i, side * (track.rail - 4));
    pools.push(at(pool.x, 0.045, pool.z, 0, 11, 1, 11));
  }
  const metal = kit.own(new THREE.MeshStandardMaterial({ color: "#30303a", roughness: 0.5 }));
  kit.instances(new THREE.CylinderGeometry(0.12, 0.17, 7.5, 8).translate(0, 3.75, 0), metal, poles);
  kit.instances(new THREE.BoxGeometry(3.5, 0.14, 0.14), metal, arms);
  const warm = new THREE.Color("#ffd9a0");
  const lamp = kit.own(
    new THREE.MeshBasicMaterial({ color: warm.clone().multiplyScalar(2.2), toneMapped: false }),
  );
  kit.instances(new THREE.BoxGeometry(1.1, 0.16, 0.46), lamp, heads, false);
  const disc = kit.own(softDisc());
  const glow = kit.own(
    new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color: warm.clone().multiplyScalar(0.3),
      depthWrite: false,
      map: disc,
      transparent: true,
    }),
  );
  const mesh = kit.instances(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    glow,
    pools,
    false,
  );
  mesh.renderOrder = 2;
};

export const addBillboards = (kit: Kit, track: Track): void => {
  const { palette } = track.def;
  const posts: Placement[] = [];
  const frame = kit.own(new THREE.MeshStandardMaterial({ color: "#6d7080", roughness: 0.6 }));
  const panel = new THREE.PlaneGeometry(10, 3.1);
  const back = new THREE.BoxGeometry(10.5, 3.6, 0.3);
  kit.own(panel);
  kit.own(back);
  for (const [k, text] of SIGNS.entries()) {
    const i = Math.round(((k + 0.5) / SIGNS.length) * track.n);
    const side = k % 2 === 0 ? -1 : 1;
    const p = pointAt(track, i, side * (track.rail + 5.5));
    const texture = kit.own(
      signTexture(
        text,
        k % 2 === 0 ? palette.accent : palette.accent2,
        k % 3 === 0 ? "#101018" : "#ffffff",
      ),
    );
    const board = new THREE.Group();
    board.position.set(p.x, 6.4, p.z);
    // Face the road: the panel's +z normal points back across the track.
    board.rotation.y = -p.a + (side > 0 ? 0 : Math.PI);
    const face = new THREE.Mesh(
      panel,
      kit.own(new THREE.MeshBasicMaterial({ color: "#d8d8d8", map: texture, toneMapped: false })),
    );
    face.position.z = 0.17;
    // The same sign on the back: a board seen from behind is still a sign.
    const reverse = face.clone();
    reverse.position.z = -0.17;
    reverse.rotation.y = Math.PI;
    const slab = new THREE.Mesh(back, frame);
    slab.castShadow = true;
    board.add(slab, face, reverse);
    kit.group.add(board);
    for (const offset of [-3.6, 3.6]) {
      const leg = pointAt(track, i + offset, side * (track.rail + 5.5));
      posts.push(at(leg.x, 0, leg.z));
    }
  }
  kit.instances(new THREE.BoxGeometry(0.3, 4.8, 0.3).translate(0, 2.4, 0), frame, posts);
};

// --- the start straight ----------------------------------------------------------

/** A box beam with diagonal bracing, lying along +x from the origin. */
const truss = (length: number, depth: number, material: THREE.Material): THREE.Group => {
  const group = new THREE.Group();
  const chord = new THREE.BoxGeometry(length, 0.14, 0.14);
  for (const y of [-depth / 2, depth / 2]) {
    for (const z of [-depth / 2, depth / 2]) {
      const bar = new THREE.Mesh(chord, material);
      bar.position.set(length / 2, y, z);
      bar.castShadow = true;
      group.add(bar);
    }
  }
  const bays = Math.max(2, Math.round(length / depth));
  const bay = length / bays;
  const brace = new THREE.BoxGeometry(Math.hypot(bay, depth), 0.09, 0.09);
  for (let i = 0; i < bays; i += 1) {
    for (const z of [-depth / 2, depth / 2]) {
      const bar = new THREE.Mesh(brace, material);
      bar.position.set(bay * (i + 0.5), 0, z);
      bar.rotation.z = (i % 2 === 0 ? 1 : -1) * Math.atan2(depth, bay);
      group.add(bar);
    }
  }
  return group;
};

export interface Gantry {
  /** The five start lights, left to right. */
  lights: THREE.MeshBasicMaterial[];
}

export const addGantry = (kit: Kit, track: Track): Gantry => {
  const { palette } = track.def;
  const line = pointAt(track, 0, 0);
  const span = (track.rail + 1.6) * 2;
  const gate = new THREE.Group();
  gate.position.set(line.x, 0, line.z);
  // Local +x runs across the road, local +z points back down the grid.
  gate.rotation.y = -line.a - Math.PI / 2;
  const steel = kit.own(new THREE.MeshStandardMaterial({ color: "#3a3a46", roughness: 0.45 }));
  for (const side of [-1, 1]) {
    const leg = truss(8.6, 0.9, steel);
    leg.rotation.z = Math.PI / 2;
    leg.position.set((side * span) / 2, 0, 0);
    gate.add(leg);
  }
  const beam = truss(span, 1.1, steel);
  beam.position.set(-span / 2, 8.4, 0);
  gate.add(beam);

  const checks = kit.own(checker(28, 2));
  const banner = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(span - 1.4, 1.3)),
    kit.own(
      new THREE.MeshStandardMaterial({ map: checks, roughness: 0.8, side: THREE.DoubleSide }),
    ),
  );
  banner.position.set(0, 7.1, 0.6);
  const title = kit.own(signTexture("GLOWLINE GP", palette.accent, "#101018"));
  const sign = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(13, 4.06)),
    kit.own(new THREE.MeshBasicMaterial({ color: "#e0e0e0", map: title, toneMapped: false })),
  );
  sign.position.set(0, 11.2, 0.62);
  const signBack = new THREE.Mesh(kit.own(new THREE.BoxGeometry(13.6, 4.6, 0.3)), steel);
  signBack.position.set(0, 11.2, 0.4);
  signBack.castShadow = true;
  gate.add(banner, sign, signBack);

  const lights: THREE.MeshBasicMaterial[] = [];
  const pod = kit.own(new THREE.BoxGeometry(6.4, 1.5, 0.5));
  const housing = new THREE.Mesh(pod, steel);
  housing.position.set(0, 5.6, 0.7);
  gate.add(housing);
  const bulb = kit.own(new THREE.SphereGeometry(0.42, 14, 10));
  for (let i = 0; i < 5; i += 1) {
    const material = kit.own(new THREE.MeshBasicMaterial({ color: "#2a0606", toneMapped: false }));
    const lamp = new THREE.Mesh(bulb, material);
    lamp.position.set((i - 2) * 1.2, 5.6, 1);
    gate.add(lamp);
    lights.push(material);
  }
  kit.group.add(gate);
  return { lights };
};

/** A tiered stand with a roof and a crowd, on the left of the start straight. */
export const addGrandstand = (kit: Kit, track: Track): void => {
  const { palette } = track.def;
  const { random } = kit;
  const mid = pointAt(track, 22, -(track.rail + 5.5));
  const stand = new THREE.Group();
  stand.position.set(mid.x, 0, mid.z);
  // Local +x runs along the road, local -z steps away from it.
  stand.rotation.y = -mid.a;
  const length = 52;
  const tiers = 7;
  const maps = concrete("#8e8a96", 61);
  kit.own(maps.map);
  kit.own(maps.normalMap);
  kit.own(maps.roughnessMap);
  const stone = kit.own(new THREE.MeshStandardMaterial({ ...maps, roughness: 0.9 }));
  const step = kit.own(new THREE.BoxGeometry(length, 1, 1.7));
  for (let t = 0; t < tiers; t += 1) {
    const slab = new THREE.Mesh(step, stone);
    slab.scale.y = 0.9 * (t + 1);
    slab.position.set(0, 0.45 * (t + 1), -t * 1.7);
    slab.castShadow = true;
    slab.receiveShadow = true;
    stand.add(slab);
  }
  const steel = kit.own(new THREE.MeshStandardMaterial({ color: "#34343f", roughness: 0.5 }));
  // Seat rows in two colours, aisles cut through them, and a rail along the front.
  const seatGeometry = kit.own(new THREE.BoxGeometry(length - 1, 0.34, 0.5));
  const seatColours = [palette.accent, palette.accent2].map((style) =>
    kit.own(new THREE.MeshStandardMaterial({ color: style, roughness: 0.6 })),
  );
  for (let t = 0; t < tiers; t += 1) {
    const seats = new THREE.Mesh(seatGeometry, seatColours[t % 2]);
    seats.position.set(0, 0.9 * (t + 1) + 0.17, -t * 1.7 - 0.5);
    stand.add(seats);
  }
  const aisle = kit.own(new THREE.BoxGeometry(1.3, 0.2, tiers * 1.7));
  for (const ax of [-length / 4, length / 4]) {
    const stair = new THREE.Mesh(aisle, steel);
    stair.position.set(ax, (tiers * 0.9) / 2 + 0.75, -((tiers - 1) * 1.7) / 2);
    stair.rotation.x = Math.atan2(0.9, 1.7);
    stand.add(stair);
  }
  const frontRail = new THREE.Mesh(kit.own(new THREE.BoxGeometry(length, 0.1, 0.1)), steel);
  frontRail.position.set(0, 1.95, 0.95);
  stand.add(frontRail);
  const baluster = kit.own(new THREE.BoxGeometry(0.08, 1.1, 0.08));
  for (let i = 0; i <= 26; i += 1) {
    const post = new THREE.Mesh(baluster, steel);
    post.position.set(-length / 2 + (i * length) / 26, 1.45, 0.95);
    stand.add(post);
  }
  const roof = new THREE.Mesh(
    kit.own(new THREE.BoxGeometry(length + 3, 0.35, tiers * 1.7 + 4)),
    steel,
  );
  roof.position.set(0, tiers * 0.9 + 5.2, -(tiers * 1.7) / 2 + 1.2);
  roof.rotation.x = 0.09;
  roof.castShadow = true;
  stand.add(roof);
  const post = kit.own(new THREE.BoxGeometry(0.3, tiers * 0.9 + 5.2, 0.3));
  for (let i = 0; i <= 6; i += 1) {
    const column = new THREE.Mesh(post, steel);
    column.position.set(
      -length / 2 + (i * length) / 6,
      (tiers * 0.9 + 5.2) / 2,
      -tiers * 1.7 + 0.4,
    );
    column.castShadow = true;
    stand.add(column);
  }
  const fascia = new THREE.Mesh(
    kit.own(new THREE.BoxGeometry(length + 3, 1, 0.2)),
    kit.own(
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(palette.accent).multiplyScalar(1.1),
        toneMapped: false,
      }),
    ),
  );
  fascia.position.set(0, tiers * 0.9 + 4.6, 3.2);
  stand.add(fascia);
  kit.group.add(stand);

  // The crowd: one small figure per seat, most seats taken.
  const people: Placement[] = [];
  const shirts = [palette.accent, palette.accent2, "#f4f1ea", "#ffd23f", "#3d6bff", "#e8503a"].map(
    (style) => new THREE.Color(style),
  );
  const cos = Math.cos(stand.rotation.y);
  const sin = Math.sin(stand.rotation.y);
  for (let t = 0; t < tiers; t += 1) {
    for (let seat = 0; seat < 58; seat += 1) {
      if (random() < 0.78) {
        const lx = -length / 2 + 1 + seat * 0.88;
        const lz = -t * 1.7 + 0.2;
        const person = at(
          mid.x + lx * cos + lz * sin,
          0.9 * (t + 1) + 0.45,
          mid.z - lx * sin + lz * cos,
          0,
          0.5,
          0.75 + random() * 0.25,
          0.4,
        );
        person.color = (shirts[Math.floor(random() * shirts.length)] ?? shirts[0])
          ?.clone()
          .multiplyScalar(0.7 + random() * 0.4);
        people.push(person);
      }
    }
  }
  // Each spectator is a body and a head, so the stand reads as people.
  const skins = ["#f1c9a5", "#d9a47a", "#a8703f", "#7b4a2a", "#f6d7bd"].map(
    (style) => new THREE.Color(style),
  );
  const heads = people.map((person) => {
    const head = at(person.x, person.y + 0.62 * person.sy + 0.2, person.z, 0, 0.21);
    head.color = skins[Math.floor(random() * skins.length)];
    return head;
  });
  // One in three has an arm in the air.
  const arms = people
    .filter((_, i) => i % 3 === 0)
    .map((person) => {
      const arm = at(person.x, person.y + 0.75 * person.sy, person.z, 0, 0.09, 0.5, 0.09);
      arm.color = person.color;
      return arm;
    });
  const cloth = kit.own(new THREE.MeshStandardMaterial({ roughness: 1 }));
  kit.instances(new THREE.CapsuleGeometry(0.42, 0.5, 2, 8), cloth, people, false);
  kit.instances(new THREE.CapsuleGeometry(1, 1, 2, 6).translate(2.6, 0, 0), cloth, arms, false);
  kit.instances(new THREE.SphereGeometry(1, 10, 8), cloth, heads, false);
};

/** A long low pit building with lit garage bays, on the right of the start straight. */
export const addPits = (kit: Kit, track: Track): void => {
  const { palette } = track.def;
  const mid = pointAt(track, 22, track.rail + 9);
  const pits = new THREE.Group();
  pits.position.set(mid.x, 0, mid.z);
  pits.rotation.y = -mid.a;
  const maps = facade("#b9b3c2", palette.windows, 140, 2);
  kit.own(maps.map);
  kit.own(maps.emissiveMap);
  maps.map.repeat.set(3, 1);
  maps.map.wrapS = THREE.RepeatWrapping;
  maps.emissiveMap.repeat.set(3, 1);
  maps.emissiveMap.wrapS = THREE.RepeatWrapping;
  const wall = kit.own(
    new THREE.MeshStandardMaterial({
      emissive: "#ffffff",
      emissiveIntensity: 0.9,
      emissiveMap: maps.emissiveMap,
      map: maps.map,
      roughness: 0.8,
    }),
  );
  const body = new THREE.Mesh(kit.own(new THREE.BoxGeometry(56, 6.5, 9)), wall);
  body.position.y = 3.25;
  body.castShadow = true;
  body.receiveShadow = true;
  const steel = kit.own(new THREE.MeshStandardMaterial({ color: "#2c2c36", roughness: 0.5 }));
  const cap = new THREE.Mesh(kit.own(new THREE.BoxGeometry(58, 0.5, 11)), steel);
  cap.position.y = 6.75;
  cap.castShadow = true;
  const title = kit.own(signTexture("PIT LANE", palette.accent2, "#ffffff"));
  const sign = new THREE.Mesh(
    kit.own(new THREE.PlaneGeometry(12, 3.75)),
    kit.own(new THREE.MeshBasicMaterial({ color: "#d8d8d8", map: title, toneMapped: false })),
  );
  sign.position.set(0, 9.2, -5.4);
  sign.rotation.y = Math.PI;
  const signBack = new THREE.Mesh(kit.own(new THREE.BoxGeometry(12.6, 4.3, 0.3)), steel);
  signBack.position.set(0, 9.2, -5.2);
  signBack.castShadow = true;
  pits.add(body, cap, sign, signBack);
  // Garage bays: a dark opening with a coloured lintel and a roller door half up.
  const bay = kit.own(new THREE.BoxGeometry(5.4, 3.6, 0.3));
  const dark = kit.own(new THREE.MeshStandardMaterial({ color: "#1a1b24", roughness: 0.9 }));
  const lintel = kit.own(new THREE.BoxGeometry(5.8, 0.5, 0.5));
  const door = kit.own(new THREE.BoxGeometry(5.2, 1.3, 0.14));
  const rail = kit.own(new THREE.BoxGeometry(58, 0.1, 0.1));
  const stanchion = kit.own(new THREE.BoxGeometry(0.1, 1.1, 0.1));
  const paints = [palette.accent, palette.accent2, "#ffd23f", "#f4f1ea"].map((style) =>
    kit.own(new THREE.MeshStandardMaterial({ color: style, roughness: 0.5 })),
  );
  for (let i = 0; i < 8; i += 1) {
    const x = -24.5 + i * 7;
    const opening = new THREE.Mesh(bay, dark);
    opening.position.set(x, 1.8, -4.45);
    const top = new THREE.Mesh(lintel, paints[i % paints.length]);
    top.position.set(x, 3.85, -4.6);
    top.castShadow = true;
    const shutter = new THREE.Mesh(door, steel);
    shutter.position.set(x, 3, -4.62);
    pits.add(opening, top, shutter);
  }
  // A roof-terrace handrail, and tool carts and tyre sets out on the apron.
  const handrail = new THREE.Mesh(rail, steel);
  handrail.position.set(0, 8.1, -5.3);
  pits.add(handrail);
  for (let i = 0; i <= 14; i += 1) {
    const post = new THREE.Mesh(stanchion, steel);
    post.position.set(-28 + i * 4, 7.55, -5.3);
    pits.add(post);
  }
  const cart = kit.own(new RoundedBoxGeometry(1.5, 1.1, 0.9, 2, 0.08));
  const stack = kit.own(new THREE.CylinderGeometry(0.45, 0.45, 1.5, 12));
  const rubber = kit.own(new THREE.MeshStandardMaterial({ color: "#15151a", roughness: 0.9 }));
  for (let i = 0; i < 8; i += 1) {
    const x = -24.5 + i * 7;
    const tools = new THREE.Mesh(cart, paints[(i + 1) % paints.length]);
    tools.position.set(x - 1.6, 0.6, -6.6);
    tools.castShadow = true;
    const tyres = new THREE.Mesh(stack, rubber);
    tyres.position.set(x + 1.7, 0.75, -6.4);
    tyres.castShadow = true;
    pits.add(tools, tyres);
  }
  kit.group.add(pits);
};

// --- splat pads --------------------------------------------------------------------

const chevrons = (): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 12;
    ctx.lineJoin = "miter";
    for (let i = 0; i < 3; i += 1) {
      ctx.globalAlpha = 0.45 + i * 0.25;
      ctx.beginPath();
      ctx.moveTo(18 + i * 28, 10);
      ctx.lineTo(128, 60 - i * 4);
      ctx.lineTo(238 - i * 28, 10);
      ctx.stroke();
      ctx.translate(0, 13);
    }
  }
  return new THREE.CanvasTexture(canvas);
};

/** One material per pad (so each can dim while it rests), plus a nozzle post either side. */
export const addPads = (kit: Kit, track: Track): THREE.MeshBasicMaterial[] => {
  const map = kit.own(chevrons());
  const geometry = kit.own(
    new THREE.PlaneGeometry(track.halfWidth * 1.5, 4.2).rotateX(-Math.PI / 2),
  );
  const materials: THREE.MeshBasicMaterial[] = [];
  const nozzles: Placement[] = [];
  for (const index of track.pads) {
    const p = pointAt(track, index, 0);
    const material = kit.own(
      new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        map,
        toneMapped: false,
        transparent: true,
      }),
    );
    const pad = new THREE.Mesh(geometry, material);
    pad.position.set(p.x, 0.05, p.z);
    pad.rotation.y = -p.a + Math.PI / 2;
    pad.renderOrder = 3;
    kit.group.add(pad);
    materials.push(material);
    for (const side of [-1, 1]) {
      const post = pointAt(track, wrapIndex(index, track.n), side * (track.halfWidth + 1.2));
      nozzles.push(at(post.x, 0, post.z));
    }
  }
  const steel = kit.own(new THREE.MeshStandardMaterial({ color: "#4a4a58", roughness: 0.35 }));
  kit.instances(
    new THREE.CylinderGeometry(0.34, 0.5, 2.2, 10).translate(0, 1.1, 0),
    steel,
    nozzles,
  );
  return materials;
};
