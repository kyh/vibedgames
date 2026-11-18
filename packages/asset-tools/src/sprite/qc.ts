import { existsSync, readFileSync } from "node:fs";

import { Bitmap } from "../image/raster.js";
import { roundHalfToEven } from "../pymath.js";
import { median } from "./frames.js";
import { isFiniteNumber, isJsonObject } from "./json.js";
import type { JsonValue } from "./json.js";

const ALPHA_ON = 16;

const EMPTY_AREA_FRAC = 0.003;
const CLIP_BORDER_FRAC = 0.01;
const BASELINE_TOL = 0.12;
const SIZE_DRIFT_TOL = 0.35;
const FACING_CX_TOL = 0.18;

const RULE_EDGE_FRAC = 0.95;
const RULE_INNER_FRAC = 0.5;
const RULE_INNER_OFFSET = 3;
const RULE_MIN_SPAN = 12;

export interface FrameMetrics {
  empty: boolean;
  area_frac: number;
  height: number;
  width: number;
  cx_frac: number;
  baseline_frac: number;
  border_frac: number;
  rule_edges: number;
}

export interface QcCheck {
  check: "empty" | "clip" | "grid" | "baseline" | "size" | "facing";
  severity: "warn" | "hint";
  frames: number[];
  detail: string;
  height_cov?: number;
}

export interface QcReport {
  sheet: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  columns: number;
  rows: number;
  verdict: "clean" | "review" | "warn";
  checks: QcCheck[];
  frames: FrameMetrics[];
}

const roundTo = (value: number, digits: number) => {
  const factor = 10 ** digits;

  return roundHalfToEven(value * factor) / factor;
};

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

const pstdev = (values: number[]) => {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;

  return Math.sqrt(variance);
};

const percent = (value: number, digits = 0) => `${roundTo(value * 100, digits).toFixed(digits)}%`;

export interface FrameGrid {
  frameWidth: number;
  frameHeight: number;
  count: number;
  columns: number;
  rows: number;
}

/**
 * Resolve the frame grid: an explicit override wins, then a sibling
 * `spritesheet.json` (which carries the real columns/rows for multi-row
 * sheets), else assume a single row of squares.
 */
export const frameGeometry = (
  sheet: Bitmap,
  sheetPath: string,
  frameWidth: number | null,
  frameHeight: number | null,
) => {
  if (frameWidth !== null && frameHeight !== null) {
    if (frameWidth <= 0 || frameHeight <= 0) {
      throw new Error("--frame-width and --frame-height must be positive");
    }

    const columns = Math.max(1, Math.floor(sheet.width / frameWidth));
    const rows = Math.max(1, Math.floor(sheet.height / frameHeight));

    return { columns, count: columns * rows, frameHeight, frameWidth, rows };
  }

  const manifestPath = sheetPath.replace(/\.[^./\\]+$/u, ".json");

  if (existsSync(manifestPath)) {
    const parsed: JsonValue = JSON.parse(readFileSync(manifestPath, "utf-8"));

    if (!isJsonObject(parsed)) {
      throw new Error(`${manifestPath}: expected an object`);
    }

    const m = parsed;

    const required = (key: string) => {
      const value = m[key];

      if (!isFiniteNumber(value) || value <= 0) {
        throw new Error(
          `${manifestPath}: "${key}" must be a positive number, got ${String(value)}`,
        );
      }

      return Math.trunc(value);
    };

    const optional = (key: string, fallback: number) => {
      const value = m[key];

      if (value === undefined) {
        return fallback;
      }

      if (!isFiniteNumber(value) || value <= 0) {
        throw new Error(
          `${manifestPath}: "${key}" must be a positive number, got ${String(value)}`,
        );
      }

      return Math.trunc(value);
    };

    const count = required("frameCount");

    return {
      columns: optional("columns", count),
      count,
      frameHeight: required("frameHeight"),
      frameWidth: required("frameWidth"),
      rows: optional("rows", 1),
    };
  }

  const side = sheet.height;
  const columns = Math.max(1, Math.floor(sheet.width / side));

  return { columns, count: columns, frameHeight: side, frameWidth: side, rows: 1 };
};

const isRuledEdge = (outer: number, inner: number) =>
  outer >= RULE_EDGE_FRAC && inner <= RULE_INNER_FRAC;

/** Per-frame alpha statistics, row-major across a possibly multi-row grid. */
export const frameMetrics = (
  sheet: Bitmap,
  index: number,
  geometry: { frameWidth: number; frameHeight: number; columns: number },
) => {
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

      if (!sheet.contains(sx, sy)) {
        continue;
      }

      if ((sheet.data[sheet.index(sx, sy) + 3] ?? 0) <= ALPHA_ON) {
        continue;
      }

      opaque += 1;
      xs.push(x);

      if (x < minX) {
        minX = x;
      }

      if (x > maxX) {
        maxX = x;
      }

      if (y < minY) {
        minY = y;
      }

      if (y > maxY) {
        maxY = y;
      }
    }
  }

  if (opaque === 0) {
    return {
      area_frac: 0,
      baseline_frac: 1,
      border_frac: 0,
      cx_frac: 0,
      empty: true,
      height: 0,
      rule_edges: 0,
      width: 0,
    };
  }

  let borderOpaque = 0;
  let borderTotal = 0;

  const sample = (x: number, y: number) => {
    borderTotal += 1;
    const sx = originX + x;
    const sy = originY + y;

    if (sheet.contains(sx, sy) && (sheet.data[sheet.index(sx, sy) + 3] ?? 0) > ALPHA_ON) {
      borderOpaque += 1;
    }
  };

  for (let x = 0; x < fw; x += 1) {
    sample(x, 0);
    sample(x, fh - 1);
  }

  for (let y = 0; y < fh; y += 1) {
    sample(0, y);
    sample(fw - 1, y);
  }

  const on = (x: number, y: number) =>
    sheet.contains(originX + x, originY + y) &&
    (sheet.data[sheet.index(originX + x, originY + y) + 3] ?? 0) > ALPHA_ON;

  const spanX = maxX - minX + 1;
  const spanY = maxY - minY + 1;

  const rowFrac = (y: number) => {
    let n = 0;

    for (let x = minX; x <= maxX; x += 1) {
      if (on(x, y)) {
        n += 1;
      }
    }

    return n / spanX;
  };

  const colFrac = (x: number) => {
    let n = 0;

    for (let y = minY; y <= maxY; y += 1) {
      if (on(x, y)) {
        n += 1;
      }
    }

    return n / spanY;
  };

  let ruleEdges = 0;

  if (spanX >= RULE_MIN_SPAN && spanY >= RULE_MIN_SPAN) {
    const inset = RULE_INNER_OFFSET;

    if (isRuledEdge(rowFrac(minY), rowFrac(clamp(minY + inset, minY, maxY)))) {
      ruleEdges += 1;
    }

    if (isRuledEdge(rowFrac(maxY), rowFrac(clamp(maxY - inset, minY, maxY)))) {
      ruleEdges += 1;
    }

    if (isRuledEdge(colFrac(minX), colFrac(clamp(minX + inset, minX, maxX)))) {
      ruleEdges += 1;
    }

    if (isRuledEdge(colFrac(maxX), colFrac(clamp(maxX - inset, minX, maxX)))) {
      ruleEdges += 1;
    }
  }

  const meanX = xs.reduce((sum, v) => sum + v, 0) / xs.length;

  return {
    area_frac: roundTo(opaque / (fw * fh), 4),
    baseline_frac: roundTo((maxY + 1) / fh, 4),
    border_frac: roundTo(borderOpaque / borderTotal, 4),
    cx_frac: roundTo((meanX - fw / 2) / fw, 4),
    empty: false,
    height: maxY - minY + 1,
    rule_edges: ruleEdges,
    width: maxX - minX + 1,
  };
};

const isLocalExtremum = (values: number[], i: number) => {
  if (i === 0 || i === values.length - 1) {
    return false;
  }

  const prev = values[i - 1] ?? 0;
  const next = values[i + 1] ?? 0;
  const value = values[i] ?? 0;

  return (value > prev && value > next) || (value < prev && value < next);
};

export const qc = (metrics: FrameMetrics[]) => {
  const checks: QcCheck[] = [];
  const live = metrics.map((m, i) => ({ index: i, m })).filter((entry) => !entry.m.empty);

  const empty = metrics
    .map((m, i) => (m.empty || m.area_frac < EMPTY_AREA_FRAC ? i + 1 : 0))
    .filter(Boolean);

  if (empty.length > 0) {
    checks.push({
      check: "empty",
      detail: `${empty.length} frame(s) blank or near-blank (area < ${percent(EMPTY_AREA_FRAC, 1)})`,
      frames: empty,
      severity: "warn",
    });
  }

  const clipped = metrics
    .map((m, i) => (m.border_frac > CLIP_BORDER_FRAC ? i + 1 : 0))
    .filter(Boolean);

  if (clipped.length > 0) {
    checks.push({
      check: "clip",
      detail: `${clipped.length} frame(s) touch the cell border (likely cut off)`,
      frames: clipped,
      severity: "warn",
    });
  }

  const ruled = metrics.map((m, i) => (m.rule_edges > 0 ? i + 1 : 0)).filter(Boolean);

  if (ruled.length > 0) {
    checks.push({
      check: "grid",
      detail:
        `${ruled.length} frame(s) contain a straight ruled line spanning the whole ` +
        `bounding box — the model inked the pose-board cell outlines and the slice ` +
        `baked them in. The rule also skews every size/baseline/facing measurement, ` +
        `so regenerate the board (restate "no grid lines, cell outlines or borders") ` +
        `rather than trusting the rest of this report`,
      frames: ruled,
      severity: "warn",
    });
  }

  if (live.length >= 2) {
    const baselines = live.map((entry) => entry.m.baseline_frac);
    const spread = Math.max(...baselines) - Math.min(...baselines);

    if (spread > BASELINE_TOL) {
      const medianBaseline = median(baselines);

      const worst = live
        .filter((entry) => Math.abs(entry.m.baseline_frac - medianBaseline) > BASELINE_TOL / 2)
        .map((entry) => entry.index + 1);

      checks.push({
        check: "baseline",
        detail: `foot baseline varies ${percent(spread)} of cell height (should be pinned by normalize)`,
        frames: worst,
        severity: "warn",
      });
    }

    const heights = live.map((entry) => entry.m.height);
    const medianHeight = median(heights);
    const cov = medianHeight ? roundTo(pstdev(heights) / medianHeight, 3) : 0;
    const drift = heights.map((h) => h / medianHeight);

    const sizeFrames = live
      .filter(
        (entry, k) =>
          Math.abs(entry.m.height / medianHeight - 1) > SIZE_DRIFT_TOL && isLocalExtremum(drift, k),
      )
      .map((entry) => entry.index + 1);

    if (sizeFrames.length > 0) {
      checks.push({
        check: "size",
        detail:
          `frame(s) are isolated size outliers (>${percent(SIZE_DRIFT_TOL)} off median height) ` +
          `— verify it is an intended pose change, not the model drawing the character ` +
          `at a different scale. height CoV=${cov}`,
        frames: sizeFrames,
        height_cov: cov,
        severity: "hint",
      });
    }

    const cxs = live.map((entry) => entry.m.cx_frac);
    const medianCx = median(cxs);

    const facingFrames = live
      .filter((entry) => Math.abs(entry.m.cx_frac - medianCx) > FACING_CX_TOL)
      .map((entry) => entry.index + 1);

    if (facingFrames.length > 0) {
      const signed = `${medianCx >= 0 ? "+" : ""}${medianCx.toFixed(2)}`;
      checks.push({
        check: "facing",
        detail:
          `frame(s) have horizontal mass far from the others (median cx=${signed}) ` +
          `— possible mirrored/flipped facing; eyeball the review gif`,
        frames: facingFrames,
        severity: "hint",
      });
    }
  }

  return checks;
};

export const verdictFor: (checks: QcCheck[]) => QcReport["verdict"] = (checks) => {
  if (checks.some((c) => c.severity === "warn")) {
    return "warn";
  }

  if (checks.some((c) => c.severity === "hint")) {
    return "review";
  }

  return "clean";
};

export const runQc: (
  sheetPath: string,
  frameWidth: number | null,
  frameHeight: number | null,
) => QcReport = (sheetPath, frameWidth, frameHeight) => {
  const sheet = Bitmap.fromFile(sheetPath);
  const geometry = frameGeometry(sheet, sheetPath, frameWidth, frameHeight);

  const metrics = Array.from({ length: geometry.count }, (_, i) =>
    frameMetrics(sheet, i, geometry),
  );

  const checks = qc(metrics);

  return {
    checks,
    columns: geometry.columns,
    frameCount: geometry.count,
    frameHeight: geometry.frameHeight,
    frameWidth: geometry.frameWidth,
    frames: metrics,
    rows: geometry.rows,
    sheet: sheetPath,
    verdict: verdictFor(checks),
  };
};
