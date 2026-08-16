// GENERATED FILE — do not edit.
// Built from packages/asset-tools by `pnpm --filter @repo/asset-tools build`.
// Contains only the exports this skill's scripts import; edit the TypeScript
// source there and re-run `pnpm dogfood` (or that build) to regenerate.

// src/args.ts
function parseArgs(argv, options = {}) {
  const booleans = new Set(options.booleans ?? []);
  const known = /* @__PURE__ */ new Set([...booleans, ...options.values ?? [], "help"]);
  const strict = options.booleans !== void 0 || options.values !== void 0;
  const unknown = [];
  const positionals = [];
  const parsed = /* @__PURE__ */ new Map();
  const push = (key, value) => {
    const existing = parsed.get(key);
    if (existing) existing.push(value);
    else parsed.set(key, [value]);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h") {
      push("help", "true");
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      const name = body.slice(0, equals);
      if (strict && !known.has(name)) unknown.push(`--${name}`);
      push(name, body.slice(equals + 1));
      continue;
    }
    if (booleans.has(body)) {
      push(body, "true");
      continue;
    }
    if (strict && !known.has(body)) {
      unknown.push(`--${body}`);
      const next2 = argv[i + 1];
      if (next2 !== void 0 && !next2.startsWith("--")) i += 1;
      continue;
    }
    const next = argv[i + 1];
    if (next === void 0 || next.startsWith("--")) {
      push(body, "true");
    } else {
      push(body, next);
      i += 1;
    }
  }
  if (unknown.length > 0) failUsage(`unrecognized arguments: ${unknown.join(" ")}`);
  return { positionals, options: parsed };
}
function getString(args, key) {
  return args.options.get(key)?.at(-1);
}
function getFlag(args, key) {
  const value = getString(args, key);
  return value !== void 0 && value !== "false";
}
function getNumber(args, key, fallback) {
  const raw = getString(args, key);
  if (raw === void 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${key} must be a number, got "${raw}"`);
  return value;
}
function fail(message) {
  process.stderr.write(`${message}
`);
  process.exit(1);
}
function failUsage(message) {
  process.stderr.write(`${message}
`);
  process.exit(2);
}
function main(run) {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

// src/image/png.ts
var SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
var crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();

// src/asset/aseprite.ts
import { constants as zlibConstants, inflateSync } from "node:zlib";
var AsepriteParseError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AsepriteParseError";
  }
};
var Reader = class {
  constructor(data) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  data;
  view;
  off = 0;
  remaining() {
    return this.data.length - this.off;
  }
  need(size) {
    if (this.off + size > this.data.length) {
      throw new AsepriteParseError("Buffer underrun while unpacking.");
    }
    const at = this.off;
    this.off += size;
    return at;
  }
  take(n) {
    if (this.off + n > this.data.length) {
      throw new AsepriteParseError("Chunk underrun while reading.");
    }
    const out = this.data.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  u8() {
    return this.data[this.need(1)];
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
    return this.s32() / 65536;
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
      hex.slice(20)
    ].join("-");
  }
};
function decompressLimited(data, limitBytes) {
  const tooLarge = () => new AsepriteParseError(`Decompressed data exceeds limit (${limitBytes} bytes).`);
  let out;
  try {
    out = new Uint8Array(
      inflateSync(data, {
        // A limit of zero is legal here but not in zlib, so ask for one byte
        // and reject it below; an empty payload still passes, as it should.
        maxOutputLength: Math.max(limitBytes, 1),
        finishFlush: zlibConstants.Z_SYNC_FLUSH
      })
    );
  } catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
    throw error;
  }
  if (out.length > limitBytes) throw tooLarge();
  return out;
}
function bytesPerPixel(colorDepthBpp) {
  if (colorDepthBpp === 32) return 4;
  if (colorDepthBpp === 16) return 2;
  if (colorDepthBpp === 8) return 1;
  throw new AsepriteParseError(`Unsupported color depth: ${colorDepthBpp} bpp`);
}
function inferBoundsFromPixels(raw, width, height, colorDepthBpp, indexedTransparentIndex, treatIndex0Transparent) {
  const bpp = bytesPerPixel(colorDepthBpp);
  const expected = width * height * bpp;
  if (raw.length !== expected) {
    throw new AsepriteParseError(
      `Unexpected decoded pixel length (got ${raw.length}, expected ${expected}).`
    );
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const mark = (x, y) => {
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
        const idx = raw[rowOff + x];
        if (idx === indexedTransparentIndex) continue;
        if (treatIndex0Transparent && idx === 0) continue;
        mark(x, y);
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function parsePropertiesMap(r) {
  const count = r.u32();
  const props = {};
  for (let i = 0; i < count; i += 1) {
    const name = r.string();
    const typeId = r.u16();
    props[name] = parseTypedValue(r, typeId);
  }
  return props;
}
function parseVector(r) {
  const n = r.u32();
  const elemType = r.u16();
  const out = [];
  if (elemType === 0) {
    for (let i = 0; i < n; i += 1) out.push(parseTypedValue(r, r.u16()));
    return out;
  }
  for (let i = 0; i < n; i += 1) out.push(parseTypedValue(r, elemType));
  return out;
}
function parseTypedValue(r, typeId) {
  switch (typeId) {
    case 1:
      return Boolean(r.u8());
    case 2:
      return r.s8();
    case 3:
      return r.u8();
    case 4:
      return r.s16();
    case 5:
      return r.u16();
    case 6:
      return r.s32();
    case 7:
      return r.u32();
    case 8:
      return r.s64();
    case 9:
      return r.u64();
    case 10:
      return r.fixed16_16();
    case 11:
      return r.f32();
    case 12:
      return r.f64();
    case 13:
      return r.string();
    case 14:
      return { x: r.s32(), y: r.s32() };
    case 15:
      return { w: r.s32(), h: r.s32() };
    case 16: {
      const x = r.s32();
      const y = r.s32();
      const w = r.s32();
      const h = r.s32();
      return { x, y, w, h };
    }
    case 17:
      return parseVector(r);
    case 18:
      return parsePropertiesMap(r);
    case 19:
      return r.uuid();
    default:
      throw new AsepriteParseError(
        `Unsupported property type: 0x${typeId.toString(16).padStart(4, "0")}`
      );
  }
}
var ASEPRITE_EXTENSIONS = [".ase", ".aseprite"];
var ASEPRITE_COMMON_TYPOS = [".aes", ".aesprite"];
function inspectAseprite(path, bytes, options = {}) {
  const decodeCels = options.decodeCels ?? false;
  const maxDecompressMib = options.maxDecompressMib ?? 64;
  const paletteEntries = options.paletteEntries ?? 16;
  const treatIndex0Transparent = options.treatIndex0Transparent ?? false;
  let cursor = 0;
  const readExact = (n) => {
    const available = bytes.length - cursor;
    if (available < n) {
      throw new AsepriteParseError(
        `Unexpected EOF (wanted ${n} bytes, got ${Math.max(available, 0)}).`
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
  if (magic !== 42464) {
    throw new AsepriteParseError(
      `Bad magic 0x${magic.toString(16).padStart(4, "0")} (expected 0xA5E0).`
    );
  }
  const frames = headerView.getUint16(6, true);
  const width = headerView.getUint16(8, true);
  const height = headerView.getUint16(10, true);
  const colorDepth = headerView.getUint16(12, true);
  const flags = headerView.getUint32(14, true);
  const speedDeprecated = headerView.getUint16(18, true);
  const transparentIndex = header[28];
  const numColors = headerView.getUint16(32, true);
  const pixelW = header[34];
  const pixelH = header[35];
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
    grid: { x: gridX, y: gridY, w: gridW, h: gridH }
  };
  const hasLayerUuids = Boolean(flags & 4);
  const layers = [];
  const tags = [];
  const slices = [];
  const tilesets = [];
  const palettes = [];
  const externalFiles = [];
  let colorProfile = null;
  const unknownChunks = [];
  const framesOut = [];
  let lastObjectRef = null;
  let pendingTagUserData = [];
  const decodedCelBounds = /* @__PURE__ */ new Map();
  const decodedCelDims = /* @__PURE__ */ new Map();
  const key = (frameIndex, layerIndex) => `${frameIndex}:${layerIndex}`;
  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const frameHeader = readExact(16);
    const fv = new DataView(frameHeader.buffer, frameHeader.byteOffset, frameHeader.byteLength);
    const bytesInFrame = fv.getUint32(0, true);
    const frameMagic = fv.getUint16(4, true);
    const oldChunks = fv.getUint16(6, true);
    const frameDuration = fv.getUint16(8, true);
    const newChunks = fv.getUint32(12, true);
    if (frameMagic !== 61946) {
      throw new AsepriteParseError(
        `Bad frame magic 0x${frameMagic.toString(16).padStart(4, "0")} at frame ${frameIndex}.`
      );
    }
    let chunkCount;
    if (oldChunks === 65535) chunkCount = newChunks;
    else if (newChunks !== 0) chunkCount = newChunks;
    else chunkCount = oldChunks;
    const frameOut = {
      bytesInFrame,
      durationMs: frameDuration,
      chunks: []
    };
    for (let c = 0; c < chunkCount; c += 1) {
      const chunkHeader = readExact(6);
      const cv = new DataView(chunkHeader.buffer, chunkHeader.byteOffset, chunkHeader.byteLength);
      const chunkSize = cv.getUint32(0, true);
      const chunkType = cv.getUint16(4, true);
      if (chunkSize < 6) throw new AsepriteParseError(`Invalid chunk size ${chunkSize}.`);
      const r = new Reader(readExact(chunkSize - 6));
      const chunkSummary = { type: chunkType, size: chunkSize };
      if (chunkType === 8196) {
        const layerFlags = r.u16();
        const layerType = r.u16();
        const childLevel = r.u16();
        r.u16();
        r.u16();
        const blendMode = r.u16();
        const opacity = r.u8();
        r.take(3);
        const name = r.string();
        const layer = {
          flags: layerFlags,
          type: layerType,
          childLevel,
          blendMode,
          opacity,
          name
        };
        if (layerType === 2) layer.tilesetIndex = r.u32();
        if (hasLayerUuids) layer.uuid = r.uuid();
        layers.push(layer);
        lastObjectRef = { kind: "layer", index: layers.length - 1 };
        chunkSummary.parsed = { layerIndex: layers.length - 1, name };
      } else if (chunkType === 8197) {
        const layerIndex = r.u16();
        const x = r.s16();
        const y = r.s16();
        const celOpacity = r.u8();
        const celType = r.u16();
        const zIndex = r.s16();
        r.take(5);
        const cel = {
          layerIndex,
          x,
          y,
          opacity: celOpacity,
          celType,
          zIndex
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
          if (decodeCels) {
            const bpp = bytesPerPixel(colorDepth);
            const expected = w * h * bpp;
            const limit = Math.min(maxDecompressMib * 1024 * 1024, Math.max(expected, 1));
            const raw = decompressLimited(compressed, limit);
            if (raw.length !== expected) {
              throw new AsepriteParseError(
                `Decoded cel size mismatch at frame ${frameIndex} layer ${layerIndex} (got ${raw.length}, expected ${expected}).`
              );
            }
            const bounds = inferBoundsFromPixels(
              raw,
              w,
              h,
              colorDepth,
              transparentIndex,
              treatIndex0Transparent
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
            compressedBytes: compressed.length
          });
          if (decodeCels) {
            const tileBytes = Math.floor(bitsPerTile / 8);
            const expected = wTiles * hTiles * tileBytes;
            const limit = Math.min(maxDecompressMib * 1024 * 1024, Math.max(expected, 1));
            const raw = decompressLimited(compressed, limit);
            if (raw.length !== expected) {
              throw new AsepriteParseError(
                `Decoded tilemap size mismatch at frame ${frameIndex} layer ${layerIndex} (got ${raw.length}, expected ${expected}).`
              );
            }
            const uniqueIds = /* @__PURE__ */ new Set();
            let flipped = 0;
            const flipMask = (xFlipMask | yFlipMask | dFlipMask) >>> 0;
            for (let t = 0; t < raw.length; t += tileBytes) {
              let tileVal = 0;
              for (let b = tileBytes - 1; b >= 0; b -= 1) tileVal = tileVal * 256 + raw[t + b];
              const tileId = (tileVal & idMask) >>> 0;
              if (tileId !== 0) uniqueIds.add(tileId);
              if ((tileVal & flipMask) >>> 0) flipped += 1;
            }
            cel.decodedTilemapSummary = {
              nonZeroUniqueTileIds: uniqueIds.size,
              flippedTiles: flipped
            };
          }
        } else {
          cel.unparsedBytes = r.remaining();
        }
        frameOut.chunks.push({ type: "cel", data: cel });
        lastObjectRef = { kind: "cel", index: frameOut.chunks.length - 1 };
        chunkSummary.parsed = { layerIndex, celType };
      } else if (chunkType === 8198) {
        const flagsEx = r.u32();
        const px = r.fixed16_16();
        const py = r.fixed16_16();
        const pw = r.fixed16_16();
        const ph = r.fixed16_16();
        r.take(Math.min(16, r.remaining()));
        frameOut.chunks.push({
          type: "celExtra",
          data: { flags: flagsEx, precise: { x: px, y: py, w: pw, h: ph } }
        });
        lastObjectRef = { kind: "celExtra", index: frameOut.chunks.length - 1 };
        chunkSummary.parsed = { flags: flagsEx };
      } else if (chunkType === 8199) {
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
      } else if (chunkType === 8200) {
        const n = r.u32();
        r.take(8);
        for (let i = 0; i < n; i += 1) {
          const entryId = r.u32();
          const t = r.u8();
          r.take(7);
          externalFiles.push({ id: entryId, type: t, name: r.string() });
        }
        chunkSummary.parsed = { entries: n };
      } else if (chunkType === 8216) {
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
      } else if (chunkType === 8217) {
        const newSize = r.u32();
        const first = r.u32();
        const last = r.u32();
        r.take(8);
        const count = last >= first ? last - first + 1 : 0;
        const entriesPreview = [];
        for (let i = 0; i < count; i += 1) {
          const entryFlags = r.u16();
          const rgba = [...r.take(4)];
          const name = entryFlags & 1 ? r.string() : null;
          if (i < paletteEntries) {
            const entry = { rgba };
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
          changedCount: count
        });
        chunkSummary.parsed = { changedCount: count };
      } else if (chunkType === 8224) {
        const uflags = r.u32();
        const ud = { flags: uflags };
        if (uflags & 1) ud.text = r.string();
        if (uflags & 2) ud.color = [...r.take(4)];
        if (uflags & 4) {
          const totalSize = r.u32();
          const maps = r.u32();
          const propsMaps = [];
          for (let i = 0; i < maps; i += 1) {
            const mapKey = r.u32();
            propsMaps.push({ key: mapKey, properties: parsePropertiesMap(r) });
          }
          ud.properties = { declaredBytes: totalSize, maps: propsMaps };
        }
        let attached = { kind: null, index: null };
        if (pendingTagUserData.length > 0) {
          const tagIndex = pendingTagUserData.shift();
          tags[tagIndex].userData = ud;
          attached = { kind: "tag", index: tagIndex };
        } else if (lastObjectRef !== null) {
          const { kind, index } = lastObjectRef;
          if (kind === "layer") layers[index].userData = ud;
          else frameOut.chunks[index].userData = ud;
          attached = { kind, index };
        }
        chunkSummary.parsed = { attachedTo: attached };
      } else if (chunkType === 8226) {
        const n = r.u32();
        const sflags = r.u32();
        r.u32();
        const name = r.string();
        const keys = [];
        for (let i = 0; i < n; i += 1) {
          const frameNumber = r.u32();
          const sx = r.s32();
          const sy = r.s32();
          const sw = r.u32();
          const sh = r.u32();
          const sliceKey = {
            frame: frameNumber,
            bounds: { x: sx, y: sy, w: sw, h: sh }
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
      } else if (chunkType === 8227) {
        const tsId = r.u32();
        const tsFlags = r.u32();
        const numTiles = r.u32();
        const tileW = r.u16();
        const tileH = r.u16();
        const baseIndex = r.s16();
        r.take(14);
        const name = r.string();
        const ts = {
          id: tsId,
          flags: tsFlags,
          numTiles,
          tileW,
          tileH,
          baseIndex,
          name
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
  const durations = framesOut.map((fr) => fr.durationMs <= 0 ? speedDeprecated : fr.durationMs);
  const totalMs = durations.reduce((sum, d) => sum + d, 0);
  if (decodeCels) {
    for (const fr of framesOut) {
      for (const chunk of fr.chunks) {
        if (chunk.type !== "cel") continue;
        const cel = chunk.data;
        if (cel.celType !== 1) continue;
        const targetFrame = typeof cel.linkFrame === "number" ? cel.linkFrame : -1;
        const layerIndex = cel.layerIndex;
        const k = key(targetFrame, layerIndex);
        if (decodedCelBounds.has(k)) {
          cel.decodedBounds = decodedCelBounds.get(k);
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
      indexedTransparency: { transparentIndex, treatIndex0Transparent }
    }
  };
}

// src/sprite/presets.ts
var action = (name, defaultFrames, recommendedFrames, fps, timing, loopable, selectionPolicy) => ({
  action: name,
  defaultFrames,
  recommendedFrames,
  fps,
  timing,
  loopable,
  selectionPolicy
});
var ACTIONS = {
  idle: action("idle", 10, [8, 10, 12], 6, "loop", true, "cycle"),
  hurt: action("hurt", 6, [4, 5, 6, 8], 8, "one_shot", false, "action_window"),
  jump: action("jump", 6, [6, 8, 10], 8, "transition", false, "full_duration_include_end"),
  crouch: action("crouch", 6, [5, 6, 8], 8, "hold", true, "hold_pose"),
  attack: action("attack", 8, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  death: action("death", 10, [8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  walk: action("walk", 8, [8, 10, 12], 10, "loop", true, "cycle"),
  run: action("run", 8, [8, 10, 12], 12, "loop", true, "cycle"),
  roll: action("roll", 8, [6, 8, 10], 14, "one_shot", false, "action_window"),
  dash: action("dash", 6, [5, 6, 8], 14, "one_shot", false, "action_window"),
  talk: action("talk", 12, [8, 10, 12], 8, "loop", true, "cycle"),
  interact: action("interact", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  pick_up: action("pick_up", 12, [8, 10, 12], 8, "one_shot", false, "action_window"),
  use: action("use", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  examine: action("examine", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  give: action("give", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  shrug: action("shrug", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  walk_forward: action("walk_forward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_backward: action("walk_backward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  block_high: action("block_high", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  block_low: action("block_low", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  knockdown: action(
    "knockdown",
    12,
    [8, 10, 12],
    8,
    "transition",
    false,
    "full_duration_include_end"
  ),
  get_up: action("get_up", 12, [6, 8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  light_attack: action("light_attack", 8, [6, 8, 10, 12], 12, "one_shot", false, "action_window"),
  heavy_attack: action("heavy_attack", 12, [6, 8, 10, 12], 10, "one_shot", false, "action_window")
};

// src/skill/normalize-factory.ts
var MARKER = "// @ts-nocheck";
var HEADER = `${MARKER}
// GENERATED by img2threejs, normalized by plugins/asset-pipeline/skills/image-to-threejs.
// Do not edit: re-run the generator, then normalize_factory.mjs. Consume it only
// through its exported factory functions, which are typed at the call site.
`;

// src/skill/zip.ts
var crcTable2 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
export {
  getFlag,
  getNumber,
  inspectAseprite,
  main,
  parseArgs
};
