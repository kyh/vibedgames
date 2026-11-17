// One circuit's scenery: a skyway hung in the dark above a city grid. The road
// is the only surface with a real shader — it draws the asphalt, the kerbs, the
// start line and, sampled by world position, everyone's paint.
//
// Built per track and thrown away on a track change; nothing here is shared
// between circuits except the paint texture it is handed.

import * as THREE from "three";

import { TRACK_STEP } from "../shared/constants";
import { pointAt, wrapIndex } from "../sim/track";
import type { Track } from "../sim/track";
import type { PaintLayer } from "./paint-layer";

const ROAD_VERTEX = `
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const ROAD_FRAGMENT = `
  uniform sampler2D uPaint;
  uniform float uSpan;
  uniform float uLap;
  uniform vec3 uRoad;
  uniform vec3 uAccent;
  uniform vec3 uAccent2;
  varying vec2 vUv;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    float across = abs(vUv.x);
    vec3 col = uRoad + hash(floor(vWorld.xz * 6.0)) * 0.012;

    // Centre dashes and lane ticks.
    float dash = step(across, 0.02) * step(0.5, fract(vUv.y / 7.0));
    col = mix(col, vec3(0.5), dash * 0.5);

    // Start line: two rows of checker across the road.
    float fromLine = min(vUv.y, uLap - vUv.y);
    float onLine = step(fromLine, 1.6);
    float checker = mod(floor(vUv.x * 7.0) + floor(vUv.y / 0.8), 2.0);
    col = mix(col, vec3(checker * 0.85 + 0.05), onLine * step(across, 0.9));

    // Paint: threshold the blurred coverage for round-edged strokes.
    vec4 paint = texture2D(uPaint, vWorld.xz / uSpan + 0.5);
    float cover = smoothstep(0.36, 0.6, paint.a) * step(across, 0.9);
    vec3 pigment = paint.a > 0.02 ? paint.rgb / paint.a : vec3(0.0);
    // A darker rim sells the stroke as wet paint with thickness.
    float rim = smoothstep(0.36, 0.5, paint.a) - smoothstep(0.5, 0.75, paint.a);
    col = mix(col, pigment * (0.62 - rim * 0.12), cover * 0.94);
    col += pigment * cover * 0.1;

    // Kerbs: alternating accent blocks along both edges.
    float kerb = smoothstep(0.9, 0.915, across);
    vec3 kerbCol = mix(uAccent, uAccent2, step(0.5, fract(vUv.y / 5.0)));
    col = mix(col, kerbCol * 1.15, kerb);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

const SKY_VERTEX = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = `
  uniform vec3 uSky;
  uniform vec3 uHorizon;
  uniform vec3 uGlow;
  varying vec3 vDir;
  void main() {
    float up = clamp(vDir.y, -1.0, 1.0);
    vec3 col = mix(uHorizon, uSky, smoothstep(-0.05, 0.55, up));
    // A band of city glow sitting on the horizon.
    col += uGlow * 0.22 * exp(-abs(up + 0.02) * 9.0);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

type Profile = (i: number) => number;

/**
 * A ribbon following the track: one edge at lateral `latA` and height `yA(i)`,
 * the other at `latB` / `yB(i)`. UV is (-1 | 1, distance along the lap).
 */
const ribbon = (
  track: Track,
  latA: number,
  yA: Profile,
  latB: number,
  yB: Profile,
): THREE.BufferGeometry => {
  const { n } = track;
  const positions = new Float32Array((n + 1) * 6);
  const uvs = new Float32Array((n + 1) * 4);
  const indices: number[] = [];
  for (let k = 0; k <= n; k += 1) {
    const i = wrapIndex(k, n);
    const a = pointAt(track, i, latA);
    const b = pointAt(track, i, latB);
    positions.set([a.x, yA(i), a.z, b.x, yB(i), b.z], k * 6);
    uvs.set([-1, k * TRACK_STEP, 1, k * TRACK_STEP], k * 4);
    if (k < n) {
      const v = k * 2;
      indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

/** A deterministic 0–1 stream, so a circuit's skyline is the same for everyone. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

const windowTexture = (lit: string, random: () => number): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#05050a";
    ctx.fillRect(0, 0, 64, 256);
    for (let row = 0; row < 40; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        if (random() < 0.32) {
          ctx.fillStyle = lit;
          ctx.globalAlpha = 0.35 + random() * 0.65;
          ctx.fillRect(col * 8 + 2, row * 6.4 + 1.5, 4, 3.2);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  return texture;
};

const SCRATCH = new THREE.Object3D();
const DEPTH = 70;
const deep: Profile = () => -DEPTH;

export class World {
  readonly group = new THREE.Group();
  private readonly disposables: { dispose: () => void }[] = [];
  private readonly padMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly padColor: THREE.Color;

  constructor(track: Track, paint: PaintLayer) {
    const { palette } = track.def;
    const accent = new THREE.Color(palette.accent);
    const accent2 = new THREE.Color(palette.accent2);
    this.padColor = accent2;
    const height: Profile = (i) => track.hs[i] ?? 0;

    this.addSky(palette.sky, palette.horizon, accent);
    this.addRoad(track, paint, height, accent, accent2);
    this.addRails(track, height, accent, palette.tower);
    this.addCity(track, palette.tower, palette.windows, accent);
    this.addGate(track, accent, accent2);
    this.addLamps(track, height, accent2);
    this.addPads(track);
  }

  /** `padReady[i]` is whether splat pad i is armed; resting pads go dim. */
  update(time: number, padReady: readonly boolean[]): void {
    for (const [i, material] of this.padMaterials.entries()) {
      const armed = padReady[i] ?? true;
      const pulse = armed ? 0.75 + Math.sin(time * 5 + i) * 0.25 : 0.12;
      material.color.copy(this.padColor).multiplyScalar(pulse * 1.6);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const item of this.disposables) {
      item.dispose();
    }
  }

  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    this.disposables.push(geometry, material);
    this.group.add(mesh);
    return mesh;
  }

  private addSky(sky: string, horizon: string, glow: THREE.Color): void {
    const material = new THREE.ShaderMaterial({
      depthWrite: false,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      uniforms: {
        uGlow: { value: glow },
        uHorizon: { value: new THREE.Color(horizon) },
        uSky: { value: new THREE.Color(sky) },
      },
      vertexShader: SKY_VERTEX,
    });
    const dome = this.mesh(new THREE.SphereGeometry(900, 24, 16), material);
    dome.renderOrder = -2;
    dome.frustumCulled = false;

    const random = seeded(7);
    const stars = new Float32Array(700 * 3);
    for (let i = 0; i < 700; i += 1) {
      const a = random() * Math.PI * 2;
      const up = 0.08 + random() * 0.9;
      const r = Math.sqrt(1 - up * up);
      stars.set([Math.cos(a) * r * 800, up * 800, Math.sin(a) * r * 800], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(stars, 3));
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: "#cfd8ff",
        depthWrite: false,
        fog: false,
        size: 1.6,
        sizeAttenuation: false,
        transparent: true,
      }),
    );
    points.renderOrder = -1;
    points.frustumCulled = false;
    this.disposables.push(geometry, points.material);
    this.group.add(points);
  }

  private addRoad(
    track: Track,
    paint: PaintLayer,
    height: Profile,
    accent: THREE.Color,
    accent2: THREE.Color,
  ): void {
    const { palette } = track.def;
    const road = new THREE.ShaderMaterial({
      fog: true,
      fragmentShader: ROAD_FRAGMENT,
      side: THREE.DoubleSide,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uAccent: { value: accent },
        uAccent2: { value: accent2 },
        uLap: { value: track.n * TRACK_STEP },
        uPaint: { value: paint.texture },
        uRoad: { value: new THREE.Color(palette.road) },
        uSpan: { value: paint.span },
      },
      vertexShader: ROAD_VERTEX,
    });
    // The kerb sits in the outer tenth of the ribbon, so the drivable width is the inner 90%.
    const edge = track.halfWidth / 0.9;
    this.mesh(ribbon(track, -edge, height, edge, height), road);
    const shoulder = new THREE.MeshBasicMaterial({
      color: palette.shoulder,
      side: THREE.DoubleSide,
    });
    const below: Profile = (i) => height(i) - 0.06;
    this.mesh(ribbon(track, -track.rail - 0.4, below, track.rail + 0.4, below), shoulder);
  }

  private addRails(track: Track, height: Profile, accent: THREE.Color, wallColor: string): void {
    const wall = new THREE.MeshBasicMaterial({ color: wallColor, side: THREE.DoubleSide });
    const glow = new THREE.MeshBasicMaterial({
      color: accent.clone().multiplyScalar(0.85),
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const top: Profile = (i) => height(i) + 0.8;
    const cap: Profile = (i) => height(i) + 1.02;
    for (const side of [-1, 1]) {
      const lat = side * (track.rail + 0.4);
      this.mesh(ribbon(track, lat, deep, lat, top), wall);
      this.mesh(ribbon(track, lat, top, lat, cap), glow);
    }
  }

  private addCity(track: Track, towerColor: string, windows: string, accent: THREE.Color): void {
    const random = seeded(track.n);
    const texture = windowTexture(windows, random);
    const material = new THREE.MeshBasicMaterial({ color: "#ffffff", map: texture });
    const geometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const towers = new THREE.InstancedMesh(geometry, material, 240);
    let placed = 0;
    for (let attempt = 0; attempt < 2400 && placed < 240; attempt += 1) {
      const x = (random() - 0.5) * 520;
      const z = (random() - 0.5) * 520;
      const size = 10 + random() * 16;
      let clear = true;
      for (let i = 0; i < track.n && clear; i += 4) {
        const d = Math.hypot(x - (track.xs[i] ?? 0), z - (track.zs[i] ?? 0));
        clear = d > track.rail + size + 4;
      }
      if (clear) {
        SCRATCH.position.set(x, -DEPTH, z);
        SCRATCH.scale.set(size, DEPTH - 8 + random() * 46, size);
        SCRATCH.updateMatrix();
        towers.setMatrixAt(placed, SCRATCH.matrix);
        placed += 1;
      }
    }
    towers.count = placed;
    towers.instanceMatrix.needsUpdate = true;
    this.disposables.push(geometry, material, texture);
    this.group.add(towers);

    // The street grid far below, so the dark has a floor.
    const grid = new THREE.GridHelper(1200, 60, accent, accent);
    grid.position.y = -DEPTH;
    const gridMaterial = grid.material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.25;
    this.disposables.push(grid.geometry, gridMaterial);
    this.group.add(grid);
    const floor = new THREE.MeshBasicMaterial({ color: towerColor });
    const plane = this.mesh(new THREE.PlaneGeometry(1400, 1400), floor);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -DEPTH - 0.5;
  }

  private addGate(track: Track, accent: THREE.Color, accent2: THREE.Color): void {
    const at = pointAt(track, 0, 0);
    const span = track.rail * 2 + 1.5;
    const gate = new THREE.Group();
    gate.position.set(at.x, at.h, at.z);
    gate.rotation.y = -at.a;
    const post = new THREE.MeshBasicMaterial({ color: "#1b1b26" });
    const beam = new THREE.MeshBasicMaterial({
      color: accent.clone().multiplyScalar(1.6),
      toneMapped: false,
    });
    const trim = new THREE.MeshBasicMaterial({
      color: accent2.clone().multiplyScalar(1.6),
      toneMapped: false,
    });
    const postGeometry = new THREE.BoxGeometry(0.8, 8, 0.8);
    const beamGeometry = new THREE.BoxGeometry(0.7, 1.1, span);
    const trimGeometry = new THREE.BoxGeometry(0.9, 0.18, span);
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(postGeometry, post);
      leg.position.set(0, 4, (side * span) / 2);
      gate.add(leg);
    }
    const bar = new THREE.Mesh(beamGeometry, beam);
    bar.position.y = 7.6;
    const line = new THREE.Mesh(trimGeometry, trim);
    line.position.y = 6.8;
    gate.add(bar, line);
    this.disposables.push(post, beam, trim, postGeometry, beamGeometry, trimGeometry);
    this.group.add(gate);
  }

  private addLamps(track: Track, height: Profile, color: THREE.Color): void {
    const count = Math.floor(track.n / 36);
    const poleGeometry = new THREE.BoxGeometry(0.22, 5, 0.22).translate(0, 2.5, 0);
    const bulbGeometry = new THREE.SphereGeometry(0.42, 8, 6);
    const pole = new THREE.MeshBasicMaterial({ color: "#1b1b26" });
    const bulb = new THREE.MeshBasicMaterial({
      color: color.clone().multiplyScalar(1.3),
      toneMapped: false,
    });
    const poles = new THREE.InstancedMesh(poleGeometry, pole, count);
    const bulbs = new THREE.InstancedMesh(bulbGeometry, bulb, count);
    for (let k = 0; k < count; k += 1) {
      const i = k * 36 + 18;
      const at = pointAt(track, i, (k % 2 === 0 ? 1 : -1) * (track.rail + 0.4));
      SCRATCH.scale.set(1, 1, 1);
      SCRATCH.position.set(at.x, height(i), at.z);
      SCRATCH.updateMatrix();
      poles.setMatrixAt(k, SCRATCH.matrix);
      SCRATCH.position.y += 5.2;
      SCRATCH.updateMatrix();
      bulbs.setMatrixAt(k, SCRATCH.matrix);
    }
    this.disposables.push(poleGeometry, bulbGeometry, pole, bulb);
    this.group.add(poles, bulbs);
  }

  private addPads(track: Track): void {
    const geometry = new THREE.PlaneGeometry(3.4, track.halfWidth * 1.5).rotateX(-Math.PI / 2);
    this.disposables.push(geometry);
    for (const index of track.pads) {
      const at = pointAt(track, index, 0);
      const material = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        transparent: true,
      });
      const pad = new THREE.Mesh(geometry, material);
      pad.position.set(at.x, at.h + 0.07, at.z);
      pad.rotation.y = -at.a;
      this.padMaterials.push(material);
      this.disposables.push(material);
      this.group.add(pad);
    }
  }
}
