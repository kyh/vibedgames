import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright-core";
import type { Download } from "playwright-core";
import { z } from "zod";

const root = path.resolve(import.meta.dirname, "..");
const worldDir = path.join(root, "public/world");

const src = readFileSync(path.join(root, "src/world/world-bin.ts"), "utf-8");
const revMatch = /WORLD_REV = (?<rev>\d+)/u.exec(src);

if (!revMatch?.groups) {
  throw new Error("WORLD_REV not found in src/world/world-bin.ts");
}

const codeRev = Number(revMatch.groups.rev);

const readHeader = (bytes: Uint8Array) => {
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);

  return {
    header: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen))),
    headerLen,
  };
};

const shippedHeaderSchema = z.object({
  tree: z.object({ rev: z.number().optional() }).optional(),
});

const containerHeaderSchema = z.object({
  buffers: z.array(z.object({ length: z.number() })),
  tree: z.object({
    files: z.array(z.object({ data: z.object({ $buf: z.number() }), name: z.string() })),
  }),
});

const deadline = async () => {
  await sleep(1_800_000);

  throw new Error("bake download did not arrive in 30 minutes");
};

const shippedRev = () => {
  const binPath = path.join(worldDir, "world.bin");

  if (!existsSync(binPath)) {
    return null;
  }

  try {
    const { header } = readHeader(gunzipSync(readFileSync(binPath)));

    return shippedHeaderSchema.parse(header).tree?.rev ?? null;
  } catch {
    return null;
  }
};

const unpackContainer = (bytes: Buffer) => {
  const read = readHeader(bytes);
  const header = containerHeaderSchema.parse(read.header);
  const { headerLen } = read;
  const offsets: number[] = [];
  let cursor = 4 + headerLen;

  for (const b of header.buffers) {
    cursor = Math.ceil(cursor / 4) * 4;
    offsets.push(cursor);
    cursor += b.length;
  }

  return header.tree.files.map((f) => {
    const i = f.data.$buf;
    const offset = offsets[i];
    const buffer = header.buffers[i];

    if (offset === undefined || buffer === undefined) {
      throw new Error(`${f.name} names missing buffer ${i}`);
    }

    return { data: bytes.subarray(offset, offset + buffer.length), name: f.name };
  });
};

const shipped = shippedRev();

if (shipped === codeRev) {
  console.error(
    `public/world already holds rev ${shipped} and WORLD_REV is still ${codeRev}.\n` +
      `Bump WORLD_REV in src/world/world-bin.ts first — a same-rev rebake either\n` +
      `forgot the bump (the baked world silently stays stale for players with the\n` +
      `old bins) or changed nothing.`,
  );
  process.exit(1);
}

console.log(`[bake] code rev ${codeRev}, shipped rev ${shipped ?? "none"} — proceeding`);

const argPort =
  process.argv
    .slice(2)
    .map(Number)
    .find((n) => Number.isFinite(n) && n > 0) ?? null;

let server: ChildProcessByStdio<null, Readable, Readable> | null = null;
let port = argPort;

if (port === null || port === 0) {
  console.log("[bake] starting vite dev server…");

  const vite = spawn("pnpm", ["dev"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  server = vite;
  const reported = Promise.withResolvers<number>();

  const timer = setTimeout(() => {
    reported.reject(new Error("vite did not report a port in 60s"));
  }, 60_000);

  vite.stdout.on("data", (chunk: Buffer) => {
    const m = /localhost:(?<port>\d+)/u.exec(String(chunk));

    if (m?.groups) {
      clearTimeout(timer);
      reported.resolve(Number(m.groups.port));
    }
  });
  vite.on("exit", () => {
    reported.reject(new Error("vite exited before reporting a port"));
  });
  port = await reported.promise;
}

console.log(`[bake] dev server on :${port}`);

const dl = mkdtempSync(path.join(tmpdir(), "waymo-bake-"));
let failed = false;

const browser = await chromium.launch(
  process.env.BAKE_BROWSER !== undefined && process.env.BAKE_BROWSER !== ""
    ? { executablePath: process.env.BAKE_BROWSER, headless: false }
    : { channel: "chrome", headless: false },
);

let heartbeat: ReturnType<typeof setInterval> | undefined;

try {
  const page = await browser.newPage({ acceptDownloads: true });

  const pageFailed = Promise.withResolvers<never>();
  page.on("pageerror", (error) => {
    pageFailed.reject(new Error(`world page: ${error.message}`));
  });
  page.on("crash", () => {
    pageFailed.reject(new Error("world page crashed"));
  });

  page.on("console", (msg) => {
    const t = msg.text();

    if (
      t.startsWith("[bake]") ||
      t.startsWith("[world-bin]") ||
      t.startsWith("[gen-worker]") ||
      t.startsWith("[city]") ||
      msg.type() === "error"
    ) {
      console.log(`  page: ${t}`);
    }
  });

  const restSkipped = Promise.withResolvers<never>();
  page.on("console", (msg) => {
    const t = msg.text();

    if (t.startsWith("[city] rest capture skipped")) {
      restSkipped.reject(
        new Error(
          `${t} — the city could not serialize every batch item, so no rest.bin ` +
            `exists to bake. See the "[city] untagged batch items" / "untagged ` +
            `texture" line above for which material.`,
        ),
      );
    }
  });

  const gotContainer = Promise.withResolvers<string>();

  const save = async (d: Download) => {
    const name = d.suggestedFilename();
    const target = path.join(dl, name);
    console.log(`[bake] downloading ${name}…`);

    if (name === "world-bake.bin") {
      try {
        await d.saveAs(target);
        gotContainer.resolve(target);
      } catch (error) {
        gotContainer.reject(error);
      }
    }
  };

  page.on("download", (d) => {
    void save(d);
  });

  await page.goto(`http://localhost:${port}/?bake=1&offline=1`, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  let lastProgress = "";

  const beat = async () => {
    try {
      const status = await page.evaluate(() => document.body.textContent.trim().slice(0, 320));

      if (status !== "" && status !== lastProgress) {
        lastProgress = status;
        console.log(`[bake] ${status.replaceAll(/\s+/gu, " ")}`);
      }
    } catch {
      lastProgress = "";
    }
  };

  heartbeat = setInterval(() => {
    void beat();
  }, 15_000);
  console.log("[bake] generating world (cold build — takes ~30-60s)…");

  const container = await Promise.race([
    gotContainer.promise,
    restSkipped.promise,
    pageFailed.promise,
    deadline(),
  ]);

  const files = unpackContainer(readFileSync(container));
  console.log(`[bake] container holds ${files.length} artifacts`);

  for (const name of readdirSync(worldDir)) {
    if (/^(?:world\.bin|meta\.bin|rest\.bin(?:\.\d+)?|rest\.parts|tiles)$/u.test(name)) {
      rmSync(path.join(worldDir, name), { force: true, recursive: true });
    }
  }

  const PLATFORM_FILE_CAP = 9.5 * 1024 * 1024;

  for (const { name, data } of files) {
    if (data.byteLength > PLATFORM_FILE_CAP) {
      throw new Error(`${name} is ${data.byteLength} bytes — over the platform's 10 MB file cap`);
    }

    const target = path.join(worldDir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }

  const finalRev = shippedRev();

  if (finalRev !== codeRev) {
    throw new Error(`installed bins report rev ${finalRev}, expected ${codeRev}`);
  }

  console.log(`[bake] installed rev ${codeRev} into public/world/ — commit the bins`);
} catch (error) {
  failed = true;
  console.error(`[bake] FAILED: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  clearInterval(heartbeat);
  await browser.close();

  if (server !== null && server.pid !== undefined && server.pid !== 0) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill();
    }
  }

  rmSync(dl, { force: true, recursive: true });
}

process.exit(failed ? 1 : 0);
