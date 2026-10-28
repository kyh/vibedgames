import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { CLI_OAUTH_CLIENT_ID } from "@repo/contract/cli";

import { getConfig, saveConfig } from "../src/lib/config.js";
import { getAccessToken, needsRefresh } from "../src/lib/oauth.js";
import { makeCleanups, makeTestServer, makeTmpDir, stubEnv } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const readForm = async (req: AsyncIterable<Buffer>) => {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
  }
  return new URLSearchParams(body);
};

test("needsRefresh only for a login with a refresh token inside the expiry margin", () => {
  const now = 1_000_000;
  const base = { baseUrl: "https://vibedgames.com", token: "t" };
  assert.equal(needsRefresh(base, now), false);
  assert.equal(needsRefresh({ ...base, expiresAt: now - 1 }, now), false);
  assert.equal(needsRefresh({ ...base, expiresAt: now + 600_000, refreshToken: "r" }, now), false);
  assert.equal(needsRefresh({ ...base, expiresAt: now + 30_000, refreshToken: "r" }, now), true);
});

test("getAccessToken refreshes an expiring login once and saves the rotated pair", async () => {
  stubEnv(cleanups, {
    VG_API_URL: undefined,
    VG_TOKEN: undefined,
    XDG_CONFIG_HOME: makeTmpDir(cleanups, "vg-oauth-"),
  });
  const seen: URLSearchParams[] = [];
  const port = await makeTestServer(cleanups, (req, res) => {
    readForm(req)
      .then((form) => {
        seen.push(form);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ access_token: "fresh", expires_in: 3600, refresh_token: "rotated" }),
        );
      })
      .catch(() => res.end());
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  saveConfig({ baseUrl, expiresAt: Date.now() + 1000, refreshToken: "old", token: "stale" });

  const tokens = await Promise.all([getAccessToken(), getAccessToken()]);

  assert.deepEqual(tokens, ["fresh", "fresh"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.get("grant_type"), "refresh_token");
  assert.equal(seen[0]?.get("refresh_token"), "old");
  assert.equal(seen[0]?.get("client_id"), CLI_OAUTH_CLIENT_ID);
  assert.equal(seen[0]?.get("resource"), `${baseUrl}/api`);
  const saved = getConfig();
  assert.equal(saved?.token, "fresh");
  assert.equal(saved?.refreshToken, "rotated");
  assert.ok((saved?.expiresAt ?? 0) > Date.now() + 3_000_000);
  // Fresh now: no second refresh.
  assert.equal(await getAccessToken(), "fresh");
  assert.equal(seen.length, 1);
});

test("a refused refresh tells the person to log in again", async () => {
  stubEnv(cleanups, {
    VG_TOKEN: undefined,
    XDG_CONFIG_HOME: makeTmpDir(cleanups, "vg-oauth-"),
  });
  const port = await makeTestServer(cleanups, (_req, res) => {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid_grant", error_description: "invalid refresh token" }));
  });
  saveConfig({
    baseUrl: `http://127.0.0.1:${port}`,
    expiresAt: Date.now(),
    refreshToken: "revoked",
    token: "stale",
  });

  await assert.rejects(getAccessToken(), /Run `vg login` again/u);
});

test("VG_TOKEN wins over a saved login", async () => {
  stubEnv(cleanups, { VG_TOKEN: "vg_key", XDG_CONFIG_HOME: makeTmpDir(cleanups, "vg-oauth-") });
  saveConfig({ baseUrl: "https://vibedgames.com", token: "saved" });
  assert.equal(await getAccessToken(), "vg_key");
});
