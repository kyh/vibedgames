/**
 * `@repo/asset-tools` — the image and sprite-sheet logic behind the
 * asset-pipeline skills.
 *
 * This package exists so that logic can be written once, typed, and covered by
 * tests, while the skills still ship plain `node` scripts the way
 * `check-canvas.mjs` always has. `pnpm build` bundles this entry point into a
 * dependency-free `scripts/_lib/asset-tools.mjs` inside each skill that needs
 * it, so a skill directory stays self-contained and copyable — no
 * `node_modules`, no Python, no `uv`.
 *
 * Everything here is pure Node: the only runtime import in the whole package
 * is `node:zlib`, which powers the PNG codec.
 */

export { type Args, fail, getAll, getFlag, getNumber, getString, main, parseArgs } from "./args.js";
export { parseColor, toHex } from "./image/color.js";
export { drawDigits, drawLine, fillRect, strokeRect } from "./image/draw.js";
export { encodeGif, type GifFrame } from "./image/gif.js";
export { decodePng, type DecodedPng, encodePng, readPngSize } from "./image/png.js";
export {
  Bitmap,
  readImageSize,
  type Rect,
  type ResampleMode,
  type RGB,
  type RGBA,
} from "./image/raster.js";

export { LuaParseError, type LuaValue, parseLua } from "./asset/lua.js";
export {
  autoDetectManifest,
  checkManifest,
  exportManifest,
  extractManifestPaths,
  type ManifestCheck,
  MANIFEST_CANDIDATES,
} from "./asset/manifest.js";
export {
  defaultRoot,
  parseFrame,
  prettyPath,
  resolveTargets,
  type Size,
  walkFiles,
  writeJsonFile,
  writeTextFile,
} from "./asset/paths.js";
export {
  analyzeBaseline,
  type BaselineReport,
  type FrameBaseline,
  probeSheet,
  type ProbeResult,
} from "./asset/sheet.js";
export { collectSizes, type SizeRow, sizesToCsv } from "./asset/sizes.js";
export {
  cropBox,
  exportMapRender,
  exportTilesetGrid,
  type FillRect,
  loadManifestJson,
  makeSelftestMap,
  MANIFEST_JSON_CANDIDATES,
  nonEmptyTileIds,
  sanitizeTilesets,
  tileCount,
  tileIdFromColRow,
  type TilesetMeta,
  tilesetMetaFromManifest,
} from "./asset/tilemap.js";

export { globFrames, type LoadedFrame, loadFrames, median } from "./sprite/frames.js";
export { normalizeCanvas } from "./sprite/normalize.js";
export {
  type Component,
  findComponents,
  recoverFrames,
  type RecoverResult,
} from "./sprite/recover.js";
export { buildSequenceGif } from "./sprite/sequence-gif.js";
export { packSpritesheet, type PackResult, type SpritesheetManifest } from "./sprite/pack.js";

export { roundHalfToEven } from "./pymath.js";
