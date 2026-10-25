import { ORPCError } from "@orpc/server";

/**
 * Reads a deploy bundle: a gzipped tar of a built game, as `tar -czf game.tgz
 * -C dist .` or `vg deploy` writes it. Files reach `onFile` one at a time, so
 * a Worker holds one file, never the whole archive. Understands ustar (with
 * its path prefix), pax `path` records and GNU long names; skips directories,
 * links and macOS `._` resource forks; strips a leading `./`.
 */

const BLOCK = 512;
const MAX_EXTENDED_HEADER = 64 * 1024;
const decoder = new TextDecoder();

export interface BundleFile {
  bytes: Uint8Array<ArrayBuffer>;
  path: string;
}

const bad = (message: string): never => {
  throw new ORPCError("BAD_REQUEST", { message: `Bundle: ${message}` });
};

/** A NUL-terminated string field. */
const field = (block: Uint8Array, offset: number, width: number) => {
  const bytes = block.subarray(offset, offset + width);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
};

const octalField = (block: Uint8Array, offset: number, width: number) => {
  const text = field(block, offset, width).trim();
  const value = text === "" ? 0 : Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : bad("a header has a bad size.");
};

/** The `path` a pax extended header sets, if any: records are `<len> <key>=<value>\n`. */
const paxPath = (data: Uint8Array): string | null => {
  let path: string | null = null;
  for (const record of decoder.decode(data).split("\n")) {
    const match = /^\d+ path=(?<value>.*)$/u.exec(record);
    if (match?.groups?.value !== undefined) {
      path = match.groups.value;
    }
  }
  return path;
};

/** Hands out exactly `size` bytes at a time from a byte stream, or null at its end. */
const byteReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let done = false;
  const take = async (size: number): Promise<Uint8Array<ArrayBuffer> | null> => {
    while (buffer.byteLength < size && !done) {
      const next = await reader.read();
      if (next.done) {
        done = true;
      } else {
        const merged = new Uint8Array(buffer.byteLength + next.value.byteLength);
        merged.set(buffer);
        merged.set(next.value, buffer.byteLength);
        buffer = merged;
      }
    }
    if (buffer.byteLength < size) {
      return null;
    }
    const out = new Uint8Array(buffer.subarray(0, size));
    buffer = buffer.subarray(size);
    return out;
  };
  return { take };
};

interface Header {
  path: string;
  size: number;
  type: string;
}

const parseHeader = (block: Uint8Array, longName: string | null): Header => {
  const prefix = field(block, 345, 155);
  const name = field(block, 0, 100);
  return {
    path: longName ?? (prefix ? `${prefix}/${name}` : name),
    size: octalField(block, 124, 12),
    type: String.fromCodePoint(block[156] ?? 0),
  };
};

const isRegularFile = (type: string) => type === "0" || type === "\0" || type === "7";

/** The path a file deploys at, or null for one a bundle carries by accident. */
const deployPath = (raw: string): string | null => {
  const path = raw.replace(/^(?:\.\/)+/u, "");
  const base = path.split("/").pop() ?? "";
  return path === "" || base.startsWith("._") || path.includes("PaxHeader") ? null : path;
};

const readBlock = async (reader: ReturnType<typeof byteReader>) => {
  try {
    return await reader.take(BLOCK);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      cause: error,
      message: "Bundle: not a valid .tar.gz; make one with `tar -czf game.tgz -C dist .`.",
    });
  }
};

/** Calls `onFile` for each regular file of a gzipped tar, in archive order. */
export const forEachBundleFile = async (
  gzipped: ReadableStream<Uint8Array>,
  { maxFileBytes }: { maxFileBytes: number },
  onFile: (file: BundleFile) => Promise<void>,
): Promise<void> => {
  const reader = byteReader(gzipped.pipeThrough(new DecompressionStream("gzip")));
  const body = async (size: number) =>
    (await reader.take(Math.ceil(size / BLOCK) * BLOCK)) ?? bad("the archive is truncated.");
  let longName: string | null = null;
  for (;;) {
    const block = await readBlock(reader);
    // Two zero blocks end the archive; a stream that simply ends does too.
    if (block === null || block.every((byte) => byte === 0)) {
      return;
    }
    const header = parseHeader(block, longName);
    longName = null;
    if (header.type === "x" || header.type === "L") {
      if (header.size > MAX_EXTENDED_HEADER) {
        bad("an extended header is too large.");
      }
      const padded = await body(header.size);
      const data = padded.subarray(0, header.size);
      longName = header.type === "L" ? field(data, 0, header.size) : paxPath(data);
    } else if (!isRegularFile(header.type)) {
      // Directories, links and global headers carry no file: skip their data.
      await body(header.size);
    } else if (header.size > maxFileBytes) {
      bad(`"${header.path}" is over ${maxFileBytes} bytes; split it into parts.`);
    } else {
      const data = await body(header.size);
      const path = deployPath(header.path);
      if (path !== null) {
        await onFile({ bytes: new Uint8Array(data.subarray(0, header.size)), path });
      }
    }
  }
};
