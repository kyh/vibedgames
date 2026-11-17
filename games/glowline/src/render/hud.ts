// The DOM HUD: place, lap, clock, drift charge, a minimap, the big centre
// callout, and the title and results cards. Markup and CSS live in index.html;
// this file only writes values, and only when they change.

import { controlHints } from "@repo/embed";

import { CONTROLS } from "../controls";
import { BOOST_TIERS, LAPS } from "../shared/constants";
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
}

export interface MapDot {
  x: number;
  z: number;
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
  me: boolean;
}

const el = <T extends HTMLElement>(id: string, ctor: new () => T): T => {
  const node = document.querySelector(`#${id}`);
  if (!(node instanceof ctor)) {
    throw new Error(`missing #${id}`);
  }
  return node;
};

/** Write text only when it changed: these run every frame. */
const setText = (node: HTMLElement, text: string): void => {
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

/** The player's paint colour, as the CSS accent every HUD surface keys off. */
export const setAccent = (color: string): void => {
  document.documentElement.style.setProperty("--me", color);
};

const MAP_PX = 300;
const MAP_PAD = 26;

export class Hud {
  private readonly hud = el("hud", HTMLElement);
  private readonly placeNum = el("place-num", HTMLElement);
  private readonly placeSuffix = el("place-suffix", HTMLElement);
  private readonly placeOf = el("place-of", HTMLElement);
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
  private readonly map = el("minimap", HTMLCanvasElement);
  private readonly mapCtx = this.map.getContext("2d");
  private mapPath: Path2D | null = null;
  private mapScale = 1;
  private mapAccent = "#fff";
  private calloutUntil = 0;
  private resultsKey = "";

  constructor(onStart: () => void) {
    el("lap-total", HTMLElement).textContent = String(LAPS);
    const controls = el("controls", HTMLElement);
    for (const [input, action] of controlHints(CONTROLS)) {
      const key = document.createElement("kbd");
      key.textContent = input;
      const what = document.createElement("span");
      what.textContent = action;
      controls.append(key, what);
    }
    el("start", HTMLButtonElement).addEventListener("click", onStart);
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
    const place = ordinal(readout.place);
    setText(this.placeNum, String(readout.place));
    setText(this.placeSuffix, place.slice(String(readout.place).length));
    setText(this.placeOf, `/${readout.total}`);
    setText(this.lapNum, String(readout.lap));
    setText(this.clock, formatTime(readout.clockMs));
    const label = SURFACE_LABEL[readout.surface];
    setText(this.surface, label);
    this.surface.dataset["kind"] = label === "" ? "" : readout.surface;
    let from = 0;
    for (const [i, bar] of this.charge.entries()) {
      const need = BOOST_TIERS[i] ?? 1;
      const fill = Math.min(1, Math.max(0, (readout.charge - from) / (need - from)));
      bar.style.setProperty("--fill", fill.toFixed(2));
      from = need;
    }
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
    ctx.strokeStyle = "rgba(244,246,255,0.16)";
    ctx.lineWidth = 16;
    ctx.stroke(this.mapPath);
    ctx.strokeStyle = this.mapAccent;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 3;
    ctx.stroke(this.mapPath);
    ctx.globalAlpha = 1;
    for (const dot of dots) {
      const x = MAP_PX / 2 + dot.x * this.mapScale;
      const y = MAP_PX / 2 + dot.z * this.mapScale;
      ctx.beginPath();
      ctx.arc(x, y, dot.me ? 11 : 7.5, 0, Math.PI * 2);
      ctx.fillStyle = dot.color;
      ctx.fill();
      if (dot.me) {
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
      }
    }
  }

  /** Show the standings card, or hide it with `null`. */
  showResults(rows: readonly ResultRow[] | null, heading = "", sub = ""): void {
    if (rows === null) {
      this.results.dataset["on"] = "0";
      this.resultsKey = "";
      return;
    }
    this.results.dataset["on"] = "1";
    setText(this.resultsTitle, heading);
    setText(this.resultsSub, sub);
    const key = rows.map((row) => `${row.name}:${row.timeMs}:${row.paint.toFixed(2)}`).join("|");
    if (key === this.resultsKey) {
      return;
    }
    this.resultsKey = key;
    this.resultsRows.replaceChildren(
      ...rows.map((row) => {
        const line = document.createElement("div");
        line.className = "row";
        line.dataset["me"] = row.me ? "1" : "0";
        const place = document.createElement("b");
        place.className = "skew";
        place.textContent = ordinal(row.place);
        const chip = document.createElement("i");
        chip.style.background = row.color;
        const name = document.createElement("span");
        name.textContent = row.name;
        const paint = document.createElement("span");
        paint.className = "paint";
        paint.textContent = `${Math.round(row.paint * 100)}% paint`;
        const time = document.createElement("span");
        time.textContent = row.timeMs > 0 ? formatTime(row.timeMs) : "—";
        line.append(place, chip, name, paint, time);
        return line;
      }),
    );
  }

  setResultsNext(text: string): void {
    setText(this.resultsNext, text);
  }
}
