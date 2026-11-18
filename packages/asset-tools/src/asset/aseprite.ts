import { constants as zlibConstants, inflateSync } from "node:zlib";
import { AsepriteParseError } from "./aseprite-error";

export { AsepriteParseError } from "./aseprite-error";

class Reader {
  readonly data: Uint8Array;
  private readonly view: DataView;
  off = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  remaining() {
    return this.data.length - this.off;
  }

  private need(size: number) {
    if (this.off + size > this.data.length) {
      throw new AsepriteParseError("Buffer underrun while unpacking.");
    }

    const at = this.off;
    this.off += size;

    return at;
  }

  take(n: number) {
    if (this.off + n > this.data.length) {
      throw new AsepriteParseError("Chunk underrun while reading.");
    }

    const out = this.data.subarray(this.off, this.off + n);
    this.off += n;

    return out;
  }

  u8() {
    return this.view.getUint8(this.need(1));
  }

  s8() {
    return this.view.getInt8(this.need(1));
  }

  u16() {
    return this.view.getUint16(this.need(2), true);
  }

  s16() {
    return this.view.getInt16(this.need(2), true);
  }

  u32() {
    return this.view.getUint32(this.need(4), true);
  }

  s32() {
    return this.view.getInt32(this.need(4), true);
  }

  u64() {
    return Number(this.view.getBigUint64(this.need(8), true));
  }

  s64() {
    return Number(this.view.getBigInt64(this.need(8), true));
  }

  f32() {
    return this.view.getFloat32(this.need(4), true);
  }

  f64() {
    return this.view.getFloat64(this.need(8), true);
  }

  fixed16_16() {
    return this.s32() / 65_536;
  }

  string() {
    const n = this.u16();

    return new TextDecoder().decode(this.take(n));
  }

  uuid() {
    const hex = [...this.take(16)].map((b) => b.toString(16).padStart(2, "0")).join("");

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }
}

const decompressLimited = (data: Uint8Array, limitBytes: number) => {
  const tooLarge = () =>
    new AsepriteParseError(`Decompressed data exceeds limit (${limitBytes} bytes).`);

  let out: Uint8Array;

  try {
    out = new Uint8Array(
      inflateSync(data, {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: Math.max(limitBytes, 1),
      }),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
      throw tooLarge();
    }

    throw error;
  }

  if (out.length > limitBytes) {
    throw tooLarge();
  }

  return out;
};

const bytesPerPixel = (colorDepthBpp: number) => {
  if (colorDepthBpp === 32) {
    return 4;
  }

  if (colorDepthBpp === 16) {
    return 2;
  }

  if (colorDepthBpp === 8) {
    return 1;
  }

  throw new AsepriteParseError(`Unsupported color depth: ${colorDepthBpp} bpp`);
};

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tightest rectangle covering the non-transparent pixels of a decoded cel.
 *
 * Transparency depends on the colour depth: alpha for RGBA and grayscale,
 * the file's transparent palette index for indexed. `treatIndex0Transparent`
 * covers sprites that use index 0 as the blank slot without declaring it —
 * a guess, so it is opt-in.
 */
export const inferBoundsFromPixels = (
  raw: Uint8Array,
  width: number,
  height: number,
  colorDepthBpp: number,
  indexedTransparentIndex: number,
  treatIndex0Transparent: boolean,
) => {
  const bpp = bytesPerPixel(colorDepthBpp);
  const expected = width * height * bpp;

  if (raw.length !== expected) {
    throw new AsepriteParseError(
      `Unexpected decoded pixel length (got ${raw.length}, expected ${expected}).`,
    );
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  const mark = (x: number, y: number) => {
    if (x < minX) {
      minX = x;
    }

    if (y < minY) {
      minY = y;
    }

    if (x > maxX) {
      maxX = x;
    }

    if (y > maxY) {
      maxY = y;
    }
  };

  if (colorDepthBpp === 32) {
    for (let y = 0; y < height; y += 1) {
      const rowOff = y * width * 4;

      for (let x = 0; x < width; x += 1) {
        if (raw[rowOff + x * 4 + 3]) {
          mark(x, y);
        }
      }
    }
  } else if (colorDepthBpp === 16) {
    for (let y = 0; y < height; y += 1) {
      const rowOff = y * width * 2;

      for (let x = 0; x < width; x += 1) {
        if (raw[rowOff + x * 2 + 1]) {
          mark(x, y);
        }
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      const rowOff = y * width;

      for (let x = 0; x < width; x += 1) {
        const idx = raw[rowOff + x];

        if (idx === undefined || idx === indexedTransparentIndex) {
          continue;
        }

        if (treatIndex0Transparent && idx === 0) {
          continue;
        }

        mark(x, y);
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return null;
  }

  return { h: maxY - minY + 1, w: maxX - minX + 1, x: minX, y: minY };
};

export type PropertyValue =
  | boolean
  | number
  | string
  | Bounds
  | { x: number; y: number }
  | { w: number; h: number }
  | PropertyValue[]
  | { [key: string]: PropertyValue };

const parseTypedValue = (r: Reader, typeId: number) => {
  switch (typeId) {
    case 0x00_01: {
      return Boolean(r.u8());
    }

    case 0x00_02: {
      return r.s8();
    }

    case 0x00_03: {
      return r.u8();
    }

    case 0x00_04: {
      return r.s16();
    }

    case 0x00_05: {
      return r.u16();
    }

    case 0x00_06: {
      return r.s32();
    }

    case 0x00_07: {
      return r.u32();
    }

    case 0x00_08: {
      return r.s64();
    }

    case 0x00_09: {
      return r.u64();
    }

    case 0x00_0a: {
      return r.fixed16_16();
    }

    case 0x00_0b: {
      return r.f32();
    }

    case 0x00_0c: {
      return r.f64();
    }

    case 0x00_0d: {
      return r.string();
    }

    case 0x00_0e: {
      return { x: r.s32(), y: r.s32() };
    }

    case 0x00_0f: {
      return { h: r.s32(), w: r.s32() };
    }

    case 0x00_10: {
      const x = r.s32();
      const y = r.s32();
      const w = r.s32();
      const h = r.s32();

      return { h, w, x, y };
    }

    case 0x00_11: {
      return parseVector(r);
    }

    case 0x00_12: {
      return parsePropertiesMap(r);
    }

    case 0x00_13: {
      return r.uuid();
    }

    default: {
      throw new AsepriteParseError(
        `Unsupported property type: 0x${typeId.toString(16).padStart(4, "0")}`,
      );
    }
  }
};

const parsePropertiesMap = (r: Reader) => {
  const count = r.u32();
  const props: Record<string, PropertyValue> = {};

  for (let i = 0; i < count; i += 1) {
    const name = r.string();
    const typeId = r.u16();
    props[name] = parseTypedValue(r, typeId);
  }

  return props;
};

const parseVector = (r: Reader) => {
  const n = r.u32();
  const elemType = r.u16();
  const out: PropertyValue[] = [];

  if (elemType === 0) {
    for (let i = 0; i < n; i += 1) {
      out.push(parseTypedValue(r, r.u16()));
    }

    return out;
  }

  for (let i = 0; i < n; i += 1) {
    out.push(parseTypedValue(r, elemType));
  }

  return out;
};

export interface UserData {
  flags: number;
  text?: string;
  color?: number[];
  properties?: {
    declaredBytes: number;
    maps: { key: number; properties: Record<string, PropertyValue> }[];
  };
}

export interface AsepriteLayer {
  flags: number;
  type: number;
  childLevel: number;
  blendMode: number;
  opacity: number;
  name: string;
  tilesetIndex?: number;
  uuid?: string;
  userData?: UserData;
}

export interface AsepriteTag {
  from: number;
  to: number;
  direction: number;
  repeat: number;
  name: string;
  userData?: UserData;
}

export interface AsepriteCel {
  layerIndex: number;
  x: number;
  y: number;
  opacity: number;
  celType: number;
  zIndex: number;
  w?: number;
  h?: number;
  rawBytes?: number;
  linkFrame?: number;
  compressedBytes?: number;
  decodedBounds?: Bounds | null;
  wTiles?: number;
  hTiles?: number;
  bitsPerTile?: number;
  idMask?: number;
  xFlipMask?: number;
  yFlipMask?: number;
  dFlipMask?: number;
  decodedTilemapSummary?: { nonZeroUniqueTileIds: number; flippedTiles: number };
  unparsedBytes?: number;
}

export interface CelExtra {
  flags: number;
  precise: { x: number; y: number; w: number; h: number };
}

export type FrameChunk =
  | { type: "cel"; data: AsepriteCel; userData?: UserData }
  | { type: "celExtra"; data: CelExtra; userData?: UserData };

export interface UserDataAttachment {
  kind: string | null;
  index: number | null;
}

export type ChunkParsedSummary =
  | { layerIndex: number; name: string }
  | { layerIndex: number; celType: number }
  | { flags: number }
  | { type: number }
  | { entries: number }
  | { tags: number }
  | { changedCount: number }
  | { attachedTo: UserDataAttachment }
  | { id: number; name: string }
  | { name: string; keys: number };

export interface ChunkSummary {
  type: number;
  size: number;
  parsed?: ChunkParsedSummary;
}

export interface AsepriteFrame {
  bytesInFrame: number;
  durationMs: number;
  chunks: FrameChunk[];
  chunkSummaries?: ChunkSummary[];
}

export interface AsepriteHeader {
  fileSize: number;
  frames: number;
  width: number;
  height: number;
  colorDepthBpp: number;
  flags: number;
  speedDeprecatedMs: number;
  transparentIndex: number;
  numColors: number;
  pixelRatio: { w: number; h: number };
  grid: { x: number; y: number; w: number; h: number };
}

export interface AsepriteSliceKey {
  frame: number;
  bounds: Bounds;
  center?: Bounds;
  pivot?: { x: number; y: number };
}

export interface AsepriteSlice {
  name: string;
  flags: number;
  keys: AsepriteSliceKey[];
}

export interface AsepriteTileset {
  id: number;
  flags: number;
  numTiles: number;
  tileW: number;
  tileH: number;
  baseIndex: number;
  name: string;
  external?: { fileId: number; tilesetId: number };
  embeddedImageCompressedBytes?: number;
}

export interface AsepriteExternalFile {
  id: number;
  type: number;
  name: string;
}

export interface PaletteEntryPreview {
  rgba: number[];
  name?: string;
}

export interface AsepritePalette {
  paletteSize: number;
  first: number;
  last: number;
  entriesPreview: PaletteEntryPreview[];
  entriesPreviewCount: number;
  changedCount: number;
}

export interface AsepriteColorProfile {
  type: number;
  flags: number;
  gamma: number;
  iccBytes: number;
}

export interface AsepriteInspection {
  path: string;
  header: AsepriteHeader;
  timeline: { frameMs: number[]; totalMs: number };
  layers: AsepriteLayer[];
  tags: AsepriteTag[];
  slices: AsepriteSlice[];
  tilesets: AsepriteTileset[];
  externalFiles: AsepriteExternalFile[];
  palettes: AsepritePalette[];
  colorProfile: AsepriteColorProfile | null;
  frames: AsepriteFrame[];
  unknownChunks: { type: number; size: number }[];
  notes: {
    specExtensions: string[];
    commonTypos: string[];
    decodeCels: boolean;
    indexedTransparency: { transparentIndex: number; treatIndex0Transparent: boolean };
  };
}

export interface InspectOptions {
  decodeCels?: boolean;
  maxDecompressMib?: number;
  paletteEntries?: number;
  treatIndex0Transparent?: boolean;
}

/** The spec's file extensions, plus the two typos that show up in practice. */
export const ASEPRITE_EXTENSIONS = [".ase", ".aseprite"];
export const ASEPRITE_COMMON_TYPOS = [".aes", ".aesprite"];

interface ParseState {
  readonly colorDepth: number;
  readonly decodeCels: boolean;
  readonly hasLayerUuids: boolean;
  readonly maxDecompressMib: number;
  readonly paletteEntries: number;
  readonly transparentIndex: number;
  readonly treatIndex0Transparent: boolean;
  readonly layers: AsepriteLayer[];
  readonly tags: AsepriteTag[];
  readonly slices: AsepriteSlice[];
  readonly tilesets: AsepriteTileset[];
  readonly palettes: AsepritePalette[];
  readonly externalFiles: AsepriteExternalFile[];
  readonly unknownChunks: { type: number; size: number }[];
  readonly decodedCelBounds: Map<string, Bounds | null>;
  readonly decodedCelDims: Map<string, [number, number]>;
  colorProfile: AsepriteColorProfile | null;
  lastObjectRef: { kind: string; index: number } | null;
  pendingTagUserData: number[];
}

// oxlint-disable-next-line no-bitwise -- the format stores booleans as flag bits
const hasFlag = (flags: number, bit: number) => (flags & bit) !== 0;

const celKey = (frameIndex: number, layerIndex: number) => `${frameIndex}:${layerIndex}`;

const decompressLimit = (state: ParseState, expected: number) =>
  Math.min(state.maxDecompressMib * 1024 * 1024, Math.max(expected, 1));

const parseLayerChunk = (state: ParseState, r: Reader) => {
  const layerFlags = r.u16();
  const layerType = r.u16();
  const childLevel = r.u16();
  r.u16();
  r.u16();
  const blendMode = r.u16();
  const opacity = r.u8();
  r.take(3);
  const name = r.string();

  const layer: AsepriteLayer = {
    blendMode,
    childLevel,
    flags: layerFlags,
    name,
    opacity,
    type: layerType,
  };

  if (layerType === 2) {
    layer.tilesetIndex = r.u32();
  }

  if (state.hasLayerUuids) {
    layer.uuid = r.uuid();
  }

  state.layers.push(layer);
  state.lastObjectRef = { index: state.layers.length - 1, kind: "layer" };

  return { layerIndex: state.layers.length - 1, name };
};

const decodeCompressedCel = (
  state: ParseState,
  cel: AsepriteCel,
  frameIndex: number,
  w: number,
  h: number,
  compressed: Uint8Array,
) => {
  const bpp = bytesPerPixel(state.colorDepth);
  const expected = w * h * bpp;
  const raw = decompressLimited(compressed, decompressLimit(state, expected));

  if (raw.length !== expected) {
    throw new AsepriteParseError(
      `Decoded cel size mismatch at frame ${frameIndex} layer ${cel.layerIndex} (got ${raw.length}, expected ${expected}).`,
    );
  }

  const bounds = inferBoundsFromPixels(
    raw,
    w,
    h,
    state.colorDepth,
    state.transparentIndex,
    state.treatIndex0Transparent,
  );

  cel.decodedBounds = bounds;
  state.decodedCelBounds.set(celKey(frameIndex, cel.layerIndex), bounds);
  state.decodedCelDims.set(celKey(frameIndex, cel.layerIndex), [w, h]);
};

interface TilemapCelHeader {
  wTiles: number;
  hTiles: number;
  bitsPerTile: number;
  idMask: number;
  xFlipMask: number;
  yFlipMask: number;
  dFlipMask: number;
}

const decodeTilemapCel = (
  state: ParseState,
  cel: AsepriteCel,
  frameIndex: number,
  tilemap: TilemapCelHeader,
  compressed: Uint8Array,
) => {
  const tileBytes = Math.floor(tilemap.bitsPerTile / 8);
  const expected = tilemap.wTiles * tilemap.hTiles * tileBytes;
  const raw = decompressLimited(compressed, decompressLimit(state, expected));

  if (raw.length !== expected) {
    throw new AsepriteParseError(
      `Decoded tilemap size mismatch at frame ${frameIndex} layer ${cel.layerIndex} (got ${raw.length}, expected ${expected}).`,
    );
  }

  const uniqueIds = new Set<number>();
  let flipped = 0;
  // oxlint-disable-next-line no-bitwise -- the file declares tile id and flip bits as masks
  const flipMask = (tilemap.xFlipMask | tilemap.yFlipMask | tilemap.dFlipMask) >>> 0;

  for (let t = 0; t < raw.length; t += tileBytes) {
    let tileVal = 0;

    for (let b = tileBytes - 1; b >= 0; b -= 1) {
      tileVal = tileVal * 256 + (raw[t + b] ?? 0);
    }

    // oxlint-disable-next-line no-bitwise -- the file declares tile id and flip bits as masks
    const tileId = (tileVal & tilemap.idMask) >>> 0;

    if (tileId !== 0) {
      uniqueIds.add(tileId);
    }

    // oxlint-disable-next-line no-bitwise -- the file declares tile id and flip bits as masks
    if ((tileVal & flipMask) >>> 0) {
      flipped += 1;
    }
  }

  cel.decodedTilemapSummary = {
    flippedTiles: flipped,
    nonZeroUniqueTileIds: uniqueIds.size,
  };
};

const parseCelChunk = (
  state: ParseState,
  frameOut: AsepriteFrame,
  frameIndex: number,
  r: Reader,
) => {
  const layerIndex = r.u16();
  const x = r.s16();
  const y = r.s16();
  const celOpacity = r.u8();
  const celType = r.u16();
  const zIndex = r.s16();
  r.take(5);

  const cel: AsepriteCel = {
    celType,
    layerIndex,
    opacity: celOpacity,
    x,
    y,
    zIndex,
  };

  if (celType === 0) {
    cel.w = r.u16();
    cel.h = r.u16();
    cel.rawBytes = r.remaining();
    r.take(r.remaining());
  } else if (celType === 1) {
    cel.linkFrame = r.u16();
  } else if (celType === 2) {
    const w = r.u16();
    const h = r.u16();
    cel.w = w;
    cel.h = h;
    const compressed = r.take(r.remaining());
    cel.compressedBytes = compressed.length;

    if (state.decodeCels) {
      decodeCompressedCel(state, cel, frameIndex, w, h, compressed);
    }
  } else if (celType === 3) {
    const wTiles = r.u16();
    const hTiles = r.u16();
    const bitsPerTile = r.u16();
    const idMask = r.u32();
    const xFlipMask = r.u32();
    const yFlipMask = r.u32();
    const dFlipMask = r.u32();
    r.take(10);
    const compressed = r.take(r.remaining());

    const tilemap: TilemapCelHeader = {
      bitsPerTile,
      dFlipMask,
      hTiles,
      idMask,
      wTiles,
      xFlipMask,
      yFlipMask,
    };

    Object.assign(cel, { ...tilemap, compressedBytes: compressed.length });

    if (state.decodeCels) {
      decodeTilemapCel(state, cel, frameIndex, tilemap, compressed);
    }
  } else {
    cel.unparsedBytes = r.remaining();
  }

  frameOut.chunks.push({ data: cel, type: "cel" });
  state.lastObjectRef = { index: frameOut.chunks.length - 1, kind: "cel" };

  return { celType, layerIndex };
};

const parseCelExtraChunk = (state: ParseState, frameOut: AsepriteFrame, r: Reader) => {
  const flagsEx = r.u32();
  const px = r.fixed16_16();
  const py = r.fixed16_16();
  const pw = r.fixed16_16();
  const ph = r.fixed16_16();
  r.take(Math.min(16, r.remaining()));
  frameOut.chunks.push({
    data: { flags: flagsEx, precise: { h: ph, w: pw, x: px, y: py } },
    type: "celExtra",
  });
  state.lastObjectRef = { index: frameOut.chunks.length - 1, kind: "celExtra" };

  return { flags: flagsEx };
};

const parseColorProfileChunk = (state: ParseState, r: Reader) => {
  const profileType = r.u16();
  const profileFlags = r.u16();
  const gamma = r.fixed16_16();
  r.take(8);
  let iccLen = 0;

  if (profileType === 2) {
    iccLen = r.u32();
    r.take(Math.min(iccLen, r.remaining()));
  }

  state.colorProfile = { flags: profileFlags, gamma, iccBytes: iccLen, type: profileType };

  return { type: profileType };
};

const parseExternalFilesChunk = (state: ParseState, r: Reader) => {
  const n = r.u32();
  r.take(8);

  for (let i = 0; i < n; i += 1) {
    const entryId = r.u32();
    const t = r.u8();
    r.take(7);
    state.externalFiles.push({ id: entryId, name: r.string(), type: t });
  }

  return { entries: n };
};

const parseTagsChunk = (state: ParseState, r: Reader) => {
  const n = r.u16();
  r.take(8);
  const baseIndex = state.tags.length;

  for (let i = 0; i < n; i += 1) {
    const from = r.u16();
    const to = r.u16();
    const direction = r.u8();
    const repeat = r.u16();
    r.take(6);
    r.take(3);
    r.take(1);
    state.tags.push({ direction, from, name: r.string(), repeat, to });
  }

  state.pendingTagUserData = Array.from({ length: n }, (_, i) => baseIndex + i);

  return { tags: n };
};

const parsePaletteChunk = (state: ParseState, r: Reader) => {
  const newSize = r.u32();
  const first = r.u32();
  const last = r.u32();
  r.take(8);
  const count = last >= first ? last - first + 1 : 0;
  const entriesPreview: PaletteEntryPreview[] = [];

  for (let i = 0; i < count; i += 1) {
    const entryFlags = r.u16();
    const rgba = [...r.take(4)];
    const name = hasFlag(entryFlags, 1) ? r.string() : null;

    if (i < state.paletteEntries) {
      const entry: PaletteEntryPreview = { rgba };

      if (name !== null) {
        entry.name = name;
      }

      entriesPreview.push(entry);
    }
  }

  state.palettes.push({
    changedCount: count,
    entriesPreview,
    entriesPreviewCount: entriesPreview.length,
    first,
    last,
    paletteSize: newSize,
  });

  return { changedCount: count };
};

const parseUserDataChunk = (state: ParseState, frameOut: AsepriteFrame, r: Reader) => {
  const uflags = r.u32();
  const ud: UserData = { flags: uflags };

  if (hasFlag(uflags, 1)) {
    ud.text = r.string();
  }

  if (hasFlag(uflags, 2)) {
    ud.color = [...r.take(4)];
  }

  if (hasFlag(uflags, 4)) {
    const totalSize = r.u32();
    const maps = r.u32();
    const propsMaps: { key: number; properties: Record<string, PropertyValue> }[] = [];

    for (let i = 0; i < maps; i += 1) {
      const mapKey = r.u32();
      propsMaps.push({ key: mapKey, properties: parsePropertiesMap(r) });
    }

    ud.properties = { declaredBytes: totalSize, maps: propsMaps };
  }

  let attached: UserDataAttachment = { index: null, kind: null };
  const tagIndex = state.pendingTagUserData.shift();

  if (tagIndex !== undefined) {
    const tag = state.tags[tagIndex];

    if (tag) {
      tag.userData = ud;
    }

    attached = { index: tagIndex, kind: "tag" };
  } else if (state.lastObjectRef !== null) {
    const { kind, index } = state.lastObjectRef;
    const target = kind === "layer" ? state.layers[index] : frameOut.chunks[index];

    if (target) {
      target.userData = ud;
    }

    attached = { index, kind };
  }

  return { attachedTo: attached };
};

const parseSliceChunk = (state: ParseState, r: Reader) => {
  const n = r.u32();
  const sflags = r.u32();
  r.u32();
  const name = r.string();
  const keys: AsepriteSliceKey[] = [];

  for (let i = 0; i < n; i += 1) {
    const frameNumber = r.u32();
    const sx = r.s32();
    const sy = r.s32();
    const sw = r.u32();
    const sh = r.u32();

    const sliceKey: AsepriteSliceKey = {
      bounds: { h: sh, w: sw, x: sx, y: sy },
      frame: frameNumber,
    };

    if (hasFlag(sflags, 1)) {
      const cx = r.s32();
      const cy = r.s32();
      const cw = r.u32();
      const ch = r.u32();
      sliceKey.center = { h: ch, w: cw, x: cx, y: cy };
    }

    if (hasFlag(sflags, 2)) {
      sliceKey.pivot = { x: r.s32(), y: r.s32() };
    }

    keys.push(sliceKey);
  }

  state.slices.push({ flags: sflags, keys, name });

  return { keys: n, name };
};

const parseTilesetChunk = (state: ParseState, r: Reader) => {
  const tsId = r.u32();
  const tsFlags = r.u32();
  const numTiles = r.u32();
  const tileW = r.u16();
  const tileH = r.u16();
  const baseIndex = r.s16();
  r.take(14);
  const name = r.string();

  const ts: AsepriteTileset = {
    baseIndex,
    flags: tsFlags,
    id: tsId,
    name,
    numTiles,
    tileH,
    tileW,
  };

  if (hasFlag(tsFlags, 1)) {
    ts.external = { fileId: r.u32(), tilesetId: r.u32() };
  }

  if (hasFlag(tsFlags, 2)) {
    const dataLen = r.u32();
    r.take(Math.min(dataLen, r.remaining()));
    ts.embeddedImageCompressedBytes = dataLen;
  }

  state.tilesets.push(ts);
  state.lastObjectRef = { index: state.tilesets.length - 1, kind: "tileset" };

  return { id: tsId, name };
};

const parseChunk = (
  state: ParseState,
  frameOut: AsepriteFrame,
  frameIndex: number,
  chunkType: number,
  chunkSize: number,
  r: Reader,
) => {
  switch (chunkType) {
    case 0x20_04: {
      return parseLayerChunk(state, r);
    }

    case 0x20_05: {
      return parseCelChunk(state, frameOut, frameIndex, r);
    }

    case 0x20_06: {
      return parseCelExtraChunk(state, frameOut, r);
    }

    case 0x20_07: {
      return parseColorProfileChunk(state, r);
    }

    case 0x20_08: {
      return parseExternalFilesChunk(state, r);
    }

    case 0x20_18: {
      return parseTagsChunk(state, r);
    }

    case 0x20_19: {
      return parsePaletteChunk(state, r);
    }

    case 0x20_20: {
      return parseUserDataChunk(state, frameOut, r);
    }

    case 0x20_22: {
      return parseSliceChunk(state, r);
    }

    case 0x20_23: {
      return parseTilesetChunk(state, r);
    }

    default: {
      state.unknownChunks.push({ size: chunkSize, type: chunkType });

      return;
    }
  }
};

const resolveLinkedCels = (state: ParseState, framesOut: AsepriteFrame[]) => {
  for (const fr of framesOut) {
    for (const chunk of fr.chunks) {
      if (chunk.type !== "cel") {
        continue;
      }

      const cel = chunk.data;

      if (cel.celType !== 1) {
        continue;
      }

      const targetFrame = cel.linkFrame ?? -1;
      const k = celKey(targetFrame, cel.layerIndex);

      if (state.decodedCelBounds.has(k)) {
        cel.decodedBounds = state.decodedCelBounds.get(k) ?? null;
        const dims = state.decodedCelDims.get(k);

        if (dims) {
          [cel.w, cel.h] = dims;
        }
      }
    }
  }
};

export const inspectAseprite = (path: string, bytes: Uint8Array, options: InspectOptions = {}) => {
  const decodeCels = options.decodeCels ?? false;
  const maxDecompressMib = options.maxDecompressMib ?? 64;
  const paletteEntries = options.paletteEntries ?? 16;
  const treatIndex0Transparent = options.treatIndex0Transparent ?? false;

  let cursor = 0;

  const readExact = (n: number) => {
    const available = bytes.length - cursor;

    if (available < n) {
      throw new AsepriteParseError(
        `Unexpected EOF (wanted ${n} bytes, got ${Math.max(available, 0)}).`,
      );
    }

    const out = bytes.subarray(cursor, cursor + n);
    cursor += n;

    return out;
  };

  const header = readExact(128);
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);

  const fileSize = headerView.getUint32(0, true);
  const magic = headerView.getUint16(4, true);

  if (magic !== 0xa5_e0) {
    throw new AsepriteParseError(
      `Bad magic 0x${magic.toString(16).padStart(4, "0")} (expected 0xA5E0).`,
    );
  }

  const frames = headerView.getUint16(6, true);
  const width = headerView.getUint16(8, true);
  const height = headerView.getUint16(10, true);
  const colorDepth = headerView.getUint16(12, true);
  const flags = headerView.getUint32(14, true);
  const speedDeprecated = headerView.getUint16(18, true);
  const transparentIndex = headerView.getUint8(28);
  const numColors = headerView.getUint16(32, true);
  const pixelW = headerView.getUint8(34);
  const pixelH = headerView.getUint8(35);
  const gridX = headerView.getInt16(36, true);
  const gridY = headerView.getInt16(38, true);
  const gridW = headerView.getUint16(40, true);
  const gridH = headerView.getUint16(42, true);

  const headerInfo = {
    colorDepthBpp: colorDepth,
    fileSize,
    flags,
    frames,
    grid: { h: gridH, w: gridW, x: gridX, y: gridY },
    height,
    numColors: numColors === 0 ? 256 : numColors,
    pixelRatio: { h: pixelH || 1, w: pixelW || 1 },
    speedDeprecatedMs: speedDeprecated,
    transparentIndex,
    width,
  };

  const state: ParseState = {
    colorDepth,
    colorProfile: null,
    decodeCels,
    decodedCelBounds: new Map(),
    decodedCelDims: new Map(),
    externalFiles: [],
    hasLayerUuids: hasFlag(flags, 4),
    lastObjectRef: null,
    layers: [],
    maxDecompressMib,
    paletteEntries,
    palettes: [],
    pendingTagUserData: [],
    slices: [],
    tags: [],
    tilesets: [],
    transparentIndex,
    treatIndex0Transparent,
    unknownChunks: [],
  };

  const framesOut: AsepriteFrame[] = [];

  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const frameHeader = readExact(16);
    const fv = new DataView(frameHeader.buffer, frameHeader.byteOffset, frameHeader.byteLength);
    const bytesInFrame = fv.getUint32(0, true);
    const frameMagic = fv.getUint16(4, true);
    const oldChunks = fv.getUint16(6, true);
    const frameDuration = fv.getUint16(8, true);
    const newChunks = fv.getUint32(12, true);

    if (frameMagic !== 0xf1_fa) {
      throw new AsepriteParseError(
        `Bad frame magic 0x${frameMagic.toString(16).padStart(4, "0")} at frame ${frameIndex}.`,
      );
    }

    let chunkCount: number;

    if (oldChunks === 0xff_ff) {
      chunkCount = newChunks;
    } else if (newChunks === 0) {
      chunkCount = oldChunks;
    } else {
      chunkCount = newChunks;
    }

    const frameOut: AsepriteFrame = {
      bytesInFrame,
      chunks: [],
      durationMs: frameDuration,
    };

    for (let c = 0; c < chunkCount; c += 1) {
      const chunkHeader = readExact(6);
      const cv = new DataView(chunkHeader.buffer, chunkHeader.byteOffset, chunkHeader.byteLength);
      const chunkSize = cv.getUint32(0, true);
      const chunkType = cv.getUint16(4, true);

      if (chunkSize < 6) {
        throw new AsepriteParseError(`Invalid chunk size ${chunkSize}.`);
      }

      const r = new Reader(readExact(chunkSize - 6));

      const chunkSummary: ChunkSummary = { size: chunkSize, type: chunkType };
      const parsed = parseChunk(state, frameOut, frameIndex, chunkType, chunkSize, r);

      if (parsed !== undefined) {
        chunkSummary.parsed = parsed;
      }

      (frameOut.chunkSummaries ??= []).push(chunkSummary);
    }

    framesOut.push(frameOut);
  }

  const durations = framesOut.map((fr) => (fr.durationMs <= 0 ? speedDeprecated : fr.durationMs));
  const totalMs = durations.reduce((sum, d) => sum + d, 0);

  if (decodeCels) {
    resolveLinkedCels(state, framesOut);
  }

  return {
    colorProfile: state.colorProfile,
    externalFiles: state.externalFiles,
    frames: framesOut,
    header: headerInfo,
    layers: state.layers,
    notes: {
      commonTypos: ASEPRITE_COMMON_TYPOS,
      decodeCels,
      indexedTransparency: { transparentIndex, treatIndex0Transparent },
      specExtensions: ASEPRITE_EXTENSIONS,
    },
    palettes: state.palettes,
    path,
    slices: state.slices,
    tags: state.tags,
    tilesets: state.tilesets,
    timeline: { frameMs: durations, totalMs },
    unknownChunks: state.unknownChunks,
  };
};
