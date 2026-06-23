#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand, runMain } from "citty";
import consola from "consola";

import { DEFAULT_MAX_TURNS, DEFAULT_MODEL, defaultWorkspace, findRepoRoot } from "./config.js";
import { runStudio } from "./orchestrator.js";
import { blackboard, loadState } from "./state.js";

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
      "Start (or resume) the autonomous studio for a game. Runs a multi-agent loop that builds the game end-to-end and polishes it forever until you stop it.",
  },
  args: {
    slug: {
      type: "positional",
      description: "Lowercase, hyphenated game slug — also the deploy subdomain.",
      required: true,
    },
    idea: {
      type: "string",
      description: 'Seed idea, e.g. --idea "a neon roguelike where you fight with sound".',
      default: "",
    },
    model: {
      type: "string",
      description: `Model alias passed to claude --model (default ${DEFAULT_MODEL}; try "opus" for higher craft).`,
      default: DEFAULT_MODEL,
    },
    workspace: {
      type: "string",
      description: "Override the game workspace dir (default apps/agents/.workspaces/<slug>).",
    },
    "max-turns": {
      type: "string",
      description: `Per-specialist agentic turn ceiling (default ${DEFAULT_MAX_TURNS}).`,
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
      description: "Skip the deploy phase — no production deploys (useful while testing the loop).",
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

    const workspace = resolveWorkspace(slug, args.workspace);
    const bb = blackboard(workspace);
    const fresh = !existsSync(bb.state);
    if (fresh && !args.idea.trim()) {
      consola.error(
        'A seed idea is required for a new game. Pass --idea "your one-line game idea".',
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
      maxTurns: toInt(args["max-turns"], DEFAULT_MAX_TURNS),
      maxCycles: toInt(args["max-cycles"], 0),
      interval: toInt(args.interval, 0),
      noShip: Boolean(args["skip-ship"]),
      skipPermissions: !args.guarded,
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
    workspace: { type: "string", description: "Override workspace dir." },
  },
  run: ({ args }) => {
    const slug = requireSlug(args.slug);
    const bb = blackboard(resolveWorkspace(slug, args.workspace));
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
    workspace: { type: "string", description: "Override workspace dir." },
    json: { type: "boolean", description: "Machine-readable output.", default: false },
  },
  run: ({ args }) => {
    const slug = requireSlug(args.slug);
    const bb = blackboard(resolveWorkspace(slug, args.workspace));
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
        `Spend:      ~$${state.totalCostUsd.toFixed(2)}`,
        `Updated:    ${state.updatedAt}`,
        `Workspace:  ${bb.root}`,
      ].join("\n"),
    );
  },
});

const main = defineCommand({
  meta: {
    name: "vg-studio",
    description:
      "vibedgames autonomous studio — a multi-agent loop that builds one browser game end-to-end and polishes it forever.",
  },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    status: statusCommand,
  },
});

function toInt(v: string | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

runMain(main);
