// Headless world bake: replaces the 4-step manual flow (?bake=1 in a browser,
// download, move into public/world/, run the split script) that was run 3×
// in one day, each ~4 minutes of babysitting with two footguns — forgetting
// the WORLD_REV bump (stale same-rev bins keep loading, so you "verify" the
// old world) and forgetting the file move.
//
//   pnpm bake:world           # starts its own vite dev server
//   pnpm bake:world -- 5193   # attach to an already-running dev server port
//
// Refuses to run while public/world/ already holds bins at the CURRENT rev:
// a rebake without a rev bump means either the bump was forgotten (bug) or
// nothing changed (pointless).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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
const browser = await chromium.launch({ headless: false, channel: "chrome" });
try {
  const page = await browser.newPage({ acceptDownloads: true });
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
      t.startsWith("[city]")
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

  const downloads = new Map();
  const gotBoth = new Promise((resolve) => {
    page.on("download", (d) => {
      const name = d.suggestedFilename();
      const target = path.join(dl, name);
      downloads.set(
        name,
        d.saveAs(target).then(() => target),
      );
      console.log(`[bake] downloading ${name}…`);
      if (downloads.has("world.bin") && downloads.has("rest.bin")) resolve(null);
    });
  });

  await page.goto(`http://localhost:${port}/?bake=1`, { waitUntil: "domcontentloaded" });
  console.log("[bake] generating world (cold build — takes ~30-60s)…");
  await Promise.race([
    gotBoth,
    restSkipped,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("bake downloads did not arrive in 30 minutes")), 1_800_000),
    ),
  ]);
  const saved = await Promise.all(downloads.values());
  console.log(`[bake] saved ${saved.length} artifacts`);

  // Install + split (split-world-bin reads public/world/{rest,world}.bin).
  // Clear EVERY existing part, not a hardcoded two: the split count tracks the
  // world's size, so a shrinking world would otherwise leave an orphan
  // rest.bin.N behind that rest.parts no longer counts and nothing ever loads.
  for (const name of readdirSync(worldDir)) {
    if (/^(world\.bin|rest\.bin(\.\d+)?|rest\.parts)$/.test(name)) {
      rmSync(path.join(worldDir, name), { force: true });
    }
  }
  for (const target of saved) renameSync(target, path.join(worldDir, path.basename(target)));
  execFileSync("node", [path.join(root, "tools/split-world-bin.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
  const finalRev = shippedRev();
  if (finalRev !== codeRev)
    throw new Error(`installed bins report rev ${finalRev}, expected ${codeRev}`);
  console.log(`[bake] installed rev ${codeRev} into public/world/ — commit the bins`);
} catch (err) {
  failed = true;
  console.error(`[bake] FAILED: ${err instanceof Error ? err.message : err}`);
} finally {
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
