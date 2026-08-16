import assert from "node:assert/strict";
import { test } from "node:test";

import { unknownFlags } from "../src/lib/strict-args.js";

const DEPLOY_ARGS = {
  dir: { type: "positional" },
  slug: { type: "string" },
  source: { type: "boolean" },
  json: { type: "boolean" },
  field: { type: "string" },
} as const;

test("declared flags pass, in both spellings", () => {
  assert.deepEqual(unknownFlags(["./dist", "--slug", "x", "--source"], DEPLOY_ARGS), []);
  assert.deepEqual(unknownFlags(["--slug=x", "--json"], DEPLOY_ARGS), []);
  assert.deepEqual(unknownFlags(["--no-source"], DEPLOY_ARGS), []);
});

test("a misspelled flag is reported rather than ignored", () => {
  assert.deepEqual(unknownFlags(["./dist", "--slugg", "wrong"], DEPLOY_ARGS), ["--slugg"]);
  assert.deepEqual(unknownFlags(["--k-colours", "64"], DEPLOY_ARGS), ["--k-colours"]);
});

test("every unknown flag is named, not just the first", () => {
  assert.deepEqual(unknownFlags(["--slugg", "a", "--sauce"], DEPLOY_ARGS), ["--slugg", "--sauce"]);
});

// A value that looks like a flag reads as one. citty parses it that way too —
// `--slug --x` leaves `slug` empty — so reporting it beats deploying to a slug
// the user never typed.
test("a --value that looks like a flag is treated as one", () => {
  assert.deepEqual(unknownFlags(["--slug", "--weird-looking-slug"], DEPLOY_ARGS), [
    "--weird-looking-slug",
  ]);
});

test("aliases count as declared", () => {
  const args = { global: { type: "boolean", alias: "g" }, agent: { type: "string", alias: ["a"] } };
  assert.deepEqual(unknownFlags(["--global", "--agent", "codex"], args), []);
  assert.deepEqual(unknownFlags(["--a", "codex"], args), []);
});

test("help and version are always declared", () => {
  assert.deepEqual(unknownFlags(["--help"], DEPLOY_ARGS), []);
  assert.deepEqual(unknownFlags(["--version"], DEPLOY_ARGS), []);
});

test("positionals are not flags, and short flags are left to citty", () => {
  assert.deepEqual(unknownFlags(["./dist", "-x"], DEPLOY_ARGS), []);
});

test("everything after a bare -- is a passthrough payload", () => {
  assert.deepEqual(unknownFlags(["--json", "--", "--not-ours"], DEPLOY_ARGS), []);
});
