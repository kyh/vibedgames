// DOM overlay: title menu, result screen, settings panel, brawler plates,
// floating numbers, kill feed, banners and the touch sticks. Everything is
// keyed by element ids in index.html; a missing id is a build error, not a
// silent no-op.

import * as THREE from "three";

import type { LootBox } from "./combat/combat";
import type { BrawlerId } from "./config";
import { mustGet, mustGetInput } from "./dom";
import type { Brawler } from "./entities/brawler";
import type { Game } from "./game";
import { FLOATER_LIFE, createFloaters, spawnFloater, styleFloater } from "./hud-floaters";
import type { Floater } from "./hud-floaters";
import type { Stick } from "./input";
import { buildLobby } from "./hud-lobby";
import { buildBrawlerCards, markSelectedCard } from "./hud-menu";
import { PlayHints } from "./polish/play-hints";
import type { RunVerdict } from "./polish/best-run";
import { createBoxBar, createOverhead, syncBoxBar, syncOverhead } from "./hud-overheads";
import type { BoxBar, Overhead } from "./hud-overheads";
import { buildSettingsPanel, renderStats, syncSettingsPanel } from "./hud-settings";
import type { FeedRecorder, FloatRecorder } from "./net/presentation";
import { clamp } from "./utils";

export { mustGet, mustGetInput } from "./dom";

/** 15.4 → "15:24". */
const padTime = (hour: number): string => {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const timeEmoji = (hour: number): string => {
  if (hour >= 19.4 || hour < 5.6) {
    return "🌙";
  }
  if (hour >= 17.2 || hour < 7.2) {
    return "🌇";
  }
  return "☀️";
};

const resultTitle = (won: boolean, rank: number): string => {
  if (won) {
    return "VICTORY!";
  }
  return rank <= 3 ? "SO CLOSE!" : "DEFEATED";
};

/** A world point mapped to CSS pixels; `on` is false when it falls off screen. */
interface Projected {
  on: boolean;
  x: number;
  y: number;
}

const PROJECT_SCRATCH = new THREE.Vector3();
/** Reused for every projection in a frame; consumers copy what they need. */
const PROJECTED: Projected = { on: false, x: 0, y: 0 };

const FLOATER_POOL = 36;
/** Half the stick's travel range in px; a full deflection moves the knob this far. */
const STICK_TRAVEL = 58;

/** A stick sits at its rest point until a thumb lands, then follows the touch origin. */
const positionStick = (el: HTMLElement, stick: Stick, restX: number, restY: number): void => {
  const held = stick.id !== null;
  const x = held ? stick.ox : restX;
  const y = held ? stick.oy : restY;
  el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  el.classList.toggle("on", held);
  const knob = el.firstElementChild;
  if (knob instanceof HTMLElement) {
    knob.style.transform = `translate(${(stick.x * STICK_TRAVEL).toFixed(1)}px, ${(stick.y * STICK_TRAVEL).toFixed(1)}px)`;
  }
};
const TOAST_MS = 3200;
const FEED_MS = 6000;
const FEED_MAX = 4;

export class Hud {
  readonly game: Game;
  readonly root: HTMLElement;
  readonly overheadLayer: HTMLElement;
  readonly floaterLayer: HTMLElement;
  readonly overheads = new Map<number, Overhead>();
  readonly boxBars = new Map<LootBox, BoxBar>();
  readonly floaters: Floater[];
  floaterCursor = 0;
  bannerT = 0;
  hurt = 0;
  selected: BrawlerId = "dusty";
  lastLeft = -1;
  lastClock = "";
  lastSuper = -1;
  statsT = 0;
  frames = 0;
  fps = 0;
  touch = false;
  readonly stickEls: { aim: HTMLElement; move: HTMLElement };
  /** The in-play control strip, which retires itself once the player has shot. */
  readonly playHints: PlayHints;
  /** While hosting online, floating numbers and kills are also written here for guests. */
  floatRecorder: FloatRecorder | null = null;
  feedRecorder: FeedRecorder | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(game: Game) {
    this.game = game;
    this.root = mustGet("hud");
    this.overheadLayer = mustGet("overheads");
    this.floaterLayer = mustGet("floaters");
    this.floaters = createFloaters(this.floaterLayer, FLOATER_POOL);
    this.stickEls = { aim: mustGet("stick-aim"), move: mustGet("stick-move") };
    this.playHints = new PlayHints(mustGet("hints"));
    this.buildMenu();
    buildLobby(game, game.params);
    buildSettingsPanel(game);
  }

  setTouchMode(on: boolean): void {
    this.touch = on;
    document.body.classList.toggle("touch", on);
    // The super button's label differs per input mode; force a redraw.
    this.lastSuper = -1;
  }

  /** Sticks rest near the bottom corners and jump to wherever a thumb lands. */
  private updateSticks(): void {
    if (!this.touch) {
      return;
    }
    const { sticks } = this.game.input;
    const w = window.innerWidth;
    const h = window.innerHeight;
    positionStick(this.stickEls.move, sticks.move, Math.max(96, w * 0.14), h - 118);
    positionStick(this.stickEls.aim, sticks.aim, w - Math.max(104, w * 0.13), h - 128);
  }

  private buildMenu(): void {
    buildBrawlerCards(mustGet("cards"), this.selected, (id) => {
      this.game.audio.unlock();
      this.game.audio.play("click");
      this.select(id);
    });
    mustGet("play").addEventListener("click", () => {
      this.game.audio.unlock();
      this.game.startMatch(this.selected);
    });
    mustGet("again").addEventListener("click", () => this.game.playAgain());
    mustGet("to-menu").addEventListener("click", () => this.game.toMenu());
  }

  select(id: BrawlerId): void {
    this.selected = id;
    markSelectedCard(id);
  }

  showMenu(open: boolean): void {
    mustGet("menu").classList.toggle("open", open);
    if (open) {
      mustGet("result").classList.remove("open");
    }
    this.root.classList.toggle("hidden", open);
  }

  // oxlint-disable-next-line class-methods-use-this -- part of the Hud facade; callers hold the instance, not the class
  showResult(
    won: boolean,
    rank: number,
    total: number,
    kills: number,
    cubes: number,
    verdict?: RunVerdict,
  ): void {
    const title = mustGet("result-title");
    title.textContent = resultTitle(won, rank);
    title.classList.toggle("lose", !won);
    mustGet("result-rank").textContent = `RANK #${rank} of ${total}`;
    mustGet("result-stats").textContent =
      `${kills} takedown${kills === 1 ? "" : "s"}  ·  ${cubes} power cube${cubes === 1 ? "" : "s"}`;
    const best = mustGet("result-best");
    best.textContent = verdict?.line ?? "";
    best.hidden = !verdict?.line;
    best.classList.toggle("record", verdict?.record === true);
    mustGet("result").classList.add("open");
  }

  // oxlint-disable-next-line class-methods-use-this -- instance API, see showResult
  hideResult(): void {
    mustGet("result").classList.remove("open");
  }

  syncSettings(): void {
    syncSettingsPanel(this.game);
  }

  toast(message: string): void {
    const el = mustGet("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove("show"), TOAST_MS);
  }

  reset(): void {
    for (const entry of this.overheads.values()) {
      entry.root.remove();
    }
    this.overheads.clear();
    for (const bar of this.boxBars.values()) {
      bar.root.remove();
    }
    this.boxBars.clear();
    for (const floater of this.floaters) {
      floater.life = 0;
      floater.el.hidden = true;
    }
    mustGet("feed").innerHTML = "";
    this.lastLeft = -1;
    this.hideResult();
  }

  addBrawler(brawler: Brawler): void {
    this.overheads.set(brawler.id, createOverhead(brawler, this.overheadLayer));
  }

  floatText(x: number, y: number, z: number, text: string, className: string): void {
    this.floatRecorder?.(x, y, z, text, className);
    const floater = this.floaters[this.floaterCursor];
    this.floaterCursor = (this.floaterCursor + 1) % this.floaters.length;
    if (floater) {
      spawnFloater(floater, x, y, z, text, className);
    }
  }

  // oxlint-disable-next-line class-methods-use-this -- instance API, see showResult
  feed(html: string): void {
    const feed = mustGet("feed");
    const line = document.createElement("div");
    line.innerHTML = html;
    feed.append(line);
    while (feed.children.length > FEED_MAX) {
      feed.firstChild?.remove();
    }
    setTimeout(() => line.remove(), FEED_MS);
  }

  /** One kill-feed line; `*IsYou` highlights the local player's own name. */
  feedKill(
    killer: string | null,
    victim: string,
    killerIsYou: boolean,
    victimIsYou: boolean,
  ): void {
    const v = `<span class="v ${victimIsYou ? "you" : ""}">${victim}</span>`;
    if (killer === null) {
      this.feed(`${v} ☠ poison gas`);
      return;
    }
    this.feed(`<span class="k ${killerIsYou ? "you" : ""}">${killer}</span> ⚔ ${v}`);
  }

  /** Announce a takedown: the feed line here, and the record for guests when hosting. */
  announceKill(killer: Brawler | null, downed: Brawler): void {
    const slayer = killer && killer !== downed ? killer : null;
    this.feedRecorder?.(slayer?.name ?? null, downed.name, slayer?.netId ?? null, downed.netId);
    this.feedKill(slayer?.name ?? null, downed.name, slayer?.isPlayer ?? false, downed.isPlayer);
  }

  banner(text: string, seconds = 1, small = false): void {
    const el = mustGet("banner");
    el.textContent = text;
    el.classList.toggle("small", small);
    el.classList.add("show");
    this.bannerT = seconds;
  }

  flashHurt(amount: number): void {
    this.hurt = clamp(this.hurt + amount / 1400, 0.35, 1);
  }

  private project(x: number, y: number, z: number): Projected {
    PROJECT_SCRATCH.set(x, y, z).project(this.game.camera);
    PROJECTED.x = (PROJECT_SCRATCH.x * 0.5 + 0.5) * window.innerWidth;
    PROJECTED.y = (-PROJECT_SCRATCH.y * 0.5 + 0.5) * window.innerHeight;
    PROJECTED.on =
      PROJECT_SCRATCH.z < 1 &&
      Math.abs(PROJECT_SCRATCH.x) < 1.15 &&
      Math.abs(PROJECT_SCRATCH.y) < 1.2;
    return PROJECTED;
  }

  private updateOverheads(): void {
    for (const brawler of this.game.brawlers) {
      const entry = this.overheads.get(brawler.id);
      if (!entry) {
        continue;
      }
      const visible = brawler.alive && brawler.root.visible;
      const point = visible
        ? this.project(brawler.x, brawler.root.position.y + 1.72, brawler.z)
        : null;
      const shown = point !== null && point.on;
      if (shown !== entry.shown) {
        entry.root.hidden = !shown;
        entry.shown = shown;
      }
      if (!point || !shown) {
        continue;
      }
      entry.root.style.transform = `translate3d(${point.x.toFixed(1)}px, ${(point.y - 44).toFixed(1)}px, 0)`;
      syncOverhead(entry, brawler);
    }
  }

  /** Only a damaged, still-standing box shows a bar; intact or broken ones drop it. */
  private updateBoxBars(): void {
    for (const box of this.game.combat.boxes) {
      let bar = this.boxBars.get(box);
      if (!(box.alive && box.hp < box.maxHp)) {
        if (bar) {
          bar.root.remove();
          this.boxBars.delete(box);
        }
        continue;
      }
      if (!bar) {
        bar = createBoxBar(this.overheadLayer);
        this.boxBars.set(box, bar);
      }
      const point = this.project(box.x, 1.35, box.z);
      bar.root.hidden = !point.on;
      bar.root.style.transform = `translate3d(${point.x.toFixed(1)}px, ${(point.y - 20).toFixed(1)}px, 0)`;
      syncBoxBar(bar, box);
    }
  }

  private updateFloaters(dt: number): void {
    for (const floater of this.floaters) {
      if (floater.life <= 0) {
        continue;
      }
      floater.life -= dt;
      if (floater.life <= 0) {
        floater.el.hidden = true;
        continue;
      }
      const progress = 1 - floater.life / FLOATER_LIFE;
      const point = this.project(floater.x, floater.y + progress * 0.9, floater.z);
      styleFloater(floater, point.x, point.y, progress);
    }
  }

  private updateTopBar(): void {
    const { game } = this;
    const left = game.brawlers.reduce((count, b) => count + (b.alive ? 1 : 0), 0);
    if (left !== this.lastLeft) {
      this.lastLeft = left;
      mustGet("left-count").innerHTML = `BRAWLERS LEFT <b>${left}</b>`;
    }
    const clock = `${timeEmoji(game.lighting.time)} ${padTime(game.lighting.time)}`;
    if (clock !== this.lastClock) {
      this.lastClock = clock;
      mustGet("clock").textContent = clock;
      mustGet("time-label").textContent = padTime(game.lighting.time);
      const slider = mustGetInput("time-slider");
      if (document.activeElement !== slider) {
        slider.value = String(game.lighting.time);
      }
    }
  }

  private updateSuperButton(): void {
    const { player } = this.game;
    const percent = player ? Math.round(player.superCharge * 100) : 0;
    if (percent === this.lastSuper) {
      return;
    }
    this.lastSuper = percent;
    const el = mustGet("super");
    el.style.setProperty("--p", String(percent));
    el.classList.toggle("ready", percent >= 100);
    let label = `SUPER ${percent}%`;
    if (percent >= 100) {
      label = this.touch ? "SUPER!" : "SPACE!";
    }
    mustGet("super-core").textContent = label;
  }

  /** Frame counter, and the diagnostics readout while the panel is open. */
  private updateStats(dt: number): void {
    this.frames += 1;
    this.statsT += dt;
    if (this.statsT < 0.5) {
      return;
    }
    this.fps = Math.round(this.frames / this.statsT);
    this.frames = 0;
    this.statsT = 0;
    if (mustGet("settings").classList.contains("open")) {
      renderStats(this.game, this.fps);
    }
  }

  update(dt: number): void {
    const { game } = this;
    this.playHints.update(dt);
    this.updateOverheads();
    this.updateBoxBars();
    this.updateFloaters(dt);
    this.updateTopBar();
    this.updateSuperButton();
    this.updateSticks();
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) {
        mustGet("banner").classList.remove("show");
      }
    }
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    mustGet("hurt").style.opacity = this.hurt.toFixed(2);
    const { player } = game;
    const inGas =
      player !== null &&
      player.alive &&
      game.gas.active &&
      game.gas.depthAt(player.x, player.z) > 0.35;
    mustGet("gas-warn").style.opacity = inGas ? "1" : "0";
    this.updateStats(dt);
  }
}
