// Headless world bake: replaces the manual flow (?bake=1 in a browser,
// download, unpack into public/world/) that was run 3× in one day, each ~4
// minutes of babysitting with two footguns — forgetting the WORLD_REV bump
// (stale same-rev bins keep loading, so you "verify" the old world) and
// forgetting the file move. The page downloads ONE container
// (world-bake.bin, see src/world/bake-download.ts); this unpacks it into
// world.bin, meta.bin and tiles/*.bin.
//
//   pnpm bake:world           # starts its own vite dev server
//   pnpm bake:world -- 5193   # attach to an already-running dev server port
//
// Refuses to run while public/world/ already holds bins at the CURRENT rev:
// a rebake without a rev bump means either the bump was forgotten (bug) or
// nothing changed (pointless).
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
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worldDir = path.join(root, "public/world");

// --- Rev guard: parse WORLD_REV from source, compare with the shipped bins.
const src = readFileSync(path.join(root, "src/world/world-bin.ts"), "utf8");
const revMatch = src.match(/WORLD_REV = (\d+)/);
if (!revMatch) throw new Error("WORLD_REV not found in src/world/world-bin.ts");
const codeRev = Number(revMatch[1]);

function shippedRev() {
  const binPath = path.join(worldDir, "world.bin");
  if (!existsSync(binPath)) return null;
  try {
    const bytes = gunzipSync(readFileSync(binPath));
    const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));
    // serializeWorldBin wraps the payload: { tree: { rev, ... }, buffers }.
    return header.tree?.rev ?? null;
  } catch {
    return null;
  }
}

// The container mirrors world-bin.ts: [u32 headerLen][JSON header][buffers…],
// header = { tree: { rev, files: [{ name, data: { $buf } }] }, buffers: [{ type, length }] }.
function unpackContainer(bytes) {
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)));
  const offsets = [];
  let cursor = 4 + headerLen;
  for (const b of header.buffers) {
    cursor = (cursor + 3) & ~3;
    offsets.push(cursor);
    cursor += b.length; // every buffer here is a Uint8Array
  }
  return header.tree.files.map((f) => {
    const i = f.data.$buf;
    return {
      name: f.name,
      data: bytes.subarray(offsets[i], offsets[i] + header.buffers[i].length),
    };
  });
}

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

// --- Dev server: attach to a given port or start our own.
// pnpm forwards a literal "--" before user args — take the first numeric arg.
const argPort =
  process.argv
    .slice(2)
    .map(Number)
    .find((n) => Number.isFinite(n) && n > 0) ?? null;
let server = null;
let port = argPort;
if (!port) {
  console.log("[bake] starting vite dev server…");
  // detached → own process group, so the kill below reaps the vite grandchild
  // (SIGTERM on the pnpm wrapper alone leaves vite holding the port).
  server = spawn("pnpm", ["dev"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vite did not report a port in 60s")), 60000);
    server.stdout.on("data", (chunk) => {
      const m = String(chunk).match(/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    server.on("exit", () => reject(new Error("vite exited before reporting a port")));
  });
}
console.log(`[bake] dev server on :${port}`);

const dl = mkdtempSync(path.join(tmpdir(), "waymo-bake-"));
let failed = false;
// HEADED on purpose: headless tabs rAF-throttle (~4fps), and the world has
// grown (real-footprint prisms, piers, freeways) past what that budget bakes
// inside the 30-minute cap. A headed window bakes in a few minutes.
// BAKE_BROWSER points the same headed launch at another binary for machines
// without branded Chrome (a remote container: run under `xvfb-run -a` with
// BAKE_BROWSER=/opt/pw-browsers/chromium-*/chrome-linux/chrome).
const browser = await chromium.launch(
  process.env.BAKE_BROWSER
    ? { headless: false, executablePath: process.env.BAKE_BROWSER }
    : { headless: false, channel: "chrome" },
);
let heartbeat;
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const pageFailed = new Promise((_, reject) => {
    page.on("pageerror", (error) => reject(new Error(`world page: ${error.message}`)));
    page.on("crash", () => reject(new Error("world page crashed")));
  });
  page.on("console", (msg) => {
    const t = msg.text();
    // [city] is in the filter because the ONE way this bake fails silently is a
    // skipped rest capture: an untagged batch item or an untagged texture clears
    // restComplete, `city.restCapture` stays null, no rest.bin is ever packed
    // and the driver simply waits out its 30-minute cap with world.bin in hand.
    // The reason is printed on a [city] line, so print [city] lines.
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

  // Fail FAST on a skipped rest capture instead of waiting out the cap: without
  // a rest capture the page can never produce rest.bin, so there is nothing to
  // wait for. The message names the pass to fix.
  const restSkipped = new Promise((_, reject) => {
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
  });

  const gotContainer = new Promise((resolve) => {
    page.on("download", (d) => {
      const name = d.suggestedFilename();
      const target = path.join(dl, name);
      console.log(`[bake] downloading ${name}…`);
      if (name === "world-bake.bin") resolve(d.saveAs(target).then(() => target));
    });
  });

  await page.goto(`http://localhost:${port}/?bake=1&offline=1`, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  let lastProgress = "";
  heartbeat = setInterval(() => {
    void page
      .evaluate(() => document.body.innerText.trim().slice(0, 320))
      .then((status) => {
        if (status && status !== lastProgress) {
          lastProgress = status;
          console.log(`[bake] ${status.replace(/\s+/g, " ")}`);
        }
        return null;
      })
      .catch(() => {});
  }, 15_000);
  console.log("[bake] generating world (cold build — takes ~30-60s)…");
  const container = await Promise.race([
    gotContainer,
    restSkipped,
    pageFailed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("bake download did not arrive in 30 minutes")), 1_800_000),
    ),
  ]);
  const files = unpackContainer(readFileSync(container));
  console.log(`[bake] container holds ${files.length} artifacts`);

  // Install: clear every previous artifact (a shrinking world would otherwise
  // leave orphan tiles behind that meta.bin no longer lists), keep the parcel
  // source (a bake INPUT, owned by bake:parcels).
  for (const name of readdirSync(worldDir)) {
    if (/^(world\.bin|meta\.bin|rest\.bin(\.\d+)?|rest\.parts|tiles)$/.test(name)) {
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
  if (finalRev !== codeRev)
    throw new Error(`installed bins report rev ${finalRev}, expected ${codeRev}`);
  console.log(`[bake] installed rev ${codeRev} into public/world/ — commit the bins`);
} catch (err) {
  failed = true;
  console.error(`[bake] FAILED: ${err instanceof Error ? err.message : err}`);
} finally {
  clearInterval(heartbeat);
  await browser.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM"); // whole group (pnpm + vite)
    } catch {
      server.kill();
    }
  }
  rmSync(dl, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
