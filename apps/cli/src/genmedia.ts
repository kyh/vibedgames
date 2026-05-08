#!/usr/bin/env node
/**
 * Drop-in shim for fal's `genmedia` CLI: forwards every invocation to
 * `vg media`. Skills written for fal-ai-community/genmedia-cli (which
 * shell out to `genmedia run …`) work transparently against the
 * vibedgames proxy after `npm install -g vibedgames`.
 *
 * This intentionally execs the local `vg` entrypoint rather than calling
 * citty in-process — it keeps argv handling identical (especially the
 * trailing arbitrary `--<param> value` pairs that `vg media run` parses
 * off process.argv) without re-implementing the whole command tree.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `.pathname`: on Windows `URL.pathname` returns
// `/C:/...` (with a leading slash) and on any platform it leaves
// `%20`-encoded spaces, both of which break spawn().
const vgEntry = fileURLToPath(new URL("./index.js", import.meta.url));
const argv = process.argv.slice(2);

const child = spawn(process.execPath, [vgEntry, "media", ...argv], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
