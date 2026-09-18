import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ORPCError } from "@orpc/server";

import type { JsonValue } from "../json";
import type { DecisionProviderConfig } from "../orpc";
import {
  MAX_CHOICE_OPTIONS,
  MAX_QUESTIONS,
  MAX_STATE_BYTES,
  decideInput,
  forwardDecision,
} from "./playtest-router";

/**
 * `playtest.decide` is the only place the TypeSafe key is used, so what leaves
 * the server matters: exactly a System One request, with the key, to the
 * configured host, and nothing else. The provider is a stubbed `fetch`.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

const stubFetch = (respond: () => Response): Captured => {
  const captured: Captured = { init: undefined, url: "" };
  globalThis.fetch = (input, init) => {
    captured.url = String(input);
    captured.init = init;
    return Promise.resolve(respond());
  };
  return captured;
};

const json = (body: JsonValue, status = 200): Response => Response.json(body, { status });

const configured: DecisionProviderConfig = { typesafe: "sk-test" };

const validInput = {
  questions: {
    move: {
      criteria: { left: "Move left", none: "Stay still", right: "Move right" },
      instructions: "Which way?",
      type: "choice" as const,
    },
  },
  state: { player: { x: 1 } },
};

const answer = {
  answers: { move: { choice: "left", confidence: 0.7, type: "choice" } },
  usage: { input_tokens: 5 },
};

test("forwards a System One request with the server's key and returns the answers", async () => {
  const captured = stubFetch(() => json(answer));
  const result = await forwardDecision(
    { typesafe: "sk-test", typesafeBaseUrl: "https://stub.example/" },
    validInput,
  );
  assert.deepEqual(result, answer);
  assert.equal(captured.url, "https://stub.example/v1/systemone");
  const headers = new Headers(captured.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-test");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    model: "jev-latest",
    questions: validInput.questions,
    state: validInput.state,
  });
});

test("defaults to the public host and honours an explicit model", async () => {
  const captured = stubFetch(() => json(answer));
  await forwardDecision(configured, { ...validInput, model: "jev-1.13.0" });
  assert.equal(captured.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(JSON.parse(String(captured.init?.body)).model, "jev-1.13.0");
});

const codeOf = async (promise: Promise<JsonValue>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ORPCError) {
      return error.code;
    }
    throw error;
  }
  return "no error";
};

test("refuses without a configured key, before touching the network", async () => {
  let fetched = false;
  globalThis.fetch = () => {
    fetched = true;
    return Promise.resolve(json(answer));
  };
  assert.equal(await codeOf(forwardDecision({}, validInput)), "PRECONDITION_FAILED");
  assert.equal(fetched, false);
});

test("maps provider failures to codes the CLI can act on", async () => {
  const expect = async (status: number, code: string) => {
    stubFetch(() => new Response("nope", { status }));
    assert.equal(await codeOf(forwardDecision(configured, validInput)), code, `HTTP ${status}`);
  };
  await expect(422, "BAD_REQUEST");
  await expect(429, "TOO_MANY_REQUESTS");
  await expect(529, "TOO_MANY_REQUESTS");
  await expect(401, "BAD_GATEWAY");
  await expect(500, "BAD_GATEWAY");

  stubFetch(() => json({ model: "x" }));
  assert.equal(
    await codeOf(forwardDecision(configured, validInput)),
    "BAD_GATEWAY",
    "a reply with no answers",
  );
});

test("caps the state size", async () => {
  stubFetch(() => json(answer));
  const state = { blob: "x".repeat(MAX_STATE_BYTES) };
  assert.equal(
    await codeOf(forwardDecision(configured, { ...validInput, state })),
    "PAYLOAD_TOO_LARGE",
  );
});

test("the input schema admits only well-formed typed questions", () => {
  assert.equal(decideInput.safeParse(validInput).success, true);
  const withQuestions = (questions: JsonValue) =>
    decideInput.safeParse({ ...validInput, questions }).success;
  assert.equal(withQuestions({}), false, "no questions");
  assert.equal(
    withQuestions({ q: { criteria: { only: "one" }, instructions: "?", type: "choice" } }),
    false,
    "a choice needs two options",
  );
  const many = Object.fromEntries(
    Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => [`o${i}`, `option ${i}`]),
  );
  assert.equal(withQuestions({ q: { criteria: many, instructions: "?", type: "choice" } }), false);
  assert.equal(withQuestions({ q: { instructions: "?", type: "noul" } }), true);
  assert.equal(
    withQuestions({ q: { criteria: ["low", "high"], instructions: "?", type: "score" } }),
    true,
  );
  assert.equal(withQuestions({ q: { instructions: "?", type: "essay" } }), false, "no free text");
  const tooMany = Object.fromEntries(
    Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => [
      `q${i}`,
      { instructions: "?", type: "noul" },
    ]),
  );
  assert.equal(withQuestions(tooMany), false);
  assert.equal(decideInput.safeParse({ ...validInput, model: "../other" }).success, false);
});
