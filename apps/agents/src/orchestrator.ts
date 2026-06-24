import { existsSync, writeFileSync } from "node:fs";

import consola from "consola";

import { claudeBin, findRepoRoot } from "./config.ts";
import { runClaude } from "./claude.ts";
import { buildTask, roleForPhase, ROLES } from "./roles.ts";
import {
  acquireLock,
  appendJournal,
  approvalPending,
  approvalToken,
  blackboard,
  clearStop,
  consumeApproval,
  hasExistingProject,
  initWorkspace,
  releaseLock,
  saveState,
  stopRequested,
  type Phase,
  type StudioState,
} from "./state.ts";

export type StudioOptions = {
  slug: string;
  idea: string;
  workspace: string;
  model: string;
  maxTurns: number;
  /** Kill a specialist that emits no output for this long (ms; 0 disables). */
  idleTimeoutMs: number;
  /** Absolute ceiling on a single specialist session (ms; 0 disables). */
  maxSessionMs: number;
  /** 0 = run forever (until stopped). */
  maxCycles: number;
  /** ms to pause between specialist runs. */
  interval: number;
  /** Skip the ship phase (no prod deploys — useful while testing the loop). */
  noShip: boolean;
  /** Deploy automatically without per-release human approval. */
  autoDeploy: boolean;
  /** Pass --dangerously-skip-permissions so tools run unattended. */
  skipPermissions: boolean;
  /** Optional operator brief written to .studio/context.md for the specialists. */
  context?: string;
  /** Optional reference directory the specialists are granted read access to. */
  contextDir?: string;
};

const MAX_RETRIES = 5;

/** Resolves true if the studio ran, false if it couldn't start (lock held). */
export async function runStudio(opts: StudioOptions): Promise<boolean> {
  const repoRoot = findRepoRoot();
  const bb = blackboard(opts.workspace);
  const now = new Date().toISOString();

  // Detect an existing project to build upon (only meaningful on a fresh start;
  // on resume the flag is already persisted).
  const isFresh = !existsSync(bb.state);
  const existingProject = isFresh && hasExistingProject(opts.workspace);

  const seed: StudioState = {
    slug: opts.slug,
    idea: opts.idea,
    model: opts.model,
    phase: "spec",
    cycle: 0,
    iteration: 0,
    phaseFailures: 0,
    existingProject,
    contextDir: opts.contextDir ?? null,
    built: false,
    lastApproval: null,
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
      `A studio is already running for "${opts.slug}" (${who}). Stop it first with \`pnpm stop ${opts.slug}\`, or wait for it to finish.`,
    );
    return false;
  }
  const onExit = () => releaseLock(bb);
  process.on("exit", onExit);

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
  state.phaseFailures = state.phaseFailures ?? 0; // backfill pre-field workspaces
  // Keep the adopt flag reflecting whether a project is actually present to
  // build upon: it starts true only when the workspace was created on existing
  // files, and clears if those files later go away — so a wiped workspace stops
  // claiming adoption. A fresh game never flips to "adopt" just because
  // scaffolding created files (false stays false).
  state.existingProject = (state.existingProject ?? false) && hasExistingProject(opts.workspace);
  // shipped implies built — force the invariant so an inconsistent persisted
  // `built:false, shipped:true` can't make the ship guard and preemption spin.
  state.built = (state.built ?? false) || state.shipped;
  state.lastApproval = state.lastApproval ?? null;
  // A new --context this run fully replaces the prior brief AND reference dir
  // (so switching to a file/text brief clears a stale reference folder);
  // otherwise keep what's persisted so a plain resume retains them.
  if (opts.context !== undefined) {
    writeFileSync(bb.context, `${opts.context.trim()}\n`);
    state.contextDir = opts.contextDir ?? null;
  } else {
    state.contextDir = state.contextDir ?? null;
  }
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

  // `stopping` is flipped by the SIGINT/SIGTERM handler above (and we also
  // honor the STOP sentinel inside the loop) — oxlint can't see the async
  // mutation, so silence its unmodified-condition heuristic.
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (!stopping) {
    if (stopRequested(bb)) {
      consola.warn("STOP sentinel found in .studio/ — halting.");
      break;
    }

    // In the forever loop (after the first release), an operator approval ships
    // the CURRENT build promptly instead of iterating further, so what goes live
    // is the build they approved rather than a newer, unreviewed one. We do NOT
    // preempt during the initial bootstrap (before the first ship): an early
    // approval simply waits and is honored at the natural ship phase, once
    // assets/build/playtest have run — so it can't deploy an incomplete game.
    // Checked before the cycle-budget stop so an explicit approval is honored
    // even when --max-cycles is already spent.
    if (
      state.phase !== "ship" &&
      state.shipped &&
      !opts.autoDeploy &&
      !opts.noShip &&
      approvalPending(bb, state.lastApproval)
    ) {
      consola.info("Approval received — shipping the current build before continuing.");
      state.phase = "ship";
      state.phaseFailures = 0; // entering a new phase: fresh retry budget
      saveState(bb, state);
    }

    // An operator-approved deploy is a deliberate command — let that single ship
    // run even if the autonomous cycle budget is used up.
    const approvedShipPending =
      state.phase === "ship" &&
      !opts.autoDeploy &&
      !opts.noShip &&
      approvalPending(bb, state.lastApproval);
    if (opts.maxCycles > 0 && state.cycle >= opts.maxCycles && !approvedShipPending) {
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

    // Never deploy without a recorded successful build — e.g. if the build
    // phase was skipped after repeated failures. Wait until a build lands.
    if (state.phase === "ship" && !state.built) {
      consola.warn("Reached ship with no successful build recorded — not deploying yet.");
      appendJournal(bb, "ship: skipped — no successful build recorded.");
      advance(state);
      saveState(bb, state);
      continue;
    }

    // Deploys require explicit human approval unless --auto-deploy is set. When
    // there's no standing approval we don't even run the shipper: the build is
    // ready, we just don't publish it — the loop keeps improving the game
    // locally until a human runs `pnpm approve <slug>`.
    if (state.phase === "ship" && !opts.autoDeploy && !approvalPending(bb, state.lastApproval)) {
      consola.warn(
        `Build ready but NOT deployed — approval required. Run \`pnpm approve ${state.slug}\` to publish it (or start with --auto-deploy).`,
      );
      appendJournal(bb, "ship: build ready, awaiting human approval (not deployed).");
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
      maxSessionMs: opts.maxSessionMs,
      claudeBin: claudeBin(),
      addDirs: state.contextDir ? [repoRoot, state.contextDir] : [repoRoot],
      skipPermissions: opts.skipPermissions,
      signal: abort.signal,
      label: role.name,
    });

    state.cycle += 1;
    if (typeof res.costUsd === "number") state.totalCostUsd += res.costUsd;
    saveState(bb, state);

    if (!res.ok) {
      state.phaseFailures += 1;
      saveState(bb, state); // persist so a restart can't reset the retry budget
      appendJournal(
        bb,
        `${role.name} (${phase}) FAILED: ${truncate(res.error ?? "unknown error")}`,
      );
      consola.error(`${role.name} failed: ${res.error ?? "unknown error"}`);
      if (state.phaseFailures >= MAX_RETRIES) {
        consola.warn(
          `${MAX_RETRIES} consecutive failures on "${phase}" — skipping ahead to avoid a stuck loop.`,
        );
        // A spent attempt consumes the deploy approval too, so a broken ship
        // can't re-trigger itself forever; the operator can re-approve.
        if (phase === "ship") {
          state.lastApproval = approvalToken(bb) ?? state.lastApproval;
          consumeApproval(bb);
        }
        state.phaseFailures = 0;
        advance(state);
        saveState(bb, state);
      } else {
        const backoff = Math.min(2 ** state.phaseFailures, 60);
        consola.info(
          `Retrying "${phase}" in ${backoff}s (attempt ${state.phaseFailures + 1}/${MAX_RETRIES}).`,
        );
        await sleepUnlessStopping(backoff * 1000);
      }
      continue;
    }

    state.phaseFailures = 0;
    appendJournal(
      bb,
      `${role.name} (${phase}) done${costNote(res.costUsd)}: ${truncate(res.result)}`,
    );
    consola.success(`${role.name} done${costNote(res.costUsd)} · ${res.numTurns ?? "?"} turns`);

    // A deployable build exists once a phase that builds the game succeeds:
    // scaffold (confirms the template/adopted project builds), build, or
    // playtest (QA builds to run it). Including playtest — which recurs in the
    // forever loop — means a game made buildable by later work can still ship;
    // built never gets permanently stuck false after a skipped bootstrap build.
    if (phase === "scaffold" || phase === "build" || phase === "playtest") state.built = true;

    // Only a real, successful ship marks the game deployed; the one-shot
    // approval is recorded as consumed in state (authoritative even if the
    // sentinel file fails to delete), so the next release needs fresh approval.
    if (phase === "ship") {
      recordShip(state);
      state.lastApproval = approvalToken(bb) ?? state.lastApproval;
      consumeApproval(bb);
    }
    advance(state);
    saveState(bb, state);

    if (opts.interval > 0 && !stopping) await sleepUnlessStopping(opts.interval);
  }

  // Don't leak handlers if runStudio is called more than once in a process.
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  process.off("exit", onExit);

  saveState(bb, state);
  releaseLock(bb);
  consola.box(
    [
      `Studio stopped for "${state.slug}".`,
      `Cycles run: ${state.cycle} · iterations: ${state.iteration}`,
      state.deployUrl ? `Live: ${state.deployUrl}` : "Not yet shipped.",
      `Approx spend: $${state.totalCostUsd.toFixed(2)}`,
      `Resume anytime: pnpm start ${state.slug}`,
    ].join("\n"),
  );
  return true;
}

/**
 * Pure phase transition: bootstrap once, then loop the studio cycle forever.
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
 * completed studio iteration (a shipped feature/fix/iteration pass).
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
  const bb = blackboard(opts.workspace);
  consola.box(
    [
      `🎮 vibedgames autonomous studio`,
      ``,
      `Game:      ${state.slug}`,
      `Idea:      ${state.idea || "(from existing project / context)"}`,
      `Model:     ${state.model}`,
      `Game dir:  ${opts.workspace}`,
      state.existingProject ? `Source:    building on existing files in the game dir` : null,
      existsSync(bb.context)
        ? `Context:   provided${state.contextDir ? ` (+ reference dir: ${state.contextDir})` : ""}`
        : null,
      `Repo:      ${repoRoot}`,
      `Mode:      ${opts.skipPermissions ? "unattended (tools auto-approved)" : "guarded (will block on approvals!)"}`,
      opts.noShip
        ? `Deploy:    disabled (--skip-ship)`
        : opts.autoDeploy
          ? `Deploy:    AUTOMATIC → ${state.slug}.vibedgames.com`
          : `Deploy:    on approval only — \`pnpm approve ${state.slug}\` → ${state.slug}.vibedgames.com`,
      opts.maxCycles > 0
        ? `Stops at:  ${opts.maxCycles} cycles`
        : `Runs:      until you stop it (Ctrl-C or \`pnpm stop ${state.slug}\`)`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (opts.skipPermissions) {
    const deployNote = opts.noShip
      ? "Deploys are disabled."
      : opts.autoDeploy
        ? "Deploys to production run AUTOMATICALLY."
        : "Deploys are gated on `pnpm approve <slug>` — nothing goes live without you.";
    consola.warn(
      `Running with --dangerously-skip-permissions: agents run shell/file tools and \`vg generate\` (which costs money) WITHOUT asking. ${deployNote} Stop with Ctrl-C.`,
    );
    // claude rejects --dangerously-skip-permissions under root unless the
    // environment is marked as a sandbox; we set IS_SANDBOX=1 for the children
    // so unattended container/CI runs (which are typically root) actually work.
    if (
      typeof process.getuid === "function" &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== "1"
    ) {
      consola.info(
        "Detected root: setting IS_SANDBOX=1 for agents so skip-permissions is allowed.",
      );
    }
  }
}

const truncate = (s: string, n = 240): string => {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

const costNote = (c?: number): string => (typeof c === "number" ? ` ($${c.toFixed(2)})` : "");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
