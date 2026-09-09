import { readImageSize } from "../image/raster.js";
import { walkFiles } from "./paths.js";

/** One PNG's dimensions, as reported by `vg asset sizes`. */
export interface SizeRow {
  width: number;
  height: number;
  path: string;
}

/**
 * Report the dimensions of every PNG under `root`.
 *
 * Only the header is parsed, never the pixel data, so scanning a few hundred
 * sprite sheets stays effectively instant.
 */
export const collectSizes = (root: string): SizeRow[] => {
  const rows: SizeRow[] = [];
  for (const path of walkFiles(root, ".png")) {
    const size = readImageSize(path);
    if (!size) {
      throw new Error(`Could not read image dimensions: ${path}`);
    }
    rows.push({ height: size.height, path, width: size.width });
  }
  return rows;
};

/** CSV with the same column order the Python script wrote. */
const escapeCsv = (value: string) =>
  /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const sizesToCsv = (rows: SizeRow[]): string => {
  const lines = ["width,height,path"];
  for (const row of rows) {
    lines.push(`${row.width},${row.height},${escapeCsv(row.path)}`);
  }
  return `${lines.join("\n")}\n`;
};
