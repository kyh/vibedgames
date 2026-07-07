import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";

import {
  BUILDINGS_COMMERCIAL,
  BUILDINGS_INDUSTRIAL,
  BUILDINGS_SKYSCRAPER,
  BUILDINGS_SUBURBAN,
  CHARACTERS,
  modelUrl,
  KK_BUILDINGS,
  KK_CARS,
  KK_PROPS_EXTRA,
  PARK_TILES,
  PROPS,
  SERVICE_CARS,
  TRAFFIC_CARS,
} from "../assets/manifest";
import type { GameScene } from "../scenes/game-scene";
import { type FloorKind, loadLocalOverrides, saveLocalOverrides } from "../world/custom-map";
import { ROAD_TILE, WORLD_H, WORLD_W } from "../shared/constants";
import { CUSTOM_PROPS } from "../world/custom-props";
import { loadLocalProps, parseMapFile, saveLocalProps } from "../world/map-file";

// The map editor (?editor=1), battle-arena style: left roster of model
// thumbnails (click one — it follows the cursor, click to stamp), right panel
// with PROPS / STREETS / FLOOR tabs + an inspector for the selected prop.
// EVERY edit auto-saves to this browser; SAVE downloads the one-file map
// (load it in-game with ?map=<url>). Streets change the generated world, so
// the STREETS tab has the one rebuild button; everything else is live.

type Entry = {
  model: string;
  u: number;
  v: number;
  yaw: number;
  s: number;
  solid?: boolean;
};

type Placed = { entry: Entry; node: THREE.Object3D | null; baked: boolean };

type Tab = "props" | "streets" | "floor" | "clear";

const CATEGORIES: readonly { label: string; cat: string; names: readonly string[] }[] = [
  { label: "props", cat: "props", names: [...PROPS, ...KK_PROPS_EXTRA] },
  { label: "parks", cat: "parks", names: PARK_TILES },
  { label: "houses", cat: "buildings", names: BUILDINGS_SUBURBAN },
  { label: "commercial", cat: "buildings", names: [...BUILDINGS_COMMERCIAL, ...BUILDINGS_SKYSCRAPER, ...KK_BUILDINGS] },
  { label: "industrial", cat: "buildings", names: BUILDINGS_INDUSTRIAL },
  { label: "cars", cat: "cars", names: [...TRAFFIC_CARS, ...SERVICE_CARS, "waymo", "police", ...KK_CARS] },
  { label: "people", cat: "characters", names: CHARACTERS },
];

const FLOOR_COLORS: Record<FloorKind | "erase", number> = {
  plaza: 0xcfd2cc,
  grass: 0x63a860,
  sand: 0xd9c489,
  erase: 0x333344,
};

// Kit models arrive at wildly different native sizes — normalize each pick to
// a sensible in-world default (adjust after with [ ] or the inspector).
function defaultScale(cat: string, size: THREE.Vector3): number {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  if (cat === "buildings") return clamp(8 / Math.max(size.x, size.z, 0.001), 0.5, 12);
  if (cat === "characters") return clamp(1.7 / Math.max(size.y, 0.001), 0.5, 6);
  if (cat === "cars") return 1;
  // props: trees/lamps etc read right around 3-4u tall
  return clamp(3.4 / Math.max(size.y, 0.001), 0.4, 6);
}

export function startEditor(game: GameScene, renderer: THREE.WebGLRenderer): void {
  const city = game.getCity();
  if (!city) return;
  const cache = game.getCache();
  const camera = game.camera;

  game.freecam = true;
  game.enableEditorLighting();
  for (const id of ["hud", "banner", "legend", "touch", "loading"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  window.addEventListener(
    "keydown",
    (e) => {
      if (["enter", "r", "m", "p", "escape", " "].includes(e.key.toLowerCase())) {
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  camera.position.set(0, WORLD_W * 0.35, WORLD_W * 0.27);
  camera.lookAt(0, 0, -20);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI / 2 - 0.06;
  controls.minDistance = 12;
  controls.maxDistance = WORLD_W * 1.3;

  const ground = game.scene.getObjectByName("terrain-ground");
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // --- State ---
  let tab: Tab = "props";
  let streetErase = false;
  const placed: Placed[] = [...CUSTOM_PROPS, ...loadLocalProps()].map((p) => ({
    entry: { model: p.model, u: p.u, v: p.v, yaw: p.yaw, s: p.s, ...(p.solid ? { solid: true } : {}) },
    node: null,
    baked: true,
  }));
  let selected: Placed | null = null;
  let selectedBox: THREE.BoxHelper | null = null;
  let palette: { cat: string; name: string } | null = null;
  let ghost: THREE.Object3D | null = null;
  let ghostYaw = 0;
  let ghostScale = 1;
  let ghostPos = new THREE.Vector3();
  let ghostOnGround = false;
  let paintDrag = false;
  let moveDrag = false;
  let stampLast: { x: number; z: number } | null = null;
  let floorKind: FloorKind | "erase" = "plaza";
  let streetsDirty = false;

  const overrides = loadLocalOverrides();
  const addSet = new Set(overrides.add.map(([a, b]) => `${a},${b}`));
  const removeSet = new Set(overrides.remove.map(([a, b]) => `${a},${b}`));
  const floorMap = new Map<string, FloorKind>(overrides.floor.map(([a, b, k]) => [`${a},${b}`, k]));
  const clearSet = new Set((overrides.clear ?? []).map(([a, b]) => `${a},${b}`));

  // --- Auto-save: every mutation persists immediately ---
  const saveNow = (): void => {
    const toPairs = (set: Set<string>): [number, number][] =>
      [...set].map((k) => {
        const [a, b] = k.split(",").map(Number);
        return [a ?? 0, b ?? 0];
      });
    const floor: [number, number, FloorKind][] = [...floorMap].map(([k, kind]) => {
      const [a, b] = k.split(",").map(Number);
      return [a ?? 0, b ?? 0, kind];
    });
    saveLocalOverrides({
      add: toPairs(addSet),
      remove: toPairs(removeSet),
      floor,
      clear: toPairs(clearSet),
    });
    saveLocalProps(placed.map((p) => p.entry));
    refreshStatus();
  };

  // --- Cell preview quads (streets + floors) ---
  const quads = new Map<string, THREE.Mesh>();
  const quadGeo = new THREE.PlaneGeometry(ROAD_TILE * 0.94, ROAD_TILE * 0.94).rotateX(-Math.PI / 2);
  const quadMats = new Map<string, THREE.MeshBasicMaterial>();
  const quadMat = (hex: number, opacity: number): THREE.MeshBasicMaterial => {
    const k = `${hex},${opacity}`;
    let m = quadMats.get(k);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity, depthWrite: false });
      quadMats.set(k, m);
    }
    return m;
  };
  const roadPadGeo = new THREE.PlaneGeometry(ROAD_TILE * 1.02, ROAD_TILE * 1.02).rotateX(-Math.PI / 2);
  const dashGeo = new THREE.PlaneGeometry(1.1, ROAD_TILE * 0.86).rotateX(-Math.PI / 2);
  const setQuad = (scope: "st" | "fl" | "cl", gx: number, gz: number, hex: number | null): void => {
    const k = `${scope}:${gx},${gz}`;
    const prev = quads.get(k);
    if (prev) {
      game.scene.remove(prev);
      quads.delete(k);
    }
    if (hex === null) return;
    const x = (gx + 0.5) * ROAD_TILE - WORLD_W / 2;
    const z = (gz + 0.5) * ROAD_TILE - WORLD_H / 2;
    const y = city.heightAt(x, z);
    let m: THREE.Object3D;
    if (scope === "st" && hex === 0xd23f34) {
      // erased street: patch the cell with ground tones — reads as REMOVED
      const grp = new THREE.Group();
      const patch = new THREE.Mesh(roadPadGeo, quadMat(0x9a9b92, 1));
      patch.position.y = 0.62;
      grp.add(patch);
      grp.position.set(x, y, z);
      m = grp;
    } else if (scope === "st" && hex === 0x2fbf4f) {
      // painted street: realtime road look (sidewalk pad + asphalt + dash)
      const grp = new THREE.Group();
      const pad = new THREE.Mesh(roadPadGeo, quadMat(0xb6b9b0, 0.95));
      pad.position.y = 0.5;
      const asphalt = new THREE.Mesh(quadGeo, quadMat(0x40454c, 0.98));
      asphalt.position.y = 0.56;
      const dash = new THREE.Mesh(dashGeo, quadMat(0xd8a23c, 0.95));
      dash.position.y = 0.6;
      grp.add(pad, asphalt, dash);
      grp.position.set(x, y, z);
      m = grp;
    } else {
      const quad = new THREE.Mesh(quadGeo, quadMat(hex, scope === "st" ? 0.5 : 0.65));
      quad.position.set(x, y + (scope === "st" ? 0.55 : 0.4), z);
      m = quad;
    }
    game.scene.add(m);
    quads.set(k, m as THREE.Mesh);
  };
  for (const k of addSet) {
    const [gx, gz] = k.split(",").map(Number);
    if (gx !== undefined && gz !== undefined) setQuad("st", gx, gz, 0x2fbf4f);
  }
  for (const k of removeSet) {
    const [gx, gz] = k.split(",").map(Number);
    if (gx !== undefined && gz !== undefined) setQuad("st", gx, gz, 0xd23f34);
  }
  for (const [k, kind] of floorMap) {
    const [gx, gz] = k.split(",").map(Number);
    if (gx !== undefined && gz !== undefined) setQuad("fl", gx, gz, FLOOR_COLORS[kind]);
  }
  for (const k of clearSet) {
    const [gx, gz] = k.split(",").map(Number);
    if (gx !== undefined && gz !== undefined) setQuad("cl", gx, gz, 0xe08030);
  }

  // --- UI ---
  injectStyle();
  const ui = document.createElement("div");
  ui.id = "cw-editor";
  const catTabs = CATEGORIES.map(
    (c, i) => `<button class="edc${i === 0 ? " on" : ""}" data-cat="${i}">${c.label}</button>`,
  ).join("");
  const floorButtons = (["plaza", "grass", "sand", "erase"] as const)
    .map((t) => {
      const hex = `#${FLOOR_COLORS[t].toString(16).padStart(6, "0")}`;
      return `<button class="edf${t === "plaza" ? " on" : ""}" data-floor="${t}"><i style="background:${hex}"></i>${t}</button>`;
    })
    .join("");
  ui.innerHTML = `
    <div class="ed-top">
      <span class="ed-logo">MAP EDITOR</span>
      <button id="ed-save">SAVE</button>
      <button id="ed-loadbtn">LOAD</button>
      <button id="ed-clear-props">CLEAR PROPS</button>
      <button id="ed-clear-map">RESET STREETS+FLOOR</button>
      <button id="ed-rot-l" title="rotate camera (Z)">⟲</button>
      <button id="ed-rot-r" title="rotate camera (X)">⟳</button>
      <span class="ed-status" id="ed-status"></span>
      <input type="file" id="ed-file" accept=".json,application/json" style="display:none">
    </div>
    <div class="ed-roster">
      <div class="ed-tabs">
        <button class="edt on" data-tab="props">PROPS</button>
        <button class="edt" data-tab="streets">STREETS</button>
        <button class="edt" data-tab="floor">FLOOR</button>
        <button class="edt" data-tab="clear">CLEAR</button>
      </div>
      <div id="ed-body-props" class="ed-tabbody">
        <div class="ed-cats">${catTabs}</div>
        <input id="ed-search" placeholder="search models…">
        <div class="ed-list" id="ed-list"></div>
        <div class="ed-inspector" id="ed-inspector" style="display:none">
          <div class="ed-i-model" id="ed-i-model"></div>
          <label>rot°<input id="ed-irot" type="number" step="15"></label>
          <label>scale<input id="ed-iscale" type="number" step="0.1" min="0.1" max="20"></label>
          <label class="edchk"><input id="ed-icol" type="checkbox">collidable</label>
          <button id="ed-idel">DELETE</button>
        </div>
      </div>
      <div id="ed-body-streets" class="ed-tabbody" style="display:none">
        <button class="edf eds on" id="ed-st-paint"><i style="background:#2fbf4f"></i>paint street</button>
        <button class="edf eds" id="ed-st-erase"><i style="background:#d23f34"></i>erase street</button>
        <div class="ed-note">Hover shows the cell; click/drag paints. Streets regenerate the world:</div>
        <button id="ed-rebuild">REBUILD WORLD</button>
      </div>
      <div id="ed-body-floor" class="ed-tabbody" style="display:none">
        ${floorButtons}
        <div class="ed-note">Hover shows the cell; click/drag paints the ground.</div>
      </div>
      <div id="ed-body-clear" class="ed-tabbody" style="display:none">
        <button class="edf on"><i style="background:#e08030"></i>clear cell</button>
        <div class="ed-note">Click/drag marks cells where GENERATED content (buildings, props, park tiles) is removed. Your own placed props are unaffected — select and Del those. Applies on rebuild:</div>
        <button id="ed-rebuild2">REBUILD WORLD</button>
      </div>
    </div>
    <canvas id="ed-minimap" width="200" height="164"></canvas>
    <div class="ed-help">click prop = select · drag = move · Q/E rotate · [ ] scale · Del delete · Esc done · left-drag pan · RMB orbit · Z/X rotate · wheel zoom · WASD pan · edits auto-save</div>`;
  document.body.appendChild(ui);

  const $ = (id: string): HTMLElement => {
    const el = ui.querySelector(`#${id}`);
    if (!(el instanceof HTMLElement)) throw new Error(`editor: missing #${id}`);
    return el;
  };

  const inspector = $("ed-inspector");
  const refreshInspector = (): void => {
    if (!selected) {
      inspector.style.display = "none";
      return;
    }
    inspector.style.display = "flex";
    $("ed-i-model").textContent = selected.entry.model;
    ($("ed-irot") as HTMLInputElement).value = String(Math.round((selected.entry.yaw * 180) / Math.PI));
    ($("ed-iscale") as HTMLInputElement).value = String(selected.entry.s);
    ($("ed-icol") as HTMLInputElement).checked = selected.entry.solid === true;
  };
  const refreshStatus = (): void => {
    const st = [];
    st.push(`${placed.length} props`);
    if (addSet.size || removeSet.size) st.push(`streets +${addSet.size} −${removeSet.size}`);
    if (floorMap.size) st.push(`floor ${floorMap.size}`);
    if (streetsDirty) st.push("● rebuild for streets");
    $("ed-status").textContent = st.join(" · ");
  };

  // --- Selection ---
  const deselect = (): void => {
    if (selectedBox) {
      game.scene.remove(selectedBox);
      selectedBox = null;
    }
    selected = null;
    refreshInspector();
    refreshStatus();
  };
  const select = (p: Placed): void => {
    deselect();
    selected = p;
    if (p.node) {
      selectedBox = new THREE.BoxHelper(p.node, 0xffd24a);
      game.scene.add(selectedBox);
    }
    refreshInspector();
    refreshStatus();
  };
  const moveSelected = (x: number, z: number): void => {
    if (!selected || !selected.node) return;
    selected.node.position.set(x, city.heightAt(x, z), z);
    selected.node.updateMatrixWorld(true);
    selected.entry.u = Math.round((x / WORLD_W + 0.5) * 10000) / 10000;
    selected.entry.v = Math.round((z / WORLD_H + 0.5) * 10000) / 10000;
    selectedBox?.update();
  };
  const deleteSelected = (): void => {
    if (!selected) return;
    if (selected.node) game.scene.remove(selected.node);
    const i = placed.indexOf(selected);
    if (i >= 0) placed.splice(i, 1);
    deselect();
    saveNow();
  };

  // Inspector bindings
  $("ed-irot").addEventListener("input", () => {
    if (!selected?.node) return;
    const deg = Number(($("ed-irot") as HTMLInputElement).value) || 0;
    selected.entry.yaw = Math.round(((deg * Math.PI) / 180) * 1000) / 1000;
    selected.node.rotation.y = selected.entry.yaw;
    selected.node.updateMatrixWorld(true);
    selectedBox?.update();
    saveNow();
  });
  $("ed-iscale").addEventListener("input", () => {
    if (!selected?.node) return;
    const v = Number(($("ed-iscale") as HTMLInputElement).value);
    if (!Number.isFinite(v) || v <= 0) return;
    selected.entry.s = Math.round(v * 100) / 100;
    selected.node.scale.setScalar(selected.entry.s);
    selected.node.updateMatrixWorld(true);
    selectedBox?.update();
    saveNow();
  });
  $("ed-icol").addEventListener("change", () => {
    if (!selected) return;
    if (($("ed-icol") as HTMLInputElement).checked) selected.entry.solid = true;
    else delete selected.entry.solid;
    saveNow();
  });
  $("ed-idel").addEventListener("click", deleteSelected);

  // --- Ghost (place-on-pick) ---
  const clearGhost = (): void => {
    if (ghost) game.scene.remove(ghost);
    ghost = null;
    palette = null;
    ui.querySelectorAll(".edp").forEach((b) => b.classList.remove("on"));
  };
  const setGhost = (cat: string, name: string): void => {
    if (ghost) game.scene.remove(ghost);
    deselect();
    palette = { cat, name };
    const url = modelUrl(cat, name);
    ghost = cache.instance(url);
    ghost.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.Material) {
        const m = c.material.clone();
        m.transparent = true;
        m.opacity = 0.65;
        c.material = m;
      }
    });
    ghostYaw = 0;
    ghostScale = defaultScale(cat, cache.bounds(url).size);
    ghost.scale.setScalar(ghostScale);
    ghost.rotation.y = ghostYaw;
    game.scene.add(ghost);
    ui.querySelectorAll(".edp").forEach((b) => {
      b.classList.toggle("on", (b as HTMLElement).dataset["model"] === `${cat}/${name}`);
    });
  };

  // --- Roster: thumbnails + search + category tabs ---
  const thumbCache = new Map<string, string>();
  const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(64, 64);
  const thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const thumbSun = new THREE.DirectionalLight(0xffffff, 2.2);
  thumbSun.position.set(3, 6, 4);
  thumbScene.add(thumbSun);
  const thumbCam = new THREE.PerspectiveCamera(30, 1, 0.05, 2000);
  const thumbnail = (cat: string, name: string): string => {
    const url = modelUrl(cat, name);
    const hit = thumbCache.get(url);
    if (hit) return hit;
    const node = cache.instance(url);
    thumbScene.add(node);
    const box = new THREE.Box3().setFromObject(node);
    const centre = box.getCenter(new THREE.Vector3());
    const span = Math.max(box.getSize(new THREE.Vector3()).length(), 0.001);
    thumbCam.position.set(centre.x + span * 0.75, centre.y + span * 0.6, centre.z + span * 0.75);
    thumbCam.lookAt(centre);
    thumbRenderer.render(thumbScene, thumbCam);
    const data = thumbRenderer.domElement.toDataURL();
    thumbScene.remove(node);
    thumbCache.set(url, data);
    return data;
  };

  let activeCat = 0;
  const list = $("ed-list");
  const renderList = (): void => {
    list.replaceChildren();
    const c = CATEGORIES[activeCat];
    if (!c) return;
    const q = (($("ed-search") as HTMLInputElement).value ?? "").trim().toLowerCase();
    for (const name of c.names) {
      if (q && !name.toLowerCase().includes(q)) continue;
      const btn = document.createElement("button");
      btn.className = `edp${palette?.name === name && palette.cat === c.cat ? " on" : ""}`;
      btn.dataset["model"] = `${c.cat}/${name}`;
      const img = document.createElement("img");
      img.src = thumbnail(c.cat, name);
      const label = document.createElement("span");
      label.textContent = name;
      btn.append(img, label);
      btn.addEventListener("click", () => {
        if (palette?.name === name && palette.cat === c.cat) clearGhost();
        else setGhost(c.cat, name);
      });
      list.appendChild(btn);
    }
  };
  ui.querySelectorAll<HTMLButtonElement>(".edc").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCat = Number(btn.dataset["cat"]) || 0;
      ui.querySelectorAll(".edc").forEach((b) => b.classList.toggle("on", b === btn));
      renderList();
    });
  });
  $("ed-search").addEventListener("input", renderList);
  renderList();

  // --- Tabs ---
  const setTab = (t: Tab): void => {
    tab = t;
    ui.querySelectorAll<HTMLButtonElement>(".edt").forEach((b) => {
      b.classList.toggle("on", b.dataset["tab"] === t);
    });
    $("ed-body-props").style.display = t === "props" ? "flex" : "none";
    $("ed-body-streets").style.display = t === "streets" ? "flex" : "none";
    $("ed-body-floor").style.display = t === "floor" ? "flex" : "none";
    $("ed-body-clear").style.display = t === "clear" ? "flex" : "none";
    controls.enablePan = t === "props";
    if (t !== "props") clearGhost();
    hoverQuad.visible = false;
  };
  ui.querySelectorAll<HTMLButtonElement>(".edt").forEach((btn) => {
    btn.addEventListener("click", () => setTab((btn.dataset["tab"] as Tab) ?? "props"));
  });
  $("ed-st-paint").addEventListener("click", () => {
    streetErase = false;
    $("ed-st-paint").classList.add("on");
    $("ed-st-erase").classList.remove("on");
  });
  $("ed-st-erase").addEventListener("click", () => {
    streetErase = true;
    $("ed-st-erase").classList.add("on");
    $("ed-st-paint").classList.remove("on");
  });
  for (const id of ["ed-rebuild", "ed-rebuild2"]) {
    $(id).addEventListener("click", () => {
      saveNow();
      window.location.reload();
    });
  }
  ui.querySelectorAll<HTMLButtonElement>(".edf").forEach((btn) => {
    btn.addEventListener("click", () => {
      floorKind = (btn.dataset["floor"] as FloorKind | "erase") ?? "plaza";
      ui.querySelectorAll(".edf").forEach((b) => b.classList.toggle("on", b === btn));
    });
  });

  // --- Top bar: save/load/clear ---
  const buildMapFile = (): string => {
    const toPairs = (set: Set<string>): number[][] => [...set].map((k) => k.split(",").map(Number));
    const floor = [...floorMap].map(([k, kind]) => [...k.split(",").map(Number), kind]);
    return JSON.stringify(
      {
        version: 1,
        streets: { add: toPairs(addSet), remove: toPairs(removeSet) },
        floor,
        props: placed.map((p) => p.entry),
        clear: toPairs(clearSet),
      },
      null,
      1,
    );
  };
  $("ed-save").addEventListener("click", () => {
    saveNow();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buildMapFile()], { type: "application/json" }));
    a.download = "crazy-waymo-map.json";
    a.click();
  });
  $("ed-loadbtn").addEventListener("click", () => $("ed-file").click());
  $("ed-file").addEventListener("change", async () => {
    const input = $("ed-file");
    if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return;
    try {
      const parsed = parseMapFile(JSON.parse(await input.files[0].text()));
      if (!parsed) return;
      saveLocalOverrides({
        add: parsed.streets.add,
        remove: parsed.streets.remove,
        floor: parsed.floor,
        clear: parsed.clear ?? [],
      });
      saveLocalProps(parsed.props);
      window.location.reload(); // rebuild the world from the loaded file
    } catch {
      // bad file — current session untouched
    }
  });
  $("ed-clear-props").addEventListener("click", () => {
    for (const p of placed) if (p.node) game.scene.remove(p.node);
    placed.length = 0;
    deselect();
    saveNow();
  });
  $("ed-rot-l").addEventListener("click", () => orbitBy(Math.PI / 8));
  $("ed-rot-r").addEventListener("click", () => orbitBy(-Math.PI / 8));
  $("ed-clear-map").addEventListener("click", () => {
    addSet.clear();
    removeSet.clear();
    floorMap.clear();
    clearSet.clear();
    for (const [, m] of quads) game.scene.remove(m);
    quads.clear();
    streetsDirty = true;
    saveNow();
  });

  // --- World spawning ---
  const spawn = (entry: Entry): THREE.Object3D => {
    const parts = entry.model.split("/");
    const node = cache.instance(modelUrl(parts[0] ?? "props", parts[1] ?? ""));
    node.scale.setScalar(entry.s);
    node.rotation.y = entry.yaw;
    const x = (entry.u - 0.5) * WORLD_W;
    const z = (entry.v - 0.5) * WORLD_H;
    node.position.set(x, city.heightAt(x, z), z);
    game.scene.add(node);
    return node;
  };
  const stampAt = (x: number, z: number): void => {
    if (!palette) return;
    const entry: Entry = {
      model: `${palette.cat}/${palette.name}`,
      u: Math.round((x / WORLD_W + 0.5) * 10000) / 10000,
      v: Math.round((z / WORLD_H + 0.5) * 10000) / 10000,
      yaw: Math.round(ghostYaw * 1000) / 1000,
      s: Math.round(ghostScale * 100) / 100,
    };
    placed.push({ entry, node: spawn(entry), baked: false });
    saveNow();
  };

  // --- Street + floor painting ---
  const isRoadCell = (gx: number, gz: number): boolean => {
    const col = city.plan.cells[gx];
    return col !== undefined && col[gz] === "road";
  };
  const paintStreet = (gx: number, gz: number, erase: boolean): void => {
    const k = `${gx},${gz}`;
    if (!erase) {
      if (removeSet.has(k)) {
        removeSet.delete(k);
        setQuad("st", gx, gz, null);
      } else if (!isRoadCell(gx, gz) && !addSet.has(k)) {
        addSet.add(k);
        setQuad("st", gx, gz, 0x2fbf4f);
      }
    } else if (addSet.has(k)) {
      addSet.delete(k);
      setQuad("st", gx, gz, null);
    } else if (isRoadCell(gx, gz) && !removeSet.has(k)) {
      removeSet.add(k);
      setQuad("st", gx, gz, 0xd23f34);
    }
    streetsDirty = true;
    saveNow();
  };
  const paintClear = (gx: number, gz: number): void => {
    const k = `${gx},${gz}`;
    if (clearSet.has(k)) {
      clearSet.delete(k);
      setQuad("cl", gx, gz, null);
    } else {
      clearSet.add(k);
      setQuad("cl", gx, gz, 0xe08030);
    }
    saveNow();
  };
  const paintFloor = (gx: number, gz: number): void => {
    const k = `${gx},${gz}`;
    if (floorKind === "erase") {
      floorMap.delete(k);
      setQuad("fl", gx, gz, null);
    } else {
      floorMap.set(k, floorKind);
      setQuad("fl", gx, gz, FLOOR_COLORS[floorKind]);
    }
    saveNow();
  };

  // --- Hover preview (streets/floor): a translucent cell follows the cursor ---
  const hoverQuad = new THREE.Mesh(quadGeo, quadMat(0x2fbf4f, 0.45));
  hoverQuad.visible = false;
  game.scene.add(hoverQuad);
  const updateHover = (e: PointerEvent): void => {
    if (tab !== "streets" && tab !== "floor" && tab !== "clear") {
      hoverQuad.visible = false;
      return;
    }
    const cell = groundCell(e);
    if (!cell) {
      hoverQuad.visible = false;
      return;
    }
    const [gx, gz] = cell;
    const hex =
      tab === "streets"
        ? streetErase
          ? 0xd23f34
          : 0x2fbf4f
        : tab === "clear"
          ? 0xe08030
          : FLOOR_COLORS[floorKind];
    hoverQuad.material = quadMat(hex, 0.45);
    const x = (gx + 0.5) * ROAD_TILE - WORLD_W / 2;
    const z = (gz + 0.5) * ROAD_TILE - WORLD_H / 2;
    hoverQuad.position.set(x, city.heightAt(x, z) + 0.7, z);
    hoverQuad.visible = true;
  };

  // --- Raycast helpers ---
  const castFrom = (e: PointerEvent): void => {
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  };
  const groundPoint = (e: PointerEvent): THREE.Vector3 | null => {
    if (!ground) return null;
    castFrom(e);
    const hit = raycaster.intersectObject(ground, true)[0];
    return hit ? hit.point : null;
  };
  const groundCell = (e: PointerEvent): [number, number] | null => {
    const p = groundPoint(e);
    if (!p) return null;
    return [Math.floor((p.x + WORLD_W / 2) / ROAD_TILE), Math.floor((p.z + WORLD_H / 2) / ROAD_TILE)];
  };
  const pickProp = (e: PointerEvent): Placed | null => {
    castFrom(e);
    const nodes: THREE.Object3D[] = [];
    for (const p of placed) if (p.node) nodes.push(p.node);
    if (nodes.length === 0) return null;
    const hit = raycaster.intersectObjects(nodes, true)[0];
    if (!hit) return null;
    let cur: THREE.Object3D | null = hit.object;
    while (cur) {
      const found = placed.find((p) => p.node === cur);
      if (found) return found;
      cur = cur.parent;
    }
    return null;
  };

  // --- Pointer flow ---
  const dom = renderer.domElement;
  dom.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (tab === "streets") {
      const cell = groundCell(e);
      if (cell) paintStreet(cell[0], cell[1], streetErase);
      paintDrag = true;
      return;
    }
    if (tab === "floor") {
      const cell = groundCell(e);
      if (cell) paintFloor(cell[0], cell[1]);
      paintDrag = true;
      return;
    }
    if (tab === "clear") {
      const cell = groundCell(e);
      if (cell) paintClear(cell[0], cell[1]);
      paintDrag = true;
      return;
    }
    // props tab: picking an existing prop wins over placing a new one.
    const hit = pickProp(e);
    if (hit && hit.node) {
      select(hit);
      moveDrag = true;
      controls.enabled = false;
      return;
    }
    if (ghost && ghostOnGround) {
      stampAt(ghostPos.x, ghostPos.z);
      stampLast = { x: ghostPos.x, z: ghostPos.z };
      paintDrag = true;
      controls.enabled = false;
      return;
    }
    deselect();
  });
  dom.addEventListener("pointermove", (e) => {
    updateHover(e);
    if (moveDrag && selected) {
      const p = groundPoint(e);
      if (p) moveSelected(p.x, p.z);
      return;
    }
    if (paintDrag && (e.buttons & 1) === 1) {
      if (tab === "streets") {
        const cell = groundCell(e);
        if (cell) paintStreet(cell[0], cell[1], streetErase);
        return;
      }
      if (tab === "floor") {
        const cell = groundCell(e);
        if (cell) paintFloor(cell[0], cell[1]);
        return;
      }
      if (tab === "clear") {
        const cell = groundCell(e);
        if (cell) paintClear(cell[0], cell[1]);
        return;
      }
      if (ghost && stampLast) {
        const p = groundPoint(e);
        if (p) {
          const box = new THREE.Box3().setFromObject(ghost);
          const spacing = Math.max(2.4, (box.max.x - box.min.x) * 1.1);
          if (Math.hypot(p.x - stampLast.x, p.z - stampLast.z) >= spacing) {
            stampAt(p.x, p.z);
            stampLast = { x: p.x, z: p.z };
          }
        }
      }
    }
    if (tab === "props" && ghost) {
      const p = groundPoint(e);
      if (p) {
        ghostPos = p;
        ghost.position.set(p.x, city.heightAt(p.x, p.z), p.z);
        ghostOnGround = true;
      }
    }
  });
  dom.addEventListener("pointerup", () => {
    if (moveDrag && selected) saveNow();
    paintDrag = false;
    moveDrag = false;
    stampLast = null;
    controls.enabled = true;
  });

  const orbitBy = (angle: number): void => {
    const off = new THREE.Vector3().subVectors(camera.position, controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    camera.position.copy(controls.target).add(off);
    camera.lookAt(controls.target);
  };

  // --- Keyboard ---
  window.addEventListener("keydown", (e) => {
    if (document.activeElement instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    const pan: readonly [number, number] | null =
      k === "w" || k === "arrowup"
        ? [0, -1]
        : k === "s" || k === "arrowdown"
          ? [0, 1]
          : k === "a" || k === "arrowleft"
            ? [-1, 0]
            : k === "d" || k === "arrowright"
              ? [1, 0]
              : null;
    if (pan) {
      const dist = camera.position.distanceTo(controls.target);
      const step = Math.max(6, dist * 0.05);
      const fwd = new THREE.Vector3().subVectors(controls.target, camera.position);
      fwd.y = 0;
      fwd.normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const move = new THREE.Vector3()
        .addScaledVector(right, pan[0] * step)
        .addScaledVector(fwd, -pan[1] * step);
      camera.position.add(move);
      controls.target.add(move);
      return;
    }
    if (k === "z" || k === "x") {
      orbitBy(k === "z" ? Math.PI / 12 : -Math.PI / 12);
      return;
    }
    if (k === "q" || k === "e") {
      const d = (k === "q" ? 1 : -1) * (Math.PI / 8);
      if (selected && selected.node) {
        selected.entry.yaw = Math.round((selected.entry.yaw + d) * 1000) / 1000;
        selected.node.rotation.y = selected.entry.yaw;
        selected.node.updateMatrixWorld(true);
        selectedBox?.update();
        refreshInspector();
        saveNow();
      } else {
        ghostYaw += d;
        if (ghost) ghost.rotation.y = ghostYaw;
      }
    } else if (k === "[" || k === "]") {
      const f = k === "]" ? 1.15 : 1 / 1.15;
      if (selected && selected.node) {
        selected.entry.s = Math.round(Math.max(0.1, Math.min(20, selected.entry.s * f)) * 100) / 100;
        selected.node.scale.setScalar(selected.entry.s);
        selected.node.updateMatrixWorld(true);
        selectedBox?.update();
        refreshInspector();
        saveNow();
      } else {
        ghostScale = Math.max(0.1, Math.min(20, ghostScale * f));
        if (ghost) ghost.scale.setScalar(ghostScale);
      }
    } else if (k === "escape") {
      if (selected) deselect();
      else if (ghost) {
        clearGhost();
      } else setTab("props");
    } else if (k === "delete" || k === "backspace") {
      if (selected) deleteSelected();
    }
  });

  // --- Minimap: plan overview, camera marker, click to jump ---
  {
    const mm = $("ed-minimap") as HTMLCanvasElement;
    const mctx = mm.getContext("2d");
    if (mctx) {
      const cells = city.plan.cells;
      const nx = cells.length;
      const nz = cells[0]?.length ?? 0;
      const base = document.createElement("canvas");
      base.width = mm.width;
      base.height = mm.height;
      const bctx = base.getContext("2d");
      if (bctx) {
        for (let gx = 0; gx < nx; gx++) {
          const col = cells[gx];
          if (!col) continue;
          for (let gz = 0; gz < nz; gz++) {
            const c = col[gz];
            bctx.fillStyle = c === "water" ? "#3f6f9f" : c === "road" ? "#9aa0a8" : "#39503b";
            bctx.fillRect((gx / nx) * mm.width, (gz / nz) * mm.height, mm.width / nx + 1, mm.height / nz + 1);
          }
        }
      }
      const draw = (): void => {
        mctx.drawImage(base, 0, 0);
        // camera target marker
        const u = controls.target.x / WORLD_W + 0.5;
        const v = controls.target.z / WORLD_H + 0.5;
        mctx.strokeStyle = "#ffd24a";
        mctx.lineWidth = 2;
        mctx.strokeRect(u * mm.width - 4, v * mm.height - 4, 8, 8);
        requestAnimationFrame(draw);
      };
      draw();
      mm.addEventListener("pointerdown", (e) => {
        const r = mm.getBoundingClientRect();
        const u = (e.clientX - r.left) / r.width;
        const v = (e.clientY - r.top) / r.height;
        const x = (u - 0.5) * WORLD_W;
        const z = (v - 0.5) * WORLD_H;
        const off = new THREE.Vector3().subVectors(camera.position, controls.target);
        controls.target.set(x, city.heightAt(x, z), z);
        camera.position.copy(controls.target).add(off);
      });
    }
  }

  setTab("props");
  refreshStatus();
  void controls;
}

let styled = false;
function injectStyle(): void {
  if (styled) return;
  styled = true;
  const s = document.createElement("style");
  s.textContent = `
#cw-editor{position:fixed;inset:0;z-index:40;pointer-events:none;font-family:ui-monospace,monospace;color:#fff}
#cw-editor button{pointer-events:auto;cursor:pointer;font:700 11px ui-monospace,monospace;color:#fff;background:rgba(30,38,60,.9);border:1px solid rgba(255,255,255,.18);border-radius:7px;padding:6px 10px}
#cw-editor button:hover{border-color:#ffd24a;color:#ffd24a}
#cw-editor input{pointer-events:auto;background:rgba(10,14,24,.9);border:1px solid rgba(255,255,255,.2);border-radius:6px;color:#fff;font:600 11px ui-monospace,monospace;padding:5px 7px}
#cw-editor .ed-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(#080a12ee,#080a1200)}
#cw-editor .ed-logo{font:900 italic 16px system-ui,sans-serif;letter-spacing:-1px;color:#ffd24a;margin-right:6px}
#cw-editor .ed-status{font:600 11px ui-monospace,monospace;opacity:.75;margin-left:auto}
#cw-editor .ed-roster{position:absolute;top:46px;left:10px;bottom:44px;width:238px;display:flex;flex-direction:column;gap:4px;background:rgba(8,10,18,.82);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px;pointer-events:auto}
#cw-editor .ed-cats{display:flex;flex-wrap:wrap;gap:3px}
#cw-editor .edc{font-size:9px;padding:4px 6px}
#cw-editor .edc.on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
#cw-editor .ed-roster input{width:100%;box-sizing:border-box}
#cw-editor .ed-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;min-height:0}
#cw-editor .edp{display:flex;align-items:center;gap:8px;text-align:left;background:rgba(20,26,42,.85);border-radius:6px;padding:5px 8px;font-weight:600}
#cw-editor .edp img{width:30px;height:30px;border-radius:5px;flex:none;background:#0a0e18}
#cw-editor .edp span{font-size:10px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#cw-editor .edp.on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
#cw-editor .ed-tabbody{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:5px;min-height:0}
#cw-editor .ed-tabs{display:flex;gap:4px}
#cw-editor .edt{flex:1}
#cw-editor .edt.on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
#cw-editor .ed-body{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:5px;min-height:0}
#cw-editor .edf{display:flex;align-items:center;gap:8px;text-align:left;background:rgba(20,26,42,.85);border-radius:6px;padding:6px 8px}
#cw-editor .edf i{display:inline-block;width:16px;height:16px;border-radius:4px;border:1px solid rgba(255,255,255,.35);flex:none}
#cw-editor .edf.on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
#cw-editor .eds.on{border-color:#ffd24a;color:#ffd24a;background:rgba(64,54,20,.9)}
#cw-editor .ed-note{font:600 9px ui-monospace,monospace;opacity:.45;padding:8px 2px;line-height:1.4}
#cw-editor .ed-inspector{display:flex;flex-direction:column;gap:6px}
#cw-editor .ed-i-model{font:800 13px ui-monospace,monospace;color:#ffd24a;word-break:break-all}
#cw-editor .ed-inspector label{display:flex;align-items:center;justify-content:space-between;gap:8px;font:600 11px ui-monospace,monospace;opacity:.9}
#cw-editor .ed-inspector label input[type=number]{width:100px}
#cw-editor .ed-inspector .edchk{justify-content:flex-start}
#cw-editor #ed-idel{background:#5a2030;border-color:#a04050}
#cw-editor #ed-rebuild{background:#274a7a}
#cw-editor #ed-minimap{position:absolute;right:10px;bottom:44px;width:200px;height:164px;border:1px solid rgba(255,255,255,.25);border-radius:8px;background:#0a0e18;pointer-events:auto;cursor:crosshair}
#cw-editor .ed-help{position:absolute;left:0;right:0;bottom:0;text-align:center;padding:8px;font:600 11px ui-monospace,monospace;opacity:.55;background:linear-gradient(#080a1200,#080a12dd)}
`;
  document.head.appendChild(s);
}
