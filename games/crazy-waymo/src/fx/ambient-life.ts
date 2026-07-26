import * as THREE from "three";

import { WORLD_H, WORLD_W } from "../shared/constants";

// Ambient life (Mario-Kart pass): seagull flocks wheeling over the shoreline,
// kites bobbing above the big parks, and — at eye level, where the player
// actually is — gulls perched on the streetlights and pigeons working the
// sidewalks, both of which flush when the car comes at them.
//
// Airborne life is fully GPU-animated (one time uniform, no CPU work). The
// perched set keeps one small CPU pass: a per-bird alarm level with a fast
// attack and a slow settle, which is what makes a flush read as a startle
// rather than a proximity dissolve. Everything is one draw per kind, and all
// of it fades out at night (birds roost, kites go home).

const GULL_COUNT = 48;
const KITE_COUNT = 7;

// Perched set. Sized to blanket the map at roughly one bird per ~130u rather
// than chase the camera: 4 triangles each, so the whole flock is ~3.6k tris in
// a single draw and there is no re-anchoring bookkeeping to get wrong.
const PERCH_COUNT = 900;
const PERCH_FADE_NEAR = 130; // birds are small; past this they are pixel noise
const PERCH_FADE_FAR = 210;
const SCATTER_R = 16; // the car flushes birds inside this radius
const SCATTER_ATTACK = 8; // alarm units/s going up — near-instant
const SCATTER_SETTLE = 0.32; // alarm units/s coming down — ~3s to return
const SCATTER_LIFT = 7; // world units a fully-alarmed bird climbs
const SCATTER_DRIFT = 9; // ...and how far it scatters horizontally
const GULL_PERCH_R = 150; // lamps this close to a flock anchor get a gull

const PIGEON_COLORS = [0x6d7078, 0x8a8d94, 0x55585f, 0x9aa0a8];

// Flock anchors in map fractions (u west→east, v north→south) — SF's actual
// bird territory: Ocean Beach, the Marina, the Wharf, the Embarcadero.
const FLOCKS: readonly { u: number; v: number; y: number; r: number }[] = [
  { u: 0.035, v: 0.32, y: 42, r: 55 },
  { u: 0.03, v: 0.58, y: 36, r: 45 },
  { u: 0.4, v: 0.075, y: 46, r: 50 },
  { u: 0.58, v: 0.06, y: 38, r: 40 },
  { u: 0.78, v: 0.2, y: 44, r: 48 },
  { u: 0.86, v: 0.48, y: 40, r: 55 },
];

// Kite spots: Marina Green, Alamo Square, Dolores Park, GG Park meadows.
const KITE_SPOTS: readonly { u: number; v: number }[] = [
  { u: 0.41, v: 0.09 },
  { u: 0.43, v: 0.095 },
  { u: 0.475, v: 0.335 },
  { u: 0.57, v: 0.475 },
  { u: 0.2, v: 0.4 },
  { u: 0.3, v: 0.405 },
  { u: 0.12, v: 0.395 },
];

const KITE_COLORS = [0xe64236, 0xf2ce3a, 0x2fb5d6, 0xd14e9b, 0x3fae52, 0xf08c2e, 0x8a4bc9];

const toX = (u: number): number => (u - 0.5) * WORLD_W;
const toZ = (v: number): number => (v - 0.5) * WORLD_H;

/**
 * A place a bird can sit. Structurally the streetlight record the furniture
 * pass emits (world/furniture.ts `LampHead`), so `city.lampHeads` passes
 * straight in — `y` is the head, `ground` the pavement under it.
 */
export type PerchAnchor = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly ground: number;
};

type PerchedFlock = {
  readonly perch: Float32Array;
  readonly alarms: Float32Array;
  readonly alarmAttr: THREE.InstancedBufferAttribute;
  readonly count: number;
};

/** True near one of the shoreline flock anchors — where gulls, not pigeons, go. */
function nearFlock(x: number, z: number): boolean {
  for (const f of FLOCKS) {
    const dx = toX(f.u) - x;
    const dz = toZ(f.v) - z;
    if (dx * dx + dz * dz < GULL_PERCH_R * GULL_PERCH_R) return true;
  }
  return false;
}

const GULL_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec4 aOrbit; // radius, angular speed, phase, scale
  uniform float uTime;
  varying float vShade;
  #include <fog_pars_vertex>
  void main() {
    float ang = uTime * aOrbit.y + aOrbit.z;
    vec3 c = aCenter + vec3(cos(ang) * aOrbit.x, sin(ang * 0.7) * 3.0, sin(ang) * aOrbit.x);
    // Face along the orbit tangent (right-handed frame, gulls fly forward).
    vec2 fwd = normalize(vec2(-sin(ang), cos(ang)));
    vec2 right = vec2(fwd.y, -fwd.x);
    // Wing flap: tips (|x|=1) beat, body stays level.
    vec3 p = position * aOrbit.w;
    p.y += sin(uTime * 9.0 + aOrbit.z * 7.0) * 0.55 * abs(position.x) * aOrbit.w;
    vec3 world = c + vec3(right.x * p.x + fwd.x * p.z, p.y, right.y * p.x + fwd.y * p.z);
    vShade = 0.82 + 0.18 * abs(position.x);
    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const GULL_FRAG = /* glsl */ `
  uniform float uDay;
  varying float vShade;
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(vec3(0.96, 0.97, 0.99) * vShade * (0.35 + 0.65 * uDay), 1.0);
    #include <fog_fragment>
  }
`;

const KITE_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec3 aColor;
  attribute float aPhase;
  uniform float uTime;
  varying vec3 vColor;
  varying float vTail;
  #include <fog_pars_vertex>
  void main() {
    vColor = aColor;
    vTail = -min(position.y, 0.0) * 0.28;
    // Lissajous bob on the tether + a lazy sway on the tail verts.
    vec3 c = aCenter + vec3(
      sin(uTime * 0.55 + aPhase) * 4.0,
      sin(uTime * 0.85 + aPhase * 1.7) * 2.2,
      cos(uTime * 0.4 + aPhase) * 4.0
    );
    vec3 p = position;
    p.x += sin(uTime * 2.2 + aPhase + position.y * 1.4) * 0.35 * vTail * 3.5;
    vec4 mvPosition = viewMatrix * vec4(c + p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const KITE_FRAG = /* glsl */ `
  uniform float uDay;
  varying vec3 vColor;
  varying float vTail;
  #include <fog_pars_fragment>
  void main() {
    if (uDay < 0.15) discard;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), vTail) * (0.4 + 0.6 * uDay), 1.0);
    #include <fog_fragment>
  }
`;

const PERCH_VERT = /* glsl */ `
  attribute vec3 aPerch;   // anchor: where the bird sits
  attribute vec4 aBird;    // scale, heading, flee-x, flee-z
  attribute vec3 aTint;
  attribute float aAlarm;  // 0 settled .. 1 fully flushed (CPU-driven)
  uniform float uTime;
  varying vec3 vColor;
  varying float vFade;
  #include <fog_pars_vertex>
  void main() {
    float a = clamp(aAlarm, 0.0, 1.0);
    // Flushed: climb and scatter along this bird's own escape vector. The
    // climb leads the drift so the take-off pops before the glide away.
    vec3 c = aPerch
      + vec3(aBird.z, 0.0, aBird.w) * (a * a * ${SCATTER_DRIFT.toFixed(1)})
      + vec3(0.0, sqrt(a) * ${SCATTER_LIFT.toFixed(1)}, 0.0);
    // Settled birds shuffle and peck; flushed birds beat hard.
    float beat = mix(2.2, 22.0, a);
    float ampl = mix(0.10, 0.62, a);
    float head = aBird.y;
    vec2 fwd = vec2(sin(head), cos(head));
    vec2 right = vec2(fwd.y, -fwd.x);
    vec3 p = position * aBird.x;
    p.y += sin(uTime * beat + head * 5.0) * ampl * abs(position.x) * aBird.x;
    vec3 world = c + vec3(right.x * p.x + fwd.x * p.z, p.y, right.y * p.x + fwd.y * p.z);
    vColor = aTint;
    vFade = 1.0 - smoothstep(
      ${PERCH_FADE_NEAR.toFixed(1)}, ${PERCH_FADE_FAR.toFixed(1)},
      distance(cameraPosition, aPerch));
    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const PERCH_FRAG = /* glsl */ `
  uniform float uDay;
  varying vec3 vColor;
  varying float vFade;
  #include <fog_pars_fragment>
  void main() {
    // Opaque geometry, so the range fade is a cull, not a blend — by the time
    // vFade runs out the bird is well under a pixel. Night culls the lot.
    if (vFade * uDay < 0.02) discard;
    gl_FragColor = vec4(vColor * (0.35 + 0.65 * uDay), 1.0);
    #include <fog_fragment>
  }
`;

// Gull: two swept-back wing triangles. Tips at |x|=1 so the shader can flap.
function gullGeometry(): THREE.BufferGeometry {
  // prettier-ignore
  const pos = new Float32Array([
    -1, 0, -0.1,   0, 0, 0.4,   0, 0, -0.25,
     1, 0, -0.1,   0, 0, -0.25, 0, 0, 0.4,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return geo;
}

// Perched bird: unlike the wheeling flock — which is only ever seen from below
// and far away — this one is looked at from the side, a metre off the bonnet.
// A flat wing V would be edge-on and invisible there, so it gets a body in the
// vertical plane crossed with the wings in the horizontal one: whichever way
// you approach, one of the two is broad. Wing tips sit at |x| = 0.95 so the
// shader's `abs(position.x)` flap term still only moves the wings.
function perchedGeometry(): THREE.BufferGeometry {
  // prettier-ignore
  const pos = new Float32Array([
    // body, side profile in the yz plane: head → back → tail, then the belly
    0, 0.02, 0.55,   0, 0.34, 0.05,   0, 0.02, -0.6,
    0, 0.02, 0.55,   0, 0.02, -0.6,   0, -0.14, -0.05,
    // wings, a shallow dihedral V out to each side
    -0.95, 0.2, -0.1,  0, 0.1, 0.35,   0, 0.1, -0.25,
     0.95, 0.2, -0.1,  0, 0.1, -0.25,  0, 0.1, 0.35,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return geo;
}

// Kite: a diamond sail (y 0..3.4) + a ribbon tail (y 0..-3), double-faced.
function kiteGeometry(): THREE.BufferGeometry {
  // prettier-ignore
  const pos = new Float32Array([
    // sail (two tris of a diamond)
    0, 3.4, 0,   -1.4, 1.7, 0,   0, 0, 0,
    0, 3.4, 0,   0, 0, 0,        1.4, 1.7, 0,
    // tail ribbon
    -0.18, 0, 0,  0.18, 0, 0,   -0.18, -3.0, 0,
    0.18, 0, 0,   0.18, -3.0, 0, -0.18, -3.0, 0,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return geo;
}

export class AmbientLife {
  readonly group = new THREE.Group();
  private time = { value: 0 };
  private gullDay = { value: 1 };
  private kiteDay = { value: 1 };

  constructor(fog: THREE.Fog, heightAt: (x: number, z: number) => number, rng: () => number) {
    // --- Gulls ---
    const gullGeo = new THREE.InstancedBufferGeometry();
    const base = gullGeometry();
    gullGeo.setAttribute("position", base.getAttribute("position"));
    gullGeo.instanceCount = GULL_COUNT;
    const centers = new Float32Array(GULL_COUNT * 3);
    const orbits = new Float32Array(GULL_COUNT * 4);
    for (let i = 0; i < GULL_COUNT; i++) {
      const f = FLOCKS[i % FLOCKS.length];
      if (!f) continue;
      centers[i * 3] = toX(f.u) + (rng() - 0.5) * 30;
      centers[i * 3 + 1] = f.y + (rng() - 0.5) * 14;
      centers[i * 3 + 2] = toZ(f.v) + (rng() - 0.5) * 30;
      orbits[i * 4] = f.r * (0.55 + rng() * 0.7);
      const dir = i % 2 === 0 ? 1 : -1;
      orbits[i * 4 + 1] = dir * (0.14 + rng() * 0.12);
      orbits[i * 4 + 2] = rng() * Math.PI * 2;
      orbits[i * 4 + 3] = 1.6 + rng() * 1.1;
    }
    gullGeo.setAttribute("aCenter", new THREE.InstancedBufferAttribute(centers, 3));
    gullGeo.setAttribute("aOrbit", new THREE.InstancedBufferAttribute(orbits, 4));
    const gullMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.time,
        uDay: this.gullDay,
        fogColor: { value: fog.color },
        fogNear: { value: fog.near },
        fogFar: { value: fog.far },
      },
      vertexShader: GULL_VERT,
      fragmentShader: GULL_FRAG,
      side: THREE.DoubleSide,
      fog: true,
    });
    const gulls = new THREE.Mesh(gullGeo, gullMat);
    gulls.frustumCulled = false; // flocks span the map
    this.group.add(gulls);
    this.gullFogUniforms = gullMat.uniforms;

    // --- Kites ---
    const kiteGeo = new THREE.InstancedBufferGeometry();
    const kbase = kiteGeometry();
    kiteGeo.setAttribute("position", kbase.getAttribute("position"));
    kiteGeo.instanceCount = KITE_COUNT;
    const kCenters = new Float32Array(KITE_COUNT * 3);
    const kColors = new Float32Array(KITE_COUNT * 3);
    const kPhases = new Float32Array(KITE_COUNT);
    const col = new THREE.Color();
    for (let i = 0; i < KITE_COUNT; i++) {
      const s = KITE_SPOTS[i % KITE_SPOTS.length];
      if (!s) continue;
      const x = toX(s.u) + (rng() - 0.5) * 12;
      const z = toZ(s.v) + (rng() - 0.5) * 12;
      kCenters[i * 3] = x;
      kCenters[i * 3 + 1] = heightAt(x, z) + 22 + rng() * 10;
      kCenters[i * 3 + 2] = z;
      col.setHex(KITE_COLORS[i % KITE_COLORS.length] ?? 0xe64236);
      kColors[i * 3] = col.r;
      kColors[i * 3 + 1] = col.g;
      kColors[i * 3 + 2] = col.b;
      kPhases[i] = rng() * Math.PI * 2;
    }
    kiteGeo.setAttribute("aCenter", new THREE.InstancedBufferAttribute(kCenters, 3));
    kiteGeo.setAttribute("aColor", new THREE.InstancedBufferAttribute(kColors, 3));
    kiteGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(kPhases, 1));
    const kiteMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.time,
        uDay: this.kiteDay,
        fogColor: { value: fog.color },
        fogNear: { value: fog.near },
        fogFar: { value: fog.far },
      },
      vertexShader: KITE_VERT,
      fragmentShader: KITE_FRAG,
      side: THREE.DoubleSide,
      fog: true,
    });
    const kites = new THREE.Mesh(kiteGeo, kiteMat);
    kites.frustumCulled = false;
    this.group.add(kites);
    this.kiteFogUniforms = kiteMat.uniforms;

    this.fog = fog;
    this.rng = rng;
  }

  private gullFogUniforms: Record<string, THREE.IUniform>;
  private kiteFogUniforms: Record<string, THREE.IUniform>;
  private perchFogUniforms: Record<string, THREE.IUniform> | null = null;
  private perched: PerchedFlock | null = null;
  private readonly fog: THREE.Fog;
  private readonly rng: () => number;

  /**
   * Populate the eye-level flock from the streetlight anchors the furniture
   * pass already produced: gulls take the lamp heads near the shoreline flock
   * spots, pigeons work the pavement around the rest. Safe to call once, after
   * the world has loaded; a second call is ignored.
   */
  populatePerches(anchors: readonly PerchAnchor[]): void {
    if (this.perched || anchors.length === 0) return;
    const rng = this.rng;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", perchedGeometry().getAttribute("position"));
    const n = Math.min(PERCH_COUNT, anchors.length);
    geo.instanceCount = n;
    const perch = new Float32Array(n * 3);
    const bird = new Float32Array(n * 4);
    const tints = new Float32Array(n * 3);
    const alarms = new Float32Array(n);
    const col = new THREE.Color();
    // Even stride over the anchor list spreads the flock across the whole map
    // instead of clumping it wherever the furniture pass happened to start.
    const stride = anchors.length / n;
    for (let i = 0; i < n; i++) {
      const a = anchors[Math.min(anchors.length - 1, Math.floor(i * stride))];
      if (!a) continue;
      const isGull = nearFlock(a.x, a.z);
      const ang = rng() * Math.PI * 2;
      if (isGull) {
        // On the lamp head itself, facing out into the wind.
        perch.set([a.x, a.y + 0.35, a.z], i * 3);
        bird.set([0.62, ang, Math.sin(ang), Math.cos(ang)], i * 4);
        col.setHex(rng() < 0.35 ? 0xd8dde4 : 0xf2f5f8);
      } else {
        // On the pavement a step or two off the post.
        const r = 1.4 + rng() * 2.6;
        perch.set([a.x + Math.sin(ang) * r, a.ground + 0.18, a.z + Math.cos(ang) * r], i * 3);
        const flee = rng() * Math.PI * 2;
        bird.set([0.4, flee, Math.sin(flee), Math.cos(flee)], i * 4);
        col.setHex(PIGEON_COLORS[i % PIGEON_COLORS.length] ?? 0x6d7078);
      }
      tints.set([col.r, col.g, col.b], i * 3);
    }
    const alarmAttr = new THREE.InstancedBufferAttribute(alarms, 1);
    alarmAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aPerch", new THREE.InstancedBufferAttribute(perch, 3));
    geo.setAttribute("aBird", new THREE.InstancedBufferAttribute(bird, 4));
    geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 3));
    geo.setAttribute("aAlarm", alarmAttr);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.time,
        uDay: this.gullDay,
        fogColor: { value: this.fog.color },
        fogNear: { value: this.fog.near },
        fogFar: { value: this.fog.far },
      },
      vertexShader: PERCH_VERT,
      fragmentShader: PERCH_FRAG,
      side: THREE.DoubleSide,
      fog: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; // the flock spans the map
    this.group.add(mesh);
    this.perched = { perch, alarms, alarmAttr, count: n };
    this.perchFogUniforms = mat.uniforms;
  }

  /**
   * `lamp`: day-night factor, 0 day → 1 night. `carX/carZ`: whatever the birds
   * should flee from. Fog refs track the scene.
   */
  update(dt: number, lamp: number, fog: THREE.Fog, carX: number, carZ: number): void {
    this.time.value += dt;
    const day = 1 - lamp;
    this.gullDay.value = day;
    this.kiteDay.value = day;
    for (const u of [this.gullFogUniforms, this.kiteFogUniforms, this.perchFogUniforms]) {
      if (!u) continue;
      const near = u.fogNear;
      const far = u.fogFar;
      if (near) near.value = fog.near;
      if (far) far.value = fog.far;
    }
    this.updateScatter(dt, day, carX, carZ);
  }

  // One pass over the flock: alarm attacks hard inside SCATTER_R and bleeds off
  // slowly outside it. The attribute only goes back to the GPU on frames where
  // a bird actually moved, which is almost none of them.
  private updateScatter(dt: number, day: number, carX: number, carZ: number): void {
    const p = this.perched;
    if (!p || day < 0.02) return;
    const rise = SCATTER_ATTACK * dt;
    const fall = SCATTER_SETTLE * dt;
    const rSq = SCATTER_R * SCATTER_R;
    let dirty = false;
    for (let i = 0; i < p.count; i++) {
      const prev = p.alarms[i] ?? 0;
      const dx = (p.perch[i * 3] ?? 0) - carX;
      const dz = (p.perch[i * 3 + 2] ?? 0) - carZ;
      const next = dx * dx + dz * dz < rSq ? Math.min(1, prev + rise) : Math.max(0, prev - fall);
      if (next !== prev) {
        p.alarms[i] = next;
        dirty = true;
      }
    }
    if (dirty) p.alarmAttr.needsUpdate = true;
  }
}
