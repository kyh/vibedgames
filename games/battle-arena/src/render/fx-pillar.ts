// The column of judgment — a shaft of light standing on the mark, a
// four-pointed star welded to its head, and two counter-tilted halo rings
// turning about it. Aurelius' Consecrating Smite lands in this.
//
// Ported from the Elemental Sandbox VFX sandbox (MIT, Copyright (c) 2026
// mohamedachrefelouafi) — https://github.com/achrefelouafi/LinearAbiltyCastingExtendedThreeJS
// (the "Celestial Rend"), re-scaled for our arena: the sandbox's column is
// thirty metres tall on a five-metre footprint; ours has to sit inside a
// three-metre stun zone under a camera a fifth as far away, so every dimension
// is a multiple of the zone radius and the flute count is roughly halved.
//
// Why the column is shaded on N·V and not on a fresnel: a beam of light is a
// VOLUME, and what the eye reads as its brightness is how much of that volume
// the ray crossed — longest through the middle of the silhouette, nothing at
// the edges. A fresnel is bright at the rim and hollow in the middle, which is
// what a soap bubble looks like, not a searchlight. (Our older fx-beam pillar
// already folds the same rod-weighting in; this one adds the flutes, the skirt
// where it meets the stone, and the star + rings on top.)
//
// Why the star is not a texture: authored as a polar field it is three raised
// cosines summed into a reach, with a hard boundary and a shaded interior —
// concave-sided points that stay sharp at any size, with bloom on top.
//
// All three pieces are built in WORLD space by their vertex shaders (the
// column and the star never leave the origin), so the pool never touches a
// vertex: strike() writes a centre and a footprint, and update() scrubs one
// clock through every uniform.
import * as THREE from "three";
import { NOISE_GLSL } from "./fx-noise";

const POOL = 3;
const CLIMB_ROWS = 26; // samples up the shaft
const AROUND_COLS = 48; // ...and around it

/** Every dimension below is × the footprint radius unless it says metres. */
const COLUMN = {
  height: 5.2, // the shaft, × footprint — it leaves the top of the frame on purpose
  radius: 0.3, // the shaft
  skirt: 1.1, // how far it flares where it meets the stone
  skirtPower: 4.5, // ... and how fast that closes with height
  topFlare: 1.25, // how much wider it is at the top
  flarePower: 1.6,
  wobble: 0.08, // noise on the barrel, × its radius
  wobbleScale: 1.1,
  wobbleSpeed: 1.2,
  spin: 0.05, // revolutions/second the barrel turns
  // The star and the rings sit LOW — a unit and a half off the floor, not the
  // sandbox's 40% of a thirty-metre shaft. Our camera looks steeply down at
  // the arena, and anything higher than a few metres is simply above the top
  // of the frame.
  starSeat: 0.95, // where the star hangs, × footprint (metres up)
  starSize: 0.75, // its half-extent, × footprint
  haloOuter: 1.05, // the rings' outer edge, × footprint
  haloSeat: 0.87, // where the band sits inside that
  haloBand: 0.055, // ... and how deep it is
  haloSecond: 0.9, // the second ring, × the first
  haloTilt: 0.34, // radians each leans, opposite ways
  haloSpin: 0.11, // revolutions/second, opposite ways
  haloLift: 0.3, // metres apart they sit, × footprint
} as const;

/** The sequence, in seconds since the strike. */
const BEATS = {
  rise: 0.26, // the beam's front reaching the top
  starDelay: 0.1,
  starTime: 0.36,
  haloDelay: 0.14,
  haloStagger: 0.09,
  haloTime: 0.4,
  hold: 0.95, // full brightness until here
  life: 1.6, // gone
  pulseRate: 1.4, // the toll envelope
} as const;

const TAU = Math.PI * 2;

// ── the column ──────────────────────────────────────────────────────────────

const PILLAR_VERT = /* glsl */ `
#define TAU 6.283185307179586
uniform float uTime;
uniform vec3  uCentre;
uniform float uRadius;
uniform float uHeight;
uniform float uSeed;

varying float vClimb;
varying float vAround;
varying vec3  vNormalW;
varying vec3  vWorld;

${NOISE_GLSL}

void main() {
  float t = position.x; // 0 at the floor, 1 at the top of the shaft
  float a = position.y; // 0..1 once around
  float angle = a * TAU + uTime * ${COLUMN.spin.toFixed(3)} * TAU;

  // The profile: a wide skirt where it meets the stone, closing hard into the
  // shaft, then opening slowly with height. The skirt is not decoration — it
  // is what makes the column look like it is STANDING ON the mark rather than
  // passing through the floor.
  float skirt = ${COLUMN.skirt.toFixed(3)} * pow(1.0 - t, ${COLUMN.skirtPower.toFixed(3)});
  float shaft = mix(1.0, ${COLUMN.topFlare.toFixed(3)}, pow(t, ${COLUMN.flarePower.toFixed(3)}));
  float wobble = snoise(vec3(cos(angle) * ${COLUMN.wobbleScale.toFixed(3)}, sin(angle) * ${COLUMN.wobbleScale.toFixed(3)},
                             t * ${(COLUMN.wobbleScale * 2).toFixed(3)} - uTime * ${COLUMN.wobbleSpeed.toFixed(3)} + uSeed)) * ${COLUMN.wobble.toFixed(3)};
  float radius = max(0.02, uRadius * (shaft + skirt + wobble));

  vec3 world = uCentre + vec3(cos(angle), 0.0, sin(angle)) * radius;
  world.y += t * uHeight;

  vClimb = t;
  vAround = a;
  vWorld = world;
  // Radial — the surface normal of a cylinder everywhere but the skirt, and
  // the skirt is short enough that the error never shows.
  vNormalW = vec3(cos(angle), 0.0, sin(angle));
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const PILLAR_FRAG = /* glsl */ `
#define PI 3.141592653589793
uniform float uTime;
uniform float uGrown;
uniform float uFront;
uniform float uFade;
uniform float uSeed;
uniform float uCharge;
uniform float uPulse;
uniform vec3  uColorCore;
uniform vec3  uColorBody;
uniform vec3  uColorEdge;
uniform vec3  uColorCool;

varying float vClimb;
varying float vAround;
varying vec3  vNormalW;
varying vec3  vWorld;

${NOISE_GLSL}

void main() {
  // The beam races up out of the mark. Nothing above the front exists yet.
  float live = 1.0 - smoothstep(uGrown - 0.04, uGrown + 0.02, vClimb);
  if (live < 0.003) discard;

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = abs(dot(normalize(vNormalW), V));

  // How much beam this ray crossed: a power of |N.V|, NOT of 1 - |N.V| — the
  // chord through a cylinder is longest through the middle of the silhouette.
  float body = pow(ndv, 1.3);
  // ... and the white-hot filament down the axis: the same term run much harder.
  float core = pow(ndv, 9.0) * 0.35;
  // The caustic boundary. Small, and only here so the shaft has an edge.
  float rim = pow(1.0 - ndv, 2.2) * 0.35;

  // Flutes combed up the barrel, drifting slowly around it, with streams of
  // light pouring up through them in the barrel's own cylindrical space.
  float flute = pow(abs(sin((vAround + uTime * 0.035) * PI * 12.0)), 0.55);
  float stream = fbm2(vec3(vAround * 6.0, vClimb * 3.0 - uTime * 1.6, uSeed));
  stream = smoothstep(-0.3, 0.7, stream);
  float combed = mix(1.0, mix(flute, 1.0, 0.35) * (0.45 + 0.75 * stream), 0.6);

  // Top: the beam does not end, it loses itself. Bottom: it piles up on the
  // stone, which is where the ability is actually happening.
  float top = 1.0 - smoothstep(0.58, 1.0, vClimb);
  float foot = 1.0 + 0.7 * exp(-vClimb / 0.12);
  // The hot leading edge while it is still climbing.
  float front = exp(-pow((vClimb - uGrown) / 0.055, 2.0)) * uFront;

  float beat = 1.0 + uPulse * 0.35 + uCharge * 0.5;
  float energy = (body * combed + core) * live * top * foot * beat;

  // Gold in its mass with blue-white light escaping off its edges.
  vec3 color = mix(uColorBody, uColorCore, clamp(core * 1.4 + front, 0.0, 1.0));
  color = mix(color, uColorEdge, smoothstep(0.35, 1.0, vClimb) * 0.45);
  color *= energy;
  color += uColorCool * rim * live * top * beat;
  color += uColorCore * front * 1.4 * live;
  // The sandbox runs this at 0.36 under a gentler bloom; under ours anything
  // past ~1 in the additive sum turns the shaft into a white slab with the
  // subject lost inside it, so the whole thing is held well under the bloom
  // threshold and the star is left to carry the hot spot.
  color *= 0.22 * uFade;

  float alpha = clamp(energy * 0.55 + rim * 0.3 + front * 0.5, 0.0, 1.0) * uFade;
  if (alpha < 0.003) discard;
  color /= 1.0 + color * 0.25;
  gl_FragColor = vec4(color, alpha);
}`;

// ── the star at its head ────────────────────────────────────────────────────

const STAR_VERT = /* glsl */ `
uniform vec3  uCentre;
uniform float uSize;
varying vec2 vLocal;
void main() {
  // Billboarded off the camera basis, kept UPRIGHT in screen space on purpose:
  // the star has a long vertical axis and a shorter horizontal one, and a star
  // that rolls with the camera loses that read immediately.
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vLocal = position.xy * 2.0;
  vec3 world = uCentre + (right * position.x + up * position.y) * uSize * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const STAR_FRAG = /* glsl */ `
#define TAU 6.283185307179586
uniform float uTime;
uniform float uSeed;
uniform float uFade;
uniform float uCharge;
uniform float uPulse;
uniform vec3  uColorCore;
uniform vec3  uColorBody;
uniform vec3  uColorEdge;
uniform vec3  uColorCool;
varying vec2 vLocal;

${NOISE_GLSL}

void main() {
  vec2 p = vLocal;
  float d = length(p);
  if (d > 1.35) discard;
  float inv = 1.0 / max(d, 1e-4);
  float c = p.x * inv;
  float s = p.y * inv;

  // Three raised cosines summed: a long vertical pair, a shorter horizontal
  // pair, four short diagonals. Each is concave-sided by construction, which
  // is what a polygonal star is not.
  float reach = 1.0  * pow(abs(s), 7.0)
              + 0.72 * pow(abs(c), 11.0)
              + 0.1  * pow(abs(2.0 * s * c), 7.0);

  // The fine spray between them: many short needles, eaten by noise so they
  // are not a comb, turning slowly against the star itself.
  float ang = atan(p.y, p.x) + uTime * 0.015 * TAU;
  float needle = pow(abs(sin(ang * 17.0)), 9.0);
  needle *= 0.35 + 0.65 * (0.5 + 0.5 * snoise(vec3(cos(ang) * 3.0, sin(ang) * 3.0, uSeed + uTime * 0.25)));
  reach += needle * 0.09;

  float flicker = 1.0 + 0.12 * snoise(vec3(uSeed, uTime * 2.6, 0.0));
  float beat = (1.0 + uPulse * 0.6 + uCharge * 0.9) * flicker;

  // A hard boundary with a soft interior, not a bare exponential: exp(-d/reach)
  // never reaches zero, so the concave sides between the points never resolve
  // into a silhouette. The beat is deliberately NOT in the reach — a star
  // whose reach breathes grows past its quad and squares off at the edge.
  float span = max(reach * 0.86, 1e-4);
  float rays = pow(clamp(1.0 - d / span, 0.0, 1.0), 1.5);
  float halo = exp(-d / max(span * 0.35, 1e-4)) * 0.35;
  float window = 1.0 - smoothstep(0.85, 1.2, d);
  float core = exp(-(d * d) / 0.0036) * 0.9;

  // The thin circle struck through it.
  float f = d - 0.5;
  float g = max(fwidth(f), 1e-7);
  float ring = (1.0 - smoothstep(0.0, max(0.008, g), abs(f))) * 0.3;

  float energy = (rays + halo + core + ring) * beat * window;
  if (energy < 0.004) discard;

  // Warm through the body, near-white in the core, and a cold fringe out at
  // the extreme tips — the one place the gold turns blue.
  vec3 color = mix(uColorBody, uColorCore, clamp(core + rays * 0.35, 0.0, 1.0));
  color = mix(color, uColorEdge, smoothstep(0.12, 0.5, d));
  color = mix(color, uColorCool, smoothstep(0.45, 0.95, d) * 0.7);
  color *= energy * 0.7 * uFade;

  float alpha = clamp(energy, 0.0, 1.0) * uFade;
  color /= 1.0 + color * 0.22;
  gl_FragColor = vec4(color, alpha);
}`;

// ── the halo rings ──────────────────────────────────────────────────────────

const HALO_VERT = /* glsl */ `
uniform float uOuter;
varying vec2 vLocal;
void main() {
  // The annulus arrives as a unit ring; the pool tilts and turns the mesh, so
  // everything below works in the ring's own plane and never has to know
  // which way it is leaning.
  vLocal = position.xy * uOuter;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy * uOuter, 0.0, 1.0);
}`;

const HALO_FRAG = /* glsl */ `
#define TAU 6.283185307179586
uniform float uTime;
uniform float uSeed;
uniform float uFade;
uniform float uCharge;
uniform float uPulse;
uniform float uSeat;
uniform float uBand;
uniform float uOpen;
uniform vec3  uColorCore;
uniform vec3  uColorBody;
uniform vec3  uColorCool;
varying vec2 vLocal;

${NOISE_GLSL}

/** Any field, stroked as a line of constant apparent width. */
float lineAA(float f, float w) {
  float g = max(fwidth(f), 1e-7);
  float px = abs(f) / g;
  float want = w / g;
  float ww = max(want, 1.0);
  return (1.0 - smoothstep(0.0, ww, px)) * (want / ww);
}

void main() {
  float r = length(vLocal);
  float a = atan(vLocal.y, vLocal.x);

  // Across the band: a soft profile with a hot line down its middle.
  float d = r - uSeat;
  float across = 1.0 - smoothstep(0.0, max(uBand, 1e-4), abs(d));
  if (across < 0.003) discard;
  float body = pow(across, 1.6);

  // The two rails that fence it — what makes a ring read as machined rather
  // than as a smear of light at this radius.
  float rails = lineAA(abs(d) - uBand * 0.86, 0.03) * 1.2;

  // Dashes cut around it, drifting slowly.
  float turn = a / TAU + uTime * 0.03;
  float cell = fract(turn * 44.0);
  float dash = smoothstep(0.0, 0.08, cell) * (1.0 - smoothstep(0.5, 0.58, cell));
  float dashed = mix(1.0, dash, 0.55);

  // Glyph beads seated on the band at a lower count — a handful of bright
  // nodes, not an even necklace.
  float gcell = fract(turn * 4.0);
  float bead = 1.0 - smoothstep(0.0, 0.012, min(gcell, 1.0 - gcell));
  bead *= (1.0 - smoothstep(0.0, uBand * 0.9, abs(d))) * 0.9;

  // The lit limb: one side brighter than the other, and that side travels,
  // which is what says the thing is turning at speed.
  float sweep = pow(max(0.0, cos(a - uTime * 0.22 * TAU)), 2.4) * 1.1;
  float grain = 1.0 + (0.5 + 0.5 * snoise(vec3(cos(a) * 3.0, sin(a) * 3.0, uTime * 0.3 + uSeed)) - 0.5) * 0.35;

  // The ring writes itself on from one bearing outward, so it snaps into
  // existence as an arc rather than appearing whole.
  float written = smoothstep(0.0, 0.14, uOpen - fract((a + 3.14159265) / TAU));
  written = max(written, step(0.999, uOpen));

  float beat = 1.0 + uPulse * 0.5 + uCharge * 0.8;
  float energy = (body * dashed * (1.0 + sweep) + rails + bead * 1.5) * grain * written * beat;
  if (energy < 0.004) discard;

  vec3 color = mix(uColorBody, uColorCore, clamp(rails + bead + sweep * 0.4, 0.0, 1.0));
  color = mix(color, uColorCool, smoothstep(0.6, 1.0, 1.0 - across) * 0.5);
  color *= energy * 0.42 * uFade;

  float alpha = clamp(energy, 0.0, 1.0) * 0.7 * uFade;
  color /= 1.0 + color * 0.2;
  gl_FragColor = vec4(color, alpha);
}`;

type PillarUniforms = {
  uTime: { value: number };
  uCentre: { value: THREE.Vector3 };
  uRadius: { value: number };
  uHeight: { value: number };
  uSeed: { value: number };
  uGrown: { value: number };
  uFront: { value: number };
  uFade: { value: number };
  uCharge: { value: number };
  uPulse: { value: number };
  uColorCore: { value: THREE.Color };
  uColorBody: { value: THREE.Color };
  uColorEdge: { value: THREE.Color };
  uColorCool: { value: THREE.Color };
};

type StarUniforms = {
  uTime: { value: number };
  uCentre: { value: THREE.Vector3 };
  uSize: { value: number };
  uSeed: { value: number };
  uFade: { value: number };
  uCharge: { value: number };
  uPulse: { value: number };
  uColorCore: { value: THREE.Color };
  uColorBody: { value: THREE.Color };
  uColorEdge: { value: THREE.Color };
  uColorCool: { value: THREE.Color };
};

type HaloUniforms = {
  uTime: { value: number };
  uOuter: { value: number };
  uSeat: { value: number };
  uBand: { value: number };
  uOpen: { value: number };
  uSeed: { value: number };
  uFade: { value: number };
  uCharge: { value: number };
  uPulse: { value: number };
  uColorCore: { value: THREE.Color };
  uColorBody: { value: THREE.Color };
  uColorCool: { value: THREE.Color };
};

type Halo = { mesh: THREE.Mesh; uni: HaloUniforms; dir: number };

type Pillar = {
  column: THREE.Mesh;
  star: THREE.Mesh;
  halos: [Halo, Halo];
  uni: PillarUniforms;
  starUni: StarUniforms;
  t: number; // seconds since the strike
  live: boolean;
  footprint: number;
  height: number;
  starY: number; // world height of the star (and the rings' seat)
};

export type PillarOpts = {
  /** The four-stop palette: core (near-white), body, edge, cool fringe. */
  colors?: { core: number; body: number; edge: number; cool: number };
};

const GOLD = { core: 0xfffdf2, body: 0xffd489, edge: 0xffb254, cool: 0xbcd8ff } as const;

/**
 * A grid of quads in parameter space: (x = along, y = around), z unused.
 * The vertex shader turns every pair into a world position.
 */
function parameterGrid(rows: number, columns: number): THREE.BufferGeometry {
  const positions = new Float32Array(rows * columns * 3);
  let v = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < columns; j++) {
      positions[v++] = i / (rows - 1);
      positions[v++] = j / (columns - 1);
      positions[v++] = 0;
    }
  }
  const indices = new Uint16Array((rows - 1) * (columns - 1) * 6);
  let k = 0;
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < columns - 1; j++) {
      const a = i * columns + j;
      const b = a + columns;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  // Placed in world space by the shader — its own bounds mean nothing.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return geo;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Linear ramp 0→1 over [start, start + dur]. */
const ramp = (t: number, start: number, dur: number) => clamp01((t - start) / Math.max(dur, 1e-3));
const easeOut = (k: number) => 1 - (1 - k) * (1 - k);

/** Pooled columns of light. Four draw calls each: shaft, star, two rings. */
export class PillarPool {
  private pillars: Pillar[] = [];
  private columnGeo = parameterGrid(CLIMB_ROWS, AROUND_COLS);
  private starGeo = new THREE.PlaneGeometry(1, 1);
  private haloGeo = new THREE.RingGeometry(0.52, 1.0, 72, 1);

  constructor(
    private scene: THREE.Scene,
    clock: { value: number },
  ) {
    for (let i = 0; i < POOL; i++) {
      const uni: PillarUniforms = {
        uTime: clock,
        uCentre: { value: new THREE.Vector3() },
        uRadius: { value: 1 },
        uHeight: { value: 10 },
        uSeed: { value: 0 },
        uGrown: { value: 0 },
        uFront: { value: 1 },
        uFade: { value: 1 },
        uCharge: { value: 0 },
        uPulse: { value: 0 },
        uColorCore: { value: new THREE.Color(GOLD.core) },
        uColorBody: { value: new THREE.Color(GOLD.body) },
        uColorEdge: { value: new THREE.Color(GOLD.edge) },
        uColorCool: { value: new THREE.Color(GOLD.cool) },
      };
      const column = new THREE.Mesh(
        this.columnGeo,
        new THREE.ShaderMaterial({
          uniforms: uni,
          vertexShader: PILLAR_VERT,
          fragmentShader: PILLAR_FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      column.frustumCulled = false;
      column.visible = false;
      column.renderOrder = 6;
      this.scene.add(column);

      const starUni: StarUniforms = {
        uTime: clock,
        uCentre: { value: new THREE.Vector3() },
        uSize: { value: 1 },
        uSeed: { value: 0 },
        uFade: { value: 1 },
        uCharge: { value: 0 },
        uPulse: { value: 0 },
        uColorCore: { value: new THREE.Color(GOLD.core) },
        uColorBody: { value: new THREE.Color(GOLD.body) },
        uColorEdge: { value: new THREE.Color(GOLD.edge) },
        uColorCool: { value: new THREE.Color(GOLD.cool) },
      };
      const star = new THREE.Mesh(
        this.starGeo,
        new THREE.ShaderMaterial({
          uniforms: starUni,
          vertexShader: STAR_VERT,
          fragmentShader: STAR_FRAG,
          transparent: true,
          depthWrite: false,
          // Off on purpose: the star is the brightest thing in the ability and
          // sits inside the column's own volume. Tested against the shaft it
          // would be punched through by whichever wall was nearer the camera.
          depthTest: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      star.frustumCulled = false;
      star.visible = false;
      star.renderOrder = 7;
      this.scene.add(star);

      const mkHalo = (dir: number): Halo => {
        const hu: HaloUniforms = {
          uTime: clock,
          uOuter: { value: 1 },
          uSeat: { value: 0.87 },
          uBand: { value: 0.1 },
          uOpen: { value: 0 },
          uSeed: { value: 0 },
          uFade: { value: 1 },
          uCharge: { value: 0 },
          uPulse: { value: 0 },
          uColorCore: { value: new THREE.Color(GOLD.core) },
          uColorBody: { value: new THREE.Color(GOLD.body) },
          uColorCool: { value: new THREE.Color(GOLD.cool) },
        };
        const mesh = new THREE.Mesh(
          this.haloGeo,
          new THREE.ShaderMaterial({
            uniforms: hu,
            vertexShader: HALO_VERT,
            fragmentShader: HALO_FRAG,
            transparent: true,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          }),
        );
        mesh.frustumCulled = false;
        mesh.visible = false;
        mesh.renderOrder = 7;
        this.scene.add(mesh);
        return { mesh, uni: hu, dir };
      };

      this.pillars.push({
        column,
        star,
        halos: [mkHalo(1), mkHalo(-1)],
        uni,
        starUni,
        t: 0,
        live: false,
        footprint: 1,
        height: 10,
        starY: 0,
      });
    }
  }

  /**
   * Stand a column up on (x, groundY, z) over a zone of radius `footprint`.
   * Everything scales off the footprint, so a rank-4 smite is a bigger column
   * for free.
   */
  strike(x: number, groundY: number, z: number, footprint: number, opts: PillarOpts = {}): void {
    const p = this.pillars.find((e) => !e.live);
    if (!p) return; // saturated — drop
    const colors = opts.colors ?? GOLD;
    p.live = true;
    p.t = 0;
    p.footprint = footprint;
    p.height = COLUMN.height * footprint;
    p.starY = groundY + COLUMN.starSeat * footprint;
    const seed = Math.random() * 100;

    p.uni.uCentre.value.set(x, groundY, z);
    p.uni.uRadius.value = COLUMN.radius * footprint;
    p.uni.uHeight.value = p.height;
    p.uni.uSeed.value = seed;
    p.uni.uColorCore.value.setHex(colors.core);
    p.uni.uColorBody.value.setHex(colors.body);
    p.uni.uColorEdge.value.setHex(colors.edge);
    p.uni.uColorCool.value.setHex(colors.cool);

    p.starUni.uCentre.value.set(x, p.starY, z);
    p.starUni.uSeed.value = seed;
    p.starUni.uColorCore.value.setHex(colors.core);
    p.starUni.uColorBody.value.setHex(colors.body);
    p.starUni.uColorEdge.value.setHex(colors.edge);
    p.starUni.uColorCool.value.setHex(colors.cool);

    const outer = COLUMN.haloOuter * footprint;
    for (const [i, h] of p.halos.entries()) {
      const scale = i === 0 ? 1 : COLUMN.haloSecond;
      h.uni.uOuter.value = outer * scale;
      h.uni.uSeat.value = outer * scale * COLUMN.haloSeat;
      h.uni.uBand.value = outer * scale * COLUMN.haloBand;
      h.uni.uSeed.value = seed + i * 7.3;
      h.uni.uOpen.value = 0;
      h.uni.uColorCore.value.setHex(colors.core);
      h.uni.uColorBody.value.setHex(colors.body);
      h.uni.uColorCool.value.setHex(colors.cool);
      h.mesh.position.set(x, p.starY + (i === 0 ? 0.5 : -0.5) * COLUMN.haloLift * footprint, z);
      // Lying flat, then leaned opposite ways so the pair reads as a gyroscope.
      h.mesh.rotation.set(-Math.PI / 2 + COLUMN.haloTilt * h.dir, 0, 0);
    }
    this.sync(p);
    p.column.visible = true;
    p.star.visible = true;
    for (const h of p.halos) h.mesh.visible = true;
  }

  private sync(p: Pillar): void {
    const t = p.t;
    // One clock, every beat a threshold on it: the column climbs, the star and
    // the rings open behind its front, everything fades together at the end.
    const grown = easeOut(ramp(t, 0, BEATS.rise));
    const fade = 1 - ramp(t, BEATS.hold, BEATS.life - BEATS.hold);
    const charge = Math.max(0, 1 - t * 1.4); // hottest at the instant it lands
    const pulse = 0.5 + 0.5 * Math.sin(t * BEATS.pulseRate * TAU);

    p.uni.uGrown.value = grown;
    p.uni.uFront.value = 1 - grown;
    p.uni.uFade.value = fade;
    p.uni.uCharge.value = charge;
    p.uni.uPulse.value = pulse;

    const starOpen = easeOut(ramp(t, BEATS.starDelay, BEATS.starTime));
    p.starUni.uSize.value = COLUMN.starSize * p.footprint * (0.2 + 0.8 * starOpen);
    p.starUni.uFade.value = fade * starOpen;
    p.starUni.uCharge.value = charge;
    p.starUni.uPulse.value = pulse;

    for (const [i, h] of p.halos.entries()) {
      const open = ramp(t, BEATS.haloDelay + i * BEATS.haloStagger, BEATS.haloTime);
      h.uni.uOpen.value = open;
      h.uni.uFade.value = fade;
      h.uni.uCharge.value = charge;
      h.uni.uPulse.value = pulse;
      // Leaned opposite ways and turning opposite ways, on the ring's own
      // tilted axis — a spin about world-up would keep the lean fixed in
      // screen space and the pair would stop reading as a gyroscope.
      h.mesh.rotation.z = t * COLUMN.haloSpin * TAU * h.dir;
    }
  }

  update(dt: number): void {
    for (const p of this.pillars) {
      if (!p.live) continue;
      p.t += dt;
      if (p.t >= BEATS.life) {
        p.live = false;
        p.column.visible = false;
        p.star.visible = false;
        for (const h of p.halos) h.mesh.visible = false;
        continue;
      }
      this.sync(p);
    }
  }

  clear(): void {
    for (const p of this.pillars) {
      p.live = false;
      p.t = 0;
      p.column.visible = false;
      p.star.visible = false;
      for (const h of p.halos) h.mesh.visible = false;
    }
  }

  dispose(): void {
    for (const p of this.pillars) {
      for (const m of [p.column, p.star, p.halos[0].mesh, p.halos[1].mesh]) {
        m.removeFromParent();
        if (m.material instanceof THREE.Material) m.material.dispose();
      }
    }
    this.pillars.length = 0;
    this.columnGeo.dispose();
    this.starGeo.dispose();
    this.haloGeo.dispose();
  }
}
