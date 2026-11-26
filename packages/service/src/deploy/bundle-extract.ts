import { ORPCError } from "@orpc/server";

const BLOCK = 512;
const MAX_EXTENDED_HEADER = 64 * 1024;
const decoder = new TextDecoder();
const END = Symbol("end");

export interface BundleFile {
  bytes: Uint8Array<ArrayBuffer>;
  path: string;
}

const bad = (message: string): never => {
  throw new ORPCError("BAD_REQUEST", { message: `Bundle: ${message}` });
};

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

const paxPath = (data: Uint8Array) => {
  let path: string | null = null;

  for (const record of decoder.decode(data).split("\n")) {
    const match = /^\d+ path=(?<value>.*)$/u.exec(record);

    if (match?.groups?.value !== undefined) {
      path = match.groups.value;
    }
  }

  return path;
};

// WARNING: a recursive frame keeps its locals alive until the recursion unwinds; never hold bytes in one (128 MB Worker limit).
const byteReader = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let buffered = 0;
  let done = false;

  const pull = async () => {
    const next = await reader.read();

    if (next.done) {
      done = true;

      return;
    }

    chunks.push(next.value);
    buffered += next.value.byteLength;
  };

  const fill: (size: number) => Promise<void> = async (size) => {
    if (buffered >= size || done) {
      return;
    }

    await pull();
    await fill(size);
  };

  const consume = (size: number, into: Uint8Array | null) => {
    let used = 0;

    while (used < size) {
      const head = chunks[0] ?? new Uint8Array(0);
      const part = Math.min(size - used, head.byteLength);
      into?.set(head.subarray(0, part), used);
      used += part;

      if (part === head.byteLength) {
        chunks.shift();
      } else {
        chunks[0] = head.subarray(part);
      }
    }

    buffered -= size;
  };

  const skip: (left: number) => Promise<boolean> = async (left) => {
    if (left <= buffered) {
      consume(left, null);

      return true;
    }

    const held = buffered;
    consume(held, null);

    if (done) {
      return false;
    }

    await pull();

    return await skip(left - held);
  };

  const take = async (size: number) => {
    await fill(size);

    if (buffered < size) {
      return null;
    }

    const out = new Uint8Array(size);
    consume(size, out);

    return out;
  };

  return { skip, take };
};

const parseHeader = (block: Uint8Array, longName: string | null) => {
  const prefix = field(block, 345, 155);
  const name = field(block, 0, 100);

  return {
    path: longName ?? (prefix ? `${prefix}/${name}` : name),
    size: octalField(block, 124, 12),
    type: String.fromCodePoint(block[156] ?? 0),
  };
};

const isRegularFile = (type: string) => type === "0" || type === "\0" || type === "7";

const deployPath = (raw: string) => {
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
  gzipped: ReadableStream<Uint8Array<ArrayBuffer>>,
  { maxFileBytes }: { maxFileBytes: number },
  onFile: (file: BundleFile) => Promise<void>,
) => {
  const reader = byteReader(gzipped.pipeThrough(new DecompressionStream("gzip")));

  const body = async (size: number) =>
    (await reader.take(Math.ceil(size / BLOCK) * BLOCK)) ?? bad("the archive is truncated.");

  const step = async (longName: string | null) => {
    const block = await readBlock(reader);

    if (block === null || block.every((byte) => byte === 0)) {
      return END;
    }

    const header = parseHeader(block, longName);

    if (header.type === "x" || header.type === "L") {
      if (header.size > MAX_EXTENDED_HEADER) {
        bad("an extended header is too large.");
      }

      const padded = await body(header.size);
      const data = padded.subarray(0, header.size);

      return { next: header.type === "L" ? field(data, 0, header.size) : paxPath(data) };
    }

    if (!isRegularFile(header.type)) {
      if (!(await reader.skip(Math.ceil(header.size / BLOCK) * BLOCK))) {
        bad("the archive is truncated.");
      }
    } else if (header.size > maxFileBytes) {
      bad(`"${header.path}" is over ${maxFileBytes} bytes; split it into parts.`);
    } else {
      const data = await body(header.size);
      const path = deployPath(header.path);

      if (path !== null) {
        await onFile({ bytes: data.subarray(0, header.size), path });
      }
    }

    return { next: null };
  };

  const entries: (longName: string | null) => Promise<void> = async (longName) => {
    const result = await step(longName);

    if (result !== END) {
      await entries(result.next);
    }
  };

  await entries(null);
};
