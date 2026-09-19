// Every DOM write the game makes: the score / preview pills, the input-owner
// badge, the catch meter, and the centre banner (title legend, CATCH IT!,
// results card). The scene decides what to show and hands over plain values;
// this module is the only code that knows the markup in index.html. Values are
// cached so a frame that changes nothing touches no DOM.

import { controlGroups } from "@repo/embed";

import { CONTROLS } from "../controls";
import { mountRuleTeaching } from "../game/rule-teaching";
import type { Status } from "../game/state";
import { groupRow } from "../pause-overlay";
import { CATCH_WINDOW_MS, PIECES } from "../shared/constants";
import { drawPiecePreview } from "./piece-preview";

const el = (id: string): HTMLElement | null => document.querySelector(`#${id}`);

/** Which input drove the last action — the badge beside the power pill. */
export type InputOwner = "POSE" | "PAD" | "KEYS" | "TOUCH";

export interface HudFrame {
  score: number;
  lines: number;
  nextIndex: number;
  holdIndex: number | null;
  holdSpent: boolean;
  /** 0..1 */
  charge: number;
  owner: InputOwner;
}

export interface RunResult {
  score: number;
  best: number;
  newBest: boolean;
  lines: number;
  pieces: number;
  rescues: number;
  largestClear: number;
}

/** What sits under the banner: the full legend (title), the quiet hotkey bar
 *  (play), or nothing (catch / results). */
export type HudMode = "legend" | "none";

const setMode = (mode: HudMode): void => {
  const legend = el("legend");
  if (legend) {
    legend.style.display = mode === "legend" ? "flex" : "none";
  }
};

const isIdle = (status: Status): boolean => status === "title" || status === "gameOver";

const setRunActions = (status: Status): void => {
  const actions = el("run-actions");
  if (actions) {
    actions.hidden = !isIdle(status);
  }
};

/** Rebuild the banner legend from the controls manifest, one row per
 *  visible input method (boot-time, not on first touch — the copy must be
 *  right before the player ever taps). Rows are the pause overlay's own
 *  method-label + keycap-chip rows, so title and pause teach with one UI. */
export const renderLegend = (): void => {
  const legend = el("legend");
  if (!legend) {
    return;
  }
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  legend.replaceChildren(...controlGroups(CONTROLS).map((group) => groupRow(group, coarse)));
};

/** Fill the results card; `showBanner("gameOver", ...)` reveals it. */
export const showResults = (result: RunResult): void => {
  const score = el("result-score");
  const best = el("result-best");
  const stats = el("result-stats");
  if (score) {
    score.textContent = String(result.score);
  }
  if (best) {
    best.textContent = `${result.newBest ? "NEW BEST" : "BEST"} ${result.best}`;
  }
  if (stats) {
    const { lines, pieces, rescues } = result;
    stats.textContent = `${lines} ${lines === 1 ? "line" : "lines"} · ${pieces} ${pieces === 1 ? "piece" : "pieces"} placed\n${rescues} ${rescues === 1 ? "rescue" : "rescues"} · largest clear ${result.largestClear}`;
  }
};

export class Hud {
  private readonly coarse: boolean;
  private score = -1;
  private lines = -1;
  private owner = "";
  private nextIdx = -2;
  private holdIdx: number | null = -2;
  private holdSpent: boolean | null = null;
  private charge = -1;
  private catchTenths = -1;

  constructor(coarse: boolean, onStart: () => void) {
    this.coarse = coarse;
    el("compact-start")?.addEventListener("click", onStart);
    const rules = el("spatial-rule");
    if (rules) {
      mountRuleTeaching(rules);
    }
  }

  update(frame: HudFrame): void {
    this.updateScore(frame.score);
    this.updateLines(frame.lines);
    this.updateNext(frame.nextIndex);
    this.updateHold(frame.holdIndex);
    this.updateHoldSpent(frame.holdSpent);
    this.updateCharge(frame.charge);
    this.updateOwner(frame.owner);
  }

  private updateScore(score: number): void {
    if (score === this.score) {
      return;
    }
    this.score = score;
    const node = el("score");
    if (node) {
      node.textContent = `SCORE ${score}`;
    }
  }

  private updateLines(lines: number): void {
    if (lines === this.lines) {
      return;
    }
    this.lines = lines;
    const node = el("lines");
    if (node) {
      node.textContent = `LINES ${lines}`;
    }
  }

  private updateNext(nextIndex: number): void {
    if (nextIndex === this.nextIdx) {
      return;
    }
    this.nextIdx = nextIndex;
    const cv = el("next-canvas");
    const def = PIECES[nextIndex];
    if (cv instanceof HTMLCanvasElement && def) {
      drawPiecePreview(cv, def.footprint, def.color);
    }
  }

  private updateHold(holdIndex: number | null): void {
    if (holdIndex === this.holdIdx) {
      return;
    }
    this.holdIdx = holdIndex;
    const cv = el("hold-canvas");
    if (cv instanceof HTMLCanvasElement) {
      const def = holdIndex === null ? null : PIECES[holdIndex];
      drawPiecePreview(cv, def?.footprint ?? null, def?.color ?? 0);
    }
  }

  private updateHoldSpent(holdSpent: boolean): void {
    if (holdSpent === this.holdSpent) {
      return;
    }
    this.holdSpent = holdSpent;
    const preview = el("hold-preview");
    if (preview) {
      preview.dataset.spent = String(holdSpent);
    }
    const status = el("hold-status");
    if (status) {
      status.hidden = !holdSpent;
    }
    const hint = el("hold-hint");
    if (hint) {
      hint.hidden = !holdSpent;
    }
  }

  private updateCharge(fraction: number): void {
    const charge = Math.round(fraction * 100);
    if (charge === this.charge) {
      return;
    }
    this.charge = charge;
    const node = el("charge");
    if (node) {
      const full = this.coarse ? "✦ POWER (T-pose / PWR)" : "✦ POWER (T-pose / F)";
      node.textContent = charge >= 100 ? full : `POWER ${charge}%`;
    }
  }

  private updateOwner(owner: InputOwner): void {
    if (owner === this.owner) {
      return;
    }
    this.owner = owner;
    const node = el("input-owner");
    if (node) {
      node.textContent = owner === "POSE" || owner === "PAD" ? `● ${owner}` : `○ ${owner}`;
    }
  }

  /** `remainingMs` null = not collapsing (meter hidden). */
  setCatchMeter(remainingMs: number | null): void {
    const meter = el("catch-meter");
    if (meter) {
      meter.hidden = remainingMs === null;
    }
    if (remainingMs === null) {
      this.catchTenths = -1;
      return;
    }
    if (meter) {
      meter.setAttribute("aria-valuenow", (remainingMs / CATCH_WINDOW_MS).toFixed(3));
    }
    const fill = el("catch-fill");
    if (fill) {
      fill.style.transform = `scaleX(${remainingMs / CATCH_WINDOW_MS})`;
    }
    const tenths = Math.ceil(remainingMs / 100);
    if (tenths !== this.catchTenths) {
      this.catchTenths = tenths;
      const label = el("catch-time");
      if (label) {
        label.textContent = `${(tenths / 10).toFixed(1)}s to catch`;
      }
      if (meter) {
        meter.setAttribute("aria-valuetext", `${(tenths / 10).toFixed(1)} seconds to catch`);
      }
    }
  }
}

/** Show the centre banner for `status`: the teaching card on the title, the
 *  results card on game over, the Play button on either. */
export const showBanner = (status: Status, title: string, sub: string, mode: HudMode): void => {
  const t = el("banner-title");
  const s = el("banner-sub");
  const b = el("banner");
  if (t) {
    t.textContent = title;
  }
  if (s) {
    s.textContent = sub;
  }
  if (b) {
    b.style.opacity = "1";
    b.dataset.phase = status;
    b.setAttribute("aria-hidden", "false");
  }
  const teaching = el("spatial-rule");
  const summary = el("run-summary");
  const start = el("compact-start");
  if (teaching) {
    teaching.hidden = status !== "title";
  }
  if (summary) {
    summary.hidden = status !== "gameOver";
  }
  if (start) {
    start.textContent = status === "gameOver" ? "Play again" : "Play";
  }
  setRunActions(status);
  setMode(mode);
};

/** Hide the banner. The full legend lives on the title banner (and the
 *  wrapper pause overlay renders its own copy from the same manifest). */
export const hideBanner = (status: Status): void => {
  const b = el("banner");
  if (b) {
    b.style.opacity = "0";
    b.dataset.phase = status;
    b.setAttribute("aria-hidden", "true");
  }
  const teaching = el("spatial-rule");
  const summary = el("run-summary");
  if (teaching) {
    teaching.hidden = true;
  }
  if (summary) {
    summary.hidden = true;
  }
  setRunActions(status);
  setMode("none");
};
