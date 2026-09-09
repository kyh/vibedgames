import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { Bitmap } from "../image/raster.js";
import { roundHalfToEven } from "../pymath.js";
import { globFrames, median } from "./frames.js";
import { isFiniteNumber, isJsonComposite, isJsonObject, isString } from "./json.js";
import type { JsonValue } from "./json.js";

/**
 * A size contract pins how big a character should appear and where it should
 * sit inside the runtime cell, so every action of one character stays the same
 * scale.
 *
 * Derive one from a reference action, then audit later actions against it. Two
 * clips generated independently will otherwise drift apart in scale and
 * baseline, and the mismatch only becomes obvious in-game when the character
 * visibly grows or sinks as it switches animations.
 */

/** Runtime cell size. */
export const FRAME_WIDTH = 256;
export const FRAME_HEIGHT = 256;

export interface Tolerances {
  maxTargetHeightDriftPct: number | null;
  maxIntraHeightDriftPct: number | null;
  maxBottomDriftPx: number | null;
  maxWidthOverflowPct: number | null;
  maxCenterDriftPx: number | null;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  maxBottomDriftPx: 2,
  maxCenterDriftPx: null,
  maxIntraHeightDriftPct: 0.08,
  maxTargetHeightDriftPct: 0.08,
  maxWidthOverflowPct: 0.12,
};

// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
export type Measurement = {
  frame: string;
  source: string;
  frameSize: [number, number];
  empty?: boolean;
  alphaBBox?: [number, number, number, number];
  visibleWidth?: number;
  visibleHeight?: number;
  visibleCenterX?: number;
  visibleBottomY?: number;
};

/** No visible pixels anywhere — nothing to measure beyond the frame count. */
export interface EmptySummary {
  frames: number;
  nonEmptyFrames: 0;
  frameSize: null;
}

// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
export type PopulatedSummary = {
  frames: number;
  nonEmptyFrames: number;
  frameSize: [number, number] | null;
  visibleWidthRange: [number, number];
  visibleHeightRange: [number, number];
  visibleBottomYRange: [number, number];
  visibleCenterXRange: [number, number];
  medianVisibleWidth: number;
  medianVisibleHeight: number;
  medianBottomY: number;
  medianCenterX: number;
  maxVisibleWidth: number;
  maxVisibleHeight: number;
  intraHeightDriftPct: number | null;
};

export type Summary = EmptySummary | PopulatedSummary;

/** `nonEmptyFrames === 0` and the missing measurement fields coincide by construction. */
const isEmptySummary = (summary: Summary): summary is EmptySummary => summary.nonEmptyFrames === 0;

/**
 * A size contract is a hand-edited JSON file, so beyond the keys
 * `loadSizeContract` actually validates, fields stay `JsonValue` and readers
 * coerce them defensively.
 */
export interface SizeContract {
  version?: JsonValue;
  kind?: JsonValue;
  name?: JsonValue;
  source?: JsonValue;
  sourceKind?: JsonValue;
  action?: JsonValue;
  direction?: JsonValue;
  runtimeCell?: JsonValue;
  sourceCanvas?: JsonValue;
  anchorPolicy?: JsonValue;
  pivot?: JsonValue;
  targetVisibleHeight?: JsonValue;
  targetVisibleWidth?: JsonValue;
  maxVisibleWidth?: JsonValue;
  targetBottomY?: JsonValue;
  targetCenterX?: JsonValue;
  tolerances?: Tolerances;
  measurementsSummary?: JsonValue;
  measurements?: JsonValue;
  promptGuidance?: JsonValue;
}

export interface SizeContractAudit {
  version: number;
  kind: string;
  stage: string;
  source: string;
  contract: SizeContract;
  status: "pass" | "warn";
  passed: boolean;
  summary: Summary;
  checks: Check[];
  measurements: Measurement[];
}

/** Python's `format(x, ".1%")` / `".0f"`, which round half to even. */
const percent = (value: number, digits = 1): string => {
  const factor = 10 ** digits;
  return `${(roundHalfToEven(value * 100 * factor) / factor).toFixed(digits)}%`;
};

const fixed0 = (value: number): string => roundHalfToEven(value).toFixed(0);

const optionalNumber = (value: JsonValue | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const measureBitmap = (
  image: Bitmap,
  label: string,
  source: string,
  frameSize: [number, number],
): Measurement => {
  const bbox = image.getBBox();
  const record: Measurement = { frame: label, frameSize, source };
  if (!bbox) {
    record.empty = true;
    return record;
  }
  record.empty = false;
  record.alphaBBox = [bbox.left, bbox.top, bbox.right, bbox.bottom];
  record.visibleWidth = bbox.right - bbox.left;
  record.visibleHeight = bbox.bottom - bbox.top;
  record.visibleCenterX = (bbox.left + bbox.right - 1) / 2;
  record.visibleBottomY = bbox.bottom - 1;
  return record;
};

/**
 * Measure a directory of frames, a packed sheet, or a single image. A file
 * whose dimensions divide evenly by the cell is treated as a sheet and split.
 */
export const measureSource = (
  source: string,
  cellSize: [number, number],
  frameGlob = "frame-*.png",
): Measurement[] => {
  if (existsSync(source) && statSync(source).isDirectory()) {
    // A directory holds one frame per file, so each frame's own size is its cell.
    return globFrames(source, frameGlob).map((file) => {
      const image = Bitmap.fromFile(file);
      return measureBitmap(image, path.basename(file), file, [image.width, image.height]);
    });
  }
  if (!existsSync(source)) {
    throw new Error(`missing size contract source: ${source}`);
  }

  const image = Bitmap.fromFile(source);
  const [cellW, cellH] = cellSize;
  if (
    image.width >= cellW &&
    image.height >= cellH &&
    image.width % cellW === 0 &&
    image.height % cellH === 0
  ) {
    const columns = image.width / cellW;
    const rows = image.height / cellH;
    const out: Measurement[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const index = row * columns + col + 1;
        const cell = image.crop({
          bottom: (row + 1) * cellH,
          left: col * cellW,
          right: (col + 1) * cellW,
          top: row * cellH,
        });
        out.push(
          measureBitmap(cell, `frame-${String(index).padStart(2, "0")}`, source, [cellW, cellH]),
        );
      }
    }
    return out;
  }
  return [measureBitmap(image, path.basename(source), source, [image.width, image.height])];
};

type LiveMeasurement = Measurement & {
  visibleWidth: number;
  visibleHeight: number;
  visibleBottomY: number;
  visibleCenterX: number;
};

/** `measureBitmap` sets every visible-* field together with `empty: false`. */
const isLiveMeasurement = (m: Measurement): m is LiveMeasurement =>
  !m.empty &&
  m.visibleWidth !== undefined &&
  m.visibleHeight !== undefined &&
  m.visibleBottomY !== undefined &&
  m.visibleCenterX !== undefined;

export const summarizeMeasurements = (measurements: Measurement[]): Summary => {
  const live = measurements.filter(isLiveMeasurement);
  if (live.length === 0) {
    return { frameSize: null, frames: measurements.length, nonEmptyFrames: 0 };
  }

  const widths = live.map((m) => m.visibleWidth);
  const heights = live.map((m) => m.visibleHeight);
  const bottoms = live.map((m) => m.visibleBottomY);
  const centers = live.map((m) => m.visibleCenterX);
  const frameSizes = live.map((m) => m.frameSize).filter(Boolean);
  const [first] = frameSizes;
  const uniform =
    first !== undefined && frameSizes.every((size) => size[0] === first[0] && size[1] === first[1]);
  const medianHeight = median(heights);

  return {
    frameSize: uniform && first !== undefined ? first : null,
    frames: measurements.length,
    intraHeightDriftPct: medianHeight
      ? (Math.max(...heights) - Math.min(...heights)) / medianHeight
      : null,
    maxVisibleHeight: Math.max(...heights),
    maxVisibleWidth: Math.max(...widths),
    medianBottomY: median(bottoms),
    medianCenterX: median(centers),
    medianVisibleHeight: medianHeight,
    medianVisibleWidth: median(widths),
    nonEmptyFrames: live.length,
    visibleBottomYRange: [Math.min(...bottoms), Math.max(...bottoms)],
    visibleCenterXRange: [Math.min(...centers), Math.max(...centers)],
    visibleHeightRange: [Math.min(...heights), Math.max(...heights)],
    visibleWidthRange: [Math.min(...widths), Math.max(...widths)],
  };
};

/**
 * A `[width, height]` pair, or nothing.
 *
 * A size contract is a JSON file people hand-edit, so `runtimeCell` arrives as
 * whatever they typed. Reading it as `number[]` and trusting the two slots
 * turns `"64x64"` or `[64]` into `NaN` that only surfaces later as a sprite
 * scaled to nothing.
 */
const asCellPair = (value: JsonValue | undefined): [number, number] | null => {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const [w, h] = value;
  if (!isFiniteNumber(w) || !isFiniteNumber(h)) {
    return null;
  }
  // A zero cell is not a cell. It passed as a pair, then made the whole sheet
  // one frame and audited `pass` against a grid that does not exist.
  if (w < 1 || h < 1) {
    return null;
  }
  return [Math.trunc(w), Math.trunc(h)];
};

/** Prompt text that keeps a generated clip on-scale for the runtime cell. */
export const promptGuidanceForContract = (contract: SizeContract): string[] => {
  const runtimeCell = asCellPair(contract.runtimeCell) ?? [FRAME_WIDTH, FRAME_HEIGHT];
  const targetHeight = optionalNumber(contract.targetVisibleHeight);
  const bottomY = optionalNumber(contract.targetBottomY);
  const pivotValue = contract.pivot;
  const pivot = isString(pivotValue) && pivotValue !== "" ? pivotValue : "base-center";

  const guidance = [
    "Use a locked camera: no zoom, pan, crop, or camera push-in/out.",
    "Keep the same apparent sprite scale as the input reference for the whole clip.",
    `Keep the sprite's ${pivot} fixed; motion should come from the action, not from sliding the whole sprite around the frame.`,
    "Keep the first and final frames close to the same scale and placement so the result can be packed into a game spritesheet.",
  ];
  if (targetHeight) {
    guidance.push(
      `After processing, the sprite should remain about ${targetHeight}px tall inside a ${runtimeCell[0]}x${runtimeCell[1]} runtime cell; treat this as scale guidance, not visible text.`,
    );
  }
  if (bottomY !== null) {
    guidance.push(
      `Keep the contact/base point visually stable; the intended runtime bottom anchor is y=${bottomY}.`,
    );
  }
  return guidance;
};

export interface Check {
  name: string;
  status: "pass" | "warn";
  message: string;
  observed?: unknown;
  target?: unknown;
}

const check = (
  name: string,
  passed: boolean,
  passMessage: string,
  warnMessage: string,
  observed: number | [number, number],
  target: number | [number, number],
): Check => ({
  message: passed ? passMessage : warnMessage,
  name,
  observed,
  status: passed ? "pass" : "warn",
  target,
});

export const contractChecks = (summary: Summary, contract: SizeContract): Check[] => {
  const tolerances = {
    ...DEFAULT_TOLERANCES,
    ...contract.tolerances,
  };
  if (isEmptySummary(summary)) {
    return [
      { message: "No non-empty frames were found.", name: "non-empty-frames", status: "warn" },
    ];
  }

  const checks: Check[] = [];

  const targetHeight = optionalNumber(contract.targetVisibleHeight);
  const medianHeight = optionalNumber(summary.medianVisibleHeight);
  const maxHeightDrift = optionalNumber(tolerances.maxTargetHeightDriftPct);
  if (targetHeight && medianHeight && maxHeightDrift !== null) {
    const range = summary.visibleHeightRange;
    const drift =
      Math.max(Math.abs(range[0] - targetHeight), Math.abs(range[1] - targetHeight)) / targetHeight;
    checks.push(
      check(
        "target-visible-height",
        drift <= maxHeightDrift,
        `height drift ${percent(drift)} <= ${percent(maxHeightDrift)}`,
        `height drift ${percent(drift)} > ${percent(maxHeightDrift)}`,
        range,
        targetHeight,
      ),
    );
  }

  const intraDrift = optionalNumber(summary.intraHeightDriftPct);
  const maxIntraDrift = optionalNumber(tolerances.maxIntraHeightDriftPct);
  if (intraDrift !== null && maxIntraDrift !== null) {
    checks.push(
      check(
        "intra-sequence-height",
        intraDrift <= maxIntraDrift,
        `intra-height drift ${percent(intraDrift)} <= ${percent(maxIntraDrift)}`,
        `intra-height drift ${percent(intraDrift)} > ${percent(maxIntraDrift)}`,
        summary.visibleHeightRange,
        maxIntraDrift,
      ),
    );
  }

  const targetBottom = optionalNumber(contract.targetBottomY);
  const maxBottomDrift = optionalNumber(tolerances.maxBottomDriftPx);
  if (targetBottom !== null && maxBottomDrift !== null) {
    const range = summary.visibleBottomYRange;
    const drift = Math.max(Math.abs(range[0] - targetBottom), Math.abs(range[1] - targetBottom));
    checks.push(
      check(
        "target-bottom-y",
        drift <= maxBottomDrift,
        `bottom drift ${fixed0(drift)}px <= ${fixed0(maxBottomDrift)}px`,
        `bottom drift ${fixed0(drift)}px > ${fixed0(maxBottomDrift)}px`,
        range,
        targetBottom,
      ),
    );
  }

  const maxWidth = optionalNumber(contract.maxVisibleWidth);
  const maxWidthOverflow = optionalNumber(tolerances.maxWidthOverflowPct);
  if (maxWidth && maxWidthOverflow !== null) {
    const observedMax = optionalNumber(summary.maxVisibleWidth);
    const overflow = Math.max(0, ((observedMax ?? 0) - maxWidth) / maxWidth);
    checks.push(
      check(
        "max-visible-width",
        overflow <= maxWidthOverflow,
        `width overflow ${percent(overflow)} <= ${percent(maxWidthOverflow)}`,
        `width overflow ${percent(overflow)} > ${percent(maxWidthOverflow)}`,
        summary.visibleWidthRange,
        maxWidth,
      ),
    );
  }

  const targetCenter = optionalNumber(contract.targetCenterX);
  const maxCenterDrift = optionalNumber(tolerances.maxCenterDriftPx);
  if (targetCenter !== null && maxCenterDrift !== null) {
    const range = summary.visibleCenterXRange;
    const drift = Math.max(Math.abs(range[0] - targetCenter), Math.abs(range[1] - targetCenter));
    checks.push(
      check(
        "target-center-x",
        drift <= maxCenterDrift,
        `center drift ${fixed0(drift)}px <= ${fixed0(maxCenterDrift)}px`,
        `center drift ${fixed0(drift)}px > ${fixed0(maxCenterDrift)}px`,
        range,
        targetCenter,
      ),
    );
  }

  return checks;
};

const BRIEF_KEYS: readonly (keyof SizeContract)[] = [
  "name",
  "source",
  "runtimeCell",
  "anchorPolicy",
  "pivot",
  "targetVisibleHeight",
  "targetVisibleWidth",
  "maxVisibleWidth",
  "targetBottomY",
  "targetCenterX",
  "tolerances",
];

const copyBriefKey = <K extends keyof SizeContract>(
  contract: SizeContract,
  out: SizeContract,
  key: K,
): void => {
  if (key in contract) {
    out[key] = contract[key];
  }
};

const contractBrief = (contract: SizeContract): SizeContract => {
  const out: SizeContract = {};
  for (const key of BRIEF_KEYS) {
    copyBriefKey(contract, out, key);
  }
  return out;
};

export const cellSizeOf = (contract: SizeContract): [number, number] =>
  asCellPair(contract.runtimeCell) ?? [FRAME_WIDTH, FRAME_HEIGHT];

export const loadSizeContract = (payload: JsonValue, source: string): SizeContract => {
  if (!isJsonObject(payload)) {
    throw new Error(`size contract must be a JSON object: ${source}`);
  }
  const data = payload;
  if (data.kind !== "sprite-size-contract") {
    throw new Error(`not a sprite size contract: ${source}`);
  }

  // Reject a malformed cell here, where the message can name the file, rather
  // than letting NaN travel into the measurements and audit.
  const runtimeCell =
    data.runtimeCell === undefined ? [FRAME_WIDTH, FRAME_HEIGHT] : asCellPair(data.runtimeCell);
  if (runtimeCell === null) {
    throw new Error(
      `runtimeCell must be [width, height] numbers, got ${JSON.stringify(data.runtimeCell)}: ${source}`,
    );
  }
  const { tolerances } = data;
  if (tolerances !== undefined && !isJsonComposite(tolerances)) {
    throw new Error(`tolerances must be an object, got ${JSON.stringify(tolerances)}: ${source}`);
  }
  // Defaults first, then the file's own keys — including ones this module does
  // not know about, which round-trip into audit reports.
  const mergedTolerances: Tolerances = { ...DEFAULT_TOLERANCES };
  if (tolerances !== undefined) {
    Object.assign(mergedTolerances, tolerances);
  }

  return {
    ...data,
    anchorPolicy: data.anchorPolicy ?? "grounded",
    pivot: data.pivot ?? "base-center",
    runtimeCell,
    tolerances: mergedTolerances,
  };
};

export const deriveSizeContract = (
  source: string,
  options: {
    cellSize?: [number, number];
    frameGlob?: string;
    name?: string | null;
    action?: string | null;
    direction?: string | null;
    anchorPolicy?: string;
    pivot?: string;
    sourceCanvas?: [number, number] | null;
    tolerances?: Partial<Tolerances>;
  } = {},
): SizeContract => {
  const {
    cellSize = [FRAME_WIDTH, FRAME_HEIGHT],
    frameGlob = "frame-*.png",
    name = null,
    action = null,
    direction = null,
    anchorPolicy = "grounded",
    pivot = "base-center",
    sourceCanvas = null,
    tolerances = {},
  } = options;

  const measurements = measureSource(source, cellSize, frameGlob);
  const summary = summarizeMeasurements(measurements);
  if (isEmptySummary(summary)) {
    throw new Error(`cannot derive size contract from empty source: ${source}`);
  }

  const targetVisibleHeight = roundHalfToEven(summary.medianVisibleHeight);
  const targetBottomY = roundHalfToEven(summary.medianBottomY);
  const isDir = existsSync(source) && statSync(source).isDirectory();

  return {
    action,
    anchorPolicy,
    direction,
    kind: "sprite-size-contract",
    maxVisibleWidth: summary.maxVisibleWidth,
    measurements,
    measurementsSummary: summary,
    name: name ?? path.basename(source).replace(/\.[^.]+$/u, ""),
    pivot,
    promptGuidance: promptGuidanceForContract({
      pivot,
      runtimeCell: [cellSize[0], cellSize[1]],
      targetBottomY,
      targetVisibleHeight,
    }),
    runtimeCell: [cellSize[0], cellSize[1]],
    source,
    sourceCanvas: sourceCanvas ?? summary.frameSize ?? null,
    sourceKind: isDir ? "directory" : "image",
    targetBottomY,
    targetCenterX: roundHalfToEven(summary.medianCenterX),
    targetVisibleHeight,
    targetVisibleWidth: roundHalfToEven(summary.medianVisibleWidth),
    tolerances: { ...DEFAULT_TOLERANCES, ...tolerances },
    version: 1,
  };
};

export const auditSizeContract = (
  source: string,
  contract: SizeContract,
  options: { cellSize?: [number, number] | null; frameGlob?: string; stage?: string } = {},
): SizeContractAudit => {
  const { cellSize = null, frameGlob = "frame-*.png", stage = "runtime" } = options;
  const measurements = measureSource(source, cellSize ?? cellSizeOf(contract), frameGlob);
  const summary = summarizeMeasurements(measurements);
  const checks = contractChecks(summary, contract);
  const passed = checks.every((c) => c.status === "pass");

  return {
    checks,
    contract: contractBrief(contract),
    kind: "sprite-size-contract-audit",
    measurements,
    passed,
    source,
    stage,
    status: passed ? "pass" : "warn",
    summary,
    version: 1,
  };
};
