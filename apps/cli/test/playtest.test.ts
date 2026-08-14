import assert from "node:assert/strict";
import { test } from "node:test";

import { expandGameFlag } from "../src/commands/playtest.js";

/** Stand-in for the real resolver so these stay pure unit tests. */
const url = (slug: string | null) => `https://${slug ?? "from-project-config"}.vibedgames.com`;

test("expandGameFlag leaves args untouched when --game is absent", () => {
  const argv = ["open", "http://localhost:5173", "--headed"];
  assert.deepEqual(expandGameFlag(argv, url), argv);
});

test("expandGameFlag adds `open` when no URL-taking verb precedes the flag", () => {
  assert.deepEqual(expandGameFlag(["--game", "my-game"], url), [
    "open",
    "https://my-game.vibedgames.com",
  ]);
  assert.deepEqual(expandGameFlag(["--game", "my-game", "--headed"], url), [
    "open",
    "https://my-game.vibedgames.com",
    "--headed",
  ]);
});

test("expandGameFlag substitutes in place after an explicit verb", () => {
  assert.deepEqual(expandGameFlag(["open", "--game", "my-game"], url), [
    "open",
    "https://my-game.vibedgames.com",
  ]);
  assert.deepEqual(expandGameFlag(["goto", "--game", "my-game", "--headed"], url), [
    "goto",
    "https://my-game.vibedgames.com",
    "--headed",
  ]);
});

test("expandGameFlag does not mistake a valued global flag's value for the subcommand", () => {
  // No mirror of agent-browser's flag grammar, so an unknown valued flag can
  // never strand the URL in the wrong place.
  assert.deepEqual(expandGameFlag(["--session", "p1", "--game", "my-game"], url), [
    "--session",
    "p1",
    "open",
    "https://my-game.vibedgames.com",
  ]);
  assert.deepEqual(expandGameFlag(["--brand-new-flag", "v", "--game", "my-game"], url), [
    "--brand-new-flag",
    "v",
    "open",
    "https://my-game.vibedgames.com",
  ]);
});

test("expandGameFlag handles a flag value that repeats a subcommand name", () => {
  assert.deepEqual(expandGameFlag(["--profile", "open", "open", "--game", "my-game"], url), [
    "--profile",
    "open",
    "open",
    "https://my-game.vibedgames.com",
  ]);
});

test("expandGameFlag expands every --game, for multi-URL subcommands", () => {
  assert.deepEqual(expandGameFlag(["diff", "url", "--game", "a", "--game", "b"], url), [
    "diff",
    "url",
    "https://a.vibedgames.com",
    "https://b.vibedgames.com",
  ]);
});

test("expandGameFlag treats a following flag as 'no slug given'", () => {
  const seen: (string | null)[] = [];
  const out = expandGameFlag(["--game", "--headed"], (slug) => {
    seen.push(slug);
    return url(slug);
  });
  assert.deepEqual(seen, [null]);
  assert.deepEqual(out, ["open", "https://from-project-config.vibedgames.com", "--headed"]);
});

test("expandGameFlag passes an explicit slug through to URL resolution", () => {
  const seen: (string | null)[] = [];
  expandGameFlag(["--game", "my-game"], (slug) => {
    seen.push(slug);
    return url(slug);
  });
  assert.deepEqual(seen, ["my-game"]);
});
