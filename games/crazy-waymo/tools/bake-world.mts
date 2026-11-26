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
import { chromium } from "playwright-core";
import type { Readable } from "node:stream";

const root = path.resolve(import.meta.dirname, "..");
const worldDir = path.join(root, "public/world");

const src = readFileSync(path.join(root, "src/world/world-bin.ts"), "utf-8");
const revMatch = /WORLD_REV = (?<rev>\d+)/u.exec(src);

if (!revMatch?.groups) {
  throw new Error("WORLD_REV not found in src/world/world-bin.ts");
}

const codeRev = Number(revMatch.groups.rev);

const shippedRev = () => {
  const binPath = path.join(worldDir, "world.bin");

  if (!existsSync(binPath)) {
    return null;
  }

  try {
    const bytes = gunzipSync(readFileSync(binPath));
    const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));

    return header.tree?.rev ?? null;
  } catch {
    return null;
  }
};

const unpackContainer = (bytes: Buffer) => {
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));
  const offsets: number[] = [];
  let cursor = 4 + headerLen;

  for (const b of header.buffers) {
    cursor = Math.ceil(cursor / 4) * 4;
    offsets.push(cursor);
    cursor += b.length;
  }

  return header.tree.files.map((f: { data: { $buf: any }; name: any }) => {
    const i = f.data.$buf;

    return {
      data: bytes.subarray(offsets[i], offsets[i] + header.buffers[i].length),
      name: f.name,
    };
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
  server = spawn("pnpm", ["dev"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // oxlint-disable-next-line promise/avoid-new -- wraps vite's stdout/exit events, which have no promise form
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("vite did not report a port in 60s"));
    }, 60_000);

    server.stdout.on("data", (chunk: any) => {
      const m = /localhost:(?<port>\d+)/u.exec(String(chunk));

      if (m?.groups) {
        clearTimeout(timer);
        resolve(Number(m.groups.port));
      }
    });
    server.on("exit", () => {
      reject(new Error("vite exited before reporting a port"));
    });
  });
}

console.log(`[bake] dev server on :${port}`);

const dl = mkdtempSync(path.join(tmpdir(), "waymo-bake-"));
let failed = false;

const browser = await chromium.launch(
  process.env.BAKE_BROWSER !== undefined && process.env.BAKE_BROWSER !== ""
    ? { executablePath: process.env.BAKE_BROWSER, headless: false }
    : { channel: "chrome", headless: false },
);

let heartbeat;

try {
  const page = await browser.newPage({ acceptDownloads: true });

  const { promise, resolve: _resolve, reject } = Promise.withResolvers<void>();
  page.on("pageerror", (error) => {
    reject(new Error(`world page: ${error.message}`));
  });
  page.on("crash", () => {
    reject(new Error("world page crashed"));
  });

  const pageFailed = promise;

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

  const { promise: promise2, resolve: _resolve, reject } = Promise.withResolvers<void>();
  page.on("console", (msg) => {
    const t = msg.text();

    if (t.startsWith("[city] rest capture skipped")) {
      reject(
        new Error(
          `${t} — the city could not serialize every batch item, so no rest.bin ` +
            `exists to bake. See the "[city] untagged batch items" / "untagged ` +
            `texture" line above for which material.`,
        ),
      );
    }
  });

  const restSkipped = promise2;

  const { promise: promise3, resolve, reject } = Promise.withResolvers<void>();
  page.on("download", async (d) => {
    const name = d.suggestedFilename();
    const target = path.join(dl, name);
    console.log(`[bake] downloading ${name}…`);

    if (name === "world-bake.bin") {
      try {
        await d.saveAs(target);
        resolve(target);
      } catch (error) {
        reject(error);
      }
    }
  });

  const gotContainer = promise3;

  await page.goto(`http://localhost:${port}/?bake=1&offline=1`, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  let lastProgress = "";
  heartbeat = setInterval(async () => {
    try {
      const status = await page.evaluate(() => document.body.textContent.trim().slice(0, 320));

      if (status && status !== lastProgress) {
        lastProgress = status;
        console.log(`[bake] ${status.replaceAll(/\s+/gu, " ")}`);
      }

      return true;
    } catch {
      return false;
    }
  }, 15_000);
  console.log("[bake] generating world (cold build — takes ~30-60s)…");

  const container = await Promise.race([
    gotContainer,
    restSkipped,
    pageFailed,
    // oxlint-disable-next-line promise/avoid-new -- a timeout arm for Promise.race has no promise form
    new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error("bake download did not arrive in 30 minutes"));
      }, 1_800_000);
    }),
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
  console.error(`[bake] FAILED: ${error instanceof Error ? error.message : error}`);
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
