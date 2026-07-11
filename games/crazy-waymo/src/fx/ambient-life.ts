import * as THREE from "three";

import { WORLD_H, WORLD_W } from "../shared/constants";

// Ambient life (Mario-Kart pass): seagull flocks wheeling over the shoreline
// and kites bobbing above the big parks. Everything is GPU-animated — one
// InstancedBufferGeometry draw per kind, a single time uniform per frame, no
// per-bird CPU work. Both fade out at night (birds sleep, kites go home).

const GULL_COUNT = 48;
const KITE_COUNT = 7;

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
  }

  private gullFogUniforms: Record<string, THREE.IUniform>;
  private kiteFogUniforms: Record<string, THREE.IUniform>;

  /** `lamp`: day-night factor, 0 day → 1 night. Fog refs track the scene. */
  update(dt: number, lamp: number, fog: THREE.Fog): void {
    this.time.value += dt;
    const day = 1 - lamp;
    this.gullDay.value = day;
    this.kiteDay.value = day;
    for (const u of [this.gullFogUniforms, this.kiteFogUniforms]) {
      const near = u.fogNear;
      const far = u.fogFar;
      if (near) near.value = fog.near;
      if (far) far.value = fog.far;
    }
  }
}
