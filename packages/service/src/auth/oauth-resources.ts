/**
 * The protected resources vibedgames issues OAuth access tokens for (RFC
 * 8707), on the host the request arrived at: `/mcp` for MCP clients, `/api`
 * for the REST and RPC API. A token's `aud` names one, and each surface
 * accepts only its own, so a token granted for MCP cannot drive the API.
 */
export const oauthResources = (baseURL: string) => {
  const { origin } = new URL(baseURL);
  return { api: `${origin}/api`, mcp: `${origin}/mcp` };
};

/** The issuer that signs those tokens: better-auth's base path on the same host. */
export const oauthIssuer = (baseURL: string) => `${new URL(baseURL).origin}/api/auth`;
