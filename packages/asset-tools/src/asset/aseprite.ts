/**
 * Aseprite `.ase`/`.aseprite` reader.
 *
 * The format is a flat stream of length-prefixed chunks, which is what makes a
 * safe reader possible without a spec-complete implementation: anything this
 * does not recognise is skipped by its declared size rather than guessed at.
 * The output is a description of the file — header, frames, layers, cels, tags,
 * slices, tilesets, palettes, user data — not an image, so nothing here decodes
 * pixels unless asked to.
 *
 * With `decodeCels`, cel and tilemap payloads are inflated so tight bounds and
 * tile summaries can be inferred. Decompression is bounded: the limit is the
 * size the header says the payload should be, so a hostile file cannot make
 * this allocate. `node:zlib` is the only runtime dependency.
 *
 * One representational difference from the Python reader this replaces: JSON
 * numbers have no float/int distinction in JS, so a fixed-point field that was
 * emitted as `1.0` is emitted as `1` here. Parsed values are identical.
 */

import { constants as zlibConstants, inflateSync } from "node:zlib";

export class AsepriteParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsepriteParseError";
  }
}

/** A cursor over a chunk body, mirroring the spec's little-endian scalar types. */
class Reader {
  private readonly view: DataView;
  off = 0;

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  remaining(): number {
    return this.data.length - this.off;
  }

  private need(size: number): number {
    if (this.off + size > this.data.length) {
      throw new AsepriteParseError("Buffer underrun while unpacking.");
    }
    const at = this.off;
    this.off += size;
    return at;
  }

  take(n: number): Uint8Array {
    if (this.off + n > this.data.length) {
      throw new AsepriteParseError("Chunk underrun while reading.");
    }
    const out = this.data.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  u8(): number {
    return this.data[this.need(1)]!;
  }

  s8(): number {
    return this.view.getInt8(this.need(1));
  }

  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }

  s16(): number {
    return this.view.getInt16(this.need(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }

  s32(): number {
    return this.view.getInt32(this.need(4), true);
  }

  u64(): number {
    return Number(this.view.getBigUint64(this.need(8), true));
  }

  s64(): number {
    return Number(this.view.getBigInt64(this.need(8), true));
  }

  f32(): number {
    return this.view.getFloat32(this.need(4), true);
  }

  f64(): number {
    return this.view.getFloat64(this.need(8), true);
  }

  fixed16_16(): number {
    return this.s32() / 65536.0;
  }

  string(): string {
    const n = this.u16();
    return new TextDecoder().decode(this.take(n));
  }

  uuid(): string {
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

/**
 * Inflate with a hard ceiling on the output.
 *
 * `Z_SYNC_FLUSH` makes a truncated stream return what it has rather than
 * throwing, so a short payload is caught by the size check downstream — where
 * the message can name the frame and layer — instead of here.
 */
function decompressLimited(data: Uint8Array, limitBytes: number): Uint8Array {
  const tooLarge = () =>
    new AsepriteParseError(`Decompressed data exceeds limit (${limitBytes} bytes).`);
  let out: Uint8Array;
  try {
    out = new Uint8Array(
      inflateSync(data, {
        // A limit of zero is legal here but not in zlib, so ask for one byte
        // and reject it below; an empty payload still passes, as it should.
        maxOutputLength: Math.max(limitBytes, 1),
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
    throw error;
  }
  if (out.length > limitBytes) throw tooLarge();
  return out;
}

function bytesPerPixel(colorDepthBpp: number): number {
  if (colorDepthBpp === 32) return 4;
  if (colorDepthBpp === 16) return 2;
  if (colorDepthBpp === 8) return 1;
  throw new AsepriteParseError(`Unsupported color depth: ${colorDepthBpp} bpp`);
}

export type Bounds = { x: number; y: number; w: number; h: number };

/**
 * Tightest rectangle covering the non-transparent pixels of a decoded cel.
 *
 * Transparency depends on the colour depth: alpha for RGBA and grayscale,
 * the file's transparent palette index for indexed. `treatIndex0Transparent`
 * covers sprites that use index 0 as the blank slot without declaring it —
 * a guess, so it is opt-in.
 */
export function inferBoundsFromPixels(
  raw: Uint8Array,
  width: number,
  height: number,
  colorDepthBpp: number,
  indexedTransparentIndex: number,
  treatIndex0Transparent: boolean,
): Bounds | null {
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
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  if (colorDepthBpp === 32) {
    for (let y = 0; y < height; y += 1) {
      const rowOff = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        if (raw[rowOff + x * 4 + 3]) mark(x, y);
      }
    }
  } else if (colorDepthBpp === 16) {
    for (let y = 0; y < height; y += 1) {
      const rowOff = y * width * 2;
      for (let x = 0; x < width; x += 1) {
        if (raw[rowOff + x * 2 + 1]) mark(x, y);
      }
    }
  } else {
    for (let y = 0; y < height; y += 1) {
      const rowOff = y * width;
      for (let x = 0; x < width; x += 1) {
        const idx = raw[rowOff + x]!;
        if (idx === indexedTransparentIndex) continue;
        if (treatIndex0Transparent && idx === 0) continue;
        mark(x, y);
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export type PropertyValue =
  | boolean
  | number
  | string
  | Bounds
  | { x: number; y: number }
  | { w: number; h: number }
  | PropertyValue[]
  | { [key: string]: PropertyValue };

function parsePropertiesMap(r: Reader): Record<string, PropertyValue> {
  const count = r.u32();
  const props: Record<string, PropertyValue> = {};
  for (let i = 0; i < count; i += 1) {
    const name = r.string();
    const typeId = r.u16();
    props[name] = parseTypedValue(r, typeId);
  }
  return props;
}

function parseVector(r: Reader): PropertyValue[] {
  const n = r.u32();
  const elemType = r.u16();
  const out: PropertyValue[] = [];
  // Element type 0 means the vector is heterogeneous and each element carries
  // its own type tag.
  if (elemType === 0) {
    for (let i = 0; i < n; i += 1) out.push(parseTypedValue(r, r.u16()));
    return out;
  }
  for (let i = 0; i < n; i += 1) out.push(parseTypedValue(r, elemType));
  return out;
}

function parseTypedValue(r: Reader, typeId: number): PropertyValue {
  switch (typeId) {
    case 0x0001:
      return Boolean(r.u8());
    case 0x0002:
      return r.s8();
    case 0x0003:
      return r.u8();
    case 0x0004:
      return r.s16();
    case 0x0005:
      return r.u16();
    case 0x0006:
      return r.s32();
    case 0x0007:
      return r.u32();
    case 0x0008:
      return r.s64();
    case 0x0009:
      return r.u64();
    case 0x000a:
      return r.fixed16_16();
    case 0x000b:
      return r.f32();
    case 0x000c:
      return r.f64();
    case 0x000d:
      return r.string();
    case 0x000e:
      return { x: r.s32(), y: r.s32() };
    case 0x000f:
      return { w: r.s32(), h: r.s32() };
    case 0x0010: {
      const x = r.s32();
      const y = r.s32();
      const w = r.s32();
      const h = r.s32();
      return { x, y, w, h };
    }
    case 0x0011:
      return parseVector(r);
    case 0x0012:
      return parsePropertiesMap(r);
    case 0x0013:
      return r.uuid();
    default:
      // Unknown types carry no length, so there is no safe way to skip one.
      throw new AsepriteParseError(
        `Unsupported property type: 0x${typeId.toString(16).padStart(4, "0")}`,
      );
  }
}

export type UserData = {
  flags: number;
  text?: string;
  color?: number[];
  properties?: {
    declaredBytes: number;
    maps: { key: number; properties: Record<string, PropertyValue> }[];
  };
};

export type AsepriteLayer = {
  flags: number;
  type: number;
  childLevel: number;
  blendMode: number;
  opacity: number;
  name: string;
  tilesetIndex?: number;
  uuid?: string;
  userData?: UserData;
};

export type AsepriteTag = {
  from: number;
  to: number;
  direction: number;
  repeat: number;
  name: string;
  userData?: UserData;
};

export type AsepriteCel = {
  layerIndex: number;
  x: number;
  y: number;
  opacity: number;
  celType: number;
  zIndex: number;
  [key: string]: unknown;
};

export type FrameChunk = {
  type: "cel" | "celExtra";
  data: Record<string, unknown>;
  userData?: UserData;
};

export type ChunkSummary = { type: number; size: number; parsed?: Record<string, unknown> };

export type AsepriteFrame = {
  bytesInFrame: number;
  durationMs: number;
  chunks: FrameChunk[];
  chunkSummaries?: ChunkSummary[];
};

export type AsepriteInspection = {
  path: string;
  header: Record<string, unknown>;
  timeline: { frameMs: number[]; totalMs: number };
  layers: AsepriteLayer[];
  tags: AsepriteTag[];
  slices: Record<string, unknown>[];
  tilesets: Record<string, unknown>[];
  externalFiles: Record<string, unknown>[];
  palettes: Record<string, unknown>[];
  colorProfile: Record<string, unknown> | null;
  frames: AsepriteFrame[];
  unknownChunks: { type: number; size: number }[];
  notes: Record<string, unknown>;
};

export type InspectOptions = {
  decodeCels?: boolean;
  maxDecompressMib?: number;
  paletteEntries?: number;
  treatIndex0Transparent?: boolean;
};

/** The spec's file extensions, plus the two typos that show up in practice. */
export const ASEPRITE_EXTENSIONS = [".ase", ".aseprite"];
export const ASEPRITE_COMMON_TYPOS = [".aes", ".aesprite"];

export function inspectAseprite(
  path: string,
  bytes: Uint8Array,
  options: InspectOptions = {},
): AsepriteInspection {
  const decodeCels = options.decodeCels ?? false;
  const maxDecompressMib = options.maxDecompressMib ?? 64;
  const paletteEntries = options.paletteEntries ?? 16;
  const treatIndex0Transparent = options.treatIndex0Transparent ?? false;

  let cursor = 0;
  const readExact = (n: number): Uint8Array => {
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
  if (magic !== 0xa5e0) {
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
  // 20 and 24 are reserved DWORDs.
  const transparentIndex = header[28]!;
  const numColors = headerView.getUint16(32, true);
  const pixelW = header[34]!;
  const pixelH = header[35]!;
  const gridX = headerView.getInt16(36, true);
  const gridY = headerView.getInt16(38, true);
  const gridW = headerView.getUint16(40, true);
  const gridH = headerView.getUint16(42, true);

  const headerInfo = {
    fileSize,
    frames,
    width,
    height,
    colorDepthBpp: colorDepth,
    flags,
    speedDeprecatedMs: speedDeprecated,
    transparentIndex,
    numColors: numColors !== 0 ? numColors : 256,
    pixelRatio: { w: pixelW || 1, h: pixelH || 1 },
    grid: { x: gridX, y: gridY, w: gridW, h: gridH },
  };

  const hasLayerUuids = Boolean(flags & 4);

  const layers: AsepriteLayer[] = [];
  const tags: AsepriteTag[] = [];
  const slices: Record<string, unknown>[] = [];
  const tilesets: Record<string, unknown>[] = [];
  const palettes: Record<string, unknown>[] = [];
  const externalFiles: Record<string, unknown>[] = [];
  let colorProfile: Record<string, unknown> | null = null;
  const unknownChunks: { type: number; size: number }[] = [];
  const framesOut: AsepriteFrame[] = [];

  // A user-data chunk describes whatever object preceded it, except after a
  // tags chunk, where one arrives per tag in order.
  let lastObjectRef: { kind: string; index: number } | null = null;
  let pendingTagUserData: number[] = [];

  const decodedCelBounds = new Map<string, Bounds | null>();
  const decodedCelDims = new Map<string, [number, number]>();
  const key = (frameIndex: number, layerIndex: number) => `${frameIndex}:${layerIndex}`;

  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const frameHeader = readExact(16);
    const fv = new DataView(frameHeader.buffer, frameHeader.byteOffset, frameHeader.byteLength);
    const bytesInFrame = fv.getUint32(0, true);
    const frameMagic = fv.getUint16(4, true);
    const oldChunks = fv.getUint16(6, true);
    const frameDuration = fv.getUint16(8, true);
    const newChunks = fv.getUint32(12, true);
    if (frameMagic !== 0xf1fa) {
      throw new AsepriteParseError(
        `Bad frame magic 0x${frameMagic.toString(16).padStart(4, "0")} at frame ${frameIndex}.`,
      );
    }

    // The 16-bit count was superseded by a 32-bit one; either sentinel means
    // the new field is authoritative.
    let chunkCount: number;
    if (oldChunks === 0xffff) chunkCount = newChunks;
    else if (newChunks !== 0) chunkCount = newChunks;
    else chunkCount = oldChunks;

    const frameOut: AsepriteFrame = {
      bytesInFrame,
      durationMs: frameDuration,
      chunks: [],
    };

    for (let c = 0; c < chunkCount; c += 1) {
      const chunkHeader = readExact(6);
      const cv = new DataView(chunkHeader.buffer, chunkHeader.byteOffset, chunkHeader.byteLength);
      const chunkSize = cv.getUint32(0, true);
      const chunkType = cv.getUint16(4, true);
      if (chunkSize < 6) throw new AsepriteParseError(`Invalid chunk size ${chunkSize}.`);
      const r = new Reader(readExact(chunkSize - 6));

      const chunkSummary: ChunkSummary = { type: chunkType, size: chunkSize };

      if (chunkType === 0x2004) {
        // Layer
        const layerFlags = r.u16();
        const layerType = r.u16();
        const childLevel = r.u16();
        r.u16(); // default width, ignored
        r.u16(); // default height, ignored
        const blendMode = r.u16();
        const opacity = r.u8();
        r.take(3);
        const name = r.string();
        const layer: AsepriteLayer = {
          flags: layerFlags,
          type: layerType,
          childLevel,
          blendMode,
          opacity,
          name,
        };
        if (layerType === 2) layer.tilesetIndex = r.u32();
        if (hasLayerUuids) layer.uuid = r.uuid();
        layers.push(layer);
        lastObjectRef = { kind: "layer", index: layers.length - 1 };
        chunkSummary.parsed = { layerIndex: layers.length - 1, name };
      } else if (chunkType === 0x2005) {
        // Cel
        const layerIndex = r.u16();
        const x = r.s16();
        const y = r.s16();
        const celOpacity = r.u8();
        const celType = r.u16();
        const zIndex = r.s16();
        r.take(5);

        const cel: Record<string, unknown> = {
          layerIndex,
          x,
          y,
          opacity: celOpacity,
          celType,
          zIndex,
        };

        if (celType === 0) {
          // Raw pixels — recorded by size, never copied into the output.
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

          if (decodeCels) {
            const bpp = bytesPerPixel(colorDepth);
            const expected = w * h * bpp;
            const limit = Math.min(maxDecompressMib * 1024 * 1024, Math.max(expected, 1));
            const raw = decompressLimited(compressed, limit);
            if (raw.length !== expected) {
              throw new AsepriteParseError(
                `Decoded cel size mismatch at frame ${frameIndex} layer ${layerIndex} (got ${raw.length}, expected ${expected}).`,
              );
            }
            const bounds = inferBoundsFromPixels(
              raw,
              w,
              h,
              colorDepth,
              transparentIndex,
              treatIndex0Transparent,
            );
            cel.decodedBounds = bounds;
            decodedCelBounds.set(key(frameIndex, layerIndex), bounds);
            decodedCelDims.set(key(frameIndex, layerIndex), [w, h]);
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
          Object.assign(cel, {
            wTiles,
            hTiles,
            bitsPerTile,
            idMask,
            xFlipMask,
            yFlipMask,
            dFlipMask,
            compressedBytes: compressed.length,
          });

          if (decodeCels) {
            const tileBytes = Math.floor(bitsPerTile / 8);
            const expected = wTiles * hTiles * tileBytes;
            const limit = Math.min(maxDecompressMib * 1024 * 1024, Math.max(expected, 1));
            const raw = decompressLimited(compressed, limit);
            if (raw.length !== expected) {
              throw new AsepriteParseError(
                `Decoded tilemap size mismatch at frame ${frameIndex} layer ${layerIndex} (got ${raw.length}, expected ${expected}).`,
              );
            }
            // A summary, not the stream: which tiles are used and how many are
            // flipped is what a caller can act on.
            const uniqueIds = new Set<number>();
            let flipped = 0;
            const flipMask = (xFlipMask | yFlipMask | dFlipMask) >>> 0;
            for (let t = 0; t < raw.length; t += tileBytes) {
              let tileVal = 0;
              for (let b = tileBytes - 1; b >= 0; b -= 1) tileVal = tileVal * 256 + raw[t + b]!;
              const tileId = (tileVal & idMask) >>> 0;
              if (tileId !== 0) uniqueIds.add(tileId);
              if ((tileVal & flipMask) >>> 0) flipped += 1;
            }
            cel.decodedTilemapSummary = {
              nonZeroUniqueTileIds: uniqueIds.size,
              flippedTiles: flipped,
            };
          }
        } else {
          cel.unparsedBytes = r.remaining();
        }

        frameOut.chunks.push({ type: "cel", data: cel });
        lastObjectRef = { kind: "cel", index: frameOut.chunks.length - 1 };
        chunkSummary.parsed = { layerIndex, celType };
      } else if (chunkType === 0x2006) {
        // Cel extra — sub-pixel precise bounds for the preceding cel.
        const flagsEx = r.u32();
        const px = r.fixed16_16();
        const py = r.fixed16_16();
        const pw = r.fixed16_16();
        const ph = r.fixed16_16();
        r.take(Math.min(16, r.remaining()));
        frameOut.chunks.push({
          type: "celExtra",
          data: { flags: flagsEx, precise: { x: px, y: py, w: pw, h: ph } },
        });
        lastObjectRef = { kind: "celExtra", index: frameOut.chunks.length - 1 };
        chunkSummary.parsed = { flags: flagsEx };
      } else if (chunkType === 0x2007) {
        // Color profile
        const profileType = r.u16();
        const profileFlags = r.u16();
        const gamma = r.fixed16_16();
        r.take(8);
        let iccLen = 0;
        if (profileType === 2) {
          iccLen = r.u32();
          r.take(Math.min(iccLen, r.remaining()));
        }
        colorProfile = { type: profileType, flags: profileFlags, gamma, iccBytes: iccLen };
        chunkSummary.parsed = { type: profileType };
      } else if (chunkType === 0x2008) {
        // External files
        const n = r.u32();
        r.take(8);
        for (let i = 0; i < n; i += 1) {
          const entryId = r.u32();
          const t = r.u8();
          r.take(7);
          externalFiles.push({ id: entryId, type: t, name: r.string() });
        }
        chunkSummary.parsed = { entries: n };
      } else if (chunkType === 0x2018) {
        // Tags
        const n = r.u16();
        r.take(8);
        const baseIndex = tags.length;
        for (let i = 0; i < n; i += 1) {
          const from = r.u16();
          const to = r.u16();
          const direction = r.u8();
          const repeat = r.u16();
          r.take(6);
          r.take(3);
          r.take(1);
          tags.push({ from, to, direction, repeat, name: r.string() });
        }
        pendingTagUserData = Array.from({ length: n }, (_, i) => baseIndex + i);
        chunkSummary.parsed = { tags: n };
      } else if (chunkType === 0x2019) {
        // Palette
        const newSize = r.u32();
        const first = r.u32();
        const last = r.u32();
        r.take(8);
        const count = last >= first ? last - first + 1 : 0;
        const entriesPreview: Record<string, unknown>[] = [];
        for (let i = 0; i < count; i += 1) {
          const entryFlags = r.u16();
          const rgba = [...r.take(4)];
          // A named entry must be consumed whether or not it is previewed.
          const name = entryFlags & 1 ? r.string() : null;
          if (i < paletteEntries) {
            const entry: Record<string, unknown> = { rgba };
            if (name !== null) entry.name = name;
            entriesPreview.push(entry);
          }
        }
        palettes.push({
          paletteSize: newSize,
          first,
          last,
          entriesPreview,
          entriesPreviewCount: entriesPreview.length,
          changedCount: count,
        });
        chunkSummary.parsed = { changedCount: count };
      } else if (chunkType === 0x2020) {
        // User data
        const uflags = r.u32();
        const ud: UserData = { flags: uflags };
        if (uflags & 1) ud.text = r.string();
        if (uflags & 2) ud.color = [...r.take(4)];
        if (uflags & 4) {
          const totalSize = r.u32();
          const maps = r.u32();
          const propsMaps: { key: number; properties: Record<string, PropertyValue> }[] = [];
          for (let i = 0; i < maps; i += 1) {
            const mapKey = r.u32();
            propsMaps.push({ key: mapKey, properties: parsePropertiesMap(r) });
          }
          ud.properties = { declaredBytes: totalSize, maps: propsMaps };
        }

        let attached: { kind: string | null; index: number | null } = { kind: null, index: null };
        if (pendingTagUserData.length > 0) {
          const tagIndex = pendingTagUserData.shift()!;
          tags[tagIndex]!.userData = ud;
          attached = { kind: "tag", index: tagIndex };
        } else if (lastObjectRef !== null) {
          const { kind, index } = lastObjectRef;
          if (kind === "layer") layers[index]!.userData = ud;
          else frameOut.chunks[index]!.userData = ud;
          attached = { kind, index };
        }
        chunkSummary.parsed = { attachedTo: attached };
      } else if (chunkType === 0x2022) {
        // Slice
        const n = r.u32();
        const sflags = r.u32();
        r.u32(); // reserved
        const name = r.string();
        const keys: Record<string, unknown>[] = [];
        for (let i = 0; i < n; i += 1) {
          const frameNumber = r.u32();
          const sx = r.s32();
          const sy = r.s32();
          const sw = r.u32();
          const sh = r.u32();
          const sliceKey: Record<string, unknown> = {
            frame: frameNumber,
            bounds: { x: sx, y: sy, w: sw, h: sh },
          };
          if (sflags & 1) {
            const cx = r.s32();
            const cy = r.s32();
            const cw = r.u32();
            const ch = r.u32();
            sliceKey.center = { x: cx, y: cy, w: cw, h: ch };
          }
          if (sflags & 2) sliceKey.pivot = { x: r.s32(), y: r.s32() };
          keys.push(sliceKey);
        }
        slices.push({ name, flags: sflags, keys });
        chunkSummary.parsed = { name, keys: n };
      } else if (chunkType === 0x2023) {
        // Tileset
        const tsId = r.u32();
        const tsFlags = r.u32();
        const numTiles = r.u32();
        const tileW = r.u16();
        const tileH = r.u16();
        const baseIndex = r.s16();
        r.take(14);
        const name = r.string();
        const ts: Record<string, unknown> = {
          id: tsId,
          flags: tsFlags,
          numTiles,
          tileW,
          tileH,
          baseIndex,
          name,
        };
        if (tsFlags & 1) ts.external = { fileId: r.u32(), tilesetId: r.u32() };
        if (tsFlags & 2) {
          const dataLen = r.u32();
          r.take(Math.min(dataLen, r.remaining()));
          ts.embeddedImageCompressedBytes = dataLen;
        }
        tilesets.push(ts);
        lastObjectRef = { kind: "tileset", index: tilesets.length - 1 };
        chunkSummary.parsed = { id: tsId, name };
      } else {
        unknownChunks.push({ type: chunkType, size: chunkSize });
      }

      (frameOut.chunkSummaries ??= []).push(chunkSummary);
    }

    framesOut.push(frameOut);
  }

  // A zero frame duration falls back to the deprecated file-wide speed.
  const durations = framesOut.map((fr) => (fr.durationMs <= 0 ? speedDeprecated : fr.durationMs));
  const totalMs = durations.reduce((sum, d) => sum + d, 0);

  // A linked cel has no pixels of its own; borrow what the target frame decoded.
  if (decodeCels) {
    for (const fr of framesOut) {
      for (const chunk of fr.chunks) {
        if (chunk.type !== "cel") continue;
        const cel = chunk.data;
        if (cel.celType !== 1) continue;
        const targetFrame = typeof cel.linkFrame === "number" ? cel.linkFrame : -1;
        const layerIndex = cel.layerIndex as number;
        const k = key(targetFrame, layerIndex);
        if (decodedCelBounds.has(k)) {
          cel.decodedBounds = decodedCelBounds.get(k)!;
          const dims = decodedCelDims.get(k);
          if (dims) {
            cel.w = dims[0];
            cel.h = dims[1];
          }
        }
      }
    }
  }

  return {
    path,
    header: headerInfo,
    timeline: { frameMs: durations, totalMs },
    layers,
    tags,
    slices,
    tilesets,
    externalFiles,
    palettes,
    colorProfile,
    frames: framesOut,
    unknownChunks,
    notes: {
      specExtensions: ASEPRITE_EXTENSIONS,
      commonTypos: ASEPRITE_COMMON_TYPOS,
      decodeCels,
      indexedTransparency: { transparentIndex, treatIndex0Transparent },
    },
  };
}
