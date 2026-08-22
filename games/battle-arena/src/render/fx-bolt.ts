// Lightning — a bundle of filaments drawn from A to B.
//
// Ported from the Elemental Sandbox VFX sandbox (MIT, Copyright (c) 2026
// mohamedachrefelouafi) — https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS
//
// The whole bolt lives in the VERTEX SHADER. A vertex arrives as (t, side) —
// how far along the bolt it is, and which edge of the ribbon it is on — and
// leaves as a world position. There is no path on the CPU to go stale, so one
// pre-built strip serves a bolt of any length, any width and any shape, and
// every filament re-kinks itself for free every frame.
//
// Three things stack to make the shape:
//   1. the axis  — a straight line from origin to target, bowed by sag.
//   2. the fan   — a constant per-filament offset in the perpendicular plane,
//                  opening with distance, so the bundle spreads as it travels.
//   3. the kinks — octaves of LINEARLY interpolated value noise. Linear on
//                  purpose: smoothstep would round the corners off, and the
//                  corners are the entire reason it reads as lightning rather
//                  than as a wobbly tube.
//
// The ribbon then turns to face the camera by crossing the local tangent with
// the view vector, so it keeps its apparent thickness from any angle without
// ever being a screen-space line.
import * as THREE from "three";
import { NOISE_GLSL } from "./fx-noise";

const NODES = 56; // samples along the bolt — the kink-detail ceiling
const STRANDS = 12; // filaments per bolt

const BOLT = {
  sag: 0,
  restrike: 14, // times a second every filament snaps onto a new shape
  spread: 0.5, // fan radius at the far end
  spreadNear: 0.04, // ...and at the hand
  spreadCurve: 1.5,
  twist: 0.35,
  twistSpeed: 0.2,
  jitter: 0.42,
  jitterScale: 1.5, // kinks per metre — stays constant however far it reaches
  octaves: 3,
  jitterFalloff: 0.5,
  crawl: 5.0,
  pinch: 0.12, // how hard both ends are pinned to their anchors
  width: 0.13,
  widthTip: 0.55,
  widthCurve: 1.3,
  coreWidth: 0.42, // the middle filament is the thinnest
  flickerSpeed: 22,
  strandFlash: 0.45,
  coreSharp: 2.6,
  glowFalloff: 1.5,
  glowWidth: 4.2, // the halo pass, as a multiple of the core width
  branchDim: 0.5, // outer filaments carry less light than the axis
  flicker: 0.35,
  tipLength: 0.1,
  tipGlow: 1.6,
} as const;

/**
 * A strip of quads in PARAMETER space: every vertex is (t, ±1). No metres in
 * here at all — the vertex shader turns that pair into a world position. One
 * instance is one filament, and `aStrand` is simply its index.
 */
function createBoltGeometry(): THREE.InstancedBufferGeometry {
  const positions = new Float32Array(NODES * 2 * 3);
  for (let i = 0; i < NODES; i++) {
    const t = i / (NODES - 1);
    const o = i * 6;
    positions[o] = t;
    positions[o + 1] = -1;
    positions[o + 3] = t;
    positions[o + 4] = 1;
  }
  const indices = new Uint16Array((NODES - 1) * 6);
  for (let i = 0; i < NODES - 1; i++) {
    const a = i * 2;
    const o = i * 6;
    indices[o] = a;
    indices[o + 1] = a + 1;
    indices[o + 2] = a + 2;
    indices[o + 3] = a + 1;
    indices[o + 4] = a + 3;
    indices[o + 5] = a + 2;
  }
  const strand = new Float32Array(STRANDS);
  for (let i = 0; i < STRANDS; i++) strand[i] = i;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aStrand", new THREE.InstancedBufferAttribute(strand, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.instanceCount = STRANDS;
  // Built in world space by the vertex shader, so the geometry's own bounds are
  // meaningless — never cull it on them.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geo;
}

const VERT = /* glsl */ `
#define PI 3.141592653589793
#define TAU 6.283185307179586

uniform float uTime;
uniform vec3  uOrigin;
uniform vec3  uTarget;
uniform float uSeed;
uniform float uFade;
uniform float uWidthScale;

attribute float aStrand;

varying float vT;
varying float vSide;
varying float vStrand;
varying float vFlash;

${NOISE_GLSL}

/** Value noise with a LINEAR ramp — piecewise-linear output, sharp corners. */
float vnoise1(float x, float seed) {
  float i = floor(x);
  float f = x - i;
  return mix(nhash11(i + seed), nhash11(i + 1.0 + seed), f) * 2.0 - 1.0;
}

vec2 kink(float t, float seed, float span) {
  vec2 o = vec2(0.0);
  float amp = 1.0;
  float freq = ${BOLT.jitterScale.toFixed(3)} * span;
  float scroll = uTime * ${BOLT.crawl.toFixed(3)};
  for (int i = 0; i < ${BOLT.octaves}; i++) {
    o.x += amp * vnoise1(t * freq + scroll, seed + 13.0 * float(i));
    o.y += amp * vnoise1(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
    amp *= ${BOLT.jitterFalloff.toFixed(3)};
    freq *= 2.0;
    scroll *= 1.63;
  }
  return o;
}

vec3 boltPoint(float t, float seed, float radial, vec3 n1, vec3 n2, float span) {
  vec3 axis = mix(uOrigin, uTarget, t);
  axis.y += ${BOLT.sag.toFixed(3)} * sin(t * PI);

  // Pinned at both ends: a bolt that lands somewhere other than where it was
  // aimed reads as a bug, not as chaos.
  float pinch = ${BOLT.pinch.toFixed(3)};
  float ends = smoothstep(0.0, pinch, t) * smoothstep(0.0, pinch, 1.0 - t);

  vec2 offset = kink(t, seed, span) * ${BOLT.jitter.toFixed(3)} * ends;
  float angle = seed * TAU + (t * ${BOLT.twist.toFixed(3)} + uTime * ${BOLT.twistSpeed.toFixed(3)}) * TAU;
  float reach = mix(${BOLT.spreadNear.toFixed(3)}, ${BOLT.spread.toFixed(3)}, pow(clamp(t, 0.0, 1.0), ${BOLT.spreadCurve.toFixed(3)}));
  offset += vec2(cos(angle), sin(angle)) * reach * radial;

  return axis + n1 * offset.x + n2 * offset.y;
}

void main() {
  float t = position.x;
  vT = t;
  vSide = position.y;

  vec3 delta = uTarget - uOrigin;
  float span = max(length(delta), 0.01);
  vec3 dir = delta / span;
  // Gram-Schmidt off world up: the axis is usually near-vertical for a smite,
  // so pick the fallback that stays well-conditioned either way.
  vec3 ref = abs(dir.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 n1 = normalize(cross(dir, ref));
  vec3 n2 = normalize(cross(dir, n1));

  // The strike index snaps every filament onto a new shape uRestrike times a
  // second; the crawl inside kink() slides it continuously in between. Both
  // together are what stop a held bolt looking like a static ribbon.
  float strike = floor(uTime * ${BOLT.restrike.toFixed(3)});
  float seed = nhash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;
  float radial = aStrand / ${(STRANDS - 1).toFixed(1)};
  vStrand = radial;

  vec3 here = boltPoint(t, seed, radial, n1, n2, span);

  // Tangent by finite difference, mirrored at the far end so the last node
  // still has a neighbour to look at.
  float ahead = t + 0.02;
  float flip = 1.0;
  if (ahead > 1.0) { ahead = t - 0.02; flip = -1.0; }
  vec3 tangent = (boltPoint(ahead, seed, radial, n1, n2, span) - here) * flip;
  tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

  vec3 binormal = cross(tangent, normalize(cameraPosition - here));
  float bl = length(binormal);
  binormal = bl > 1e-4 ? binormal / bl : n1;

  // A stuttering per-filament blink, quantised so the whole bundle strobes on
  // one clock instead of shimmering independently.
  float flash = mix(1.0, nhash11(floor(uTime * ${BOLT.flickerSpeed.toFixed(1)}) + aStrand * 3.7 + uSeed), ${BOLT.strandFlash.toFixed(3)});
  vFlash = flash;

  float halfWidth = ${BOLT.width.toFixed(3)} * uWidthScale;
  halfWidth *= mix(1.0, ${BOLT.widthTip.toFixed(3)}, pow(clamp(t, 0.0, 1.0), ${BOLT.widthCurve.toFixed(3)}));
  halfWidth *= mix(${BOLT.coreWidth.toFixed(3)}, 1.0, radial);
  halfWidth *= flash * uFade;

  gl_Position = projectionMatrix * viewMatrix * vec4(here + binormal * vSide * halfWidth, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uProgress;
uniform float uFade;
uniform float uOpacity;
uniform float uGlowPass;
uniform vec3  uCore;
uniform vec3  uInner;
uniform vec3  uOuter;
uniform vec3  uHalo;

varying float vT;
varying float vSide;
varying float vStrand;
varying float vFlash;

${NOISE_GLSL}

void main() {
  // Ahead of the strike front there is no bolt yet. The ribbon is drawn whole
  // and CLIPPED here rather than scaled, so the shape never changes as the
  // front travels — only how much of it exists.
  float drawn = 1.0 - smoothstep(uProgress - ${BOLT.tipLength.toFixed(3)}, uProgress, vT);
  if (drawn <= 0.002) discard;

  float v = clamp(abs(vSide), 0.0, 1.0);
  vec3 color;
  float profile;
  if (uGlowPass > 0.5) {
    profile = pow(1.0 - v, ${BOLT.glowFalloff.toFixed(3)});
    color = mix(uHalo, uOuter, profile);
  } else {
    profile = pow(1.0 - v, ${BOLT.coreSharp.toFixed(3)});
    color = mix(uOuter, uInner, smoothstep(0.0, 0.5, profile));
    color = mix(color, uCore, smoothstep(0.45, 1.0, profile));
  }

  // The leading edge is where the air is actually breaking down.
  color += uCore * smoothstep(uProgress - ${(BOLT.tipLength * 2).toFixed(3)}, uProgress, vT) * ${BOLT.tipGlow.toFixed(3)};

  // Quantised, not sinusoidal: real lightning stutters between brightnesses,
  // it does not breathe.
  float flicker = 1.0 - ${BOLT.flicker.toFixed(3)} * nhash11(floor(uTime * ${BOLT.flickerSpeed.toFixed(1)}) + uSeed);

  float alpha = profile * drawn * flicker * vFlash * uFade * uOpacity;
  alpha *= mix(1.0, ${BOLT.branchDim.toFixed(3)}, vStrand);
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(color, alpha);
}`;

/** One pass's uniform block. Named rather than an open dictionary so the
 *  colour and vector values keep their types all the way to the write site. */
type BoltUniforms = {
  uTime: { value: number };
  uOrigin: { value: THREE.Vector3 };
  uTarget: { value: THREE.Vector3 };
  uSeed: { value: number };
  uFade: { value: number };
  uProgress: { value: number };
  uOpacity: { value: number };
  uWidthScale: { value: number };
  uGlowPass: { value: number };
  uCore: { value: THREE.Color };
  uInner: { value: THREE.Color };
  uOuter: { value: THREE.Color };
  uHalo: { value: THREE.Color };
};

type BoltMesh = THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;

type Bolt = {
  core: BoltMesh;
  glow: BoltMesh;
  uni: { core: BoltUniforms; glow: BoltUniforms };
  life: number;
  maxLife: number;
  strikeTime: number; // seconds the front takes to travel origin → target
};

export type BoltOpts = {
  /** Seconds the bolt is on screen. */
  life?: number;
  /** Seconds the strike front takes to travel origin → target. */
  strikeTime?: number;
  /** Multiplier on the filament width. */
  scale?: number;
  color?: number;
  haloColor?: number;
};

const POOL = 4;
/** Reused by the inner-colour lerp — allocating a Color per strike is churn. */
const WHITE = new THREE.Color(0xffffff);

/** Pooled lightning bolts. Two draw calls each: a hot core and a wide halo. */
export class BoltPool {
  private bolts: Bolt[] = [];
  private geo = createBoltGeometry();

  constructor(scene: THREE.Scene, clock: { value: number }) {
    for (let i = 0; i < POOL; i++) {
      const mk = (glowPass: boolean) => {
        const uni: BoltUniforms = {
          uTime: clock,
          uOrigin: { value: new THREE.Vector3() },
          uTarget: { value: new THREE.Vector3() },
          uSeed: { value: 0 },
          uFade: { value: 1 },
          uProgress: { value: 1 },
          uOpacity: { value: glowPass ? 0.5 : 1 },
          uWidthScale: { value: glowPass ? BOLT.glowWidth : 1 },
          uGlowPass: { value: glowPass ? 1 : 0 },
          uCore: { value: new THREE.Color(0xffffff) },
          uInner: { value: new THREE.Color(0xdcefff) },
          uOuter: { value: new THREE.Color(0x7fc4ff) },
          uHalo: { value: new THREE.Color(0x2a6cff) },
        };
        const mat = new THREE.ShaderMaterial({
          uniforms: uni,
          vertexShader: VERT,
          fragmentShader: FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(this.geo, mat);
        mesh.frustumCulled = false;
        mesh.visible = false;
        mesh.renderOrder = 6;
        scene.add(mesh);
        return { mesh, uni };
      };
      const core = mk(false);
      const glow = mk(true);
      this.bolts.push({
        core: core.mesh,
        glow: glow.mesh,
        uni: { core: core.uni, glow: glow.uni },
        life: 0,
        maxLife: 1,
        strikeTime: 0.09,
      });
    }
  }

  /** Strike from `from` to `to` (world space). */
  strike(from: THREE.Vector3Like, to: THREE.Vector3Like, opts: BoltOpts = {}): void {
    const b = this.bolts.find((x) => x.life <= 0);
    if (!b) return; // saturated — drop
    const { life = 0.34, scale = 1, color = 0x9fd4ff, haloColor = 0x2a6cff } = opts;
    b.life = life;
    b.maxLife = life;
    b.core.visible = true;
    b.glow.visible = true;
    const seed = Math.random() * 100;
    for (const [uni, widthGain] of [
      [b.uni.core, 1],
      [b.uni.glow, BOLT.glowWidth],
    ] as const) {
      uni.uOrigin.value.set(from.x, from.y, from.z);
      uni.uTarget.value.set(to.x, to.y, to.z);
      uni.uSeed.value = seed;
      uni.uWidthScale.value = scale * widthGain;
      uni.uOuter.value.setHex(color);
      uni.uHalo.value.setHex(haloColor);
      uni.uInner.value.setHex(color).lerp(WHITE, 0.6);
      uni.uProgress.value = 0;
    }
    b.strikeTime = opts.strikeTime ?? Math.min(0.09, life * 0.35);
  }

  update(dt: number): void {
    for (const b of this.bolts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.core.visible = false;
        b.glow.visible = false;
        continue;
      }
      const elapsed = b.maxLife - b.life;
      const front = Math.min(1, elapsed / Math.max(1e-3, b.strikeTime));
      // Holds at full brightness while it strikes, then guts out.
      const k = elapsed / b.maxLife;
      const fade = k < 0.45 ? 1 : 1 - (k - 0.45) / 0.55;
      for (const uni of [b.uni.core, b.uni.glow]) {
        uni.uProgress.value = front;
        uni.uFade.value = fade;
      }
    }
  }

  dispose(): void {
    for (const b of this.bolts) {
      for (const m of [b.core, b.glow]) {
        m.material.dispose();
        m.removeFromParent();
      }
    }
    this.geo.dispose();
    this.bolts.length = 0;
  }
}
