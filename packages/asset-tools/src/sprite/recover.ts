import { Bitmap } from "../image/raster.js";

/**
 * Recover individual poses from a generated pose board by finding connected
 * blobs of non-background pixels, rather than slicing the grid uniformly.
 *
 * Image models rarely land poses on an exact grid — a character drifts out of
 * its cell, or an attack arc overhangs the next one. Uniform slicing then cuts
 * limbs in half. Finding each pose as a connected component and cropping to
 * its own bounds survives that drift; the grid is used only to decide which
 * cell a recovered pose belongs to.
 */

export interface Component {
  area: number;
  bbox: [number, number, number, number];
  center: [number, number];
  points: number[];
}

export interface RecoverResult {
  sheet: string;
  bg_rgb: [number, number, number];
  rows: number;
  cols: number;
  threshold: number;
  requested_frames?: number;
  frames: {
    frame: string;
    bbox: [number, number, number, number];
    area: number;
    center: [number, number];
    path: string;
  }[];
}

const sampleBackground: (image: Bitmap) => [number, number, number] = (image) => {
  const corners = [
    image.getPixel(0, 0),
    image.getPixel(image.width - 1, 0),
    image.getPixel(0, image.height - 1),
    image.getPixel(image.width - 1, image.height - 1),
  ];

  const average = (channel: 0 | 1 | 2) =>
    Math.round(corners.reduce((sum, c) => sum + c[channel], 0) / corners.length);

  return [average(0), average(1), average(2)];
};

const foregroundMask = (image: Bitmap, background: [number, number, number], threshold: number) => {
  const { width, height } = image;
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = image.getPixel(x, y);

      const distance =
        Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]);

      if (distance > threshold) {
        mask[y * width + x] = 1;
      }
    }
  }

  return mask;
};

export const findComponents = (
  image: Bitmap,
  background: [number, number, number],
  threshold: number,
) => {
  const { width, height } = image;
  const mask = foregroundMask(image, background, threshold);

  const seen = new Uint8Array(width * height);
  const components: Component[] = [];
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const visit = (n: number) => {
    if ((seen[n] ?? 0) !== 0 || (mask[n] ?? 0) === 0) {
      return;
    }

    seen[n] = 1;
    queue[tail] = n;
    tail += 1;
  };

  for (let startY = 0; startY < height; startY += 1) {
    for (let startX = 0; startX < width; startX += 1) {
      const start = startY * width + startX;

      if ((seen[start] ?? 0) !== 0 || (mask[start] ?? 0) === 0) {
        continue;
      }

      head = 0;
      tail = 0;
      queue[tail] = start;
      tail += 1;
      seen[start] = 1;

      const points: number[] = [];
      let minX = startX;
      let maxX = startX;
      let minY = startY;
      let maxY = startY;

      while (head < tail) {
        const index = queue[head] ?? 0;
        head += 1;
        const y = Math.floor(index / width);
        const x = index - y * width;
        points.push(index);

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

        if (x + 1 < width) {
          visit(index + 1);
        }

        if (x > 0) {
          visit(index - 1);
        }

        if (y + 1 < height) {
          visit(index + width);
        }

        if (y > 0) {
          visit(index - width);
        }
      }

      components.push({
        area: points.length,
        bbox: [minX, minY, maxX, maxY],
        center: [(minX + maxX) / 2, (minY + maxY) / 2],
        points,
      });
    }
  }

  return components;
};

export interface RecoverOutput {
  result: RecoverResult;
  crops: { index: number; image: Bitmap }[];
}

/**
 * Assign recovered blobs to grid cells and crop each to its own bounds.
 *
 * Only the `frames` largest blobs are considered, so speckle and JPEG-ish
 * noise in the matte never claim a cell. When two blobs land in one cell the
 * larger wins — that is the pose, the other is a detached shadow or spark.
 */
export const recoverFrames = (
  sheetPath: string,
  options: { rows: number; cols: number; frames: number | null; threshold: number },
) => {
  const { rows, cols, frames, threshold } = options;

  if (rows <= 0 || cols <= 0) {
    throw new Error("--rows and --cols must be positive integers");
  }

  if (frames !== null && frames <= 0) {
    throw new Error("--frames must be a positive integer");
  }

  const image = Bitmap.fromFile(sheetPath);
  const background = sampleBackground(image);
  const components = findComponents(image, background, threshold);

  const wanted = rows * cols;
  const selected = [...components].toSorted((a, b) => b.area - a.area).slice(0, wanted);

  const assigned: (Component | null)[] = Array.from({ length: wanted }, () => null);
  const cellWidth = image.width / cols;
  const cellHeight = image.height / rows;

  for (const component of selected) {
    const col = Math.min(cols - 1, Math.max(0, Math.floor(component.center[0] / cellWidth)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(component.center[1] / cellHeight)));
    const index = row * cols + col;
    const current = assigned[index] ?? null;

    if (current === null || component.area > current.area) {
      assigned[index] = component;
    }
  }

  const required = frames === null ? wanted : Math.min(frames, wanted);

  const missing = assigned.slice(0, required).flatMap((item, i) => (item === null ? [i + 1] : []));

  if (missing.length > 0) {
    throw new Error(
      `Recovery found ${components.length} distinct pose(s) but ${required} frame(s) were requested; ` +
        `grid slots ${missing.join(", ")} came up empty. The model likely merged poses across cells ` +
        `or laid out fewer than ${required}. Re-run without --recover to slice the grid uniformly instead.`,
    );
  }

  const emitted = frames === null ? assigned : assigned.slice(0, required);

  const result: RecoverResult = {
    bg_rgb: background,
    cols,
    frames: [],
    rows,
    sheet: sheetPath,
    threshold,
  };

  if (frames !== null) {
    result.requested_frames = required;
  }

  const crops = emitted.map((component, i) => {
    if (!component) {
      throw new Error("internal: unassigned frame slot survived validation");
    }

    const [minX, minY, maxX, maxY] = component.bbox;
    const crop = Bitmap.create(maxX - minX + 1, maxY - minY + 1);

    for (const point of component.points) {
      const y = Math.floor(point / image.width);
      const x = point - y * image.width;
      crop.putPixel(x - minX, y - minY, image.getPixel(x, y));
    }

    return {
      area: component.area,
      bbox: component.bbox,
      center: component.center,
      image: crop,
      index: i + 1,
      label: String(i + 1).padStart(2, "0"),
    };
  });

  return { crops, result };
};
