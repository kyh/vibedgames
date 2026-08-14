import assert from "node:assert/strict";
import { test } from "node:test";

import { expandGameFlag } from "../src/commands/playtest.js";

test("expandGameFlag leaves args untouched when --game is absent", () => {
  const argv = ["open", "http://localhost:5173", "--headed"];
  assert.deepEqual(expandGameFlag(argv), argv);
});

test("expandGameFlag defaults to `open` when --game is the only argument", () => {
  assert.deepEqual(expandGameFlag(["--game", "my-game"]), [
    "open",
    "https://my-game.vibedgames.com",
  ]);
});

test("expandGameFlag inserts the URL after an explicit navigate subcommand", () => {
  assert.deepEqual(expandGameFlag(["open", "--game", "my-game"]), [
    "open",
    "https://my-game.vibedgames.com",
  ]);
  assert.deepEqual(expandGameFlag(["goto", "--game", "my-game", "--headed"]), [
    "goto",
    "https://my-game.vibedgames.com",
    "--headed",
  ]);
});

test("expandGameFlag keeps trailing flags after the injected URL", () => {
  assert.deepEqual(expandGameFlag(["--game", "my-game", "--headed", "--json"]), [
    "open",
    "https://my-game.vibedgames.com",
    "--headed",
    "--json",
  ]);
});

test("expandGameFlag treats a following flag as 'no slug given'", () => {
  // `--game --headed` must not swallow `--headed` as the slug — with no slug
  // the URL comes from the project's vibedgames.json instead.
  const seen: (string | null)[] = [];
  const out = expandGameFlag(["--game", "--headed"], (slug) => {
    seen.push(slug);
    return "https://from-project-config.vibedgames.com";
  });
  assert.deepEqual(seen, [null]);
  assert.deepEqual(out, ["open", "https://from-project-config.vibedgames.com", "--headed"]);
});

test("expandGameFlag passes an explicit slug through to URL resolution", () => {
  const seen: (string | null)[] = [];
  expandGameFlag(["--game", "my-game"], (slug) => {
    seen.push(slug);
    return "https://my-game.vibedgames.com";
  });
  assert.deepEqual(seen, ["my-game"]);
});
