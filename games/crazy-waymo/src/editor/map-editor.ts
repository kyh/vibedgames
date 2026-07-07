import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";

import {
  BUILDINGS_COMMERCIAL,
  BUILDINGS_INDUSTRIAL,
  BUILDINGS_SKYSCRAPER,
  BUILDINGS_SUBURBAN,
  CHARACTERS,
  modelUrl,
  PROPS,
  SERVICE_CARS,
  TRAFFIC_CARS,
} from "../assets/manifest";
import type { GameScene } from "../scenes/game-scene";
import {
  type FloorKind,
  loadLocalOverrides,
  saveLocalOverrides,
} from "../world/custom-map";
import { ROAD_TILE, WORLD_H, WORLD_W } from "../shared/constants";
import { CUSTOM_PROPS } from "../world/custom-props";
import { loadLocalProps, parseMapFile, saveLocalProps } from "../world/map-file";

// The map editor (?editor=1). SimCity-style modes:
//   Navigate — pure camera (drag pan, right-drag orbit, wheel zoom, WASD).
//   Place — pick a model, click to drop, HOLD + DRAG to stamp a trail of
//           copies; click any placed prop to select it, drag it to move,
//           Q/E rotate · [ ] scale · Delete removes.
//   Streets — paint/erase road cells (green/red preview, Apply regenerates).
//   Floor — paint ground surface (plaza/grass/sand) per cell.
// Street + floor edits persist per-browser and export as JSON for
// world/custom-map.ts; props export for world/custom-props.ts.

type Entry = {
  model: string;
  u: number;
  v: number;
  yaw: number;
  s: number;
  solid?: boolean;
};

type Placed = { entry: Entry; node: THREE.Object3D | null; baked: boolean };

type Mode = "nav" | "place" | "street-paint" | "street-erase" | "floor";

const CATEGORIES: readonly { label: string; cat: string; names: readonly string[] }[] = [
  { label: "Props", cat: "props", names: PROPS },
  { label: "Houses", cat: "buildings", names: BUILDINGS_SUBURBAN },
  { label: "Commercial", cat: "buildings", names: [...BUILDINGS_COMMERCIAL, ...BUILDINGS_SKYSCRAPER] },
  { label: "Industrial", cat: "buildings", names: BUILDINGS_INDUSTRIAL },
  { label: "Cars", cat: "cars", names: [...TRAFFIC_CARS, ...SERVICE_CARS, "waymo", "police"] },
  { label: "People", cat: "characters", names: CHARACTERS },
];

const FLOOR_COLORS: Record<FloorKind, number> = {
  plaza: 0xcfd2cc,
  grass: 0x63a860,
  sand: 0xd9c489,
};

const PANEL_CSS = `position:fixed;top:0;right:0;bottom:0;width:262px;z-index:50;
background:rgba(14,13,20,.94);color:#eee;font:12px ui-monospace,Menlo,monospace;
padding:10px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;`;
const BTN = `background:#2a2733;color:#eee;border:1px solid #4a4657;border-radius:6px;
padding:4px 8px;margin:1px;cursor:pointer;font:11px ui-monospace,monospace;`;
const BTN_ON = BTN.replace("#2a2733", "#8a6d1f");

export function startEditor(game: GameScene, renderer: THREE.WebGLRenderer): void {
  const city = game.getCity();
  if (!city) return;
  const cache = game.getCache();
  const camera = game.camera;

  game.freecam = true;
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
  let mode: Mode = "nav";
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

  const overrides = loadLocalOverrides();
  const addSet = new Set(overrides.add.map(([a, b]) => `${a},${b}`));
  const removeSet = new Set(overrides.remove.map(([a, b]) => `${a},${b}`));
  const floorMap = new Map<string, FloorKind>(overrides.floor.map(([a, b, k]) => [`${a},${b}`, k]));

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
  const setQuad = (scope: "st" | "fl", gx: number, gz: number, hex: number | null): void => {
    const k = `${scope}:${gx},${gz}`;
    const prev = quads.get(k);
    if (prev) {
      game.scene.remove(prev);
      quads.delete(k);
    }
    if (hex === null) return;
    const m = new THREE.Mesh(quadGeo, quadMat(hex, scope === "st" ? 0.5 : 0.65));
    const x = (gx + 0.5) * ROAD_TILE - WORLD_W / 2;
    const z = (gz + 0.5) * ROAD_TILE - WORLD_H / 2;
    m.position.set(x, city.heightAt(x, z) + (scope === "st" ? 0.55 : 0.4), z);
    game.scene.add(m);
    quads.set(k, m);
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

  // --- Panel DOM ---
  const panel = document.createElement("div");
  panel.setAttribute("style", PANEL_CSS);
  panel.innerHTML = `
    <div style="font-weight:700;color:#ffd147">MAP EDITOR</div>
    <div id="ed-modes"></div>
    <div id="ed-status" style="color:#8fd9ff;min-height:26px"></div>
    <div id="ed-help" style="opacity:.7;line-height:1.45"></div>
    <div id="ed-floor-row" style="display:none"></div>
    <div id="ed-place-ui" style="display:none">
      <div id="ed-tabs"></div>
      <div id="ed-models" style="max-height:300px;overflow-y:auto;border:1px solid #333;border-radius:6px;padding:4px;margin-top:4px"></div>
    </div>
    <div style="font-weight:700;margin-top:2px">Map edits</div>
    <div id="ed-map-status" style="opacity:.75"></div>
    <button id="ed-apply" style="${BTN}background:#1f4a6a">Apply &amp; reload</button>
    <button id="ed-map-copy" style="${BTN}">Copy map JSON (custom-map.ts)</button>
    <button id="ed-map-clear" style="${BTN}background:#5a1f1f">Clear street + floor edits</button>
    <div style="font-weight:700;margin-top:2px">Props (<span id="ed-count">0</span>)</div>
    <button id="ed-copy" style="${BTN}background:#1f5a2a">Copy props JSON (custom-props.ts)</button>
    <textarea id="ed-io" rows="3" style="background:#191722;color:#bbb;border:1px solid #333;border-radius:6px;font:10px monospace" placeholder="JSON appears here on copy; paste + Load to import"></textarea>
    <button id="ed-load" style="${BTN}">Load props JSON from box</button>
    <button id="ed-save-file" style="${BTN}background:#274a7a">Save map file (.json)</button>
    <button id="ed-load-file" style="${BTN}">Load map file…</button>
    <input id="ed-file" type="file" accept=".json,application/json" style="display:none" />
  `;
  document.body.appendChild(panel);

  const $ = (id: string): HTMLElement => {
    const el = panel.querySelector(`#${id}`);
    if (!(el instanceof HTMLElement)) throw new Error(`editor: missing #${id}`);
    return el;
  };

  const HELP: Record<Mode, string> = {
    nav: "drag = pan · right-drag = orbit · wheel = zoom · WASD/arrows = pan<br>click a placed prop to select it",
    place:
      "pick a model, click to drop · <b>hold + drag</b> stamps copies<br>click a placed prop = select · drag it = move · <b>Q/E</b> rotate · <b>[ ]</b> scale · <b>Del</b> remove · <b>Esc</b> done",
    "street-paint": "left-click / drag paints street cells (green preview)<br>Apply &amp; reload regenerates the whole city",
    "street-erase": "left-click / drag removes street cells (red preview)",
    floor: "pick a surface, left-click / drag paints the ground per cell",
  };

  const refreshStatus = (): void => {
    const sel = selected
      ? `selected: ${selected.entry.model.split("/")[1] ?? selected.entry.model}${selected.baked ? " [baked]" : ""}`
      : palette && mode === "place"
        ? `placing: ${palette.name} · yaw ${Math.round((ghostYaw * 180) / Math.PI)}° · scale ${ghostScale.toFixed(2)}`
        : "";
    $("ed-status").innerHTML = sel;
    $("ed-help").innerHTML = HELP[mode];
    $("ed-map-status").textContent =
      `streets +${addSet.size} −${removeSet.size} · floor ${floorMap.size} cells (preview until Apply)`;
    $("ed-count").textContent = String(placed.length);
  };

  // --- Selection ---
  const deselect = (): void => {
    if (selectedBox) {
      game.scene.remove(selectedBox);
      selectedBox = null;
    }
    selected = null;
    refreshStatus();
  };
  const select = (p: Placed): void => {
    deselect();
    selected = p;
    if (p.node) {
      selectedBox = new THREE.BoxHelper(p.node, 0xffd147);
      game.scene.add(selectedBox);
    }
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
  };

  // --- Ghost (Place mode) ---
  const clearGhost = (): void => {
    if (ghost) game.scene.remove(ghost);
    ghost = null;
    palette = null;
    refreshStatus();
  };
  const setGhost = (cat: string, name: string): void => {
    if (ghost) game.scene.remove(ghost);
    deselect();
    palette = { cat, name };
    ghost = cache.instance(modelUrl(cat, name));
    ghost.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.Material) {
        const m = c.material.clone();
        m.transparent = true;
        m.opacity = 0.65;
        c.material = m;
      }
    });
    ghost.scale.setScalar(ghostScale);
    ghost.rotation.y = ghostYaw;
    game.scene.add(ghost);
    refreshStatus();
  };

  // --- Mode toolbar ---
  const modeButtons = new Map<Mode, HTMLButtonElement>();
  const setMode = (m: Mode): void => {
    mode = m;
    for (const [k, b] of modeButtons) b.setAttribute("style", k === m ? BTN_ON : BTN);
    $("ed-place-ui").style.display = m === "place" ? "block" : "none";
    $("ed-floor-row").style.display = m === "floor" ? "block" : "none";
    // Painting owns the left button; navigation keeps orbit + wheel.
    controls.enablePan = m === "nav" || m === "place";
    if (m !== "place") clearGhost();
    refreshStatus();
  };
  for (const [m, label] of [
    ["nav", "🧭 Navigate"],
    ["place", "🏠 Place"],
    ["street-paint", "🛣 +Street"],
    ["street-erase", "⌫ −Street"],
    ["floor", "🟩 Floor"],
  ] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.setAttribute("style", BTN);
    b.addEventListener("click", () => setMode(m));
    modeButtons.set(m, b);
    $("ed-modes").appendChild(b);
  }

  // Floor kind row
  {
    const row = $("ed-floor-row");
    for (const kind of ["plaza", "grass", "sand", "erase"] as const) {
      const b = document.createElement("button");
      b.textContent = kind;
      b.setAttribute("style", kind === floorKind ? BTN_ON : BTN);
      b.addEventListener("click", () => {
        floorKind = kind;
        for (const child of Array.from(row.children)) {
          child.setAttribute("style", child === b ? BTN_ON : BTN);
        }
      });
      row.appendChild(b);
    }
  }

  // --- Palette (Place mode): thumbnail cards rendered from the models ---
  const thumbCache = new Map<string, string>();
  const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(96, 96);
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

  const tabs = $("ed-tabs");
  const models = $("ed-models");
  let activeTab = 0;
  const renderModels = (): void => {
    models.replaceChildren();
    const c = CATEGORIES[activeTab];
    if (!c) return;
    for (const name of c.names) {
      const card = document.createElement("button");
      card.setAttribute(
        "style",
        `${palette?.name === name ? BTN_ON : BTN}width:31%;padding:3px;display:inline-flex;flex-direction:column;align-items:center;gap:2px;vertical-align:top`,
      );
      const img = document.createElement("img");
      img.src = thumbnail(c.cat, name);
      img.setAttribute("style", "width:100%;aspect-ratio:1;border-radius:4px;background:#211f2b");
      const label = document.createElement("span");
      label.textContent = name;
      label.setAttribute("style", "font-size:9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap");
      card.append(img, label);
      card.addEventListener("click", () => {
        setGhost(c.cat, name);
        renderModels();
      });
      models.appendChild(card);
    }
  };
  CATEGORIES.forEach((c, i) => {
    const b = document.createElement("button");
    b.textContent = c.label;
    b.setAttribute("style", i === activeTab ? BTN_ON : BTN);
    b.addEventListener("click", () => {
      activeTab = i;
      for (const child of Array.from(tabs.children)) {
        child.setAttribute("style", child === b ? BTN_ON : BTN);
      }
      renderModels();
    });
    tabs.appendChild(b);
  });
  renderModels();

  // --- Spawning ---
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
    refreshStatus();
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
    refreshStatus();
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
    refreshStatus();
  };
  const saveOverrides = (): void => {
    const toPairs = (set: Set<string>): [number, number][] =>
      [...set].map((k) => {
        const [a, b] = k.split(",").map(Number);
        return [a ?? 0, b ?? 0];
      });
    const floor: [number, number, FloorKind][] = [...floorMap].map(([k, kind]) => {
      const [a, b] = k.split(",").map(Number);
      return [a ?? 0, b ?? 0, kind];
    });
    saveLocalOverrides({ add: toPairs(addSet), remove: toPairs(removeSet), floor });
    saveLocalProps(placed.map((p) => p.entry));
  };

  $("ed-apply").addEventListener("click", () => {
    saveOverrides();
    window.location.reload();
  });
  $("ed-map-clear").addEventListener("click", () => {
    addSet.clear();
    removeSet.clear();
    floorMap.clear();
    for (const [, m] of quads) game.scene.remove(m);
    quads.clear();
    saveOverrides();
    refreshStatus();
  });
  $("ed-map-copy").addEventListener("click", () => {
    const toPairs = (set: Set<string>): number[][] => [...set].map((k) => k.split(",").map(Number));
    const floor = [...floorMap].map(([k, kind]) => [...k.split(",").map(Number), kind]);
    const json = JSON.stringify({ add: toPairs(addSet), remove: toPairs(removeSet), floor });
    const io = $("ed-io");
    if (io instanceof HTMLTextAreaElement) io.value = json;
    void navigator.clipboard?.writeText(json).catch(() => undefined);
  });
  $("ed-copy").addEventListener("click", () => {
    const json = JSON.stringify(placed.map((p) => p.entry), null, 2);
    const io = $("ed-io");
    if (io instanceof HTMLTextAreaElement) io.value = json;
    void navigator.clipboard?.writeText(json).catch(() => undefined);
  });
  const buildMapFile = (): string => {
    const toPairs = (set: Set<string>): number[][] => [...set].map((k) => k.split(",").map(Number));
    const floor = [...floorMap].map(([k, kind]) => [...k.split(",").map(Number), kind]);
    return JSON.stringify(
      {
        version: 1,
        streets: { add: toPairs(addSet), remove: toPairs(removeSet) },
        floor,
        props: placed.map((p) => p.entry),
      },
      null,
      1,
    );
  };
  $("ed-save-file").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buildMapFile()], { type: "application/json" }));
    a.download = "crazy-waymo-map.json";
    a.click();
  });
  $("ed-load-file").addEventListener("click", () => $("ed-file").click());
  $("ed-file").addEventListener("change", async () => {
    const input = $("ed-file");
    if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return;
    try {
      const parsed = parseMapFile(JSON.parse(await input.files[0].text()));
      if (!parsed) return;
      addSet.clear();
      removeSet.clear();
      floorMap.clear();
      for (const [a, b] of parsed.streets.add) addSet.add(`${a},${b}`);
      for (const [a, b] of parsed.streets.remove) removeSet.add(`${a},${b}`);
      for (const [a, b, kind] of parsed.floor) floorMap.set(`${a},${b}`, kind);
      saveLocalOverrides({ add: parsed.streets.add, remove: parsed.streets.remove, floor: parsed.floor });
      saveLocalProps(parsed.props);
      window.location.reload(); // rebuild the world from the loaded file
    } catch {
      // bad file — leave the current session untouched
    }
  });
  $("ed-load").addEventListener("click", () => {
    const io = $("ed-io");
    if (!(io instanceof HTMLTextAreaElement) || !io.value.trim()) return;
    try {
      const arr: unknown = JSON.parse(io.value);
      if (!Array.isArray(arr)) return;
      for (const p of placed) if (p.node) game.scene.remove(p.node);
      placed.length = 0;
      deselect();
      for (const raw of arr) {
        if (typeof raw !== "object" || raw === null) continue;
        if (!("model" in raw) || !("u" in raw) || !("v" in raw)) continue;
        const { model, u, v } = raw;
        if (typeof model !== "string" || typeof u !== "number" || typeof v !== "number") continue;
        const entry: Entry = {
          model,
          u,
          v,
          yaw: "yaw" in raw && typeof raw.yaw === "number" ? raw.yaw : 0,
          s: "s" in raw && typeof raw.s === "number" ? raw.s : 1,
          ...("solid" in raw && raw.solid === true ? { solid: true } : {}),
        };
        placed.push({ entry, node: spawn(entry), baked: false });
      }
      refreshStatus();
    } catch {
      io.value = "!! invalid JSON";
    }
  });

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
    // Walk up to the placed root.
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
    if (mode === "street-paint" || mode === "street-erase") {
      const cell = groundCell(e);
      if (cell) paintStreet(cell[0], cell[1], mode === "street-erase");
      paintDrag = true;
      return;
    }
    if (mode === "floor") {
      const cell = groundCell(e);
      if (cell) paintFloor(cell[0], cell[1]);
      paintDrag = true;
      return;
    }
    // nav/place: picking an existing prop wins over placing a new one.
    const hit = pickProp(e);
    if (hit && hit.node) {
      select(hit);
      moveDrag = true;
      controls.enabled = false;
      return;
    }
    if (mode === "place" && ghost && ghostOnGround) {
      stampAt(ghostPos.x, ghostPos.z);
      stampLast = { x: ghostPos.x, z: ghostPos.z };
      paintDrag = true;
      controls.enabled = false;
      return;
    }
    deselect();
  });
  dom.addEventListener("pointermove", (e) => {
    if (moveDrag && selected) {
      const p = groundPoint(e);
      if (p) moveSelected(p.x, p.z);
      return;
    }
    if (paintDrag && (e.buttons & 1) === 1) {
      if (mode === "street-paint" || mode === "street-erase") {
        const cell = groundCell(e);
        if (cell) paintStreet(cell[0], cell[1], mode === "street-erase");
        return;
      }
      if (mode === "floor") {
        const cell = groundCell(e);
        if (cell) paintFloor(cell[0], cell[1]);
        return;
      }
      if (mode === "place" && ghost && stampLast) {
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
    if (mode === "place" && ghost) {
      const p = groundPoint(e);
      if (p) {
        ghostPos = p;
        ghost.position.set(p.x, city.heightAt(p.x, p.z), p.z);
        ghostOnGround = true;
      }
    }
  });
  dom.addEventListener("pointerup", () => {
    paintDrag = false;
    moveDrag = false;
    stampLast = null;
    controls.enabled = true;
  });

  // --- Keyboard ---
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    // WASD / arrows pan the camera on the ground plane.
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
    if (k === "q" || k === "e") {
      const d = (k === "q" ? 1 : -1) * (Math.PI / 8);
      if (selected && selected.node) {
        selected.entry.yaw = Math.round((selected.entry.yaw + d) * 1000) / 1000;
        selected.node.rotation.y = selected.entry.yaw;
        selected.node.updateMatrixWorld(true);
        selectedBox?.update();
      } else {
        ghostYaw += d;
        if (ghost) ghost.rotation.y = ghostYaw;
      }
      refreshStatus();
    } else if (k === "[" || k === "]") {
      const f = k === "]" ? 1.15 : 1 / 1.15;
      if (selected && selected.node) {
        selected.entry.s = Math.round(Math.max(0.1, Math.min(20, selected.entry.s * f)) * 100) / 100;
        selected.node.scale.setScalar(selected.entry.s);
        selected.node.updateMatrixWorld(true);
        selectedBox?.update();
      } else {
        ghostScale = Math.max(0.1, Math.min(20, ghostScale * f));
        if (ghost) ghost.scale.setScalar(ghostScale);
      }
      refreshStatus();
    } else if (k === "escape") {
      if (selected) deselect();
      else if (ghost) {
        clearGhost();
        renderModels();
      } else setMode("nav");
    } else if (k === "delete" || k === "backspace") {
      if (selected) deleteSelected();
      else {
        const last = placed[placed.length - 1];
        if (last && !last.baked) {
          if (last.node) game.scene.remove(last.node);
          placed.pop();
          refreshStatus();
        }
      }
    }
  });

  setMode("nav");
  void controls;
}
