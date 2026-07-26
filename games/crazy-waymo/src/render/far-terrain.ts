import * as THREE from "three";

import { DETAIL_DISTANCE } from "../world/city";
import type { GoldenGatePlan, SilhouetteBar } from "../world/golden-gate";
import { goldenGateSilhouette, goldenGateSolvedPlan } from "../world/golden-gate";
import { HAZE_AMOUNT, HAZE_BASE, HAZE_SCALE } from "./aerial-fog";
import { liveQuality } from "./quality";

// The horizon beyond the map: Marin and Mount Tam over the Gate, the East Bay
// ridge and Diablo across the water, San Bruno Mountain and the peninsula to
// the south. Without it the world ends at the border wall and every long view
// bottoms out in flat haze.
//
// Three curtain bands of flat silhouette, one draw call, ~1.5k triangles. Each
// band is a ring of quads at a fixed world radius whose top edge follows a
// bearing profile built from Gaussian ridges. Bands are emitted far-first so
// painter order inside the single draw gives the near ridges priority.
//
// DISTANCE COMPRESSION. The real bands sit 1.9–3.6km out, past the camera's
// 2000u far plane. Rather than move the far plane (and lose depth precision
// across the whole game) the vertex shader rescales each vertex along the ray
// from the camera onto a fixed shell: `p = cam + (world - cam) * shell / dist`.
// Uniform scaling of the camera-relative vector leaves the view direction —
// and therefore the silhouette — pixel-identical, while parallax survives
// because the scale factor still depends on true distance. Nothing clips.
//
// COMPOSITING. The band draws with no depth test and no depth write, right
// after the sky dome (renderOrder -2) and before every real mesh, so any actual
// geometry — ground, buildings, ocean — simply paints over it.

const SHELL = 1300; // radius the compressed silhouette is drawn at
const SEGMENTS = 192; // ring resolution
const BASE_Y = -90; // curtain foot, well under the horizon line
const SEA_FLOOR = -8; // profile floor where there is only open ocean
// Soft crest. The band cannot use alpha — it is opaque on purpose so it draws
// in the opaque bucket ahead of the city (a transparent one would sort AFTER
// every building and paint over the world). So the softness is GEOMETRY: one
// extra strip above each crest whose colour runs from the ridge to pure fog.
// Without it a 1.5–3.6 km ridgeline ends on a razor line against the sky and
// the whole belt reads as a cardboard cut-out.
const FRINGE = 0.16; // strip height as a fraction of the crest's height above sea
const FRINGE_MIN = 6; // ...but never thinner than this in world units
// Relief. One flat fill per band is the other half of the cardboard read, so
// each vertex gets a value multiplier from a low-frequency bearing wave (broad
// flanks catching or losing the light) plus a lift toward the crest.
const RELIEF = 0.2;

/** A summit in bearing space: 0 = north (-Z), 90 = east (+X). */
type Ridge = {
  readonly bearing: number;
  readonly width: number; // degrees, Gaussian sigma
  readonly height: number; // world units above sea level
};

type Band = {
  readonly radius: number;
  /** 0 = crisp, 1 = fully dissolved into the horizon haze. */
  readonly haze: number;
  readonly color: number;
  readonly ridges: readonly Ridge[];
};

// Ordered far → near; the emitter relies on it for painter order.
//
// Haze came DOWN across all three bands in the 2026-07-26 grading pass. At 0.74
// the far band was 74–92% fog colour, so at golden hour — when the fog is sand —
// the entire horizon arc resolved to one flat sand fill at the same hue as the
// mid-distance building tan, and the city and its backdrop merged. The bands
// keep enough of their own blue now to sit BEHIND the city rather than in it.
const BANDS: readonly Band[] = [
  {
    radius: 3600,
    haze: 0.5,
    color: 0x8fa5c2,
    // Broad Gaussians alone give a band ONE smooth dome per ridge, which from
    // the city reads as a sand-coloured hill-shaped cut-out. Narrow secondary
    // summits riding on the broad ones break the outline into a range.
    ridges: [
      { bearing: 76, width: 9, height: 300 }, // Mount Diablo
      { bearing: 96, width: 34, height: 200 }, // Berkeley / Oakland hills
      { bearing: 86, width: 6, height: 232 }, // ...and its northern shoulder
      { bearing: 108, width: 7, height: 218 }, // ...and its southern one
      { bearing: 132, width: 26, height: 170 }, // inner coast range, south-east
      { bearing: 122, width: 5, height: 196 },
      { bearing: 145, width: 8, height: 188 },
    ],
  },
  {
    radius: 2600,
    haze: 0.42,
    color: 0x778fae,
    ridges: [
      { bearing: 344, width: 11, height: 260 }, // Mount Tamalpais
      { bearing: 357, width: 20, height: 165 }, // Marin ridge
      { bearing: 24, width: 14, height: 105 }, // Tiburon
      { bearing: 47, width: 17, height: 120 }, // Richmond hills
      { bearing: 177, width: 15, height: 155 }, // San Bruno Mountain
      { bearing: 201, width: 21, height: 175 }, // peninsula ridge
    ],
  },
  {
    radius: 1850,
    haze: 0.24,
    color: 0x647a99,
    ridges: [
      { bearing: 322, width: 13, height: 110 }, // Marin headlands, west of the Gate
      { bearing: 12, width: 7, height: 78 }, // Angel Island
      { bearing: 101, width: 19, height: 52 }, // Oakland shoreline
    ],
  },
];

/** Skyline height at a bearing: the tallest ridge wins, no stacking. */
function profileAt(ridges: readonly Ridge[], bearing: number): number {
  let h = SEA_FLOOR;
  for (const r of ridges) {
    // Wrap the bearing delta into ±180 so a ridge at 357° reaches past north.
    let d = bearing - r.bearing;
    d -= Math.round(d / 360) * 360;
    const g = r.height * Math.exp(-(d * d) / (2 * r.width * r.width));
    if (g > h) h = g;
  }
  return h;
}

const VERT = /* glsl */ `
  attribute float aTop;
  attribute float aHaze;
  attribute vec3 aTint;
  attribute float aFringe;
  attribute float aRelief;
  uniform float uShell;
  uniform vec3 uFog;
  uniform float uNight;
  varying vec3 vColor;
  void main() {
    vec3 rel = position - cameraPosition;
    float d = max(length(rel.xz), 1.0);
    vec3 p = cameraPosition + rel * (uShell / d);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    // Aerial perspective within the band: the foot sits deeper in the haze
    // than the crest, which is what sells one ridge standing behind another.
    float toFog = clamp(aHaze + (1.0 - aHaze) * (1.0 - aTop) * 0.55, 0.0, 1.0);
    // ...and the fringe strip above the crest runs the rest of the way to pure
    // fog, which is the soft top edge (see FRINGE).
    toFog = mix(toFog, 1.0, aFringe);
    // At night the belt has to converge on the fog rather than merely dim: the
    // night fog is now genuinely dark, so a band that only scaled its own tint
    // down stayed BRIGHTER than the sky it stood against and drew a pale
    // horizontal seam right across the bay in every night vista.
    toFog = mix(toFog, 1.0, uNight * 0.55);
    vColor = mix(aTint * aRelief * (1.0 - 0.86 * uNight), uFog, toFog);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

// --- The Golden Gate at range ---------------------------------------------
//
// The bridge is the thing you orient by from across the map, and it was the one
// structure that vanished from it. Measured on the shipped build, noon, three
// bearings: at 300u it is the best frame in the game; at 700u it is four thin
// orange sticks with no deck, no cables and no form; at 1200u a grey smudge; at
// 2000u nothing at all. Three causes stack up, and only the first is obvious:
//
//  1. THE LOD KEEPS THE WRONG PARTS. Past DETAIL_DISTANCE an instance survives
//     only as a box imposter, and only if it stands 13u or taller. On this
//     bridge that is the four tower legs and NOTHING else — the cables, the
//     truss, the deck boards and the portal bracing are all under the bar and
//     are simply culled. What is left is exactly the four sticks.
//  2. SUB-PIXEL MEMBERS. A 3.6u leg is 3.7px at 1200u and 2px at 2000u, thin
//     enough for MSAA and the haze to finish off.
//  3. THE HAZE OWNS THE COLOUR. Fog far is ~950u by day, so from street level
//     everything past it is 100% fog — International Orange included.
//
// The fix is a stand-in that is drawn at EVERY distance and only ever grows:
// ~70 camera-facing ribbons (world/golden-gate.ts goldenGateSilhouette) laid
// exactly on the towers, the bracing, the truss chords and the catenary. Each
// ribbon is INSET inside the member it stands for, so within the detail band
// the real bridge covers it completely and it cannot be seen; past that band it
// holds a minimum WIDTH ON SCREEN, so the form stops thinning away; and its
// haze is the scene's own curve with a ceiling, so the orange survives the
// distance the rest of the world is meant to dissolve into. Nothing switches
// on and nothing switches off — there is no LOD boundary to pop at, only a
// width that ramps in over the band where the real members are being culled.
//
// It also has to WIN the pixels its own leg imposters still hold out there, or
// each thickened leg would carry a washed-out fog-coloured stripe down its
// middle. Hence the small push toward the camera, ramped on the same curve: at
// close range it is zero (the stand-in stays hidden behind the real bridge),
// at range it is a couple of units (the stand-in covers its own imposter).
const LM_HOLD = DETAIL_DISTANCE; // last range the real bridge is still whole
const LM_FULL = 760; // ...and where the stand-in has fully taken over
// ...but the real band is DETAIL_DISTANCE * detailScale (city.ts, from the perf
// governor's tier), so on a phone the members cull at ~220u while an unscaled
// ramp is still holding the stand-in thin. Both ends track the tier, so the
// hand-off stays put wherever the LOD actually is. Desktop is scale 1 and this
// is the identity.
const growRange = (scale: number): [number, number] => [LM_HOLD * scale, LM_FULL * scale];
// Minimum half-width a TOWER LEG holds, in NDC-Y units — a fixed fraction of
// the screen HEIGHT rather than a pixel count, because a beacon has to hold its
// angular size at any resolution. 0.0075 is ~2.7px of a 720p frame, so a leg
// bottoms out at ~5px wide and the two of them still read as a portal rather
// than fusing into a slab. Every other member holds a share of it (minScale).
const LM_MIN_HALF_NDC = 0.0075;
// ...but the screen floor is not allowed to run away in WORLD units. Held past
// ~1300u it takes a 3.6u tower leg to 8u and the two legs of a tower start to
// close the 15u portal between them: the crossing bloats into one orange lump
// with two bumps on it. Capped, the members thin out again at extreme range,
// which is what they should do — at 2000u a leg is still 2px.
const LM_MAX_HALF = 6.5;
// Ceiling on how far the landmark ages into the haze. It buys a real
// exemption and the number is small on purpose: the sky here is a bright
// blue-white, and sRGB is steep near black, so a mix that sounds harmless
// wrecks the HUE — International Orange's blue channel is a sixth of the fog's,
// so the weakest channel takes almost all of the lift and the bridge goes
// CORAL while it is still nominally "90% itself". Measured at 1200u on the
// shipped grade: 0.10 read (191,109,106) — green and blue level, i.e. pink,
// against the real paint's (141,75,60) at 300u. 0.045 lands (166,86,70): still
// visibly lighter and softer than the near bridge, so the distance reads, but
// with the orange ratio intact. The distance is carried by size, by the
// members simplifying, and by everything AROUND the bridge being hazier — not
// by bleaching the one colour the landmark is famous for choosing so it would
// survive fog.
const LM_MAX_HAZE = 0.045;
// Inside the 2000u far plane: past this the silhouette is rescaled along the
// view ray onto a shell, which leaves the projection pixel-identical (see the
// band shader above) and stops the far corner of the map clipping it away.
const LM_SHELL = 1700;
const LM_PUSH = 2.6; // depth bias, in world units, over its own imposters
const LM_TINT = 0xd6512e; // International Orange
// The stand-in is unlit, so this stands in for the sun on the real bridge's
// paint — and it is a calibration, not a free brightness knob. At 2.2 the red
// channel clips before the grade sees it, which costs the colour its ratio and
// the bridge goes pale pink (measured (228,136,130) at 1200u). RE-CALIBRATED
// against the shipped grade: the sun-blowout pass (render/post.ts, day bloom
// cut 3.0 -> 6.5, and the bounded sun disc) landed in the same session this was
// tuned in, and 0.9 measures (191,109,106) against it — a stand-in half a stop
// brighter than the bridge it stands in for, which is what made it read as a
// diagram drawn over the strait rather than as the bridge. 0.72 measures
// (166,86,70) at 1200u against the real paint's (141,75,60) at 300u.
const LM_GAIN = 0.72;

const LM_VERT = /* glsl */ `
  attribute vec3 aOther;
  // x = side, y = half-thickness here, z = +1 at a / -1 at b, w = min-width share
  attribute vec4 aEdge;
  uniform vec2 uGrow;
  uniform float uMinHalf;
  uniform float uShell;
  uniform vec2 uFogRange;
  uniform vec3 uFog;
  uniform vec3 uTint;
  uniform float uNight;
  varying vec3 vColor;
  void main() {
    vec3 toCam = cameraPosition - position;
    float dist = max( length( toCam ), 1.0 );
    vec3 view = toCam / dist;
    // The bar runs a -> b whichever end this vertex sits at, so both ends
    // offset to the SAME side of it (they bow-tie otherwise).
    vec3 dir = normalize( aOther - position ) * aEdge.z;
    vec3 side = cross( dir, view );
    float sl = length( side );
    side = sl > 1e-3 ? side / sl : vec3( 0.0, 1.0, 0.0 );
    // Screen-space floor on the thickness. projectionMatrix[1][1] is
    // 1/tan(fovY/2), so this is an angular size and survives any FOV.
    float grow = smoothstep( uGrow.x, uGrow.y, dist );
    float minHalf = min(
      uMinHalf * aEdge.w * dist / projectionMatrix[1][1],
      ${LM_MAX_HALF.toFixed(2)} * aEdge.w );
    // ('half' is a reserved word in GLSL — hw it is.)
    float hw = max( aEdge.y, minHalf * grow );
    // ...and the ends run on by their own width, so a thickened chain of them
    // has no daylight at the joints.
    vec3 world = position + side * ( aEdge.x * hw ) - dir * ( aEdge.z * hw );
    world += view * ( grow * max( ${LM_PUSH.toFixed(2)}, hw ) );
    vec3 rel = world - cameraPosition;
    float d3 = max( length( rel ), 1.0 );
    gl_Position = projectionMatrix * viewMatrix
      * vec4( cameraPosition + rel * min( 1.0, uShell / d3 ), 1.0 );
    // The scene's own aerial perspective, with a ceiling on it.
    float f = smoothstep( uFogRange.x, uFogRange.y, dist );
    float fragHaze = exp( - max( 0.0, world.y - ${HAZE_BASE.toFixed(2)} ) / ${HAZE_SCALE.toFixed(2)} );
    float camHaze = exp( - max( 0.0, cameraPosition.y - ${HAZE_BASE.toFixed(2)} ) / ${HAZE_SCALE.toFixed(2)} );
    f *= mix( 1.0, sqrt( fragHaze * camHaze ), ${HAZE_AMOUNT.toFixed(2)} );
    vColor = mix( uTint * ( 1.0 - 0.82 * uNight ), uFog, min( f, ${LM_MAX_HAZE.toFixed(2)} ) );
  }
`;

/**
 * The long-range stand-in for one landmark: a set of camera-facing ribbons that
 * hold a minimum screen width. Drawn as ordinary opaque geometry so the world
 * in front of it occludes it correctly, but with no depth WRITE — a stand-in
 * should never own the depth buffer.
 */
class LandmarkSilhouette {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly uFog = { value: new THREE.Color(0xbfdcf2) };
  private readonly uTint = { value: new THREE.Color(LM_TINT).multiplyScalar(LM_GAIN) };
  private readonly uNight = { value: 0 };
  private readonly uFogRange = { value: new THREE.Vector2(400, 950) };
  private readonly uGrow = { value: new THREE.Vector2(...growRange(1)) };

  constructor(bars: readonly SilhouetteBar[]) {
    const positions = new Float32Array(bars.length * 4 * 3);
    const others = new Float32Array(bars.length * 4 * 3);
    const edges = new Float32Array(bars.length * 4 * 4);
    const indices = new Uint16Array(bars.length * 6);
    bars.forEach((bar, i) => {
      const v = i * 4;
      // 0,3 sit at a; 1,2 sit at b; 0,1 offset one way, 2,3 the other.
      const ends = [bar.a, bar.b, bar.b, bar.a];
      const opp = [bar.b, bar.a, bar.a, bar.b];
      const half = [bar.halfA, bar.halfB, bar.halfB, bar.halfA];
      const side = [-1, -1, 1, 1];
      const end = [1, -1, -1, 1];
      for (let k = 0; k < 4; k++) {
        const p = ends[k];
        const o = opp[k];
        if (!p || !o) continue;
        positions.set([p.x, p.y, p.z], (v + k) * 3);
        others.set([o.x, o.y, o.z], (v + k) * 3);
        edges.set([side[k] ?? 0, half[k] ?? 0, end[k] ?? 0, bar.minScale], (v + k) * 4);
      }
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aOther", new THREE.BufferAttribute(others, 3));
    geo.setAttribute("aEdge", new THREE.BufferAttribute(edges, 4));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uGrow: this.uGrow,
        uMinHalf: { value: LM_MIN_HALF_NDC },
        uShell: { value: LM_SHELL },
        uFogRange: this.uFogRange,
        uFog: this.uFog,
        uTint: this.uTint,
        uNight: this.uNight,
      },
      vertexShader: LM_VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide, // the ribbon is built around the bar, not wound
      depthWrite: false,
      fog: false,
    });

    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "landmark-silhouette";
    this.mesh.frustumCulled = false; // the shader moves every vertex
    this.mesh.matrixAutoUpdate = false; // bar positions are already world-space
  }

  update(fogColor: THREE.Color, night: number, fog: THREE.Fog | null): void {
    this.uFog.value.copy(fogColor);
    this.uNight.value = night;
    if (fog) this.uFogRange.value.set(fog.near, fog.far);
    this.uGrow.value.set(...growRange(liveQuality().detailScale));
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export class FarTerrain {
  readonly mesh: THREE.Mesh;
  private uFog = { value: new THREE.Color(0xbfdcf2) };
  private uNight = { value: 0 };
  private landmark: LandmarkSilhouette | null = null;
  private landmarkPlan: GoldenGatePlan | null = null;

  constructor() {
    // Two quads per segment now: the ridge body, then the fringe strip above it.
    const quads = BANDS.length * SEGMENTS * 2;
    const positions = new Float32Array(quads * 4 * 3);
    const tops = new Float32Array(quads * 4);
    const hazes = new Float32Array(quads * 4);
    const tints = new Float32Array(quads * 4 * 3);
    const fringes = new Float32Array(quads * 4);
    const reliefs = new Float32Array(quads * 4);
    const indices = new Uint16Array(quads * 6);
    const tint = new THREE.Color();
    let v = 0; // vertex cursor
    let f = 0; // index cursor

    // Value multiplier for a vertex: the local ridge SLOPE lights one flank and
    // shades the other (a symmetric fill would keep the band flat no matter how
    // varied its outline), plus a slow bearing wave for broad shoulders, both
    // faded out toward the foot where the haze owns the colour anyway.
    const reliefAt = (ridges: readonly Ridge[], bearing: number, top: number): number => {
      const d = 1.5;
      const slope = (profileAt(ridges, bearing + d) - profileAt(ridges, bearing - d)) / (2 * d);
      const lit = Math.max(-1, Math.min(1, slope / 12));
      const wave = Math.sin(bearing * 0.19 + 1.7) * 0.5 + Math.sin(bearing * 0.061) * 0.5;
      return 1 + RELIEF * (lit * 0.7 + wave * 0.3) * (0.3 + 0.7 * top);
    };

    for (const band of BANDS) {
      tint.setHex(band.color);
      for (let s = 0; s < SEGMENTS; s++) {
        const b0 = (s / SEGMENTS) * 360;
        const b1 = ((s + 1) / SEGMENTS) * 360;
        // Bearing 0 points -Z (north); +90 points +X (east).
        const a0 = THREE.MathUtils.degToRad(b0);
        const a1 = THREE.MathUtils.degToRad(b1);
        const x0 = Math.sin(a0) * band.radius;
        const z0 = -Math.cos(a0) * band.radius;
        const x1 = Math.sin(a1) * band.radius;
        const z1 = -Math.cos(a1) * band.radius;
        const h0 = profileAt(band.ridges, b0);
        const h1 = profileAt(band.ridges, b1);
        const r0 = reliefAt(band.ridges, b0, 1);
        const r1 = reliefAt(band.ridges, b1, 1);
        const fringe0 = Math.max(FRINGE_MIN, (h0 - SEA_FLOOR) * FRINGE);
        const fringe1 = Math.max(FRINGE_MIN, (h1 - SEA_FLOOR) * FRINGE);

        const quad = (
          ys: readonly [number, number, number, number],
          top: readonly [number, number, number, number],
          fr: readonly [number, number, number, number],
          rel: readonly [number, number, number, number],
        ): void => {
          const base = v;
          // 0,1 = lower edge (b0, b1); 2,3 = upper edge (b1, b0).
          positions.set([x0, ys[0], z0, x1, ys[1], z1, x1, ys[2], z1, x0, ys[3], z0], v * 3);
          tops.set(top, v);
          fringes.set(fr, v);
          reliefs.set(rel, v);
          hazes.set([band.haze, band.haze, band.haze, band.haze], v);
          for (let k = 0; k < 4; k++) tints.set([tint.r, tint.g, tint.b], (v + k) * 3);
          v += 4;
          indices.set([base, base + 1, base + 2, base, base + 2, base + 3], f);
          f += 6;
        };

        // Body: feet on the ground shell up to the crest.
        quad(
          [BASE_Y, BASE_Y, h1, h0],
          [0, 0, 1, 1],
          [0, 0, 0, 0],
          [reliefAt(band.ridges, b0, 0), reliefAt(band.ridges, b1, 0), r1, r0],
        );
        // Fringe: crest up into the sky, dissolving to pure fog.
        quad([h0, h1, h1 + fringe1, h0 + fringe0], [1, 1, 1, 1], [0, 0, 1, 1], [r0, r1, r1, r0]);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aTop", new THREE.BufferAttribute(tops, 1));
    geo.setAttribute("aHaze", new THREE.BufferAttribute(hazes, 1));
    geo.setAttribute("aTint", new THREE.BufferAttribute(tints, 3));
    geo.setAttribute("aFringe", new THREE.BufferAttribute(fringes, 1));
    geo.setAttribute("aRelief", new THREE.BufferAttribute(reliefs, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uShell: { value: SHELL }, uFog: this.uFog, uNight: this.uNight },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide, // the ring is viewed from inside AND from outside
      depthTest: false,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "far-terrain";
    this.mesh.frustumCulled = false; // the shader moves every vertex
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -1; // after the sky dome (-2), before everything real
  }

  /** Track the day-night grade: horizon tint from the fog, darkness from lamp. */
  update(fogColor: THREE.Color, night: number): void {
    this.uFog.value.copy(fogColor);
    this.uNight.value = night;
    this.syncLandmark(fogColor, night);
  }

  // The Golden Gate's stand-in rides along here for one reason: this is the
  // only render-side object the scene already owns and ticks, and the bridge's
  // MESHES are baked (buildGoldenGate runs on cold generation only), so nothing
  // on the normal load path builds bridge geometry at all. Both load paths do
  // solve the placement — city.ts lightGoldenGate() — so the silhouette picks
  // the solved plan up on the frame after the world lands, and rebuilds if the
  // world is ever regenerated under it.
  private syncLandmark(fogColor: THREE.Color, night: number): void {
    const plan = goldenGateSolvedPlan();
    if (plan !== this.landmarkPlan) {
      this.landmarkPlan = plan;
      if (this.landmark) {
        this.mesh.remove(this.landmark.mesh);
        this.landmark.dispose();
        this.landmark = null;
      }
      if (plan) {
        this.landmark = new LandmarkSilhouette(goldenGateSilhouette(plan));
        this.mesh.add(this.landmark.mesh);
      }
    }
    if (!this.landmark) return;
    // The day-night grade owns fogNear/fogFar and never hands them here, so
    // read them off the scene the mesh is hanging in — the stand-in has to age
    // on the same curve as the geometry it stands in for.
    const scene = this.mesh.parent;
    const fog = scene instanceof THREE.Scene && scene.fog instanceof THREE.Fog ? scene.fog : null;
    this.landmark.update(fogColor, night, fog);
  }
}
