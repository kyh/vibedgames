import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { asJsonObject, asString, asNumber, isJsonString, parseJson } from "./json.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import type { Activity } from "./reporter.ts";
import type { RunOptions, RunResult } from "./runner.ts";
import { bestEffort } from "./best-effort.ts";

const RESULT_EXIT_GRACE_MS = 10_000;

const STDERR_TAIL_MAX = 16_000;

const fmtMs = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

const clip = (s: string, n: number) => {
  const flat = s.replaceAll(/\s+/gu, " ").trim();

  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

const describeError = (
  evt: Extract<StreamEvent, { type: "result" }>,
  lastText: string,
  stderr: string,
) => {
  const parts: string[] = [];

  const result = evt.result?.trim() ?? "";

  if (result !== "") {
    parts.push(result);
  } else if (evt.subtype !== undefined && evt.subtype !== "" && evt.subtype !== "success") {
    parts.push(`agent error (${evt.subtype})`);
  } else {
    parts.push("agent reported an error");
  }

  if (lastText) {
    parts.push(`last agent message: "${clip(lastText, 400)}"`);
  }

  const err = stderr.trim();

  if (err) {
    parts.push(`stderr: ${clip(err, 400)}`);
  }

  return parts.join(" — ");
};

const parseMessage: (value: JsonValue | undefined) => { content: ContentBlock[] } | null = (
  value,
) => {
  const message = asJsonObject(value);

  if (!message) {
    return null;
  }

  const content = Array.isArray(message.content) ? message.content : [];

  return {
    content: content.flatMap<ContentBlock>((block) => {
      const b = asJsonObject(block);

      if (!b) {
        return [];
      }

      if (b.type === "text") {
        return [{ text: asString(b.text), type: "text" }];
      }

      if (b.type === "tool_use") {
        return [{ input: asJsonObject(b.input), name: asString(b.name), type: "tool_use" }];
      }

      return [];
    }),
  };
};

const parseStreamEvent: (text: string) => StreamEvent | null = (text) => {
  const evt = asJsonObject(parseJson(text));

  if (!evt) {
    return null;
  }

  const type = asString(evt.type) ?? "";

  switch (type) {
    case "system": {
      return {
        model: asString(evt.model),
        session_id: asString(evt.session_id),
        subtype: asString(evt.subtype),
        tools: Array.isArray(evt.tools) ? evt.tools.filter(isJsonString) : undefined,
        type: "system",
      };
    }

    case "assistant":
    case "user": {
      return { message: parseMessage(evt.message), type };
    }

    case "result": {
      return {
        is_error: evt.is_error === true,
        num_turns: asNumber(evt.num_turns),
        result: asString(evt.result),
        session_id: asString(evt.session_id),
        subtype: asString(evt.subtype),
        total_cost_usd: asNumber(evt.total_cost_usd),
        type: "result",
      };
    }

    default: {
      return null;
    }
  }
};

const summarizeTool = (input?: JsonObject) => {
  if (!input) {
    return "";
  }

  const cmd = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.prompt;

  if (!isJsonString(cmd)) {
    return "";
  }

  const oneLine = cmd.replaceAll(/\s+/gu, " ").trim();

  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
};

const emitActivity = (onActivity: (activity: Activity) => void, evt: StreamEvent) => {
  if (evt.type === "system" && evt.subtype === "init") {
    onActivity({ kind: "init", model: evt.model, tools: evt.tools?.length ?? 0 });

    return;
  }

  if (evt.type === "assistant") {
    for (const block of evt.message?.content ?? []) {
      const text = block.type === "text" ? (block.text?.trim() ?? "") : "";

      if (text !== "") {
        onActivity({ kind: "text", text });
      } else if (block.type === "tool_use") {
        onActivity({
          detail: summarizeTool(block.input) || undefined,
          kind: "tool",
          name: block.name ?? "tool",
        });
      }
    }
  }
};

/**
 * Invoke a headless Claude Code session and stream a compact view of what it
 * does. Uses `--output-format stream-json` so the operator can watch the agent
 * work in real time; the terminal `result` event carries the final summary,
 * cost and session id.
 */
export const runClaude: (opts: RunOptions) => Promise<RunResult> = async (opts) => {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--append-system-prompt",
    opts.systemPrompt,
    "--max-turns",
    String(opts.maxTurns),
  ];

  if (opts.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (opts.resumeSessionId !== undefined && opts.resumeSessionId !== "") {
    args.push("--resume", opts.resumeSessionId);
  }

  for (const dir of opts.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  const { promise, resolve } = Promise.withResolvers<RunResult>();

  let child: ReturnType<typeof spawn> | undefined;
  let rl: ReturnType<typeof createInterface> | undefined;
  let final: RunResult = { ok: false, result: "" };
  let gotResult = false;
  let stderr = "";
  let settled = false;
  let sessionId: string | undefined;
  let lastText = "";
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;

  const settle = (res: RunResult) => {
    if (settled) {
      return;
    }

    settled = true;

    if (graceTimer) {
      clearTimeout(graceTimer);
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    if (sessionTimer) {
      clearTimeout(sessionTimer);
    }

    bestEffort(() => {
      rl?.close();
    });
    bestEffort(() => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
    });
    resolve(res);
  };

  const pokeIdle = () => {
    if (opts.idleTimeoutMs <= 0 || settled || gotResult) {
      return;
    }

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
      bestEffort(() => {
        child?.kill("SIGKILL");
      });
      settle({
        error: `no output for ${fmtMs(opts.idleTimeoutMs)} — treating claude as hung`,
        ok: false,
        result: "",
        sessionId,
      });
    }, opts.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const env: NodeJS.ProcessEnv = { ...process.env };
  const isRoot = process.getuid?.() === 0;

  if (opts.skipPermissions && isRoot && env.IS_SANDBOX !== "1") {
    env.IS_SANDBOX = "1";
  }

  try {
    child = spawn(opts.bin, args, {
      cwd: opts.cwd,
      env,
      signal: opts.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    settle({
      error: `failed to spawn ${opts.bin}: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
      result: "",
    });

    return await promise;
  }

  pokeIdle();

  if (opts.maxSessionMs > 0) {
    sessionTimer = setTimeout(() => {
      bestEffort(() => {
        child?.kill("SIGKILL");
      });
      settle({
        error: `exceeded the ${fmtMs(opts.maxSessionMs)} session limit — killed`,
        ok: false,
        result: "",
        sessionId,
      });
    }, opts.maxSessionMs);
    sessionTimer.unref?.();
  }

  const onResult = (evt: ResultEvent) => {
    gotResult = true;

    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    if (sessionTimer) {
      clearTimeout(sessionTimer);
    }

    final = {
      costUsd: evt.total_cost_usd,
      error: evt.is_error === true ? describeError(evt, lastText, stderr) : undefined,
      numTurns: evt.num_turns,
      ok: evt.subtype === "success" && evt.is_error !== true,
      result: evt.result ?? "",
      sessionId: evt.session_id ?? sessionId,
    };

    if (graceTimer) {
      return;
    }

    graceTimer = setTimeout(() => {
      bestEffort(() => {
        child?.kill("SIGKILL");
      });
      settle(final);
    }, RESULT_EXIT_GRACE_MS);
    graceTimer.unref?.();
  };

  if (child.stdout) {
    rl = createInterface({ input: child.stdout });
  }

  if (!rl) {
    settle({ error: "claude produced no stdout pipe", ok: false, result: "", sessionId });

    return await promise;
  }

  rl.on("line", (line) => {
    pokeIdle();
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    const evt = parseStreamEvent(trimmed);

    if (evt === null) {
      return;
    }

    emitActivity(opts.onActivity, evt);

    if (
      evt.type === "system" &&
      evt.subtype === "init" &&
      evt.session_id !== undefined &&
      evt.session_id !== ""
    ) {
      sessionId = evt.session_id;
    }

    if (evt.type === "assistant") {
      for (const block of evt.message?.content ?? []) {
        const text = block.type === "text" ? (block.text?.trim() ?? "") : "";

        if (text !== "") {
          lastText = text;
        }
      }
    }

    if (evt.type === "result") {
      onResult(evt);
    }
  });

  child.stderr?.on("data", (d: Buffer) => {
    pokeIdle();
    stderr = (stderr + d.toString()).slice(-STDERR_TAIL_MAX);
  });

  child.on("error", (err: Error) => {
    settle({ error: `${opts.bin}: ${err.message}`, ok: false, result: "" });
  });

  child.on("close", (code) => {
    if (gotResult) {
      settle(final);

      return;
    }

    settle({
      error: stderr.trim() || `claude exited with code ${code} without a result event`,
      ok: false,
      result: "",
      sessionId,
    });
  });

  return await promise;
};

interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
}

type StreamEvent =
  | { type: "system"; subtype?: string; model?: string; tools?: string[]; session_id?: string }
  | { type: "assistant"; message: { content: ContentBlock[] } | null }
  | { type: "user"; message: { content: ContentBlock[] } | null }
  | ResultEvent;

type ContentBlock =
  | { type: "text"; text?: string }
  | { type: "tool_use"; name?: string; input?: JsonObject };
