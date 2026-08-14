import { readImageSize } from "../image/raster.js";
import { walkFiles } from "./paths.js";

/** One PNG's dimensions, as reported by `vg asset sizes`. */
export type SizeRow = { width: number; height: number; path: string };

/**
 * Report the dimensions of every PNG under `root`.
 *
 * Only the header is parsed, never the pixel data, so scanning a few hundred
 * sprite sheets stays effectively instant.
 */
export function collectSizes(root: string): SizeRow[] {
  const rows: SizeRow[] = [];
  for (const path of walkFiles(root, ".png")) {
    const size = readImageSize(path);
    if (!size) throw new Error(`Could not read image dimensions: ${path}`);
    rows.push({ width: size.width, height: size.height, path });
  }
  return rows;
}

/** CSV with the same column order the Python script wrote. */
export function sizesToCsv(rows: SizeRow[]): string {
  const escape = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = ["width,height,path"];
  for (const row of rows) {
    lines.push(`${row.width},${row.height},${escape(row.path)}`);
  }
  return `${lines.join("\n")}\n`;
}
