import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// runScript resolves exactly once via a `done`-guarded finish() helper;
// oxlint's static check can't see the guard (same pattern as claude.ts).
/* oxlint-disable promise/no-multiple-resolved */

/**
 * The harness-enforced quality gate. Subagents are TOLD to verify their work,
 * but a forever-loop can't run on claims — after engineering phases the
 * orchestrator itself runs the workspace's typecheck + build scripts and
 * refuses to advance on red. Deterministic, no LLM in the loop.
 */

const STEP_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 4_000;

export type GateResult = {
  ok: boolean;
  /** True when the workspace has no scripts to run (nothing to enforce). */
  skipped: boolean;
  /** "typecheck ✓ build ✓" style note, or the failing step's output tail. */
  detail: string;
};

function readScripts(workspace: string): Record<string, unknown> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(workspace, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function runScript(workspace: string, script: string): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("npm", ["run", script, "--silent"], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    });
    let out = "";
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ ok, tail: out.slice(-OUTPUT_TAIL) });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      out += `\n(timed out after ${STEP_TIMEOUT_MS / 60_000}m)`;
      finish(false);
    }, STEP_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (d: Buffer) => {
      out = (out + d.toString()).slice(-OUTPUT_TAIL * 2);
    });
    child.stderr?.on("data", (d: Buffer) => {
      out = (out + d.toString()).slice(-OUTPUT_TAIL * 2);
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/** Run the workspace's typecheck + build (whichever exist), in that order. */
export async function runGate(workspace: string): Promise<GateResult> {
  if (!existsSync(resolve(workspace, "package.json"))) {
    return { ok: true, skipped: true, detail: "no package.json yet" };
  }
  const scripts = readScripts(workspace);
  const steps = ["typecheck", "build"].filter((s) => typeof scripts[s] === "string");
  if (steps.length === 0) {
    return { ok: true, skipped: true, detail: "no typecheck/build scripts" };
  }
  const passed: string[] = [];
  for (const step of steps) {
    const res = await runScript(workspace, step);
    if (!res.ok) {
      return {
        ok: false,
        skipped: false,
        detail: `\`npm run ${step}\` failed:\n${res.tail.trim() || "(no output)"}`,
      };
    }
    passed.push(`${step} ✓`);
  }
  return { ok: true, skipped: false, detail: passed.join(" · ") };
}
