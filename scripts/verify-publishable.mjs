// Packs every publishable workspace package exactly as npm would, installs the
// tarball into a scratch project, and imports each of its export entries under
// plain Node ESM.
//
// This exists because nothing else in the repo ever touches a package's `dist`:
// `exports` points at source and the games resolve `workspace:^` straight to it,
// so a published artifact can be completely broken while every build, typecheck
// and game stays green. Both published packages shipped a `dist` that threw
// ERR_MODULE_NOT_FOUND on import — tsc with `moduleResolution: "bundler"` emits
// extensionless relative specifiers, which Node ESM rejects — and no amount of
// local green caught it. Only the tarball tells the truth.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packagesDir = join(root, "packages");

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Packages with `private: false` are the ones that reach npm. */
const publishable = readdirSync(packagesDir)
  .map((name) => join(packagesDir, name))
  .flatMap((dir) => {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      return [];
    }
    return pkg.private === false ? [{ dir, pkg }] : [];
  });

if (publishable.length === 0) {
  console.error("no publishable packages found — did the layout change?");
  process.exit(1);
}

/**
 * The entry specifiers a consumer can actually import, taken from the exports
 * map that ships. `publishConfig.exports` is what pnpm swaps in at publish time,
 * so that — not the source-pointing `exports` — is what we must verify.
 */
const entriesOf = (pkg) => {
  const exports = pkg.publishConfig?.exports ?? pkg.exports ?? { ".": "." };
  return Object.keys(exports).map((key) =>
    key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`,
  );
};

let failed = false;

for (const { dir, pkg } of publishable) {
  const scratch = mkdtempSync(join(tmpdir(), "verify-publishable-"));
  try {
    // Build fresh, then pack through pnpm so publishConfig rewriting is applied
    // — the same transformation `pnpm publish` performs.
    run("pnpm", ["build"], dir);
    const packed = run("pnpm", ["pack", "--pack-destination", scratch], dir)
      .trim()
      .split("\n")
      .pop();

    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({ name: "scratch", private: true, type: "module" }),
    );
    run("npm", ["install", "--no-audit", "--no-fund", "--silent", packed], scratch);

    for (const entry of entriesOf(pkg)) {
      const probe = join(scratch, "probe.mjs");
      writeFileSync(probe, `await import(${JSON.stringify(entry)});\n`);
      try {
        run("node", [probe], scratch);
        console.log(`ok   ${entry}`);
      } catch (error) {
        // A peer dep the consumer must supply (phaser, react) is not our bug;
        // an unresolvable *internal* specifier is exactly what we are hunting.
        const stderr = String(error.stderr ?? "");
        const missing = /Cannot find (?:module|package) '([^']+)'/.exec(stderr)?.[1] ?? "";
        const isOurs = missing.includes("/dist/") || missing.startsWith(".");
        const peer = Object.keys(pkg.peerDependencies ?? {});
        if (!isOurs && peer.some((p) => missing === p || missing.startsWith(`${p}/`))) {
          console.log(`ok   ${entry}  (unresolved peer '${missing}' — consumer supplies it)`);
          continue;
        }
        failed = true;
        console.error(`FAIL ${entry}`);
        console.error(
          `     ${stderr.split("\n").find((l) => l.includes("Error")) ?? stderr.trim()}`,
        );
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (failed) {
  console.error("\nA published entry does not import under Node ESM.");
  console.error("Usually: a relative import is missing its .js extension.");
  process.exit(1);
}
console.log("\nall publishable entries import cleanly");
