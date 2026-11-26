import { softLightMaterial } from "./soft-light";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  activePartitionRuns,
  APOTHEM,
  ARENA,
  BOSS_PLATFORM_RADIUS,
  BOSS_POS,
  CAMPS,
  FLOOR_OVERRIDES,
  floorKey,
  hasCustomMap,
  OBSTACLES,
  RUNE_SPOTS,
  SPAWNS,
} from "../data/map";
import { terrainHeight } from "../data/terrain";
import { PLATEAU_H, PLATEAU_R, STAIR_ANGLES, STAIR_HALF, STAIR_RUN } from "../sim/elevation";
import { buildDecor, hash2 } from "../data/decor";
import type { Decor } from "../data/decor";
import type { ModelLibrary } from "./models";
import { refreshStaticShadows } from "./view";
import { teamColor } from "./palette";
import { ArenaMaterials, floorVariation } from "./arena-materials";

/** Standing-tall models scale-to-height (target × decor scale) so they match
 *  the arena pillars; everything else keeps native size × scale. (Exported for
 *  the map editor, which replicates this planting math for pickable props.) */
export const TALL_TARGET = new Map<string, number>([
  ["pillar", 3.8],
  ["column", 3.8],
  ["pillar_decorated", 3.8],
  ["vampire_throne", 2.6],
  ["paladin_statue", 2.6],
]);

const TAU = Math.PI * 2;
const WARN_R = 7;
const WARN_SEE = 14;

const WALL_APOTHEM = APOTHEM + 1.5;
const WALL_H = 4;
const STORY2_H = 3.6;
const LEDGE_APOTHEM = WALL_APOTHEM + 2;
const STORY2_APOTHEM = WALL_APOTHEM + 4;
const EDGE_N = 11;

const EXTRA_PIECES = [
  "wall_half",
  "wall_half_endcap",
  "wall_arched",
  "wall_cracked",
  "wall_inset_candles",
  "wall_archedwindow_open",
  "wall_window_open",
  "barrier",
  "barrier_column",
  "stairs_walled",
] as const;

const V_POS = new THREE.Vector3();
const V_SCL = new THREE.Vector3();
const V_ZERO = new THREE.Vector3(0, 0, 0);
const E_ROT = new THREE.Euler(0, 0, 0, "YXZ");
const Q_ROT = new THREE.Quaternion();
const M_SCRATCH = new THREE.Matrix4();
const M_OUT = new THREE.Matrix4();
const BOX_SCRATCH = new THREE.Box3();
const C_SCRATCH = new THREE.Color();

interface GeoInfo {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  box: THREE.Box3;
  meshCount: number;
}

let dotTex: THREE.Texture | null = null;

const softDot = () => {
  if (dotTex) {
    return dotTex;
  }

  const c = document.createElement("canvas");
  c.height = 64;
  c.width = 64;
  const g = c.getContext("2d");

  if (!g) {
    dotTex = new THREE.Texture();

    return dotTex;
  }

  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  dotTex = new THREE.CanvasTexture(c);

  return dotTex;
};

interface DriftGlsl {
  head: string;
  body: string;
}

const DRIFT_HASH = "float baHash(float n) { return fract(sin(n) * 43758.5453123); }";

const EMBER_DRIFT: DriftGlsl = {
  body: [
    "float life = 0.8 + 1.4 * baHash(aSeed);",
    "float cyc = floor(uTime / life);",
    "float age = uTime - cyc * life;",
    "float h = aSeed * 97.31 + cyc * 13.37;",
    "transformed += vec3((baHash(h + 1.0) - 0.5) * 0.5, baHash(h + 2.0) * 0.4 - 0.3, (baHash(h + 3.0) - 0.5) * 0.5);",
    "vec3 vel = vec3((baHash(h + 4.0) - 0.5) * 0.4, 0.7 + baHash(h + 5.0) * 0.8, (baHash(h + 6.0) - 0.5) * 0.4);",
    "transformed += vel * age + vec3(0.0, 0.15 * age * age, 0.0);",
  ].join("\n"),
  head: `attribute float aSeed;\nuniform float uTime;\n${DRIFT_HASH}`,
};

const GOLD_DRIFT: DriftGlsl = {
  body: "transformed.y = 2.2 + mod(transformed.y - 2.2 + uTime * 0.5, 4.0);",
  head: "uniform float uTime;",
};

const MOTE_DRIFT: DriftGlsl = {
  body: "transformed += aVel * uTime;\ntransformed.y = 0.5 + mod(transformed.y - 0.5, 5.5);",
  head: "attribute vec3 aVel;\nuniform float uTime;",
};

const driftPoints = (
  mat: THREE.PointsMaterial,
  key: string,
  glsl: DriftGlsl,
  time: { value: number },
) => {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${glsl.head}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${glsl.body}`);
  };

  mat.customProgramCacheKey = () => key;
};

interface Blob {
  x: number;
  y: number;
  r: number;
}

type FloorBand = "flag" | "worn" | "dirt" | "grate";

type Cell = [number, number, number, number];

type CellBuckets = { [K in FloorBand]: Cell[] };

const inAnyBlob = (gx: number, gz: number, blobs: Blob[]) => {
  for (const b of blobs) {
    const dx = gx - b.x;
    const dz = gz - b.y;

    if (dx * dx + dz * dz <= b.r * b.r) {
      return true;
    }
  }

  return false;
};

const floorBand: (
  gx: number,
  gz: number,
  y: number,
  blobs: Blob[],
  have: { dirt: boolean; worn: boolean; grate: boolean },
) => FloorBand = (gx, gz, y, blobs, have) => {
  const painted = FLOOR_OVERRIDES.get(floorKey(gx, gz));

  if (painted) {
    return painted;
  }

  if (y > 0) {
    return "flag";
  }

  if (have.dirt && inAnyBlob(gx, gz, blobs)) {
    return "dirt";
  }

  const r = Math.hypot(gx, gz);
  const h = hash2(gx / 4, gz / 4);

  if (have.worn && r > WALL_APOTHEM * 0.34 && h < 0.16) {
    return "worn";
  }

  if (have.grate && r > WALL_APOTHEM * 0.39 && r < WALL_APOTHEM * 0.84 && h >= 0.16 && h < 0.205) {
    return "grate";
  }

  return "flag";
};

const storyTwoWallModel = (h: number) => {
  if (h < 0.3) {
    return "wall_archedwindow_open";
  }

  return h < 0.48 ? "wall_window_open" : "wall";
};

const fallbackPillarModel = (i: number) => {
  if (hasCustomMap()) {
    return null;
  }

  if (i % 3 === 0) {
    return "pillar_decorated";
  }

  return i % 3 === 1 ? "column" : "pillar";
};

const plantMatrix = (
  box: THREE.Box3,
  x: number,
  z: number,
  baseY: number,
  rot: number,
  sx: number,
  sy: number,
  sz: number,
) => {
  E_ROT.set(0, rot, 0);
  Q_ROT.setFromEuler(E_ROT);
  V_SCL.set(sx, sy, sz);
  M_SCRATCH.compose(V_ZERO, Q_ROT, V_SCL);
  BOX_SCRATCH.copy(box).applyMatrix4(M_SCRATCH);
  V_POS.set(
    x - (BOX_SCRATCH.min.x + BOX_SCRATCH.max.x) / 2,
    baseY - BOX_SCRATCH.min.y,
    z - (BOX_SCRATCH.min.z + BOX_SCRATCH.max.z) / 2,
  );

  return new THREE.Matrix4().compose(V_POS, Q_ROT, V_SCL);
};

const decorMatrix = (d: Decor, box: THREE.Box3) => {
  const tall = d.lie === true ? undefined : TALL_TARGET.get(d.model);
  const bh = Math.max(0.01, box.max.y - box.min.y);
  const s = tall === undefined ? d.scale : (tall * d.scale) / bh;
  E_ROT.set(0, d.rot, d.lie === true ? Math.PI / 2 : 0);
  Q_ROT.setFromEuler(E_ROT);
  V_SCL.set(s, s, s);
  M_SCRATCH.compose(V_ZERO, Q_ROT, V_SCL);
  BOX_SCRATCH.copy(box).applyMatrix4(M_SCRATCH);
  const y = terrainHeight(d.x, d.y) - BOX_SCRATCH.min.y + (d.h ?? 0);
  V_POS.set(d.x, y, d.y);

  return M_OUT.compose(V_POS, Q_ROT, V_SCL);
};

export class Environment {
  private readonly materials = new ArenaMaterials();
  private readonly reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  private readonly flames: THREE.PointLight[] = [];
  private embers: THREE.Points | null = null;
  private motes: THREE.Points | null = null;
  private goldMotes: THREE.Points | null = null;
  private readonly ambientTime = { value: 0 };
  private warnRims: THREE.InstancedMesh | null = null;
  private warnLevels: Float32Array = new Float32Array(0);
  private localX = 0;
  private localY = 0;
  private hasLocal = false;
  private homeSlot = -1;
  private lastT = -1;
  private disposed = false;
  private readonly extras = new Map<string, THREE.Object3D>();
  private readonly added: THREE.Object3D[] = [];
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];

  private readonly scene: THREE.Scene;
  private readonly lib: ModelLibrary;
  private readonly opts: { decor?: boolean; obstacles?: boolean };

  constructor(
    scene: THREE.Scene,
    lib: ModelLibrary,
    opts: { decor?: boolean; obstacles?: boolean } = {},
  ) {
    this.scene = scene;
    this.lib = lib;
    this.opts = opts;
  }

  setup() {
    this.buildFloor();
    this.buildPlatform();

    if (this.opts.obstacles !== false) {
      for (const [i, o] of OBSTACLES.entries()) {
        if (o.model === "wall_run") {
          continue;
        }

        const name = o.model ?? fallbackPillarModel(i);

        if (name === null) {
          continue;
        }

        const rot = o.model === "paladin_statue" ? Math.atan2(-o.x, -o.y) : i * 0.7;
        this.add(this.place(name, o.x, o.y, o.height, rot));
      }
    }

    if (this.opts.decor !== false) {
      this.buildDecorInstanced();
    }

    const torchN = 6;

    for (let i = 0; i < torchN; i += 1) {
      const a = (i / torchN) * TAU;
      const r = BOSS_PLATFORM_RADIUS + 1.6;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      this.add(this.place("torch_lit", x, y, 2, a));
      const light = new THREE.PointLight(0xff_8a_2c, 6, 12, 2);
      light.position.set(x, 2.4, y);
      this.add(light);
      this.flames.push(light);
    }

    const throneLight = new THREE.PointLight(0xff_c8_61, 5, 16, 2);
    throneLight.position.set(0, 6.2, 0);
    this.add(throneLight);
    this.flames.push(throneLight);

    for (const sp of SPAWNS) {
      const inward = Math.atan2(-sp.y, -sp.x);
      const ox = Math.cos(inward + Math.PI / 2) * 2.4;
      const oy = Math.sin(inward + Math.PI / 2) * 2.4;
      this.add(this.place("torch_lit", sp.x + ox, sp.y + oy, 2, inward));
      const banner = this.place("banner_red", sp.x - ox, sp.y - oy, 3, sp.facing);
      const team = new THREE.Color(teamColor(`bot:${sp.slot}`));
      banner.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) {
          return;
        }

        const src = Array.isArray(o.material) ? o.material[0] : o.material;

        if (!src) {
          return;
        }

        const cloned = src.clone();

        if (cloned instanceof THREE.MeshStandardMaterial) {
          cloned.color.lerp(team, 0.7);
        }

        o.material = cloned;
        this.ownedMats.push(cloned);
      });
      this.add(banner);
    }

    this.buildGolemLair();
    this.buildMonolithGlow();
    this.buildLightShafts();
    this.buildWarnRims();
    this.buildAmbient();

    void this.initArchitecture();
  }

  private async initArchitecture() {
    try {
      await this.loadExtras();
    } catch (error) {
      console.error("[environment] architecture load failed", error);

      return;
    }

    if (this.disposed) {
      this.disposeExtras();

      return;
    }

    this.buildPerimeter();

    if (this.opts.obstacles !== false) {
      this.buildPartitions();
    }

    refreshStaticShadows();
  }

  private async loadExtras() {
    const loader = new GLTFLoader();
    await Promise.all(
      EXTRA_PIECES.map(async (name) => {
        const gltf = await loader.loadAsync(`./models/dungeon/${name}.gltf`);
        const graded = new Set<THREE.Material>();
        gltf.scene.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) {
            return;
          }

          o.castShadow = true;
          o.receiveShadow = true;
          const mats = Array.isArray(o.material) ? o.material : [o.material];

          for (const m of mats) {
            if (!(m instanceof THREE.MeshStandardMaterial) || graded.has(m)) {
              continue;
            }

            graded.add(m);
            m.roughness = Math.max(m.roughness, 0.82);
            m.envMapIntensity = 0.35;
            m.color.setHex(0xca_bb_9f);
          }
        });
        this.extras.set(name, gltf.scene);
      }),
    );
  }

  private disposeExtras() {
    for (const tpl of this.extras.values()) {
      tpl.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) {
          return;
        }

        o.geometry.dispose();
        const ms = Array.isArray(o.material) ? o.material : [o.material];

        for (const m of ms) {
          m.dispose();
        }
      });
    }

    this.extras.clear();
  }

  private add(o: THREE.Object3D) {
    this.scene.add(o);
    this.added.push(o);
  }

  private templateOf(name: string) {
    const extra = this.extras.get(name);
    const object = extra ? extra.clone(true) : this.lib.instance(name);
    this.materials.apply(object, name);

    return object;
  }

  private geoOf(name: string) {
    const tpl = this.templateOf(name);
    tpl.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    tpl.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        meshes.push(o);
      }
    });
    const [mesh] = meshes;

    if (!mesh) {
      return null;
    }

    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;

    const box = bb
      ? bb.clone()
      : new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));

    const rawMat = mesh.material;
    const mat = Array.isArray(rawMat) ? rawMat[0] : rawMat;

    if (!mat) {
      return null;
    }

    this.ownedGeos.push(geo);

    return { box, geo, mat, meshCount: meshes.length };
  }

  private addInstanced(model: string, mats: THREE.Matrix4[], shadows = true) {
    if (mats.length === 0) {
      return;
    }

    const info = this.geoOf(model);

    if (!info) {
      return;
    }

    if (info.meshCount > 1) {
      for (const m of mats) {
        const obj = this.templateOf(model);
        obj.applyMatrix4(m);
        obj.traverse((c) => {
          if (c instanceof THREE.Mesh) {
            c.castShadow = shadows;
            c.receiveShadow = true;
          }
        });
        this.add(obj);
      }

      return;
    }

    const inst = new THREE.InstancedMesh(info.geo, info.mat, mats.length);
    inst.castShadow = shadows;
    inst.receiveShadow = true;

    for (const [i, m] of mats.entries()) {
      inst.setMatrixAt(i, m);
    }

    inst.instanceMatrix.needsUpdate = true;
    this.add(inst);
  }

  private buildDecorInstanced() {
    const groups = new Map<string, Decor[]>();

    for (const d of buildDecor()) {
      const g = groups.get(d.model);

      if (g) {
        g.push(d);
      } else {
        groups.set(d.model, [d]);
      }
    }

    for (const [model, items] of groups) {
      const info = this.geoOf(model);

      if (!info) {
        continue;
      }

      if (info.meshCount > 1) {
        for (const d of items) {
          this.add(this.placeScaled(d));
        }

        continue;
      }

      const inst = new THREE.InstancedMesh(info.geo, info.mat, items.length);
      inst.castShadow = true;
      inst.receiveShadow = true;

      for (const [i, d] of items.entries()) {
        inst.setMatrixAt(i, decorMatrix(d, info.box));
      }

      inst.instanceMatrix.needsUpdate = true;
      this.add(inst);
    }
  }

  private buildGolemLair() {
    const camp = CAMPS.find((c) => c.id === "golem");

    if (!camp) {
      return;
    }

    const ang = Math.atan2(camp.y, camp.x);
    const frost = new THREE.Color(0x9f_d4_ff);

    const ring: { model: string; specs: { da: number; r: number; s: number }[] }[] = [
      {
        model: "rocks",
        specs: [
          { da: 0.5, r: 2.9, s: 1.15 },
          { da: 2.4, r: 3.1, s: 1.05 },
          { da: -1.9, r: 2.7, s: 1.25 },
        ],
      },
      {
        model: "rubble_half",
        specs: [
          { da: 1.4, r: 2.5, s: 0.5 },
          { da: -0.8, r: 2.6, s: 0.45 },
        ],
      },
    ];

    for (const [gi, group] of ring.entries()) {
      const info = this.geoOf(group.model);

      if (!info) {
        continue;
      }

      const mat = info.mat.clone();

      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.color.lerp(frost, 0.6);
      }

      this.ownedMats.push(mat);
      const inst = new THREE.InstancedMesh(info.geo, mat, group.specs.length);
      inst.castShadow = true;
      inst.receiveShadow = true;

      for (const [i, sp] of group.specs.entries()) {
        const x = camp.x + Math.cos(ang + sp.da) * sp.r;
        const y = camp.y + Math.sin(ang + sp.da) * sp.r;

        const d: Decor = {
          model: group.model,
          rot: hash2(gi * 5 + i, 67) * TAU,
          scale: sp.s,
          x,
          y,
        };

        inst.setMatrixAt(i, decorMatrix(d, info.box));
      }

      inst.instanceMatrix.needsUpdate = true;
      this.add(inst);
    }
  }

  private buildMonolithGlow() {
    const rings: THREE.BufferGeometry[] = [];

    for (const p of RUNE_SPOTS) {
      const g = new THREE.RingGeometry(0.9, 1.2, 24);
      g.rotateX(-Math.PI / 2);
      g.translate(p.x, terrainHeight(p.x, p.y) + 0.1, p.y);
      rings.push(g);
    }

    const merged = mergeGeometries(rings);

    for (const g of rings) {
      g.dispose();
    }

    if (!merged) {
      return;
    }

    const mat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color: 0x66_cc_ff,
      depthWrite: false,
      opacity: 0.12,
      transparent: true,
    });

    this.ownedGeos.push(merged);
    this.ownedMats.push(mat);
    this.add(new THREE.Mesh(merged, mat));
  }

  private buildLightShafts() {
    const edge = Math.PI / 6;

    const spots: [number, number][] = [-9, 0, 9].map((t) => {
      const x = Math.cos(edge) * 31 - Math.sin(edge) * t;
      const y = Math.sin(edge) * 31 + Math.cos(edge) * t;

      return [x, y];
    });

    const azLen = Math.hypot(18, 12);
    const azX = 18 / azLen;
    const azZ = 12 / azLen;
    const tiltAxis = new THREE.Vector3(azZ, 0, -azX);
    Q_ROT.setFromAxisAngle(tiltAxis, (16 * Math.PI) / 180);
    const cones: THREE.BufferGeometry[] = [];

    for (const [x, y] of spots) {
      const g = new THREE.CylinderGeometry(0.5, 2, 13, 10, 1, true);
      g.applyQuaternion(Q_ROT);
      g.translate(x, 4.6, y);
      cones.push(g);
    }

    const merged = mergeGeometries(cones);

    for (const g of cones) {
      g.dispose();
    }

    if (!merged) {
      return;
    }

    const mat = softLightMaterial(0x9f_c6_e0, 0.035);
    this.ownedGeos.push(merged);
    this.ownedMats.push(mat);
    this.add(new THREE.Mesh(merged, mat));
  }

  private buildWarnRims() {
    const geo = new THREE.RingGeometry(WARN_R - 0.45, WARN_R, 48);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color: 0xff_40_30,
      depthWrite: false,
      transparent: true,
    });

    const inst = new THREE.InstancedMesh(geo, mat, SPAWNS.length);
    this.warnLevels = new Float32Array(SPAWNS.length);

    for (const [i, sp] of SPAWNS.entries()) {
      M_OUT.makeTranslation(sp.x, 0.1, sp.y);
      inst.setMatrixAt(i, M_OUT);
      inst.setColorAt(i, C_SCRATCH.setRGB(0, 0, 0));
    }

    inst.instanceMatrix.needsUpdate = true;

    if (inst.instanceColor) {
      inst.instanceColor.needsUpdate = true;
    }

    this.ownedGeos.push(geo);
    this.ownedMats.push(mat);
    this.warnRims = inst;
    this.add(inst);
  }

  private buildAmbient() {
    const tex = softDot();
    const EN = 110;
    const epos = new Float32Array(EN * 3);
    const eseed = new Float32Array(EN);
    const ecol = new Float32Array(EN * 3);
    const n = Math.min(6, this.flames.length);

    for (let i = 0; i < EN; i += 1) {
      const f = n > 0 ? this.flames[i % n] : undefined;
      const p = f ? f.position : { x: 0, y: 2, z: 0 };
      epos[i * 3] = p.x;
      epos[i * 3 + 1] = p.y;
      epos[i * 3 + 2] = p.z;
      eseed[i] = Math.random() * 100;
      ecol[i * 3] = 1.4;
      ecol[i * 3 + 1] = 0.55;
      ecol[i * 3 + 2] = 0.12;
    }

    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(epos, 3));
    eg.setAttribute("aSeed", new THREE.BufferAttribute(eseed, 1));
    eg.setAttribute("color", new THREE.BufferAttribute(ecol, 3));

    const em = new THREE.PointsMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      map: tex,
      size: 0.17,
      transparent: true,
      vertexColors: true,
    });

    driftPoints(em, "ba-embers", EMBER_DRIFT, this.ambientTime);
    this.embers = new THREE.Points(eg, em);
    this.embers.frustumCulled = false;
    this.ownedGeos.push(eg);
    this.ownedMats.push(em);
    this.add(this.embers);

    const GN = 40;
    const gpos = new Float32Array(GN * 3);
    const gcol = new Float32Array(GN * 3);

    for (let i = 0; i < GN; i += 1) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * (PLATEAU_R - 0.5);
      gpos[i * 3] = Math.cos(a) * r;
      gpos[i * 3 + 1] = 2.2 + Math.random() * 3.8;
      gpos[i * 3 + 2] = Math.sin(a) * r;
      gcol[i * 3] = 1.5;
      gcol[i * 3 + 1] = 1.05;
      gcol[i * 3 + 2] = 0.3;
    }

    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.BufferAttribute(gpos, 3));
    gg.setAttribute("color", new THREE.BufferAttribute(gcol, 3));

    const gm = new THREE.PointsMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      map: tex,
      size: 0.11,
      transparent: true,
      vertexColors: true,
    });

    driftPoints(gm, "ba-gold-motes", GOLD_DRIFT, this.ambientTime);
    this.goldMotes = new THREE.Points(gg, gm);
    this.goldMotes.frustumCulled = false;
    this.ownedGeos.push(gg);
    this.ownedMats.push(gm);
    this.add(this.goldMotes);

    const coarse = "matchMedia" in window && window.matchMedia("(pointer:coarse)").matches;

    if (coarse || window.devicePixelRatio < 1.3) {
      return;
    }

    const MN = 180;
    const mpos = new Float32Array(MN * 3);
    const mvel = new Float32Array(MN * 3);

    for (let i = 0; i < MN; i += 1) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * APOTHEM;
      mpos[i * 3] = Math.cos(a) * r;
      mpos[i * 3 + 1] = 0.5 + Math.random() * 5.5;
      mpos[i * 3 + 2] = Math.sin(a) * r;
      mvel[i * 3] = (Math.random() - 0.5) * 0.3;
      mvel[i * 3 + 1] = 0.1 + Math.random() * 0.2;
      mvel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    }

    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(mpos, 3));
    mg.setAttribute("aVel", new THREE.BufferAttribute(mvel, 3));

    const mm = new THREE.PointsMaterial({
      blending: THREE.AdditiveBlending,
      color: 0x9f_c6_e0,
      depthWrite: false,
      map: tex,
      opacity: 0.5,
      size: 0.07,
      transparent: true,
    });

    driftPoints(mm, "ba-dust-motes", MOTE_DRIFT, this.ambientTime);
    this.motes = new THREE.Points(mg, mm);
    this.motes.frustumCulled = false;
    this.ownedGeos.push(mg);
    this.ownedMats.push(mm);
    this.add(this.motes);
  }

  private static hexDepth(x: number, y: number, apothem: number) {
    let d = -Infinity;

    for (let k = 0; k < 6; k += 1) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      const v = x * Math.cos(a) + y * Math.sin(a) - apothem;

      if (v > d) {
        d = v;
      }
    }

    return d;
  }

  /** Tear down + rebuild just the floor instancing — the editor calls this
   *  live while painting FLOOR_OVERRIDES. */
  rebuildFloor() {
    for (const m of this.floorMeshes) {
      this.scene.remove(m);
      m.dispose();
      const at = this.added.indexOf(m);

      if (at !== -1) {
        this.added.splice(at, 1);
      }
    }

    for (const geometry of this.floorGeos) {
      geometry.dispose();
      const at = this.ownedGeos.indexOf(geometry);

      if (at !== -1) {
        this.ownedGeos.splice(at, 1);
      }
    }

    this.floorMeshes.length = 0;
    this.floorGeos.clear();
    this.buildFloor();
  }

  private readonly floorMeshes: THREE.InstancedMesh[] = [];
  private readonly floorGeos = new Set<THREE.BufferGeometry>();

  private buildFloor() {
    const flag = this.geoOf("floor_tile_large");
    const worn = this.geoOf("floor_tile_large_rocks");
    const dirt = this.geoOf("floor_dirt_large");
    const grate = this.geoOf("floor_tile_big_grate");

    if (!flag) {
      return;
    }

    for (const info of [flag, worn, dirt, grate]) {
      if (!info) {
        continue;
      }

      this.floorGeos.add(info.geo);
      const c = info.box.getCenter(V_POS);
      info.geo.translate(-c.x, 0, -c.z);
    }

    const blobs: Blob[] = CAMPS.map((c) => ({
      r: c.id === "golem" ? 5.5 : 5,
      x: c.x,
      y: c.y,
    }));

    for (let k = 0; k < 12; k += 1) {
      const a = hash2(k, 91) * TAU;
      const r = WALL_APOTHEM * (0.34 + hash2(k, 92) * 0.55);
      blobs.push({ r: 3.5 + hash2(k, 93) * 3, x: Math.cos(a) * r, y: Math.sin(a) * r });
    }

    const tile = 4;

    const cells: CellBuckets = {
      dirt: [],
      flag: [],
      grate: [],
      worn: [],
    };

    const have = { dirt: dirt !== null, grate: grate !== null, worn: worn !== null };
    const lim = Math.ceil((WALL_APOTHEM + 4) / tile) * tile;

    for (let gx = -lim; gx <= lim; gx += tile) {
      for (let gz = -lim; gz <= lim; gz += tile) {
        if (Environment.hexDepth(gx, gz, WALL_APOTHEM + 1) > 0) {
          continue;
        }

        const r2 = gx * gx + gz * gz;
        const rot = Math.floor(hash2(gz / 4, gx / 4) * 4) * (Math.PI / 2);
        const y = r2 < PLATEAU_R * PLATEAU_R ? PLATEAU_H : 0;
        cells[floorBand(gx, gz, y, blobs, have)].push([gx, gz, y, rot]);
      }
    }

    const bands: [GeoInfo | null, Cell[]][] = [
      [flag, cells.flag],
      [worn, cells.worn],
      [dirt, cells.dirt],
      [grate, cells.grate],
    ];

    for (const [info, list] of bands) {
      if (!info || list.length === 0) {
        continue;
      }

      const inst = new THREE.InstancedMesh(info.geo, info.mat, list.length);
      inst.receiveShadow = true;

      for (const [i, [x, z, y, rot]] of list.entries()) {
        E_ROT.set(0, rot, 0);
        Q_ROT.setFromEuler(E_ROT);
        V_POS.set(x, y, z);
        V_SCL.set(1, 1, 1);
        inst.setMatrixAt(i, M_OUT.compose(V_POS, Q_ROT, V_SCL));
        inst.setColorAt(i, floorVariation(x, z, C_SCRATCH));
      }

      inst.instanceMatrix.needsUpdate = true;

      if (inst.instanceColor) {
        inst.instanceColor.needsUpdate = true;
      }

      this.add(inst);
      this.floorMeshes.push(inst);
    }
  }

  private buildPerimeter() {
    const mats = new Map<string, THREE.Matrix4[]>();

    const put = (model: string, m: THREE.Matrix4) => {
      const list = mats.get(model);

      if (list) {
        list.push(m);
      } else {
        mats.set(model, [m]);
      }
    };

    const boxes = new Map<string, THREE.Box3>();

    const boxOf = (model: string) => {
      const cached = boxes.get(model);

      if (cached) {
        return cached;
      }

      const tpl = this.templateOf(model);
      tpl.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(tpl);
      boxes.set(model, box);

      return box;
    };

    const wallBox = boxOf("wall");
    const wallW = Math.max(0.01, wallBox.max.x - wallBox.min.x);
    const wallH = Math.max(0.01, wallBox.max.y - wallBox.min.y);
    const syWall = WALL_H / wallH;

    const runPiece = (
      model: string,
      edgeA: number,
      apothem: number,
      t: number,
      baseY: number,
      sx: number,
      sy: number,
    ) => {
      const x = Math.cos(edgeA) * apothem - Math.sin(edgeA) * t;
      const z = Math.sin(edgeA) * apothem + Math.cos(edgeA) * t;
      put(model, plantMatrix(boxOf(model), x, z, baseY, Math.PI / 2 - edgeA, sx, sy, 1));
    };

    for (let k = 0; k < 6; k += 1) {
      const A = Math.PI / 6 + (k * Math.PI) / 3;
      const side1 = (2 * WALL_APOTHEM) / Math.sqrt(3);
      const piece1 = side1 / EDGE_N;
      const sx1 = (piece1 / wallW) * 1.02;

      for (let i = 0; i < EDGE_N; i += 1) {
        const t = (i - (EDGE_N - 1) / 2) * piece1;
        const mid = i === (EDGE_N - 1) / 2;
        let model = "wall";

        if (mid) {
          model = "wall_gated";
        } else if (i === (EDGE_N - 1) / 2 - 1 || i === (EDGE_N - 1) / 2 + 1) {
          model = "wall_pillar";
        } else {
          const h = hash2(k * 31 + i, 101);

          if (h < 0.14) {
            model = "wall_cracked";
          } else if (h < 0.26) {
            model = "wall_arched";
          } else if (h < 0.34) {
            model = "wall_inset_candles";
          } else if (h < 0.4) {
            model = "wall_broken";
          }
        }

        runPiece(model, A, WALL_APOTHEM, t, 0, sx1, syWall);
      }

      const sideL = (2 * LEDGE_APOTHEM) / Math.sqrt(3);
      const ledgeN = 11;
      const ledgeBox = boxOf("floor_tile_large");
      const ledgeW = Math.max(0.01, ledgeBox.max.x - ledgeBox.min.x);
      const pieceL = sideL / (ledgeN + 1);

      for (let i = 0; i < ledgeN; i += 1) {
        const t = (i - (ledgeN - 1) / 2) * pieceL;
        const x = Math.cos(A) * LEDGE_APOTHEM - Math.sin(A) * t;
        const z = Math.sin(A) * LEDGE_APOTHEM + Math.cos(A) * t;
        put(
          "floor_tile_large",
          plantMatrix(
            boxOf("floor_tile_large"),
            x,
            z,
            WALL_H - 0.25,
            Math.PI / 2 - A,
            (pieceL / ledgeW) * 1.02,
            1,
            1.08,
          ),
        );
      }

      const balA = WALL_APOTHEM - 0.15;
      const sideB = (2 * balA) / Math.sqrt(3);
      const balN = 11;
      const balBox = boxOf("barrier");
      const balW = Math.max(0.01, balBox.max.x - balBox.min.x);
      const pieceB = sideB / (balN + 1);

      for (let i = 0; i < balN; i += 1) {
        const t = (i - (balN - 1) / 2) * pieceB;
        runPiece("barrier", A, balA, t, WALL_H, (pieceB / balW) * 1, 1);
      }

      runPiece("barrier_column", A, balA, ((balN + 1) / 2) * pieceB - 0.3, WALL_H, 1, 1);
      runPiece("barrier_column", A, balA, -(((balN + 1) / 2) * pieceB - 0.3), WALL_H, 1, 1);

      const side2 = (2 * STORY2_APOTHEM) / Math.sqrt(3);
      const N2 = 12;
      const piece2 = side2 / N2;
      const sx2 = (piece2 / wallW) * 1.02;
      const sy2 = STORY2_H / wallH;

      for (let i = 0; i < N2; i += 1) {
        const t = (i - (N2 - 1) / 2) * piece2;
        const h = hash2(k * 47 + i, 103);
        const model = storyTwoWallModel(h);
        runPiece(model, A, STORY2_APOTHEM, t, WALL_H, sx2, sy2);

        if (i % 4 === 2 && h >= 0.48) {
          const bModel = k % 2 === 0 ? "banner_red" : "banner_blue";
          const bx = Math.cos(A) * (STORY2_APOTHEM - 0.7) - Math.sin(A) * t;
          const bz = Math.sin(A) * (STORY2_APOTHEM - 0.7) + Math.cos(A) * t;
          put(
            bModel,
            plantMatrix(boxOf(bModel), bx, bz, WALL_H + 0.9, Math.PI / 2 - A + Math.PI, 1, 1, 1),
          );
        }
      }

      if (k === 1 || k === 4) {
        runPiece("stairs_walled", A, LEDGE_APOTHEM - 0.4, 8.5, WALL_H, 1, 1);
      }
    }

    for (let k = 0; k < 6; k += 1) {
      const a = (k * Math.PI) / 3;
      const vr = WALL_APOTHEM / Math.cos(Math.PI / 6) - 0.6;
      put(
        "wall_pillar",
        plantMatrix(
          boxOf("wall_pillar"),
          Math.cos(a) * vr,
          Math.sin(a) * vr,
          0,
          Math.PI / 2 - a,
          1.6,
          (WALL_H + STORY2_H + 0.3) / wallH,
          1.6,
        ),
      );
      const vr2 = STORY2_APOTHEM / Math.cos(Math.PI / 6) - 0.7;
      put(
        "wall_pillar",
        plantMatrix(
          boxOf("wall_pillar"),
          Math.cos(a) * vr2,
          Math.sin(a) * vr2,
          WALL_H,
          Math.PI / 2 - a,
          1.5,
          (STORY2_H + 0.4) / wallH,
          1.5,
        ),
      );
    }

    for (const [model, list] of mats) {
      this.addInstanced(model, list);
    }
  }

  private buildPartitions() {
    const seg = this.geoOf("wall");
    const cap = this.geoOf("wall_half_endcap");

    if (!seg) {
      return;
    }

    const segW = Math.max(0.01, seg.box.max.x - seg.box.min.x);
    const segH = Math.max(0.01, seg.box.max.y - seg.box.min.y);
    const sy = 2.6 / segH;
    const capH = cap ? Math.max(0.01, cap.box.max.y - cap.box.min.y) : 1;
    const capSy = cap ? 2.7 / capH : 1;
    const segMats: THREE.Matrix4[] = [];
    const capMats: THREE.Matrix4[] = [];

    for (const run of activePartitionRuns()) {
      const first = run.offsets[0] ?? 0;
      const last = run.offsets.at(-1) ?? 0;
      const len = last - first + 2.2;
      const nSeg = Math.max(1, Math.round(len / segW));
      const pieceW = len / nSeg;
      const rot = Math.PI - run.dir;
      const tx = Math.cos(run.dir);
      const ty = Math.sin(run.dir);

      for (let i = 0; i < nSeg; i += 1) {
        const t = first - 1.1 + (i + 0.5) * pieceW;
        segMats.push(
          plantMatrix(
            seg.box,
            run.x + tx * t,
            run.y + ty * t,
            0,
            rot,
            (pieceW / segW) * 1.02,
            sy,
            1,
          ),
        );
      }

      if (cap) {
        capMats.push(
          plantMatrix(
            cap.box,
            run.x + tx * (last + 1.4),
            run.y + ty * (last + 1.4),
            0,
            rot,
            1,
            capSy,
            1,
          ),
          plantMatrix(
            cap.box,
            run.x + tx * (first - 1.4),
            run.y + ty * (first - 1.4),
            0,
            rot + Math.PI,
            1,
            capSy,
            1,
          ),
        );
      }
    }

    this.addInstanced("wall", segMats);

    if (cap) {
      this.addInstanced("wall_half_endcap", capMats);
    }
  }

  /** Flicker torch lights + advance the ambient particle clock + drive the
   *  fountain warning rims. No per-frame allocations, no buffer uploads. */
  update(t: number) {
    const reduced = this.reducedMotion?.matches ?? false;
    this.flickerFlames(t, reduced);
    const dt = reduced || this.lastT < 0 ? 0 : Math.min(0.05, Math.max(0, t - this.lastT));
    this.lastT = t;
    this.ambientTime.value += dt;
    this.pulseWarnRims(t, reduced);
  }

  private flickerFlames(t: number, reduced: boolean) {
    for (let i = 0; i < this.flames.length; i += 1) {
      const f = this.flames[i];

      if (!f) {
        continue;
      }

      const base = i < 6 ? 6 : 5;
      f.intensity =
        base *
        (reduced ? 0.82 : 0.82 + Math.sin(t * 9 + i * 2.1) * 0.12 + Math.sin(t * 23 + i) * 0.06);
    }
  }

  private warnLevelFor(i: number, sp: { x: number; y: number }) {
    if (i === this.homeSlot) {
      return 0;
    }

    if (this.hasLocal) {
      const d = Math.hypot(this.localX - sp.x, this.localY - sp.y);

      return 0.4 * Math.max(0, 1 - d / WARN_SEE);
    }

    return 0.25;
  }

  private pulseWarnRims(t: number, reduced: boolean) {
    if (!this.warnRims) {
      return;
    }

    let dirty = false;

    for (let i = 0; i < SPAWNS.length; i += 1) {
      const sp = SPAWNS[i];

      if (!sp) {
        continue;
      }

      const level = this.warnLevelFor(i, sp);
      const v = level * (reduced ? 1 : 0.72 + 0.28 * Math.sin(t * 4 + i * 1.1));

      if (Math.abs(v - (this.warnLevels[i] ?? 0)) < 0.005) {
        continue;
      }

      this.warnLevels[i] = v;
      this.warnRims.setColorAt(i, C_SCRATCH.setRGB(v, v, v));
      dirty = true;
    }

    if (dirty && this.warnRims.instanceColor) {
      this.warnRims.instanceColor.needsUpdate = true;
    }
  }

  /** Feed the local player's sim position (drives the fountain warning rims).
   *  Optional — rims degrade to a fixed glow when never called. */
  setLocalPos(x: number, y: number) {
    this.localX = x;
    this.localY = y;
    this.hasLocal = true;
  }

  /** The local player's spawn slot — that pad's warning rim stays dark. */
  setHomeSlot(slot: number) {
    this.homeSlot = slot;
  }

  private place(name: string, x: number, y: number, targetHeight: number, rotY: number) {
    const obj = this.templateOf(name);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(V_SCL);
    const h = size.y > 0.01 ? size.y : 1;
    const s = targetHeight / h;
    obj.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(obj);
    obj.position.set(x, terrainHeight(x, y) - box2.min.y, y);
    obj.rotation.y = rotY;
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });

    return obj;
  }

  private buildPlatform() {
    const gapHalf = STAIR_HALF + 0.04;

    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x56_5b_68,
      roughness: 0.95,
      side: THREE.DoubleSide,
    });

    this.ownedMats.push(wallMat);

    for (const a of STAIR_ANGLES) {
      const geo = new THREE.CylinderGeometry(
        PLATEAU_R + 0.1,
        PLATEAU_R + 0.1,
        PLATEAU_H,
        26,
        1,
        true,
        a + gapHalf,
        Math.PI / 2 - 2 * gapHalf,
      );

      const arc = new THREE.Mesh(geo, wallMat);
      arc.position.y = PLATEAU_H / 2;
      arc.receiveShadow = true;
      this.ownedGeos.push(geo);
      this.add(arc);
    }

    const st = this.geoOf("stairs_wide");

    if (!st) {
      return;
    }

    const size = st.box.getSize(V_POS);
    const sx = (2 * gapHalf * PLATEAU_R) / Math.max(0.01, size.x);
    const sy = PLATEAU_H / Math.max(0.01, size.y);
    const sz = STAIR_RUN / Math.max(0.01, size.z);
    V_SCL.set(sx, sy, sz);
    const inst = new THREE.InstancedMesh(st.geo, st.mat, STAIR_ANGLES.length);
    inst.castShadow = true;
    inst.receiveShadow = true;

    for (const [i, a] of STAIR_ANGLES.entries()) {
      const rc = PLATEAU_R + STAIR_RUN / 2;
      E_ROT.set(0, Math.atan2(Math.cos(a), Math.sin(a)), 0);
      Q_ROT.setFromEuler(E_ROT);
      V_POS.set(Math.cos(a) * rc, 0, Math.sin(a) * rc);
      inst.setMatrixAt(i, M_OUT.compose(V_POS, Q_ROT, V_SCL));
    }

    inst.instanceMatrix.needsUpdate = true;
    this.add(inst);
  }

  private placeScaled(d: Decor) {
    const tall = d.lie === true ? undefined : TALL_TARGET.get(d.model);

    if (tall !== undefined) {
      const obj = this.place(d.model, d.x, d.y, tall * d.scale, d.rot);
      obj.position.y += d.h ?? 0;

      return obj;
    }

    const obj = this.templateOf(d.model);
    obj.scale.setScalar(d.scale);
    obj.rotation.order = "YXZ";
    obj.rotation.y = d.rot;

    if (d.lie === true) {
      obj.rotation.z = Math.PI / 2;
    }

    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.set(d.x, terrainHeight(d.x, d.y) - box.min.y + (d.h ?? 0), d.y);
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });

    return obj;
  }

  /** Tear down everything this environment added: scene objects removed, owned
   *  geometries/materials disposed (library templates are shared — untouched). */
  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.disposeExtras();

    for (const o of this.added) {
      this.scene.remove(o);

      if (o instanceof THREE.InstancedMesh) {
        o.dispose();
      }
    }

    this.added.length = 0;

    for (const g of this.ownedGeos) {
      g.dispose();
    }

    this.ownedGeos.length = 0;

    for (const m of this.ownedMats) {
      m.dispose();
    }

    this.ownedMats.length = 0;
    this.materials.dispose();
    this.floorMeshes.length = 0;
    this.floorGeos.clear();
    this.flames.length = 0;
    this.embers = null;
    this.motes = null;
    this.goldMotes = null;
    this.warnRims = null;
    this.hasLocal = false;
    this.lastT = -1;
  }

  static get throneCenter() {
    return { r: ARENA.throne.radius, x: BOSS_POS.x, y: BOSS_POS.y };
  }
}
