import { Bitmap } from "../image/raster.js";
import { roundHalfToEven } from "../lib/pymath.js";
import type { Size } from "./paths.js";

/**
 * Grid operations over sprite sheets: probing which cells actually contain
 * art, and normalising where the visible sprite sits inside each cell.
 */

export type ProbeResult = {
  path: string;
  frame: { w: number; h: number };
  grid: { columns: number; rows: number };
  non_empty: [number, number][];
  empty_count: number;
  empty?: [number, number][];
};

/** Split `size` into a `frame`-sized grid, or explain why it doesn't divide. */
function gridFor(path: string, size: Size, frame: Size): { columns: number; rows: number } {
  if (size.width % frame.width !== 0 || size.height % frame.height !== 0) {
    throw new Error(
      `${path} size ${size.width}x${size.height} not divisible by ${frame.width}x${frame.height}`,
    );
  }
  return { columns: size.width / frame.width, rows: size.height / frame.height };
}

/** Coordinate sort matching Python's tuple ordering: column first, then row. */
function byColumnThenRow(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** List which grid cells contain any non-transparent pixel. */
export function probeSheet(path: string, frame: Size, includeEmpty: boolean): ProbeResult {
  const image = Bitmap.fromFile(path);
  const { columns, rows } = gridFor(path, image, frame);

  const nonEmpty: [number, number][] = [];
  const empty: [number, number][] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const cell = image.crop({
        left: col * frame.width,
        top: row * frame.height,
        right: (col + 1) * frame.width,
        bottom: (row + 1) * frame.height,
      });
      if (cell.getBBox()) nonEmpty.push([col, row]);
      else empty.push([col, row]);
    }
  }

  const result: ProbeResult = {
    path,
    frame: { w: frame.width, h: frame.height },
    grid: { columns, rows },
    non_empty: [...nonEmpty].sort(byColumnThenRow),
    empty_count: empty.length,
  };
  // The original emitted `empty` in row-major order rather than sorted.
  if (includeEmpty) result.empty = empty;
  return result;
}

export type FrameBaseline = {
  index: number;
  col: number;
  row: number;
  empty: boolean;
  alphaBBox?: [number, number, number, number];
  visibleBottomY?: number;
  visibleCenterX?: number;
  shiftToTarget?: [number, number];
};

export type BaselineReport = {
  path: string;
  size: { width: number; height: number };
  frame: { width: number; height: number };
  grid: { columns: number; rows: number };
  targetBottomY: number;
  targetCenterX: number | null;
  visibleBottomYRange: [number, number] | null;
  shiftYRange: [number, number] | null;
  out: string | null;
  frames: FrameBaseline[];
};

/**
 * Audit where each frame's visible pixels sit, and optionally rewrite the
 * sheet with every sprite shifted onto a shared baseline.
 *
 * A character whose feet land on a different scanline in each frame bobs when
 * the animation plays; aligning the bottom of the alpha bounding box fixes it
 * without re-authoring the art.
 */
export function analyzeBaseline(
  path: string,
  frame: Size,
  targetBottom: number,
  targetCenterX: number | null,
  outPath: string | null,
): BaselineReport {
  const image = Bitmap.fromFile(path);
  const { columns, rows } = gridFor(path, image, frame);
  const fixed = outPath ? Bitmap.create(image.width, image.height) : null;
  const frames: FrameBaseline[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < columns; col += 1) {
      const left = col * frame.width;
      const top = row * frame.height;
      const cell = image.crop({
        left,
        top,
        right: left + frame.width,
        bottom: top + frame.height,
      });
      const bbox = cell.getBBox();
      const index = row * columns + col;

      if (!bbox) {
        frames.push({ index, col, row, empty: true });
        if (fixed) fixed.alphaComposite(cell, left, top);
        continue;
      }

      const bottomY = bbox.bottom - 1;
      const centerX = (bbox.left + bbox.right - 1) / 2;
      const shiftY = targetBottom - bottomY;
      const shiftX = targetCenterX === null ? 0 : roundHalfToEven(targetCenterX - centerX);

      frames.push({
        index,
        col,
        row,
        empty: false,
        alphaBBox: [bbox.left, bbox.top, bbox.right, bbox.bottom],
        visibleBottomY: bottomY,
        visibleCenterX: centerX,
        shiftToTarget: [shiftX, shiftY],
      });

      if (fixed) {
        const shifted = Bitmap.create(frame.width, frame.height);
        shifted.pasteMasked(cell, shiftX, shiftY, cell.channel(3));
        fixed.alphaComposite(shifted, left, top);
      }
    }
  }

  if (fixed && outPath) fixed.toFile(outPath);

  const visible = frames.filter((f) => !f.empty);
  const bottoms = visible.map((f) => f.visibleBottomY!);
  const shifts = visible.map((f) => f.shiftToTarget![1]);

  return {
    path,
    size: { width: image.width, height: image.height },
    frame: { width: frame.width, height: frame.height },
    grid: { columns, rows },
    targetBottomY: targetBottom,
    targetCenterX,
    visibleBottomYRange: bottoms.length ? [Math.min(...bottoms), Math.max(...bottoms)] : null,
    shiftYRange: shifts.length ? [Math.min(...shifts), Math.max(...shifts)] : null,
    out: outPath,
    frames,
  };
}
