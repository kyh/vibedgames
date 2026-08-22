// CPU-side procedural geometry for the spell FX: faceted crystals (frost
// eruptions, bog thorns, stone teeth) and cratered rock (meteors, debris).
//
// Ported from the Elemental Sandbox VFX sandbox (MIT, Copyright (c) 2026
// mohamedachrefelouafi) — https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS
//
// Shapes are deterministic in `seed`, so a given eruption always throws up the
// same field and a cache keyed on the shape params is safe.
import * as THREE from "three";

const TAU = Math.PI * 2;

function hash11(p: number): number {
  let x = (p * 0.1031) % 1;
  if (x < 0) x += 1;
  x *= x + 33.33;
  x *= x + x;
  return x % 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ── crystals ────────────────────────────────────────────────────────────────

/** Ring heights the crystal profile is sampled at, base (0) to shoulder. */
const RING_HEIGHTS = [0, 0.22, 0.5, 0.75, 0.92] as const;

export type CrystalOpts = {
  seed?: number;
  sides?: number; // facets around the prism — 5..8 read best
  taper?: number; // tip radius as a fraction of the base
  roughness?: number; // how far facets are pushed off a clean prism
  bend?: number; // sideways curve from base to tip
};

/**
 * One crystal: a tapered, faceted, slightly bent prism.
 *
 * Unit space — base ring on y=0 with a circumscribed radius of 0.5, apex at
 * y=1. An instance scales footprint and height independently, and `local.y`
 * reads straight off as "how far up this crystal am I", which is what the rime
 * banding in the ice material keys off.
 */
export function createCrystalGeometry({
  seed = 1,
  sides = 6,
  taper = 0.13,
  roughness = 0.28,
  bend = 0.22,
}: CrystalOpts = {}): THREE.BufferGeometry {
  const facets = Math.max(3, Math.round(sides));
  const tipRadius = clamp(taper, 0.01, 0.9);

  // One fixed bend direction per crystal, so a field leans convincingly instead
  // of every spike curving the same way.
  const bendAngle = hash11(seed * 1.77) * TAU;
  const bendX = Math.cos(bendAngle);
  const bendZ = Math.sin(bendAngle);
  const axisOffset = (t: number) => bend * 0.5 * Math.pow(t, 1.6);

  // Angles are jittered once and shared by every ring, so facets stay
  // continuous edges up the crystal rather than twisting into a screw.
  const angles: number[] = [];
  for (let i = 0; i < facets; i++) {
    const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / facets) * 0.55 * roughness * 3;
    angles.push((i / facets) * TAU + jitter);
  }

  type Pt = readonly [number, number, number];
  const rings: Pt[][] = RING_HEIGHTS.map((t, ringIndex) => {
    const profile = tipRadius + (1 - tipRadius) * Math.pow(1 - t, 1.15);
    const baseR = profile * 0.5;
    const drift = axisOffset(t);
    // Height wobble keeps the shoulder lines from stacking into clean bands.
    const y = t + (hash11(seed * 5.9 + ringIndex * 2.3) - 0.5) * 0.06 * roughness * (t > 0 ? 1 : 0);

    return angles.map((angle, i) => {
      // Irregularity grows toward the tip: a crystal is roughly round where it
      // leaves the ground and increasingly ragged where it was torn.
      const wobble =
        1 +
        (hash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) *
          roughness *
          1.3 *
          (0.35 + 0.65 * t);
      const r = Math.max(0.002, baseR * wobble);
      return [Math.cos(angle) * r + bendX * drift, y, Math.sin(angle) * r + bendZ * drift] as const;
    });
  });

  // The apex sits a little off-axis so the tip reads as chipped rather than as
  // the vertex of a cone.
  const apexDrift = axisOffset(1);
  const apex: Pt = [
    bendX * apexDrift + (hash11(seed * 17.3) - 0.5) * 0.09 * roughness,
    1,
    bendZ * apexDrift + (hash11(seed * 19.7) - 0.5) * 0.09 * roughness,
  ];
  const floorCentre: Pt = [0, 0, 0];

  const positions: number[] = [];
  const push = (p: Pt | undefined) => {
    if (p) positions.push(p[0], p[1], p[2]);
  };

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring];
    const upper = rings[ring + 1];
    if (!lower || !upper) continue;
    for (let i = 0; i < facets; i++) {
      const j = (i + 1) % facets;
      push(lower[i]);
      push(lower[j]);
      push(upper[i]);
      push(lower[j]);
      push(upper[j]);
      push(upper[i]);
    }
  }

  const top = rings[rings.length - 1];
  const base = rings[0];
  if (top && base) {
    for (let i = 0; i < facets; i++) {
      const j = (i + 1) % facets;
      push(top[i]);
      push(top[j]);
      push(apex);
      push(floorCentre);
      push(base[j]);
      push(base[i]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // Non-indexed + per-face normals: this is what makes the facets crisp.
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A short, wide shard — the ankle-height rubble that fills in around the main
 * spikes. Same unit space, so it instances through the identical path.
 */
export function createShardGeometry(seed = 5, sides = 5): THREE.BufferGeometry {
  return createCrystalGeometry({
    seed: seed * 2.7 + 41,
    sides,
    taper: 0.22,
    roughness: 0.55,
    bend: 0.35,
  });
}

// ── rock ────────────────────────────────────────────────────────────────────

function lattice(ix: number, iy: number, iz: number, seed: number): number {
  return hash11(ix * 127.1 + iy * 311.7 + iz * 74.7 + seed * 19.19);
}

/**
 * Deterministic 3D value noise, 0..1. The GLSL library has simplex, but the
 * rock is displaced on the CPU — a vertex shader cannot move a shadow caster's
 * silhouette or its normals — so it needs a JS counterpart.
 */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = lattice(ix, iy, iz, seed);
  const c100 = lattice(ix + 1, iy, iz, seed);
  const c010 = lattice(ix, iy + 1, iz, seed);
  const c110 = lattice(ix + 1, iy + 1, iz, seed);
  const c001 = lattice(ix, iy, iz + 1, seed);
  const c101 = lattice(ix + 1, iy, iz + 1, seed);
  const c011 = lattice(ix, iy + 1, iz + 1, seed);
  const c111 = lattice(ix + 1, iy + 1, iz + 1, seed);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;

  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;

  return y0 + (y1 - y0) * uz;
}

/** Signed fbm over `valueNoise3`, roughly -1..1. */
function fbmValue(x: number, y: number, z: number, seed: number, octaves: number): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value +=
      amplitude *
      (valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 7.7) * 2 - 1);
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

export type RockOpts = {
  seed?: number;
  detail?: number; // icosphere subdivisions, 0..3
  lumpiness?: number; // low-frequency deformation, × radius
  noiseScale?: number;
  roughness?: number; // high-frequency chipping
  cuts?: number; // planar fracture faces sliced off it
  cutDepth?: number;
  craters?: number;
  craterDepth?: number;
  craterSize?: number; // angular radius, radians
};

/**
 * A meteor: a fractured, cratered ball of rock. Unit space — an icosphere of
 * radius 1 pushed in and out along its own vertex directions, so `local` reads
 * as a direction on the rock and the lava-seam shader can weld its cracks to
 * the surface instead of letting them swim as it tumbles.
 *
 * The planar cuts are the part that matters: slicing the ball with random
 * half-spaces leaves genuinely flat faces meeting at hard edges, which is what
 * separates this from a displaced sphere. Craters are punched first so a cut
 * can shear one in half.
 */
export function createRockGeometry({
  seed = 1,
  detail = 2,
  lumpiness = 0.26,
  noiseScale = 1.5,
  roughness = 0.16,
  cuts = 7,
  cutDepth = 0.2,
  craters = 5,
  craterDepth = 0.18,
  craterSize = 0.5,
}: RockOpts = {}): THREE.BufferGeometry {
  // Non-indexed is what keeps the facets flat: duplicated vertices share a
  // direction, so the displacement below moves them identically and the mesh
  // cannot split open. Polyhedron geometries already arrive that way.
  const base = new THREE.IcosahedronGeometry(1, clamp(Math.round(detail), 0, 3));
  const geometry = base.index ? base.toNonIndexed() : base;
  const posAttr = geometry.getAttribute("position");

  /** A deterministic point on the unit sphere. */
  const direction = (a: number, b: number) => {
    const phi = Math.acos(2 * hash11(a) - 1);
    const theta = hash11(b) * TAU;
    const sinPhi = Math.sin(phi);
    return { x: sinPhi * Math.cos(theta), y: Math.cos(phi), z: sinPhi * Math.sin(theta) };
  };

  const planes: { x: number; y: number; z: number; offset: number }[] = [];
  for (let i = 0; i < Math.max(0, Math.round(cuts)); i++) {
    const n = direction(seed * 2.3 + i * 9.1, seed * 5.7 + i * 4.3);
    // How far along its own normal the plane sits: 1 is tangent (no bite), less
    // shaves a face off. Kept high enough that a cut never lops the rock in half.
    planes.push({
      ...n,
      offset: 1 - cutDepth * (0.35 + 0.9 * hash11(seed * 13.1 + i * 6.7)),
    });
  }

  const bowls: { x: number; y: number; z: number; radius: number; depth: number }[] = [];
  for (let i = 0; i < Math.max(0, Math.round(craters)); i++) {
    const c = direction(seed * 3.1 + i * 12.9, seed * 7.7 + i * 5.3);
    bowls.push({
      ...c,
      radius: Math.max(0.08, craterSize * (0.45 + 0.8 * hash11(seed * 11.3 + i * 3.7))),
      depth: craterDepth * (0.5 + hash11(seed * 17.9 + i * 2.1)),
    });
  }

  for (let v = 0; v < posAttr.count; v++) {
    // IcosahedronGeometry(1) hands us unit-length vertices already.
    const x = posAttr.getX(v);
    const y = posAttr.getY(v);
    const z = posAttr.getZ(v);

    let radius = 1;
    radius += fbmValue(x * noiseScale, y * noiseScale, z * noiseScale, seed, 3) * lumpiness;
    radius +=
      fbmValue(x * noiseScale * 4.3, y * noiseScale * 4.3, z * noiseScale * 4.3, seed + 31.7, 2) *
      roughness *
      0.5;

    for (const bowl of bowls) {
      const angle = Math.acos(clamp(x * bowl.x + y * bowl.y + z * bowl.z, -1, 1));
      const q = angle / bowl.radius;
      if (q >= 1.4) continue;
      radius -= bowl.depth * Math.max(0, 1 - q * q);
      radius += bowl.depth * 0.5 * smoothstep(0.72, 1.0, q) * (1 - smoothstep(1.0, 1.4, q));
    }

    radius = Math.max(0.35, radius);
    let px = x * radius;
    let py = y * radius;
    let pz = z * radius;

    for (const plane of planes) {
      const over = px * plane.x + py * plane.y + pz * plane.z - plane.offset;
      if (over <= 0) continue;
      // Project back onto the plane: every vertex outside lands *on* it, so the
      // result is a genuinely flat facet, not a squashed curve.
      px -= plane.x * over;
      py -= plane.y * over;
      pz -= plane.z * over;
    }

    posAttr.setXYZ(v, px, py, pz);
  }

  posAttr.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
