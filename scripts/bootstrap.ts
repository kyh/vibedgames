#!/usr/bin/env tsx
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { styleText } from "node:util";

import { repeatWhile } from "@repo/contract/run-in-order";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, ".env.example");
const D1_DIR = path.join(ROOT_DIR, "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const DEV_LOG = path.join(ROOT_DIR, "apps/web/.wrangler/bootstrap-dev.log");
const DEV_URL = "http://localhost:5173";
const DEV_BOOT_BUDGET_MS = 180_000;

const ASSUME_YES = process.argv.includes("--yes") || process.argv.includes("-y");
const INTERACTIVE = process.stdin.isTTY && process.stdout.isTTY && !ASSUME_YES;

const dim = (text: string) => styleText("dim", text);

const ok = (text: string) => {
  console.log(`  ${styleText("green", "✓")} ${text}`);
};

const exec = (command: string) => {
  execSync(command, { cwd: ROOT_DIR, stdio: "inherit" });
};

const localD1Exists = () =>
  fs.existsSync(D1_DIR) && fs.readdirSync(D1_DIR).some((f) => /^[0-9a-f]{64}\.sqlite$/u.test(f));

const confirm = async () => {
  if (!INTERACTIVE) {
    return true;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const answer = await rl.question(
    "  Creates .env if missing, boots the dev Worker once if the local D1 is missing,\n" +
      "  then pushes the schema to and seeds the LOCAL D1. Continue? [Y/n] ",
  );

  rl.close();

  return !/^n/iu.test(answer.trim());
};

const createEnv = () => {
  if (fs.existsSync(ENV_PATH)) {
    ok(".env already exists, keeping it");

    return;
  }

  fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  ok(".env created from .env.example");
};

const devServerAnswers = async () => {
  try {
    const res = await fetch(`${DEV_URL}/auth/login`, { signal: AbortSignal.timeout(2000) });

    return res.status === 200;
  } catch {
    return false;
  }
};

const touchDatabase = async () => {
  try {
    await fetch(`${DEV_URL}/api/auth/sign-in/email-otp`, {
      body: JSON.stringify({ email: "bootstrap@vibedgames.local", otp: "000000" }),
      headers: { "content-type": "application/json", origin: DEV_URL },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => Promise<boolean>, budgetMs: number) => {
  const startedAt = performance.now();
  let passed = false;

  await repeatWhile(async () => {
    if (performance.now() - startedAt >= budgetMs) {
      return false;
    }

    passed = await check();

    if (passed) {
      return false;
    }

    await sleep(500);

    return true;
  });

  return passed;
};

const stopDevServer = async (pid: number) => {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }

  const stopped = await waitFor(async () => !(await devServerAnswers()), 15_000);

  if (!stopped) {
    process.kill(-pid, "SIGKILL");
  }
};

const ensureLocalD1 = async () => {
  if (localD1Exists()) {
    ok("local D1 already initialized");

    return;
  }

  const alreadyRunning = await devServerAnswers();
  let pid: number | undefined;

  if (!alreadyRunning) {
    fs.mkdirSync(path.dirname(DEV_LOG), { recursive: true });
    const log = fs.openSync(DEV_LOG, "w");

    const child = spawn("pnpm", ["-F", "@repo/web", "dev"], {
      cwd: ROOT_DIR,
      detached: true,
      stdio: ["ignore", log, log],
    });

    ({ pid } = child);
    console.log(`  ${dim(`booting the dev Worker once to create the local D1 (log ${DEV_LOG})`)}`);
  }

  try {
    if (!(await waitFor(devServerAnswers, DEV_BOOT_BUDGET_MS))) {
      throw new Error(
        `the dev Worker did not answer at ${DEV_URL} within ${DEV_BOOT_BUDGET_MS / 1000}s; see ${DEV_LOG}`,
      );
    }

    const created = await waitFor(async () => {
      await touchDatabase();

      return localD1Exists();
    }, 30_000);

    if (!created) {
      throw new Error(`the dev Worker answered but created no local D1 under ${D1_DIR}`);
    }

    ok("local D1 initialized");
  } finally {
    if (pid !== undefined) {
      await stopDevServer(pid);
      ok("stopped the dev Worker it booted");
    }
  }
};

const main = async () => {
  console.log("\n  Bootstrapping vibedgames (local only)\n");

  if (!(await confirm())) {
    console.log("  Aborted.\n");

    return;
  }

  createEnv();
  await ensureLocalD1();
  exec("pnpm db:push");
  ok("schema pushed to the local D1");
  exec("pnpm db:seed-local");
  ok(
    "seeded user@vibedgames.com and admin@vibedgames.com (sign in with `pnpm sign-in-code <email>`)",
  );

  console.log(
    `\n  ${styleText("green", "Ready.")} pnpm dev:web, then open ${DEV_URL}/auth/login\n`,
  );
};

const run = async () => {
  try {
    await main();
  } catch (error) {
    console.error(
      `\n  ${styleText("red", "✗ Bootstrap failed:")} ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
};

void run();
