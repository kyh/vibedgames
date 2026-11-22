import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { JsonValue } from "@repo/contract/json";
import {
  MAX_CHOICE_OPTIONS,
  MAX_QUESTIONS,
  MAX_STATE_BYTES,
  decideInput,
} from "@repo/contract/playtest/playtest-schema";
import { ORPCError } from "@orpc/server";

import type { DecisionProviderConfig } from "../orpc";
import { startUpstream } from "../upstream.test-utils";
import type { UpstreamReply } from "../upstream.test-utils";
import { DEFAULT_BASE_URL, forwardDecision } from "./playtest-router";

const answer = {
  answers: { move: { choice: "left", confidence: 0.7, type: "choice" } },
  usage: { input_tokens: 5 },
};

let reply: UpstreamReply = {};
const upstream = await startUpstream(() => reply);

after(upstream.close);

beforeEach(() => {
  upstream.requests.length = 0;
  reply = { json: answer };
});

const configured: DecisionProviderConfig = {
  typesafe: "sk-test",
  typesafeBaseUrl: upstream.origin,
};

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

test("forwards a System One request with the server's key and returns the answers", async () => {
  const result = await forwardDecision(
    { typesafe: "sk-test", typesafeBaseUrl: `${upstream.origin}/` },
    validInput,
  );

  assert.deepEqual(result, answer);
  const [request] = upstream.requests;
  assert.equal(request?.method, "POST");
  assert.equal(request?.url.pathname, "/v1/systemone");
  assert.equal(request?.headers.authorization, "Bearer sk-test");
  assert.equal(request?.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request?.body ?? "null"), {
    model: "jev-latest",
    questions: validInput.questions,
    state: validInput.state,
  });
});

test("defaults to the public host and honours an explicit model", async () => {
  assert.equal(DEFAULT_BASE_URL, "https://api.typesafe.ai");
  await forwardDecision(configured, { ...validInput, model: "jev-1.13.0" });
  assert.equal(JSON.parse(upstream.requests[0]?.body ?? "null").model, "jev-1.13.0");
});

const codeOf = async (promise: Promise<JsonValue>) => {
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
  assert.equal(
    await codeOf(forwardDecision({ typesafeBaseUrl: upstream.origin }, validInput)),
    "PRECONDITION_FAILED",
  );
  assert.equal(upstream.requests.length, 0);
});

test("maps provider failures to codes the CLI can act on", async () => {
  const expect = async (status: number, code: string) => {
    reply = { status, text: "nope" };
    assert.equal(await codeOf(forwardDecision(configured, validInput)), code, `HTTP ${status}`);
  };

  await expect(422, "BAD_REQUEST");
  await expect(429, "TOO_MANY_REQUESTS");
  await expect(529, "TOO_MANY_REQUESTS");
  await expect(401, "BAD_GATEWAY");
  await expect(500, "BAD_GATEWAY");

  reply = { json: { model: "x" } };
  assert.equal(
    await codeOf(forwardDecision(configured, validInput)),
    "BAD_GATEWAY",
    "a reply with no answers",
  );
});

test("caps the state size", async () => {
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
