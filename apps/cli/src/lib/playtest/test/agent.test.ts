import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { runInNewContext, Script } from "node:vm";

import { repeatWhile } from "@repo/contract/run-in-order";
import { z } from "zod";

import type {
  AgentConfig,
  AgentEnv,
  AgentPointer,
  AgentRequest,
  AgentResponse,
  AgentResult,
  AgentSample,
  Reflex,
} from "../agent.js";
import { browserEnv, inPageAgent } from "../agent.js";
import { keyInitsFor, keyTable } from "../keys.js";

const repeatRounds = async (
  rounds: number,
  step: () => Promise<void>,
  until: () => boolean = () => false,
) => {
  await repeatWhile(async (round) => {
    if (round >= rounds || until()) {
      return false;
    }

    await step();

    return true;
  });
};

const sentDecision = z.object({
  model: z.string(),
  questions: z.record(
    z.string(),
    z.looseObject({
      criteria: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
      type: z.string(),
    }),
  ),
  state: z.looseObject({
    goal: z.string().nullable(),
    recent: z.looseObject({ held: z.json() }),
    tick: z.object({ index: z.number(), of: z.number() }),
  }),
});

const readSent = (body: string) => sentDecision.parse(JSON.parse(body));

const criteriaOf = (body: z.infer<typeof sentDecision>, key: string) =>
  body.questions[key]?.criteria ?? [];

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

interface AnswerScript {
  pick: (offered: string[], tick: number) => string;
  actionProbability?: number;
  progress?: (tick: number) => number;
  status?: number;
  failTimes?: number;
}

interface FakePage {
  env: AgentEnv;
  dispatched: Dispatched[];
  requests: AgentRequest[];
  published: AgentResult | null;
  frame: (ms?: number) => void;
  settle: () => Promise<void>;
  sample: AgentSample;
  ballX: number;
}

const makePage = (script: AnswerScript, reflexes: Record<string, Reflex> = {}) => {
  let now = 1000;
  let frames: (() => void)[] = [];
  const timers: { at: number; resolve: (at: number) => void }[] = [];
  const inFlight: (() => void)[] = [];
  let failuresLeft = script.failTimes ?? 0;

  const fireDueTimers = () => {
    const due = timers.filter((t) => t.at <= now);

    for (const timer of due) {
      timers.splice(timers.indexOf(timer), 1);
      timer.resolve(timer.at);
    }
  };

  const answer = (init: AgentRequest) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;

      return { body: "down", ok: false, status: 503 };
    }

    if (script.status !== undefined && script.status !== 200) {
      return { body: "nope", ok: false, status: script.status };
    }

    const body = readSent(init.body);
    const offered = Object.keys(criteriaOf(body, "move"));
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
      delay: async (ms) => {
        const { promise, resolve } = Promise.withResolvers<number>();
        timers.push({ at: now + ms, resolve });

        await promise;
      },
      dispatchKey: (type, init) => {
        page.dispatched.push({ code: init.code, kind: "key", type });
      },
      dispatchPointer: (pointer, type) => {
        page.dispatched.push({ kind: "pointer", pointer, type });
      },
      fetch: async (_url, init) => {
        page.requests.push(init);
        const reply = answer(init);

        const { promise, resolve } = Promise.withResolvers<AgentResponse>();
        inFlight.push(() => {
          now += 40;
          resolve({
            ok: reply.ok,
            status: reply.status,
            text: async () => await Promise.resolve(reply.body),
          });
        });

        return await promise;
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
      await repeatRounds(20, async () => {
        fireDueTimers();
        await nextTurn();
      });
    },
  };

  return page;
};

const inits = (codes: string[]) => keyInitsFor(codes);

const config = (overrides: Partial<AgentConfig> = {}) => ({
  actionThreshold: 0.5,
  actions: { jump: { description: "jump", inits: inits(["Space"]) } },
  decideUrl: "https://vibedgames.test/api/playtest/decide",
  decisionRetries: 2,
  decisionTimeoutMs: 1000,
  finalHoldMs: 100,
  goal: "Go right.",
  idleRestTicks: 8,
  idleRun: 3,
  keyTable: keyTable(),
  model: "jev-latest",
  motionEpsilon: 0.2,
  move: {
    left: { description: "Move left", inits: inits(["KeyA"]), pointer: null },
    none: { description: "Stay still", inits: [], pointer: null },
    right: { description: "Move right", inits: inits(["KeyD"]), pointer: null },
    track: { description: "Follow the ball", inits: [], pointer: null },
  },
  pinMove: null,
  stuckRun: 2,
  tickMs: 0,
  ticks: 3,
  token: "pt.test",
  trailLength: 6,
  ...overrides,
});

const complete = async (page: FakePage, cfg: AgentConfig, movePerFrame = 1) => {
  const result = inPageAgent(cfg, page.env);

  await repeatRounds(
    200,
    async () => {
      page.sample.x += movePerFrame;
      page.frame();
      await page.settle();
    },
    () => result.done,
  );

  assert.ok(result.done, "the agent should finish");

  return result;
};

const keyEvents = (page: FakePage) =>
  page.dispatched.filter((d) => d.kind === "key").map((d) => `${d.type}:${d.code}`);

test("asks one choice for movement, a progress score, and one yes/no per action, with the token", async () => {
  const page = makePage({ pick: () => "right", progress: (tick) => tick * 2 });
  const result = await complete(page, config({ ticks: 2 }));
  assert.equal(result.error, null);
  assert.equal(page.requests.length, 2);
  const [first, second] = page.requests;
  assert.ok(first && second);
  assert.equal(first.headers.authorization, "Bearer pt.test");
  const body = readSent(first.body);
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(Object.keys(body.questions), ["move", "progress", "act:jump"]);
  assert.equal(body.questions.progress?.type, "score");
  assert.equal(Object.keys(criteriaOf(body, "progress")).length, 5);
  assert.deepEqual(
    result.records.map((r) => r.progress),
    [0, 0.5],
  );
  assert.deepEqual(Object.keys(criteriaOf(body, "move")).toSorted(), [
    "left",
    "none",
    "right",
    "track",
  ]);
  assert.equal(body.questions["act:jump"]?.type, "noul");
  assert.equal(body.state.goal, "Go right.");
  assert.deepEqual(body.state.tick, { index: 0, of: 2 });
  assert.equal(body.state.recent.held, null);
  assert.deepEqual(readSent(second.body).state.recent.held, { actions: [], move: "right" });
});

test("holds the chosen move, and presses a repeated action again on each decision", async () => {
  const page = makePage({
    actionProbability: 0.9,
    pick: (_, tick) => (tick === 0 ? "right" : "left"),
  });

  const result = await complete(page, config({ ticks: 2 }));
  assert.equal(result.error, null);
  assert.deepEqual(keyEvents(page), [
    "keydown:KeyD",
    "keydown:Space",
    "keyup:Space",
    "keyup:KeyD",
    "keydown:KeyA",
    "keydown:Space",
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

test("withdraws a move that produced nothing twice, then the next one, until the player moves", async () => {
  const offeredPerTick: string[][] = [];

  const page = makePage({
    pick: (offered) => {
      offeredPerTick.push(offered.toSorted());

      if (offered.includes("right")) {
        return "right";
      }

      return offered.includes("left") ? "left" : "none";
    },
  });

  const result = await complete(page, config({ idleRun: 99, ticks: 9 }), 0);
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
  assert.deepEqual(offeredPerTick.at(-1), ["none", "track"]);
});

test("rests the no-input option after the model idles, then offers it again", async () => {
  const offeredPerTick: string[][] = [];

  const page = makePage({
    pick: (offered) => {
      offeredPerTick.push(offered.toSorted());

      return offered.includes("none") ? "none" : "right";
    },
  });

  const result = await complete(page, config({ idleRestTicks: 2, ticks: 8 }), 0);
  assert.equal(result.error, null);
  const rested = offeredPerTick.findIndex((offered) => !offered.includes("none"));
  assert.ok(rested >= 3, "three idle decisions come first");
  assert.ok(
    offeredPerTick.slice(rested + 2).some((offered) => offered.includes("none")),
    "the rest is temporary",
  );
});

test("a parked pointer that has arrived is not a stuck player", async () => {
  const page = makePage({ pick: () => "park" });

  const result = await complete(
    page,
    config({
      move: {
        none: { description: "stay", inits: [], pointer: null },
        park: { description: "park", inits: [], pointer: { down: false, x: 0.5, y: 0.5 } },
      },
      ticks: 4,
    }),
    0,
  );

  assert.equal(result.error, null);
  assert.ok(result.records.every((r) => !r.askedToMove));
});

test("gives up on a decision that never answers", async () => {
  const page = makePage({ pick: () => "right" });
  page.env.fetch = async () =>
    // oxlint-disable-next-line promise/avoid-new -- a request that hangs forever
    await new Promise(() => {});
  const result = inPageAgent(config({ decisionRetries: 0, ticks: 1 }), page.env);

  await repeatRounds(
    10,
    async () => {
      page.frame(500);
      await page.settle();
    },
    () => result.done,
  );

  assert.match(result.error ?? "", /no answer within 1000 ms/u);
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
    result.records.every((r) => !r.askedToMove),
    "a converged reflex holds still on purpose, so its windows are never stuck",
  );
  const firstMove = page.dispatched.find((d) => d.kind === "pointer" && d.type === "pointermove");
  assert.equal(firstMove?.pointer?.x, 0.25);
  assert.ok(keyEvents(page).includes("keydown:KeyD"));
  assert.equal(page.dispatched.filter((d) => d.type === "pointermove").length, 1);
});

test("a reflex that reports itself stuck is withdrawn like any wedged move", async () => {
  const offeredPerTick: string[][] = [];

  const page = makePage(
    {
      pick: (offered) => {
        offeredPerTick.push(offered.toSorted());

        return (
          ["track", "right", "left", "none"].find((label) => offered.includes(label)) ?? "none"
        );
      },
    },
    { track: () => ({ keys: ["KeyD"], stuck: true }) },
  );

  const result = await complete(page, config({ ticks: 6 }), 0);
  assert.equal(result.error, null);
  assert.ok(result.records.filter((r) => r.move === "track").every((r) => r.askedToMove));
  assert.ok(offeredPerTick.some((offered) => !offered.includes("track")));
});

test("a pinned move runs without ever calling the model", async () => {
  const page = makePage({ pick: () => "left" });
  const result = await complete(page, config({ pinMove: "right", ticks: 3 }));
  assert.equal(result.error, null);
  assert.equal(page.requests.length, 0);
  assert.deepEqual(
    result.records.map((r) => r.move),
    ["right", "right", "right"],
  );
});

test("a held-down pointer that moves is a drag, not a click per move", async () => {
  let x = 0.2;

  const page = makePage(
    { pick: () => "track" },
    {
      track: () => {
        x += 0.01;

        return { pointer: { down: true, x, y: 0.5 } };
      },
    },
  );

  await complete(page, config({ ticks: 2 }));
  const types = page.dispatched.filter((d) => d.kind === "pointer").map((d) => d.type);
  assert.equal(types.filter((type) => type === "pointerdown").length, 1);
  assert.ok(types.filter((type) => type === "pointermove").length > 1);
  assert.equal(types.at(-1), "pointerup");
});

test("a reflex that returns null releases what it held", async () => {
  let frames = 0;

  const page = makePage(
    { pick: () => "track" },
    {
      track: () => {
        frames += 1;

        return frames === 1 ? { keys: ["KeyD"] } : null;
      },
    },
  );

  await complete(page, config({ ticks: 1 }));
  assert.deepEqual(keyEvents(page).slice(0, 2), ["keydown:KeyD", "keyup:KeyD"]);
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

  await repeatRounds(3, async () => {
    page.frame();
    await page.settle();
  });

  assert.ok(keyEvents(page).includes("keydown:KeyD"), "something is held");
  result.stop();

  await repeatRounds(
    10,
    async () => {
      page.frame();
      await page.settle();
    },
    () => result.done,
  );

  assert.ok(result.done);
  assert.equal(keyEvents(page).at(-1), "keyup:KeyD", "nothing stays held");
  assert.ok(page.requests.length < 50);
});

test("both injected functions survive being stringified into a fresh scope", async () => {
  const page = makePage({ actionProbability: 0.9, pick: () => "right" });
  const started: AgentResult[] = [];

  runInNewContext(`started.push((${inPageAgent.toString()})(config, env));`, {
    __name: <T>(fn: T) => fn,
    config: config({ ticks: 2 }),
    env: page.env,
    started,
  });

  const [result] = started;
  assert.ok(result);

  await repeatRounds(
    100,
    async () => {
      page.sample.x += 1;
      page.frame();
      await page.settle();
    },
    () => result.done,
  );

  assert.ok(result.done);
  assert.equal(result.error, null);
  assert.equal(result.records.length, 2);
  assert.doesNotThrow(() => new Script(`(${browserEnv.toString()})`));
});
