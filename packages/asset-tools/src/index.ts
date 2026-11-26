/**
 * `@repo/asset-tools` — the image and sprite-sheet logic behind the
 * asset-pipeline skills.
 *
 * This package exists so that logic can be written once, typed, and covered by
 * tests, while the skills still ship scripts plain `node` runs as they are.
 * `pnpm build` bundles this entry point into a
 * dependency-free `scripts/_lib/asset-tools.mjs` inside each skill that needs
 * it, so a skill directory stays self-contained and copyable — no
 * `node_modules`, no Python, no `uv`.
 *
 * Everything here is pure Node: the only runtime import in the whole package
 * is `node:zlib`, which powers the PNG codec.
 */

export {
  type Args,
  fail,
  failUsage,
  getAll,
  getFlag,
  getInt,
  getNumber,
  getString,
  main,
  parseArgs,
} from "./args.js";

export { parseColor, toHex } from "./image/color.js";

export { diffImages, type DiffResult } from "./image/diff.js";

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

export {
  ASEPRITE_COMMON_TYPOS,
  ASEPRITE_EXTENSIONS,
  type AsepriteCel,
  type AsepriteFrame,
  type AsepriteInspection,
  type AsepriteLayer,
  AsepriteParseError,
  type AsepriteTag,
  type Bounds,
  inferBoundsFromPixels,
  inspectAseprite,
  type InspectOptions,
  type PropertyValue,
  type UserData,
} from "./asset/aseprite.js";

export {
  isFiniteJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonObject,
  type JsonValue,
  parseJsonText,
} from "./asset/json.js";

export { LuaParseError, type LuaValue, parseLua } from "./asset/lua.js";

export {
  createTilemapEditor,
  DEFAULT_MAP_HEIGHT,
  DEFAULT_MAP_WIDTH,
  type EditorHandle,
  type EditorOptions,
  isInside,
} from "./asset/tilemap-server.js";

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
  toPythonJson,
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
  MAP_MAX,
  MAP_MIN,
  newMap,
  nonEmptyTileIds,
  normalizeMapData,
  parseTilemap,
  sanitizeTilesets,
  tileCount,
  tileIdFromColRow,
  type TilemapDoc,
  tilemapPayload,
  type TilesetMeta,
  tilesetMetaFromManifest,
} from "./asset/tilemap.js";

export { globFrames } from "./sprite/frames.js";

export {
  cleanChroma,
  despillChroma,
  HIGH_FRINGE_REMOVAL_RATIO,
  keyMatte,
  removeChromaFringe,
} from "./sprite/chroma.js";

export { normalizeCanvas } from "./sprite/normalize.js";

export {
  ACTIONS,
  actionFacts,
  canonicalProfiles,
  coerceFrameCount,
  formatPythonValue,
  PROFILES,
  resolveProfile,
} from "./sprite/presets.js";

export { recoverFrames } from "./sprite/recover.js";

export { buildSequenceGif } from "./sprite/sequence-gif.js";

export { runQc } from "./sprite/qc.js";

export { DEFAULT_SNAP_CONFIG, snapImage, snapSheet, snapWarning } from "./sprite/pixel-snap.js";

export {
  auditSizeContract,
  deriveSizeContract,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  loadSizeContract,
  promptGuidanceForContract,
} from "./sprite/size-contract.js";

export {
  getDirection,
  renderAnchorPrompt,
  renderPoseBoardPrompt,
  resolvePoseBoardPreset,
  totalCells,
  withStyle,
} from "./sprite/prompt.js";

export { packSpritesheet } from "./sprite/pack.js";

export {
  dropUserDataAssignment,
  HEADER,
  MARKER,
  normalizeFactory,
} from "./skill/normalize-factory.js";

export { roundHalfToEven } from "./pymath.js";

export { processSheet } from "./sprite/process-sheet.js";
