import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { render } from "ink";
import type { Instance } from "ink";

import {
  availableSlug,
  defaultWorkspaceLabel,
  deriveSlug,
  normalizeSlug,
  resolveWorkspace,
} from "../config.ts";
import type { RoleName } from "../agents.ts";
import { bestEffort } from "../best-effort.ts";
import { runAgent } from "../orchestrator.ts";
import type { AgentOptions, RunControls } from "../orchestrator.ts";
import type { Runner } from "../runner.ts";
import {
  approvalPending,
  blackboard,
  hasExistingProject,
  readDirective,
  requestApproval,
  setDirective,
} from "../state.ts";
import { App } from "./app.tsx";
import type { AppController, SetupForm } from "./app.tsx";
import { readBacklog } from "./backlog.ts";
import { TuiSink } from "./sink.ts";
import { TuiStore } from "./store.ts";

/** Everything the CLI hands the interactive app. slug/idea/dir are optional —
 * missing pieces are collected on the setup screen. */
export interface TuiLaunch {
  slug?: string;
  idea: string;
  dir?: string;
  runner: Runner;
  model: string;
  codexRoles: RoleName[];
  codexModel: string;
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
}

interface RunConfig {
  slug: string;
  idea: string;
  workspace: string;
  runner: Runner;
  model: string;
}

const expandPath = (raw: string) => {
  const p = raw.trim();

  if (p === "~") {
    return homedir();
  }

  if (p.startsWith("~/")) {
    return path.resolve(homedir(), p.slice(2));
  }

  return path.resolve(process.cwd(), p);
};

/**
 * The interactive factory app. Mounts the Ink dashboard, collects a game
 * config on the setup screen when the CLI didn't provide one, and starts /
 * stops / resumes the agent loop from the keyboard. Resolves only via
 * process.exit (quit key or force-quit).
 */
export const runTui = (launch: TuiLaunch) => {
  const store = new TuiStore();
  const sink = new TuiSink(store);

  let instance: Instance | null = null;
  let controls: RunControls | null = null;
  let cfg: RunConfig | null = null;
  let loopActive = false;
  let closed = false;
  let poller: ReturnType<typeof setInterval> | null = null;

  const teardown = () => {
    if (closed) {
      return;
    }

    closed = true;

    if (poller) {
      clearInterval(poller);
    }

    bestEffort(() => {
      instance?.unmount();
    });
  };

  const pollBacklog = () => {
    if (!cfg) {
      return;
    }

    store.set({ backlog: readBacklog(blackboard(cfg.workspace).backlog) });
  };

  const startRun = (config: RunConfig) => {
    if (loopActive) {
      return;
    }

    loopActive = true;
    cfg = config;
    store.set({
      checkpoint: null,
      directive: readDirective(blackboard(config.workspace)),
      paused: false,
      screen: "dashboard",
      setupError: null,
      stopping: false,
    });
    pollBacklog();

    const opts: AgentOptions = {
      autoDeploy: launch.autoDeploy,
      beforeForceExit: teardown,
      checkpointWaitMs: launch.checkpointWaitMs,
      codexModel: launch.codexModel,
      codexRoles: launch.codexRoles,
      context: launch.context,
      contextDir: launch.contextDir,
      idea: config.idea,
      idleTimeoutMs: launch.idleTimeoutMs,
      interval: launch.interval,
      maxCycles: launch.maxCycles,
      maxSessionMs: launch.maxSessionMs,
      maxTurns: launch.maxTurns,
      model: config.model,
      noShip: launch.noShip,
      registerControls: (c) => {
        controls = c;
      },
      runner: config.runner,
      skipPermissions: launch.skipPermissions,
      slug: config.slug,
      workspace: config.workspace,
    };

    const run = async () => {
      const ok = await runAgent(opts, sink);
      loopActive = false;
      controls = null;

      if (!ok) {
        store.set({ running: false, stopping: false, turn: null });
      }
    };

    void run();
  };

  const controller: AppController = {
    approve: () => {
      if (!cfg) {
        return;
      }

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
    continueNow: () => {
      controls?.continueNow();
    },
    defaultDirLabel: () => defaultWorkspaceLabel(),
    expandPath,
    previewSlug: (form: SetupForm) =>
      deriveSlug({
        dir: form.dir.trim() ? expandPath(form.dir) : undefined,
        idea: form.idea.trim() || undefined,
        slug: form.slug.trim() || undefined,
      }),
    quit: () => {
      if (!loopActive) {
        teardown();
        process.exit(0);
      }

      if (!store.getSnapshot().stopping) {
        controller.stop();

        return;
      }

      teardown();

      if (controls) {
        controls.forceQuit();
      } else {
        process.exit(130);
      }
    },
    redirect: (text: string) => {
      if (!cfg) {
        return;
      }

      const bb = blackboard(cfg.workspace);
      setDirective(bb, text);
      const directive = readDirective(bb);
      store.set({ directive });
      store.push(
        "marker",
        directive !== null && directive !== ""
          ? `⟶ directive: ${directive}`
          : "⟶ directive cleared",
      );

      if (store.getSnapshot().checkpoint) {
        controls?.continueNow();
      }
    },
    resume: () => {
      if (loopActive || !cfg) {
        return;
      }

      startRun(cfg);
    },
    stop: () => {
      if (!loopActive) {
        return;
      }

      store.set({ paused: false, stopping: true });
      controls?.gracefulStop();
    },
    stopAtRelease: () => {
      if (!loopActive) {
        return;
      }

      controls?.stopAtRelease();
    },
    submitSetup: (form: SetupForm) => {
      if (loopActive) {
        return;
      }

      const explicit = form.slug.trim();

      if (explicit && (normalizeSlug(explicit) ?? "") === "") {
        store.set({
          setupError: 'Slug must be lowercase letters, digits, and hyphens (e.g. "neon-slasher").',
        });

        return;
      }

      const dir = form.dir.trim() ? expandPath(form.dir) : undefined;
      const idea = form.idea.trim();
      let slug = deriveSlug({ dir, idea: idea || undefined, slug: explicit || undefined });

      if (slug === null || slug === "") {
        store.set({
          setupError:
            "What kind of game? Describe it in INSTRUCTIONS — or point FOLDER at an existing project.",
        });

        return;
      }

      if (!explicit && (dir === undefined || dir === "")) {
        slug = availableSlug(slug);
      }

      const workspace = resolveWorkspace(slug, dir);
      const fresh = !existsSync(blackboard(workspace).state);

      if (
        fresh &&
        !idea &&
        (launch.context === undefined || launch.context === "") &&
        !hasExistingProject(workspace)
      ) {
        store.set({
          setupError:
            "That folder is empty — describe the game to build in INSTRUCTIONS, or point FOLDER at an existing project.",
        });

        return;
      }

      startRun({ idea, model: form.model, runner: form.runner, slug, workspace });
    },
    togglePause: () => {
      if (!loopActive) {
        return;
      }

      const paused = !store.getSnapshot().paused;
      store.set({ paused });

      if (paused) {
        controls?.pause();
      } else {
        controls?.resume();
      }
    },
  };

  const onSignal = () => {
    if (loopActive) {
      return;
    }

    teardown();
    process.exit(130);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  instance = render(
    <App
      store={store}
      controller={controller}
      prefill={{
        dir: launch.dir ?? "",
        idea: launch.idea,
        model: launch.model,
        runner: launch.runner,
        slug: launch.slug ?? "",
      }}
    />,
    { alternateScreen: true, exitOnCtrlC: false, incrementalRendering: true, maxFps: 60 },
  );
  poller = setInterval(pollBacklog, 2000);

  if (
    (launch.slug !== undefined && launch.slug !== "") ||
    (launch.dir !== undefined && launch.dir !== "")
  ) {
    controller.submitSetup({
      dir: launch.dir ?? "",
      idea: launch.idea,
      model: launch.model,
      runner: launch.runner,
      slug: launch.slug ?? "",
    });
  }
};
