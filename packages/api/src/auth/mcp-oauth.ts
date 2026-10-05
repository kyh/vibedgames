/**
 * OAuth 2.1 for the `/mcp` endpoint, so connectors in claude.ai, ChatGPT and
 * other MCP hosts can sign a user in. better-auth is the authorization server
 * (`@better-auth/mcp`); clients identify themselves with a Client ID Metadata
 * Document (`@better-auth/cimd`) rather than registering dynamically.
 *
 * Sign-in goes through the existing /auth/login and /auth/register pages, so
 * the invite-code gate on registration applies to OAuth sign-ups unchanged.
 */
import type { Auth, Session } from "./auth";
import type { Db } from "@repo/db/drizzle-client";
import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { eq } from "@repo/db";
import { user as userTable } from "@repo/db/drizzle-schema-auth";
import { jwt } from "better-auth/plugins";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";

/** The protected resource: tokens are audience-bound to exactly this URL. */
export const mcpResourceUrl = (baseURL: string): string => `${baseURL}/mcp`;

// Hosts whose Client ID Metadata Documents we fetch. The CIMD transport is
// meant to resolve DNS once and refuse private addresses; a Worker can do
// neither, so the fetch is limited to known MCP hosts instead. (A Worker's
// fetch can't reach private networks either, which bounds the SSRF surface.)
const METADATA_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "openai.com"];

const isAllowedMetadataUrl = (clientIdUrl: string): boolean => {
  const url = URL.parse(clientIdUrl);
  return (
    url?.protocol === "https:" &&
    METADATA_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  );
};

const fetchClientMetadata = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  fetch(input, { ...init, redirect: "manual" });

/** The plugin set `createAuth()` and `auth-codegen` both install. */
export const mcpOAuthPlugins = (baseURL: string) => [
  jwt(),
  mcp({
    // Clients arrive through CIMD; hand-made clients (and their redirect URIs)
    // would put a consent screen on our domain for any app, so only admins
    // manage them.
    clientPrivileges: ({ user }) => user?.role === "admin",
    consentPage: "/auth/consent",
    loginPage: "/auth/login",
    resource: mcpResourceUrl(baseURL),
    resourcePrivileges: ({ user }) => user?.role === "admin",
  }),
  cimd({
    fetchClientMetadataResource: fetchClientMetadata,
    isMetadataDocumentUrlAllowed: isAllowedMetadataUrl,
    metadataProfile: "mcp-2026-07-28",
  }),
];

// Namespaces the synthetic session for an OAuth access token, like the
// API-key one, so `sessionOnlyProcedure` refuses it.
export const MCP_TOKEN_SESSION_PREFIX = "mcp:";

const accessTokenClaims = z.object({
  azp: z.string().optional(),
  exp: z.number(),
  jti: z.string().optional(),
  sub: z.string(),
});

const bearerToken = (headers: Headers): string | undefined =>
  /^Bearer\s+(?<token>\S+)$/iu.exec(headers.get("authorization") ?? "")?.groups?.token;

/**
 * Resolve an MCP OAuth access token to a better-auth-shaped session.
 *
 * Verifies against the JWKS read in-process rather than fetched over HTTP: a
 * Worker's subrequest to its own zone route never reaches itself. Only the
 * `/mcp` route calls this, since a token is valid only for the resource it
 * was issued for.
 */
export const resolveMcpTokenSession = async (
  auth: Auth,
  db: Db,
  headers: Headers,
  baseURL: string,
): Promise<Session | null> => {
  const token = bearerToken(headers);
  // A JWT has three segments; session tokens and `vg_` keys don't.
  if (!token || token.split(".").length !== 3) {
    return null;
  }
  const jwks = createLocalJWKSet(await auth.api.getJwks());
  let claims: z.infer<typeof accessTokenClaims>;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      audience: mcpResourceUrl(baseURL),
      issuer: `${baseURL}/api/auth`,
    });
    claims = accessTokenClaims.parse(payload);
  } catch {
    return null;
  }

  const [user] = await db.select().from(userTable).where(eq(userTable.id, claims.sub)).limit(1);
  if (!user || (user.banned && (!user.banExpires || user.banExpires.getTime() > Date.now()))) {
    return null;
  }

  const now = new Date();
  const id = `${MCP_TOKEN_SESSION_PREFIX}${claims.jti ?? claims.azp ?? user.id}`;
  // SAFETY: synthesized better-auth Session shape at the OAuth boundary; only `user` and the namespaced token are read downstream
  return {
    session: {
      createdAt: now,
      expiresAt: new Date(claims.exp * 1000),
      id,
      ipAddress: null,
      token: id,
      updatedAt: now,
      userAgent: null,
      userId: user.id,
    },
    user,
  } as Session;
};
