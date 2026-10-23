import { ORPCError } from "@orpc/server";

/**
 * A gzipped ustar archive of a deployment's files, in the shape `vg deploy
 * --source` uploads and `vg fork` extracts: plain files at their paths, no
 * root folder. Built in memory, so the caller bounds the input.
 */

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

const encoder = new TextEncoder();

export interface ArchiveEntry {
  bytes: Uint8Array;
  path: string;
}

/** ustar keeps a path in `name` (100 bytes), or split at a `/` into `prefix` (155) and `name`. */
const splitPath = (path: string) => {
  if (encoder.encode(path).byteLength <= NAME_MAX) {
    return { name: path, prefix: "" };
  }
  for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) {
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (
      encoder.encode(prefix).byteLength <= PREFIX_MAX &&
      encoder.encode(name).byteLength <= NAME_MAX
    ) {
      return { name, prefix };
    }
  }
  throw new ORPCError("BAD_REQUEST", { message: `"${path}" is too long for a source archive.` });
};

/** An octal number in `width` bytes: digits, then a NUL. */
const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

const header = (entry: ArchiveEntry, mtime: number): Uint8Array => {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, value: string) => block.set(encoder.encode(value), offset);
  const { name, prefix } = splitPath(entry.path);
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(entry.bytes.byteLength, 12));
  put(136, octal(mtime, 12));
  // The checksum is summed with its own field read as spaces.
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  put(345, prefix);
  const checksum = block.reduce((acc, byte) => acc + byte, 0);
  put(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;

/** The tar of `entries`, gzipped. Every file is dated `mtime` (seconds). */
export const sourceArchive = async (
  entries: readonly ArchiveEntry[],
  mtime = Math.floor(Date.now() / 1000),
): Promise<Uint8Array<ArrayBuffer>> => {
  const size = entries.reduce((acc, e) => acc + BLOCK + padded(e.bytes.byteLength), 2 * BLOCK);
  const tar = new Uint8Array(size);
  let offset = 0;
  for (const entry of entries) {
    tar.set(header(entry, mtime), offset);
    tar.set(entry.bytes, offset + BLOCK);
    offset += BLOCK + padded(entry.bytes.byteLength);
  }
  const gzipped = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gzipped).arrayBuffer());
};
