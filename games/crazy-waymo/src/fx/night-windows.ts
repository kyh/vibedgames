import * as THREE from "three";

import type { ModelCache } from "../assets/loader";
import type { BatchItemRec } from "../world/city";
import { Rng } from "../shared/rng";

// Emissive night windows: the classic trick that makes a night city read
// ALIVE instead of merely visible. One static additive draw of lit-window
// quads generated on building facades from the batch-item records (solids
// don't carry heights — building boxes are "infinitely tall" for collision),
// ramped by the day-night lamp factor and faded out at the night fog line.
//
// Everything is baked in world space at build time: no per-frame work beyond
// two uniform writes, and the whole city is ONE draw call.

const MIN_HEIGHT = 7; // buildings shorter than this get no windows (sheds)
const FLOOR_STEP = 2.9; // world-space storey height
const COL_STEP = 2.3; // horizontal window spacing
const FACE_MARGIN = 1.1; // dead band at facade corners
const SILL_START = 2.0; // first storey sill height above the building base
const WIN_W = 0.62;
const WIN_H = 0.85;
const FACE_OFFSET = 0.09; // out from the wall so the quad never z-fights
const LIT_CHANCE = 0.45;
// Fade with the night fog (fogFar ~700 at night) so far windows never read
// as floating dots past the fog line.
const FADE_NEAR = 430;
const FADE_FAR = 680;

// Warm sodium-ish interior palette with the occasional cool TV-blue room.
const WARM = new THREE.Color(0xffd9a0);
const WARM2 = new THREE.Color(0xfff0c8);
const COOL = new THREE.Color(0xbfd8ff);

type Instance = {
  cx: number;
  cz: number;
  baseY: number;
  hx: number;
  hz: number;
  height: number;
  yaw: number;
};

export class NightWindows {
  readonly mesh: THREE.Mesh;
  private uNight = { value: 0 };

  constructor(items: readonly BatchItemRec[], cache: ModelCache, budget: number) {
    const rng = new Rng(20260709);
    const instances = collectBuildings(items, cache);

    // Candidate census first: the lit chance is scaled so the whole city
    // lands under `budget` quads regardless of how dense the bake is.
    let candidates = 0;
    for (const b of instances) candidates += candidateCount(b);
    const chance = LIT_CHANCE * Math.min(1, budget / Math.max(1, candidates * LIT_CHANCE));

    const positions: number[] = [];
    const colors: number[] = [];
    const scratch = new THREE.Color();
    for (const b of instances) {
      emitBuilding(b, rng, chance, positions, colors, scratch);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();

    const mat = new THREE.ShaderMaterial({
      uniforms: { uNight: this.uNight },
      vertexShader: /* glsl */ `
        attribute vec3 color;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          vColor = color;
          float d = distance(position, cameraPosition);
          vFade = 1.0 - smoothstep(${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, d);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          gl_FragColor = vec4(vColor * uNight * vFade, 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = "night-windows";
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2; // after the city, with the other glow passes
    console.log(
      `[windows] ${positions.length / 18} lit windows on ${instances.length} buildings` +
        ` (candidates ${candidates}, chance ${chance.toFixed(3)})`,
    );
  }

  setIntensity(night: number): void {
    this.uNight.value = night;
    this.mesh.visible = night > 0.02;
  }
}

// One record per building INSTANCE. Batch items are per source MESH with the
// child-node transform baked into the matrix, so a building is several items
// whose translations differ (roof pieces sit high). Grouping on (url, rounded
// x/z) and UNIONING each mesh's actual world-space bbox — expressed in the
// instance's yaw frame so rotated avenue buildings keep tight facades — gives
// the real building box. (Whole-model bounds at a child matrix put windows in
// the sky over multi-node models.)
type Acc = {
  yaw: number;
  sin: number;
  cos: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

function collectBuildings(items: readonly BatchItemRec[], cache: ModelCache): Instance[] {
  const acc = new Map<string, Acc>();
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const corner = new THREE.Vector3();
  for (const it of items) {
    if (it.url === null || !it.url.includes("/buildings/")) continue;
    const srcMesh = cache.srcMesh(it.url, it.idx);
    if (!srcMesh) continue;
    const geo = srcMesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) continue;
    m4.fromArray(it.m);
    m4.decompose(pos, quat, scl);
    // Buildings rotate about Y only; anything tilted isn't a facade.
    if (Math.abs(quat.x) > 1e-3 || Math.abs(quat.z) > 1e-3) continue;
    const yaw = 2 * Math.atan2(quat.y, quat.w);
    const key = `${it.url}|${Math.round(pos.x / 2)}|${Math.round(pos.z / 2)}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        yaw,
        sin: Math.sin(yaw),
        cos: Math.cos(yaw),
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      };
      acc.set(key, a);
    }
    // 8 bbox corners → world → the instance's yaw-local frame.
    for (let i = 0; i < 8; i++) {
      corner
        .set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
        .applyMatrix4(m4);
      const lx = corner.x * a.cos - corner.z * a.sin;
      const lz = corner.x * a.sin + corner.z * a.cos;
      if (lx < a.minX) a.minX = lx;
      if (lx > a.maxX) a.maxX = lx;
      if (corner.y < a.minY) a.minY = corner.y;
      if (corner.y > a.maxY) a.maxY = corner.y;
      if (lz < a.minZ) a.minZ = lz;
      if (lz > a.maxZ) a.maxZ = lz;
    }
  }
  const out: Instance[] = [];
  for (const a of acc.values()) {
    const height = a.maxY - a.minY;
    const hx = (a.maxX - a.minX) / 2;
    const hz = (a.maxZ - a.minZ) / 2;
    // Skip sheds and anything implausibly wide for a single building.
    if (height < MIN_HEIGHT || hx > 40 || hz > 40 || hx < 1 || hz < 1) continue;
    const lcx = (a.minX + a.maxX) / 2;
    const lcz = (a.minZ + a.maxZ) / 2;
    out.push({
      // Yaw-local centre back to world (inverse of the rotation above).
      cx: lcx * a.cos + lcz * a.sin,
      cz: -lcx * a.sin + lcz * a.cos,
      baseY: a.minY,
      hx,
      hz,
      height,
      yaw: a.yaw,
    });
  }
  return out;
}

function gridFor(b: Instance): { floors: number; colsX: number; colsZ: number } {
  return {
    floors: Math.max(0, Math.floor((b.height - SILL_START - 1.0) / FLOOR_STEP)),
    colsX: Math.max(0, Math.floor((b.hx * 2 - FACE_MARGIN * 2) / COL_STEP)),
    colsZ: Math.max(0, Math.floor((b.hz * 2 - FACE_MARGIN * 2) / COL_STEP)),
  };
}

function candidateCount(b: Instance): number {
  const g = gridFor(b);
  return g.floors * (g.colsX + g.colsZ) * 2;
}

function emitBuilding(
  b: Instance,
  rng: Rng,
  chance: number,
  positions: number[],
  colors: number[],
  scratch: THREE.Color,
): void {
  const g = gridFor(b);
  if (g.floors === 0) return;
  const sin = Math.sin(b.yaw);
  const cos = Math.cos(b.yaw);
  // Four faces in the building's LOCAL frame: (normal, tangent, half-extents).
  const faces: readonly { nx: number; nz: number; cols: number; half: number }[] = [
    { nx: 0, nz: 1, cols: g.colsX, half: b.hz },
    { nx: 0, nz: -1, cols: g.colsX, half: b.hz },
    { nx: 1, nz: 0, cols: g.colsZ, half: b.hx },
    { nx: -1, nz: 0, cols: g.colsZ, half: b.hx },
  ];
  for (const f of faces) {
    if (f.cols === 0) continue;
    // Tangent runs left along the face when looking at it from outside.
    const tx = -f.nz;
    const tz = f.nx;
    const span = (f.cols - 1) * COL_STEP;
    for (let fl = 0; fl < g.floors; fl++) {
      const y = b.baseY + SILL_START + fl * FLOOR_STEP;
      for (let c = 0; c < f.cols; c++) {
        if (!rng.chance(chance)) continue;
        const along = -span / 2 + c * COL_STEP;
        // Local-frame window centre, pushed out of the wall.
        const lx = f.nx * (f.nx !== 0 ? b.hx + FACE_OFFSET : 0) + tx * along;
        const lz = f.nz * (f.nz !== 0 ? b.hz + FACE_OFFSET : 0) + tz * along;
        // Local → world (rotate by yaw about the box centre).
        const wx = b.cx + lx * cos + lz * sin;
        const wz = b.cz - lx * sin + lz * cos;
        const wtx = tx * cos + tz * sin;
        const wtz = -tx * sin + tz * cos;
        const hw = WIN_W / 2;
        // Two triangles, CCW facing outward (backface-culled from inside).
        const ax = wx + wtx * hw;
        const az = wz + wtz * hw;
        const bx = wx - wtx * hw;
        const bz = wz - wtz * hw;
        const y0 = y;
        const y1 = y + WIN_H;
        positions.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
        scratch.copy(rng.chance(0.14) ? COOL : rng.chance(0.5) ? WARM : WARM2);
        scratch.multiplyScalar(0.55 + rng.range(0, 0.5));
        for (let v = 0; v < 6; v++) colors.push(scratch.r, scratch.g, scratch.b);
      }
    }
  }
}
