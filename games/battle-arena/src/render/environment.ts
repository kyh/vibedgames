// KayKit dungeon dressing. Places real pillars/columns at the map obstacles plus
// torches (with atmosphere lights), crates/barrels, and base banners — driven by
// the same map data the sim reads. Decoration over the primitive ground (we don't
// tile thousands of floor pieces — that would blow the draw-call budget).
import * as THREE from "three";
import {
  ARENA,
  BOSS_PLATFORM_RADIUS,
  BOSS_POS,
  HALF,
  OBSTACLES,
  SPAWNS,
} from "../data/map";
import { PLATEAU_SKIRT, terrainHeight } from "../data/terrain";
import { PLATEAU_H, PLATEAU_R, STAIR_ANGLES } from "../sim/elevation";
import { buildDecor, type Decor } from "../data/decor";
import type { ModelLibrary } from "./models";
import { teamColor } from "./palette";

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
  private lastT = -1;

  constructor(
    private scene: THREE.Scene,
    private lib: ModelLibrary,
  ) {}

  setup(): void {
    this.buildFloor();
    this.buildWalls();
    this.buildPlatform();

    // cover pillars on the map obstacles (the real colliders)
    OBSTACLES.forEach((o, i) => {
      const name = i % 3 === 0 ? "pillar_decorated" : i % 3 === 1 ? "column" : "pillar";
      this.scene.add(this.place(name, o.x, o.y, o.height, i * 0.7));
    });

    // data-driven set-dressing: ruined colonnade, camp stashes, base outposts,
    // rim debris — makes the arena read as a real place (render-only)
    for (const d of buildDecor()) this.scene.add(this.placeScaled(d));

    // torch ring around the throne, with warm atmosphere lights
    const torchN = 6;
    for (let i = 0; i < torchN; i++) {
      const a = (i / torchN) * Math.PI * 2;
      const r = BOSS_PLATFORM_RADIUS + 1.6;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      this.scene.add(this.place("torch_lit", x, y, 2.0, a));
      const light = new THREE.PointLight(0xff8a2c, 6, 12, 2);
      light.position.set(x, 2.4, y);
      this.scene.add(light);
      this.flames.push(light);
    }

    // a torch + team banner at each base for identity (no extra dynamic light
    // here — 12 point lights is too heavy; the throne ring carries the glow)
    SPAWNS.forEach((sp) => {
      const inward = Math.atan2(-sp.y, -sp.x);
      const ox = Math.cos(inward + Math.PI / 2) * 2.4;
      const oy = Math.sin(inward + Math.PI / 2) * 2.4;
      this.scene.add(this.place("torch_lit", sp.x + ox, sp.y + oy, 2.0, inward));
      const banner = this.place("banner_red", sp.x - ox, sp.y - oy, 3.0, sp.facing);
      const team = new THREE.Color(teamColor(`bot:${sp.slot}`));
      banner.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (!mm.isMesh) return;
        // clone first — banner instances share one material (cloneSkinned)
        const cloned = (Array.isArray(mm.material) ? mm.material[0]! : mm.material).clone() as THREE.MeshStandardMaterial;
        cloned.color.lerp(team, 0.7); // banner matches the base pad / occupant hue
        mm.material = cloned;
      });
      this.scene.add(banner);
    });

    this.buildAmbient();
  }

  /** Torch embers (rise off the throne torches) + slow dust motes catching the
   *  light. Dedicated Points layers, one draw call each. Motes skipped on
   *  coarse-pointer / low-DPR devices to protect fill rate. */
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
    this.embers = new THREE.Points(eg, new THREE.PointsMaterial({ size: 0.17, map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, vertexColors: true }));
    this.embers.frustumCulled = false;
    this.scene.add(this.embers);

    // ── dust motes (god-ray dust) ──
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer:coarse)").matches;
    if (coarse || window.devicePixelRatio < 1.3) return;
    const MN = 180;
    this.motePos = new Float32Array(MN * 3);
    this.moteVel = new Float32Array(MN * 3);
    for (let i = 0; i < MN; i++) {
      const a = Math.random() * Math.PI * 2;
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
    this.motes = new THREE.Points(mg, new THREE.PointsMaterial({ size: 0.07, map: tex, color: 0x9fc6e0, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);
  }

  private seedEmber(i: number): void {
    const f = this.flames[i % Math.max(1, this.flames.length)];
    const p = f ? f.position : { x: 0, y: 2, z: 0 };
    this.emberPos[i * 3] = p.x + (Math.random() - 0.5) * 0.5;
    this.emberPos[i * 3 + 1] = p.y - 0.3 + Math.random() * 0.4;
    this.emberPos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.5;
    this.emberVel[i * 3] = (Math.random() - 0.5) * 0.4;
    this.emberVel[i * 3 + 1] = 0.7 + Math.random() * 0.8;
    this.emberVel[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    this.emberLife[i] = 0.8 + Math.random() * 1.4;
  }

  /** Pull a single mesh's geometry+material out of a loaded prop for instancing. */
  private geoOf(name: string): { geo: THREE.BufferGeometry; mat: THREE.Material; box: THREE.Box3 } | null {
    const tpl = this.lib.instance(name);
    tpl.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    tpl.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) meshes.push(m);
    });
    const mesh = meshes[0];
    if (!mesh) return null;
    const geo = (mesh.geometry as THREE.BufferGeometry).clone();
    geo.applyMatrix4(mesh.matrixWorld);
    geo.computeBoundingBox();
    const mat = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
    return { geo, mat, box: geo.boundingBox!.clone() };
  }

  /** Tiled dungeon floor over the circular arena — one InstancedMesh, one draw call. */
  private buildFloor(): void {
    const f = this.geoOf("floor_tile_large");
    if (!f) return;
    const c = f.box.getCenter(new THREE.Vector3());
    f.geo.translate(-c.x, 0, -c.z); // center each tile on its origin
    const tile = 4;
    const R = HALF; // out to the wall ring
    // tile the WHOLE floor: the raised platform top (at PLATEAU_H) and the flat
    // plaza (at 0). Each tile is flat; the platform's vertical wall (below) hides
    // the step between the two levels, so there are no dark gaps.
    const cells: [number, number, number][] = []; // x, z, y
    for (let gx = -R; gx <= R; gx += tile) {
      for (let gz = -R; gz <= R; gz += tile) {
        const r2 = gx * gx + gz * gz;
        if (r2 > (R + 1) * (R + 1)) continue;
        const y = r2 < PLATEAU_R * PLATEAU_R ? PLATEAU_H : 0; // platform top vs plaza
        cells.push([gx, gz, y]);
      }
    }
    const inst = new THREE.InstancedMesh(f.geo, f.mat, cells.length);
    inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    cells.forEach(([x, z, y], i) => {
      m.makeTranslation(x, y, z);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    this.scene.add(inst);
  }

  /** Ring of dungeon walls around the rim — one InstancedMesh. */
  private buildWalls(): void {
    const w = this.geoOf("wall");
    if (!w) return;
    const c = w.box.getCenter(new THREE.Vector3());
    w.geo.translate(-c.x, 0, 0); // center the 4-wide span; keep base at y=0
    const segW = 4;
    const R = HALF + 2.4;
    const N = Math.ceil((2 * Math.PI * R) / segW);
    const inst = new THREE.InstancedMesh(w.geo, w.mat, N);
    inst.castShadow = true;
    inst.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1.02, 1.2, 1);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pos.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      q.setFromAxisAngle(up, Math.PI / 2 - a);
      m.compose(pos, q, scl);
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.scene.add(inst);
  }

  /** Flicker torch lights + advance the ambient particle layers. */
  update(t: number): void {
    for (let i = 0; i < this.flames.length; i++) {
      const base = i < 6 ? 6 : 4;
      this.flames[i]!.intensity = base * (0.82 + Math.sin(t * 9 + i * 2.1) * 0.12 + Math.sin(t * 23 + i) * 0.06);
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
      (this.embers.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
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
      (this.motes.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Instance a model, scale it to a target height, plant its base at y=0. */
  private place(name: string, x: number, y: number, targetHeight: number, rotY: number): THREE.Object3D {
    const obj = this.lib.instance(name);
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const h = size.y > 0.01 ? size.y : 1;
    const s = targetHeight / h;
    obj.scale.setScalar(s);
    const box2 = new THREE.Box3().setFromObject(obj);
    obj.position.set(x, terrainHeight(x, y) - box2.min.y, y); // plant on the terrain
    obj.rotation.y = rotY;
    obj.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return obj;
  }

  /** The throne platform: a stone cliff face in 4 arc segments with GAPS where
   *  wide stairs climb up. Built to exact dimensions so the stairs really bridge
   *  the plaza→platform height (native stair height is 5.1). */
  private buildPlatform(): void {
    const gapHalf = 0.22; // visual gap half-width — a touch wider than the walkable gap
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x565b68, roughness: 0.95, side: THREE.DoubleSide });
    // the platform's vertical stone wall in 4 arcs, a gap at each stair angle.
    // (cylinder theta aligns with the world angle x=cosθ,z=sinθ → gaps land on
    // the stairs.) A slight overhang top radius so the top tiles' edge is hidden.
    for (const a of STAIR_ANGLES) {
      const arc = new THREE.Mesh(
        new THREE.CylinderGeometry(PLATEAU_R + 0.1, PLATEAU_R + 0.1, PLATEAU_H, 26, 1, true, a + gapHalf, Math.PI / 2 - 2 * gapHalf),
        wallMat,
      );
      arc.position.y = PLATEAU_H / 2;
      arc.receiveShadow = true;
      this.scene.add(arc);
    }
    // wide staircases filling the gaps, rising exactly the platform height
    for (const a of STAIR_ANGLES) {
      const st = this.lib.instance("stairs");
      st.scale.set(0.85, PLATEAU_H / 5.1, 0.55); // broad ramp that fills the gap + rises 2u
      st.rotation.y = a + Math.PI; // climb inward toward the throne
      const rc = PLATEAU_R + 0.5;
      st.position.set(Math.cos(a) * rc, 0, Math.sin(a) * rc);
      st.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          m.receiveShadow = true;
        }
      });
      this.scene.add(st);
    }
  }

  /** Place a decor prop: tall standing pieces scale-to-height (so they match
   *  the arena pillars); low/toppled pieces keep native size × scale. Both sit
   *  on the terrain. */
  private placeScaled(d: Decor): THREE.Object3D {
    const standingTall = !d.lie && (d.model === "pillar" || d.model === "column" || d.model === "wall" || d.model === "wall_corner" || d.model === "pillar_decorated");
    if (standingTall) return this.place(d.model, d.x, d.y, 3.8 * d.scale, d.rot);

    const obj = this.lib.instance(d.model);
    obj.scale.setScalar(d.scale);
    obj.rotation.order = "YXZ";
    obj.rotation.y = d.rot;
    if (d.lie) obj.rotation.z = Math.PI / 2; // toppled debris
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.set(d.x, terrainHeight(d.x, d.y) - box.min.y, d.y);
    obj.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    return obj;
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
