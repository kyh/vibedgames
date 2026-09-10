#!/usr/bin/env bun
import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineCommand, runMain } from "citty";
import { consola } from "consola";

import type { RoleName } from "./agents.ts";

import {
  availableSlug,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_MAX_TURNS,
  DEFAULT_RUNNER,
  DEFAULT_SESSION_MINUTES,
  defaultModelFor,
  deriveSlug,
  normalizeSlug,
  resolveWorkspace,
} from "./config.ts";
import { isRunner, RUNNERS } from "./runner.ts";
import { runAgent } from "./orchestrator.ts";
import { createConsoleReporter } from "./reporter.ts";
import {
  approvalPending,
  blackboard,
  hasExistingProject,
  loadState,
  requestApproval,
} from "./state.ts";
import { runTui } from "./tui/main.tsx";

/** Cap how much of a context file we inline into the brief. */
const MAX_CONTEXT_BYTES = 20_000;

/** Read at most maxBytes from a file without loading the whole thing. */
const readBounded = (file: string, maxBytes: number): string => {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    closeSync(fd);
  }
};

/**
 * Resolve the optional --context value into a brief (and maybe a reference dir
 * the agents get read access to). A path to a file is read inline (bounded); a
 * path to a directory becomes a reference the agents explore; anything that
 * isn't an existing path is treated as literal brief text. A path that exists
 * but can't be read is a hard error (don't silently treat it as text).
 */
interface ResolvedContext {
  context?: string;
  contextDir?: string;
}

const resolveContext = (raw: string | undefined): ResolvedContext => {
  const value = (raw ?? "").trim();
  if (!value) {
    return {};
  }
  const p = path.resolve(process.cwd(), value);

  let stat;
  try {
    stat = statSync(p);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // not a path — a literal brief
      return { context: value };
    }
    consola.error(
      `Could not access --context path ${p}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (stat.isDirectory()) {
    return {
      context: `Reference material is provided in this directory (you have read access): ${p}\nExplore it and take direction from / build upon what's there.`,
      contextDir: p,
    };
  }
  if (stat.isFile()) {
    try {
      return { context: readBounded(p, MAX_CONTEXT_BYTES) };
    } catch (error) {
      consola.error(
        `Could not read --context file ${p}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }
  return { context: value };
};

const ROLE_NAMES: readonly RoleName[] = [
  "director",
  "designer",
  "engineer",
  "artist",
  "qa",
  "shipper",
];

/** Parse + validate --codex-roles, exiting on an unknown role (CLI edge only). */
const parseCodexRoles = (raw: string): RoleName[] => {
  const names = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const roles: RoleName[] = [];
  for (const name of names) {
    const match = ROLE_NAMES.find((r) => r === name);
    if (!match) {
      consola.error(`Unknown role in --codex-roles: "${name}". Use ${ROLE_NAMES.join(", ")}.`);
      process.exit(1);
    }
    roles.push(match);
  }
  return roles;
};

/** Validate a slug or exit with a helpful message (CLI edge only). */
const requireSlug = (raw: string): string => {
  const slug = normalizeSlug(raw);
  if (!slug) {
    consola.error(
      `Invalid slug: ${raw}\n  Use lowercase letters, digits, and hyphens (e.g. "asteroid-belt").`,
    );
    process.exit(1);
  }
  return slug;
};

/**
 * Parse a CLI integer strictly: only a plain non-negative integer (>= min) is
 * accepted; anything malformed or out of range falls back, so a typo can't
 * silently disable a timeout or set a nonsensical budget.
 */
const toInt = (v: string | undefined, fallback: number, min = 0): number => {
  if (v === undefined) {
    return fallback;
  }
  const t = v.trim();
  if (!/^\d+$/u.test(t)) {
    return fallback;
  }
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
};
const startCommand = defineCommand({
  args: {
    "auto-deploy": {
      default: false,
      description:
        "Deploy automatically without per-release approval. Default is OFF: nothing goes live until you approve (pnpm approve <slug> or the A key).",
      type: "boolean",
    },
    "checkpoint-wait": {
      description:
        "Seconds an agent checkpoint waits for your feedback before auto-continuing (default 120; 0 = never wait).",
      type: "string",
    },
    "codex-model": {
      default: "",
      description: `Model for codex-routed roles (default ${defaultModelFor("codex")}).`,
      type: "string",
    },
    "codex-roles": {
      default: "",
      description:
        'Comma-separated roles to run on the codex CLI even when the main runner is claude (e.g. "engineer"). Routes bulk build work to a cheaper runner; judgment roles stay on claude.',
      type: "string",
    },
    context: {
      description:
        "Extra context for the build: literal text, a path to a file (read inline), or a path to a directory (the agents get read access and build upon it).",
      type: "string",
    },
    dir: {
      description:
        "Where the game lives — its project directory (default apps/factory/.workspaces/<slug>). Points at an existing project? The agent builds upon it. Outside this repo, run `vg init` first so the skills path.resolve.",
      type: "string",
    },
    guarded: {
      default: false,
      description:
        "Do NOT pass --dangerously-skip-permissions. Agents will block waiting for approval — breaks unattended autonomy. For debugging only.",
      type: "boolean",
    },
    idea: {
      default: "",
      description:
        'Seed idea, e.g. --idea "a neon roguelike where you fight with sound". Optional when --dir points at an existing project or you pass --context.',
      type: "string",
    },
    "idle-timeout": {
      description: `Kill a specialist that emits no output for this many minutes (default ${DEFAULT_IDLE_MINUTES}; 0 disables).`,
      type: "string",
    },
    interval: {
      description: "Milliseconds to pause between specialist runs (default 0).",
      type: "string",
    },
    "max-cycles": {
      description: "Stop after N specialist runs (default 0 = run forever).",
      type: "string",
    },
    "max-turns": {
      description: `Per-specialist agentic turn ceiling (default ${DEFAULT_MAX_TURNS}).`,
      type: "string",
    },
    model: {
      default: "",
      description: `Model for the runner (default ${defaultModelFor("claude")} for claude, ${defaultModelFor("codex")} for codex; pass a cheaper tier for a budget run).`,
      type: "string",
    },
    "no-tui": {
      default: false,
      description:
        "Disable the interactive dashboard and stream plain logs instead (automatic when stdout isn't a TTY).",
      type: "boolean",
    },
    runner: {
      default: DEFAULT_RUNNER,
      description: `Which coding-agent CLI runs the subagents: ${RUNNERS.join(" | ")} (default ${DEFAULT_RUNNER}).`,
      type: "string",
    },
    "session-timeout": {
      description: `Absolute cap on a single specialist session in minutes (default ${DEFAULT_SESSION_MINUTES}; 0 disables).`,
      type: "string",
    },
    "skip-ship": {
      default: false,
      description: "Skip the deploy phase entirely — never even prepare a release.",
      type: "boolean",
    },
    slug: {
      description:
        "Lowercase, hyphenated game slug — the deploy subdomain. Optional: derived from --dir's folder name or the --idea when omitted; with neither, the dashboard opens on the setup screen.",
      required: false,
      type: "positional",
    },
  },
  meta: {
    description:
      "Start (or resume) the autonomous agent for a game. In a terminal this opens the interactive dashboard — run it with no slug to configure a new game on the setup screen. Deploys are gated on approval unless --auto-deploy is set.",
    name: "start",
  },
  run: async ({ args }) => {
    const { context, contextDir } = resolveContext(args.context);
    if (!isRunner(args.runner)) {
      consola.error(`Unknown --runner "${args.runner}". Use ${RUNNERS.join(" or ")}.`);
      process.exit(1);
    }
    const { runner } = args;
    const codexRoles = parseCodexRoles(args["codex-roles"]);
    const knobs = {
      autoDeploy: Boolean(args["auto-deploy"]),
      checkpointWaitMs: toInt(args["checkpoint-wait"], 120) * 1000,
      codexModel: args["codex-model"].trim() || defaultModelFor("codex"),
      codexRoles,
      context,
      contextDir,
      idea: args.idea.trim(),
      idleTimeoutMs: toInt(args["idle-timeout"], DEFAULT_IDLE_MINUTES) * 60_000,
      interval: toInt(args.interval, 0),
      maxCycles: toInt(args["max-cycles"], 0),
      maxSessionMs: toInt(args["session-timeout"], DEFAULT_SESSION_MINUTES) * 60_000,
      maxTurns: toInt(args["max-turns"], DEFAULT_MAX_TURNS, 1),
      model: args.model.trim() || defaultModelFor(runner),
      noShip: Boolean(args["skip-ship"]),
      runner,
      skipPermissions: !args.guarded,
    };

    // The interactive dashboard needs a real terminal on both ends (keyboard +
    // screen); anything else (CI, piped logs, --no-tui) streams plain logs.
    const interactive =
      !args["no-tui"] && process.stdout.isTTY === true && process.stdin.isTTY === true;

    if (interactive) {
      // Validate an explicit slug here so a typo fails fast with the usual CLI
      // error; the setup screen re-validates whatever the user types in.
      const slug = args.slug ? requireSlug(args.slug) : undefined;
      await runTui({ ...knobs, dir: args.dir, slug });
      return;
    }

    // The slug is only the deploy identity — derive it when omitted (folder
    // name, else the idea's first words), exactly like the setup screen does.
    const explicit = args.slug ? requireSlug(args.slug) : undefined;
    let slug = deriveSlug({ dir: args.dir, idea: knobs.idea || undefined, slug: explicit });
    if (!slug) {
      consola.error(
        'Nothing identifies the game: pass a slug, --dir <folder>, or --idea "your one-line idea".',
      );
      process.exit(1);
    }
    if (!explicit && !args.dir) {
      slug = availableSlug(slug);
    }
    const workspace = resolveWorkspace(slug, args.dir);
    const bb = blackboard(workspace);
    const fresh = !existsSync(bb.state);
    // A new game needs *something* to go on: a seed idea, an operator brief, or
    // an existing project in the game dir to build upon.
    if (fresh && !knobs.idea && !context && !hasExistingProject(workspace)) {
      // Distinguish "no --context given" from "--context given but empty", so an
      // operator who pointed at an empty file isn't told to "add --context".
      const contextAttempted = Boolean((args.context ?? "").trim());
      consola.error(
        contextAttempted
          ? "The --context you provided is empty (blank text or an empty file). Provide non-empty context, pass --idea, or point --dir at an existing project."
          : 'Nothing to build from. Pass --idea "your one-line idea", add --context, or point --dir at an existing project.',
      );
      process.exit(1);
    }
    // A stale STOP sentinel is cleared inside runAgent once the workspace lock
    // is held, so a restart can never wipe a still-running process's stop.

    const started = await runAgent({ ...knobs, slug, workspace }, createConsoleReporter());
    if (!started) {
      process.exit(1);
    }
  },
});

const stopCommand = defineCommand({
  args: {
    dir: { description: "Game directory (if you set --dir on start).", type: "string" },
    slug: { description: "Game slug.", required: true, type: "positional" },
  },
  meta: {
    description: "Signal a running agent to stop after its current step (writes a STOP sentinel).",
    name: "stop",
  },
  run: ({ args }) => {
    const slug = requireSlug(args.slug);
    const bb = blackboard(resolveWorkspace(slug, args.dir));
    if (!existsSync(bb.dir)) {
      consola.error(`No agent workspace found for "${slug}".`);
      process.exit(1);
    }
    writeFileSync(bb.stop, `stop requested ${new Date().toISOString()}\n`);
    consola.success(
      `Stop signalled for "${slug}". It will halt after the current specialist finishes.`,
    );
  },
});

const statusCommand = defineCommand({
  args: {
    dir: { description: "Game directory (if you set --dir on start).", type: "string" },
    json: { default: false, description: "Machine-readable output.", type: "boolean" },
    slug: { description: "Game slug.", required: true, type: "positional" },
  },
  meta: {
    description: "Show the current state of a game's agent.",
    name: "status",
  },
  run: ({ args }) => {
    const slug = requireSlug(args.slug);
    const bb = blackboard(resolveWorkspace(slug, args.dir));
    if (!existsSync(bb.state)) {
      consola.error(`No agent state found for "${slug}".`);
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
        `Approval:   ${approvalPending(bb, state.lastApproval) ? "pending — deploys the current build shortly" : "none (run `pnpm approve <slug>` to publish)"}`,
        `Spend:      ~$${state.totalCostUsd.toFixed(2)}`,
        `Updated:    ${state.updatedAt}`,
        `Game dir:   ${bb.root}`,
      ].join("\n"),
    );
  },
});

const approveCommand = defineCommand({
  args: {
    dir: { description: "Game directory (if you set --dir on start).", type: "string" },
    slug: { description: "Game slug.", required: true, type: "positional" },
  },
  meta: {
    description:
      "Approve the current build for ONE deployment. A running agent publishes it at its next ship step (or immediately if it's waiting); the next release needs fresh approval.",
    name: "approve",
  },
  run: ({ args }) => {
    const slug = requireSlug(args.slug);
    const bb = blackboard(resolveWorkspace(slug, args.dir));
    if (!existsSync(bb.dir)) {
      consola.error(`No agent workspace found for "${slug}".`);
      process.exit(1);
    }
    requestApproval(bb);
    consola.success(
      `Approved "${slug}" for one deployment. A running agent publishes the current build shortly (after the in-flight step finishes); the next release needs fresh approval.`,
    );
  },
});

const main = defineCommand({
  meta: {
    description:
      "vibedgames factory — one autonomous agent per game: it builds a browser game end-to-end and evolves it like a studio (a durable, checkpointed loop of clean-context subagents). Deploys require approval.",
    name: "factory",
  },
  subCommands: {
    approve: approveCommand,
    start: startCommand,
    status: statusCommand,
    stop: stopCommand,
  },
});

runMain(main);
