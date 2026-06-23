import consola from "consola";

import { claudeBin, findRepoRoot } from "./config.js";
import { runClaude } from "./claude.js";
import { buildTask, roleForPhase, ROLES } from "./roles.js";
import {
  acquireLock,
  appendJournal,
  blackboard,
  clearStop,
  initWorkspace,
  releaseLock,
  saveState,
  stopRequested,
  type Phase,
  type StudioState,
} from "./state.js";

export type StudioOptions = {
  slug: string;
  idea: string;
  workspace: string;
  model: string;
  maxTurns: number;
  /** Kill a specialist that emits no output for this long (ms; 0 disables). */
  idleTimeoutMs: number;
  /** 0 = run forever (until stopped). */
  maxCycles: number;
  /** ms to pause between specialist runs. */
  interval: number;
  /** Skip the ship phase (no prod deploys — useful while testing the loop). */
  noShip: boolean;
  /** Pass --dangerously-skip-permissions so tools run unattended. */
  skipPermissions: boolean;
};

const MAX_RETRIES = 5;

/** Resolves true if the studio ran, false if it couldn't start (lock held). */
export async function runStudio(opts: StudioOptions): Promise<boolean> {
  const repoRoot = findRepoRoot();
  const bb = blackboard(opts.workspace);
  const now = new Date().toISOString();

  const seed: StudioState = {
    slug: opts.slug,
    idea: opts.idea,
    model: opts.model,
    phase: "spec",
    cycle: 0,
    iteration: 0,
    shipped: false,
    deployUrl: null,
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
  };
  // One studio per workspace: refuse to start a second process on the same
  // game, which would let two loops fight over the same files (and let an
  // impatient `start` wipe a still-running process's pending STOP).
  const owner = acquireLock(bb);
  if (owner !== null) {
    const who = owner > 0 ? `pid ${owner}` : "another process";
    consola.error(
      `A studio is already running for "${opts.slug}" (${who}). Stop it first with \`vg-studio stop ${opts.slug}\`, or wait for it to finish.`,
    );
    return false;
  }
  process.on("exit", () => releaseLock(bb));

  // We now hold the lock, so any STOP sentinel is necessarily stale (left by a
  // previous run that has since exited) — safe to clear before we loop.
  clearStop(bb);

  let state = initWorkspace(bb, seed);
  // The persisted slug is authoritative for an existing workspace (R2 keys and
  // the deploy URL are tied to it). Warn rather than silently honor a different
  // CLI slug aimed at the same blackboard (only possible via --workspace).
  if (state.slug !== opts.slug) {
    consola.warn(
      `Workspace already belongs to "${state.slug}"; ignoring the "${opts.slug}" slug for this run.`,
    );
  }
  // Re-seed mutable knobs on restart so flags take effect.
  state.idea = opts.idea || state.idea;
  state.model = opts.model;
  saveState(bb, state);

  banner(opts, state, repoRoot);

  let stopping = false;
  const abort = new AbortController();
  const onSignal = () => {
    if (!stopping) {
      stopping = true;
      consola.warn(
        "\nStop requested — finishing the current step. Press Ctrl-C again to force quit.",
      );
    } else {
      consola.warn("Force quitting.");
      abort.abort();
      process.exit(130);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // A sleep that wakes early if a stop is requested (Ctrl-C or STOP sentinel),
  // so backoff/interval waits never delay shutdown.
  const sleepUnlessStopping = async (ms: number): Promise<void> => {
    const step = 250;
    for (let waited = 0; waited < ms; waited += step) {
      if (stopping || stopRequested(bb)) return;
      await sleep(Math.min(step, ms - waited));
    }
  };

  let failures = 0;

  // `stopping` is flipped by the SIGINT/SIGTERM handler above (and we also
  // honor the STOP sentinel inside the loop) — oxlint can't see the async
  // mutation, so silence its unmodified-condition heuristic.
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (!stopping) {
    if (stopRequested(bb)) {
      consola.warn("STOP sentinel found in .studio/ — halting.");
      break;
    }
    if (opts.maxCycles > 0 && state.cycle >= opts.maxCycles) {
      consola.info(`Reached --max-cycles=${opts.maxCycles}. Stopping.`);
      break;
    }

    // Optionally skip shipping (no prod deploy) while testing.
    if (state.phase === "ship" && opts.noShip) {
      consola.info("--skip-ship set; skipping the ship phase.");
      advance(state);
      saveState(bb, state);
      continue;
    }

    const phase = state.phase;
    const role = ROLES[roleForPhase(phase, bb)];
    const task = buildTask(phase, state, bb);

    consola.log("");
    consola.start(
      `${role.emoji} ${role.name} — phase "${phase}" · cycle ${state.cycle + 1}${
        state.shipped ? ` · iteration ${state.iteration + 1}` : ""
      }`,
    );

    const res = await runClaude({
      prompt: task,
      systemPrompt: role.system,
      cwd: opts.workspace,
      model: state.model,
      maxTurns: opts.maxTurns,
      idleTimeoutMs: opts.idleTimeoutMs,
      claudeBin: claudeBin(),
      addDirs: [repoRoot],
      skipPermissions: opts.skipPermissions,
      signal: abort.signal,
      label: role.name,
    });

    state.cycle += 1;
    if (typeof res.costUsd === "number") state.totalCostUsd += res.costUsd;
    saveState(bb, state);

    if (!res.ok) {
      failures += 1;
      appendJournal(
        bb,
        `${role.name} (${phase}) FAILED: ${truncate(res.error ?? "unknown error")}`,
      );
      consola.error(`${role.name} failed: ${res.error ?? "unknown error"}`);
      if (failures >= MAX_RETRIES) {
        consola.warn(
          `${MAX_RETRIES} consecutive failures on "${phase}" — skipping ahead to avoid a stuck loop.`,
        );
        advance(state);
        saveState(bb, state);
        failures = 0;
      } else {
        const backoff = Math.min(2 ** failures, 60);
        consola.info(
          `Retrying "${phase}" in ${backoff}s (attempt ${failures + 1}/${MAX_RETRIES}).`,
        );
        await sleepUnlessStopping(backoff * 1000);
      }
      continue;
    }

    failures = 0;
    appendJournal(
      bb,
      `${role.name} (${phase}) done${costNote(res.costUsd)}: ${truncate(res.result)}`,
    );
    consola.success(`${role.name} done${costNote(res.costUsd)} · ${res.numTurns ?? "?"} turns`);

    // Only a real, successful ship marks the game deployed.
    if (phase === "ship") recordShip(state);
    advance(state);
    saveState(bb, state);

    if (opts.interval > 0 && !stopping) await sleepUnlessStopping(opts.interval);
  }

  saveState(bb, state);
  releaseLock(bb);
  consola.box(
    [
      `Studio stopped for "${state.slug}".`,
      `Cycles run: ${state.cycle} · iterations: ${state.iteration}`,
      state.deployUrl ? `Live: ${state.deployUrl}` : "Not yet shipped.",
      `Approx spend: $${state.totalCostUsd.toFixed(2)}`,
      `Resume anytime: vg-studio start ${state.slug}`,
    ].join("\n"),
  );
  return true;
}

/**
 * Pure phase transition: bootstrap once, then loop the polish cycle forever.
 * Deliberately has NO side effects on shipped/deployUrl/iteration — those only
 * happen on a *successful* ship (see recordShip), never when the ship phase is
 * skipped (--no-ship) or abandoned after repeated failures.
 */
function advance(state: StudioState): void {
  const transitions: Record<Phase, Phase> = {
    spec: "scaffold",
    scaffold: "assets",
    assets: "build",
    build: "playtest",
    playtest: "ship",
    ship: "plan",
    plan: "work",
    work: "playtest",
  };
  state.phase = transitions[state.phase];
}

/**
 * Record a confirmed deploy. Called only after the shipper actually succeeds,
 * so state.json / status never claim a shipped game or live URL that wasn't
 * deployed. The first success flips `shipped`; each later success counts a
 * completed polish iteration.
 */
function recordShip(state: StudioState): void {
  if (state.shipped) {
    state.iteration += 1;
  } else {
    state.shipped = true;
    state.deployUrl = `https://${state.slug}.vibedgames.com`;
  }
}

function banner(opts: StudioOptions, state: StudioState, repoRoot: string): void {
  consola.box(
    [
      `🎮 vibedgames autonomous studio`,
      ``,
      `Game:      ${state.slug}`,
      `Idea:      ${state.idea}`,
      `Model:     ${state.model}`,
      `Workspace: ${opts.workspace}`,
      `Repo:      ${repoRoot}`,
      `Mode:      ${opts.skipPermissions ? "unattended (tools auto-approved)" : "guarded (will block on approvals!)"}`,
      opts.noShip
        ? `Shipping:  disabled (--skip-ship)`
        : `Shipping:  vg deploy → ${state.slug}.vibedgames.com`,
      opts.maxCycles > 0
        ? `Stops at:  ${opts.maxCycles} cycles`
        : `Runs:      until you stop it (Ctrl-C or \`vg-studio stop ${state.slug}\`)`,
    ].join("\n"),
  );
  if (opts.skipPermissions) {
    consola.warn(
      "Running with --dangerously-skip-permissions: agents run shell/file tools, `vg generate`, and `vg deploy` WITHOUT asking. These cost money and deploy to production. Stop with Ctrl-C.",
    );
  }
}

const truncate = (s: string, n = 240): string => {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

const costNote = (c?: number): string => (typeof c === "number" ? ` ($${c.toFixed(2)})` : "");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
