import { ORPCError } from "@orpc/server";

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

const encoder = new TextEncoder();

export interface ArchiveEntry {
  path: string;
  /** The file's bytes, read when the archive reaches it. */
  read: () => Promise<Uint8Array<ArrayBuffer>>;
}

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

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

const header = (path: string, size: number, mtime: number) => {
  const block = new Uint8Array(BLOCK);
  const put = (offset: number, value: string) => block.set(encoder.encode(value), offset);
  const { name, prefix } = splitPath(path);
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(mtime, 12));
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  put(345, prefix);
  const checksum = block.reduce((acc, byte) => acc + byte, 0);
  put(148, `${checksum.toString(8).padStart(6, "0")}\0 `);

  return block;
};

const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/** The tar of `entries`, gzipped. Every file is dated `mtime` (seconds). */
export const sourceArchive = async (
  entries: readonly ArchiveEntry[],
  mtime = Math.floor(Date.now() / 1000),
) => {
  let next = 0;

  const tar = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull: async (controller) => {
      const entry = entries[next];
      next += 1;

      if (!entry) {
        controller.enqueue(new Uint8Array(2 * BLOCK));
        controller.close();

        return;
      }

      const bytes = await entry.read();
      controller.enqueue(header(entry.path, bytes.byteLength, mtime));
      controller.enqueue(bytes);
      controller.enqueue(padding(bytes.byteLength));
    },
  });

  const gzipped = tar.pipeThrough(new CompressionStream("gzip"));

  return new Uint8Array(await new Response(gzipped).arrayBuffer());
};
