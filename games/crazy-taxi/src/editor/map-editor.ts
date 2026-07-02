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
import { WORLD_SIZE } from "../shared/constants";
import { CUSTOM_PROPS, type CustomProp } from "../world/custom-props";

// The map editor (?editor=1): fly around the built city, place assets on the
// terrain, and export the placements as JSON for world/custom-props.ts.
// Existing custom props load into the list as [baked] rows — they're already
// merged into the city, so edits to them apply on the next reload.

type Entry = {
  model: string;
  u: number;
  v: number;
  yaw: number;
  s: number;
  solid?: boolean;
};

type Placed = { entry: Entry; node: THREE.Object3D | null; baked: boolean };

const CATEGORIES: readonly { label: string; cat: string; names: readonly string[] }[] = [
  { label: "Props", cat: "props", names: PROPS },
  { label: "Houses", cat: "buildings", names: BUILDINGS_SUBURBAN },
  { label: "Commercial", cat: "buildings", names: [...BUILDINGS_COMMERCIAL, ...BUILDINGS_SKYSCRAPER] },
  { label: "Industrial", cat: "buildings", names: BUILDINGS_INDUSTRIAL },
  { label: "Cars", cat: "cars", names: [...TRAFFIC_CARS, ...SERVICE_CARS, "taxi", "police"] },
  { label: "People", cat: "characters", names: CHARACTERS },
];

const PANEL_CSS = `position:fixed;top:0;right:0;bottom:0;width:250px;z-index:50;
background:rgba(14,13,20,.92);color:#eee;font:12px ui-monospace,Menlo,monospace;
padding:10px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;`;
const BTN = `background:#2a2733;color:#eee;border:1px solid #4a4657;border-radius:6px;
padding:3px 7px;margin:1px;cursor:pointer;font:11px ui-monospace,monospace;`;
const BTN_ON = BTN.replace("#2a2733", "#8a6d1f");

export function startEditor(game: GameScene, renderer: THREE.WebGLRenderer): void {
  const city = game.getCity();
  if (!city) return;
  const cache = game.getCache();
  const camera = game.camera;

  // Take the camera away from the game and hide the play UI.
  game.freecam = true;
  for (const id of ["hud", "banner", "legend", "touch", "loading"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  // Swallow the game's hotkeys (capture phase runs before the game's window
  // listeners while events bubble up from the canvas).
  window.addEventListener(
    "keydown",
    (e) => {
      if (["enter", "r", "m", "p", "escape", " "].includes(e.key.toLowerCase())) {
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  camera.position.set(0, 170, 130);
  camera.lookAt(0, 0, -20);
  const controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI / 2 - 0.06;
  controls.minDistance = 12;
  controls.maxDistance = 600;

  const ground = game.scene.getObjectByName("terrain-ground");
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const placed: Placed[] = CUSTOM_PROPS.map((p) => ({
    entry: { model: p.model, u: p.u, v: p.v, yaw: p.yaw, s: p.s, ...(p.solid ? { solid: true } : {}) },
    node: null,
    baked: true,
  }));

  let selected: { cat: string; name: string } | null = null;
  let ghost: THREE.Object3D | null = null;
  let ghostYaw = 0;
  let ghostScale = 1;
  let ghostPos = new THREE.Vector3();
  let ghostOnGround = false;

  const setGhost = (cat: string, name: string): void => {
    if (ghost) game.scene.remove(ghost);
    selected = { cat, name };
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
  const clearGhost = (): void => {
    if (ghost) game.scene.remove(ghost);
    ghost = null;
    selected = null;
    refreshStatus();
  };

  // --- Panel DOM ---
  const panel = document.createElement("div");
  panel.setAttribute("style", PANEL_CSS);
  panel.innerHTML = `
    <div style="font-weight:700;color:#ffd147">MAP EDITOR</div>
    <div style="opacity:.75;line-height:1.5">drag = pan · right-drag = orbit · wheel = zoom<br>
    click = place · <b>Q/E</b> rotate · <b>[ ]</b> scale · <b>Esc</b> deselect · <b>Backspace</b> undo</div>
    <div id="ed-status" style="color:#8fd9ff"></div>
    <div id="ed-tabs"></div>
    <div id="ed-models" style="max-height:200px;overflow-y:auto;border:1px solid #333;border-radius:6px;padding:4px"></div>
    <div style="font-weight:700">Placed (<span id="ed-count">0</span>)</div>
    <div id="ed-list" style="max-height:160px;overflow-y:auto;border:1px solid #333;border-radius:6px;padding:4px"></div>
    <button id="ed-copy" style="${BTN}background:#1f5a2a">Copy JSON for custom-props.ts</button>
    <textarea id="ed-io" rows="4" style="background:#191722;color:#bbb;border:1px solid #333;border-radius:6px;font:10px monospace" placeholder="JSON appears here on copy; paste + Load to import"></textarea>
    <button id="ed-load" style="${BTN}">Load JSON from box</button>
    <div style="opacity:.6">[baked] rows are already merged into the city — deletes/edits to them apply after you paste the JSON into custom-props.ts and reload.</div>
  `;
  document.body.appendChild(panel);

  const $ = (id: string): HTMLElement => {
    const el = panel.querySelector(`#${id}`);
    if (!(el instanceof HTMLElement)) throw new Error(`editor: missing #${id}`);
    return el;
  };

  const refreshStatus = (): void => {
    $("ed-status").textContent = selected
      ? `placing: ${selected.name} · yaw ${Math.round((ghostYaw * 180) / Math.PI)}° · scale ${ghostScale.toFixed(2)}`
      : "nothing selected — pick a model";
  };

  const refreshList = (): void => {
    $("ed-count").textContent = String(placed.length);
    const list = $("ed-list");
    list.replaceChildren();
    placed.forEach((p, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;gap:4px;padding:1px 0";
      const label = document.createElement("span");
      label.textContent = `${p.baked ? "[baked] " : ""}${p.entry.model.split("/")[1] ?? p.entry.model}`;
      label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      const del = document.createElement("button");
      del.textContent = "✕";
      del.setAttribute("style", BTN + "padding:0 5px");
      del.addEventListener("click", () => {
        if (p.node) game.scene.remove(p.node);
        placed.splice(i, 1);
        refreshList();
      });
      row.append(label, del);
      list.appendChild(row);
    });
  };

  // Category tabs + model buttons.
  const tabs = $("ed-tabs");
  const models = $("ed-models");
  let activeTab = 0;
  const renderModels = (): void => {
    models.replaceChildren();
    const c = CATEGORIES[activeTab];
    if (!c) return;
    for (const name of c.names) {
      const b = document.createElement("button");
      b.textContent = name;
      b.setAttribute("style", selected?.name === name ? BTN_ON : BTN);
      b.addEventListener("click", () => {
        setGhost(c.cat, name);
        renderModels();
      });
      models.appendChild(b);
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
  refreshList();
  refreshStatus();

  // --- Export / import ---
  $("ed-copy").addEventListener("click", () => {
    const json = JSON.stringify(
      placed.map((p) => p.entry),
      null,
      2,
    );
    const io = $("ed-io");
    if (io instanceof HTMLTextAreaElement) io.value = json;
    void navigator.clipboard?.writeText(json).catch(() => undefined);
  });
  $("ed-load").addEventListener("click", () => {
    const io = $("ed-io");
    if (!(io instanceof HTMLTextAreaElement) || !io.value.trim()) return;
    try {
      const arr: unknown = JSON.parse(io.value);
      if (!Array.isArray(arr)) return;
      for (const p of placed) if (p.node) game.scene.remove(p.node);
      placed.length = 0;
      for (const raw of arr) {
        if (typeof raw !== "object" || raw === null) continue;
        if (!("model" in raw) || !("u" in raw) || !("v" in raw)) continue;
        const { model, u, v } = raw;
        if (typeof model !== "string" || typeof u !== "number" || typeof v !== "number") {
          continue;
        }
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
      refreshList();
    } catch {
      io.value = "!! invalid JSON";
    }
  });

  const spawn = (entry: Entry): THREE.Object3D => {
    const parts = entry.model.split("/");
    const node = cache.instance(modelUrl(parts[0] ?? "props", parts[1] ?? ""));
    node.scale.setScalar(entry.s);
    node.rotation.y = entry.yaw;
    const x = (entry.u - 0.5) * WORLD_SIZE;
    const z = (entry.v - 0.5) * WORLD_SIZE;
    node.position.set(x, city.heightAt(x, z), z);
    game.scene.add(node);
    return node;
  };

  // --- Pointer: ghost follows the terrain; a non-drag click places. ---
  const dom = renderer.domElement;
  let downAt: { x: number; y: number } | null = null;
  dom.addEventListener("pointermove", (e) => {
    if (!ghost || !ground) return;
    pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(ground, false);
    const hit = hits[0];
    if (hit) {
      ghostPos = hit.point;
      ghost.position.set(ghostPos.x, city.heightAt(ghostPos.x, ghostPos.z), ghostPos.z);
      ghostOnGround = true;
    }
  });
  dom.addEventListener("pointerdown", (e) => {
    if (e.button === 0) downAt = { x: e.clientX, y: e.clientY };
  });
  dom.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || !downAt) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    downAt = null;
    if (moved > 5 || !ghost || !selected || !ghostOnGround) return;
    const entry: Entry = {
      model: `${selected.cat}/${selected.name}`,
      u: Math.round((ghostPos.x / WORLD_SIZE + 0.5) * 10000) / 10000,
      v: Math.round((ghostPos.z / WORLD_SIZE + 0.5) * 10000) / 10000,
      yaw: Math.round(ghostYaw * 1000) / 1000,
      s: Math.round(ghostScale * 100) / 100,
    };
    placed.push({ entry, node: spawn(entry), baked: false });
    refreshList();
  });

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "q" || k === "e") {
      ghostYaw += (k === "q" ? 1 : -1) * (Math.PI / 8);
      if (ghost) ghost.rotation.y = ghostYaw;
      refreshStatus();
    } else if (k === "[" || k === "]") {
      ghostScale = Math.max(0.1, Math.min(20, ghostScale * (k === "]" ? 1.15 : 1 / 1.15)));
      if (ghost) ghost.scale.setScalar(ghostScale);
      refreshStatus();
    } else if (k === "escape") {
      clearGhost();
      renderModels();
    } else if (k === "backspace") {
      const last = placed[placed.length - 1];
      if (last && !last.baked) {
        if (last.node) game.scene.remove(last.node);
        placed.pop();
        refreshList();
      }
    }
  });

  // MapControls with damping off needs no per-frame update; the game loop
  // keeps rendering and our freecam flag keeps its hands off the camera.
  void controls;
}
