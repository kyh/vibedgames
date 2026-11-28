import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  bareTokens,
  expandGameFlag,
  resolveGameUrl,
  withScopedSession,
} from "../src/commands/playtest.js";
import { SLUG_RE } from "../src/lib/config-file.js";
import { makeCleanups, stubEnv } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();

afterEach(drain);

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
  assert.equal(bareTokens(["--session", "p1", "snapshot", "--game", "x"])[0], "snapshot");
  assert.equal(bareTokens(["snapshot", "--game", "x"])[0], "snapshot");
});

test("bareTokens sees past a --flag=value token, which claims nothing", () => {
  assert.equal(bareTokens(["--session=p1", "snapshot", "--game", "x"])[0], "snapshot");
});

test("bareTokens keeps a trailing verb visible, so a dead command can be caught", () => {
  assert.deepEqual(bareTokens(["--game", "my-game", "open"]), ["open"]);
  assert.deepEqual(bareTokens(["open", "--game", "my-game"]), ["open"]);
});

test("bareTokens finds none when every bare token is a flag's value", () => {
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
  for (const bad of ["my/evil.com", "../other", "a.b", "evil.com#", "-x", "x-", "", "A"]) {
    assert.equal(SLUG_RE.test(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("SLUG_RE accepts exactly what deploy accepts", () => {
  for (const good of ["my-game", "a--b", "ab", "a-b-c", "game2"]) {
    assert.equal(SLUG_RE.test(good), true, `${good} must be accepted`);
  }

  assert.equal(SLUG_RE.test("a"), false, "single-character slugs aren't deployable");
});

test("expandGameFlag reads a verb that follows a boolean flag as the verb", () => {
  assert.deepEqual(expandGameFlag(["--headed", "open", "--game", "my-game"], url), [
    "--headed",
    "open",
    "https://my-game.vibedgames.com",
  ]);
  assert.deepEqual(expandGameFlag(["--headed", "--json", "goto", "--game", "my-game"], url), [
    "--headed",
    "--json",
    "goto",
    "https://my-game.vibedgames.com",
  ]);
});

test("bareTokens keeps a known verb, and still drops an ordinary flag value", () => {
  assert.deepEqual(bareTokens(["--headed", "open", "--game", "x"]), ["open"]);
  assert.deepEqual(bareTokens(["--session", "p1", "--game", "x"]), []);
  assert.deepEqual(bareTokens(["--session", "open", "--game", "x"]), ["open"]);
});

test("expandGameFlag accepts a slug that happens to be a verb", () => {
  for (const slug of ["open", "diff", "url", "goto", "navigate"]) {
    assert.deepEqual(
      expandGameFlag(["--game", slug], () => `https://${slug}.vibedgames.com`),
      ["open", `https://${slug}.vibedgames.com`],
    );
  }

  assert.deepEqual(
    expandGameFlag(["open", "--game", "open"], () => "https://open.vibedgames.com"),
    ["open", "https://open.vibedgames.com"],
  );
});

const SESSION = () => "vg-abc123";

test("withScopedSession scopes a verb to the project", () => {
  assert.deepEqual(withScopedSession(["open", "http://localhost:5173"], SESSION), [
    "--session",
    "vg-abc123",
    "open",
    "http://localhost:5173",
  ]);
  assert.deepEqual(withScopedSession(["screenshot", "out.png"], SESSION), [
    "--session",
    "vg-abc123",
    "screenshot",
    "out.png",
  ]);
});

test("withScopedSession never overrides an explicit session", () => {
  const explicit = ["--session", "p1", "open", "http://localhost:5173"];
  assert.deepEqual(withScopedSession(explicit, SESSION), explicit);
  const inline = ["--session=p2", "snapshot"];
  assert.deepEqual(withScopedSession(inline, SESSION), inline);
});

test("withScopedSession leaves machine-wide commands alone", () => {
  assert.deepEqual(withScopedSession(["session", "list"], SESSION), ["session", "list"]);
  assert.deepEqual(withScopedSession(["install"], SESSION), ["install"]);
  assert.deepEqual(withScopedSession(["--help"], SESSION), ["--help"]);
});

test("resolveGameUrl serves a game beside the www web host, not under it", () => {
  stubEnv(cleanups, { VG_API_URL: "https://www.vibedgames.com" });
  assert.equal(resolveGameUrl("my-game"), "https://my-game.vibedgames.com");
});

test("resolveGameUrl still resolves from an apex API URL saved by an older login", () => {
  stubEnv(cleanups, { VG_API_URL: "https://vibedgames.com" });
  assert.equal(resolveGameUrl("my-game"), "https://my-game.vibedgames.com");
});
