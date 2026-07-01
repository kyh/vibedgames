// KayKit dungeon dressing for "The Sunken Court". Places real pillars/statues/
// trees at the map obstacles plus torches (with atmosphere lights), the throne
// hoard, themed camp lairs, shrine pads, rim gates, the Breach forest, and rune
// monoliths — driven by the same map data the sim reads.
//
// Draw-call discipline: repeated decor is grouped by model into InstancedMeshes
// (one call per model); only multi-mesh templates (chests, torch_lit) fall back
// to per-prop placement. Ambient particles are dedicated Points layers (one
// call each). Light budget: exactly 7 dynamic PointLights — 6 torch ring + 1
// throne hoard. Nothing else may add one.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  ARENA,
  BOSS_PLATFORM_RADIUS,
  BOSS_POS,
  CAMPS,
  HALF,
  OBSTACLES,
  RUNE_SPOTS,
  SPAWNS,
} from "../data/map";
import { terrainHeight } from "../data/terrain";
import { PLATEAU_H, PLATEAU_R, STAIR_ANGLES } from "../sim/elevation";
import { buildDecor, hash2, type Decor } from "../data/decor";
import type { ModelLibrary } from "./models";
import { teamColor } from "./palette";

/** Fill-rate guard: foliage never casts shadows. */
const NO_SHADOW = new Set(["grass_a", "grass_b", "bush_a", "bush_b"]);

/** Standing-tall models scale-to-height (target × decor scale) so they match
 *  the arena pillars; everything else keeps native size × scale. */
const TALL_TARGET: Record<string, number> = {
  pillar: 3.8,
  column: 3.8,
  wall: 3.8,
  wall_corner: 3.8,
  pillar_decorated: 3.8,
  vampire_throne: 2.6,
  paladin_statue: 2.6,
};

const TAU = Math.PI * 2;
const WARN_R = 7; // enemy-fountain guard radius (mirrors SPAWN_GUARD_RADIUS)
const WARN_SEE = 14; // rim fades in within this range of the local player

function wrapAngle(d: number): number {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

// setup-time scratch (never allocated per placement)
const V_POS = new THREE.Vector3();
const V_SCL = new THREE.Vector3();
const V_ZERO = new THREE.Vector3(0, 0, 0);
const E_ROT = new THREE.Euler(0, 0, 0, "YXZ");
const Q_ROT = new THREE.Quaternion();
const M_SCRATCH = new THREE.Matrix4();
const M_OUT = new THREE.Matrix4();
const BOX_SCRATCH = new THREE.Box3();
const C_SCRATCH = new THREE.Color();

type GeoInfo = { geo: THREE.BufferGeometry; mat: THREE.Material; box: THREE.Box3; meshCount: number };

export class Environment {
  private flames: THREE.PointLight[] = [];
  // ambient particle layers (own Points — never the combat pool)
  private embers: THREE.Points | null = null;
  private emberPos: Float32Array = new Float32Array(0);
  private emberVel: Float32Array = new Float32Array(0);
  private emberLife: Float32Array = new Float32Array(0);
  private motes: THREE.Points | null = null;
  private motePos: Float32Array = new Float32Array(0);
  private moteVel: Float32Array = new Float32Array(0);
  // Breach fireflies (skipped on coarse-pointer devices)
  private fireflies: THREE.Points | null = null;
  private fireflyPos: Float32Array = new Float32Array(0);
  private fireflyVel: Float32Array = new Float32Array(0);
  // throne gold motes (the hoard glitters — objective read from anywhere)
  private goldMotes: THREE.Points | null = null;
  private goldPos: Float32Array = new Float32Array(0);
  // enemy-fountain warning rims (per-pad brightness via instanceColor)
  private warnRims: THREE.InstancedMesh | null = null;
  private warnLevels: Float32Array = new Float32Array(0);
  private localX = 0;
  private localY = 0;
  private hasLocal = false;
  private homeSlot = -1;
  private lastT = -1;
  // teardown bookkeeping: scene objects we added + geometries/materials we own
  // (library-template materials are shared and never disposed here)
  private added: THREE.Object3D[] = [];
  private ownedGeos: THREE.BufferGeometry[] = [];
  private ownedMats: THREE.Material[] = [];

  constructor(
    private scene: THREE.Scene,
    private lib: ModelLibrary,
  ) {}

  setup(): void {
    this.buildFloor();
    this.buildWalls();
    this.buildPlatform();

    // real colliders get real models: statues/trees carry their own model via
    // the map's render hint; bare pillars keep the classic cycle
    OBSTACLES.forEach((o, i) => {
      const name = o.model ?? (i % 3 === 0 ? "pillar_decorated" : i % 3 === 1 ? "column" : "pillar");
      // shrine statues gaze over their pad toward the throne
      const rot = o.model === "paladin_statue" ? Math.atan2(-o.x, -o.y) : i * 0.7;
      this.add(this.place(name, o.x, o.y, o.height, rot));
    });

    // data-driven set-dressing, grouped by model into InstancedMeshes
    this.buildDecorInstanced();

    // torch ring around the throne, with warm atmosphere lights
    const torchN = 6;
    for (let i = 0; i < torchN; i++) {
      const a = (i / torchN) * TAU;
      const r = BOSS_PLATFORM_RADIUS + 1.6;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      this.add(this.place("torch_lit", x, y, 2.0, a));
      const light = new THREE.PointLight(0xff8a2c, 6, 12, 2);
      light.position.set(x, 2.4, y);
      this.add(light);
      this.flames.push(light);
    }
    // the 7th (FINAL) dynamic light: warm gold pool over the throne hoard.
    // The light cap is 7 — nothing below may add another.
    const throneLight = new THREE.PointLight(0xffc861, 5, 16, 2);
    throneLight.position.set(0, 6.2, 0);
    this.add(throneLight);
    this.flames.push(throneLight);

    // a torch + team banner at each base for identity (no extra dynamic light
    // here — 12 point lights is too heavy; the throne ring carries the glow)
    SPAWNS.forEach((sp) => {
      const inward = Math.atan2(-sp.y, -sp.x);
      const ox = Math.cos(inward + Math.PI / 2) * 2.4;
      const oy = Math.sin(inward + Math.PI / 2) * 2.4;
      this.add(this.place("torch_lit", sp.x + ox, sp.y + oy, 2.0, inward));
      const banner = this.place("banner_red", sp.x - ox, sp.y - oy, 3.0, sp.facing);
      const team = new THREE.Color(teamColor(`bot:${sp.slot}`));
      banner.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const src = Array.isArray(o.material) ? o.material[0] : o.material;
        if (!src) return;
        // clone first — banner instances share one material (cloneSkinned)
        const cloned = src.clone();
        if (cloned instanceof THREE.MeshStandardMaterial) cloned.color.lerp(team, 0.7);
        o.material = cloned;
        this.ownedMats.push(cloned);
      });
      this.add(banner);
    });

    this.buildGolemLair();
    this.buildMonolithGlow();
    this.buildLightShafts();
    this.buildWarnRims();
    this.buildAmbient();
  }

  /** Track everything we put in the scene so dispose() can tear it down. */
  private add(o: THREE.Object3D): void {
    this.scene.add(o);
    this.added.push(o);
  }

  /** Pull a single mesh's geometry+material out of a loaded prop for
   *  instancing, plus how many meshes the template really has (multi-mesh
   *  templates — chests with lids, torches with flames — can't instance). */
  private geoOf(name: string): GeoInfo | null {
    const tpl = this.lib.instance(name);
    tpl.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    tpl.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    const mesh = meshes[0];
    if (!mesh) return null;
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrixWorld);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const box = bb ? bb.clone() : new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));
    const rawMat = mesh.material;
    const mat = Array.isArray(rawMat) ? rawMat[0] : rawMat;
    if (!mat) return null;
    this.ownedGeos.push(geo);
    return { geo, mat, box, meshCount: meshes.length };
  }

  /** Per-instance matrix replicating placeScaled's planting math exactly:
   *  tall models scale-to-height, lie topples 90° on Z, base planted at
   *  terrainHeight − rotated-box min.y, plus the optional `h` lift. */
  private decorMatrix(d: Decor, box: THREE.Box3): THREE.Matrix4 {
    const tall = d.lie ? undefined : TALL_TARGET[d.model];
    const bh = Math.max(0.01, box.max.y - box.min.y);
    const s = tall !== undefined ? (tall * d.scale) / bh : d.scale;
    E_ROT.set(0, d.rot, d.lie ? Math.PI / 2 : 0);
    Q_ROT.setFromEuler(E_ROT);
    V_SCL.set(s, s, s);
    M_SCRATCH.compose(V_ZERO, Q_ROT, V_SCL);
    BOX_SCRATCH.copy(box).applyMatrix4(M_SCRATCH);
    const y = terrainHeight(d.x, d.y) - BOX_SCRATCH.min.y + (d.h ?? 0);
    V_POS.set(d.x, y, d.y);
    return M_OUT.compose(V_POS, Q_ROT, V_SCL);
  }

  /** THE draw-call enabler: group buildDecor() by model — single-mesh templates
   *  become one InstancedMesh each; multi-mesh templates fall back to
   *  placeScaled. ~130 placements → ~30 instanced groups + a few fallbacks. */
  private buildDecorInstanced(): void {
    const groups = new Map<string, Decor[]>();
    for (const d of buildDecor()) {
      const g = groups.get(d.model);
      if (g) g.push(d);
      else groups.set(d.model, [d]);
    }
    for (const [model, items] of groups) {
      const info = this.geoOf(model);
      if (!info) continue;
      if (info.meshCount > 1) {
        // chests (lids), decorated kegs, … — few of these; place individually
        for (const d of items) this.add(this.placeScaled(d));
        continue;
      }
      const inst = new THREE.InstancedMesh(info.geo, info.mat, items.length);
      inst.castShadow = !NO_SHADOW.has(model);
      inst.receiveShadow = true;
      items.forEach((d, i) => inst.setMatrixAt(i, this.decorMatrix(d, info.box)));
      inst.instanceMatrix.needsUpdate = true;
      this.add(inst);
    }
  }

  /** The 7th camp is the Frost Golem's lair: a ring of frost-rimed boulders
   *  (blue-tinted material CLONES — lib materials are shared across instances)
   *  around the spawn. No light — the 7-light budget is spent. */
  private buildGolemLair(): void {
    const camp = CAMPS.find((c) => c.id === "golem");
    if (!camp) return;
    const ang = Math.atan2(camp.y, camp.x);
    const frost = new THREE.Color(0x9fd4ff);
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
        model: "rock_b",
        specs: [
          { da: 1.4, r: 2.5, s: 1.5 },
          { da: -0.8, r: 2.6, s: 1.4 },
        ],
      },
    ];
    ring.forEach((group, gi) => {
      const info = this.geoOf(group.model);
      if (!info) return;
      const mat = info.mat.clone();
      if (mat instanceof THREE.MeshStandardMaterial) mat.color.lerp(frost, 0.35);
      this.ownedMats.push(mat);
      const inst = new THREE.InstancedMesh(info.geo, mat, group.specs.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      group.specs.forEach((sp, i) => {
        const x = camp.x + Math.cos(ang + sp.da) * sp.r;
        const y = camp.y + Math.sin(ang + sp.da) * sp.r;
        const d: Decor = { model: group.model, x, y, rot: hash2(gi * 5 + i, 67) * TAU, scale: sp.s };
        inst.setMatrixAt(i, this.decorMatrix(d, info.box));
      });
      inst.instanceMatrix.needsUpdate = true;
      this.add(inst);
    });
  }

  /** Dormant rune glow: one merged ring geometry over the 4 reserved rune
   *  spots (the monolith pillars themselves ride the decor instancing). */
  private buildMonolithGlow(): void {
    const rings: THREE.BufferGeometry[] = [];
    for (const p of RUNE_SPOTS) {
      const g = new THREE.RingGeometry(0.9, 1.2, 24);
      g.rotateX(-Math.PI / 2);
      g.translate(p.x, terrainHeight(p.x, p.y) + 0.05, p.y);
      rings.push(g);
    }
    const merged = mergeGeometries(rings);
    for (const g of rings) g.dispose();
    if (!merged) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ownedGeos.push(merged);
    this.ownedMats.push(mat);
    this.add(new THREE.Mesh(merged, mat));
  }

  /** Moonlight pouring through the collapsed west wall: 3 slanted additive
   *  cones, merged — one draw call, zero light budget. */
  private buildLightShafts(): void {
    const spots: [number, number][] = [
      [-38, 8],
      [-41, -3],
      [-33, -10],
    ];
    // tilt each shaft 12° toward the moon's azimuth (sun sits at (18, 34, 12))
    const azLen = Math.hypot(18, 12);
    const azX = 18 / azLen;
    const azZ = 12 / azLen;
    const tiltAxis = new THREE.Vector3(azZ, 0, -azX);
    Q_ROT.setFromAxisAngle(tiltAxis, (12 * Math.PI) / 180);
    const cones: THREE.BufferGeometry[] = [];
    for (const [x, y] of spots) {
      const g = new THREE.CylinderGeometry(0.6, 2.8, 14, 10, 1, true);
      g.applyQuaternion(Q_ROT);
      g.translate(x, 7, y);
      cones.push(g);
    }
    const merged = mergeGeometries(cones);
    for (const g of cones) g.dispose();
    if (!merged) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x9fc6e0,
      transparent: true,
      opacity: 0.035,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ownedGeos.push(merged);
    this.ownedMats.push(mat);
    this.add(new THREE.Mesh(merged, mat));
  }

  /** Red warning rims at the spawn pads (enemy fountains burn intruders — the
   *  sim damage is silent, so the renderer must say it). One InstancedMesh;
   *  per-pad brightness rides instanceColor (additive: black = invisible).
   *  Brightness follows the local player's distance once setLocalPos is fed;
   *  until then the rims idle at a fixed 0.25. */
  private buildWarnRims(): void {
    const geo = new THREE.RingGeometry(WARN_R - 0.45, WARN_R, 48);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff4030,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const inst = new THREE.InstancedMesh(geo, mat, SPAWNS.length);
    this.warnLevels = new Float32Array(SPAWNS.length);
    SPAWNS.forEach((sp, i) => {
      M_OUT.makeTranslation(sp.x, 0.05, sp.y);
      inst.setMatrixAt(i, M_OUT);
      inst.setColorAt(i, C_SCRATCH.setRGB(0, 0, 0));
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.ownedGeos.push(geo);
    this.ownedMats.push(mat);
    this.warnRims = inst;
    this.add(inst);
  }

  /** Torch embers + dust motes + Breach fireflies + throne gold motes. Each is
   *  a dedicated Points layer, one draw call. Motes/fireflies are skipped on
   *  coarse-pointer (and motes on low-DPR) devices to protect fill rate. */
  private buildAmbient(): void {
    const tex = softDot();
    // ── torch embers ──
    const EN = 110;
    this.emberPos = new Float32Array(EN * 3);
    this.emberVel = new Float32Array(EN * 3);
    this.emberLife = new Float32Array(EN);
    const ecol = new Float32Array(EN * 3);
    for (let i = 0; i < EN; i++) {
      this.seedEmber(i);
      ecol[i * 3] = 1.4; ecol[i * 3 + 1] = 0.55; ecol[i * 3 + 2] = 0.12; // warm HDR (blooms)
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.BufferAttribute(this.emberPos, 3));
    eg.setAttribute("color", new THREE.BufferAttribute(ecol, 3));
    const em = new THREE.PointsMaterial({ size: 0.17, map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true });
    this.embers = new THREE.Points(eg, em);
    this.embers.frustumCulled = false;
    this.ownedGeos.push(eg);
    this.ownedMats.push(em);
    this.add(this.embers);

    // ── throne gold motes (always on — it's the objective's read) ──
    const GN = 40;
    this.goldPos = new Float32Array(GN * 3);
    const gcol = new Float32Array(GN * 3);
    for (let i = 0; i < GN; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * (PLATEAU_R - 0.5);
      this.goldPos[i * 3] = Math.cos(a) * r;
      this.goldPos[i * 3 + 1] = 2.2 + Math.random() * 3.8;
      this.goldPos[i * 3 + 2] = Math.sin(a) * r;
      gcol[i * 3] = 1.5; gcol[i * 3 + 1] = 1.05; gcol[i * 3 + 2] = 0.3; // HDR gold (blooms)
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.BufferAttribute(this.goldPos, 3));
    gg.setAttribute("color", new THREE.BufferAttribute(gcol, 3));
    const gm = new THREE.PointsMaterial({ size: 0.11, map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true });
    this.goldMotes = new THREE.Points(gg, gm);
    this.goldMotes.frustumCulled = false;
    this.ownedGeos.push(gg);
    this.ownedMats.push(gm);
    this.add(this.goldMotes);

    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer:coarse)").matches;

    // ── Breach fireflies (green HDR — blooms through the wall holes) ──
    if (!coarse) {
      const FN = 40;
      this.fireflyPos = new Float32Array(FN * 3);
      this.fireflyVel = new Float32Array(FN * 3);
      const fcol = new Float32Array(FN * 3);
      for (let i = 0; i < FN; i++) {
        this.seedFirefly(i);
        fcol[i * 3] = 0.45; fcol[i * 3 + 1] = 1.25; fcol[i * 3 + 2] = 0.4;
      }
      const fg = new THREE.BufferGeometry();
      fg.setAttribute("position", new THREE.BufferAttribute(this.fireflyPos, 3));
      fg.setAttribute("color", new THREE.BufferAttribute(fcol, 3));
      const fm = new THREE.PointsMaterial({ size: 0.12, map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true });
      this.fireflies = new THREE.Points(fg, fm);
      this.fireflies.frustumCulled = false;
      this.ownedGeos.push(fg);
      this.ownedMats.push(fm);
      this.add(this.fireflies);
    }

    // ── dust motes (god-ray dust) ──
    if (coarse || window.devicePixelRatio < 1.3) return;
    const MN = 180;
    this.motePos = new Float32Array(MN * 3);
    this.moteVel = new Float32Array(MN * 3);
    for (let i = 0; i < MN; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * HALF;
      this.motePos[i * 3] = Math.cos(a) * r;
      this.motePos[i * 3 + 1] = 0.5 + Math.random() * 5.5;
      this.motePos[i * 3 + 2] = Math.sin(a) * r;
      this.moteVel[i * 3] = (Math.random() - 0.5) * 0.3;
      this.moteVel[i * 3 + 1] = 0.1 + Math.random() * 0.2;
      this.moteVel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(this.motePos, 3));
    const mm = new THREE.PointsMaterial({ size: 0.07, map: tex, color: 0x9fc6e0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
    this.motes = new THREE.Points(mg, mm);
    this.motes.frustumCulled = false;
    this.ownedGeos.push(mg);
    this.ownedMats.push(mm);
    this.add(this.motes);
  }

  private seedEmber(i: number): void {
    // embers rise off the 6 torch flames only (flames[6] is the high throne light)
    const n = Math.min(6, this.flames.length);
    const f = n > 0 ? this.flames[i % n] : undefined;
    const p = f ? f.position : { x: 0, y: 2, z: 0 };
    this.emberPos[i * 3] = p.x + (Math.random() - 0.5) * 0.5;
    this.emberPos[i * 3 + 1] = p.y - 0.3 + Math.random() * 0.4;
    this.emberPos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.5;
    this.emberVel[i * 3] = (Math.random() - 0.5) * 0.4;
    this.emberVel[i * 3 + 1] = 0.7 + Math.random() * 0.8;
    this.emberVel[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    this.emberLife[i] = 0.8 + Math.random() * 1.4;
  }

  private seedFirefly(i: number): void {
    const a = Math.PI + (Math.random() - 0.5) * 0.68; // the Breach sector
    const r = 30 + Math.random() * 16;
    this.fireflyPos[i * 3] = Math.cos(a) * r;
    this.fireflyPos[i * 3 + 1] = 0.4 + Math.random() * 2.2;
    this.fireflyPos[i * 3 + 2] = Math.sin(a) * r;
    this.fireflyVel[i * 3] = (Math.random() - 0.5) * 0.5;
    this.fireflyVel[i * 3 + 1] = (Math.random() - 0.5) * 0.2;
    this.fireflyVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
  }

  /** Three-band tiled floor: flagstone plaza, worn-rock mid-ring patches, dirt
   *  under the camps and across the Breach — with hash-seeded 0/90/180/270
   *  tile rotations. Three InstancedMeshes, three draw calls. */
  private buildFloor(): void {
    const flag = this.geoOf("floor_tile_large");
    const worn = this.geoOf("floor_tile_large_rocks");
    const dirt = this.geoOf("floor_dirt_large");
    if (!flag) return;
    for (const info of [flag, worn, dirt]) {
      if (!info) continue;
      const c = info.box.getCenter(V_POS);
      info.geo.translate(-c.x, 0, -c.z); // center each tile on its origin
    }
    const tile = 4;
    const R = HALF; // out to the wall ring
    type Cell = [number, number, number, number]; // x, z, y, rotY
    const cells: Record<"flag" | "worn" | "dirt", Cell[]> = { flag: [], worn: [], dirt: [] };
    for (let gx = -R; gx <= R; gx += tile) {
      for (let gz = -R; gz <= R; gz += tile) {
        const r2 = gx * gx + gz * gz;
        if (r2 > (R + 1) * (R + 1)) continue;
        const r = Math.sqrt(r2);
        const ang = Math.atan2(gz, gx);
        const h = hash2(gx / 4, gz / 4);
        const rot = Math.floor(hash2(gz / 4, gx / 4) * 4) * (Math.PI / 2);
        // platform top stays pristine flagstone (the vertical wall hides the step)
        if (r2 < PLATEAU_R * PLATEAU_R) {
          cells.flag.push([gx, gz, PLATEAU_H, rot]);
          continue;
        }
        let nearCamp = false;
        for (const c of CAMPS) {
          const dx = gx - c.x;
          const dz = gz - c.y;
          if (dx * dx + dz * dz <= 25) {
            nearCamp = true;
            break;
          }
        }
        const west = Math.abs(wrapAngle(ang - Math.PI));
        const isDirt = nearCamp || (west < 0.35 && r > 26) || (west < 0.5 && r > 30 && h < 0.5);
        if (isDirt && dirt) cells.dirt.push([gx, gz, 0, rot]);
        else if (r > 14 && r < 34 && h < 0.18 && worn) cells.worn.push([gx, gz, 0, rot]);
        else cells.flag.push([gx, gz, 0, rot]);
      }
    }
    const bands: [GeoInfo | null, Cell[]][] = [
      [flag, cells.flag],
      [worn, cells.worn],
      [dirt, cells.dirt],
    ];
    for (const [info, list] of bands) {
      if (!info || list.length === 0) continue;
      const inst = new THREE.InstancedMesh(info.geo, info.mat, list.length);
      inst.receiveShadow = true;
      list.forEach(([x, z, y, rot], i) => {
        E_ROT.set(0, rot, 0);
        Q_ROT.setFromEuler(E_ROT);
        V_POS.set(x, y, z);
        V_SCL.set(1, 1, 1);
        inst.setMatrixAt(i, M_OUT.compose(V_POS, Q_ROT, V_SCL));
      });
      inst.instanceMatrix.needsUpdate = true;
      this.add(inst);
    }
  }

  /** Rim ring: dungeon walls with a personal gate behind each base (wall_gated
   *  + flanking wall_pillars) and the collapsed Breach span in the west —
   *  wall_broken segments with two ragged holes showing the forest vista. */
  private buildWalls(): void {
    const w = this.geoOf("wall");
    if (!w) return;
    const broken = this.geoOf("wall_broken");
    const gated = this.geoOf("wall_gated");
    const pillar = this.geoOf("wall_pillar");
    for (const info of [w, broken, gated, pillar]) {
      if (!info) continue;
      const c = info.box.getCenter(V_POS);
      info.geo.translate(-c.x, 0, 0); // center the 4-wide span; keep base at y=0
    }
    const segW = 4;
    const R = HALF + 2.4;
    const N = Math.ceil((TAU * R) / segW);
    const step = TAU / N;
    const nearestSeg = (target: number): number => (((Math.round(target / step) % N) + N) % N);
    const skip = new Set<number>();
    const baseAngles = SPAWNS.map((sp) => Math.atan2(sp.y, sp.x));
    for (const a of baseAngles) skip.add(nearestSeg(a)); // gate opening per base
    skip.add(nearestSeg((173 * Math.PI) / 180)); // two ragged Breach holes
    skip.add(nearestSeg((189 * Math.PI) / 180));
    const wallIdx: number[] = [];
    const brokenIdx: number[] = [];
    for (let i = 0; i < N; i++) {
      if (skip.has(i)) continue;
      const a = i * step;
      if (broken && Math.abs(wrapAngle(a - Math.PI)) <= 0.35) brokenIdx.push(i);
      else wallIdx.push(i);
    }
    const up = new THREE.Vector3(0, 1, 0);
    const placeRing = (info: GeoInfo, angles: number[], scl: THREE.Vector3): void => {
      const inst = new THREE.InstancedMesh(info.geo, info.mat, angles.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      angles.forEach((a, i) => {
        V_POS.set(Math.cos(a) * R, 0, Math.sin(a) * R);
        Q_ROT.setFromAxisAngle(up, Math.PI / 2 - a);
        inst.setMatrixAt(i, M_OUT.compose(V_POS, Q_ROT, scl));
      });
      inst.instanceMatrix.needsUpdate = true;
      this.add(inst);
    };
    V_SCL.set(1.02, 1.2, 1);
    placeRing(w, wallIdx.map((i) => i * step), V_SCL);
    if (broken && brokenIdx.length > 0) placeRing(broken, brokenIdx.map((i) => i * step), V_SCL);
    if (gated) placeRing(gated, baseAngles, V_SCL);
    if (pillar) {
      const flanks: number[] = [];
      for (const a of baseAngles) flanks.push(a - 2.6 / R, a + 2.6 / R);
      placeRing(pillar, flanks, V_SCL);
    }
  }

  /** Flicker torch lights + advance the ambient particle layers + drive the
   *  fountain warning rims. No per-frame allocations. */
  update(t: number): void {
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i];
      if (!f) continue;
      const base = i < 6 ? 6 : 5; // index 6 = throne light (slow warm flicker)
      f.intensity = base * (0.82 + Math.sin(t * 9 + i * 2.1) * 0.12 + Math.sin(t * 23 + i) * 0.06);
    }
    const dt = this.lastT < 0 ? 0 : Math.min(0.05, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (this.embers) {
      const ep = this.emberPos;
      const ev = this.emberVel;
      const el = this.emberLife;
      for (let i = 0; i < el.length; i++) {
        if ((el[i] ?? 0) - dt <= 0) {
          this.seedEmber(i);
          continue;
        }
        el[i] = (el[i] ?? 0) - dt;
        const o = i * 3;
        ev[o + 1] = (ev[o + 1] ?? 0) + dt * 0.3; // gentle updraft
        ep[o] = (ep[o] ?? 0) + (ev[o] ?? 0) * dt;
        ep[o + 1] = (ep[o + 1] ?? 0) + (ev[o + 1] ?? 0) * dt;
        ep[o + 2] = (ep[o + 2] ?? 0) + (ev[o + 2] ?? 0) * dt;
      }
      this.embers.geometry.getAttribute("position").needsUpdate = true;
    }
    if (this.motes) {
      const mp = this.motePos;
      const mv = this.moteVel;
      for (let i = 0; i < mv.length / 3; i++) {
        const o = i * 3;
        mp[o] = (mp[o] ?? 0) + (mv[o] ?? 0) * dt;
        mp[o + 1] = (mp[o + 1] ?? 0) + (mv[o + 1] ?? 0) * dt;
        mp[o + 2] = (mp[o + 2] ?? 0) + (mv[o + 2] ?? 0) * dt;
        if ((mp[o + 1] ?? 0) > 6) mp[o + 1] = 0.5; // wrap up→down
      }
      this.motes.geometry.getAttribute("position").needsUpdate = true;
    }
    if (this.fireflies) {
      const fp = this.fireflyPos;
      const fv = this.fireflyVel;
      for (let i = 0; i < fv.length / 3; i++) {
        const o = i * 3;
        const x = (fp[o] ?? 0) + ((fv[o] ?? 0) + Math.sin(t * 0.9 + i * 2.1) * 0.18) * dt;
        const y = (fp[o + 1] ?? 0) + ((fv[o + 1] ?? 0) + Math.sin(t * 1.3 + i) * 0.06) * dt;
        const z = (fp[o + 2] ?? 0) + ((fv[o + 2] ?? 0) + Math.cos(t * 0.7 + i * 1.3) * 0.18) * dt;
        const r = Math.hypot(x, z);
        if (r < 29.5 || r > 46.5 || y < 0.3 || y > 2.7 || Math.abs(wrapAngle(Math.atan2(z, x) - Math.PI)) > 0.37) {
          this.seedFirefly(i); // drifted out of the Breach — respawn inside
          continue;
        }
        fp[o] = x;
        fp[o + 1] = y;
        fp[o + 2] = z;
      }
      this.fireflies.geometry.getAttribute("position").needsUpdate = true;
    }
    if (this.goldMotes) {
      const gp = this.goldPos;
      for (let i = 0; i < gp.length / 3; i++) {
        const o = i * 3;
        const y = (gp[o + 1] ?? 0) + 0.5 * dt; // hoard glitter drifts upward
        gp[o + 1] = y > 6.2 ? 2.2 : y;
      }
      this.goldMotes.geometry.getAttribute("position").needsUpdate = true;
    }
    if (this.warnRims) {
      let dirty = false;
      for (let i = 0; i < SPAWNS.length; i++) {
        const sp = SPAWNS[i];
        if (!sp) continue;
        let level = 0.25; // graceful default until setLocalPos is wired (Wave 3)
        if (i === this.homeSlot) level = 0; // your own fountain is not a threat
        else if (this.hasLocal) {
          const d = Math.hypot(this.localX - sp.x, this.localY - sp.y);
          level = 0.4 * Math.max(0, 1 - d / WARN_SEE);
        }
        const v = level * (0.72 + 0.28 * Math.sin(t * 4 + i * 1.1));
        if (Math.abs(v - (this.warnLevels[i] ?? 0)) < 0.005) continue;
        this.warnLevels[i] = v;
        this.warnRims.setColorAt(i, C_SCRATCH.setRGB(v, v, v));
        dirty = true;
      }
      if (dirty && this.warnRims.instanceColor) this.warnRims.instanceColor.needsUpdate = true;
    }
  }

  /** Feed the local player's sim position (drives the fountain warning rims).
   *  Optional — rims degrade to a fixed glow when never called. */
  setLocalPos(x: number, y: number): void {
    this.localX = x;
    this.localY = y;
    this.hasLocal = true;
  }

  /** The local player's spawn slot — that pad's warning rim stays dark. */
  setHomeSlot(slot: number): void {
    this.homeSlot = slot;
  }

  /** Instance a model, scale it to a target height, plant its base at y=0. */
  private place(name: string, x: number, y: number, targetHeight: number, rotY: number): THREE.Object3D {
    const obj = this.lib.instance(name);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(V_SCL);
    const h = size.y > 0.01 ? size.y : 1;
    const s = targetHeight / h;
    obj.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(obj);
    obj.position.set(x, terrainHeight(x, y) - box2.min.y, y); // plant on the terrain
    obj.rotation.y = rotY;
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    return obj;
  }

  /** The throne platform: a stone cliff face in 4 arc segments with GAPS where
   *  grand stairways climb up. Built to exact dimensions so the stairs really
   *  bridge the plaza→platform height. */
  private buildPlatform(): void {
    const gapHalf = 0.22; // visual gap half-width — a touch wider than the walkable gap
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x565b68, roughness: 0.95, side: THREE.DoubleSide });
    this.ownedMats.push(wallMat);
    // the platform's vertical stone wall in 4 arcs, a gap at each stair angle.
    // (cylinder theta aligns with the world angle x=cosθ,z=sinθ → gaps land on
    // the stairs.) A slight overhang top radius so the top tiles' edge is hidden.
    for (const a of STAIR_ANGLES) {
      const geo = new THREE.CylinderGeometry(PLATEAU_R + 0.1, PLATEAU_R + 0.1, PLATEAU_H, 26, 1, true, a + gapHalf, Math.PI / 2 - 2 * gapHalf);
      const arc = new THREE.Mesh(geo, wallMat);
      arc.position.y = PLATEAU_H / 2;
      arc.receiveShadow = true;
      this.ownedGeos.push(geo);
      this.add(arc);
    }
    // grand ceremonial stairways (stairs_wide, 7u wide natively) filling the
    // gaps, scale-fit: rise exactly PLATEAU_H, span the 4.84u visual gap.
    // One InstancedMesh for all four.
    const st = this.geoOf("stairs_wide");
    if (!st) return;
    const size = st.box.getSize(V_POS);
    const sx = (2 * gapHalf * PLATEAU_R) / Math.max(0.01, size.x);
    const sy = PLATEAU_H / Math.max(0.01, size.y);
    V_SCL.set(sx, sy, 0.6);
    const inst = new THREE.InstancedMesh(st.geo, st.mat, STAIR_ANGLES.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    STAIR_ANGLES.forEach((a, i) => {
      const rc = PLATEAU_R + 0.5;
      // face the throne: rotY = atan2(dirX, dirY) toward the center. (The old
      // per-stair `a + π` only matched this at a = π/4 — two of the four
      // stairs were rotated 180°.)
      E_ROT.set(0, Math.atan2(-Math.cos(a), -Math.sin(a)), 0);
      Q_ROT.setFromEuler(E_ROT);
      V_POS.set(Math.cos(a) * rc, 0, Math.sin(a) * rc);
      inst.setMatrixAt(i, M_OUT.compose(V_POS, Q_ROT, V_SCL));
    });
    inst.instanceMatrix.needsUpdate = true;
    this.add(inst);
  }

  /** Place a decor prop (fallback path for multi-mesh templates): tall
   *  standing pieces scale-to-height; low/toppled pieces keep native size ×
   *  scale. Both sit on the terrain, plus the optional `h` lift. */
  private placeScaled(d: Decor): THREE.Object3D {
    const tall = d.lie ? undefined : TALL_TARGET[d.model];
    if (tall !== undefined) {
      const obj = this.place(d.model, d.x, d.y, tall * d.scale, d.rot);
      obj.position.y += d.h ?? 0;
      return obj;
    }

    const obj = this.lib.instance(d.model);
    obj.scale.setScalar(d.scale);
    obj.rotation.order = "YXZ";
    obj.rotation.y = d.rot;
    if (d.lie) obj.rotation.z = Math.PI / 2; // toppled debris
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.set(d.x, terrainHeight(d.x, d.y) - box.min.y + (d.h ?? 0), d.y);
    obj.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.castShadow = !NO_SHADOW.has(d.model);
        c.receiveShadow = true;
      }
    });
    return obj;
  }

  /** Tear down everything this environment added: scene objects removed, owned
   *  geometries/materials disposed (library templates are shared — untouched). */
  dispose(): void {
    for (const o of this.added) this.scene.remove(o);
    this.added.length = 0;
    for (const g of this.ownedGeos) g.dispose();
    this.ownedGeos.length = 0;
    for (const m of this.ownedMats) m.dispose();
    this.ownedMats.length = 0;
    this.flames.length = 0;
    this.embers = null;
    this.motes = null;
    this.fireflies = null;
    this.goldMotes = null;
    this.warnRims = null;
    this.hasLocal = false;
    this.lastT = -1;
  }

  // expose for callers that want the dais center
  static get throneCenter(): { x: number; y: number; r: number } {
    return { x: BOSS_POS.x, y: BOSS_POS.y, r: ARENA.throne.radius };
  }
}

/** A soft radial-falloff dot texture for round additive particles (shared). */
let dotTex: THREE.Texture | null = null;
function softDot(): THREE.Texture {
  if (dotTex) return dotTex;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
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
}
