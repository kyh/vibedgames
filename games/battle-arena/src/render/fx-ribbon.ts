// Helix ribbons dragged behind a projectile — the wake Grimelda's Hex Bolt
// leaves as it curdles through the air.
//
// Ported from the Elemental Sandbox VFX sandbox (MIT, Copyright (c) 2026
// mohamedachrefelouafi) — https://github.com/achrefelouafi/LinearAbiltyCastingExtendedThreeJS
// (the "Cyber Serpent" neon trail), with the sandbox's depth-buffer soft fade
// dropped (we run no depth prepass) and the palette re-graded from neon cyan
// to bog green running out to violet.
//
// A whole nest of them is ONE draw call: the geometry is the same instanced
// parameter strip the lightning bolt uses, and each instance winds its own
// helix about the flight line from nothing but its instance index. The CPU
// hands over four vectors a frame — where the nose is, and the frame it is
// flying in — and never touches a vertex. There is no path to go stale, so a
// projectile that dies mid-flight leaves a wake that dissolves in place.
//
// Three things stop this reading as a machined screw thread, which is what a
// plain helix looks like:
//   - the RADIUS PROFILE opens just behind the head and closes to a point at
//     the far end, so a ribbon is a teardrop wrapped around the path;
//   - each strand carries its own PHASE, PITCH and RADIUS, rolled off its
//     index, so the strands cross each other instead of nesting;
//   - a low-frequency WANDER pushes the whole helix off axis — the difference
//     between a light ribbon and a spring.
//
// The strip is billboarded: a fixed normal would make a strand vanish edge-on
// every half turn, which on a helix is twice a revolution.
import * as THREE from "three";
import { NOISE_GLSL } from "./fx-noise";

const POOL = 6;
// samples along the wake
const NODES = 40;
// ribbons per wake
const STRANDS = 5;

const RIBBON = {
  // the hard thread down the middle of it
  core: 20,
  // it is a curse, not a wire — let it stutter
  flicker: 0.3,
  flickerScale: 6,
  flickerSpeed: 2.2,
  intensity: 1.35,
  // seconds a wake takes to dissolve once its head is gone
  loose: 0.3,
  opacity: 0.68,
  // charge running up it
  pulse: 1.3,
  pulseFreq: 2.2,
  pulseSpeed: 1.3,
  // how far off the axis they ride, metres
  radius: 0.34,
  // falloff across the ribbon
  sharp: 2.8,
  // metres of path they reach back over
  span: 4.5,
  // turns/second they roll on top of that
  spin: 0.35,
  // where along the span they are fattest
  swell: 0.5,
  // turns each makes over that span
  turns: 1.8,
  // metres the helix drifts off axis
  wander: 0.12,
  wanderScale: 2,
  wanderSpeed: 0.8,
  // half-width at the head, metres
  width: 0.07,
  // that width at the tail, as a multiple
  widthTip: 0.5,
} as const;

/** Bog green out of a white thread, running to violet at the tail. */
const HEX = { body: 0x7f_e0_8a, core: 0xf0_ff_f0, tail: 0x6a_3a_a8 } as const;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const VERT = /* glsl */ `
#define TAU 6.283185307179586
#define PI  3.141592653589793
attribute float aStrand;
uniform float uTime;
uniform vec3  uHead;   // the nose, in world space
uniform vec3  uDir;    // unit heading
uniform vec3  uSide;
uniform vec3  uUp;
uniform float uSeed;
uniform float uSpan;
uniform float uFade;
varying float vT;
varying float vV;
varying float vStrand;

${NOISE_GLSL}

/* Where strand 'phase' sits at t — 0 at the nose, 1 at the far tail. */
vec3 pathAt(float t, float phase, float radius, float pitch) {
  vec3 axis = uHead - uDir * (t * uSpan);
  // Opens behind the head, closes to a point at the end.
  float profile = sin(pow(clamp(t, 0.0, 1.0), ${RIBBON.swell.toFixed(3)}) * PI);
  float r = radius * profile;
  float angle = phase + t * pitch * TAU - uTime * ${RIBBON.spin.toFixed(3)} * TAU;
  axis += (uSide * cos(angle) + uUp * sin(angle)) * r;
  // ... and a slow push off the axis, so the helix breathes.
  float w = ${RIBBON.wander.toFixed(3)} * profile;
  axis += uSide * snoise(vec3(t * ${RIBBON.wanderScale.toFixed(3)}, uTime * ${RIBBON.wanderSpeed.toFixed(3)}, phase)) * w;
  axis += uUp * snoise(vec3(t * ${RIBBON.wanderScale.toFixed(3)} + 19.7, uTime * ${RIBBON.wanderSpeed.toFixed(3)}, phase + 4.3)) * w;
  return axis;
}

void main() {
  float strand = aStrand;
  float roll = nhash11(strand * 7.13 + uSeed);
  float roll2 = nhash11(strand * 3.71 + uSeed + 11.3);

  // Evenly spaced around the axis, then jittered — evenly spaced alone makes
  // the strands read as one rotating cage.
  float phase = (strand / ${STRANDS.toFixed(1)}) * TAU + roll * 1.7 + uSeed;
  float radius = ${RIBBON.radius.toFixed(3)} * (0.7 + roll * 0.65);
  float pitch = ${RIBBON.turns.toFixed(3)} * (0.75 + roll2 * 0.6) * (roll2 > 0.5 ? 1.0 : -1.0);

  float t = clamp(position.x, 0.0, 1.0);
  const float H = 0.012;
  vec3 p0 = pathAt(t, phase, radius, pitch);
  vec3 p1 = pathAt(min(t + H, 1.0), phase, radius, pitch);
  vec3 tangent = normalize(p1 - p0 + 1e-6);

  vec3 toEye = normalize(cameraPosition - p0);
  vec3 side = cross(tangent, toEye);
  if (dot(side, side) < 1e-8) side = uSide;
  side = normalize(side);

  // Tapered at both ends: a ribbon that stops dead reads as a cut strip.
  float taper = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.72, 1.0, t));
  float halfWidth = ${RIBBON.width.toFixed(3)} * mix(1.0, ${RIBBON.widthTip.toFixed(3)}, t) * taper * uFade * (0.7 + roll * 0.6);

  vT = t;
  vV = position.y;
  vStrand = strand;
  gl_Position = projectionMatrix * viewMatrix * vec4(p0 + side * (position.y * halfWidth), 1.0);
}`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const FRAG = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uFade;
uniform vec3  uColorCore;
uniform vec3  uColorBody;
uniform vec3  uColorTail;
varying float vT;
varying float vV;
varying float vStrand;

${NOISE_GLSL}

void main() {
  /* across the ribbon: a soft body with a hard thread down the middle */
  float across = clamp(1.0 - abs(vV), 0.0, 1.0);
  float body = pow(across, ${RIBBON.sharp.toFixed(3)});
  float core = pow(across, ${RIBBON.core.toFixed(3)});

  /* charge running up the ribbon toward the head */
  float phase = fract(vT * ${RIBBON.pulseFreq.toFixed(3)} + uTime * ${RIBBON.pulseSpeed.toFixed(3)} + vStrand * 0.37);
  float pulse = pow(1.0 - abs(phase * 2.0 - 1.0), 6.0) * ${RIBBON.pulse.toFixed(3)};

  /* let it stutter */
  float flicker = snoise(vec3(vT * ${RIBBON.flickerScale.toFixed(3)}, uTime * ${RIBBON.flickerSpeed.toFixed(3)}, vStrand * 5.1 + uSeed)) * 0.5 + 0.5;
  flicker = mix(1.0, flicker, ${RIBBON.flicker.toFixed(3)});

  float energy = (body * (1.0 + pulse) + core * 1.6) * flicker;
  // The far end goes to nothing: the ribbon dissolves into the wake instead of
  // ending on a line.
  energy *= 1.0 - smoothstep(0.55, 1.0, vT);

  vec3 color = mix(uColorBody, uColorTail, smoothstep(0.15, 0.8, vT));
  color = mix(color, uColorCore, clamp(core + pulse * 0.7, 0.0, 1.0));
  color *= energy * ${RIBBON.intensity.toFixed(3)};

  float alpha = clamp(energy, 0.0, 1.0) * ${RIBBON.opacity.toFixed(3)} * uFade;
  if (alpha < 0.004) discard;
  // Rolled off hard: a ribbon that clips is a white noodle.
  color /= 1.0 + color * 0.18;
  gl_FragColor = vec4(color, alpha);
}`;

/** The bolt's strip: (t, ±1) per vertex, one instance per strand. */
const createStripGeometry = (): THREE.InstancedBufferGeometry => {
  const positions = new Float32Array(NODES * 2 * 3);
  for (let i = 0; i < NODES; i += 1) {
    const t = i / (NODES - 1);
    const o = i * 6;
    positions[o] = t;
    positions[o + 1] = -1;
    positions[o + 3] = t;
    positions[o + 4] = 1;
  }
  const indices = new Uint16Array((NODES - 1) * 6);
  for (let i = 0; i < NODES - 1; i += 1) {
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
  for (let i = 0; i < STRANDS; i += 1) {
    strand[i] = i;
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aStrand", new THREE.InstancedBufferAttribute(strand, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.instanceCount = STRANDS;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geo;
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
type RibbonUniforms = {
  uTime: { value: number };
  uHead: { value: THREE.Vector3 };
  uDir: { value: THREE.Vector3 };
  uSide: { value: THREE.Vector3 };
  uUp: { value: THREE.Vector3 };
  uSeed: { value: number };
  uSpan: { value: number };
  uFade: { value: number };
  uColorCore: { value: THREE.Color };
  uColorBody: { value: THREE.Color };
  uColorTail: { value: THREE.Color };
};

interface Ribbon {
  mesh: THREE.Mesh;
  uni: RibbonUniforms;
  // the projectile it follows; "" when free
  id: string;
  // followed this frame
  fed: boolean;
  // seconds since its head last reported in
  loose: number;
}

export interface RibbonPalette {
  core: number;
  body: number;
  tail: number;
}

/** Pooled projectile wakes, keyed by the projectile they follow. */
export class RibbonPool {
  private ribbons: Ribbon[] = [];
  private geo = createStripGeometry();
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene, clock: { value: number }) {
    this.scene = scene;
    for (let i = 0; i < POOL; i += 1) {
      const uni: RibbonUniforms = {
        uColorBody: { value: new THREE.Color(HEX.body) },
        uColorCore: { value: new THREE.Color(HEX.core) },
        uColorTail: { value: new THREE.Color(HEX.tail) },
        uDir: { value: new THREE.Vector3(0, 0, 1) },
        uFade: { value: 1 },
        uHead: { value: new THREE.Vector3() },
        uSeed: { value: 0 },
        uSide: { value: new THREE.Vector3(1, 0, 0) },
        uSpan: { value: 0 },
        uTime: clock,
        uUp: { value: new THREE.Vector3(0, 1, 0) },
      };
      const mesh = new THREE.Mesh(
        this.geo,
        new THREE.ShaderMaterial({
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fragmentShader: FRAG,
          side: THREE.DoubleSide,
          transparent: true,
          uniforms: uni,
          vertexShader: VERT,
        }),
      );
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 6;
      this.scene.add(mesh);
      this.ribbons.push({ fed: false, id: "", loose: 0, mesh, uni });
    }
  }

  /**
   * Report a projectile's nose this frame. (x, h, z) is its world position,
   * (dx, dz) its unit heading on the floor, `traveled` how far it has flown —
   * the wake only reaches back as far as the bolt has actually been, so it
   * does not pop out of the caster's back fully formed.
   */
  follow(
    id: string,
    x: number,
    h: number,
    z: number,
    dx: number,
    dz: number,
    traveled: number,
    palette: RibbonPalette = HEX,
  ): void {
    let r = this.ribbons.find((e) => e.id === id);
    if (!r) {
      r = this.ribbons.find((e) => e.id === "");
      if (!r) {
        return;
        // saturated — this bolt flies without a wake
      }
      r.id = id;
      r.loose = 0;
      // A slot freed by a wake that had faded out still carries that fade —
      // reset it here, not in update(), or the new wake's first frame draws
      // at whatever the old one died at.
      r.uni.uFade.value = 1;
      r.uni.uSeed.value = Math.random() * 100;
      r.uni.uColorCore.value.setHex(palette.core);
      r.uni.uColorBody.value.setHex(palette.body);
      r.uni.uColorTail.value.setHex(palette.tail);
      r.mesh.visible = true;
    }
    r.fed = true;
    r.uni.uHead.value.set(x, h, z);
    r.uni.uDir.value.set(dx, 0, dz);
    r.uni.uSide.value.set(-dz, 0, dx);
    r.uni.uSpan.value = Math.min(RIBBON.span, traveled + 0.4);
  }

  update(dt: number): void {
    for (const r of this.ribbons) {
      if (r.id === "") {
        continue;
      }
      if (r.fed) {
        r.fed = false;
        r.loose = 0;
        r.uni.uFade.value = 1;
        continue;
      }
      // The head is gone (the bolt burst or fizzled): the wake dissolves where
      // it was, tail first.
      r.loose += dt;
      const k = r.loose / RIBBON.loose;
      if (k >= 1) {
        r.id = "";
        r.mesh.visible = false;
        continue;
      }
      r.uni.uFade.value = 1 - k;
    }
  }

  dispose(): void {
    for (const r of this.ribbons) {
      r.mesh.removeFromParent();
      if (r.mesh.material instanceof THREE.Material) {
        r.mesh.material.dispose();
      }
    }
    this.ribbons.length = 0;
    this.geo.dispose();
  }
}
