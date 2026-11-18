// The DOM HUD. Markup and CSS live in index.html; this file writes values, and
// only when they change. Every panel is a "plate" (see the stylesheet): the
// standings board, the timing plate, the framed minimap, the speedometer with
// the drift charge under its needle, the position roundel, the item slot and
// the orb counter. The title screen is the garage: pick a chassis, read the
// rules, race.

import { controlHints } from "@repo/embed";

import { CONTROLS } from "../controls";
import { BOOST_TIERS, CHASSIS, LAPS, ORB_MAX } from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import type { Surface } from "../sim/kart";
import { formatTime, ordinal } from "../sim/race";
import type { Track } from "../sim/track";

export interface RaceReadout {
  place: number;
  total: number;
  lap: number;
  clockMs: number;
  /** Seconds of drift held. */
  charge: number;
  surface: Surface;
  kmh: number;
  boosting: boolean;
  orbs: number;
  item: ItemKind | null;
  /** Seconds to the kart ahead, 0 when leading. */
  gap: number;
}

export interface MapDot {
  x: number;
  z: number;
  color: string;
  me: boolean;
}

export interface BoardRow {
  name: string;
  color: string;
  me: boolean;
}

export interface ResultRow {
  place: number;
  name: string;
  color: string;
  /** Race time in ms, or 0 for a kart that did not finish. */
  timeMs: number;
  /** Share of the painted road this kart holds, 0–1. */
  paint: number;
  /** Cup points so far, this race included. */
  points: number;
  me: boolean;
}

export interface HudActions {
  onStart: () => void;
  onChassis: (index: number) => void;
  onItem: () => void;
}

const el = <T extends Element>(id: string, ctor: new () => T): T => {
  const node = document.querySelector(`#${id}`);
  if (!(node instanceof ctor)) {
    throw new Error(`missing #${id}`);
  }
  return node;
};

/** Write text only when it changed: these run every frame. */
const setText = (node: Element, text: string): void => {
  if (node.textContent !== text) {
    node.textContent = text;
  }
};

const SURFACE_LABEL: Record<Surface, string> = {
  own: "IN THE GLOW",
  rival: "SLICK",
  road: "",
  shoulder: "",
};

/** One glyph per item, drawn as strokes in a 64-unit box. */
const ITEM_ICONS: Record<ItemKind | "none", string> = {
  blot: '<path d="M32 10c10 0 20 8 20 20 0 6-4 9-2 15 2 7-6 11-12 8-5-3-9-2-14 0-7 2-13-4-11-11 2-6-2-9-1-15 2-10 10-17 20-17z" fill="currentColor" stroke="none"/><circle cx="14" cy="50" r="4" fill="currentColor" stroke="none"/>',
  bomb: '<circle cx="28" cy="38" r="17"/><path d="M40 26l8-8"/><path d="M50 8v6M56 14h-6M54 10l-4 4"/>',
  none: '<path d="M22 24a10 10 0 1 1 14 9c-3 2-4 4-4 8"/><path d="M32 51v1"/>',
  solvent:
    '<path d="M32 8c10 13 16 21 16 30a16 16 0 0 1-32 0c0-9 6-17 16-30z"/><path d="M24 38a8 8 0 0 0 8 8"/>',
  turbo: '<path d="M10 14l20 18-20 18"/><path d="M32 14l20 18-20 18"/>',
};

/** A side-on silhouette per chassis: wing, cage and crate, twin fins. */
const WHEELS = '<circle cx="13" cy="26" r="7"/><circle cx="45" cy="26" r="6"/>';
const CHASSIS_ICONS = [
  `${WHEELS}<path d="M6 22h40l8 3v2H6z"/><path d="M22 22l3-8h8l3 8z"/><path d="M2 6h14v3H10v10H7V9H2z"/>`,
  `${WHEELS}<path d="M6 22h42l6 3v2H6z"/><path d="M4 8h18v14H4z"/><path d="M22 22V8h14l4 14h-3l-3-11h-9v11z"/>`,
  `${WHEELS}<path d="M8 22h36l12 4v1H8z"/><path d="M22 22l3-7h7l3 7z"/><path d="M4 8l12 6v8h-4z"/><path d="M44 18h10v2H44z"/>`,
] as const;

const ITEM_NAMES: Record<ItemKind, string> = {
  blot: "Blot",
  bomb: "Paint bomb",
  solvent: "Solvent",
  turbo: "Turbo",
};

const MAP_PX = 300;
const MAP_PAD = 26;
/** The speedometer's sweep, degrees either side of straight up, and its top mark. */
const SWEEP = 135;
const DIAL_MAX = 220;
const SVG = "http://www.w3.org/2000/svg";

/** The player's paint colour, as the CSS accent every HUD surface keys off. */
export const setAccent = (color: string): void => {
  document.documentElement.style.setProperty("--me", color);
};

/** How many of six pips a chassis multiplier lights, around three for "average". */
const pips = (value: number, spread: number): number =>
  Math.min(6, Math.max(1, Math.round(3 + (value - 1) * spread)));

const statRow = (label: string, lit: number, color: string): HTMLElement => {
  const row = document.createElement("div");
  row.className = "stat";
  const name = document.createElement("span");
  name.textContent = label;
  const bar = document.createElement("span");
  bar.className = "pips";
  bar.style.setProperty("--pip", color);
  for (let i = 0; i < 6; i += 1) {
    const pip = document.createElement("i");
    pip.dataset["on"] = i < lit ? "1" : "0";
    bar.append(pip);
  }
  row.append(name, bar);
  return row;
};

/** Tick marks round the speedometer. */
const buildDial = (): void => {
  const ticks = el("ticks", SVGGElement);
  for (let i = 0; i <= 10; i += 1) {
    const angle = ((-SWEEP + (i / 10) * SWEEP * 2 - 90) * Math.PI) / 180;
    const inner = i % 5 === 0 ? 50 : 55;
    const tick = document.createElementNS(SVG, "line");
    tick.setAttribute("x1", (80 + Math.cos(angle) * inner).toFixed(1));
    tick.setAttribute("y1", (80 + Math.sin(angle) * inner).toFixed(1));
    tick.setAttribute("x2", (80 + Math.cos(angle) * 59).toFixed(1));
    tick.setAttribute("y2", (80 + Math.sin(angle) * 59).toFixed(1));
    ticks.append(tick);
  }
};

export class Hud {
  private readonly hud = el("hud", HTMLElement);
  private readonly placeNum = el("place-num", HTMLElement);
  private readonly placeSuffix = el("place-suffix", HTMLElement);
  private readonly lapNum = el("lap-num", HTMLElement);
  private readonly clock = el("clock", HTMLElement);
  private readonly surface = el("surface", HTMLElement);
  private readonly charge = [...el("charge", HTMLElement).querySelectorAll("i")];
  private readonly net = el("net", HTMLElement);
  private readonly trackName = el("track-name", HTMLElement);
  private readonly calloutNode = el("callout", HTMLElement);
  private readonly title = el("title", HTMLElement);
  private readonly results = el("results", HTMLElement);
  private readonly resultsTitle = el("results-title", HTMLElement);
  private readonly resultsSub = el("results-sub", HTMLElement);
  private readonly resultsRows = el("results-rows", HTMLElement);
  private readonly resultsNext = el("results-next", HTMLElement);
  private readonly board = el("board", HTMLElement);
  private readonly item = el("item", HTMLButtonElement);
  private readonly itemIcon = el("item-icon", SVGSVGElement);
  private readonly orbCount = el("orb-count", HTMLElement);
  private readonly kmh = el("kmh-num", HTMLElement);
  private readonly needle = el("needle", SVGGElement);
  private readonly arc = el("arc", SVGPathElement);
  private readonly gap = el("gap", HTMLElement);
  private readonly cards: HTMLButtonElement[] = [];
  private readonly map = el("minimap", HTMLCanvasElement);
  private readonly mapCtx = this.map.getContext("2d");
  private mapPath: Path2D | null = null;
  private mapScale = 1;
  private mapAccent = "#fff";
  private calloutUntil = 0;
  private resultsKey = "";
  private boardKey = "";
  private itemKind = "?";
  private dial = 0;

  constructor(actions: HudActions) {
    el("lap-total", HTMLElement).textContent = String(LAPS);
    const controls = el("controls", HTMLElement);
    for (const [input, action] of controlHints(CONTROLS)) {
      const key = document.createElement("kbd");
      key.textContent = input;
      const what = document.createElement("span");
      what.textContent = action;
      controls.append(key, what);
    }
    el("start", HTMLButtonElement).addEventListener("click", actions.onStart);
    this.item.addEventListener("click", actions.onItem);
    buildDial();
    this.buildCards(actions.onChassis);
    this.setItem(null);
  }

  showTitle(on: boolean): void {
    this.title.dataset["on"] = on ? "1" : "0";
  }

  showHud(on: boolean): void {
    this.hud.dataset["on"] = on ? "1" : "0";
  }

  setTrack(track: Track): void {
    setText(this.trackName, track.def.name);
    this.mapAccent = track.def.palette.accent;
    let reach = 1;
    for (let i = 0; i < track.n; i += 1) {
      reach = Math.max(reach, Math.abs(track.xs[i] ?? 0), Math.abs(track.zs[i] ?? 0));
    }
    this.mapScale = (MAP_PX / 2 - MAP_PAD) / reach;
    const path = new Path2D();
    for (let i = 0; i <= track.n; i += 4) {
      const k = i % track.n;
      const x = MAP_PX / 2 + (track.xs[k] ?? 0) * this.mapScale;
      const y = MAP_PX / 2 + (track.zs[k] ?? 0) * this.mapScale;
      if (i === 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }
    path.closePath();
    this.mapPath = path;
  }

  setRace(readout: RaceReadout): void {
    setText(this.placeNum, String(readout.place));
    setText(this.placeSuffix, ordinal(readout.place).slice(String(readout.place).length));
    setText(this.lapNum, String(readout.lap));
    setText(this.clock, formatTime(readout.clockMs));
    setText(this.orbCount, String(Math.min(ORB_MAX, readout.orbs)));
    setText(this.kmh, String(readout.kmh));
    const label = SURFACE_LABEL[readout.surface];
    setText(this.surface, label);
    this.surface.dataset["kind"] = label === "" ? "" : readout.surface;
    this.setItem(readout.item);

    // Ease the needle so it sweeps instead of ticking.
    const share = Math.min(1, readout.kmh / DIAL_MAX);
    this.dial += (share - this.dial) * 0.35;
    this.needle.style.transform = `rotate(${(-SWEEP + this.dial * SWEEP * 2).toFixed(1)}deg)`;
    this.arc.setAttribute("stroke-dasharray", `${(this.dial * 100).toFixed(1)} 100`);
    this.arc.setAttribute("stroke", readout.boosting ? "#ffffff" : "var(--me)");

    let from = 0;
    for (const [i, bar] of this.charge.entries()) {
      const need = BOOST_TIERS[i] ?? 1;
      const fill = Math.min(1, Math.max(0, (readout.charge - from) / (need - from)));
      bar.style.setProperty("--fill", fill.toFixed(2));
      from = need;
    }
    this.gap.dataset["on"] = readout.gap > 0 ? "1" : "0";
    if (readout.gap > 0) {
      setText(this.gap, `AHEAD +${readout.gap.toFixed(1)}s`);
    }
  }

  /** The standings board: one row per kart, leader first. */
  setStandings(rows: readonly BoardRow[]): void {
    const key = rows.map((row) => `${row.name}${row.color}${row.me ? 1 : 0}`).join("|");
    if (key === this.boardKey) {
      return;
    }
    this.boardKey = key;
    this.board.replaceChildren(
      ...rows.map((row, i) => {
        const line = document.createElement("li");
        line.className = "plate skew";
        line.dataset["me"] = row.me ? "1" : "0";
        line.style.setProperty("--chip", row.color);
        const rank = document.createElement("b");
        rank.className = "num";
        rank.textContent = String(i + 1);
        const chip = document.createElement("i");
        const name = document.createElement("span");
        name.textContent = row.name;
        line.append(rank, chip, name);
        return line;
      }),
    );
  }

  setNet(text: string): void {
    setText(this.net, text);
  }

  /** Flash the centre callout for `ms`; `detail` is the small line under it. */
  callout(text: string, ms: number, tone: "go" | "warn" = "go", detail = ""): void {
    this.calloutNode.textContent = text;
    if (detail !== "") {
      const small = document.createElement("small");
      small.textContent = detail;
      this.calloutNode.append(small);
    }
    this.calloutNode.dataset["tone"] = tone;
    this.calloutNode.dataset["on"] = "1";
    this.calloutUntil = performance.now() + ms;
  }

  /** Every frame: retire the callout when its time is up. */
  tick(): void {
    if (this.calloutUntil !== 0 && performance.now() > this.calloutUntil) {
      this.calloutNode.dataset["on"] = "0";
      this.calloutUntil = 0;
    }
  }

  drawMap(dots: readonly MapDot[]): void {
    const ctx = this.mapCtx;
    if (!ctx || !this.mapPath) {
      return;
    }
    ctx.clearRect(0, 0, MAP_PX, MAP_PX);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0c0d14";
    ctx.lineWidth = 24;
    ctx.stroke(this.mapPath);
    ctx.strokeStyle = "#4a4d60";
    ctx.lineWidth = 16;
    ctx.stroke(this.mapPath);
    ctx.strokeStyle = this.mapAccent;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 8]);
    ctx.stroke(this.mapPath);
    ctx.setLineDash([]);
    for (const dot of dots) {
      const x = MAP_PX / 2 + dot.x * this.mapScale;
      const y = MAP_PX / 2 + dot.z * this.mapScale;
      ctx.beginPath();
      ctx.arc(x, y, dot.me ? 12 : 8, 0, Math.PI * 2);
      ctx.fillStyle = dot.color;
      ctx.fill();
      ctx.lineWidth = dot.me ? 5 : 3;
      ctx.strokeStyle = dot.me ? "#ffffff" : "#0c0d14";
      ctx.stroke();
    }
  }

  /** Show the standings sheet, or hide it with `null`. */
  showResults(rows: readonly ResultRow[] | null, heading = "", sub = ""): void {
    if (rows === null) {
      this.results.dataset["on"] = "0";
      this.resultsKey = "";
      return;
    }
    this.results.dataset["on"] = "1";
    setText(this.resultsTitle, heading);
    setText(this.resultsSub, sub);
    const key = rows
      .map((row) => `${row.name}:${row.timeMs}:${row.paint.toFixed(2)}:${row.points}`)
      .join("|");
    if (key === this.resultsKey) {
      return;
    }
    this.resultsKey = key;
    this.resultsRows.replaceChildren(
      ...rows.map((row) => {
        const line = document.createElement("div");
        line.className = "row skew";
        line.dataset["me"] = row.me ? "1" : "0";
        const place = document.createElement("b");
        place.textContent = ordinal(row.place);
        const chip = document.createElement("i");
        chip.style.background = row.color;
        const name = document.createElement("span");
        name.textContent = row.name;
        const paint = document.createElement("span");
        paint.className = "paint";
        paint.textContent = `${Math.round(row.paint * 100)}% PAINT`;
        const time = document.createElement("span");
        time.className = "time";
        time.textContent = row.timeMs > 0 ? formatTime(row.timeMs) : "—";
        const points = document.createElement("b");
        points.className = "pts";
        points.textContent = `${row.points} PTS`;
        line.append(place, chip, name, paint, time, points);
        return line;
      }),
    );
  }

  setResultsNext(text: string): void {
    setText(this.resultsNext, text);
  }

  private setItem(kind: ItemKind | null): void {
    const next = kind ?? "";
    if (next === this.itemKind) {
      return;
    }
    this.itemKind = next;
    this.item.dataset["kind"] = next;
    this.item.setAttribute("aria-label", kind ? `Use item: ${ITEM_NAMES[kind]}` : "No item");
    // Static markup from the table above, never user text.
    this.itemIcon.innerHTML = ITEM_ICONS[kind ?? "none"];
  }

  /** One card per chassis: name, what it is for, three stat bars. */
  private buildCards(onChassis: (index: number) => void): void {
    const host = el("chassis", HTMLElement);
    for (const [index, chassis] of CHASSIS.entries()) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card plate";
      card.setAttribute("aria-pressed", index === 0 ? "true" : "false");
      const name = document.createElement("strong");
      name.className = "skew";
      name.textContent = chassis.name;
      const tag = document.createElement("span");
      tag.className = "label";
      tag.textContent = chassis.tag;
      const icon = document.createElementNS(SVG, "svg");
      icon.setAttribute("viewBox", "0 0 58 34");
      icon.setAttribute("aria-hidden", "true");
      // Static markup from the table above, never user text.
      icon.innerHTML = CHASSIS_ICONS[index] ?? "";
      card.append(
        name,
        icon,
        tag,
        statRow("SPEED", pips(chassis.speed, 25), "#ff4d6a"),
        statRow("ACCEL", pips(chassis.accel, 14), "#3d9bff"),
        statRow("GRIP", pips(chassis.grip, 20), "#4fe07a"),
      );
      card.addEventListener("click", () => {
        for (const [i, other] of this.cards.entries()) {
          other.setAttribute("aria-pressed", i === index ? "true" : "false");
        }
        onChassis(index);
      });
      this.cards.push(card);
      host.append(card);
    }
  }
}
