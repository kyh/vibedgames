import * as THREE from "three";

// The horizon beyond the map: Marin and Mount Tam over the Gate, the East Bay
// ridge and Diablo across the water, San Bruno Mountain and the peninsula to
// the south. Without it the world ends at the border wall and every long view
// bottoms out in flat haze.
//
// Three curtain bands of flat silhouette, one draw call, ~1.6k triangles. Each
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
// Ring resolution. The bands used to be a uniform 192 quads over the full
// circle — 1.875 degrees each, which at a 1280-wide frame is a 28-PIXEL step,
// and every sloping ridgeline in the game was visibly a staircase once the sun
// blowout stopped bleaching it away. Uniform resolution is also the wrong shape
// for the problem: most of the circle is open ocean sitting flat on SEA_FLOOR,
// where a chord is exact and every extra quad is wasted. So the ring starts
// coarse and SUBDIVIDES ONLY WHERE THE PROFILE BENDS — see `bearings()`.
// Measured worst chord error on the far band, in the frame: 3.38 px -> 0.30 px,
// and it costs NEGATIVE triangles (576 segments -> 403, 2304 tris -> 1612),
// because the ocean arcs hand back more than the summits take.
const BASE_SEGMENTS = 96;
// ...down to this many halvings, i.e. a floor of 360/(96*2^5) = 0.117 degrees.
const MAX_SPLITS = 5;
// A segment splits while its chord misses the true profile at the midpoint by
// more than this, as a fraction of the band's radius. The bands are drawn on a
// fixed shell, so a world-space error of `radius * TOL` at `radius` subtends
// atan(TOL) either way: 5e-4 is 0.029 degrees, well under half a pixel at the
// game's ~15 px/degree, which is the point at which a staircase stops being a
// staircase and starts being an edge.
const CREST_TOL = 2.5e-4;
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

/**
 * Emit `b0`, splitting the span first while the chord from `b0` to `b1` misses
 * the profile at its midpoint by more than `tol`. Standard adaptive-subdivision
 * recursion — the flat ocean arcs, where the chord IS the profile, terminate on
 * the first test and cost nothing; a Gaussian summit or the corner where two
 * ridges cross keeps halving until it is flat within half a pixel.
 */
function refineSpan(
  ridges: readonly Ridge[],
  b0: number,
  b1: number,
  h0: number,
  h1: number,
  tol: number,
  splits: number,
  out: number[],
): void {
  const bm = (b0 + b1) * 0.5;
  const hm = profileAt(ridges, bm);
  if (splits > 0 && Math.abs(hm - (h0 + h1) * 0.5) > tol) {
    refineSpan(ridges, b0, bm, h0, hm, tol, splits - 1, out);
    refineSpan(ridges, bm, b1, hm, h1, tol, splits - 1, out);
  } else {
    out.push(b0);
  }
}

/** The bearings of one band's ring, closed (first entry 0, last 360). */
function bearings(band: Band): readonly number[] {
  const tol = band.radius * CREST_TOL;
  const step = 360 / BASE_SEGMENTS;
  const out: number[] = [];
  for (let s = 0; s < BASE_SEGMENTS; s++) {
    const b0 = s * step;
    const b1 = b0 + step;
    refineSpan(
      band.ridges,
      b0,
      b1,
      profileAt(band.ridges, b0),
      profileAt(band.ridges, b1),
      tol,
      MAX_SPLITS,
      out,
    );
  }
  out.push(360);
  return out;
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

export class FarTerrain {
  readonly mesh: THREE.Mesh;
  private uFog = { value: new THREE.Color(0xbfdcf2) };
  private uNight = { value: 0 };

  constructor() {
    const rings = BANDS.map(bearings);
    // Two quads per segment: the ridge body, then the fringe strip above it.
    const quads = rings.reduce((n, ring) => n + (ring.length - 1) * 2, 0);
    const positions = new Float32Array(quads * 4 * 3);
    const tops = new Float32Array(quads * 4);
    const hazes = new Float32Array(quads * 4);
    const tints = new Float32Array(quads * 4 * 3);
    const fringes = new Float32Array(quads * 4);
    const reliefs = new Float32Array(quads * 4);
    // Adaptive rings can outgrow a 16-bit index (4 vertices a quad), and a
    // silent wrap here would fold the far side of the horizon over the near.
    const indices = quads * 4 > 65536 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
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

    BANDS.forEach((band, bandIndex) => {
      const ring = rings[bandIndex] ?? [];
      tint.setHex(band.color);
      for (let s = 0; s + 1 < ring.length; s++) {
        const b0 = ring[s] ?? 0;
        const b1 = ring[s + 1] ?? 0;
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
    });

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
  }
}
