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
    // Real windows first: rectangles detected in each model's geometry (see
    // detectWindows) — lit quads land exactly ON the modelled glass. Models
    // where detection finds nothing fall back to the old procedural grid.
    const detected = collectDetected(items, cache);
    const instances = collectBuildings(detected.fallbackItems, cache);

    // Candidate census first: the lit chance is scaled so the whole city
    // lands under `budget` quads regardless of how dense the bake is.
    let candidates = detected.candidates;
    for (const b of instances) candidates += candidateCount(b);
    const chance = LIT_CHANCE * Math.min(1, budget / Math.max(1, candidates * LIT_CHANCE));

    const positions: number[] = [];
    const colors: number[] = [];
    const scratch = new THREE.Color();
    emitDetected(detected, rng, chance, positions, colors, scratch);
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
      // Detected panes inherit each instance's matrix — a mirrored (negative
      // determinant) instance would flip their winding and FrontSide-cull
      // them. No kit ships mirrored buildings today; DoubleSide closes the
      // trap for ~zero cost (tiny quads, additive, depth-tested).
      side: THREE.DoubleSide,
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

// --- Detected windows: light the ACTUAL modelled glass -------------------
// The kits paint window glass as a desaturated dark blue via the shared
// colormap atlas. Per source mesh (cached by url|idx): sample each triangle's
// UV centroid in the colormap, keep the blue "glass" triangles, group them
// into panes by shared vertices (scale-free — quantized meshopt attributes
// make fixed-size clustering impossible), and store each pane as a local-
// space rect (center, horizontal tangent, width, height). Instances then
// place lit quads exactly on their windows. Models with no detectable glass
// fall back to the procedural grid below.

type Pane = {
  cx: number;
  cy: number;
  cz: number;
  tx: number; // horizontal tangent (local)
  tz: number;
  w: number;
  h: number;
};

type DetectedInstance = { m: Float32Array; panes: readonly Pane[] };
type Detected = {
  instances: DetectedInstance[];
  fallbackItems: BatchItemRec[];
  candidates: number;
};

const imageDataCache = new Map<string, ImageData | null>();

function imageDataFor(tex: THREE.Texture): ImageData | null {
  const cached = imageDataCache.get(tex.uuid);
  if (cached !== undefined) return cached;
  let data: ImageData | null = null;
  const img: unknown = tex.image;
  if (
    img instanceof HTMLImageElement ||
    img instanceof ImageBitmap ||
    (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement)
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(img, 0, 0);
      try {
        data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        data = null; // tainted canvas — fall back
      }
    }
  }
  imageDataCache.set(tex.uuid, data);
  return data;
}

// Window glass swatches: Kenney's bright blue (103,148,217) and KayKit's
// slate blue (77,107,130). Both tests must EXCLUDE the blue-grey walls
// (142,149,179 / 121,131,136) and navy trim (81,85,102) — a loose
// blue-dominance check matched entire facades.
function isGlassRgb(r: number, g: number, b: number): boolean {
  if (b > 160 && b > r * 1.35 && b > g * 1.25) return true; // Kenney
  return b >= 115 && b <= 155 && b > r * 1.55 && b > g * 1.15; // KayKit
}

const paneCache = new Map<string, readonly Pane[]>();

function detectPanes(url: string, idx: number, cache: ModelCache): readonly Pane[] {
  const key = `${url}|${idx}`;
  const cached = paneCache.get(key);
  if (cached) return cached;
  const out: Pane[] = [];
  paneCache.set(key, out);
  const mesh = cache.srcMesh(url, idx);
  if (!mesh || Array.isArray(mesh.material)) return out;
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const mat = mesh.material;
  const map = mat instanceof THREE.MeshStandardMaterial ? mat.map : null;
  const img = map ? imageDataFor(map) : null;
  const flat =
    !img && mat instanceof THREE.MeshStandardMaterial
      ? isGlassRgb(mat.color.r * 255, mat.color.g * 255, mat.color.b * 255)
      : false;
  if (!img && !flat) return out;
  if (img && !uv) return out;

  const index = geo.index;
  const triCount = (index ? index.count : pos.count) / 3;
  if (triCount > 20000) return out;
  const vid = (t: number, k: number): number => (index ? index.getX(t * 3 + k) : t * 3 + k);

  // Glass triangles + union-find by shared vertex index.
  const glassTris: number[] = [];
  const parent = new Map<number, number>(); // tri -> parent tri
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    let c = a;
    while (parent.get(c) !== c) {
      const n = parent.get(c) ?? c;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const vertOwner = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    if (img) {
      let u = 0;
      let v = 0;
      for (let k = 0; k < 3; k++) {
        const i = vid(t, k);
        u += (uv?.getX(i) ?? 0) / 3;
        v += (uv?.getY(i) ?? 0) / 3;
      }
      u -= Math.floor(u);
      v -= Math.floor(v);
      const px = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)));
      const flipY = map ? map.flipY : false;
      const pyRaw = flipY ? 1 - v : v;
      const py = Math.min(img.height - 1, Math.max(0, Math.floor(pyRaw * img.height)));
      const o = (py * img.width + px) * 4;
      const r = img.data[o] ?? 0;
      const g = img.data[o + 1] ?? 0;
      const b = img.data[o + 2] ?? 0;
      if (!isGlassRgb(r, g, b)) continue;
    }
    // Steep faces only (skip skylight/roof glass) — cheap normal-Y test.
    const i0 = vid(t, 0);
    const i1 = vid(t, 1);
    const i2 = vid(t, 2);
    const e1x = pos.getX(i1) - pos.getX(i0);
    const e1y = pos.getY(i1) - pos.getY(i0);
    const e1z = pos.getZ(i1) - pos.getZ(i0);
    const e2x = pos.getX(i2) - pos.getX(i0);
    const e2y = pos.getY(i2) - pos.getY(i0);
    const e2z = pos.getZ(i2) - pos.getZ(i0);
    const nX = e1y * e2z - e1z * e2y;
    const nY = e1z * e2x - e1x * e2z;
    const nZ = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nX, nY, nZ) || 1;
    if (Math.abs(nY / nl) > 0.6) continue;
    glassTris.push(t);
    parent.set(t, t);
    for (const i of [i0, i1, i2]) {
      const owner = vertOwner.get(i);
      if (owner === undefined) vertOwner.set(i, t);
      else parent.set(find(t), find(owner));
    }
  }
  if (glassTris.length === 0 || glassTris.length > 4000) return out;

  // Pane rects per component, in the (tangent, Y) plane frame.
  type PaneAcc = {
    nx: number;
    nz: number;
    minU: number;
    maxU: number;
    minY: number;
    maxY: number;
    minD: number;
    maxD: number;
  };
  const accs = new Map<number, PaneAcc>();
  for (const t of glassTris) {
    const root = find(t);
    let a = accs.get(root);
    for (let k = 0; k < 3; k++) {
      const i = vid(t, k);
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (!a) {
        // Component normal from the first triangle (windows are planar).
        const i0 = vid(t, 0);
        const i1 = vid(t, 1);
        const i2 = vid(t, 2);
        const e1x = pos.getX(i1) - pos.getX(i0);
        const e1z = pos.getZ(i1) - pos.getZ(i0);
        const e2x = pos.getX(i2) - pos.getX(i0);
        const e2z = pos.getZ(i2) - pos.getZ(i0);
        const e1y = pos.getY(i1) - pos.getY(i0);
        const e2y = pos.getY(i2) - pos.getY(i0);
        let nx = e1y * e2z - e1z * e2y;
        let nz = e1x * e2y - e1y * e2x;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl;
        nz /= nl;
        a = {
          nx,
          nz,
          minU: Infinity,
          maxU: -Infinity,
          minY: Infinity,
          maxY: -Infinity,
          minD: Infinity,
          maxD: -Infinity,
        };
        accs.set(root, a);
      }
      const u = x * -a.nz + z * a.nx; // tangent coordinate
      const d = x * a.nx + z * a.nz; // plane depth
      if (u < a.minU) a.minU = u;
      if (u > a.maxU) a.maxU = u;
      if (y < a.minY) a.minY = y;
      if (y > a.maxY) a.maxY = y;
      if (d < a.minD) a.minD = d;
      if (d > a.maxD) a.maxD = d;
    }
  }
  for (const a of accs.values()) {
    const w = a.maxU - a.minU;
    const h = a.maxY - a.minY;
    if (w <= 0 || h <= 0) continue;
    const mu = (a.minU + a.maxU) / 2;
    const md = (a.maxD + a.minD) / 2;
    out.push({
      cx: -a.nz * mu + a.nx * md,
      cy: (a.minY + a.maxY) / 2,
      cz: a.nx * mu + a.nz * md,
      tx: -a.nz,
      tz: a.nx,
      w,
      h,
    });
  }
  return out;
}

function collectDetected(items: readonly BatchItemRec[], cache: ModelCache): Detected {
  const instances: DetectedInstance[] = [];
  const fallbackItems: BatchItemRec[] = [];
  let candidates = 0;
  // A model falls back only when NO mesh of its url has panes.
  const urlHasPanes = new Map<string, boolean>();
  for (const it of items) {
    if (it.url === null || !it.url.includes("/buildings/")) continue;
    const panes = detectPanes(it.url, it.idx, cache);
    if (panes.length > 0) {
      instances.push({ m: it.m, panes });
      candidates += panes.length;
      urlHasPanes.set(it.url, true);
    } else if (!urlHasPanes.has(it.url)) {
      urlHasPanes.set(it.url, false);
    }
  }
  for (const it of items) {
    if (it.url === null || !it.url.includes("/buildings/")) continue;
    if (!urlHasPanes.get(it.url)) fallbackItems.push(it);
  }
  return { instances, fallbackItems, candidates };
}

const M4 = new THREE.Matrix4();
const CORNERS = [
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
];
const EDGE_A = new THREE.Vector3();
const EDGE_B = new THREE.Vector3();
const NORMAL = new THREE.Vector3();

function emitDetected(
  det: Detected,
  rng: Rng,
  chance: number,
  positions: number[],
  colors: number[],
  scratch: THREE.Color,
): void {
  for (const inst of det.instances) {
    M4.fromArray(inst.m);
    for (const p of inst.panes) {
      if (!rng.chance(chance)) continue;
      // Inset 8% so the glow sits inside the frame.
      const hw = (p.w / 2) * 0.92;
      const hh = (p.h / 2) * 0.92;
      const c0 = CORNERS[0];
      const c1 = CORNERS[1];
      const c2 = CORNERS[2];
      const c3 = CORNERS[3];
      if (!c0 || !c1 || !c2 || !c3) continue;
      c0.set(p.cx + p.tx * hw, p.cy - hh, p.cz + p.tz * hw).applyMatrix4(M4);
      c1.set(p.cx - p.tx * hw, p.cy - hh, p.cz - p.tz * hw).applyMatrix4(M4);
      c2.set(p.cx - p.tx * hw, p.cy + hh, p.cz - p.tz * hw).applyMatrix4(M4);
      c3.set(p.cx + p.tx * hw, p.cy + hh, p.cz + p.tz * hw).applyMatrix4(M4);
      // World normal from the transformed rect; lift the quad off the glass.
      EDGE_A.subVectors(c1, c0);
      EDGE_B.subVectors(c3, c0);
      NORMAL.crossVectors(EDGE_A, EDGE_B).normalize().multiplyScalar(FACE_OFFSET);
      c0.add(NORMAL);
      c1.add(NORMAL);
      c2.add(NORMAL);
      c3.add(NORMAL);
      positions.push(c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, c2.x, c2.y, c2.z);
      positions.push(c0.x, c0.y, c0.z, c2.x, c2.y, c2.z, c3.x, c3.y, c3.z);
      scratch.copy(rng.chance(0.14) ? COOL : rng.chance(0.5) ? WARM : WARM2);
      scratch.multiplyScalar(0.55 + rng.range(0, 0.5));
      for (let v = 0; v < 6; v++) colors.push(scratch.r, scratch.g, scratch.b);
    }
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
