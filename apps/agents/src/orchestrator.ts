import consola from "consola";

import { claudeBin, findRepoRoot } from "./config.js";
import { runClaude } from "./claude.js";
import { buildTask, roleForPhase, ROLES } from "./roles.js";
import {
  appendJournal,
  blackboard,
  initWorkspace,
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

export async function runStudio(opts: StudioOptions): Promise<void> {
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
  let state = initWorkspace(bb, seed);
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
      consola.info("--no-ship set; skipping the ship phase.");
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
        await sleep(backoff * 1000);
      }
      continue;
    }

    failures = 0;
    appendJournal(
      bb,
      `${role.name} (${phase}) done${costNote(res.costUsd)}: ${truncate(res.result)}`,
    );
    consola.success(`${role.name} done${costNote(res.costUsd)} · ${res.numTurns ?? "?"} turns`);

    advance(state);
    saveState(bb, state);

    if (opts.interval > 0 && !stopping) await sleep(opts.interval);
  }

  saveState(bb, state);
  consola.box(
    [
      `Studio stopped for "${state.slug}".`,
      `Cycles run: ${state.cycle} · iterations: ${state.iteration}`,
      state.deployUrl ? `Live: ${state.deployUrl}` : "Not yet shipped.",
      `Approx spend: $${state.totalCostUsd.toFixed(2)}`,
      `Resume anytime: vg-studio start ${state.slug}`,
    ].join("\n"),
  );
}

/** Phase machine: bootstrap once, then loop the polish cycle forever. */
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

  if (state.phase === "ship") {
    if (!state.shipped) {
      state.shipped = true;
      state.deployUrl = `https://${state.slug}.vibedgames.com`;
    } else {
      state.iteration += 1;
    }
  }
  state.phase = transitions[state.phase];
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
        ? `Shipping:  disabled (--no-ship)`
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
