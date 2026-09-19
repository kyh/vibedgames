// World-anchored HUD widgets: the name/health plate that floats above each
// brawler and the small health bar a damaged loot box shows. Each widget
// caches the last values it wrote so an unchanged frame touches no DOM.

import type { LootBox } from "./combat/combat";
import type { Brawler } from "./entities/brawler";
import { clamp } from "./utils";

/** `root.querySelector(selector)` that refuses to return nothing. */
const mustQuery = (root: ParentNode, selector: string): HTMLElement => {
  const el = root.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`missing HUD element "${selector}"`);
  }
  return el;
};

export interface Overhead {
  ammo: HTMLElement[];
  cubes: HTMLElement;
  fill: HTMLElement;
  hp: HTMLElement | null;
  lastAmmo: number[];
  lastCubes: number;
  lastHp: number;
  lastMax: number;
  root: HTMLElement;
  shown: boolean;
}

/** The player's plate carries three ammo pips under the health bar. */
const AMMO_ROW = `<div class="oh-ammo"><i><b></b></i><i><b></b></i><i><b></b></i></div>`;

export const createOverhead = (brawler: Brawler, layer: HTMLElement): Overhead => {
  const root = document.createElement("div");
  root.className = `oh${brawler.isPlayer ? " me" : ""}`;
  root.innerHTML = `<div class="oh-name">${brawler.isPlayer ? "" : '<span class="n"></span>'}<span class="oh-cubes"></span></div>
      <div class="oh-bar"><div class="oh-fill"></div>${brawler.isPlayer ? '<span class="oh-hp"></span>' : ""}</div>
      ${brawler.isPlayer ? AMMO_ROW : ""}`;
  if (!brawler.isPlayer) {
    mustQuery(root, ".n").textContent = brawler.name;
  }
  layer.append(root);
  const ammo: HTMLElement[] = [];
  for (const pip of root.querySelectorAll(".oh-ammo b")) {
    if (pip instanceof HTMLElement) {
      ammo.push(pip);
    }
  }
  return {
    ammo,
    cubes: mustQuery(root, ".oh-cubes"),
    fill: mustQuery(root, ".oh-fill"),
    hp: brawler.isPlayer ? mustQuery(root, ".oh-hp") : null,
    lastAmmo: [-1, -1, -1],
    lastCubes: -1,
    lastHp: -1,
    lastMax: -1,
    root,
    shown: true,
  };
};

/** Ammo pips are quantised to 1/40 so a slow reload does not rewrite styles every frame. */
const AMMO_STEPS = 40;

const syncAmmo = (entry: Overhead, brawler: Brawler): void => {
  for (const [slot, pip] of entry.ammo.entries()) {
    const reloading = Math.floor(brawler.ammo) === slot ? brawler.reloadT : 0;
    const fill = clamp(brawler.ammo - slot + reloading, 0, 1);
    const step = Math.round(fill * AMMO_STEPS);
    if (step !== entry.lastAmmo[slot]) {
      entry.lastAmmo[slot] = step;
      pip.style.transform = `scaleX(${(step / AMMO_STEPS).toFixed(3)})`;
      pip.style.opacity = fill >= 1 ? "1" : "0.55";
    }
  }
};

/** Refresh the plate's health, cube count and (for the player) ammo pips. */
export const syncOverhead = (entry: Overhead, brawler: Brawler): void => {
  const hp = Math.max(0, Math.ceil(brawler.hp));
  if (hp !== entry.lastHp || brawler.maxHp !== entry.lastMax) {
    entry.lastHp = hp;
    entry.lastMax = brawler.maxHp;
    entry.fill.style.transform = `scaleX(${clamp(hp / brawler.maxHp, 0, 1).toFixed(3)})`;
    if (entry.hp) {
      entry.hp.textContent = String(hp);
    }
  }
  if (brawler.cubes !== entry.lastCubes) {
    entry.lastCubes = brawler.cubes;
    entry.cubes.textContent = brawler.cubes > 0 ? `⚡${brawler.cubes}` : "";
  }
  if (brawler.isPlayer) {
    syncAmmo(entry, brawler);
  }
};

export interface BoxBar {
  fill: HTMLElement;
  hp: HTMLElement;
  last: number;
  root: HTMLElement;
}

export const createBoxBar = (layer: HTMLElement): BoxBar => {
  const root = document.createElement("div");
  root.className = "oh box";
  root.innerHTML = `<div class="oh-bar"><div class="oh-fill"></div><span class="oh-hp"></span></div>`;
  layer.append(root);
  return {
    fill: mustQuery(root, ".oh-fill"),
    hp: mustQuery(root, ".oh-hp"),
    last: -1,
    root,
  };
};

export const syncBoxBar = (bar: BoxBar, box: LootBox): void => {
  const hp = Math.max(0, Math.ceil(box.hp));
  if (hp !== bar.last) {
    bar.last = hp;
    bar.fill.style.transform = `scaleX(${clamp(hp / box.maxHp, 0, 1).toFixed(3)})`;
    bar.hp.textContent = String(hp);
  }
};
