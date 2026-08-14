/**
 * A minimal Aseprite file writer, used to build fixtures for the reader.
 *
 * Aseprite itself is a GUI app, so there is no way to generate a `.ase` on a
 * build machine. Writing one here instead means the reader can be exercised
 * against every chunk kind it claims to handle — including the ones a hand-made
 * sprite would never contain, like linked cels, tilemap cels and typed user-data
 * properties — and the same bytes can be fed to any other implementation to
 * compare against.
 *
 * This is a fixture generator, not a general encoder: it writes exactly the
 * structures the tests need, in the layout the format spec describes.
 */

import { deflateSync } from "node:zlib";

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;

  private push(bytes: Uint8Array): this {
    this.parts.push(bytes);
    this.length += bytes.length;
    return this;
  }

  private scalar(size: number, write: (view: DataView) => void): this {
    const buf = new Uint8Array(size);
    write(new DataView(buf.buffer));
    return this.push(buf);
  }

  u8(v: number) {
    return this.scalar(1, (d) => d.setUint8(0, v));
  }
  u16(v: number) {
    return this.scalar(2, (d) => d.setUint16(0, v, true));
  }
  s16(v: number) {
    return this.scalar(2, (d) => d.setInt16(0, v, true));
  }
  u32(v: number) {
    return this.scalar(4, (d) => d.setUint32(0, v, true));
  }
  s32(v: number) {
    return this.scalar(4, (d) => d.setInt32(0, v, true));
  }
  f64(v: number) {
    return this.scalar(8, (d) => d.setFloat64(0, v, true));
  }
  /** 16.16 fixed point, the format's fractional type. */
  fixed(v: number) {
    return this.s32(Math.round(v * 65536));
  }
  zeros(n: number) {
    return this.push(new Uint8Array(n));
  }
  bytes(b: ArrayLike<number> | Uint8Array) {
    return this.push(b instanceof Uint8Array ? b : Uint8Array.from(b));
  }
  /** u16 length prefix, then UTF-8 — the format's only string encoding. */
  string(s: string) {
    const encoded = new TextEncoder().encode(s);
    return this.u16(encoded.length).bytes(encoded);
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** A chunk is its 6-byte header followed by the body it declares the size of. */
function chunk(type: number, body: Uint8Array): Uint8Array {
  return new Writer()
    .u32(body.length + 6)
    .u16(type)
    .bytes(body)
    .build();
}

export type ChunkList = Uint8Array[];

export const chunks = {
  colorProfile(type = 1, gamma = 1.0): Uint8Array {
    return chunk(0x2007, new Writer().u16(type).u16(0).fixed(gamma).zeros(8).build());
  },

  layer(opts: {
    name: string;
    type?: number;
    flags?: number;
    childLevel?: number;
    blendMode?: number;
    opacity?: number;
    tilesetIndex?: number;
    uuid?: Uint8Array;
  }): Uint8Array {
    const w = new Writer()
      .u16(opts.flags ?? 3)
      .u16(opts.type ?? 0)
      .u16(opts.childLevel ?? 0)
      .u16(0)
      .u16(0)
      .u16(opts.blendMode ?? 0)
      .u8(opts.opacity ?? 255)
      .zeros(3)
      .string(opts.name);
    if ((opts.type ?? 0) === 2) w.u32(opts.tilesetIndex ?? 0);
    if (opts.uuid) w.bytes(opts.uuid);
    return chunk(0x2004, w.build());
  },

  /** Cel type 2: the common case — a zlib-compressed rectangle of pixels. */
  compressedCel(opts: {
    layerIndex: number;
    x: number;
    y: number;
    w: number;
    h: number;
    pixels: Uint8Array;
    opacity?: number;
    zIndex?: number;
  }): Uint8Array {
    const body = new Writer()
      .u16(opts.layerIndex)
      .s16(opts.x)
      .s16(opts.y)
      .u8(opts.opacity ?? 255)
      .u16(2)
      .s16(opts.zIndex ?? 0)
      .zeros(5)
      .u16(opts.w)
      .u16(opts.h)
      .bytes(new Uint8Array(deflateSync(opts.pixels)))
      .build();
    return chunk(0x2005, body);
  },

  /** Cel type 0: uncompressed pixels, which the reader records but never copies. */
  rawCel(opts: {
    layerIndex: number;
    x: number;
    y: number;
    w: number;
    h: number;
    pixels: Uint8Array;
  }): Uint8Array {
    const body = new Writer()
      .u16(opts.layerIndex)
      .s16(opts.x)
      .s16(opts.y)
      .u8(255)
      .u16(0)
      .s16(0)
      .zeros(5)
      .u16(opts.w)
      .u16(opts.h)
      .bytes(opts.pixels)
      .build();
    return chunk(0x2005, body);
  },

  /** Cel type 1: a reference to the same layer's cel in an earlier frame. */
  linkedCel(opts: { layerIndex: number; x: number; y: number; linkFrame: number }): Uint8Array {
    const body = new Writer()
      .u16(opts.layerIndex)
      .s16(opts.x)
      .s16(opts.y)
      .u8(255)
      .u16(1)
      .s16(0)
      .zeros(5)
      .u16(opts.linkFrame)
      .build();
    return chunk(0x2005, body);
  },

  /** Cel type 3: tile indices rather than pixels, one packed integer per tile. */
  tilemapCel(opts: {
    layerIndex: number;
    x: number;
    y: number;
    wTiles: number;
    hTiles: number;
    bitsPerTile?: number;
    idMask?: number;
    xFlipMask?: number;
    yFlipMask?: number;
    dFlipMask?: number;
    tiles: number[];
  }): Uint8Array {
    const bitsPerTile = opts.bitsPerTile ?? 32;
    const tileBytes = bitsPerTile / 8;
    const raw = new Uint8Array(opts.tiles.length * tileBytes);
    opts.tiles.forEach((tile, i) => {
      let value = tile;
      for (let b = 0; b < tileBytes; b += 1) {
        raw[i * tileBytes + b] = value % 256;
        value = Math.floor(value / 256);
      }
    });
    const body = new Writer()
      .u16(opts.layerIndex)
      .s16(opts.x)
      .s16(opts.y)
      .u8(255)
      .u16(3)
      .s16(0)
      .zeros(5)
      .u16(opts.wTiles)
      .u16(opts.hTiles)
      .u16(bitsPerTile)
      .u32(opts.idMask ?? 0x1fffffff)
      .u32(opts.xFlipMask ?? 0x20000000)
      .u32(opts.yFlipMask ?? 0x40000000)
      .u32(opts.dFlipMask ?? 0x80000000)
      .zeros(10)
      .bytes(new Uint8Array(deflateSync(raw)))
      .build();
    return chunk(0x2005, body);
  },

  celExtra(opts: { flags?: number; x: number; y: number; w: number; h: number }): Uint8Array {
    const body = new Writer()
      .u32(opts.flags ?? 1)
      .fixed(opts.x)
      .fixed(opts.y)
      .fixed(opts.w)
      .fixed(opts.h)
      .zeros(16)
      .build();
    return chunk(0x2006, body);
  },

  externalFiles(entries: { id: number; type: number; name: string }[]): Uint8Array {
    const w = new Writer().u32(entries.length).zeros(8);
    for (const entry of entries) w.u32(entry.id).u8(entry.type).zeros(7).string(entry.name);
    return chunk(0x2008, w.build());
  },

  tags(list: { from: number; to: number; direction: number; repeat: number; name: string }[]) {
    const w = new Writer().u16(list.length).zeros(8);
    for (const tag of list) {
      w.u16(tag.from)
        .u16(tag.to)
        .u8(tag.direction)
        .u16(tag.repeat)
        .zeros(6)
        .zeros(3)
        .zeros(1)
        .string(tag.name);
    }
    return chunk(0x2018, w.build());
  },

  palette(opts: {
    paletteSize: number;
    first: number;
    entries: { rgba: [number, number, number, number]; name?: string }[];
  }): Uint8Array {
    const last = opts.first + opts.entries.length - 1;
    const w = new Writer().u32(opts.paletteSize).u32(opts.first).u32(last).zeros(8);
    for (const entry of opts.entries) {
      w.u16(entry.name === undefined ? 0 : 1).bytes(entry.rgba);
      if (entry.name !== undefined) w.string(entry.name);
    }
    return chunk(0x2019, w.build());
  },

  /**
   * User data attaches to whichever object came before it — or, after a tags
   * chunk, to each tag in turn.
   */
  userData(opts: {
    text?: string;
    color?: [number, number, number, number];
    properties?: { key: number; entries: [string, number, (w: Writer) => void][] }[];
  }): Uint8Array {
    let flags = 0;
    if (opts.text !== undefined) flags |= 1;
    if (opts.color !== undefined) flags |= 2;
    if (opts.properties !== undefined) flags |= 4;

    const w = new Writer().u32(flags);
    if (opts.text !== undefined) w.string(opts.text);
    if (opts.color !== undefined) w.bytes(opts.color);
    if (opts.properties !== undefined) {
      const maps = new Writer().u32(opts.properties.length);
      for (const map of opts.properties) {
        maps.u32(map.key).u32(map.entries.length);
        for (const [name, typeId, write] of map.entries) {
          maps.string(name).u16(typeId);
          write(maps);
        }
      }
      const built = maps.build();
      // The declared size counts itself plus the map payload.
      w.u32(built.length + 4).bytes(built);
    }
    return chunk(0x2020, w.build());
  },

  slice(opts: {
    name: string;
    flags?: number;
    keys: {
      frame: number;
      bounds: [number, number, number, number];
      center?: [number, number, number, number];
      pivot?: [number, number];
    }[];
  }): Uint8Array {
    const flags = opts.flags ?? 0;
    const w = new Writer().u32(opts.keys.length).u32(flags).u32(0).string(opts.name);
    for (const k of opts.keys) {
      w.u32(k.frame).s32(k.bounds[0]).s32(k.bounds[1]).u32(k.bounds[2]).u32(k.bounds[3]);
      if (flags & 1) {
        const c = k.center ?? [0, 0, 0, 0];
        w.s32(c[0]).s32(c[1]).u32(c[2]).u32(c[3]);
      }
      if (flags & 2) {
        const p = k.pivot ?? [0, 0];
        w.s32(p[0]).s32(p[1]);
      }
    }
    return chunk(0x2022, w.build());
  },

  tileset(opts: {
    id: number;
    name: string;
    numTiles: number;
    tileW: number;
    tileH: number;
    baseIndex?: number;
    flags?: number;
    externalFileId?: number;
    externalTilesetId?: number;
    embeddedImage?: Uint8Array;
  }): Uint8Array {
    const flags = opts.flags ?? 0;
    const w = new Writer()
      .u32(opts.id)
      .u32(flags)
      .u32(opts.numTiles)
      .u16(opts.tileW)
      .u16(opts.tileH)
      .s16(opts.baseIndex ?? 1)
      .zeros(14)
      .string(opts.name);
    if (flags & 1) w.u32(opts.externalFileId ?? 0).u32(opts.externalTilesetId ?? 0);
    if (flags & 2) {
      const image = opts.embeddedImage ?? new Uint8Array(0);
      w.u32(image.length).bytes(image);
    }
    return chunk(0x2023, w.build());
  },

  /** Anything the reader does not know is meant to be skipped by its size. */
  unknown(type: number, size: number): Uint8Array {
    return chunk(type, new Uint8Array(size));
  },
};

/** Property-value writers, for the typed entries inside a user-data map. */
export const prop = {
  bool: (v: boolean) => (w: Writer) => void w.u8(v ? 1 : 0),
  int16: (v: number) => (w: Writer) => void w.s16(v),
  uint32: (v: number) => (w: Writer) => void w.u32(v),
  double: (v: number) => (w: Writer) => void w.f64(v),
  string: (v: string) => (w: Writer) => void w.string(v),
  point: (x: number, y: number) => (w: Writer) => void w.s32(x).s32(y),
  rect: (x: number, y: number, rw: number, rh: number) => (w: Writer) =>
    void w.s32(x).s32(y).s32(rw).s32(rh),
  uuid: (bytes: Uint8Array) => (w: Writer) => void w.bytes(bytes),
  /** A homogeneous vector: one element type tag, then the values. */
  vectorOfInt16: (values: number[]) => (w: Writer) => {
    w.u32(values.length).u16(0x0004);
    for (const v of values) w.s16(v);
  },
};

export const PROP_TYPE = {
  bool: 0x0001,
  int16: 0x0004,
  uint32: 0x0007,
  double: 0x000c,
  string: 0x000d,
  point: 0x000e,
  rect: 0x0010,
  vector: 0x0011,
  uuid: 0x0013,
} as const;

export type FrameSpec = { durationMs: number; chunks: ChunkList };

export type FileSpec = {
  width: number;
  height: number;
  colorDepth: number;
  /** Bit 2 declares that every layer chunk carries a UUID. */
  flags?: number;
  speedDeprecatedMs?: number;
  transparentIndex?: number;
  numColors?: number;
  pixelRatio?: [number, number];
  grid?: [number, number, number, number];
  frames: FrameSpec[];
};

export function buildAseFile(spec: FileSpec): Uint8Array {
  const frameBlocks = spec.frames.map((frame) => {
    const body = new Writer();
    for (const c of frame.chunks) body.bytes(c);
    const built = body.build();
    return new Writer()
      .u32(built.length + 16)
      .u16(0xf1fa)
      .u16(0xffff) // old chunk count sentinel; the 32-bit field below is used
      .u16(frame.durationMs)
      .zeros(2)
      .u32(frame.chunks.length)
      .bytes(built)
      .build();
  });

  const framesSize = frameBlocks.reduce((sum, b) => sum + b.length, 0);
  const [pixelW, pixelH] = spec.pixelRatio ?? [1, 1];
  const [gridX, gridY, gridW, gridH] = spec.grid ?? [0, 0, 16, 16];

  const header = new Writer()
    .u32(128 + framesSize)
    .u16(0xa5e0)
    .u16(spec.frames.length)
    .u16(spec.width)
    .u16(spec.height)
    .u16(spec.colorDepth)
    .u32(spec.flags ?? 0)
    .u16(spec.speedDeprecatedMs ?? 100)
    .zeros(4)
    .zeros(4)
    .u8(spec.transparentIndex ?? 0)
    .zeros(3)
    .u16(spec.numColors ?? 0)
    .u8(pixelW)
    .u8(pixelH)
    .s16(gridX)
    .s16(gridY)
    .u16(gridW)
    .u16(gridH)
    .zeros(84)
    .build();

  const out = new Writer().bytes(header);
  for (const block of frameBlocks) out.bytes(block);
  return out.build();
}

/** A 4×4 RGBA block with an opaque 2×2 square at (1,1). */
function rgbaPixels(w: number, h: number, box: [number, number, number, number]): Uint8Array {
  const pixels = new Uint8Array(w * h * 4);
  const [bx, by, bw, bh] = box;
  for (let y = by; y < by + bh; y += 1) {
    for (let x = bx; x < bx + bw; x += 1) {
      const at = (y * w + x) * 4;
      pixels[at] = 200;
      pixels[at + 1] = 40;
      pixels[at + 2] = 90;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

function indexedPixels(w: number, h: number, box: [number, number, number, number]): Uint8Array {
  const pixels = new Uint8Array(w * h);
  const [bx, by, bw, bh] = box;
  for (let y = by; y < by + bh; y += 1) {
    for (let x = bx; x < bx + bw; x += 1) pixels[y * w + x] = 3;
  }
  return pixels;
}

const UUID_A = Uint8Array.from([
  0x1b, 0x4e, 0x28, 0xba, 0x2f, 0xa1, 0x11, 0xd2, 0x88, 0x3f, 0x00, 0x16, 0xd3, 0xcc, 0xa4, 0x27,
]);
const UUID_B = Uint8Array.from([
  0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
]);

/**
 * Every chunk kind the reader handles, in one RGBA file.
 *
 * Layer UUIDs are on, there is a tilemap layer with a tilemap cel, a linked cel
 * in the second frame, an unknown chunk to be skipped, and user data carrying
 * one of each property type.
 */
export function sampleRgbaFile(): Uint8Array {
  return buildAseFile({
    width: 8,
    height: 8,
    colorDepth: 32,
    flags: 4,
    speedDeprecatedMs: 120,
    grid: [-2, -3, 16, 16],
    pixelRatio: [1, 1],
    frames: [
      {
        durationMs: 100,
        chunks: [
          chunks.colorProfile(1, 1.0),
          chunks.externalFiles([
            { id: 0, type: 0, name: "palette.gpl" },
            { id: 1, type: 1, name: "tiles.aseprite" },
          ]),
          chunks.layer({ name: "background", uuid: UUID_A }),
          chunks.userData({
            text: "notes — ünicode",
            color: [10, 20, 30, 255],
            properties: [
              {
                key: 0,
                entries: [
                  ["visible", PROP_TYPE.bool, prop.bool(true)],
                  ["offset", PROP_TYPE.int16, prop.int16(-7)],
                  ["mask", PROP_TYPE.uint32, prop.uint32(0xdeadbeef)],
                  ["weight", PROP_TYPE.double, prop.double(0.125)],
                  ["label", PROP_TYPE.string, prop.string("hero")],
                  ["anchor", PROP_TYPE.point, prop.point(3, -4)],
                  ["hitbox", PROP_TYPE.rect, prop.rect(1, 2, 3, 4)],
                  ["steps", PROP_TYPE.vector, prop.vectorOfInt16([1, -2, 3])],
                  ["id", PROP_TYPE.uuid, prop.uuid(UUID_B)],
                ],
              },
            ],
          }),
          chunks.layer({ name: "tiles", type: 2, tilesetIndex: 0, uuid: UUID_B }),
          chunks.tileset({ id: 0, name: "terrain", numTiles: 4, tileW: 8, tileH: 8 }),
          chunks.compressedCel({
            layerIndex: 0,
            x: 2,
            y: 1,
            w: 4,
            h: 4,
            pixels: rgbaPixels(4, 4, [1, 1, 2, 2]),
          }),
          chunks.celExtra({ x: 2.5, y: 1.25, w: 4, h: 4 }),
          chunks.tilemapCel({
            layerIndex: 1,
            x: 0,
            y: 0,
            wTiles: 2,
            hTiles: 2,
            tiles: [0, 1, 2 | 0x20000000, 3],
          }),
          chunks.tags([
            { from: 0, to: 1, direction: 0, repeat: 0, name: "idle" },
            { from: 1, to: 1, direction: 1, repeat: 3, name: "blink" },
          ]),
          chunks.userData({ text: "loop forever" }),
          chunks.userData({ color: [255, 0, 0, 255] }),
          chunks.slice({
            name: "body",
            flags: 3,
            keys: [{ frame: 0, bounds: [1, 1, 6, 6], center: [2, 2, 2, 2], pivot: [3, 3] }],
          }),
          chunks.unknown(0x0004, 12),
        ],
      },
      {
        durationMs: 0,
        chunks: [
          chunks.linkedCel({ layerIndex: 0, x: 2, y: 1, linkFrame: 0 }),
          chunks.rawCel({
            layerIndex: 1,
            x: 0,
            y: 0,
            w: 2,
            h: 2,
            pixels: rgbaPixels(2, 2, [0, 0, 1, 1]),
          }),
        ],
      },
    ],
  });
}

/**
 * An indexed file, where transparency is a palette index rather than alpha.
 *
 * The transparent index is 2 and the drawn pixels are index 3, so bounds under
 * `--treat-index0-transparent` differ from bounds without it: the surrounding
 * zeros count as opaque unless that flag is set.
 */
export function sampleIndexedFile(): Uint8Array {
  return buildAseFile({
    width: 6,
    height: 6,
    colorDepth: 8,
    transparentIndex: 2,
    numColors: 4,
    frames: [
      {
        durationMs: 80,
        chunks: [
          chunks.layer({ name: "sprite" }),
          chunks.palette({
            paletteSize: 4,
            first: 0,
            entries: [
              { rgba: [0, 0, 0, 255], name: "black" },
              { rgba: [255, 255, 255, 255] },
              { rgba: [0, 0, 0, 0], name: "clear" },
              { rgba: [220, 60, 40, 255] },
            ],
          }),
          chunks.compressedCel({
            layerIndex: 0,
            x: 1,
            y: 1,
            w: 4,
            h: 4,
            pixels: indexedPixels(4, 4, [2, 2, 2, 2]),
          }),
        ],
      },
    ],
  });
}
