import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AccessTokenCheck } from "./oauth-token";
import { verifyAccessToken } from "./oauth-token";

/**
 * Access tokens are audience-bound: one granted for `/mcp` must never drive
 * the API, and the reverse. The keys here are a fresh Ed25519 pair standing in
 * for the JWT plugin's, which signs with EdDSA by default.
 */

const ISSUER = "https://vibedgames.com/api/auth";
const MCP = "https://vibedgames.com/mcp";
const API = "https://vibedgames.com/api";

const generatePair = async (): Promise<CryptoKeyPair> => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  assert.ok("privateKey" in pair);
  return pair;
};

const keyPair = await generatePair();
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const otherPair = await generatePair();

interface TokenClaims {
  aud: string[];
  cnf?: { jkt: string };
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  sub: string;
}

interface JwsHeader {
  alg: string;
  kid: string;
  typ: string;
}

const encode = (value: JwsHeader | TokenClaims) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const sign = async (claims: TokenClaims, key: CryptoKey = keyPair.privateKey) => {
  const signingInput = `${encode({ alg: "EdDSA", kid: "key-1", typ: "at+jwt" })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
};

const now = Math.floor(Date.now() / 1000);

const claims = (overrides: Partial<TokenClaims> = {}): TokenClaims => ({
  aud: [MCP, `${ISSUER}/oauth2/userinfo`],
  exp: now + 3600,
  iat: now,
  iss: ISSUER,
  jti: "token-1",
  sub: "user_1",
  ...overrides,
});

// Each check gets its own key source, so no test reads another's cached key set.
const checkFor = (resource: string): AccessTokenCheck => ({
  getJwks: () => Promise.resolve({ keys: [{ ...publicJwk, alg: "EdDSA", kid: "key-1" }] }),
  issuer: ISSUER,
  resource,
});

describe("verifyAccessToken", () => {
  test("accepts a token for the resource it was issued for", async () => {
    const verified = await verifyAccessToken(await sign(claims()), checkFor(MCP));
    assert.strictEqual(verified?.sub, "user_1");
    assert.strictEqual(verified.jti, "token-1");
  });

  test("refuses a token issued for another resource", async () => {
    assert.strictEqual(await verifyAccessToken(await sign(claims()), checkFor(API)), null);
  });

  test("refuses an expired token", async () => {
    const expired = await sign(claims({ exp: now - 120, iat: now - 3720 }));
    assert.strictEqual(await verifyAccessToken(expired, checkFor(MCP)), null);
  });

  test("refuses a token from another issuer", async () => {
    const foreign = await sign(claims({ iss: "https://evil.example/api/auth" }));
    assert.strictEqual(await verifyAccessToken(foreign, checkFor(MCP)), null);
  });

  test("refuses a token signed with another key", async () => {
    const forged = await sign(claims(), otherPair.privateKey);
    assert.strictEqual(await verifyAccessToken(forged, checkFor(MCP)), null);
  });

  // A DPoP-bound token needs a proof of possession this API does not check.
  test("refuses a sender-constrained token", async () => {
    const bound = await sign(claims({ cnf: { jkt: "thumbprint" } }));
    assert.strictEqual(await verifyAccessToken(bound, checkFor(MCP)), null);
  });
});
