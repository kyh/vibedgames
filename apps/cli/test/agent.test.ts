import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import type {
  AgentConfig,
  AgentEnv,
  AgentKeyInit,
  AgentPointer,
  AgentRequest,
  AgentResult,
  AgentSample,
  Reflex,
} from "../src/lib/playtest/agent.js";
import { browserEnv, inPageAgent } from "../src/lib/playtest/agent.js";
import { keyInitsFor, keyTable } from "../src/lib/playtest/keys.js";

/**
 * The in-page agent, driven against a fake page: a scripted "model" answers
 * from the criteria it was offered, the fake records every dispatched
 * event, and time is a counter. A decision resolves on the next animation
 * frame, the way a real one takes at least a frame, so windows have frames
 * in them. What matters is the loop's contract — what it asks, what it
 * holds, what it records, when it stops — not the browser.
 */

interface Dispatched {
  kind: "key" | "pointer";
  type: string;
  code?: string;
  pointer?: AgentPointer;
}

interface FakeAnswer {
  type: string;
  choice?: string;
  confidence?: number;
  noul?: number;
  score?: number;
}

interface FakeReply {
  ok: boolean;
  status: number;
  body: string;
}

interface AnswerScript {
  /** Called per request with the offered move labels; returns the move to pick. */
  pick: (offered: string[], tick: number) => string;
  actionProbability?: number;
  /** The `progress` score answer per tick, in levels (0–4); omitted = the model gave none. */
  progress?: (tick: number) => number;
  status?: number;
  failTimes?: number;
}

interface FakePage {
  env: AgentEnv;
  dispatched: Dispatched[];
  requests: AgentRequest[];
  published: AgentResult | null;
  /** Advance the clock, run one animation frame, and deliver any decision in flight. */
  frame: (ms?: number) => void;
  /** Let every pending microtask and due timer settle. */
  settle: () => Promise<void>;
  sample: AgentSample;
  ballX: number;
}

const makePage = (script: AnswerScript, reflexes: Record<string, Reflex> = {}): FakePage => {
  let now = 1000;
  let frames: (() => void)[] = [];
  const timers: { at: number; resolve: () => void }[] = [];
  const inFlight: (() => void)[] = [];
  let failuresLeft = script.failTimes ?? 0;

  const fireDueTimers = (): void => {
    const due = timers.filter((t) => t.at <= now);
    for (const timer of due) {
      timers.splice(timers.indexOf(timer), 1);
      timer.resolve();
    }
  };

  const answer = (init: AgentRequest): FakeReply => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return { body: "down", ok: false, status: 503 };
    }
    if (script.status !== undefined && script.status !== 200) {
      return { body: "nope", ok: false, status: script.status };
    }
    const body = JSON.parse(init.body);
    const offered = Object.keys(body.questions.move.criteria);
    const choice = script.pick(offered, body.state.tick.index);
    const answers = new Map<string, FakeAnswer>([
      ["move", { choice, confidence: 0.75, type: "choice" }],
    ]);
    if (script.progress !== undefined) {
      answers.set("progress", { score: script.progress(body.state.tick.index), type: "score" });
    }
    for (const key of Object.keys(body.questions)) {
      if (key.startsWith("act:")) {
        answers.set(key, { noul: script.actionProbability ?? 0.1, type: "noul" });
      }
    }
    return {
      body: JSON.stringify({
        answers: Object.fromEntries(answers),
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
      ok: true,
      status: 200,
    };
  };

  const page: FakePage = {
    ballX: 0.25,
    dispatched: [],
    env: {
      caf: () => {
        frames = [];
      },
      delay: (ms) =>
        // oxlint-disable-next-line promise/avoid-new -- a fake timer has nothing to await but a promise it resolves itself
        new Promise<void>((resolve) => {
          timers.push({ at: now + ms, resolve });
        }),
      dispatchKey: (type, init) => {
        page.dispatched.push({ code: init.code, kind: "key", type });
      },
      dispatchPointer: (pointer, type) => {
        page.dispatched.push({ kind: "pointer", pointer, type });
      },
      fetch: (_url, init) => {
        page.requests.push(init);
        const reply = answer(init);
        // oxlint-disable-next-line promise/avoid-new -- delivered by the next frame, like a real round trip
        return new Promise((resolve) => {
          inFlight.push(() => {
            now += 40;
            resolve({
              ok: reply.ok,
              status: reply.status,
              text: () => Promise.resolve(reply.body),
            });
          });
        });
      },
      live: () => ({ player: { x: page.sample.x, y: page.sample.y } }),
      now: () => now,
      publish: (result) => {
        page.published = result;
      },
      raf: (frame) => {
        frames.push(frame);
        return frames.length;
      },
      read: () => ({ ...page.sample }),
      reflexFor: (label) => reflexes[label] ?? null,
      snapshot: () => ({
        frame: page.sample.frame,
        player: { x: page.sample.x, y: page.sample.y },
      }),
    },
    frame: (ms = 16) => {
      now += ms;
      page.sample.frame += 1;
      const due = frames;
      frames = [];
      for (const frame of due) {
        frame();
      }
      const deliveries = inFlight.splice(0);
      for (const deliver of deliveries) {
        deliver();
      }
    },
    published: null,
    requests: [],
    sample: { complete: false, frame: 0, score: 0, x: 0, y: 0, z: 0 },
    settle: async () => {
      for (let i = 0; i < 20; i += 1) {
        fireDueTimers();
        await nextTurn();
      }
    },
  };
  return page;
};

const inits = (codes: string[]): AgentKeyInit[] => keyInitsFor(codes);

const config = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  actionThreshold: 0.5,
  actions: { jump: { description: "jump", inits: inits(["Space"]) } },
  decideUrl: "https://vibedgames.test/api/playtest/decide",
  decisionRetries: 2,
  decisionTimeoutMs: 1000,
  finalHoldMs: 100,
  goal: "Go right.",
  keyTable: keyTable(),
  model: "jev-latest",
  motionEpsilon: 0.2,
  move: {
    left: { description: "Move left", inits: inits(["KeyA"]), pointer: null },
    none: { description: "Stay still", inits: [], pointer: null },
    right: { description: "Move right", inits: inits(["KeyD"]), pointer: null },
    track: { description: "Follow the ball", inits: [], pointer: null },
  },
  stuckRun: 2,
  tickMs: 0,
  ticks: 3,
  token: "pt.test",
  trailLength: 6,
  ...overrides,
});

/** Run the agent to completion, moving the player and advancing a frame each round. */
const complete = async (
  page: FakePage,
  cfg: AgentConfig,
  movePerFrame = 1,
): Promise<AgentResult> => {
  const result = inPageAgent(cfg, page.env);
  for (let i = 0; i < 200 && !result.done; i += 1) {
    page.sample.x += movePerFrame;
    page.frame();
    await page.settle();
  }
  assert.ok(result.done, "the agent should finish");
  return result;
};

const keyEvents = (page: FakePage): string[] =>
  page.dispatched.filter((d) => d.kind === "key").map((d) => `${d.type}:${d.code}`);

test("asks one choice for movement, a progress score, and one yes/no per action, with the token", async () => {
  const page = makePage({ pick: () => "right", progress: (tick) => tick * 2 });
  const result = await complete(page, config({ ticks: 2 }));
  assert.equal(result.error, null);
  assert.equal(page.requests.length, 2);
  const [first, second] = page.requests;
  assert.ok(first && second);
  assert.equal(first.headers.authorization, "Bearer pt.test");
  const body = JSON.parse(first.body);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions), ["move", "progress", "act:jump"]);
  assert.equal(body.questions.progress.type, "score");
  assert.equal(body.questions.progress.criteria.length, 5);
  // Levels 0 and 2 of 4, normalised to 0–1.
  assert.deepEqual(
    result.records.map((r) => r.progress),
    [0, 0.5],
  );
  assert.deepEqual(Object.keys(body.questions.move.criteria).toSorted(), [
    "left",
    "none",
    "right",
    "track",
  ]);
  assert.equal(body.questions["act:jump"].type, "noul");
  assert.equal(body.state.goal, "Go right.");
  assert.deepEqual(body.state.tick, { index: 0, of: 2 });
  assert.equal(body.state.recent.held, null);
  assert.deepEqual(JSON.parse(second.body).state.recent.held, { actions: [], move: "right" });
});

test("holds the chosen move and actions as key events, releasing on change and at the end", async () => {
  const page = makePage({
    actionProbability: 0.9,
    pick: (_, tick) => (tick === 0 ? "right" : "left"),
  });
  const result = await complete(page, config({ ticks: 2 }));
  assert.equal(result.error, null);
  assert.deepEqual(keyEvents(page), [
    "keydown:KeyD",
    "keydown:Space",
    "keyup:KeyD",
    "keydown:KeyA",
    "keyup:KeyA",
    "keyup:Space",
  ]);
  assert.deepEqual(
    result.records.map((r) => r.actions),
    [["jump"], ["jump"]],
  );
  assert.equal(page.published, result, "published on the page for the CLI to poll");
});

test("records a window per decision with usage, and measures motion under it", async () => {
  const page = makePage({ pick: () => "right" });
  const result = await complete(page, config({ ticks: 3 }), 2);
  assert.equal(result.error, null);
  assert.deepEqual(
    result.records.map((r) => r.tick),
    [0, 1, 2],
  );
  for (const record of result.records) {
    assert.equal(record.move, "right");
    assert.equal(record.askedToMove, true);
    assert.equal(record.confidence, 0.75);
    assert.equal(record.progress, null, "a model that gave no score is recorded as none");
    assert.equal(record.inputTokens, 100);
    assert.ok(record.window.peak > 0, "the player moved during the window");
    assert.ok(record.window.frame > record.window.frameBefore);
  }
  assert.equal(result.usage.calls, 3);
  assert.equal(result.usage.inputTokens, 300);
  assert.ok(result.wallMs > 0);
});

test("withdraws a move that produced nothing twice, and only that move", async () => {
  const offeredPerTick: string[][] = [];
  const page = makePage({
    pick: (offered) => {
      offeredPerTick.push(offered.toSorted());
      return offered.includes("right") ? "right" : "left";
    },
  });
  // The player never moves, so `right` is stuck from the first window.
  const result = await complete(page, config({ ticks: 5 }), 0);
  assert.equal(result.error, null);
  assert.deepEqual(offeredPerTick[0], ["left", "none", "right", "track"]);
  assert.deepEqual(
    offeredPerTick[1],
    ["left", "none", "right", "track"],
    "one still window is a wall",
  );
  const withdrawn = offeredPerTick.findIndex((offered) => !offered.includes("right"));
  assert.ok(withdrawn > 1, "two still windows in a row withdraw the move");
  assert.deepEqual(offeredPerTick[withdrawn], ["left", "none", "track"]);
  assert.ok(
    result.records.filter((r) => r.move === "right").length >= 2,
    "the withdrawn move was tried at least twice",
  );
});

test("runs an option's reflex every frame and holds what it returns", async () => {
  let calls = 0;
  const page = makePage(
    { pick: () => "track" },
    {
      track: () => {
        calls += 1;
        return { keys: ["KeyD"], pointer: { x: page.ballX, y: 0.5 } };
      },
    },
  );
  const result = await complete(page, config({ ticks: 2 }));
  assert.equal(result.error, null);
  assert.ok(calls > 0, "the reflex ran");
  assert.ok(result.records.every((r) => r.reflexFrames > 0));
  assert.ok(
    result.records.every((r) => r.askedToMove),
    "a reflex-only option still asks to move",
  );
  const firstMove = page.dispatched.find((d) => d.kind === "pointer" && d.type === "pointermove");
  assert.equal(firstMove?.pointer?.x, 0.25);
  assert.ok(keyEvents(page).includes("keydown:KeyD"));
  // The pointer never changed, so it was dispatched once, not once per frame.
  assert.equal(page.dispatched.filter((d) => d.type === "pointermove").length, 1);
});

test("stops on a rejected token without retrying, and retries an upstream fault", async () => {
  const rejected = makePage({ pick: () => "right", status: 401 });
  const failed = await complete(rejected, config({ ticks: 2 }));
  assert.match(failed.error ?? "", /HTTP 401/u);
  assert.equal(rejected.requests.length, 1);
  assert.deepEqual(failed.records, []);

  const flaky = makePage({ failTimes: 1, pick: () => "right" });
  const recovered = await complete(flaky, config({ ticks: 1 }));
  assert.equal(recovered.error, null);
  assert.equal(flaky.requests.length, 2, "one failure, one success");
});

test("stop() ends the run and releases everything held", async () => {
  const page = makePage({ pick: () => "right" });
  const result = inPageAgent(config({ ticks: 50 }), page.env);
  for (let i = 0; i < 3; i += 1) {
    page.frame();
    await page.settle();
  }
  assert.ok(keyEvents(page).includes("keydown:KeyD"), "something is held");
  result.stop();
  for (let i = 0; i < 10 && !result.done; i += 1) {
    page.frame();
    await page.settle();
  }
  assert.ok(result.done);
  assert.equal(keyEvents(page).at(-1), "keyup:KeyD", "nothing stays held");
  assert.ok(page.requests.length < 50);
});

test("both injected functions survive being stringified into a fresh scope", async () => {
  // In the page nothing from this module exists, so a helper that leaked to
  // module scope would be a ReferenceError there — and only there. Evaluate
  // the same source in a scope with none of this module's bindings. (`__name`
  // is the one thing supplied: tsx's esbuild transform annotates functions
  // with it, where the real tsc build emits nothing of the kind.)
  const source = `(${inPageAgent.toString()})`;
  // oxlint-disable-next-line no-new-func -- the point is a scope with no module bindings, which only Function gives
  const factory = new Function("__name", "config", "env", `return ${source}(config, env);`);
  // SAFETY: the Function was built from inPageAgent's own source, so it has inPageAgent's signature.
  const rebuilt = factory as (
    keep: <T>(fn: T) => T,
    cfg: AgentConfig,
    env: AgentEnv,
  ) => AgentResult;
  const page = makePage({ actionProbability: 0.9, pick: () => "right" });
  const result = rebuilt((fn) => fn, config({ ticks: 2 }), page.env);
  for (let i = 0; i < 100 && !result.done; i += 1) {
    page.sample.x += 1;
    page.frame();
    await page.settle();
  }
  assert.ok(result.done);
  assert.equal(result.error, null);
  assert.equal(result.records.length, 2);
  // The browser env only references page globals, which a parse check can prove.
  // oxlint-disable-next-line no-new-func -- parse-only check of the stringified source
  assert.doesNotThrow(() => new Function(`return (${browserEnv.toString()})`));
});
