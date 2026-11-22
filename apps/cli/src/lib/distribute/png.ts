import { closeSync, openSync, readSync } from "node:fs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 24;
const WIDTH_OFFSET = 16;
const HEIGHT_OFFSET = 20;

/** A PNG's pixel size read from its header, or null when the file is not a PNG. */
export const readPngSize = (file: string) => {
  const header = Buffer.alloc(HEADER_BYTES);
  const fd = openSync(file, "r");

  try {
    if (readSync(fd, header, 0, HEADER_BYTES, 0) < HEADER_BYTES) {
      return null;
    }
  } finally {
    closeSync(fd);
  }

  if (!header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }

  return { height: header.readUInt32BE(HEIGHT_OFFSET), width: header.readUInt32BE(WIDTH_OFFSET) };
};
