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

// radius the compressed silhouette is drawn at
const SHELL = 1300;
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
// curtain foot, well under the horizon line
const BASE_Y = -90;
// profile floor where there is only open ocean
const SEA_FLOOR = -8;
// Soft crest. The band cannot use alpha — it is opaque on purpose so it draws
// in the opaque bucket ahead of the city (a transparent one would sort AFTER
// every building and paint over the world). So the softness is GEOMETRY: one
// extra strip above each crest whose colour runs from the ridge to pure fog.
// Without it a 1.5–3.6 km ridgeline ends on a razor line against the sky and
// the whole belt reads as a cardboard cut-out.
// strip height as a fraction of the crest's height above sea
const FRINGE = 0.16;
// ...but never thinner than this in world units
const FRINGE_MIN = 6;
// Relief. One flat fill per band is the other half of the cardboard read, so
// each vertex gets a value multiplier from a low-frequency bearing wave (broad
// flanks catching or losing the light) plus a lift toward the crest.
const RELIEF = 0.2;
// Painter's value ladder (kart-royale backdrop treatment): the fog drains hue
// faster than value (render/aerial-fog.ts), so VALUE is the only channel a
// silhouette stack survives on at range — nearest ridge darkest, lightening
// toward the sky. Applied per PIXEL before the fog mix (the camera roams
// ±~1.5km of the band centre, so distance varies a lot within one band) and
// day-weighted so the tuned night fog convergence is untouched.
const LADDER_NEAR = 260;
const LADDER_FAR = 3600;
const LADDER_LO = 0.42;
const LADDER_HI = 0.8;
// Azimuthal aerial tint, desaturate-first: warm toward the live sun color in
// the near-sun sector, violet-grey away — that contrast IS golden hour. Both
// ops ramp with distance so the near band keeps most of its own color.
const AERIAL_NEAR = 900;
const AERIAL_FAR = 3600;
const AERIAL_DESAT = 0.42;
const AERIAL_TINT = 0.34;
const COOL_AWAY = 0xa9_b0_c8;
// smoothstep bounds on cos(view azimuth, sun azimuth): warm ONLY into the sun.
const WARM_LO = 0.15;
const WARM_HI = 0.92;
// Sun-keyed terms hold through sunset (lamp opens at 0.62 there), die across
// dusk; the intensity ramp keeps the night moon (0.28-0.32) from ever tinting.
const SUN_FADE_LO = 0.62;
const SUN_FADE_HI = 1;
const SUN_INT_LO = 0.5;
const SUN_INT_HI = 1.2;

/** A summit in bearing space: 0 = north (-Z), 90 = east (+X). */
interface Ridge {
  readonly bearing: number;
  // degrees, Gaussian sigma
  readonly width: number;
  // world units above sea level
  readonly height: number;
}

interface Band {
  readonly radius: number;
  /** 0 = crisp, 1 = fully dissolved into the horizon haze. */
  readonly haze: number;
  readonly color: number;
  readonly ridges: readonly Ridge[];
}

// Ordered far → near; the emitter relies on it for painter order.
//
// Haze came DOWN across all three bands in the 2026-07-26 grading pass. At 0.74
// the far band was 74–92% fog colour, so at golden hour — when the fog is sand —
// the entire horizon arc resolved to one flat sand fill at the same hue as the
// mid-distance building tan, and the city and its backdrop merged. The bands
// keep enough of their own blue now to sit BEHIND the city rather than in it.
const BANDS: readonly Band[] = [
  {
    color: 0x8f_a5_c2,
    haze: 0.5,
    radius: 3600,
    // Broad Gaussians alone give a band ONE smooth dome per ridge, which from
    // the city reads as a sand-coloured hill-shaped cut-out. Narrow secondary
    // summits riding on the broad ones break the outline into a range.
    ridges: [
      // Mount Diablo
      { bearing: 76, height: 300, width: 9 },
      // Berkeley / Oakland hills
      { bearing: 96, height: 200, width: 34 },
      // ...and its northern shoulder
      { bearing: 86, height: 232, width: 6 },
      // ...and its southern one
      { bearing: 108, height: 218, width: 7 },
      // inner coast range, south-east
      { bearing: 132, height: 170, width: 26 },
      { bearing: 122, height: 196, width: 5 },
      { bearing: 145, height: 188, width: 8 },
    ],
  },
  {
    color: 0x7e_8e_9a,
    haze: 0.42,
    radius: 2600,
    ridges: [
      // Mount Tamalpais
      { bearing: 344, height: 260, width: 11 },
      // broken summit and eastern saddle
      { bearing: 339, height: 276, width: 3.3 },
      { bearing: 350, height: 239, width: 3.5 },
      // Marin ridge
      { bearing: 357, height: 165, width: 20 },
      // Tiburon
      { bearing: 24, height: 105, width: 14 },
      { bearing: 18, height: 112, width: 3.5 },
      { bearing: 32, height: 108, width: 4 },
      // Richmond hills
      { bearing: 47, height: 120, width: 17 },
      // San Bruno Mountain
      { bearing: 177, height: 155, width: 15 },
      // peninsula ridge
      { bearing: 201, height: 175, width: 21 },
    ],
  },
  {
    color: 0x66_7e_76,
    haze: 0.24,
    radius: 1850,
    ridges: [
      // Marin headlands, west of the Gate
      { bearing: 322, height: 110, width: 13 },
      { bearing: 315, height: 119, width: 3.5 },
      { bearing: 328, height: 112, width: 3.8 },
      // Angel Island
      { bearing: 12, height: 78, width: 7 },
      { bearing: 9, height: 83, width: 2.3 },
      // Oakland shoreline
      { bearing: 101, height: 52, width: 19 },
    ],
  },
];

/** Skyline height at a bearing: the tallest ridge wins, no stacking. */
const profileAt = (ridges: readonly Ridge[], bearing: number): number => {
  let h = SEA_FLOOR;
  for (const r of ridges) {
    // Wrap the bearing delta into ±180 so a ridge at 357° reaches past north.
    let d = bearing - r.bearing;
    d -= Math.round(d / 360) * 360;
    const g = r.height * Math.exp(-(d * d) / (2 * r.width * r.width));
    if (g > h) {
      h = g;
    }
  }
  return h;
};

/**
 * Emit `b0`, splitting the span first while the chord from `b0` to `b1` misses
 * the profile at its midpoint by more than `tol`. Standard adaptive-subdivision
 * recursion — the flat ocean arcs, where the chord IS the profile, terminate on
 * the first test and cost nothing; a Gaussian summit or the corner where two
 * ridges cross keeps halving until it is flat within half a pixel.
 */
const refineSpan = (
  ridges: readonly Ridge[],
  b0: number,
  b1: number,
  h0: number,
  h1: number,
  tol: number,
  splits: number,
  out: number[],
): void => {
  const bm = (b0 + b1) * 0.5;
  const hm = profileAt(ridges, bm);
  if (splits > 0 && Math.abs(hm - (h0 + h1) * 0.5) > tol) {
    refineSpan(ridges, b0, bm, h0, hm, tol, splits - 1, out);
    refineSpan(ridges, bm, b1, hm, h1, tol, splits - 1, out);
  } else {
    out.push(b0);
  }
};

/** The bearings of one band's ring, closed (first entry 0, last 360). */
const bearings = (band: Band): readonly number[] => {
  const tol = band.radius * CREST_TOL;
  const step = 360 / BASE_SEGMENTS;
  const out: number[] = [];
  for (let s = 0; s < BASE_SEGMENTS; s += 1) {
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
};

const glf = (n: number): string => n.toFixed(2);

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const VERT = /* glsl */ `
  attribute float aTop;
  attribute float aHaze;
  attribute vec3 aTint;
  attribute float aFringe;
  attribute float aRelief;
  uniform float uShell;
  uniform float uNight;
  varying vec3 vTint;
  varying float vToFog;
  varying vec2 vDir;
  varying float vDist;
  void main() {
    vec3 rel = position - cameraPosition;
    float d = max(length(rel.xz), 1.0);
    vec3 p = cameraPosition + rel * (uShell / d);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    vDist = d;
    vDir = rel.xz / d;
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
    vToFog = toFog;
    vTint = aTint * aRelief * (1.0 - 0.86 * uNight);
  }
`;

// oxlint-disable-next-line no-inline-comments -- the /* glsl */ tag must sit on the template line for editor shader highlighting
const FRAG = /* glsl */ `
  uniform vec3 uFog;
  uniform vec2 uSunAzim;
  uniform vec3 uSunWarm;
  uniform vec3 uCool;
  uniform float uDay;
  varying vec3 vTint;
  varying float vToFog;
  varying vec2 vDir;
  varying float vDist;
  void main() {
    vec3 col = vTint;
    // Value ladder, then desaturate, then azimuth tint, then the fog mix —
    // the kart-royale registration order (ladder -> aerial -> fog).
    float ladder = mix(${glf(LADDER_LO)}, ${glf(LADDER_HI)},
      smoothstep(${glf(LADDER_NEAR)}, ${glf(LADDER_FAR)}, vDist));
    col *= mix(1.0, ladder, uDay);
    float aer = smoothstep(${glf(AERIAL_NEAR)}, ${glf(AERIAL_FAR)}, vDist) * uDay;
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(lum), ${glf(AERIAL_DESAT)} * aer);
    float az = dot(vDir, uSunAzim);
    col = mix(col, mix(uCool, uSunWarm, smoothstep(${glf(WARM_LO)}, ${glf(WARM_HI)}, az)),
      ${glf(AERIAL_TINT)} * aer);
    gl_FragColor = vec4(mix(col, uFog, vToFog), 1.0);
  }
`;

export class FarTerrain {
  readonly mesh: THREE.Mesh;
  private uFog = { value: new THREE.Color(0xbf_dc_f2) };
  private uNight = { value: 0 };
  private uSunAzim = { value: new THREE.Vector2(0, -1) };
  private uSunWarm = { value: new THREE.Color(0xff_d9_a8) };
  private uCool = { value: new THREE.Color(COOL_AWAY) };
  private uDay = { value: 0 };
  // The scene's shadow light, found once from the mesh's own render callback.
  // update()'s call site only carries fog + night, and widening the god
  // object's wiring for one vec3 isn't worth the drift — if a shared sun
  // signal ever lands (render/grade.ts pattern), feed it there instead.
  private sunRef: THREE.DirectionalLight | null = null;
  private scrSun = new THREE.Vector3();

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
    const indices = quads * 4 > 65_536 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    const tint = new THREE.Color();
    // vertex cursor
    let v = 0;
    // index cursor
    let f = 0;

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

    const quad = (
      band: Band,
      x0: number,
      z0: number,
      x1: number,
      z1: number,
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
      for (let k = 0; k < 4; k += 1) {
        tints.set([tint.r, tint.g, tint.b], (v + k) * 3);
      }
      v += 4;
      indices.set([base, base + 1, base + 2, base, base + 2, base + 3], f);
      f += 6;
    };

    for (const [bandIndex, band] of BANDS.entries()) {
      const ring = rings[bandIndex] ?? [];
      tint.setHex(band.color);
      for (let s = 0; s + 1 < ring.length; s += 1) {
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

        // Body: feet on the ground shell up to the crest.
        quad(
          band,
          x0,
          z0,
          x1,
          z1,
          [BASE_Y, BASE_Y, h1, h0],
          [0, 0, 1, 1],
          [0, 0, 0, 0],
          [reliefAt(band.ridges, b0, 0), reliefAt(band.ridges, b1, 0), r1, r0],
        );
        // Fringe: crest up into the sky, dissolving to pure fog.
        quad(
          band,
          x0,
          z0,
          x1,
          z1,
          [h0, h1, h1 + fringe1, h0 + fringe0],
          [1, 1, 1, 1],
          [0, 0, 1, 1],
          [r0, r1, r1, r0],
        );
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
      depthTest: false,
      depthWrite: false,
      fog: false,
      fragmentShader: FRAG,
      // the ring is viewed from inside AND from outside
      side: THREE.DoubleSide,
      uniforms: {
        uCool: this.uCool,
        uDay: this.uDay,
        uFog: this.uFog,
        uNight: this.uNight,
        uShell: { value: SHELL },
        uSunAzim: this.uSunAzim,
        uSunWarm: this.uSunWarm,
      },
      vertexShader: VERT,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "far-terrain";
    // the shader moves every vertex
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // after the sky dome (-2), before everything real
    this.mesh.renderOrder = -1;

    // Live sun for the azimuth tint, read same-frame on the mesh's own draw;
    // direction from the light's position/target pair (game-scene.updateSun).
    this.mesh.onBeforeRender = (_renderer, scene) => {
      let sun = this.sunRef;
      if (sun === null || sun.parent !== scene) {
        sun = null;
        for (const child of scene.children) {
          if (child instanceof THREE.DirectionalLight) {
            sun = child;
            break;
          }
        }
        this.sunRef = sun;
      }
      if (sun === null) {
        this.uDay.value = 0;
        return;
      }
      const dir = this.scrSun.copy(sun.position).sub(sun.target.position);
      if (dir.lengthSq() < 1e-6) {
        this.uDay.value = 0;
        return;
      }
      dir.normalize();
      const azLen = Math.hypot(dir.x, dir.z);
      if (azLen > 1e-4) {
        this.uSunAzim.value.set(dir.x / azLen, dir.z / azLen);
      }
      this.uSunWarm.value.copy(sun.color);
      this.uDay.value =
        (1 - THREE.MathUtils.smoothstep(this.uNight.value, SUN_FADE_LO, SUN_FADE_HI)) *
        THREE.MathUtils.smoothstep(sun.intensity, SUN_INT_LO, SUN_INT_HI);
    };
  }

  /** Track the day-night grade: horizon tint from the fog, darkness from lamp. */
  update(fogColor: THREE.Color, night: number): void {
    this.uFog.value.copy(fogColor);
    this.uNight.value = night;
  }
}
