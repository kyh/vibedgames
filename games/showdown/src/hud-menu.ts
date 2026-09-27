// The roster uses portraits rendered from the playable models themselves.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildBrawlerModel } from "./entities/brawler-model";
import { BRAWLERS } from "./config";
import type { AttackDef, BrawlerDef, BrawlerId } from "./config";
import { mustGet } from "./dom";

const portraits = new Map<BrawlerId, string>();
const rosterKeys = new Map([
  ["ArrowDown", 3],
  ["ArrowLeft", -1],
  ["ArrowRight", 1],
  ["ArrowUp", -3],
]);

const framePortrait = (camera: THREE.PerspectiveCamera, root: THREE.Group): void => {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root, true);
  const centre = bounds.getCenter(new THREE.Vector3());
  const direction = new THREE.Vector3(-0.42, 0.26, 1).normalize();
  const right = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right);
  const vertical = Math.tan((camera.fov * Math.PI) / 360) * 0.86;
  const horizontal = vertical * camera.aspect;
  let distance = 0;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const corner = new THREE.Vector3(x, y, z).sub(centre);
        const reach = Math.max(
          Math.abs(corner.dot(right)) / horizontal,
          Math.abs(corner.dot(up)) / vertical,
        );
        distance = Math.max(distance, corner.dot(direction) + reach);
      }
    }
  }
  camera.position.copy(centre).addScaledVector(direction, distance);
  camera.lookAt(centre);
};

const preparePortraits = (): void => {
  if (portraits.size > 0) {
    return;
  }
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(640, 560);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  const scene = new THREE.Scene();
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room);
  room.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.35;
  scene.add(new THREE.HemisphereLight(0xff_f4_e2, 0x4a_6b_62, 1.8));
  const key = new THREE.DirectionalLight(0xff_f4_dd, 2.6);
  key.position.set(-3, 5, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xb1_e7_d6, 1.6);
  rim.position.set(3, 2, -3);
  scene.add(rim);
  const camera = new THREE.PerspectiveCamera(25, 640 / 560, 0.1, 20);
  for (const def of Object.values(BRAWLERS)) {
    const model = buildBrawlerModel(def, 0);
    scene.add(model.root);
    framePortrait(camera, model.root);
    renderer.render(scene, camera);
    portraits.set(def.id, renderer.domElement.toDataURL("image/png"));
    scene.remove(model.root);
    for (const material of model.allMats) {
      material.dispose();
    }
  }
  environment.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
};

const hex = (color: number): string => `#${color.toString(16).padStart(6, "0")}`;

const attackDamage = (attack: AttackDef): number => {
  if (attack.kind === "burst") {
    return attack.damage * attack.count;
  }
  if (attack.kind === "spread") {
    return attack.damage * attack.pellets;
  }
  return attack.damage;
};

const cardMarkup = (def: BrawlerDef, index: number): string => {
  const swatch = hex(def.palette.body);
  const portrait = portraits.get(def.id);
  const combatType = def.attack.kind === "melee" ? "Melee" : "Ranged";
  return `<div class="swatch" style="--kit-color:${swatch}"><span class="kit-index">${String(index + 1).padStart(2, "0")}</span><img src="${portrait ?? ""}" alt="" width="640" height="560" /><span class="combat-type">${combatType}</span></div>
        <span class="champion-name">${def.name}</span><span class="role">${def.role}</span>`;
};

const showChampion = (id: BrawlerId): void => {
  const def = BRAWLERS[id];
  const detail = mustGet("champion-detail");
  detail.style.setProperty("--kit-color", hex(def.palette.body));
  detail.innerHTML = `<div class="champion-portrait"><img src="${portraits.get(id) ?? ""}" alt="${def.name}, ${def.role}" width="640" height="560" /></div>
    <div class="champion-copy"><div class="champion-class">${def.attack.kind === "melee" ? "Melee" : "Ranged"} · ${def.role}</div>
    <h2>${def.name}</h2><p>${def.blurb}</p>
    <dl class="champion-stats"><div><dt>Health</dt><dd>${def.hp.toLocaleString("en-US")}</dd></div><div><dt>Reach</dt><dd>${def.attack.range.toFixed(1)}</dd></div><div><dt>Max hit</dt><dd>${attackDamage(def.attack).toLocaleString("en-US")}</dd></div></dl>
    <div class="champion-super"><span>SUPER</span><strong>${def.superName}</strong><p>${def.superBlurb}</p></div></div>`;
};

/** Build one card per brawler into `container`; `onPick` fires on click, Enter or Space. */
export const buildBrawlerCards = (
  container: HTMLElement,
  selected: BrawlerId,
  onPick: (id: BrawlerId) => void,
): void => {
  preparePortraits();
  const kits = Object.values(BRAWLERS);
  for (const [index, def] of kits.entries()) {
    const card = document.createElement("button");
    card.type = "button";
    const on = def.id === selected;
    card.className = `card${on ? " on" : ""}`;
    card.dataset.id = def.id;
    card.setAttribute("aria-pressed", String(on));
    card.setAttribute("aria-label", `${def.name}, ${def.role}`);
    card.innerHTML = cardMarkup(def, index);
    const pick = (): void => onPick(def.id);
    card.addEventListener("click", pick);
    card.addEventListener("keydown", (event) => {
      const direction = rosterKeys.get(event.key);
      if (direction === undefined) {
        return;
      }
      event.preventDefault();
      const next = kits[(index + direction + kits.length) % kits.length];
      if (next) {
        onPick(next.id);
        container.querySelector<HTMLButtonElement>(`[data-id="${next.id}"]`)?.focus();
      }
    });
    container.append(card);
  }
  showChampion(selected);
};

/** Highlight the chosen card and demote the rest. */
export const markSelectedCard = (selected: BrawlerId): void => {
  for (const card of document.querySelectorAll<HTMLElement>("#cards .card")) {
    const on = card.dataset.id === selected;
    card.classList.toggle("on", on);
    card.setAttribute("aria-pressed", String(on));
  }
  showChampion(selected);
};
