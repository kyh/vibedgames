// GENERATED FILE — do not edit.
// Built from packages/asset-tools by `pnpm --filter @repo/asset-tools build`.
// Contains only the exports this skill's scripts import; edit the TypeScript
// source there and re-run `pnpm dogfood` (or that build) to regenerate.

// src/args.ts
import { readFileSync } from "node:fs";
var headerDoc = (entry) => {
  if (!entry) {
    return null;
  }
  let source;
  try {
    source = readFileSync(entry, "utf-8");
  } catch {
    return null;
  }
  const doc = /^(?:#![^\n]*\n)?\/\*\*(?<doc>[\s\S]*?)\*\//u.exec(source)?.groups?.doc;
  if (doc === void 0) {
    return null;
  }
  const text = doc.split("\n").map((line) => line.replace(/^\s*\* ?/u, "")).join("\n").trim();
  return text.length > 0 ? text : null;
};
var fail = (message) => {
  process.stderr.write(`${message}
`);
  process.exit(1);
};
var failUsage = (message) => {
  process.stderr.write(`${message}
`);
  process.exit(2);
};
var declaredOptions = (options) => {
  const booleans = new Set(options.booleans);
  const known = /* @__PURE__ */ new Set([...booleans, ...options.values ?? [], "help"]);
  const strict = options.booleans !== void 0 || options.values !== void 0;
  return { booleans, known, strict };
};
var isValueToken = (token) => token !== void 0 && !token.startsWith("--");
var parseArgs = (argv, options = {}) => {
  const { booleans, known, strict } = declaredOptions(options);
  const unknown = [];
  const positionals = [];
  const parsed = /* @__PURE__ */ new Map();
  const push = (key, value) => {
    const existing = parsed.get(key);
    if (existing) {
      existing.push(value);
    } else {
      parsed.set(key, [value]);
    }
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
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
      if (strict && !known.has(name)) {
        unknown.push(`--${name}`);
      }
      push(name, body.slice(equals + 1));
      continue;
    }
    if (booleans.has(body)) {
      push(body, "true");
      continue;
    }
    if (strict && !known.has(body)) {
      unknown.push(`--${body}`);
      if (isValueToken(argv[i + 1])) {
        i += 1;
      }
      continue;
    }
    const next = argv[i + 1];
    if (isValueToken(next)) {
      push(body, next);
      i += 1;
    } else {
      push(body, "true");
    }
  }
  if (unknown.length > 0) {
    failUsage(`unrecognized arguments: ${unknown.join(" ")}`);
  }
  if (parsed.has("help")) {
    const help = headerDoc(process.argv[1]);
    process.stdout.write(`${help ?? "No help available."}
`);
    process.exit(0);
  }
  return { options: parsed, positionals };
};
var getString = (args, key) => args.options.get(key)?.at(-1);
var getFlag = (args, key) => {
  const value = getString(args, key);
  return value !== void 0 && value !== "false";
};
var getInt = (args, key, fallback) => {
  const raw = getString(args, key);
  if (raw === void 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    failUsage(`--${key} must be a whole number, got "${raw}"`);
  }
  return value;
};
var main = (run) => {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
};

// src/image/png.ts
var SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
var crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

// src/asset/aseprite.ts
import { constants as zlibConstants, inflateSync } from "node:zlib";

// src/asset/aseprite-error.ts
var AsepriteParseError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AsepriteParseError";
  }
};

// src/asset/aseprite.ts
var Reader = class {
  data;
  view;
  off = 0;
  constructor(data) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
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
var decompressLimited = (data, limitBytes) => {
  const tooLarge = () => new AsepriteParseError(`Decompressed data exceeds limit (${limitBytes} bytes).`);
  let out;
  try {
    out = new Uint8Array(
      inflateSync(data, {
        // A limit of zero is legal here but not in zlib, so ask for one byte
        // and reject it below; an empty payload still passes, as it should.
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
        maxOutputLength: Math.max(limitBytes, 1)
      })
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
var bytesPerPixel = (colorDepthBpp) => {
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
var inferBoundsFromPixels = (raw, width, height, colorDepthBpp, indexedTransparentIndex, treatIndex0Transparent) => {
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
        if (idx === void 0 || idx === indexedTransparentIndex) {
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
var parseTypedValue = (r, typeId) => {
  switch (typeId) {
    case 1: {
      return Boolean(r.u8());
    }
    case 2: {
      return r.s8();
    }
    case 3: {
      return r.u8();
    }
    case 4: {
      return r.s16();
    }
    case 5: {
      return r.u16();
    }
    case 6: {
      return r.s32();
    }
    case 7: {
      return r.u32();
    }
    case 8: {
      return r.s64();
    }
    case 9: {
      return r.u64();
    }
    case 10: {
      return r.fixed16_16();
    }
    case 11: {
      return r.f32();
    }
    case 12: {
      return r.f64();
    }
    case 13: {
      return r.string();
    }
    case 14: {
      return { x: r.s32(), y: r.s32() };
    }
    case 15: {
      return { h: r.s32(), w: r.s32() };
    }
    case 16: {
      const x = r.s32();
      const y = r.s32();
      const w = r.s32();
      const h = r.s32();
      return { h, w, x, y };
    }
    case 17: {
      return parseVector(r);
    }
    case 18: {
      return parsePropertiesMap(r);
    }
    case 19: {
      return r.uuid();
    }
    default: {
      throw new AsepriteParseError(
        `Unsupported property type: 0x${typeId.toString(16).padStart(4, "0")}`
      );
    }
  }
};
var parsePropertiesMap = (r) => {
  const count = r.u32();
  const props = {};
  for (let i = 0; i < count; i += 1) {
    const name = r.string();
    const typeId = r.u16();
    props[name] = parseTypedValue(r, typeId);
  }
  return props;
};
var parseVector = (r) => {
  const n = r.u32();
  const elemType = r.u16();
  const out = [];
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
var ASEPRITE_EXTENSIONS = [".ase", ".aseprite"];
var ASEPRITE_COMMON_TYPOS = [".aes", ".aesprite"];
var hasFlag = (flags, bit) => (flags & bit) !== 0;
var celKey = (frameIndex, layerIndex) => `${frameIndex}:${layerIndex}`;
var decompressLimit = (state, expected) => Math.min(state.maxDecompressMib * 1024 * 1024, Math.max(expected, 1));
var parseLayerChunk = (state, r) => {
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
    blendMode,
    childLevel,
    flags: layerFlags,
    name,
    opacity,
    type: layerType
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
var decodeCompressedCel = (state, cel, frameIndex, w, h, compressed) => {
  const bpp = bytesPerPixel(state.colorDepth);
  const expected = w * h * bpp;
  const raw = decompressLimited(compressed, decompressLimit(state, expected));
  if (raw.length !== expected) {
    throw new AsepriteParseError(
      `Decoded cel size mismatch at frame ${frameIndex} layer ${cel.layerIndex} (got ${raw.length}, expected ${expected}).`
    );
  }
  const bounds = inferBoundsFromPixels(
    raw,
    w,
    h,
    state.colorDepth,
    state.transparentIndex,
    state.treatIndex0Transparent
  );
  cel.decodedBounds = bounds;
  state.decodedCelBounds.set(celKey(frameIndex, cel.layerIndex), bounds);
  state.decodedCelDims.set(celKey(frameIndex, cel.layerIndex), [w, h]);
};
var decodeTilemapCel = (state, cel, frameIndex, tilemap, compressed) => {
  const tileBytes = Math.floor(tilemap.bitsPerTile / 8);
  const expected = tilemap.wTiles * tilemap.hTiles * tileBytes;
  const raw = decompressLimited(compressed, decompressLimit(state, expected));
  if (raw.length !== expected) {
    throw new AsepriteParseError(
      `Decoded tilemap size mismatch at frame ${frameIndex} layer ${cel.layerIndex} (got ${raw.length}, expected ${expected}).`
    );
  }
  const uniqueIds = /* @__PURE__ */ new Set();
  let flipped = 0;
  const flipMask = (tilemap.xFlipMask | tilemap.yFlipMask | tilemap.dFlipMask) >>> 0;
  for (let t = 0; t < raw.length; t += tileBytes) {
    let tileVal = 0;
    for (let b = tileBytes - 1; b >= 0; b -= 1) {
      tileVal = tileVal * 256 + (raw[t + b] ?? 0);
    }
    const tileId = (tileVal & tilemap.idMask) >>> 0;
    if (tileId !== 0) {
      uniqueIds.add(tileId);
    }
    if ((tileVal & flipMask) >>> 0) {
      flipped += 1;
    }
  }
  cel.decodedTilemapSummary = {
    flippedTiles: flipped,
    nonZeroUniqueTileIds: uniqueIds.size
  };
};
var parseCelChunk = (state, frameOut, frameIndex, r) => {
  const layerIndex = r.u16();
  const x = r.s16();
  const y = r.s16();
  const celOpacity = r.u8();
  const celType = r.u16();
  const zIndex = r.s16();
  r.take(5);
  const cel = {
    celType,
    layerIndex,
    opacity: celOpacity,
    x,
    y,
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
    const tilemap = {
      bitsPerTile,
      dFlipMask,
      hTiles,
      idMask,
      wTiles,
      xFlipMask,
      yFlipMask
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
var parseCelExtraChunk = (state, frameOut, r) => {
  const flagsEx = r.u32();
  const px = r.fixed16_16();
  const py = r.fixed16_16();
  const pw = r.fixed16_16();
  const ph = r.fixed16_16();
  r.take(Math.min(16, r.remaining()));
  frameOut.chunks.push({
    data: { flags: flagsEx, precise: { h: ph, w: pw, x: px, y: py } },
    type: "celExtra"
  });
  state.lastObjectRef = { index: frameOut.chunks.length - 1, kind: "celExtra" };
  return { flags: flagsEx };
};
var parseColorProfileChunk = (state, r) => {
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
var parseExternalFilesChunk = (state, r) => {
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
var parseTagsChunk = (state, r) => {
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
var parsePaletteChunk = (state, r) => {
  const newSize = r.u32();
  const first = r.u32();
  const last = r.u32();
  r.take(8);
  const count = last >= first ? last - first + 1 : 0;
  const entriesPreview = [];
  for (let i = 0; i < count; i += 1) {
    const entryFlags = r.u16();
    const rgba = [...r.take(4)];
    const name = hasFlag(entryFlags, 1) ? r.string() : null;
    if (i < state.paletteEntries) {
      const entry = { rgba };
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
    paletteSize: newSize
  });
  return { changedCount: count };
};
var parseUserDataChunk = (state, frameOut, r) => {
  const uflags = r.u32();
  const ud = { flags: uflags };
  if (hasFlag(uflags, 1)) {
    ud.text = r.string();
  }
  if (hasFlag(uflags, 2)) {
    ud.color = [...r.take(4)];
  }
  if (hasFlag(uflags, 4)) {
    const totalSize = r.u32();
    const maps = r.u32();
    const propsMaps = [];
    for (let i = 0; i < maps; i += 1) {
      const mapKey = r.u32();
      propsMaps.push({ key: mapKey, properties: parsePropertiesMap(r) });
    }
    ud.properties = { declaredBytes: totalSize, maps: propsMaps };
  }
  let attached = { index: null, kind: null };
  const tagIndex = state.pendingTagUserData.shift();
  if (tagIndex !== void 0) {
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
var parseSliceChunk = (state, r) => {
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
      bounds: { h: sh, w: sw, x: sx, y: sy },
      frame: frameNumber
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
var parseTilesetChunk = (state, r) => {
  const tsId = r.u32();
  const tsFlags = r.u32();
  const numTiles = r.u32();
  const tileW = r.u16();
  const tileH = r.u16();
  const baseIndex = r.s16();
  r.take(14);
  const name = r.string();
  const ts = {
    baseIndex,
    flags: tsFlags,
    id: tsId,
    name,
    numTiles,
    tileH,
    tileW
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
var parseChunk = (state, frameOut, frameIndex, chunkType, chunkSize, r) => {
  switch (chunkType) {
    case 8196: {
      return parseLayerChunk(state, r);
    }
    case 8197: {
      return parseCelChunk(state, frameOut, frameIndex, r);
    }
    case 8198: {
      return parseCelExtraChunk(state, frameOut, r);
    }
    case 8199: {
      return parseColorProfileChunk(state, r);
    }
    case 8200: {
      return parseExternalFilesChunk(state, r);
    }
    case 8216: {
      return parseTagsChunk(state, r);
    }
    case 8217: {
      return parsePaletteChunk(state, r);
    }
    case 8224: {
      return parseUserDataChunk(state, frameOut, r);
    }
    case 8226: {
      return parseSliceChunk(state, r);
    }
    case 8227: {
      return parseTilesetChunk(state, r);
    }
    default: {
      state.unknownChunks.push({ size: chunkSize, type: chunkType });
      return void 0;
    }
  }
};
var resolveLinkedCels = (state, framesOut) => {
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
var inspectAseprite = (path, bytes, options = {}) => {
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
    width
  };
  const state = {
    colorDepth,
    colorProfile: null,
    decodeCels,
    decodedCelBounds: /* @__PURE__ */ new Map(),
    decodedCelDims: /* @__PURE__ */ new Map(),
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
    unknownChunks: []
  };
  const framesOut = [];
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
    if (oldChunks === 65535) {
      chunkCount = newChunks;
    } else if (newChunks === 0) {
      chunkCount = oldChunks;
    } else {
      chunkCount = newChunks;
    }
    const frameOut = {
      bytesInFrame,
      chunks: [],
      durationMs: frameDuration
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
      const chunkSummary = { size: chunkSize, type: chunkType };
      const parsed = parseChunk(state, frameOut, frameIndex, chunkType, chunkSize, r);
      if (parsed !== void 0) {
        chunkSummary.parsed = parsed;
      }
      (frameOut.chunkSummaries ??= []).push(chunkSummary);
    }
    framesOut.push(frameOut);
  }
  const durations = framesOut.map((fr) => fr.durationMs <= 0 ? speedDeprecated : fr.durationMs);
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
      specExtensions: ASEPRITE_EXTENSIONS
    },
    palettes: state.palettes,
    path,
    slices: state.slices,
    tags: state.tags,
    tilesets: state.tilesets,
    timeline: { frameMs: durations, totalMs },
    unknownChunks: state.unknownChunks
  };
};

// src/sprite/presets.ts
var action = (name, defaultFrames, recommendedFrames, fps, timing, loopable, selectionPolicy) => ({
  action: name,
  defaultFrames,
  fps,
  loopable,
  recommendedFrames,
  selectionPolicy,
  timing
});
var ACTIONS = {
  attack: action("attack", 8, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  block_high: action("block_high", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  block_low: action("block_low", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  crouch: action("crouch", 6, [5, 6, 8], 8, "hold", true, "hold_pose"),
  dash: action("dash", 6, [5, 6, 8], 14, "one_shot", false, "action_window"),
  death: action("death", 10, [8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  examine: action("examine", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  get_up: action("get_up", 12, [6, 8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  give: action("give", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  heavy_attack: action("heavy_attack", 12, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  hurt: action("hurt", 6, [4, 5, 6, 8], 8, "one_shot", false, "action_window"),
  idle: action("idle", 10, [8, 10, 12], 6, "loop", true, "cycle"),
  interact: action("interact", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  jump: action("jump", 6, [6, 8, 10], 8, "transition", false, "full_duration_include_end"),
  knockdown: action(
    "knockdown",
    12,
    [8, 10, 12],
    8,
    "transition",
    false,
    "full_duration_include_end"
  ),
  light_attack: action("light_attack", 8, [6, 8, 10, 12], 12, "one_shot", false, "action_window"),
  pick_up: action("pick_up", 12, [8, 10, 12], 8, "one_shot", false, "action_window"),
  roll: action("roll", 8, [6, 8, 10], 14, "one_shot", false, "action_window"),
  run: action("run", 8, [8, 10, 12], 12, "loop", true, "cycle"),
  shrug: action("shrug", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  talk: action("talk", 12, [8, 10, 12], 8, "loop", true, "cycle"),
  use: action("use", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  walk: action("walk", 8, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_backward: action("walk_backward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_forward: action("walk_forward", 12, [8, 10, 12], 10, "loop", true, "cycle")
};

// src/skill/normalize-factory.ts
var MARKER = "// @ts-nocheck";
var HEADER = `${MARKER}
// GENERATED by img2threejs, normalized by plugins/asset-pipeline/skills/image-to-threejs.
// Do not edit: re-run the generator, then normalize-factory.mjs. Consume it only
// through its exported factory functions, which are typed at the call site.
`;

// src/skill/zip.ts
var crcTable2 = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();
export {
  getFlag,
  getInt,
  inspectAseprite,
  main,
  parseArgs
};
