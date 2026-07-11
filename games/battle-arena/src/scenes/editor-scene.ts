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
import { buildDefaultObstacles, clampToArena, FLOOR_OVERRIDES, floorKey, HEX_R } from "../data/map";
import { buildProceduralDecor } from "../data/decor";
import { terrainHeight } from "../data/terrain";
import { Environment, TALL_TARGET } from "../render/environment";
import type { ModelLibrary } from "../render/models";
import type { View } from "../render/view";
import {
  FLOOR_TYPES,
  MAP_STORAGE_KEY,
  parseMapData,
  PLACEABLE_MODELS,
  serializeMapData,
  type FloorType,
  type MapCollider,
  type MapData,
  type MapFloorCell,
  type MapProp,
} from "../data/map-format";

const WALL_RUN = "wall_run"; // collider-only wall stub (no prop model)
const PITCH = (55 * Math.PI) / 180; // default camera elevation above horizontal
const MIN_PITCH = (28 * Math.PI) / 180;
const MAX_PITCH = (82 * Math.PI) / 180;
const MIN_H = 15;
const MAX_H = 110; // camera height clamp (wheel zoom)
const POS_MARGIN = -3; // hex clamp apron (matches map-format's parser)
const FLOOR_TILE = 4; // the floor builder's cell size

/** Floor-palette swatch colors (hover highlight + UI chips). */
const FLOOR_COLORS: Record<FloorType | "auto", number> = {
  flag: 0x9aa3b8,
  worn: 0x7d8894,
  dirt: 0x8a6a4a,
  grate: 0xb0703a,
  auto: 0xffffff,
};

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

  // camera — yaw/pitch orbit around a ground target
  private target = new THREE.Vector3(0, 0, 0);
  private camH = 55;
  private yaw = 0;
  private pitch = PITCH;
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
  private rotating = false;
  private panX = 0;
  private panY = 0;

  // place mode: a palette pick follows the cursor as an opaque preview; click
  // stamps it, click-drag stamps a trail
  private placing: { model: string; ghost: THREE.Object3D; ringR: number } | null = null;
  private stamping = false;
  private stampX = 0;
  private stampY = 0;

  // floor mode: paint tile bands onto the 4u grid
  private mode: "props" | "floor" = "props";
  private floorType: FloorType | "auto" = "dirt";
  private paintingFloor = false;
  private floorCursor: THREE.Mesh;
  private floorCursorMat: THREE.MeshBasicMaterial;
  private floorRebuildTimer: number | undefined;

  // shared editor-only resources
  private cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20);
  private boxGeo = new THREE.BoxGeometry(1, 1, 1);
  private colMat = new THREE.MeshBasicMaterial({
    color: 0xff4433,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  private pureMat = new THREE.MeshBasicMaterial({
    color: 0xff4433,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });
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
      new THREE.MeshBasicMaterial({
        color: 0x66ff99,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    this.selRing.visible = false;
    this.scene.add(this.selRing);
    this.floorCursorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const cursGeo = new THREE.PlaneGeometry(FLOOR_TILE, FLOOR_TILE);
    cursGeo.rotateX(-Math.PI / 2);
    this.floorCursor = new THREE.Mesh(cursGeo, this.floorCursorMat);
    this.floorCursor.visible = false;
    this.scene.add(this.floorCursor);
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
      const model =
        o.model ?? (i % 3 === 0 ? "pillar_decorated" : i % 3 === 1 ? "column" : "pillar");
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
        this.makeItem({
          model: WALL_RUN,
          x: c.x,
          y: c.y,
          rot,
          scale: 1,
          lie: false,
          h: 0,
          collidable: true,
          radius: c.radius,
          height: c.height,
        });
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
        const host = propItems.find(
          (p) => !p.collidable && Math.hypot(p.x - c.x, p.y - c.y) < 0.05,
        );
        if (host) {
          host.collidable = true;
          host.radius = c.radius;
          host.height = c.height;
          this.addColliderMesh(host);
          this.plant(host);
        } else {
          this.makeItem({
            model: "",
            x: c.x,
            y: c.y,
            rot: 0,
            scale: 1,
            lie: false,
            h: 0,
            collidable: true,
            radius: c.radius,
            height: c.height,
          });
        }
      }
    }
    FLOOR_OVERRIDES.clear();
    for (const f of data.floor ?? []) FLOOR_OVERRIDES.set(floorKey(f.x, f.y), f.t);
    this.env?.rebuildFloor();
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
        const p: MapProp = {
          model: it.model,
          x: r3(it.x),
          y: r3(it.y),
          rot: r3(it.rot),
          scale: r3(it.scale),
        };
        if (it.lie) p.lie = true;
        if (it.h !== 0) p.h = r3(it.h);
        props.push(p);
      }
      if (it.collidable) {
        const c: MapCollider = {
          x: r3(it.x),
          y: r3(it.y),
          radius: r3(it.radius),
          height: r3(it.height),
        };
        if (it.model === WALL_RUN) c.model = WALL_RUN;
        colliders.push(c);
      }
    }
    const floor: MapFloorCell[] = [];
    for (const [key, t] of FLOOR_OVERRIDES) {
      const [gx, gz] = key.split(",").map(Number);
      if (gx !== undefined && gz !== undefined && Number.isFinite(gx) && Number.isFinite(gz))
        floor.push({ x: gx, y: gz, t });
    }
    const out: MapData = { version: 1, props, colliders };
    if (floor.length > 0) out.floor = floor;
    return out;
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

  /** Shared placement math (also used by the place-mode ghost): replicate
   *  Environment.decorMatrix (tall models scale-to-height, lie topples 90° on
   *  Z, base at terrain − rotated-box min.y, plus the `h` lift) so the editor
   *  preview matches the game. Returns the footprint ring radius. */
  private plantTransform(obj: THREE.Object3D, spec: Omit<ItemSpec, "collidable">): number {
    obj.rotation.order = "YXZ";
    obj.rotation.set(0, spec.rot, spec.lie ? Math.PI / 2 : 0);
    if (spec.model === WALL_RUN)
      obj.scale.set(Math.max(0.2, spec.radius * 2), Math.max(0.2, spec.height), 0.9);
    else if (spec.model === "")
      obj.scale.set(
        Math.max(0.1, spec.radius),
        Math.max(0.1, spec.height),
        Math.max(0.1, spec.radius),
      );
    else {
      const tall = spec.lie ? undefined : TALL_TARGET[spec.model];
      obj.scale.setScalar(
        tall === undefined ? spec.scale : (tall * spec.scale) / this.nativeHeight(spec.model),
      );
    }
    obj.position.set(0, 0, 0);
    obj.updateMatrixWorld(true);
    BOX.setFromObject(obj);
    const ringR = Math.max(0.6, Math.max(BOX.max.x - BOX.min.x, BOX.max.z - BOX.min.z) / 2 + 0.35);
    obj.position.set(spec.x, terrainHeight(spec.x, spec.y) - BOX.min.y + spec.h, spec.y);
    obj.updateMatrixWorld(true);
    return ringR;
  }

  private plant(it: EdItem): void {
    it.ringR = this.plantTransform(it.obj, it);
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

  // ── place mode (ghost-under-cursor stamping) ───────────────────────────────

  /** Enter place mode: `model` follows the cursor as a translucent ghost;
   *  LMB stamps it (drag = stamp a trail). RMB/Esc exits. */
  startPlacing(model: string): void {
    this.stopPlacing();
    this.select(null);
    // OPAQUE preview — the real model under the cursor, exactly what a stamp
    // will drop (translucency read as "not really there")
    const ghost =
      model === WALL_RUN ? new THREE.Mesh(this.boxGeo, this.stubMat) : this.lib.instance(model);
    this.scene.add(ghost);
    const ringR = this.plantTransform(ghost, {
      model,
      x: this.target.x,
      y: this.target.z,
      rot: 0,
      scale: 1,
      lie: false,
      h: 0,
      radius: 1.1,
      height: 2.4,
    });
    this.placing = { model, ghost, ringR };
    this.highlightPalette(model);
  }

  stopPlacing(): void {
    const p = this.placing;
    if (!p) return;
    this.scene.remove(p.ghost);
    this.placing = null;
    this.stamping = false;
    this.highlightPalette(null);
  }

  private moveGhost(x: number, y: number, snap: boolean): void {
    const p = this.placing;
    if (!p) return;
    const pos = clampToArena(snap ? snapHalf(x) : x, snap ? snapHalf(y) : y, POS_MARGIN);
    p.ringR = this.plantTransform(p.ghost, {
      model: p.model,
      x: pos.x,
      y: pos.y,
      rot: 0,
      scale: 1,
      lie: false,
      h: 0,
      radius: 1.1,
      height: 2.4,
    });
  }

  /** Render each palette model to a small 3/4-view thumbnail (offscreen GL
   *  context, batched across frames) and feed the palette row images. */
  private async genThumbs(models: string[]): Promise<void> {
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    r.setSize(size, size, false);
    r.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x39415a, 1.35));
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(3, 5, 2.2);
    scene.add(sun);
    const frame = (): Promise<void> => new Promise((res) => requestAnimationFrame(() => res()));
    let n = 0;
    for (const model of models) {
      const obj =
        model === WALL_RUN ? new THREE.Mesh(this.boxGeo, this.stubMat) : this.lib.instance(model);
      if (model === WALL_RUN) obj.scale.set(2.2, 2.4, 0.9);
      scene.add(obj);
      obj.updateMatrixWorld(true);
      BOX.setFromObject(obj);
      const c = BOX.getCenter(new THREE.Vector3());
      const s = BOX.getSize(new THREE.Vector3());
      const dist = (Math.max(s.x, s.y, s.z) / Math.tan((cam.fov * Math.PI) / 360)) * 0.62 + 0.4;
      cam.position.set(c.x + dist * 0.74, c.y + dist * 0.6, c.z + dist * 0.74);
      cam.lookAt(c);
      r.render(scene, cam);
      const url = canvas.toDataURL();
      scene.remove(obj);
      this.ui?.querySelectorAll<HTMLImageElement>(`img[data-thumb="${model}"]`).forEach((img) => {
        img.src = url;
      });
      if (++n % 6 === 0) await frame(); // keep init responsive
    }
    r.dispose();
  }

  /** Stamp one copy at the ghost's spot (place mode LMB / drag trail). */
  private stampAt(x: number, y: number): void {
    const p = this.placing;
    if (!p) return;
    const pos = clampToArena(x, y, POS_MARGIN);
    const isWall = p.model === WALL_RUN;
    this.makeItem({
      model: p.model,
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
    this.stampX = pos.x;
    this.stampY = pos.y;
    this.markDirty();
  }

  private highlightPalette(model: string | null): void {
    this.ui?.querySelectorAll<HTMLButtonElement>(".edp").forEach((btn) => {
      btn.classList.toggle("edp-on", model !== null && btn.dataset["model"] === model);
    });
  }

  // ── floor mode (paint tile bands on the 4u grid) ───────────────────────────

  setMode(mode: "props" | "floor"): void {
    this.mode = mode;
    if (mode === "floor") {
      this.stopPlacing();
      this.select(null);
      this.dragging = false;
    }
    this.paintingFloor = false;
    this.floorCursor.visible = false;
    document.getElementById("ed-tab-props")?.classList.toggle("on", mode === "props");
    document.getElementById("ed-tab-floor")?.classList.toggle("on", mode === "floor");
    const fp = document.getElementById("ed-floorpal");
    if (fp) fp.style.display = mode === "floor" ? "flex" : "none";
    const pp = document.getElementById("ed-proppal");
    if (pp) pp.style.display = mode === "floor" ? "none" : "flex";
    const roster = document.getElementById("ed-roster");
    if (roster) roster.style.display = mode === "floor" ? "none" : "flex";
    this.syncInspector(true);
  }

  setFloorType(t: FloorType | "auto"): void {
    this.floorType = t;
    this.floorCursorMat.color.setHex(FLOOR_COLORS[t]);
    this.ui?.querySelectorAll<HTMLButtonElement>(".edf").forEach((btn) => {
      btn.classList.toggle("edp-on", btn.dataset["floor"] === t);
    });
  }

  private paintFloorAt(x: number, y: number): void {
    const gx = Math.round(x / FLOOR_TILE) * FLOOR_TILE;
    const gz = Math.round(y / FLOOR_TILE) * FLOOR_TILE;
    const key = floorKey(gx, gz);
    if (this.floorType === "auto") {
      if (!FLOOR_OVERRIDES.has(key)) return;
      FLOOR_OVERRIDES.delete(key);
    } else {
      if (FLOOR_OVERRIDES.get(key) === this.floorType) return;
      FLOOR_OVERRIDES.set(key, this.floorType);
    }
    this.markDirty();
    // rebuilding ~1k instanced tiles is cheap but not per-mousemove-event cheap
    if (this.floorRebuildTimer === undefined) {
      this.floorRebuildTimer = window.setTimeout(() => {
        this.floorRebuildTimer = undefined;
        this.env?.rebuildFloor();
      }, 90);
    }
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
    this.ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
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
    const el = this.view.renderer.domElement;
    // RMB: orbit (Shift+RMB pans, for mice without a wheel button). Also
    // cancels place mode. MMB: pan.
    if (e.button === 2) {
      if (this.placing) {
        this.stopPlacing();
        return;
      }
      if (e.shiftKey) this.panning = true;
      else this.rotating = true;
      this.panX = e.clientX;
      this.panY = e.clientY;
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 1) {
      this.panning = true;
      this.panX = e.clientX;
      this.panY = e.clientY;
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    // floor mode: LMB paints (click or drag)
    if (this.mode === "floor") {
      if (this.groundPoint(e)) {
        this.paintingFloor = true;
        this.paintFloorAt(this.groundHit.x, this.groundHit.z);
        el.setPointerCapture(e.pointerId);
      }
      return;
    }
    // place mode: LMB stamps; holding stamps a trail as the pointer moves
    if (this.placing) {
      if (this.groundPoint(e)) {
        this.stamping = true;
        this.moveGhost(this.groundHit.x, this.groundHit.z, e.shiftKey);
        this.stampAt(this.placing.ghost.position.x, this.placing.ghost.position.z);
        el.setPointerCapture(e.pointerId);
      }
      return;
    }
    const hit = this.pick(e);
    this.select(hit);
    if (hit && this.groundPoint(e)) {
      this.dragging = true;
      this.dragOffX = this.groundHit.x - hit.x;
      this.dragOffZ = this.groundHit.z - hit.y;
      el.setPointerCapture(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.rotating) {
      this.yaw -= (e.clientX - this.panX) * 0.005;
      this.pitch = clamp(this.pitch + (e.clientY - this.panY) * 0.004, MIN_PITCH, MAX_PITCH);
      this.panX = e.clientX;
      this.panY = e.clientY;
      return;
    }
    if (this.panning) {
      const k = (this.camH / window.innerHeight) * 1.35;
      const dx = (e.clientX - this.panX) * k;
      const dy = (e.clientY - this.panY) * k;
      // yaw-aware: screen-right / screen-up in ground coordinates
      const rx = Math.cos(this.yaw);
      const rz = -Math.sin(this.yaw);
      const fx = -Math.sin(this.yaw);
      const fz = -Math.cos(this.yaw);
      this.target.x = clamp(this.target.x - rx * dx + fx * dy, -HEX_R, HEX_R);
      this.target.z = clamp(this.target.z - rz * dx + fz * dy, -HEX_R, HEX_R);
      this.panX = e.clientX;
      this.panY = e.clientY;
      return;
    }
    if (this.mode === "floor") {
      if (!this.groundPoint(e)) return;
      const gx = Math.round(this.groundHit.x / FLOOR_TILE) * FLOOR_TILE;
      const gz = Math.round(this.groundHit.z / FLOOR_TILE) * FLOOR_TILE;
      this.floorCursor.visible = true;
      this.floorCursor.position.set(gx, terrainHeight(gx, gz) + 0.14, gz);
      if (this.paintingFloor) this.paintFloorAt(this.groundHit.x, this.groundHit.z);
      return;
    }
    if (this.placing) {
      if (!this.groundPoint(e)) return;
      this.moveGhost(this.groundHit.x, this.groundHit.z, e.shiftKey);
      if (this.stamping) {
        const g = this.placing.ghost.position;
        const spacing = Math.max(1.6, this.placing.ringR * 1.15);
        if (Math.hypot(g.x - this.stampX, g.z - this.stampY) >= spacing) this.stampAt(g.x, g.z);
      }
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
    this.rotating = false;
    this.dragging = false;
    this.stamping = false;
    if (this.paintingFloor) {
      this.paintingFloor = false;
      // flush the throttled rebuild so the stroke commits immediately
      if (this.floorRebuildTimer !== undefined) {
        window.clearTimeout(this.floorRebuildTimer);
        this.floorRebuildTimer = undefined;
      }
      this.env?.rebuildFloor();
    }
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
        if (this.placing) this.stopPlacing();
        else this.select(null);
        return;
      case "f":
      case "F":
        this.setMode(this.mode === "floor" ? "props" : "floor");
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
    // WASD pan, yaw-relative ('d' is duplicate while something is selected)
    const pan = this.camH * 0.9 * dt;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    if (this.keys.has("w")) {
      this.target.x += fx * pan;
      this.target.z += fz * pan;
    }
    if (this.keys.has("s")) {
      this.target.x -= fx * pan;
      this.target.z -= fz * pan;
    }
    if (this.keys.has("a")) {
      this.target.x -= rx * pan;
      this.target.z -= rz * pan;
    }
    if (this.keys.has("d") && !this.selected) {
      this.target.x += rx * pan;
      this.target.z += rz * pan;
    }
    this.target.x = clamp(this.target.x, -HEX_R, HEX_R);
    this.target.z = clamp(this.target.z, -HEX_R, HEX_R);

    const cam = this.view.camera;
    const ground = this.camH / Math.tan(this.pitch);
    cam.position.set(
      this.target.x + Math.sin(this.yaw) * ground,
      this.camH,
      this.target.z + Math.cos(this.yaw) * ground,
    );
    cam.lookAt(this.target.x, 0, this.target.z);

    const sel = this.selected;
    if (sel) {
      this.selRing.visible = true;
      this.selRing.position.set(sel.x, terrainHeight(sel.x, sel.y) + 0.12, sel.y); // above tile tops (0.05) + dirt bumps
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
      const emptyNote = document.getElementById("ed-note");
      if (emptyNote) emptyNote.style.display = "block";
      return;
    }
    box.style.display = "flex";
    const note = document.getElementById("ed-note");
    if (note) note.style.display = "none";
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
      .map(
        (m) =>
          `<button class="edp" data-model="${m}"><img data-thumb="${m}" alt=""><span>${m}</span></button>`,
      )
      .join("");
    const floorButtons = [...FLOOR_TYPES, "auto" as const]
      .map((t) => {
        const hex = `#${FLOOR_COLORS[t].toString(16).padStart(6, "0")}`;
        const label =
          t === "auto"
            ? "auto (erase)"
            : t === "flag"
              ? "flagstone"
              : t === "worn"
                ? "worn rock"
                : t === "grate"
                  ? "grate"
                  : "dirt";
        return `<button class="edf" data-floor="${t}"><i style="background:${hex}"></i>${label}</button>`;
      })
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
      <div class="ed-roster" id="ed-roster">
        <div class="ed-roster-h">PROPS</div>
        <input id="ed-search" placeholder="search props…">
        <div class="ed-list" id="ed-list">${paletteButtons}</div>
      </div>
      <div class="ed-panel">
        <div class="ed-tabs">
          <button class="edt" id="ed-tab-props" data-tab="props">PROPS</button>
          <button class="edt" id="ed-tab-floor" data-tab="floor">FLOOR</button>
        </div>
        <div class="ed-body" id="ed-proppal">
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
          <div class="ed-note" id="ed-note">Pick a prop on the left — it follows your cursor; click to stamp it, click-drag to stamp a trail. RMB or Esc exits place mode. Click a placed prop to select and edit it here.</div>
        </div>
        <div class="ed-body" id="ed-floorpal" style="display:none">
          <div class="ed-roster-h">FLOOR PAINT</div>
          ${floorButtons}
          <div class="ed-note">Click or drag on the ground to paint 4u tiles. AUTO restores the procedural floor.</div>
        </div>
      </div>
      <div class="ed-help">LMB select/drag (Shift snap) · Q/E rotate · +/- scale · L lie · C collide · D duplicate · Del delete · F floor tab · RMB orbit · MMB or Shift+RMB pan · WASD pan · wheel zoom</div>`;
    document.body.appendChild(ui);
    this.ui = ui;
    this.statusEl = document.getElementById("ed-status");
    this.inspector = document.getElementById("ed-inspector");

    // palette → place mode (opaque preview under the cursor; clicking the
    // active model again exits)
    ui.querySelectorAll<HTMLButtonElement>(".edp").forEach((btn) => {
      btn.addEventListener("click", () => {
        const model = btn.dataset["model"];
        if (!model) return;
        if (this.placing?.model === model) this.stopPlacing();
        else this.startPlacing(model);
      });
    });
    // floor palette
    ui.querySelectorAll<HTMLButtonElement>(".edf").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset["floor"];
        if (t === "auto" || (FLOOR_TYPES as readonly string[]).includes(t ?? ""))
          this.setFloorType(t as FloorType | "auto");
      });
    });
    this.setFloorType(this.floorType);
    ui.querySelectorAll<HTMLButtonElement>(".edt").forEach((btn) => {
      btn.addEventListener("click", () =>
        this.setMode(btn.dataset["tab"] === "floor" ? "floor" : "props"),
      );
    });
    this.setMode(this.mode);
    void this.genThumbs([WALL_RUN, ...PLACEABLE_MODELS]);
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
.ed-roster{position:absolute;top:46px;left:10px;bottom:44px;width:206px;display:flex;flex-direction:column;gap:4px;background:rgba(8,10,18,.82);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;pointer-events:auto}
.ed-roster-h{font:800 10px ui-monospace,monospace;letter-spacing:1px;opacity:.55;padding:6px 2px 2px}
.ed-roster input{width:100%;box-sizing:border-box}
.ed-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;pointer-events:auto;min-height:0}
#ba-editor .edp{display:flex;align-items:center;gap:8px;text-align:left;background:rgba(20,26,42,.85);border-radius:6px;padding:5px 8px;font-weight:600}
#ba-editor .edp img{width:30px;height:30px;border-radius:5px;flex:none;background:#0a0e18}
#ba-editor .edp span{font-size:10px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#ba-editor .edp-on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
.ed-panel{position:absolute;top:46px;right:10px;width:250px;max-height:calc(100vh - 100px);display:flex;flex-direction:column;gap:6px;background:rgba(8,10,18,.85);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;pointer-events:auto}
.ed-tabs{display:flex;gap:4px}
.edt{flex:1}
#ba-editor .edt.on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
.ed-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:5px;min-height:0}
#ba-editor .edf{display:flex;align-items:center;gap:8px;text-align:left;background:rgba(20,26,42,.85);border-radius:6px;padding:6px 8px}
#ba-editor .edf i{display:inline-block;width:16px;height:16px;border-radius:4px;border:1px solid rgba(255,255,255,.35);flex:none}
#ba-editor .edf.edp-on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
.ed-note{font:600 9px ui-monospace,monospace;opacity:.45;padding:8px 2px;line-height:1.4}
.ed-inspector{display:flex;flex-direction:column;gap:6px}
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
