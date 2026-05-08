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

const vgEntry = new URL("./index.js", import.meta.url).pathname;
const argv = process.argv.slice(2);

const child = spawn(process.execPath, [vgEntry, "media", ...argv], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
