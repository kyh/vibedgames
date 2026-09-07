// The floor under Grimelda's Cauldron Brew: stone with acid standing in it.
//
// Ported from the Elemental Sandbox VFX sandbox (MIT, Copyright (c) 2026
// mohamedachrefelouafi) — https://github.com/achrefelouafi/LinearAbiltyCastingExtendedThreeJS
// (the "Caustic Bloom" pool), re-graded from its chartreuse to the witch's bog
// green and run at two noise octaves instead of three.
//
// Three decisions carry it, and they are all about the difference between a
// POOL and a green light on the floor:
//
//   It is alpha blended, not additive. The brew has to eat the floor — darken
//   the stone, sink the crazing into it, sit WET on top of it. Additive can
//   only ever add, so an additive pool is a decal that glows.
//
//   The surface is glossy. Everything else on this stage is rough, and one
//   Blinn highlight off a fake normal (a height field differentiated in world
//   space with screen derivatives) is the cheapest thing that says liquid.
//
//   The boundary is corroded, not circular. The outline is pushed around by
//   a low-frequency noise on the bearing and bitten into by a higher one, so
//   the pool has bays and headlands. A clean disc reads as a decal whatever is
//   drawn inside it.
//
// On top of that: gas coming OUT of it. `surfaceBoil` gives every cell of a
// jittered grid its own clock and draws the expanding rim of one bubble
// breaking the surface — the floor pops continuously without a single
// particle (the particle bubbles fx.ts adds on top are the ones that leave it).
//
// Everything is drawn in METRES from the centre, so the crazing keeps its
// physical width whatever the zone radius is.
import * as THREE from "three";
import { NOISE_GLSL } from "./fx-noise";

const POOL = {
  plates: 0.62, // plates per metre
  craze: 0.55, // the finer network laid over them
  warp: 0.45, // domain warp on the cell centres
  seam: 0.05, // width of a channel, cell space
  seamGlow: 1.15,
  crust: 0.95, // how opaque the sludge crust is
  relief: 0.8, // fake lighting across the plates
  sheen: 0.32, // the specular lobe — what says "wet"
  gloss: 0.42, // 0 = broad and dull, 1 = a tight highlight
  etch: 0.35, // how much the growing edge is chewed by its own noise
  etchScale: 1.6,
  pits: 0.12, // fraction of plates eaten clean through
  pitScale: 1.6, // pits per metre
  boilRate: 0.5, // surface bubbles bursting, per second per cell
  heat: 0.55, // master brightness of the live acid
  heatFalloff: 1.4, // how fast it goes inert toward the boundary
  flow: 0.5, // how fast brightness crawls along a channel
  caustic: 0.25, // interference on the standing acid
  causticScale: 2.2,
  boundary: 0.16, // the bleached band on the footprint, metres
  boundaryGlow: 0.4,
  core: 0.12, // the brighter pool in the middle
  coreSize: 0.4, // its radius, × footprint
  rings: 1.3, // pressure rings running out of the middle
  ringSpeed: 0.4,
  /** Metres of quad per metre of footprint: room for the bays and the lip. */
  quad: 2.6,
} as const;

/** Grimelda's grade. */
const BOG = {
  sludge: 0x0a1104,
  plate: 0x24310c,
  acid: 0x86f07a,
  hot: 0xdcffb0,
  edge: 0x9fefa8,
} as const;

const VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vViewDir;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vViewDir = cameraPosition - world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const FRAG = /* glsl */ `
#define TAU 6.283185307179586
uniform float uTime;
uniform float uQuadSize;
uniform float uRadius;
uniform float uGrown;   // how far the corrosion has spread, metres
uniform float uFront;   // brightness of the leading edge, 0 once it lands
uniform float uSpent;   // 1 fresh → the acid going inert
uniform float uBoil;    // the surge envelope
uniform float uSeed;
uniform float uFade;
uniform vec3  uColorSludge;
uniform vec3  uColorCrust;
uniform vec3  uColorAcid;
uniform vec3  uColorHot;
uniform vec3  uColorEdge;
varying vec2 vUv;
varying vec3 vViewDir;

${NOISE_GLSL}

const vec3 LIGHT_DIR = normalize(vec3(0.44, 0.83, 0.29)); // the arena sun

float snoise01(vec3 p) { return snoise(p) * 0.5 + 0.5; }
vec2 hash21(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/** Nearest-cell voronoi: x = distance to the nearest centre, y = its hash. */
vec2 voronoi2(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  float md = 8.0;
  float id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md = d; id = nhash11(dot(n + g, vec2(31.7, 57.1))); }
    }
  }
  return vec2(sqrt(md), id);
}

/**
 * Two-nearest voronoi: x = distance to the nearest cell EDGE, y = a hash of
 * the winning cell. The second loop walks the winner's neighbours and
 * measures the distance to each bisector — the standard crack-network
 * construction, and the reason these seams fork and meet at proper junctions
 * instead of ending in mid-air.
 */
vec2 voronoiEtch(vec2 p) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  float md = 8.0;
  float id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; id = nhash11(dot(n + g, vec2(31.7, 57.1))); }
    }
  }
  float edge = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
      vec2 r = g + o - f;
      vec2 diff = r - mr;
      float dd = dot(diff, diff);
      if (dd > 1e-5) edge = min(edge, dot(0.5 * (mr + r), normalize(diff)));
    }
  }
  return vec2(edge, id);
}

/**
 * Gas breaking the surface: a jittered grid where every cell keeps its own
 * clock and size and draws the expanding rim of one bubble. Because the phase
 * is a fract() of a per-cell rate the pool boils continuously without any two
 * cells ever being in step. Returns (rim brightness, the dark crater under it).
 */
vec2 surfaceBoil(vec2 p, float scale, float rate, float seed) {
  vec2 g = p * scale;
  vec2 n = floor(g);
  vec2 f = fract(g);
  float rim = 0.0;
  float crater = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      float cell = dot(n + o, vec2(41.3, 289.1)) + seed;
      float id = nhash11(cell);
      vec2 jitter = hash21(cell * 1.37);
      float phase = fract(uTime * rate * (0.45 + id * 1.1) + id * 9.0);
      float size = 0.16 + id * 0.30;
      float r = phase * size;
      float d = length(o + jitter - f);
      float w = max(0.018, size * 0.22 * (1.0 - phase * 0.6));
      float ring = smoothstep(w, 0.0, abs(d - r)) * (1.0 - phase) * (1.0 - phase);
      rim = max(rim, ring);
      crater = max(crater, smoothstep(r, r * 0.2, d) * (1.0 - phase) * 0.8);
    }
  }
  return vec2(rim, crater);
}

void main() {
  vec2 p = vec2(vUv.x - 0.5, 0.5 - vUv.y) * uQuadSize;
  float rad = length(p);
  vec2 dir = rad > 1e-4 ? p / rad : vec2(1.0, 0.0);

  /* ---- the corroded boundary ---- */
  float bearing = fbm2(vec3(dir * 1.9, uSeed)) * 0.5 + 0.5;
  float bite = snoise01(vec3(dir * 5.4, uSeed * 3.1 + uTime * 0.05));
  // Held INSIDE the footprint: the telegraph's hostile rim runs around the
  // zone's true radius, and a pool that spilled past it would lie about where
  // the burn stops.
  float outer = min(uRadius, uRadius * (0.80 + bearing * 0.16 + bite * 0.05) + ${POOL.boundary.toFixed(3)} * 0.5);
  float aa = fwidth(rad) + 0.02;
  if (rad > outer + aa * 6.0) discard;

  /* ---- how much detail this pixel can actually resolve ---- */
  // Metres of floor one pixel covers: a centimetre near the camera, tens of
  // centimetres out where the floor is nearly edge-on. Fading the fine terms
  // as the footprint outgrows their features is what a mip chain does for a
  // texture, and it is the only thing that keeps a procedural surface from
  // sparkling into white speckle at a grazing angle.
  float footprint = max(fwidth(p.x), fwidth(p.y));
  float detail = 1.0 - smoothstep(0.02, 0.13, footprint);

  /* ---- the etched stone ---- */
  vec2 warp = vec2(fbm2(vec3(p * 0.6, uSeed)), fbm2(vec3(p * 0.6, uSeed + 23.1))) * ${POOL.warp.toFixed(3)};
  vec2 plate = voronoiEtch((p + warp) * ${POOL.plates.toFixed(3)});
  // A second, much finer network over the first: acid does not shatter stone
  // into plates the way heat does — it CRAZES it.
  vec2 craze = voronoiEtch((p - warp * 0.4) * ${(POOL.plates * 4.3).toFixed(3)} + 31.7);

  float seamA = 1.0 - smoothstep(0.0, ${POOL.seam.toFixed(3)}, plate.x);
  float seamB = 1.0 - smoothstep(0.0, ${(POOL.seam * 1.6).toFixed(3)}, craze.x);
  float seam = max(seamA, seamB * ${POOL.craze.toFixed(3)} * detail);
  // The wide bleached lip either side of a channel — where the acid has wicked
  // into the stone. A channel is a stain first and a light second.
  float lip = max(1.0 - smoothstep(${POOL.seam.toFixed(3)}, ${(POOL.seam * 3.4).toFixed(3)}, plate.x),
                  (1.0 - smoothstep(${POOL.seam.toFixed(3)}, ${(POOL.seam * 3.0).toFixed(3)}, craze.x)) * ${(POOL.craze * 0.6).toFixed(3)} * detail);

  /* ---- pits eaten clean through ---- */
  vec2 pitCell = voronoi2(p * ${POOL.pitScale.toFixed(3)} + uSeed * 5.0);
  float pitMask = step(${(1 - POOL.pits).toFixed(3)}, pitCell.y);
  float pit = pitMask * smoothstep(0.42, 0.16, pitCell.x);
  float pitRim = pitMask * smoothstep(0.10, 0.0, abs(pitCell.x - 0.34));

  /* ---- relief ---- */
  float grain = fbm2(vec3(p * 3.4, uSeed * 5.0)) * 0.5 + 0.5;
  // Plates stand proud, channels and pits are sunk, grain on top. The gradient
  // is taken in WORLD space — screen derivatives of p invert the pixel
  // footprint — so the lighting is right however the camera is angled.
  float height = smoothstep(0.0, ${(POOL.seam * 3).toFixed(3)}, plate.x) * 0.7 + grain * 0.3 - pit * 0.55;
  vec2 dpx = dFdx(p);
  vec2 dpy = dFdy(p);
  float det = dpx.x * dpy.y - dpx.y * dpy.x;
  vec2 grad = vec2(0.0);
  if (abs(det) > 1e-9) {
    float hx = dFdx(height);
    float hy = dFdy(height);
    grad = vec2(hx * dpy.y - hy * dpx.y, -hx * dpy.x + hy * dpx.x) / det;
  }
  vec3 N = normalize(vec3(-grad.x * ${POOL.relief.toFixed(3)}, 1.0, -grad.y * ${POOL.relief.toFixed(3)}));
  float lambert = clamp(dot(N, LIGHT_DIR), 0.0, 1.0);

  /* ---- it is wet ---- */
  vec3 V = normalize(vViewDir);
  vec3 H = normalize(LIGHT_DIR + V);
  float spec = pow(clamp(dot(N, H), 0.0, 1.0), ${(8 + 82 * POOL.gloss).toFixed(2)}) * ${POOL.sheen.toFixed(3)};
  // The bleached lip is dry stone, not liquid: a tight lobe left running
  // across it draws one continuous jagged highlight over the whole pool.
  spec *= (1.0 - lip * 0.65) * detail;
  float sheen = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * ${(POOL.sheen * 0.35).toFixed(3)};

  /* ---- how live the acid still is ---- */
  float surge = 1.0 + uBoil;
  float radial = clamp(rad / max(uRadius, 0.05), 0.0, 1.0);
  float heat = ${POOL.heat.toFixed(3)} * uSpent * pow(1.0 - radial, ${POOL.heatFalloff.toFixed(3)});
  // Not static: brightness crawls along the inside of every channel.
  float pump = 0.5 + 0.5 * (snoise(vec3(p * 1.7, uTime * ${POOL.flow.toFixed(3)} + uSeed * 3.0)) * 0.5 + 0.5);
  heat *= pump * surge;

  // Caustics on the standing acid, drawn where the crust is NOT.
  vec2 cp = p * ${POOL.causticScale.toFixed(3)};
  float c1 = snoise(vec3(cp, uTime * 0.7 + uSeed));
  float c2 = snoise(vec3(cp * 1.43 + 11.0, -uTime * 0.53 + uSeed));
  float caustic = pow(clamp(1.0 - abs(c1 + c2) * 0.9, 0.0, 1.0), 6.0) * ${POOL.caustic.toFixed(3)} * uSpent * detail;

  /* ---- gas coming off it ---- */
  vec2 boil = surfaceBoil(p, ${(POOL.pitScale * 0.62).toFixed(3)}, ${POOL.boilRate.toFixed(3)}, uSeed * 11.0) * detail;

  /* ---- the corrosion racing out to the boundary ---- */
  float open = smoothstep(uGrown + 0.25, uGrown - 0.5, rad);
  // Eaten rather than wiped in: the growing edge is chewed by its own noise,
  // so the pool spreads the way a stain does.
  float chew = snoise01(vec3(p * ${POOL.etchScale.toFixed(3)}, uSeed * 7.0)) * ${POOL.etch.toFixed(3)};
  open = clamp(open - chew * smoothstep(uGrown - 1.2, uGrown + 0.1, rad), 0.0, 1.0);
  float front = smoothstep(0.6, 0.0, abs(rad - uGrown)) * uFront;

  /* ---- the furniture: boundary band, centre pool, pressure rings ---- */
  float inner = max(0.01, outer - ${POOL.boundary.toFixed(3)});
  float band = smoothstep(outer + aa, outer - aa, rad) * smoothstep(inner - aa, inner + aa, rad);
  float pool = smoothstep(${POOL.coreSize.toFixed(3)} * uRadius, 0.0, rad) * ${POOL.core.toFixed(3)} * uSpent;
  float ring = pow(0.5 + 0.5 * cos((radial * ${POOL.rings.toFixed(3)} - uTime * ${POOL.ringSpeed.toFixed(3)}) * TAU), 8.0);
  ring *= smoothstep(uRadius, uRadius * 0.2, rad) * 0.35;

  /* ---- put it together ---- */
  vec3 crust = mix(uColorSludge, uColorCrust, plate.y * 0.8 + grain * 0.2);
  crust *= mix(0.42, 1.3, lambert);
  crust = mix(crust, uColorCrust * 1.4, lip * 0.4);
  crust = mix(crust, uColorSludge * 0.35, boil.y * 0.7);

  float acidMask = clamp(seam * 0.95 + pit * 0.85 + pitRim + front * 0.8 + boil.x * 0.9, 0.0, 1.0);
  vec3 acid = mix(uColorAcid, uColorHot, clamp(heat * 0.5 + front + boil.x * 0.5, 0.0, 1.0));

  vec3 color = crust * (1.0 - acidMask);
  color += acid * acidMask * (heat + front * 1.5) * ${POOL.seamGlow.toFixed(3)};
  // Bounce onto the stone either side of a channel.
  color += uColorAcid * lip * heat * 0.3;
  color += uColorHot * caustic * heat * (1.0 - acidMask) * 0.8;
  color += uColorEdge * (band * ${POOL.boundaryGlow.toFixed(3)} + pool * surge + ring) * 0.9;
  // Weighted to where there is actually standing acid to reflect off.
  color += (spec + sheen) * mix(uColorAcid, uColorHot, 0.55) * (0.12 + acidMask * 0.95);

  float alpha = ${POOL.crust.toFixed(3)} * (1.0 - acidMask * 0.35) + acidMask + band * 0.9 + pool * 0.5;
  alpha = clamp(alpha, 0.0, 1.0) * open * uFade;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(color, alpha);
}`;

/** What the zone tells the pool each frame. */
export type BrewPoolState = {
  radius: number; // the footprint, metres
  grown: number; // how far the corrosion has spread, metres
  front: number; // 0..1 — the leading edge, lit while it spreads
  spent: number; // 1 fresh → lower as the acid goes inert
  boil: number; // 0..1 surge envelope
  fade: number; // 0..1, the pool going at the end
};

export type BrewPoolMaterial = THREE.ShaderMaterial & {
  sync(state: BrewPoolState): void;
  /** The quad-to-footprint ratio, for whoever scales the mesh. */
  readonly quad: number;
};

export function createBrewPoolMaterial(clock: { value: number }): BrewPoolMaterial {
  const uniforms = {
    uTime: clock,
    uQuadSize: { value: 10 },
    uRadius: { value: 3 },
    uGrown: { value: 0 },
    uFront: { value: 1 },
    uSpent: { value: 1 },
    uBoil: { value: 0 },
    uSeed: { value: Math.random() * 100 },
    uFade: { value: 1 },
    uColorSludge: { value: new THREE.Color(BOG.sludge) },
    uColorCrust: { value: new THREE.Color(BOG.plate) },
    uColorAcid: { value: new THREE.Color(BOG.acid) },
    uColorHot: { value: new THREE.Color(BOG.hot) },
    uColorEdge: { value: new THREE.Color(BOG.edge) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  return Object.assign(mat, {
    quad: POOL.quad,
    sync: (s: BrewPoolState) => {
      uniforms.uQuadSize.value = s.radius * POOL.quad;
      uniforms.uRadius.value = s.radius;
      uniforms.uGrown.value = s.grown;
      uniforms.uFront.value = s.front;
      uniforms.uSpent.value = s.spent;
      uniforms.uBoil.value = s.boil;
      uniforms.uFade.value = s.fade;
    },
  });
}
