import assert from "node:assert/strict";
import { test } from "node:test";

import { PLAYTEST_TOKEN_TTL_MS, mintPlaytestToken, verifyPlaytestToken } from "./session-token";

/**
 * The token is handed to untrusted game pages, so what it can and cannot
 * do is the whole point: genuine and unexpired verifies; anything tampered,
 * re-signed with another secret, or past its time does not.
 */

const SECRET = "test-secret-0123456789";

test("a minted token verifies to its user until it expires", async () => {
  const now = 1_700_000_000_000;
  const { token, expiresAt } = await mintPlaytestToken(SECRET, "user-1", now);
  assert.equal(expiresAt, now + PLAYTEST_TOKEN_TTL_MS);
  assert.match(token, /^pt\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

  assert.deepEqual(await verifyPlaytestToken(SECRET, token, now + 1000), {
    expiresAt,
    userId: "user-1",
  });
  assert.equal(
    await verifyPlaytestToken(SECRET, token, expiresAt),
    null,
    "expired at the boundary",
  );
  assert.equal(await verifyPlaytestToken(SECRET, token, expiresAt + 1), null);
});

test("two mints differ, and each verifies only under its own secret", async () => {
  const a = await mintPlaytestToken(SECRET, "user-1");
  const b = await mintPlaytestToken(SECRET, "user-1");
  assert.notEqual(a.token, b.token, "a nonce makes tokens unique");
  assert.equal(await verifyPlaytestToken("another-secret", a.token), null);
});

test("a tampered token is rejected", async () => {
  const { token } = await mintPlaytestToken(SECRET, "user-1");
  const [prefix, payload, signature] = token.split(".");
  assert.ok(prefix && payload && signature);
  // Forge the claims: a different user under the original signature.
  const forgedPayload = Buffer.from(
    JSON.stringify({ e: Date.now() + 60_000, n: "x", u: "user-2" }),
  ).toString("base64url");
  assert.equal(await verifyPlaytestToken(SECRET, `${prefix}.${forgedPayload}.${signature}`), null);
  // Damage the signature — at the FIRST character: the last one of a 32-byte
  // digest carries two padding bits, so some swaps there decode to the same bytes.
  const flipped = signature.startsWith("A") ? "B" : "A";
  assert.equal(
    await verifyPlaytestToken(SECRET, `${prefix}.${payload}.${flipped}${signature.slice(1)}`),
    null,
  );
  for (const bad of ["", "pt", "pt.a", `${token}.extra`, "nope.payload.sig", `vg_${token}`]) {
    assert.equal(await verifyPlaytestToken(SECRET, bad), null, JSON.stringify(bad));
  }
});
