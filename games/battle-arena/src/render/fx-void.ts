// The singularity — the black hole Grimelda's Grand Hex tears open over the
// sealing circle: a shadow, the photon ring piled up on its edge, and the
// lensed light wound around it.
//
// Ported from the Elemental Sandbox VFX sandbox (MIT, Copyright (c) 2026
// mohamedachrefelouafi) — https://github.com/achrefelouafi/LinearAbiltyCastingExtendedThreeJS
// (the "Astral Void Blast" horizon). The sandbox also bends the finished frame
// around the hole through a screen-space distortion pass; we have no such
// pass, so the lens is dropped and the halo carries the read on its own. The
// palette is re-graded from the sandbox's gold-on-violet to Grimelda's bog
// green ring on a violet halo, so it stays hers and not a generic void.
//
// Why a camera-facing quad rather than a sphere: a Schwarzschild shadow is
// CIRCULAR from every direction — it is not the silhouette of a sphere but the
// set of impact parameters below which a photon cannot escape, rotationally
// symmetric about the line of sight whatever the observer does. So a billboard
// is the correct primitive: exactly round at every camera angle, antialiased
// against one analytic radius instead of a tessellated limb.
//
// The disc is PREMULTIPLIED. Inside the shadow the colour is zero and the
// alpha is one, so the frame behind it is replaced by nothing. Straight alpha
// with a near-black colour leaves a dark grey disc, and a grey black hole is
// not a black hole.
import * as THREE from "three";
import { NOISE_GLSL } from "./fx-noise";

const POOL = 2;

/** Every dimension below is × the zone's footprint radius. */
const HOLE = {
  horizon: 0.22, // the settled shadow
  height: 0.52, // how far off the floor it hangs — a body has to be LIFTED in
  reach: 4.5, // how far the halo is drawn, × the horizon
  ringWidth: 0.05, // thickness of the photon ring, in horizon radii
  // The sandbox runs the ring at 9 under a gentle bloom. Under ours that
  // blooms into a white blob that buries the shadow — the one thing the
  // effect is for — so it sits just over the bloom threshold instead.
  ringGlow: 1.4,
  beam: 0.75, // how hard one side of the ring is beamed, 0 = evenly lit
  beamSpin: 0.22, // revolutions/second the beamed side travels
  halo: 0.9,
  haloFalloff: 2.4, // how fast the halo dies outward
  wind: 2.4, // differential winding — inner strands lap outer ones
  spin: 0.3, // revolutions/second the whole halo turns
  filament: 0.7, // how far the halo is torn into strands
  filamentScale: 2.2,
} as const;

/** The sequence, in seconds since it opened. */
const BEATS = {
  swell: 0.3, // inflating to its overshoot
  bloom: 1.35, // × the settled horizon at the top of that
  settle: 0.55, // back at its settled size
  pinch: 0.22, // the collapse, at the end
} as const;

const TAU = Math.PI * 2;

const VERT = /* glsl */ `
uniform float uSize;     // half-width of the quad, metres
uniform float uHorizon;  // radius of the shadow, metres
varying vec2 vLocal;     // -1..1 across the quad
void main() {
  // PlaneGeometry(1, 1) spans -0.5..0.5, so this is the unit square doubled.
  vLocal = position.xy * 2.0;
  // Camera facing: the quad's own basis is thrown away and its corners are
  // laid out in view space around the object's origin.
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * (uSize * 2.0);
  // Pulled forward to the NEAR surface of the sphere it stands for: a
  // silhouette is at the limb, not the middle, and it is what makes a body
  // being drawn into the hole go behind it instead of z-fighting through the
  // one surface in the frame that has to stay solid black.
  mv.z += uHorizon;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
#define TAU 6.283185307179586
uniform float uTime;
uniform float uSize;
uniform float uHorizon;
uniform float uBeamPhase;
uniform float uChurn;     // the flare envelope, 0..1
uniform float uSeed;
uniform float uFade;
uniform vec3  uColorPhoton;
uniform vec3  uColorHalo;
uniform vec3  uColorCool;
varying vec2 vLocal;

${NOISE_GLSL}

mat2 rot2(float a) { float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }

void main() {
  float len = length(vLocal);
  if (len > 1.0) discard;

  // Everything below is measured in horizon radii, so every threshold is a
  // shape rather than a distance and the whole disc rescales for free.
  float scale = uSize / max(uHorizon, 1e-3);
  float r = len * scale;
  float ang = atan(vLocal.y, vLocal.x);

  // One pixel, in those same units. Every band is floored at it, or the ring
  // aliases into a dashed circle the moment the camera pulls back.
  float px = max(fwidth(r), 1e-4);

  /* ---- the shadow ---- */
  float shadow = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);

  /* ---- which side is coming toward us ---- */
  // Relativistic beaming, near enough: the approaching limb is brighter, the
  // receding one dimmer — the cheapest detail that says this is TURNING.
  float toward = cos(ang - uBeamPhase);
  float beam = 1.0 + ${HOLE.beam.toFixed(3)} * toward;

  /* ---- the photon ring ---- */
  // Sat right on the shadow's edge and floored at a pixel. Energy is kept as
  // the band widens, so pulling the camera back dims the ring rather than
  // turning it into a fat bright donut.
  float width = max(${HOLE.ringWidth.toFixed(3)}, px * 1.1);
  float d = (r - 1.0 - width * 0.65) / width;
  float ring = exp(-d * d * 2.2) * (${HOLE.ringWidth.toFixed(3)} / width);
  // A second, much fainter ring outside it: light that went round twice. It is
  // nearly subliminal, and it stops the first ring reading as a drawn outline.
  float d2 = (r - 1.0 - width * 3.4) / (width * 1.6);
  ring += exp(-d2 * d2 * 2.0) * 0.16 * (${HOLE.ringWidth.toFixed(3)} / width);

  /* ---- the lensed halo ---- */
  // Wound at a differential rate: the strands nearest the hole overtake the
  // ones outside them, which is what an orbit does and a spinning texture
  // does not.
  float turn = uTime * ${HOLE.spin.toFixed(3)} * TAU + ${HOLE.wind.toFixed(3)} / (0.25 + r * 0.85);
  vec2 wound = rot2(turn) * vLocal;
  float strands = ridged(vec3(wound * ${HOLE.filamentScale.toFixed(3)}, uTime * 0.25 + uSeed));
  strands = mix(1.0, smoothstep(0.25, 0.95, strands), ${HOLE.filament.toFixed(3)});

  // Falls off outward from the ring, and is cut dead inside the shadow —
  // there is nothing in there to be lit.
  float halo = exp(-(r - 1.0) * ${HOLE.haloFalloff.toFixed(3)}) * smoothstep(1.0 - px, 1.0 + px * 2.0, r);
  halo *= strands;

  /* ---- put it together ---- */
  float flare = 1.0 + uChurn * 0.55;
  vec3 color = uColorPhoton * ring * ${HOLE.ringGlow.toFixed(2)} * beam * flare;
  // The halo cools with distance: hot at the ring, deep violet at the reach.
  vec3 haloTint = mix(uColorHalo, uColorCool, smoothstep(1.0, scale * 0.75, r));
  color += haloTint * halo * ${HOLE.halo.toFixed(3)} * beam * flare;
  color *= uFade;

  // The disc is opaque; outside it the glow carries its own coverage, so it
  // adds to the frame instead of veiling it.
  float glow = ring * ${HOLE.ringGlow.toFixed(2)} + halo * ${HOLE.halo.toFixed(3)};
  float alpha = clamp(shadow + glow * 0.3 * uFade, 0.0, 1.0);
  if (alpha < 0.002) discard;

  // Premultiplied: inside the shadow the colour is zero and the alpha is one.
  gl_FragColor = vec4(color * (1.0 - shadow), alpha);
}`;

type VoidUniforms = {
  uTime: { value: number };
  uSize: { value: number };
  uHorizon: { value: number };
  uBeamPhase: { value: number };
  uChurn: { value: number };
  uSeed: { value: number };
  uFade: { value: number };
  uColorPhoton: { value: THREE.Color };
  uColorHalo: { value: THREE.Color };
  uColorCool: { value: THREE.Color };
};

type Hole = {
  mesh: THREE.Mesh;
  uni: VoidUniforms;
  t: number;
  life: number;
  live: boolean;
  horizon: number; // the settled shadow radius, metres
};

export type VoidOpts = {
  /** Seconds it stands, collapse included. */
  life?: number;
  colors?: { photon: number; halo: number; cool: number };
};

/** Grimelda's grade: a bog-green photon ring on a violet halo. */
const HEX = { photon: 0xb4ffa8, halo: 0xb98ae0, cool: 0x2a1450 } as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Pooled singularities. One billboard, one draw call each. */
export class VoidPool {
  private holes: Hole[] = [];
  private geo = new THREE.PlaneGeometry(1, 1);

  constructor(
    private scene: THREE.Scene,
    clock: { value: number },
  ) {
    for (let i = 0; i < POOL; i++) {
      const uni: VoidUniforms = {
        uTime: clock,
        uSize: { value: 1 },
        uHorizon: { value: 0.3 },
        uBeamPhase: { value: 0 },
        uChurn: { value: 0 },
        uSeed: { value: 0 },
        uFade: { value: 1 },
        uColorPhoton: { value: new THREE.Color(HEX.photon) },
        uColorHalo: { value: new THREE.Color(HEX.halo) },
        uColorCool: { value: new THREE.Color(HEX.cool) },
      };
      const mesh = new THREE.Mesh(
        this.geo,
        new THREE.ShaderMaterial({
          uniforms: uni,
          vertexShader: VERT,
          fragmentShader: FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
          premultipliedAlpha: true,
          side: THREE.DoubleSide,
        }),
      );
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 5;
      this.scene.add(mesh);
      this.holes.push({ mesh, uni, t: 0, life: 1, live: false, horizon: 0.3 });
    }
  }

  /** Tear one open over (x, groundY, z), sized to a zone of radius `footprint`. */
  open(x: number, groundY: number, z: number, footprint: number, opts: VoidOpts = {}): void {
    const h = this.holes.find((e) => !e.live);
    if (!h) return; // saturated — drop
    const colors = opts.colors ?? HEX;
    h.live = true;
    h.t = 0;
    h.life = opts.life ?? 1.6;
    h.horizon = HOLE.horizon * footprint;
    h.mesh.position.set(x, groundY + HOLE.height * footprint, z);
    h.uni.uSeed.value = Math.random() * 100;
    h.uni.uColorPhoton.value.setHex(colors.photon);
    h.uni.uColorHalo.value.setHex(colors.halo);
    h.uni.uColorCool.value.setHex(colors.cool);
    this.sync(h);
    h.mesh.visible = true;
  }

  private sync(h: Hole): void {
    const t = h.t;
    // Inflates past its size and settles back, then at the very end pinches
    // to nothing — the collapse is faster than the opening, on purpose.
    let size: number;
    if (t < BEATS.swell) {
      const k = t / BEATS.swell;
      size = BEATS.bloom * (1 - (1 - k) * (1 - k));
    } else if (t < BEATS.settle) {
      const k = (t - BEATS.swell) / (BEATS.settle - BEATS.swell);
      size = BEATS.bloom + (1 - BEATS.bloom) * k;
    } else {
      size = 1;
    }
    const pinchStart = h.life - BEATS.pinch;
    const pinch = clamp01((t - pinchStart) / BEATS.pinch);
    size *= 1 - pinch * pinch;
    // The halo flares as it opens and again as it goes.
    const churn = Math.max(1 - t / BEATS.settle, pinch);

    const horizon = Math.max(0.01, h.horizon * size);
    h.uni.uHorizon.value = horizon;
    h.uni.uSize.value = horizon * HOLE.reach;
    h.uni.uBeamPhase.value = t * HOLE.beamSpin * TAU;
    h.uni.uChurn.value = churn;
    h.uni.uFade.value = 1 - pinch * 0.5;
  }

  update(dt: number): void {
    for (const h of this.holes) {
      if (!h.live) continue;
      h.t += dt;
      if (h.t >= h.life) {
        h.live = false;
        h.mesh.visible = false;
        continue;
      }
      this.sync(h);
    }
  }

  dispose(): void {
    for (const h of this.holes) {
      h.mesh.removeFromParent();
      if (h.mesh.material instanceof THREE.Material) h.mesh.material.dispose();
    }
    this.holes.length = 0;
    this.geo.dispose();
  }
}
