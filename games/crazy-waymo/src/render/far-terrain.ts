import * as THREE from "three";

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
const BANDS: readonly Band[] = [
  {
    radius: 3600,
    haze: 0.74,
    color: 0x93a7bf,
    ridges: [
      { bearing: 76, width: 9, height: 300 }, // Mount Diablo
      { bearing: 96, width: 34, height: 200 }, // Berkeley / Oakland hills
      { bearing: 132, width: 26, height: 170 }, // inner coast range, south-east
    ],
  },
  {
    radius: 2600,
    haze: 0.54,
    color: 0x7f95af,
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
    haze: 0.32,
    color: 0x6f849e,
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
    float toFog = clamp(aHaze + (1.0 - aHaze) * (1.0 - aTop) * 0.7, 0.0, 1.0);
    vColor = mix(aTint * (1.0 - 0.72 * uNight), uFog, toFog);
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
    const quads = BANDS.length * SEGMENTS;
    const positions = new Float32Array(quads * 4 * 3);
    const tops = new Float32Array(quads * 4);
    const hazes = new Float32Array(quads * 4);
    const tints = new Float32Array(quads * 4 * 3);
    const indices = new Uint16Array(quads * 6);
    const tint = new THREE.Color();
    let v = 0; // vertex cursor
    let f = 0; // index cursor

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
        const base = v;
        // 0,1 = feet; 2,3 = crest.
        positions.set([x0, BASE_Y, z0, x1, BASE_Y, z1, x1, h1, z1, x0, h0, z0], v * 3);
        tops.set([0, 0, 1, 1], v);
        hazes.set([band.haze, band.haze, band.haze, band.haze], v);
        for (let k = 0; k < 4; k++) tints.set([tint.r, tint.g, tint.b], (v + k) * 3);
        v += 4;
        indices.set([base, base + 1, base + 2, base, base + 2, base + 3], f);
        f += 6;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aTop", new THREE.BufferAttribute(tops, 1));
    geo.setAttribute("aHaze", new THREE.BufferAttribute(hazes, 1));
    geo.setAttribute("aTint", new THREE.BufferAttribute(tints, 3));
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
