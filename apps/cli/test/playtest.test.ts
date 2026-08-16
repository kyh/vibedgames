import assert from "node:assert/strict";
import { test } from "node:test";

import { bareTokens, expandGameFlag } from "../src/commands/playtest.js";
import { SLUG_RE } from "../src/lib/config-file.js";

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

test("bareTokens sees past a valued global flag", () => {
  // agent-browser answers `--session p1 snapshot open <url>` by running the
  // snapshot and silently ignoring the URL, so missing the guard here costs a
  // wrong answer rather than an error. `p1` is claimed by `--session`, leaving
  // `snapshot` as the first unclaimed bare token.
  assert.equal(bareTokens(["--session", "p1", "snapshot", "--game", "x"])[0], "snapshot");
  assert.equal(bareTokens(["snapshot", "--game", "x"])[0], "snapshot");
});

test("bareTokens sees past a --flag=value token, which claims nothing", () => {
  assert.equal(bareTokens(["--session=p1", "snapshot", "--game", "x"])[0], "snapshot");
});

test("bareTokens keeps a trailing verb visible, so a dead command can be caught", () => {
  // `--game my-game open` can't be expanded usefully: in place gives
  // `<url> open`, whose first positional agent-browser reads as the
  // subcommand, and inserting a verb gives `open <url> open`. expandGameFlag
  // exits on this; what matters here is that the verb is seen at all.
  assert.deepEqual(bareTokens(["--game", "my-game", "open"]), ["open"]);
  assert.deepEqual(bareTokens(["open", "--game", "my-game"]), ["open"]);
});

test("bareTokens finds none when every bare token is a flag's value", () => {
  // These are the shapes that legitimately need an `open` inserted.
  assert.equal(bareTokens(["--game", "x"]).length, 0);
  assert.equal(bareTokens(["--headed", "--game", "x"]).length, 0);
  assert.equal(bareTokens(["--session", "p1", "--game", "x"]).length, 0);
  assert.equal(bareTokens(["--brand-new-flag", "v", "--game", "x"]).length, 0);
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

test("SLUG_RE keeps a slug inside its own subdomain", () => {
  // `--game` puts the slug in the hostname, so anything that could re-point the
  // origin has to be rejected before the URL is built.
  for (const bad of ["my/evil.com", "../other", "a.b", "evil.com#", "-x", "x-", "", "A"]) {
    assert.equal(SLUG_RE.test(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("SLUG_RE accepts exactly what deploy accepts", () => {
  // Shared with deploy/fork/new — a slug that deployed must stay playtestable,
  // including the repeated hyphens deploy allows.
  for (const good of ["my-game", "a--b", "ab", "a-b-c", "game2"]) {
    assert.equal(SLUG_RE.test(good), true, `${good} must be accepted`);
  }
  assert.equal(SLUG_RE.test("a"), false, "single-character slugs aren't deployable");
});
