import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { asJsonObject, isJsonString, parseJson } from "./json.ts";

/**
 * The harness-enforced quality gate. Subagents are TOLD to verify their work,
 * but a forever-loop can't run on claims — after engineering phases the
 * orchestrator itself runs the workspace's typecheck + build scripts and
 * refuses to advance on red. Deterministic, no LLM in the loop.
 */

const STEP_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 4000;

export interface GateResult {
  ok: boolean;
  /** True when the workspace has no scripts to run (nothing to enforce). */
  skipped: boolean;
  /** "typecheck ✓ build ✓" style note, or the failing step's output tail. */
  detail: string;
}

/** Names of package.json scripts whose values are actual command strings. */
const readScriptNames = (workspace: string): Set<string> => {
  let text: string;
  try {
    text = readFileSync(path.resolve(workspace, "package.json"), "utf-8");
  } catch {
    return new Set();
  }
  const pkg = asJsonObject(parseJson(text));
  const scripts = asJsonObject(pkg?.scripts);
  if (!scripts) {
    return new Set();
  }
  return new Set(Object.keys(scripts).filter((name) => isJsonString(scripts[name])));
};

/** Holds a timeout armed after the closure that clears it. */
interface TimeoutCell {
  handle?: ReturnType<typeof setTimeout>;
}

const runScript = (workspace: string, script: string): Promise<{ ok: boolean; tail: string }> =>
  // oxlint-disable-next-line promise/avoid-new -- child_process.spawn is event-based
  new Promise((resolve) => {
    const child = spawn("npm", ["run", script, "--silent"], {
      cwd: workspace,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let done = false;
    const timeout: TimeoutCell = {};
    const finish = (ok: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeout.handle);
      resolve({ ok, tail: out.slice(-OUTPUT_TAIL) });
    };
    timeout.handle = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      out += `\n(timed out after ${STEP_TIMEOUT_MS / 60_000}m)`;
      finish(false);
    }, STEP_TIMEOUT_MS);
    timeout.handle.unref?.();
    child.stdout?.on("data", (d: Buffer) => {
      out = (out + d.toString()).slice(-OUTPUT_TAIL * 2);
    });
    child.stderr?.on("data", (d: Buffer) => {
      out = (out + d.toString()).slice(-OUTPUT_TAIL * 2);
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });

/** Run the workspace's typecheck + build (whichever exist), in that order. */
export const runGate = async (workspace: string): Promise<GateResult> => {
  if (!existsSync(path.resolve(workspace, "package.json"))) {
    return { detail: "no package.json yet", ok: true, skipped: true };
  }
  const scripts = readScriptNames(workspace);
  const steps = ["typecheck", "build"].filter((s) => scripts.has(s));
  if (steps.length === 0) {
    return { detail: "no typecheck/build scripts", ok: true, skipped: true };
  }
  const passed: string[] = [];
  for (const step of steps) {
    const res = await runScript(workspace, step);
    if (!res.ok) {
      return {
        detail: `\`npm run ${step}\` failed:\n${res.tail.trim() || "(no output)"}`,
        ok: false,
        skipped: false,
      };
    }
    passed.push(`${step} ✓`);
  }
  return { detail: passed.join(" · "), ok: true, skipped: false };
};
