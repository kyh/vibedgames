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

function el(id: string): HTMLElement | null {
  return document.querySelector(`#${id}`);
}

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
export type HudMode = "legend" | "hotkeys" | "none";

const isIdle = (status: Status): boolean => status === "title" || status === "gameOver";

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

  /** Rebuild the banner legend from the controls manifest, one row per
   *  visible input method (boot-time, not on first touch — the copy must be
   *  right before the player ever taps). Rows are the pause overlay's own
   *  method-label + keycap-chip rows, so title and pause teach with one UI. */
  renderLegend(): void {
    const legend = el("legend");
    if (!legend) {
      return;
    }
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    legend.replaceChildren(...controlGroups(CONTROLS).map((group) => groupRow(group, coarse)));
  }

  update(frame: HudFrame): void {
    if (frame.score !== this.score) {
      this.score = frame.score;
      const node = el("score");
      if (node) {
        node.textContent = `SCORE ${frame.score}`;
      }
    }
    if (frame.lines !== this.lines) {
      this.lines = frame.lines;
      const node = el("lines");
      if (node) {
        node.textContent = `LINES ${frame.lines}`;
      }
    }
    if (frame.nextIndex !== this.nextIdx) {
      this.nextIdx = frame.nextIndex;
      const cv = el("next-canvas");
      const def = PIECES[frame.nextIndex];
      if (cv instanceof HTMLCanvasElement && def) {
        drawPiecePreview(cv, def.footprint, def.color);
      }
    }
    if (frame.holdIndex !== this.holdIdx) {
      this.holdIdx = frame.holdIndex;
      const cv = el("hold-canvas");
      if (cv instanceof HTMLCanvasElement) {
        const def = frame.holdIndex === null ? null : PIECES[frame.holdIndex];
        drawPiecePreview(cv, def?.footprint ?? null, def?.color ?? 0);
      }
    }
    if (frame.holdSpent !== this.holdSpent) {
      this.holdSpent = frame.holdSpent;
      const preview = el("hold-preview");
      if (preview) {
        preview.dataset.spent = String(frame.holdSpent);
      }
      const status = el("hold-status");
      if (status) {
        status.hidden = !frame.holdSpent;
      }
      const hint = el("hold-hint");
      if (hint) {
        hint.hidden = !frame.holdSpent;
      }
    }
    const charge = Math.round(frame.charge * 100);
    if (charge !== this.charge) {
      this.charge = charge;
      const node = el("charge");
      if (node) {
        const full = this.coarse ? "✦ POWER (T-pose / PWR)" : "✦ POWER (T-pose / F)";
        node.textContent = charge >= 100 ? full : `POWER ${charge}%`;
      }
    }
    if (frame.owner !== this.owner) {
      this.owner = frame.owner;
      const node = el("input-owner");
      if (node) {
        node.textContent =
          frame.owner === "POSE" || frame.owner === "PAD" ? `● ${frame.owner}` : `○ ${frame.owner}`;
      }
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

  /** Fill the results card; `showBanner("gameOver", ...)` reveals it. */
  showResults(result: RunResult): void {
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
  }

  /** Show the centre banner for `status`: the teaching card on the title, the
   *  results card on game over, the Play button on either. */
  showBanner(status: Status, title: string, sub: string, mode: HudMode): void {
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
    this.setRunActions(status);
    this.setMode(mode);
  }

  /** Hide the banner. In play the quiet hotkey bar carries the reference; the
   *  full legend lives on the title banner (and the wrapper pause overlay
   *  renders its own copy from the same manifest). */
  hideBanner(status: Status): void {
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
    this.setRunActions(status);
    this.setMode("hotkeys");
  }

  private setRunActions(status: Status): void {
    const actions = el("run-actions");
    if (actions) {
      actions.hidden = !isIdle(status);
    }
  }

  private setMode(mode: HudMode): void {
    const legend = el("legend");
    if (legend) {
      legend.style.display = mode === "legend" ? "flex" : "none";
    }
    const hotkeys = el("hotkeys");
    // Touch has no keyboard to reference and the bar lands on the DROP/HOLD
    // buttons; an inline display would beat the stylesheet's `body.touch` rule.
    if (hotkeys) {
      hotkeys.style.display = mode === "hotkeys" && !this.coarse ? "flex" : "none";
    }
  }
}
