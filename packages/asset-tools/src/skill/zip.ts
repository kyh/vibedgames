/* oxlint-disable no-bitwise -- ZIP container writer: CRC32 hashing and DOS date/time bit packing */
import { deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer, enough to produce a `.skill` bundle.
 *
 * A `.skill` file is just a zip, and `node:zlib` already provides raw deflate,
 * so writing the container here avoids an archiver dependency entirely.
 * Stored (uncompressed) entries are used when deflate would make a file
 * bigger, which is what happens with tiny or already-compressed files like
 * PNGs.
 */

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0;
};

/** Convert a JS date to the DOS date/time pair ZIP headers use. */
const dosDateTime = (date: Date) => {
  const time =
    (Math.floor(date.getSeconds() / 2) & 0x1f) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getHours() & 0x1f) << 11);
  const day =
    (date.getDate() & 0x1f) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    ((Math.max(0, date.getFullYear() - 1980) & 0x7f) << 9);
  return { date: day, time };
};

/**
 * General-purpose bit 11: "the filename is UTF-8".
 *
 * Names are written with `Buffer.from(name, "utf8")`, so this has to be set —
 * with the flags at zero, a reader is entitled to decode them as CP437, and a
 * skill carrying `é.png` extracts as `Ã©.png`, breaking every link to it.
 */
const FLAG_UTF8 = 0x08_00;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  mtime?: Date;
}

export const createZip = (entries: ZipEntry[]): Buffer => {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf-8");
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data, { level: 9 });
    // Fall back to stored when compression does not pay for itself.
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : Buffer.from(entry.data);
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04_03_4b_50, 0);
    // version needed
    header.writeUInt16LE(20, 4);
    // general-purpose flags
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    // extra length
    header.writeUInt16LE(0, 28);
    locals.push(header, nameBytes, payload);

    const entryHeader = Buffer.alloc(46);
    entryHeader.writeUInt32LE(0x02_01_4b_50, 0);
    // version made by
    entryHeader.writeUInt16LE(20, 4);
    // version needed
    entryHeader.writeUInt16LE(20, 6);
    // general-purpose flags
    entryHeader.writeUInt16LE(FLAG_UTF8, 8);
    entryHeader.writeUInt16LE(method, 10);
    entryHeader.writeUInt16LE(time, 12);
    entryHeader.writeUInt16LE(date, 14);
    entryHeader.writeUInt32LE(crc, 16);
    entryHeader.writeUInt32LE(payload.length, 20);
    entryHeader.writeUInt32LE(entry.data.length, 24);
    entryHeader.writeUInt16LE(nameBytes.length, 28);
    // extra
    entryHeader.writeUInt16LE(0, 30);
    // comment
    entryHeader.writeUInt16LE(0, 32);
    // disk number
    entryHeader.writeUInt16LE(0, 34);
    // internal attrs
    entryHeader.writeUInt16LE(0, 36);
    // external attrs: regular file
    entryHeader.writeUInt32LE(0o644 << 16, 38);
    entryHeader.writeUInt32LE(offset, 42);
    central.push(entryHeader, nameBytes);

    offset += header.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  // this disk
  end.writeUInt16LE(0, 4);
  // disk with central directory
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  // comment length
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
};
