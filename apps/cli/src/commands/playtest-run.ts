import { defineCommand } from "citty";
import { consola } from "consola";

import type { JsonValue } from "../lib/types.js";
import type { Controls } from "../lib/playtest/controls.js";
import type { RunOptions, Session } from "../lib/playtest/run.js";
import { authErrorCode, createClient } from "../lib/api.js";
import { getBaseUrl, getToken } from "../lib/config.js";
import { outputArgs, writeStructured } from "../lib/output.js";
import { GameBrowser } from "../lib/playtest/browser.js";
import {
  DEFAULT_PRESET,
  PRESETS,
  PRESET_NAMES,
  parseControls,
  readControlsArg,
} from "../lib/playtest/controls.js";
import { HarnessError } from "../lib/playtest/errors.js";
import { buildReport, runInPage, verdict } from "../lib/playtest/run.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { ensureAgentBrowser, projectSessionId, resolveGameUrl } from "./playtest.js";

/**
 * `vg playtest run` — let a model play the game, and report how it went.
 *
 * The loop runs inside the game's page: several times a second it reads
 * `window.__GAME_DIAGNOSTICS__`, asks the decision model (via
 * `/api/playtest-decide` with a short-lived token; the server holds the
 * provider key) which movement to hold and which actions to take, dispatches
 * them as real held input, and repeats — with a per-frame reflex where the
 * game's `__GAME_PLAYTEST__` provides one. Code does perception and
 * keystrokes; the model only decides.
 *
 * Exit 0 = the game plays under the model. Exit 1 = it doesn't (the report
 * says why). Exit 2 = the harness itself failed (bad flags, no browser, the
 * game never booted, the model unreachable).
 */

const HARNESS_FAILURE = 2;

/**
 * Floor on the hold, so a fast model doesn't play at a jittery superhuman
 * rate: ~6 decisions a second is a quick human's cadence. A real decision
 * round trip is usually longer than this, in which case it never binds.
 */
const DEFAULT_TICK_MS = 150;

const runArgs = {
  controls: {
    description: `Control scheme: a preset (${PRESET_NAMES.join(", ")}) or a JSON file. Default: the game's window.__GAME_PLAYTEST__ if it publishes one, else ${DEFAULT_PRESET}.`,
    type: "string",
  },
  expectProgress: {
    description: "Assert the objective advances (score rises) during the run.",
    type: "boolean",
  },
  game: {
    description: "Deployed game slug to playtest (mutually exclusive with --url).",
    type: "string",
  },
  goal: {
    description:
      "What the playtester is trying to do — what wins, what kills, which way is progress. Overrides the scheme's goal.",
    type: "string",
  },
  headed: { description: "Show the browser.", type: "boolean" },
  keepOpen: { description: "Leave the page open afterwards.", type: "boolean" },
  model: { default: "jev-latest", description: "Decision model id.", type: "string" },
  seed: { default: "12345", description: "Seed for the game's RNG.", type: "string" },
  tickMs: {
    default: String(DEFAULT_TICK_MS),
    description: `Minimum time each decision's inputs stay held (ms). The default caps the playtester near a fast player's cadence; 0 = as fast as decisions arrive.`,
    type: "string",
  },
  ticks: { default: "60", description: "Decisions to make.", type: "string" },
  url: {
    description: "Where the game is served (mutually exclusive with --game).",
    type: "string",
  },
  ...outputArgs,
} as const;

interface ParsedArgs {
  controls?: string;
  expectProgress?: boolean;
  game?: string;
  goal?: string;
  headed?: boolean;
  keepOpen?: boolean;
  model: string;
  seed: string;
  tickMs: string;
  ticks: string;
  url?: string;
}

const numberArg = (
  raw: string,
  flag: string,
  check: (n: number) => boolean,
  hint: string,
): number => {
  // `Number("")` is 0, not NaN, so an empty value would slip past otherwise.
  const value = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!check(value)) {
    throw new HarnessError(`\`${flag}\` must be ${hint}.`);
  }
  return value;
};

interface Settings {
  explicitControls: Controls | null;
  expectProgress: boolean;
  goal: string | null;
  headed: boolean;
  keepOpen: boolean;
  model: string;
  seed: number;
  target: string;
  tickMs: number;
  ticks: number;
  url: string;
}

const settingsFrom = (args: ParsedArgs): Settings => {
  if (!args.url && !args.game) {
    throw new HarnessError("Pass --url <url> or --game <slug>.");
  }
  if (args.url && args.game) {
    throw new HarnessError("Pass either --url or --game, not both.");
  }
  if (args.goal !== undefined && args.goal.trim() === "") {
    throw new HarnessError("`--goal` must not be empty.");
  }
  if (args.model.trim() === "") {
    throw new HarnessError("`--model` must not be empty.");
  }
  return {
    expectProgress: args.expectProgress === true,
    explicitControls: args.controls === undefined ? null : readControlsArg(args.controls),
    goal: args.goal ?? null,
    headed: args.headed === true,
    keepOpen: args.keepOpen === true,
    model: args.model,
    seed: numberArg(args.seed, "--seed", Number.isFinite, "a finite number"),
    target: args.game ? `game:${args.game}` : (args.url ?? ""),
    tickMs: numberArg(
      args.tickMs,
      "--tick-ms",
      (n) => Number.isFinite(n) && n >= 0 && n <= 5000,
      "between 0 and 5000 milliseconds",
    ),
    ticks: numberArg(
      args.ticks,
      "--ticks",
      (n) => Number.isInteger(n) && n > 0,
      "a positive integer",
    ),
    url: args.url ?? resolveGameUrl(args.game ?? null),
  };
};

/**
 * Which scheme drives this run: an explicit `--controls`, else the game's
 * own manifest, else the wasd preset. `--goal` wins over all of them.
 */
const chooseControls = (settings: Settings, manifest: JsonValue | null): Controls => {
  let controls: Controls | null | undefined = settings.explicitControls;
  if (!controls) {
    controls =
      manifest === null
        ? PRESETS.get(DEFAULT_PRESET)
        : parseControls(manifest, "window.__GAME_PLAYTEST__");
  }
  if (!controls) {
    throw new HarnessError("no control scheme available.");
  }
  return settings.goal === null ? controls : { ...controls, goal: settings.goal };
};

/**
 * A token for this run, from `playtest.session`, and where the page should
 * send decisions. The token is all the (untrusted) game page ever holds.
 */
const mintSession = async (client: ReturnType<typeof createClient>): Promise<Session> => {
  try {
    const { token } = await client.playtest.session();
    return { decideUrl: new URL("/api/playtest-decide", getBaseUrl()).toString(), token };
  } catch (error) {
    const code = authErrorCode(error);
    if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
      throw new HarnessError(
        "Not authenticated. Run `vg login`, or check your VG_TOKEN / API key.",
      );
    }
    throw new HarnessError(
      `couldn't start a playtest session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const summarize = (
  report: ReturnType<typeof buildReport>,
  failures: string[],
  warnings: string[],
): void => {
  const rate = report.decisionsPerSecond === null ? "" : ` at ${report.decisionsPerSecond}/s`;
  consola.log(
    `The model made ${report.ticksRun} decisions${rate} (mean ${report.model.meanDecisionMs ?? "?"} ms each) on ${report.target}`,
  );
  consola.log(
    `  frames +${report.framesAdvanced}  moved ${report.distanceTravelled} (peak ${report.maxTickDisplacement}/tick)  score ${report.scoreBefore} → ${report.scoreAfter}  stuck ${report.stuckTicks} (longest run ${report.longestStuckRun})`,
  );
  const moves = Object.entries(report.decisions.moves)
    .map(([label, count]) => `${label}×${count}`)
    .join(" ");
  consola.log(
    `  moves: ${moves || "none"}  confidence ${report.decisions.meanConfidence ?? "n/a"}  tokens ${report.model.inputTokens}`,
  );
  for (const warning of warnings) {
    consola.warn(warning);
  }
  if (failures.length > 0) {
    consola.error(`FAILED — ${failures.join("; ")}`);
  } else {
    consola.success("PASSED");
  }
};

export const playtestRunCommand = defineCommand({
  args: runArgs,
  meta: {
    description:
      "Let a model play the game and report how it went — reads the game's diagnostics each tick, decides what to hold, drives real input. Needs the diagnostics contract (see the playtest skill).",
    name: "run",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, runArgs);

    let settings: Settings;
    try {
      settings = settingsFrom(args);
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error));
      process.exit(HARNESS_FAILURE);
    }

    if (!getToken()) {
      consola.warn("Not logged in. Run `vg login` to authenticate.");
      process.exit(1);
    }
    const client = createClient();

    const { bin } = ensureAgentBrowser();
    const browser = new GameBrowser(bin, process.env.AGENT_BROWSER_SESSION ?? projectSessionId());

    // Ctrl-C mid-hold leaves the key down and the sampler running in a daemon
    // page that outlives this process — the same poison an early exit causes.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        browser.stopAgent();
        process.exit(HARNESS_FAILURE);
      });
    }

    let opts: RunOptions;
    let payload: ReturnType<typeof buildReport> & { failures: string[]; warnings: string[] };
    try {
      const session = await mintSession(client);
      const launched = browser.launch({
        headed: settings.headed,
        seed: settings.seed,
        url: settings.url,
      });
      opts = {
        controls: chooseControls(settings, launched.manifest),
        expectProgress: settings.expectProgress,
        model: settings.model,
        tickMs: settings.tickMs,
        ticks: settings.ticks,
      };
      const run = await runInPage(browser, opts, session);
      const report = buildReport(opts, {
        before: launched.before,
        consoleErrors: browser.consoleErrors(),
        gpu: browser.gpuInfo(),
        pageErrors: browser.pageErrors(),
        run,
        seed: settings.seed,
        seedApplied: launched.seedApplied,
        target: settings.target,
      });
      payload = { ...report, ...verdict(report, opts) };
    } catch (error) {
      browser.stopAgent();
      const message = error instanceof Error ? error.message : String(error);
      consola.error(
        error instanceof HarnessError ? message : `playtest harness failed: ${message}`,
      );
      process.exit(HARNESS_FAILURE);
    }

    if (!settings.keepOpen) {
      browser.close();
    }

    if (!writeStructured(payload, args)) {
      summarize(payload, payload.failures, payload.warnings);
    }
    if (payload.failures.length > 0) {
      process.exit(1);
    }
  },
});
