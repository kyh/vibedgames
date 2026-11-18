import * as THREE from "three";

const SHELL = 1300;
const BASE_SEGMENTS = 96;
const MAX_SPLITS = 5;
const CREST_TOL = 2.5e-4;
const BASE_Y = -90;
const SEA_FLOOR = -8;
const FRINGE = 0.16;
const FRINGE_MIN = 6;
const RELIEF = 0.2;
const LADDER_NEAR = 260;
const LADDER_FAR = 3600;
const LADDER_LO = 0.42;
const LADDER_HI = 0.8;
const AERIAL_NEAR = 900;
const AERIAL_FAR = 3600;
const AERIAL_DESAT = 0.26;
const AERIAL_TINT = 0.34;
const COOL_AWAY = 0xa9_b0_c8;
const WARM_LO = 0.15;
const WARM_HI = 0.92;
const SUN_FADE_LO = 0.62;
const SUN_FADE_HI = 1;
const SUN_INT_LO = 0.5;
const SUN_INT_HI = 1.2;

interface Ridge {
  readonly bearing: number;
  readonly width: number;
  readonly height: number;
}

interface Band {
  readonly radius: number;
  readonly haze: number;
  readonly color: number;
  readonly ridges: readonly Ridge[];
}

const BANDS: readonly Band[] = [
  {
    color: 0x7f_a0_d8,
    haze: 0.5,
    radius: 3600,
    ridges: [
      { bearing: 76, height: 300, width: 9 },
      { bearing: 96, height: 200, width: 34 },
      { bearing: 86, height: 232, width: 6 },
      { bearing: 108, height: 218, width: 7 },
      { bearing: 132, height: 170, width: 26 },
      { bearing: 122, height: 196, width: 5 },
      { bearing: 145, height: 188, width: 8 },
    ],
  },
  {
    color: 0x6c_9a_a4,
    haze: 0.42,
    radius: 2600,
    ridges: [
      { bearing: 344, height: 260, width: 11 },
      { bearing: 339, height: 276, width: 3.3 },
      { bearing: 350, height: 239, width: 3.5 },
      { bearing: 357, height: 165, width: 20 },
      { bearing: 24, height: 105, width: 14 },
      { bearing: 18, height: 112, width: 3.5 },
      { bearing: 32, height: 108, width: 4 },
      { bearing: 47, height: 120, width: 17 },
      { bearing: 177, height: 155, width: 15 },
      { bearing: 201, height: 175, width: 21 },
    ],
  },
  {
    color: 0x5a_96_6c,
    haze: 0.24,
    radius: 1850,
    ridges: [
      { bearing: 322, height: 110, width: 13 },
      { bearing: 315, height: 119, width: 3.5 },
      { bearing: 328, height: 112, width: 3.8 },
      { bearing: 12, height: 78, width: 7 },
      { bearing: 9, height: 83, width: 2.3 },
      { bearing: 101, height: 52, width: 19 },
    ],
  },
];

const profileAt = (ridges: readonly Ridge[], bearing: number) => {
  let h = SEA_FLOOR;

  for (const r of ridges) {
    let d = bearing - r.bearing;
    d -= Math.round(d / 360) * 360;
    const g = r.height * Math.exp(-(d * d) / (2 * r.width * r.width));

    if (g > h) {
      h = g;
    }
  }

  return h;
};

const refineSpan = (
  ridges: readonly Ridge[],
  b0: number,
  b1: number,
  h0: number,
  h1: number,
  tol: number,
  splits: number,
  out: number[],
) => {
  const bm = (b0 + b1) * 0.5;
  const hm = profileAt(ridges, bm);

  if (splits > 0 && Math.abs(hm - (h0 + h1) * 0.5) > tol) {
    refineSpan(ridges, b0, bm, h0, hm, tol, splits - 1, out);
    refineSpan(ridges, bm, b1, hm, h1, tol, splits - 1, out);
  } else {
    out.push(b0);
  }
};

const bearings = (band: Band) => {
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

const glf = (n: number) => n.toFixed(2);

const VERT = `
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

const FRAG = `
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

const reliefAt = (ridges: readonly Ridge[], bearing: number, top: number) => {
  const d = 1.5;
  const slope = (profileAt(ridges, bearing + d) - profileAt(ridges, bearing - d)) / (2 * d);
  const lit = Math.max(-1, Math.min(1, slope / 12));
  const wave = Math.sin(bearing * 0.19 + 1.7) * 0.5 + Math.sin(bearing * 0.061) * 0.5;

  return 1 + RELIEF * (lit * 0.7 + wave * 0.3) * (0.3 + 0.7 * top);
};

export class FarTerrain {
  readonly mesh: THREE.Mesh;
  private uFog = { value: new THREE.Color(0xbf_dc_f2) };
  private uNight = { value: 0 };
  private uSunAzim = { value: new THREE.Vector2(0, -1) };
  private uSunWarm = { value: new THREE.Color(0xff_d9_a8) };
  private uCool = { value: new THREE.Color(COOL_AWAY) };
  private uDay = { value: 0 };
  private sunRef: THREE.DirectionalLight | null = null;
  private scrSun = new THREE.Vector3();

  constructor() {
    const rings = BANDS.map(bearings);
    const quads = rings.reduce((n, ring) => n + (ring.length - 1) * 2, 0);
    const positions = new Float32Array(quads * 4 * 3);
    const tops = new Float32Array(quads * 4);
    const hazes = new Float32Array(quads * 4);
    const tints = new Float32Array(quads * 4 * 3);
    const fringes = new Float32Array(quads * 4);
    const reliefs = new Float32Array(quads * 4);
    const indices = quads * 4 > 65_536 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
    const tint = new THREE.Color();
    let v = 0;
    let f = 0;

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
    ) => {
      const base = v;
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
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -1;

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
  update(fogColor: THREE.Color, night: number) {
    this.uFog.value.copy(fogColor);
    this.uNight.value = night;
  }
}
