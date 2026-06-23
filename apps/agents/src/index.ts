#!/usr/bin/env node
import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand, runMain } from "citty";
import consola from "consola";

import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  DEFAULT_SESSION_MINUTES,
  defaultWorkspace,
  findRepoRoot,
} from "./config.js";
import { runStudio } from "./orchestrator.js";
import {
  approvalPending,
  blackboard,
  hasExistingProject,
  loadState,
  requestApproval,
} from "./state.js";

/** Cap how much of a context file we inline into the brief. */
const MAX_CONTEXT_BYTES = 20_000;

/** Read at most maxBytes from a file without loading the whole thing. */
function readBounded(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Resolve the optional --context value into a brief (and maybe a reference dir
 * the agents get read access to). A path to a file is read inline (bounded); a
 * path to a directory becomes a reference the agents explore; anything that
 * isn't an existing path is treated as literal brief text. A path that exists
 * but can't be read is a hard error (don't silently treat it as text).
 */
function resolveContext(raw: string | undefined): { context?: string; contextDir?: string } {
  const value = (raw ?? "").trim();
  if (!value) return {};
  const p = resolve(process.cwd(), value);

  let stat;
  try {
    stat = statSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { context: value }; // not a path — a literal brief
    }
    consola.error(`Could not access --context path ${p}: ${(err as Error).message}`);
    process.exit(1);
  }

  if (stat.isDirectory()) {
    return {
      contextDir: p,
      context: `Reference material is provided in this directory (you have read access): ${p}\nExplore it and take direction from / build upon what's there.`,
    };
  }
  if (stat.isFile()) {
    try {
      return { context: readBounded(p, MAX_CONTEXT_BYTES) };
    } catch (err) {
      consola.error(`Could not read --context file ${p}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
  return { context: value };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Validate + normalize a slug before it's ever used to build a filesystem
 * path. Rejecting anything outside [a-z0-9-] keeps `..`/path segments from
 * resolving `.studio` outside the workspaces dir.
 */
function requireSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    consola.error(
      `Invalid slug: ${raw}\n  Use lowercase letters, digits, and hyphens (e.g. "asteroid-belt").`,
    );
    process.exit(1);
  }
  return slug;
}

function resolveWorkspace(slug: string, override?: string): string {
  if (override) return resolve(process.cwd(), override);
  return defaultWorkspace(findRepoRoot(), slug);
}

const startCommand = defineCommand({
  meta: {
    name: "start",
    description:
      "Start (or resume) the autonomous studio for a game. Builds the game end-to-end and evolves it like a studio until you stop it. Deploys are gated on `vg-studio approve` unless --auto-deploy is set.",
  },
  args: {
    slug: {
      type: "positional",
      description: "Lowercase, hyphenated game slug — also the deploy subdomain.",
      required: true,
    },
    idea: {
      type: "string",
      description:
        'Seed idea, e.g. --idea "a neon roguelike where you fight with sound". Optional when --dir points at an existing project or you pass --context.',
      default: "",
    },
    context: {
      type: "string",
      description:
        "Extra context for the build: literal text, a path to a file (read inline), or a path to a directory (the agents get read access and build upon it).",
    },
    model: {
      type: "string",
      description: `Model alias passed to claude --model (default ${DEFAULT_MODEL}; try "opus" for higher craft).`,
      default: DEFAULT_MODEL,
    },
    dir: {
      type: "string",
      description:
        "Where the game lives — its project directory (default apps/agents/.workspaces/<slug>). Outside this repo, run `vg init` first so the skills resolve.",
    },
    "max-turns": {
      type: "string",
      description: `Per-specialist agentic turn ceiling (default ${DEFAULT_MAX_TURNS}).`,
    },
    "idle-timeout": {
      type: "string",
      description: `Kill a specialist that emits no output for this many minutes (default ${DEFAULT_IDLE_MINUTES}; 0 disables).`,
    },
    "session-timeout": {
      type: "string",
      description: `Absolute cap on a single specialist session in minutes (default ${DEFAULT_SESSION_MINUTES}; 0 disables).`,
    },
    "max-cycles": {
      type: "string",
      description: "Stop after N specialist runs (default 0 = run forever).",
    },
    interval: {
      type: "string",
      description: "Milliseconds to pause between specialist runs (default 0).",
    },
    "skip-ship": {
      type: "boolean",
      description: "Skip the deploy phase entirely — never even prepare a release.",
      default: false,
    },
    "auto-deploy": {
      type: "boolean",
      description:
        "Deploy automatically without per-release approval. Default is OFF: nothing goes live until you run `vg-studio approve <slug>`.",
      default: false,
    },
    guarded: {
      type: "boolean",
      description:
        "Do NOT pass --dangerously-skip-permissions. Agents will block waiting for approval — breaks unattended autonomy. For debugging only.",
      default: false,
    },
  },
  run: async ({ args }) => {
    const slug = requireSlug(args.slug);

    const workspace = resolveWorkspace(slug, args.dir);
    const bb = blackboard(workspace);
    const fresh = !existsSync(bb.state);
    const { context, contextDir } = resolveContext(args.context);
    // A new game needs *something* to go on: a seed idea, an operator brief, or
    // an existing project in the game dir to build upon.
    if (fresh && !args.idea.trim() && !context && !hasExistingProject(workspace)) {
      consola.error(
        'Nothing to build from. Pass --idea "your one-line idea", add --context, or point --dir at an existing project.',
      );
      process.exit(1);
    }
    // A stale STOP sentinel is cleared inside runStudio once the workspace lock
    // is held, so a restart can never wipe a still-running process's stop.

    const started = await runStudio({
      slug,
      idea: args.idea.trim(),
      workspace,
      model: args.model,
      maxTurns: toInt(args["max-turns"], DEFAULT_MAX_TURNS, 1),
      idleTimeoutMs: toInt(args["idle-timeout"], DEFAULT_IDLE_MINUTES) * 60_000,
      maxSessionMs: toInt(args["session-timeout"], DEFAULT_SESSION_MINUTES) * 60_000,
      maxCycles: toInt(args["max-cycles"], 0),
      interval: toInt(args.interval, 0),
      noShip: Boolean(args["skip-ship"]),
      autoDeploy: Boolean(args["auto-deploy"]),
      skipPermissions: !args.guarded,
      context,
      contextDir,
    });
    if (!started) process.exit(1);
  },
});

const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Signal a running studio to stop after its current step (writes a STOP sentinel).",
  },
  args: {
    slug: { type: "positional", description: "Game slug.", required: true },
    dir: { type: "string", description: "Game directory (if you set --dir on start)." },
  },
  run: ({ args }) => {
    const slug = requireSlug(args.slug);
    const bb = blackboard(resolveWorkspace(slug, args.dir));
    if (!existsSync(bb.dir)) {
      consola.error(`No studio workspace found for "${slug}".`);
      process.exit(1);
    }
    writeFileSync(bb.stop, `stop requested ${new Date().toISOString()}\n`);
    consola.success(
      `Stop signalled for "${slug}". It will halt after the current specialist finishes.`,
    );
  },
});

const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show the current state of a game's studio.",
  },
  args: {
    slug: { type: "positional", description: "Game slug.", required: true },
    dir: { type: "string", description: "Game directory (if you set --dir on start)." },
    json: { type: "boolean", description: "Machine-readable output.", default: false },
  },
  run: ({ args }) => {
    const slug = requireSlug(args.slug);
    const bb = blackboard(resolveWorkspace(slug, args.dir));
    if (!existsSync(bb.state)) {
      consola.error(`No studio state found for "${slug}".`);
      process.exit(1);
    }
    const state = loadState(bb);
    if (args.json) {
      consola.log(JSON.stringify(state, null, 2));
      return;
    }
    consola.box(
      [
        `Game:       ${state.slug}`,
        `Idea:       ${state.idea}`,
        `Phase:      ${state.phase}`,
        `Cycles:     ${state.cycle}`,
        `Iterations: ${state.iteration}`,
        `Shipped:    ${state.shipped ? "yes" : "no"}`,
        state.deployUrl ? `Live:       ${state.deployUrl}` : `Live:       —`,
        `Approval:   ${approvalPending(bb, state.lastApproval) ? "pending — deploys the current build shortly" : "none (run `vg-studio approve` to publish)"}`,
        `Spend:      ~$${state.totalCostUsd.toFixed(2)}`,
        `Updated:    ${state.updatedAt}`,
        `Game dir:   ${bb.root}`,
      ].join("\n"),
    );
  },
});

const approveCommand = defineCommand({
  meta: {
    name: "approve",
    description:
      "Approve the current build for ONE deployment. A running studio publishes it at its next ship step (or immediately if it's waiting); the next release needs fresh approval.",
  },
  args: {
    slug: { type: "positional", description: "Game slug.", required: true },
    dir: { type: "string", description: "Game directory (if you set --dir on start)." },
  },
  run: ({ args }) => {
    const slug = requireSlug(args.slug);
    const bb = blackboard(resolveWorkspace(slug, args.dir));
    if (!existsSync(bb.dir)) {
      consola.error(`No studio workspace found for "${slug}".`);
      process.exit(1);
    }
    requestApproval(bb);
    consola.success(
      `Approved "${slug}" for one deployment. A running studio publishes the current build shortly (after the in-flight step finishes); the next release needs fresh approval.`,
    );
  },
});

const main = defineCommand({
  meta: {
    name: "vg-studio",
    description:
      "vibedgames autonomous studio — a multi-agent loop that builds one browser game and evolves it like a studio. Deploys require approval (`vg-studio approve`).",
  },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    status: statusCommand,
    approve: approveCommand,
  },
});

/**
 * Parse a CLI integer strictly: only a plain non-negative integer (>= min) is
 * accepted; anything malformed or out of range falls back, so a typo can't
 * silently disable a timeout or set a nonsensical budget.
 */
function toInt(v: string | undefined, fallback: number, min = 0): number {
  if (v == null) return fallback;
  const t = v.trim();
  if (!/^\d+$/.test(t)) return fallback;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

runMain(main);
