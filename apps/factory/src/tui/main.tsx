import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { createRoot, type Root } from "@opentui/react";

import {
  availableSlug,
  defaultWorkspaceLabel,
  deriveSlug,
  normalizeSlug,
  resolveWorkspace,
} from "../config.ts";
import { runAgent, type AgentOptions, type RunControls } from "../orchestrator.ts";
import type { Runner } from "../runner.ts";
import {
  approvalPending,
  blackboard,
  hasExistingProject,
  readDirective,
  requestApproval,
  setDirective,
} from "../state.ts";
import { App, type AppController, type SetupForm } from "./app.tsx";
import { readBacklog } from "./backlog.ts";
import { TuiSink } from "./sink.ts";
import { TuiStore } from "./store.ts";

/** Everything the CLI hands the interactive app. slug/idea/dir are optional —
 * missing pieces are collected on the setup screen. */
export type TuiLaunch = {
  slug?: string;
  idea: string;
  dir?: string;
  runner: Runner;
  model: string;
  maxTurns: number;
  idleTimeoutMs: number;
  maxSessionMs: number;
  maxCycles: number;
  checkpointWaitMs: number;
  interval: number;
  noShip: boolean;
  autoDeploy: boolean;
  skipPermissions: boolean;
  context?: string;
  contextDir?: string;
};

type RunConfig = { slug: string; idea: string; workspace: string };

const expandPath = (raw: string): string => {
  const p = raw.trim();
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(process.cwd(), p);
};

/**
 * The interactive factory app. Mounts the opentui dashboard, collects a game
 * config on the setup screen when the CLI didn't provide one, and starts /
 * stops / resumes the agent loop from the keyboard. Resolves only via
 * process.exit (quit key or force-quit).
 */
export async function runTui(launch: TuiLaunch): Promise<void> {
  const store = new TuiStore();
  const sink = new TuiSink(store);

  let renderer: CliRenderer | null = null;
  let root: Root | null = null;
  let controls: RunControls | null = null;
  let cfg: RunConfig | null = null;
  let loopActive = false;
  let closed = false;
  let poller: ReturnType<typeof setInterval> | undefined;

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    if (poller) clearInterval(poller);
    try {
      root?.unmount();
    } catch {
      /* teardown is best-effort */
    }
    try {
      renderer?.destroy();
    } catch {
      /* teardown is best-effort */
    }
  };

  const pollBacklog = (): void => {
    if (!cfg) return;
    store.set({ backlog: readBacklog(blackboard(cfg.workspace).backlog) });
  };

  const startRun = (config: RunConfig): void => {
    if (loopActive) return;
    loopActive = true;
    cfg = config;
    store.set({
      screen: "dashboard",
      setupError: null,
      stopping: false,
      paused: false,
      checkpoint: null,
      directive: readDirective(blackboard(config.workspace)),
    });
    pollBacklog();
    const opts: AgentOptions = {
      slug: config.slug,
      idea: config.idea,
      workspace: config.workspace,
      runner: launch.runner,
      model: launch.model,
      maxTurns: launch.maxTurns,
      idleTimeoutMs: launch.idleTimeoutMs,
      maxSessionMs: launch.maxSessionMs,
      maxCycles: launch.maxCycles,
      checkpointWaitMs: launch.checkpointWaitMs,
      interval: launch.interval,
      noShip: launch.noShip,
      autoDeploy: launch.autoDeploy,
      skipPermissions: launch.skipPermissions,
      context: launch.context,
      contextDir: launch.contextDir,
      registerControls: (c) => {
        controls = c;
      },
      beforeForceExit: teardown,
    };
    const run = async (): Promise<void> => {
      const ok = await runAgent(opts, sink);
      loopActive = false;
      controls = null;
      // A loop that never started (lock held) still needs the UI unstuck; a
      // completed one was already settled by runEnded.
      if (!ok) store.set({ running: false, stopping: false, turn: null });
    };
    void run();
  };

  const controller: AppController = {
    expandPath,
    defaultDirLabel: () => defaultWorkspaceLabel(),

    previewSlug: (form: SetupForm): string | null =>
      deriveSlug({
        slug: form.slug.trim() || undefined,
        dir: form.dir.trim() ? expandPath(form.dir) : undefined,
        idea: form.idea.trim() || undefined,
      }),

    submitSetup: (form: SetupForm): void => {
      if (loopActive) return;
      const explicit = form.slug.trim();
      if (explicit && !normalizeSlug(explicit)) {
        store.set({
          setupError: 'Slug must be lowercase letters, digits, and hyphens (e.g. "neon-slasher").',
        });
        return;
      }
      const dir = form.dir.trim() ? expandPath(form.dir) : undefined;
      const idea = form.idea.trim();
      // The slug is derived when not given: folder name, else the idea's first
      // words. Nothing derivable means the form is empty — ask for the game.
      let slug = deriveSlug({ slug: explicit || undefined, dir, idea: idea || undefined });
      if (!slug) {
        store.set({
          setupError:
            "What kind of game? Describe it in INSTRUCTIONS — or point FOLDER at an existing project.",
        });
        return;
      }
      // Idea-derived names must not silently resume an unrelated game.
      if (!explicit && !dir) slug = availableSlug(slug);
      const workspace = resolveWorkspace(slug, dir);
      // A new game needs *something* to go on: instructions, an operator
      // brief, or an existing project in the folder to build upon.
      const fresh = !existsSync(blackboard(workspace).state);
      if (fresh && !idea && !launch.context && !hasExistingProject(workspace)) {
        store.set({
          setupError:
            "That folder is empty — describe the game to build in INSTRUCTIONS, or point FOLDER at an existing project.",
        });
        return;
      }
      startRun({ slug, idea, workspace });
    },

    approve: (): void => {
      if (!cfg) return;
      const bb = blackboard(cfg.workspace);
      requestApproval(bb);
      store.push(
        "info",
        "Deploy approval granted — the current build ships at the next release point.",
      );
      store.set({
        approvalPending: approvalPending(bb, store.getSnapshot().state?.lastApproval ?? null),
      });
    },

    stop: (): void => {
      if (!loopActive) return;
      store.set({ stopping: true, paused: false });
      controls?.gracefulStop();
    },

    togglePause: (): void => {
      if (!loopActive) return;
      const paused = !store.getSnapshot().paused;
      store.set({ paused });
      if (paused) controls?.pause();
      else controls?.resume();
    },

    stopAtRelease: (): void => {
      if (!loopActive) return;
      controls?.stopAtRelease();
    },

    continueNow: (): void => {
      controls?.continueNow();
    },

    redirect: (text: string): void => {
      if (!cfg) return;
      const bb = blackboard(cfg.workspace);
      setDirective(bb, text);
      const directive = readDirective(bb);
      store.set({ directive });
      store.push("marker", directive ? `⟶ directive: ${directive}` : "⟶ directive cleared");
      // A directive is also an answer to an open checkpoint.
      if (store.getSnapshot().checkpoint) controls?.continueNow();
    },

    resume: (): void => {
      if (loopActive || !cfg) return;
      startRun(cfg);
    },

    quit: (): void => {
      if (!loopActive) {
        teardown();
        process.exit(0);
      }
      if (!store.getSnapshot().stopping) {
        controller.stop();
        return;
      }
      // Second press while stopping: force quit.
      teardown();
      if (controls) {
        controls.forceQuit();
      } else {
        process.exit(130);
      }
    },
  };

  // While the loop runs, runAgent owns SIGINT/SIGTERM (graceful → force with
  // terminal restore via beforeForceExit). This handler covers the idle app
  // (setup screen / stopped), where nothing else would restore the terminal.
  const onSignal = (): void => {
    if (loopActive) return;
    teardown();
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // We own Ctrl-C (graceful-then-force) and signals, so the renderer must not
  // exit the process itself.
  renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], targetFps: 60 });
  root = createRoot(renderer);
  root.render(
    <App
      store={store}
      controller={controller}
      prefill={{ slug: launch.slug ?? "", idea: launch.idea, dir: launch.dir ?? "" }}
    />,
  );
  poller = setInterval(pollBacklog, 2000);

  // A slug or folder on the command line starts immediately (`pnpm start
  // <slug>` resumes; `pnpm start --dir <folder>` adopts what's there);
  // anything invalid or incomplete lands on the setup screen with the values
  // prefilled and the reason shown.
  if (launch.slug || launch.dir) {
    controller.submitSetup({ slug: launch.slug ?? "", idea: launch.idea, dir: launch.dir ?? "" });
  }
}
