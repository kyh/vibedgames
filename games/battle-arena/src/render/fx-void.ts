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
  // how hard one side of the ring is beamed, 0 = evenly lit
  beam: 0.75,
  // revolutions/second the beamed side travels
  beamSpin: 0.22,
  // how far the halo is torn into strands
  filament: 0.7,
  filamentScale: 2.2,
  halo: 0.9,
  // how fast the halo dies outward
  haloFalloff: 2.4,
  // how far off the floor it hangs — a body has to be LIFTED in
  height: 0.52,
  // the settled shadow
  horizon: 0.22,
  // how far the halo is drawn, × the horizon
  reach: 4.5,
  // The sandbox runs the ring at 9 under a gentle bloom. Under ours that
  // blooms into a white blob that buries the shadow — the one thing the
  // effect is for — so it sits just over the bloom threshold instead.
  ringGlow: 1.4,
  // thickness of the photon ring, in horizon radii
  ringWidth: 0.05,
  // revolutions/second the whole halo turns
  spin: 0.3,
  // differential winding — inner strands lap outer ones
  wind: 2.4,
} as const;

/** The sequence, in seconds since it opened. */
const BEATS = {
  // × the settled horizon at the top of that
  bloom: 1.35,
  // the collapse, at the end
  pinch: 0.22,
  // back at its settled size
  settle: 0.55,
  // inflating to its overshoot
  swell: 0.3,
} as const;

const TAU = Math.PI * 2;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
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

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
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

// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
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

interface Hole {
  mesh: THREE.Mesh;
  uni: VoidUniforms;
  t: number;
  life: number;
  live: boolean;
  // the settled shadow radius, metres
  horizon: number;
}

export interface VoidOpts {
  /** Seconds it stands, collapse included. */
  life?: number;
  colors?: { photon: number; halo: number; cool: number };
}

/** Grimelda's grade: a bog-green photon ring on a violet halo. */
const HEX = { cool: 0x2a_14_50, halo: 0xb9_8a_e0, photon: 0xb4_ff_a8 } as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Drive one hole's uniforms from its elapsed time. */
const syncHole = (h: Hole): void => {
  const { t } = h;
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
};

/** Pooled singularities. One billboard, one draw call each. */
export class VoidPool {
  private holes: Hole[] = [];
  private geo = new THREE.PlaneGeometry(1, 1);
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene, clock: { value: number }) {
    this.scene = scene;
    for (let i = 0; i < POOL; i += 1) {
      const uni: VoidUniforms = {
        uBeamPhase: { value: 0 },
        uChurn: { value: 0 },
        uColorCool: { value: new THREE.Color(HEX.cool) },
        uColorHalo: { value: new THREE.Color(HEX.halo) },
        uColorPhoton: { value: new THREE.Color(HEX.photon) },
        uFade: { value: 1 },
        uHorizon: { value: 0.3 },
        uSeed: { value: 0 },
        uSize: { value: 1 },
        uTime: clock,
      };
      const mesh = new THREE.Mesh(
        this.geo,
        new THREE.ShaderMaterial({
          blending: THREE.NormalBlending,
          depthWrite: false,
          fragmentShader: FRAG,
          premultipliedAlpha: true,
          side: THREE.DoubleSide,
          transparent: true,
          uniforms: uni,
          vertexShader: VERT,
        }),
      );
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 5;
      this.scene.add(mesh);
      this.holes.push({ horizon: 0.3, life: 1, live: false, mesh, t: 0, uni });
    }
  }

  /** Tear one open over (x, groundY, z), sized to a zone of radius `footprint`. */
  open(x: number, groundY: number, z: number, footprint: number, opts: VoidOpts = {}): void {
    const h = this.holes.find((e) => !e.live);
    if (!h) {
      return;
      // saturated — drop
    }
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
    syncHole(h);
    h.mesh.visible = true;
  }

  update(dt: number): void {
    for (const h of this.holes) {
      if (!h.live) {
        continue;
      }
      h.t += dt;
      if (h.t >= h.life) {
        h.live = false;
        h.mesh.visible = false;
        continue;
      }
      syncHole(h);
    }
  }

  clear(): void {
    for (const h of this.holes) {
      h.live = false;
      h.life = 0;
      h.t = 0;
      h.mesh.visible = false;
    }
  }

  dispose(): void {
    for (const h of this.holes) {
      h.mesh.removeFromParent();
      if (h.mesh.material instanceof THREE.Material) {
        h.mesh.material.dispose();
      }
    }
    this.holes.length = 0;
    this.geo.dispose();
  }
}
