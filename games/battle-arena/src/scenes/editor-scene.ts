// In-browser map editor (?editor=1). Renders the arena shell (Environment
// without its decor/obstacle placement) and every prop of the working set as
// an individual pickable object. Edits write a debounced draft to
// localStorage["ba-map"] (the ?auto=1 test loop) and SAVE downloads
// battle-arena-map.json — commit it as public/maps/default.json to make a
// custom map canonical. Loaded via dynamic import so gameplay never pays for
// this chunk. The editor owns its input (no Controls/TouchControls) and drives
// the camera directly: fixed-pitch top-down orbit, RMB/MMB-or-WASD pan, wheel
// zoom.
import * as THREE from "three";
import { buildDefaultObstacles, clampToArena, HEX_R } from "../data/map";
import { buildProceduralDecor } from "../data/decor";
import { terrainHeight } from "../data/terrain";
import { Environment, TALL_TARGET } from "../render/environment";
import type { ModelLibrary } from "../render/models";
import type { View } from "../render/view";
import {
  MAP_STORAGE_KEY,
  parseMapData,
  PLACEABLE_MODELS,
  serializeMapData,
  type MapCollider,
  type MapData,
  type MapProp,
} from "../data/map-format";

const WALL_RUN = "wall_run"; // collider-only wall stub (no prop model)
const PITCH = (55 * Math.PI) / 180; // camera elevation above horizontal
const MIN_H = 15;
const MAX_H = 90; // camera height clamp (wheel zoom)
const POS_MARGIN = -3; // hex clamp apron (matches map-format's parser)

/** One editable placement: a prop (model name), a wall stub (WALL_RUN), or a
 *  pure collider (model ""). Collidable items carry the MapCollider fields. */
export type EdItem = {
  model: string;
  x: number;
  y: number;
  rot: number;
  scale: number;
  lie: boolean;
  h: number;
  collidable: boolean;
  radius: number;
  height: number;
  obj: THREE.Object3D;
  colliderMesh: THREE.Mesh | null;
  ringR: number; // selection-ring footprint radius (from the placed bbox)
};

type ItemSpec = Omit<EdItem, "obj" | "colliderMesh" | "ringR">;

const BOX = new THREE.Box3();
const snapHalf = (v: number): number => Math.round(v * 2) / 2;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class EditorScene {
  readonly items: EdItem[] = [];
  private byObj = new Map<THREE.Object3D, EdItem>();
  private selected: EdItem | null = null;
  private env: Environment | null = null;
  private scene: THREE.Scene;

  // camera
  private target = new THREE.Vector3(0, 0, 0);
  private camH = 55;
  private keys = new Set<string>();

  // picking / dragging
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private groundHit = new THREE.Vector3();
  private dragging = false;
  private dragOffX = 0;
  private dragOffZ = 0;
  private panning = false;
  private panX = 0;
  private panY = 0;

  // shared editor-only resources
  private cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20);
  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private colMat = new THREE.MeshBasicMaterial({ color: 0xff4433, transparent: true, opacity: 0.28, depthWrite: false });
  private pureMat = new THREE.MeshBasicMaterial({ color: 0xff4433, transparent: true, opacity: 0.45, depthWrite: false });
  private stubMat = new THREE.MeshStandardMaterial({ color: 0x8a8578, roughness: 0.9 });
  private selRing: THREE.Mesh;
  private heights = new Map<string, number>(); // native template heights

  // persistence
  private dirty = false;
  private saveTimer: number | undefined;
  private t = 0;

  // UI refs
  private ui: HTMLDivElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inspector: HTMLElement | null = null;
  private inputs = new Map<string, HTMLInputElement>();

  constructor(
    private view: View,
    private lib: ModelLibrary,
  ) {
    this.scene = view.scene;
    // the gameplay fog reads as murk from the editor's high vantage — thin it
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = 0.004;
    const ringGeo = new THREE.RingGeometry(0.9, 1, 40);
    ringGeo.rotateX(-Math.PI / 2);
    this.selRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.selRing.visible = false;
    this.scene.add(this.selRing);
  }

  /** Build the shell, resolve the working set (draft → bundled → procedural),
   *  place the items, and mount the UI. */
  async init(): Promise<void> {
    this.env = new Environment(this.scene, this.lib, { decor: false, obstacles: false });
    this.env.setup();
    this.setWorkingSet(await this.loadInitial());
    this.buildUI();
    this.bindInput();
    this.view.refreshShadows();
  }

  // ── working set ────────────────────────────────────────────────────────────

  private async loadInitial(): Promise<MapData> {
    const raw = localStorage.getItem(MAP_STORAGE_KEY);
    if (raw !== null) {
      try {
        const parsed = parseMapData(JSON.parse(raw));
        if (parsed) return parsed;
      } catch {
        /* corrupt draft — fall through */
      }
    }
    try {
      const res = await fetch("./maps/default.json");
      if (res.ok) {
        const parsed = parseMapData(await res.json());
        if (parsed) return parsed;
      }
    } catch {
      /* no bundled map */
    }
    return this.proceduralMapData();
  }

  /** Today's map as MapData: the procedural decor plus the default OBSTACLES
   *  materialized as collidable props (the pillar cycle / statues become
   *  explicit models so the editor — and saved maps — need no index magic). */
  private proceduralMapData(): MapData {
    const props: MapProp[] = buildProceduralDecor().map((d) => {
      const p: MapProp = { model: d.model, x: d.x, y: d.y, rot: d.rot, scale: d.scale };
      if (d.lie) p.lie = true;
      if (d.h !== undefined && d.h !== 0) p.h = d.h;
      return p;
    });
    const colliders: MapCollider[] = [];
    buildDefaultObstacles().forEach((o, i) => {
      if (o.model === WALL_RUN) {
        colliders.push({ x: o.x, y: o.y, radius: o.radius, height: o.height, model: WALL_RUN });
        return;
      }
      const model = o.model ?? (i % 3 === 0 ? "pillar_decorated" : i % 3 === 1 ? "column" : "pillar");
      const tall = TALL_TARGET[model] ?? o.height;
      props.push({
        model,
        x: o.x,
        y: o.y,
        rot: model === "paladin_statue" ? Math.atan2(-o.x, -o.y) : i * 0.7,
        scale: o.height / tall,
      });
      colliders.push({ x: o.x, y: o.y, radius: o.radius, height: o.height });
    });
    return { version: 1, props, colliders };
  }

  private clearItems(): void {
    for (const it of this.items) {
      this.scene.remove(it.obj);
      if (it.colliderMesh) this.scene.remove(it.colliderMesh);
    }
    this.items.length = 0;
    this.byObj.clear();
    this.selected = null;
  }

  /** Replace the working set from MapData. Modelless colliders pair with the
   *  prop at the same spot (a collidable prop saves as prop + bare collider);
   *  unpaired ones become standalone red-cylinder items. */
  private setWorkingSet(data: MapData): void {
    this.clearItems();
    const propItems: EdItem[] = data.props.map((p) =>
      this.makeItem({
        model: p.model,
        x: p.x,
        y: p.y,
        rot: p.rot,
        scale: p.scale,
        lie: p.lie ?? false,
        h: p.h ?? 0,
        collidable: false,
        radius: 1,
        height: 2,
      }),
    );
    const wallRuns = data.colliders.filter((c) => c.model === WALL_RUN);
    for (const c of data.colliders) {
      if (c.model === WALL_RUN) {
        // orient the stub along its run: face the nearest sibling wall_run
        let rot = 0;
        let best = Infinity;
        for (const o of wallRuns) {
          if (o === c) continue;
          const d = Math.hypot(o.x - c.x, o.y - c.y);
          if (d < best) {
            best = d;
            rot = -Math.atan2(o.y - c.y, o.x - c.x);
          }
        }
        this.makeItem({ model: WALL_RUN, x: c.x, y: c.y, rot, scale: 1, lie: false, h: 0, collidable: true, radius: c.radius, height: c.height });
      } else if (c.model !== undefined) {
        // hand-authored modeled collider — edit it as a collidable prop
        const tall = TALL_TARGET[c.model];
        this.makeItem({
          model: c.model,
          x: c.x,
          y: c.y,
          rot: 0,
          scale: tall !== undefined ? c.height / tall : 1,
          lie: false,
          h: 0,
          collidable: true,
          radius: c.radius,
          height: c.height,
        });
      } else {
        const host = propItems.find((p) => !p.collidable && Math.hypot(p.x - c.x, p.y - c.y) < 0.05);
        if (host) {
          host.collidable = true;
          host.radius = c.radius;
          host.height = c.height;
          this.addColliderMesh(host);
          this.plant(host);
        } else {
          this.makeItem({ model: "", x: c.x, y: c.y, rot: 0, scale: 1, lie: false, h: 0, collidable: true, radius: c.radius, height: c.height });
        }
      }
    }
    this.refreshStatus();
  }

  /** Serialize the working set to the map format. Collidable props emit BOTH a
   *  prop (rendered via the decor override) and a bare collider (sim-only);
   *  wall stubs keep the "wall_run" render hint; pure colliders stay bare. */
  toMapData(): MapData {
    const props: MapProp[] = [];
    const colliders: MapCollider[] = [];
    for (const it of this.items) {
      if (it.model !== WALL_RUN && it.model !== "") {
        const p: MapProp = { model: it.model, x: r3(it.x), y: r3(it.y), rot: r3(it.rot), scale: r3(it.scale) };
        if (it.lie) p.lie = true;
        if (it.h !== 0) p.h = r3(it.h);
        props.push(p);
      }
      if (it.collidable) {
        const c: MapCollider = { x: r3(it.x), y: r3(it.y), radius: r3(it.radius), height: r3(it.height) };
        if (it.model === WALL_RUN) c.model = WALL_RUN;
        colliders.push(c);
      }
    }
    return { version: 1, props, colliders };
  }

  // ── item lifecycle ─────────────────────────────────────────────────────────

  private makeItem(spec: ItemSpec): EdItem {
    let obj: THREE.Object3D;
    if (spec.model === WALL_RUN) obj = new THREE.Mesh(this.boxGeo, this.stubMat);
    else if (spec.model === "") obj = new THREE.Mesh(this.cylGeo, this.pureMat);
    else {
      obj = this.lib.instance(spec.model);
      obj.traverse((c) => {
        if (c instanceof THREE.Mesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
    }
    this.scene.add(obj);
    const item: EdItem = { ...spec, obj, colliderMesh: null, ringR: 1 };
    this.byObj.set(obj, item);
    this.items.push(item);
    if (item.collidable && item.model !== "") this.addColliderMesh(item);
    this.plant(item);
    return item;
  }

  private nativeHeight(model: string): number {
    const cached = this.heights.get(model);
    if (cached !== undefined) return cached;
    const tpl = this.lib.instance(model);
    tpl.updateMatrixWorld(true);
    BOX.setFromObject(tpl);
    const h = Math.max(0.01, BOX.max.y - BOX.min.y);
    this.heights.set(model, h);
    return h;
  }

  private unitScale(it: EdItem): number {
    const tall = it.lie ? undefined : TALL_TARGET[it.model];
    if (tall === undefined) return it.scale;
    return (tall * it.scale) / this.nativeHeight(it.model);
  }

  /** Re-plant an item: replicate Environment.decorMatrix's math (tall models
   *  scale-to-height, lie topples 90° on Z, base at terrain − rotated-box
   *  min.y, plus the `h` lift) so the editor preview matches the game. */
  private plant(it: EdItem): void {
    const obj = it.obj;
    obj.rotation.order = "YXZ";
    obj.rotation.set(0, it.rot, it.lie ? Math.PI / 2 : 0);
    if (it.model === WALL_RUN) obj.scale.set(Math.max(0.2, it.radius * 2), Math.max(0.2, it.height), 0.9);
    else if (it.model === "") obj.scale.set(Math.max(0.1, it.radius), Math.max(0.1, it.height), Math.max(0.1, it.radius));
    else obj.scale.setScalar(this.unitScale(it));
    obj.position.set(0, 0, 0);
    obj.updateMatrixWorld(true);
    BOX.setFromObject(obj);
    it.ringR = Math.max(0.6, Math.max(BOX.max.x - BOX.min.x, BOX.max.z - BOX.min.z) / 2 + 0.35);
    obj.position.set(it.x, terrainHeight(it.x, it.y) - BOX.min.y + it.h, it.y);
    obj.updateMatrixWorld(true);
    if (it.colliderMesh) {
      it.colliderMesh.scale.set(it.radius, it.height, it.radius);
      it.colliderMesh.position.set(it.x, terrainHeight(it.x, it.y) + it.height / 2, it.y);
    }
  }

  private addColliderMesh(it: EdItem): void {
    if (it.colliderMesh) return;
    const m = new THREE.Mesh(this.cylGeo, this.colMat);
    this.scene.add(m);
    it.colliderMesh = m;
  }

  private removeColliderMesh(it: EdItem): void {
    if (!it.colliderMesh) return;
    this.scene.remove(it.colliderMesh);
    it.colliderMesh = null;
  }

  // ── public edit API (also the dev handle window.__ed) ─────────────────────

  select(it: EdItem | null): void {
    this.selected = it;
    this.syncInspector(true);
  }

  /** Spawn a palette model at (x,y) — default: the camera's look-at point. */
  addProp(model: string, x?: number, y?: number): EdItem {
    const pos = clampToArena(x ?? this.target.x, y ?? this.target.z, POS_MARGIN);
    const isWall = model === WALL_RUN;
    const item = this.makeItem({
      model,
      x: pos.x,
      y: pos.y,
      rot: 0,
      scale: 1,
      lie: false,
      h: 0,
      collidable: isWall,
      radius: isWall ? 1.1 : 1,
      height: isWall ? 2.4 : 2,
    });
    this.select(item);
    this.markDirty();
    return item;
  }

  setSelectedPos(x: number, y: number): void {
    const it = this.selected;
    if (!it) return;
    const pos = clampToArena(x, y, POS_MARGIN);
    it.x = pos.x;
    it.y = pos.y;
    this.plant(it);
    this.markDirty();
    this.syncInspector();
  }

  rotateSelected(rad: number): void {
    const it = this.selected;
    if (!it) return;
    it.rot += rad;
    this.plant(it);
    this.markDirty();
    this.syncInspector();
  }

  scaleSelected(factor: number): void {
    const it = this.selected;
    if (!it) return;
    it.scale = clamp(it.scale * factor, 0.2, 4);
    this.plant(it);
    this.markDirty();
    this.syncInspector();
  }

  toggleSelectedLie(): void {
    const it = this.selected;
    if (!it || it.model === WALL_RUN || it.model === "") return;
    it.lie = !it.lie;
    this.plant(it);
    this.markDirty();
    this.syncInspector();
  }

  /** Collidable toggle — the default radius/height come from the placed
   *  model's bounding-box footprint (editable in the inspector). */
  toggleSelectedCollidable(): void {
    const it = this.selected;
    if (!it || it.model === WALL_RUN || it.model === "") return; // those are always colliders
    it.collidable = !it.collidable;
    if (it.collidable) {
      BOX.setFromObject(it.obj);
      it.radius = clamp(Math.max(BOX.max.x - BOX.min.x, BOX.max.z - BOX.min.z) / 2, 0.2, 8);
      it.height = clamp(BOX.max.y - BOX.min.y, 0.5, 8);
      this.addColliderMesh(it);
    } else {
      this.removeColliderMesh(it);
    }
    this.plant(it);
    this.markDirty();
    this.syncInspector(true);
  }

  removeSelected(): void {
    const it = this.selected;
    if (!it) return;
    this.scene.remove(it.obj);
    this.removeColliderMesh(it);
    this.byObj.delete(it.obj);
    const idx = this.items.indexOf(it);
    if (idx >= 0) this.items.splice(idx, 1);
    this.select(null);
    this.markDirty();
  }

  duplicateSelected(): EdItem | null {
    const it = this.selected;
    if (!it) return null;
    const pos = clampToArena(it.x + 1, it.y, POS_MARGIN);
    const copy = this.makeItem({
      model: it.model,
      x: pos.x,
      y: pos.y,
      rot: it.rot,
      scale: it.scale,
      lie: it.lie,
      h: it.h,
      collidable: it.collidable,
      radius: it.radius,
      height: it.height,
    });
    this.select(copy);
    this.markDirty();
    return copy;
  }

  /** Write the draft to localStorage NOW (edits debounce through markDirty). */
  flush(): void {
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    localStorage.setItem(MAP_STORAGE_KEY, serializeMapData(this.toMapData()));
  }

  private markDirty(): void {
    this.dirty = true;
    this.refreshStatus();
    this.view.refreshShadows(); // scenery moved — re-bake the static shadow map
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 300);
  }

  // ── input ──────────────────────────────────────────────────────────────────

  private bindInput(): void {
    const el = this.view.renderer.domElement;
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.camH = clamp(this.camH * Math.exp(e.deltaY * 0.0012), MIN_H, MAX_H);
      },
      { passive: false },
    );
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
  }

  private setNdc(e: PointerEvent): void {
    const r = this.view.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private groundPoint(e: PointerEvent): boolean {
    this.setNdc(e);
    this.ray.setFromCamera(this.ndc, this.view.camera);
    return this.ray.ray.intersectPlane(this.groundPlane, this.groundHit) !== null;
  }

  private itemFromHit(o: THREE.Object3D): EdItem | null {
    let cur: THREE.Object3D | null = o;
    while (cur) {
      const it = this.byObj.get(cur);
      if (it) return it;
      cur = cur.parent;
    }
    return null;
  }

  private pick(e: PointerEvent): EdItem | null {
    this.setNdc(e);
    this.ray.setFromCamera(this.ndc, this.view.camera);
    const roots = this.items.map((it) => it.obj);
    const hits = this.ray.intersectObjects(roots, true);
    const first = hits[0];
    return first ? this.itemFromHit(first.object) : null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 1 || e.button === 2) {
      this.panning = true;
      this.panX = e.clientX;
      this.panY = e.clientY;
      this.view.renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const hit = this.pick(e);
    this.select(hit);
    if (hit && this.groundPoint(e)) {
      this.dragging = true;
      this.dragOffX = this.groundHit.x - hit.x;
      this.dragOffZ = this.groundHit.z - hit.y;
      this.view.renderer.domElement.setPointerCapture(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.panning) {
      const k = (this.camH / window.innerHeight) * 1.35;
      this.target.x = clamp(this.target.x - (e.clientX - this.panX) * k, -HEX_R, HEX_R);
      this.target.z = clamp(this.target.z - (e.clientY - this.panY) * k, -HEX_R, HEX_R);
      this.panX = e.clientX;
      this.panY = e.clientY;
      return;
    }
    if (!this.dragging || !this.selected) return;
    if (!this.groundPoint(e)) return;
    let nx = this.groundHit.x - this.dragOffX;
    let ny = this.groundHit.z - this.dragOffZ;
    if (e.shiftKey) {
      nx = snapHalf(nx);
      ny = snapHalf(ny);
    }
    this.setSelectedPos(nx, ny);
  }

  private onPointerUp(e: PointerEvent): void {
    this.panning = false;
    this.dragging = false;
    const el = this.view.renderer.domElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (document.activeElement instanceof HTMLInputElement) return;
    const k = e.key;
    const lower = k.toLowerCase();
    if (lower === "w" || lower === "a" || lower === "s" || lower === "d") this.keys.add(lower);
    switch (k) {
      case "Escape":
        this.select(null);
        return;
      case "q":
      case "Q":
        this.rotateSelected(((e.shiftKey ? -1 : -15) * Math.PI) / 180);
        return;
      case "e":
      case "E":
        this.rotateSelected(((e.shiftKey ? 1 : 15) * Math.PI) / 180);
        return;
      case "+":
      case "=":
        this.scaleSelected(1.1);
        return;
      case "-":
      case "_":
        this.scaleSelected(1 / 1.1);
        return;
      case "l":
      case "L":
        this.toggleSelectedLie();
        return;
      case "c":
      case "C":
        this.toggleSelectedCollidable();
        return;
      case "d":
      case "D":
        // D duplicates when something is selected; otherwise it pans (WASD)
        if (this.selected && !e.repeat) this.duplicateSelected();
        return;
      case "Delete":
      case "Backspace":
        this.removeSelected();
        return;
      default:
        return;
    }
  }

  // ── frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.t += dt;
    // WASD pan ('d' is duplicate while something is selected)
    const pan = this.camH * 0.9 * dt;
    if (this.keys.has("w")) this.target.z -= pan;
    if (this.keys.has("s")) this.target.z += pan;
    if (this.keys.has("a")) this.target.x -= pan;
    if (this.keys.has("d") && !this.selected) this.target.x += pan;
    this.target.x = clamp(this.target.x, -HEX_R, HEX_R);
    this.target.z = clamp(this.target.z, -HEX_R, HEX_R);

    const cam = this.view.camera;
    cam.position.set(this.target.x, this.camH, this.target.z + this.camH / Math.tan(PITCH));
    cam.lookAt(this.target.x, 0, this.target.z);

    const sel = this.selected;
    if (sel) {
      this.selRing.visible = true;
      this.selRing.position.set(sel.x, terrainHeight(sel.x, sel.y) + 0.06, sel.y);
      this.selRing.scale.setScalar(sel.ringR);
    } else {
      this.selRing.visible = false;
    }

    this.env?.update(this.t);
    this.view.render();
  }

  // ── DOM UI ─────────────────────────────────────────────────────────────────

  private input(id: string): HTMLInputElement {
    const cached = this.inputs.get(id);
    if (cached) return cached;
    const el = document.getElementById(id);
    if (!(el instanceof HTMLInputElement)) throw new Error(`editor: missing input #${id}`);
    this.inputs.set(id, el);
    return el;
  }

  private refreshStatus(): void {
    if (!this.statusEl) return;
    const nProps = this.items.filter((it) => it.model !== WALL_RUN && it.model !== "").length;
    const nCols = this.items.filter((it) => it.collidable).length;
    this.statusEl.textContent = `${nProps} props · ${nCols} colliders${this.dirty ? " · ●" : ""}`;
  }

  /** Update inspector fields; full=true also rebuilds visibility/model label. */
  private syncInspector(full = false): void {
    const box = this.inspector;
    if (!box) return;
    const it = this.selected;
    if (!it) {
      box.style.display = "none";
      return;
    }
    box.style.display = "flex";
    if (full) {
      const label = document.getElementById("ed-i-model");
      if (label) label.textContent = it.model === "" ? "(pure collider)" : it.model;
    }
    const setVal = (id: string, v: string): void => {
      const el = this.input(id);
      if (document.activeElement !== el) el.value = v;
    };
    setVal("ed-ix", it.x.toFixed(2));
    setVal("ed-iy", it.y.toFixed(2));
    setVal("ed-irot", (((it.rot * 180) / Math.PI) % 360).toFixed(1));
    setVal("ed-iscale", it.scale.toFixed(2));
    setVal("ed-ih", it.h.toFixed(2));
    this.input("ed-ilie").checked = it.lie;
    this.input("ed-icol").checked = it.collidable;
    const isProp = it.model !== WALL_RUN && it.model !== "";
    this.input("ed-ilie").disabled = !isProp;
    this.input("ed-icol").disabled = !isProp;
    this.input("ed-iscale").disabled = !isProp;
    this.input("ed-ih").disabled = !isProp;
    const colRow = document.getElementById("ed-colrow");
    if (colRow) colRow.style.display = it.collidable ? "flex" : "none";
    if (it.collidable) {
      setVal("ed-irad", it.radius.toFixed(2));
      setVal("ed-iht", it.height.toFixed(2));
    }
  }

  private buildUI(): void {
    injectStyle();
    const ui = document.createElement("div");
    ui.id = "ba-editor";
    const paletteButtons = [WALL_RUN, ...PLACEABLE_MODELS]
      .map((m) => `<button class="edp" data-model="${m}">${m}</button>`)
      .join("");
    ui.innerHTML = `
      <div class="ed-top">
        <span class="ed-logo">MAP EDITOR</span>
        <button id="ed-save">SAVE</button>
        <button id="ed-test">TEST</button>
        <button id="ed-loadbtn">LOAD</button>
        <button id="ed-reset">RESET</button>
        <button id="ed-clear">CLEAR PROPS</button>
        <span class="ed-status" id="ed-status"></span>
        <input type="file" id="ed-file" accept=".json,application/json" style="display:none">
      </div>
      <div class="ed-palette">
        <input id="ed-search" placeholder="search props…">
        <div class="ed-list" id="ed-list">${paletteButtons}</div>
      </div>
      <div class="ed-inspector" id="ed-inspector" style="display:none">
        <div class="ed-i-model" id="ed-i-model"></div>
        <label>x<input id="ed-ix" type="number" step="0.5"></label>
        <label>y<input id="ed-iy" type="number" step="0.5"></label>
        <label>rot°<input id="ed-irot" type="number" step="15"></label>
        <label>scale<input id="ed-iscale" type="number" step="0.1" min="0.2" max="4"></label>
        <label>lift<input id="ed-ih" type="number" step="0.1"></label>
        <label class="edchk"><input id="ed-ilie" type="checkbox">lie (toppled)</label>
        <label class="edchk"><input id="ed-icol" type="checkbox">collidable</label>
        <div id="ed-colrow" style="display:none">
          <label>radius<input id="ed-irad" type="number" step="0.1" min="0.1"></label>
          <label>height<input id="ed-iht" type="number" step="0.1" min="0.1"></label>
        </div>
        <button id="ed-idel">DELETE</button>
      </div>
      <div class="ed-help">LMB select/drag (Shift snap) · Q/E rotate (Shift fine) · +/- scale · L lie · C collide · D duplicate · Del delete · Esc deselect · RMB/WASD pan · wheel zoom</div>`;
    document.body.appendChild(ui);
    this.ui = ui;
    this.statusEl = document.getElementById("ed-status");
    this.inspector = document.getElementById("ed-inspector");

    // palette
    ui.querySelectorAll<HTMLButtonElement>(".edp").forEach((btn) => {
      btn.addEventListener("click", () => {
        const model = btn.dataset["model"];
        if (model) this.addProp(model);
      });
    });
    const search = this.input("ed-search");
    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      ui.querySelectorAll<HTMLButtonElement>(".edp").forEach((btn) => {
        const name = btn.dataset["model"] ?? "";
        btn.style.display = name.includes(q) ? "" : "none";
      });
    });

    // top bar
    const on = (id: string, fn: () => void): void => {
      document.getElementById(id)?.addEventListener("click", fn);
    };
    on("ed-save", () => {
      this.flush();
      const blob = new Blob([serializeMapData(this.toMapData())], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "battle-arena-map.json";
      a.click();
      URL.revokeObjectURL(url);
      this.dirty = false;
      this.refreshStatus();
    });
    on("ed-test", () => {
      this.flush();
      window.open(`${location.pathname}?auto=1`, "_blank");
    });
    on("ed-loadbtn", () => this.input("ed-file").click());
    this.input("ed-file").addEventListener("change", () => {
      const file = this.input("ed-file").files?.item(0);
      if (!file) return;
      void file.text().then((text) => {
        let parsed: MapData | null = null;
        try {
          parsed = parseMapData(JSON.parse(text));
        } catch {
          parsed = null;
        }
        if (!parsed) {
          window.alert("Not a valid battle-arena map file.");
          return;
        }
        this.setWorkingSet(parsed);
        this.markDirty();
      });
      this.input("ed-file").value = "";
    });
    on("ed-reset", () => {
      this.setWorkingSet(this.proceduralMapData());
      this.markDirty();
    });
    on("ed-clear", () => {
      for (const it of [...this.items]) {
        if (it.model === WALL_RUN || it.model === "") continue;
        this.scene.remove(it.obj);
        this.removeColliderMesh(it);
        this.byObj.delete(it.obj);
        const idx = this.items.indexOf(it);
        if (idx >= 0) this.items.splice(idx, 1);
      }
      this.select(null);
      this.markDirty();
      this.refreshStatus();
    });
    on("ed-idel", () => this.removeSelected());

    // inspector live inputs
    const bindNum = (id: string, apply: (it: EdItem, v: number) => void): void => {
      const el = this.input(id);
      el.addEventListener("input", () => {
        const it = this.selected;
        const v = Number.parseFloat(el.value);
        if (!it || !Number.isFinite(v)) return;
        apply(it, v);
        this.plant(it);
        this.markDirty();
      });
    };
    bindNum("ed-ix", (it, v) => {
      const pos = clampToArena(v, it.y, POS_MARGIN);
      it.x = pos.x;
      it.y = pos.y;
    });
    bindNum("ed-iy", (it, v) => {
      const pos = clampToArena(it.x, v, POS_MARGIN);
      it.x = pos.x;
      it.y = pos.y;
    });
    bindNum("ed-irot", (it, v) => {
      it.rot = (v * Math.PI) / 180;
    });
    bindNum("ed-iscale", (it, v) => {
      it.scale = clamp(v, 0.2, 4);
    });
    bindNum("ed-ih", (it, v) => {
      it.h = clamp(v, -10, 20);
    });
    bindNum("ed-irad", (it, v) => {
      it.radius = clamp(v, 0.1, 20);
    });
    bindNum("ed-iht", (it, v) => {
      it.height = clamp(v, 0.1, 30);
    });
    this.input("ed-ilie").addEventListener("change", () => this.toggleSelectedLie());
    this.input("ed-icol").addEventListener("change", () => this.toggleSelectedCollidable());

    this.refreshStatus();
  }
}

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = `
#ba-editor{position:fixed;inset:0;z-index:40;pointer-events:none;font-family:ui-monospace,monospace;color:#fff}
#ba-editor button{pointer-events:auto;cursor:pointer;font:700 11px ui-monospace,monospace;color:#fff;background:rgba(30,38,60,.9);border:1px solid rgba(255,255,255,.18);border-radius:7px;padding:6px 10px}
#ba-editor button:hover{border-color:#ffd24a;color:#ffd24a}
#ba-editor input{pointer-events:auto;background:rgba(10,14,24,.9);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font:600 11px ui-monospace,monospace;padding:5px 7px}
.ed-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(#080a12ee,#080a1200)}
.ed-logo{font:900 italic 16px system-ui,sans-serif;letter-spacing:-1px;color:#ffd24a;margin-right:6px}
.ed-status{font:600 11px ui-monospace,monospace;opacity:.75;margin-left:auto}
.ed-palette{position:absolute;top:46px;left:10px;bottom:44px;width:200px;display:flex;flex-direction:column;gap:6px;background:rgba(8,10,18,.82);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px}
.ed-palette input{width:100%;box-sizing:border-box}
.ed-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:3px;pointer-events:auto}
.ed-list button{text-align:left;background:rgba(20,26,42,.85);border-radius:5px;padding:4px 8px;font-weight:600}
.ed-inspector{position:absolute;top:46px;right:10px;width:220px;display:flex;flex-direction:column;gap:6px;background:rgba(8,10,18,.85);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px}
.ed-i-model{font:800 13px ui-monospace,monospace;color:#ffd24a;word-break:break-all}
.ed-inspector label{display:flex;align-items:center;justify-content:space-between;gap:8px;font:600 11px ui-monospace,monospace;opacity:.9}
.ed-inspector label input[type=number]{width:110px}
.ed-inspector .edchk{justify-content:flex-start}
#ed-colrow{display:flex;flex-direction:column;gap:6px;border-top:1px solid rgba(255,255,255,.12);padding-top:6px}
#ed-idel{background:#5a2030;border-color:#a04050}
.ed-help{position:absolute;left:0;right:0;bottom:0;text-align:center;padding:8px;font:600 11px ui-monospace,monospace;opacity:.55;background:linear-gradient(#080a1200,#080a12dd)}
`;
  document.head.appendChild(s);
}
