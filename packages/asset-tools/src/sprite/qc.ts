import { existsSync, readFileSync } from "node:fs";

import { Bitmap } from "../image/raster.js";
import { roundHalfToEven } from "../pymath.js";
import { median } from "./frames.js";

/**
 * Quality-control a packed spritesheet — the eval that tells an agent whether
 * to ship the sheet or regenerate the board.
 *
 * The pose-board model has two recurring failure modes the deterministic
 * pipeline cannot fix on its own:
 *
 *  - SIZE DRIFT — the character is drawn at different scales across cells, so
 *    the sliced frames look like it grows and shrinks mid-animation.
 *  - FACING FLIP — one cell (often the first) is mirrored, so the character
 *    faces the wrong way for part of the animation.
 *
 * Plus the always-checkable ones: empty cells, frames clipping the cell edge,
 * and a foot baseline that wanders. Everything is measured from the alpha
 * channel.
 *
 * Hard checks are unambiguous defects and report `warn`. Soft checks need an
 * eyeball — a death collapse legitimately changes the character's height — so
 * they report `hint` and ask for verification rather than claiming a defect.
 */

/** Alpha above this counts as opaque. */
const ALPHA_ON = 16;

// Thresholds, as fractions of the cell unless noted.
const EMPTY_AREA_FRAC = 0.003;
const CLIP_BORDER_FRAC = 0.01;
const BASELINE_TOL = 0.12;
const SIZE_DRIFT_TOL = 0.35;
const FACING_CX_TOL = 0.18;

export type FrameMetrics = {
  empty: boolean;
  area_frac: number;
  height: number;
  width: number;
  cx_frac: number;
  baseline_frac: number;
  border_frac: number;
};

export type QcCheck = {
  check: "empty" | "clip" | "baseline" | "size" | "facing";
  severity: "warn" | "hint";
  frames: number[];
  detail: string;
  height_cov?: number;
};

export type QcReport = {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  columns: number;
  rows: number;
  verdict: "clean" | "review" | "warn";
  checks: QcCheck[];
  frames: FrameMetrics[];
};

/** Python's `round(value, digits)`: nearest, ties to even. */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return roundHalfToEven(value * factor) / factor;
}

/** Population standard deviation, matching `statistics.pstdev`. */
function pstdev(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Python's `format(x, ".Np%")`. Percent formatting rounds half to even there,
 * so a baseline spread of exactly 0.125 renders as "12%", not "13%" — the
 * boundary is reachable on real sheets, so `toFixed` alone disagrees.
 */
function percent(value: number, digits = 0): string {
  return `${roundTo(value * 100, digits).toFixed(digits)}%`;
}

/**
 * Resolve the frame grid: an explicit override wins, then a sibling
 * `spritesheet.json` (which carries the real columns/rows for multi-row
 * sheets), else assume a single row of squares.
 */
export function frameGeometry(
  sheet: Bitmap,
  sheetPath: string,
  frameWidth: number | null,
  frameHeight: number | null,
): { frameWidth: number; frameHeight: number; count: number; columns: number; rows: number } {
  if (frameWidth !== null && frameHeight !== null) {
    if (frameWidth <= 0 || frameHeight <= 0) {
      throw new Error("--frame-width and --frame-height must be positive");
    }
    const columns = Math.max(1, Math.floor(sheet.width / frameWidth));
    // Every row the sheet actually has, not just the first: a QC pass that
    // silently inspected an eighth of an 8-row sheet and reported CLEAN is
    // worse than no QC at all.
    const rows = Math.max(1, Math.floor(sheet.height / frameHeight));
    return { frameWidth, frameHeight, count: columns * rows, columns, rows };
  }

  const manifestPath = sheetPath.replace(/\.[^./\\]+$/, ".json");
  if (existsSync(manifestPath)) {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`${manifestPath}: expected an object`);
    }
    const m = parsed as Record<string, unknown>;
    // Read these rather than assert them. A manifest missing `frameCount` used
    // to produce `NaN` frames, which inspected nothing and reported CLEAN.
    const required = (key: string): number => {
      const value = m[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(
          `${manifestPath}: "${key}" must be a positive number, got ${String(value)}`,
        );
      }
      return Math.trunc(value);
    };
    const optional = (key: string, fallback: number): number => {
      const value = m[key];
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(
          `${manifestPath}: "${key}" must be a positive number, got ${String(value)}`,
        );
      }
      return Math.trunc(value);
    };
    const count = required("frameCount");
    return {
      frameWidth: required("frameWidth"),
      frameHeight: required("frameHeight"),
      count,
      columns: optional("columns", count),
      rows: optional("rows", 1),
    };
  }

  const side = sheet.height;
  const columns = Math.max(1, Math.floor(sheet.width / side));
  return { frameWidth: side, frameHeight: side, count: columns, columns, rows: 1 };
}

/** Per-frame alpha statistics, row-major across a possibly multi-row grid. */
export function frameMetrics(
  sheet: Bitmap,
  index: number,
  geometry: { frameWidth: number; frameHeight: number; columns: number },
): FrameMetrics {
  const { frameWidth: fw, frameHeight: fh, columns } = geometry;
  const row = Math.floor(index / columns);
  const col = index - row * columns;
  const originX = col * fw;
  const originY = row * fh;

  const xs: number[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let opaque = 0;

  for (let y = 0; y < fh; y += 1) {
    for (let x = 0; x < fw; x += 1) {
      const sx = originX + x;
      const sy = originY + y;
      if (!sheet.contains(sx, sy)) continue;
      if (sheet.data[sheet.index(sx, sy) + 3]! <= ALPHA_ON) continue;
      opaque += 1;
      xs.push(x);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (opaque === 0) {
    return {
      empty: true,
      area_frac: 0,
      height: 0,
      width: 0,
      cx_frac: 0,
      baseline_frac: 1,
      border_frac: 0,
    };
  }

  // The cell's four borders. Corners are counted twice, as in the original's
  // concatenation of the edge rows and columns.
  let borderOpaque = 0;
  let borderTotal = 0;
  const sample = (x: number, y: number) => {
    borderTotal += 1;
    const sx = originX + x;
    const sy = originY + y;
    if (sheet.contains(sx, sy) && sheet.data[sheet.index(sx, sy) + 3]! > ALPHA_ON)
      borderOpaque += 1;
  };
  for (let x = 0; x < fw; x += 1) {
    sample(x, 0);
    sample(x, fh - 1);
  }
  for (let y = 0; y < fh; y += 1) {
    sample(0, y);
    sample(fw - 1, y);
  }

  const meanX = xs.reduce((sum, v) => sum + v, 0) / xs.length;
  return {
    empty: false,
    area_frac: roundTo(opaque / (fw * fh), 4),
    height: maxY - minY + 1,
    width: maxX - minX + 1,
    // Horizontal mass offset from the cell centre, as a fraction of width.
    cx_frac: roundTo((meanX - fw / 2) / fw, 4),
    // Foot baseline: bottom of the figure as a fraction from the top.
    baseline_frac: roundTo((maxY + 1) / fh, 4),
    border_frac: roundTo(borderOpaque / borderTotal, 4),
  };
}

/**
 * True when `values[i]` is a spike or dip against both neighbours, so it is
 * NOT part of a monotonic trend. This is what separates scale drift from a
 * legitimate pose arc: a death collapse shrinks steadily and is spared, while
 * one oddly-sized cell in an otherwise uniform run is flagged.
 */
function isLocalExtremum(values: number[], i: number): boolean {
  if (i === 0 || i === values.length - 1) return false;
  const prev = values[i - 1]!;
  const next = values[i + 1]!;
  const value = values[i]!;
  return (value > prev && value > next) || (value < prev && value < next);
}

export function qc(metrics: FrameMetrics[]): QcCheck[] {
  const checks: QcCheck[] = [];
  const live = metrics.map((m, i) => ({ index: i, m })).filter((entry) => !entry.m.empty);

  const empty = metrics
    .map((m, i) => (m.empty || m.area_frac < EMPTY_AREA_FRAC ? i + 1 : 0))
    .filter(Boolean);
  if (empty.length > 0) {
    checks.push({
      check: "empty",
      severity: "warn",
      frames: empty,
      detail: `${empty.length} frame(s) blank or near-blank (area < ${percent(EMPTY_AREA_FRAC, 1)})`,
    });
  }

  const clipped = metrics
    .map((m, i) => (m.border_frac > CLIP_BORDER_FRAC ? i + 1 : 0))
    .filter(Boolean);
  if (clipped.length > 0) {
    checks.push({
      check: "clip",
      severity: "warn",
      frames: clipped,
      detail: `${clipped.length} frame(s) touch the cell border (likely cut off)`,
    });
  }

  if (live.length >= 2) {
    const baselines = live.map((entry) => entry.m.baseline_frac);
    const spread = Math.max(...baselines) - Math.min(...baselines);
    if (spread > BASELINE_TOL) {
      const medianBaseline = median(baselines);
      const worst = live
        .filter((_, k) => Math.abs(baselines[k]! - medianBaseline) > BASELINE_TOL / 2)
        .map((entry) => entry.index + 1);
      checks.push({
        check: "baseline",
        severity: "warn",
        frames: worst,
        detail: `foot baseline varies ${percent(spread)} of cell height (should be pinned by normalize)`,
      });
    }

    const heights = live.map((entry) => entry.m.height);
    const medianHeight = median(heights);
    const cov = medianHeight ? roundTo(pstdev(heights) / medianHeight, 3) : 0;
    const drift = heights.map((h) => h / medianHeight);
    const sizeFrames = live
      .filter((_, k) => Math.abs(drift[k]! - 1) > SIZE_DRIFT_TOL && isLocalExtremum(drift, k))
      .map((entry) => entry.index + 1);
    if (sizeFrames.length > 0) {
      checks.push({
        check: "size",
        severity: "hint",
        frames: sizeFrames,
        height_cov: cov,
        detail:
          `frame(s) are isolated size outliers (>${percent(SIZE_DRIFT_TOL)} off median height) ` +
          `— verify it is an intended pose change, not the model drawing the character ` +
          `at a different scale. height CoV=${cov}`,
      });
    }

    const cxs = live.map((entry) => entry.m.cx_frac);
    const medianCx = median(cxs);
    const facingFrames = live
      .filter((_, k) => Math.abs(cxs[k]! - medianCx) > FACING_CX_TOL)
      .map((entry) => entry.index + 1);
    if (facingFrames.length > 0) {
      const signed = `${medianCx >= 0 ? "+" : ""}${medianCx.toFixed(2)}`;
      checks.push({
        check: "facing",
        severity: "hint",
        frames: facingFrames,
        detail:
          `frame(s) have horizontal mass far from the others (median cx=${signed}) ` +
          `— possible mirrored/flipped facing; eyeball the review gif`,
      });
    }
  }

  return checks;
}

export function verdictFor(checks: QcCheck[]): QcReport["verdict"] {
  if (checks.some((c) => c.severity === "warn")) return "warn";
  if (checks.some((c) => c.severity === "hint")) return "review";
  return "clean";
}

export function runQc(
  sheetPath: string,
  frameWidth: number | null,
  frameHeight: number | null,
): QcReport {
  const sheet = Bitmap.fromFile(sheetPath);
  const geometry = frameGeometry(sheet, sheetPath, frameWidth, frameHeight);
  const metrics = Array.from({ length: geometry.count }, (_, i) =>
    frameMetrics(sheet, i, geometry),
  );
  const checks = qc(metrics);
  return {
    sheet: sheetPath,
    frameWidth: geometry.frameWidth,
    frameHeight: geometry.frameHeight,
    frameCount: geometry.count,
    columns: geometry.columns,
    rows: geometry.rows,
    verdict: verdictFor(checks),
    checks,
    frames: metrics,
  };
}
