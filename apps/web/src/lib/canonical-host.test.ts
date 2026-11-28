import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canonicalLocation } from "@/lib/canonical-host";

const at = (url: string) => canonicalLocation(new URL(url));

describe("canonicalLocation", () => {
  test("sends apex pages to www with path and query intact", () => {
    assert.equal(at("https://vibedgames.com/"), "https://www.vibedgames.com/");
    assert.equal(
      at("https://vibedgames.com/docs?x=1&y=2"),
      "https://www.vibedgames.com/docs?x=1&y=2",
    );
    assert.equal(at("https://vibedgames.com/auth/login"), "https://www.vibedgames.com/auth/login");
    assert.equal(
      at("https://vibedgames.com/device?user_code=ABCD-EFGH"),
      "https://www.vibedgames.com/device?user_code=ABCD-EFGH",
    );
  });

  test("drops the fragment, which never reaches the server", () => {
    assert.equal(
      at("https://vibedgames.com/settings#credits"),
      "https://www.vibedgames.com/settings",
    );
  });

  test("keeps the API, /mcp and discovery on the apex", () => {
    for (const path of [
      "/api",
      "/api/v1/deploy/list",
      "/api/orpc/auth/me",
      "/api/auth/oauth2/token",
      "/api/stripe/webhook",
      "/mcp",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/agent-skills/index.json",
    ]) {
      assert.equal(at(`https://vibedgames.com${path}`), null, path);
    }
  });

  test("keeps an OAuth authorize that began on the apex there until it finishes", () => {
    assert.equal(at("https://vibedgames.com/auth/login?client_id=c&sig=s"), null);
    assert.equal(at("https://vibedgames.com/auth/register?client_id=c&sig=s"), null);
    assert.equal(at("https://vibedgames.com/oauth/consent?client_id=c&sig=s"), null);
    assert.equal(
      at("https://vibedgames.com/oauth/consent?client_id=c"),
      "https://www.vibedgames.com/oauth/consent?client_id=c",
    );
  });

  test("redirects only what merely starts like an exempt path", () => {
    assert.equal(at("https://vibedgames.com/apis"), "https://www.vibedgames.com/apis");
    assert.equal(at("https://vibedgames.com/mcp-guide"), "https://www.vibedgames.com/mcp-guide");
    assert.equal(at("https://vibedgames.com/docs?sig=s"), "https://www.vibedgames.com/docs?sig=s");
  });

  test("leaves every other host alone", () => {
    for (const url of [
      "https://www.vibedgames.com/docs",
      "https://pong.vibedgames.com/",
      "https://vibedgames-web-kyh-x.workers.dev/",
      "http://localhost:5173/",
    ]) {
      assert.equal(at(url), null, url);
    }
  });
});
