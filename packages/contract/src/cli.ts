import { OAUTH_SCOPES } from "./auth/oauth-scopes";

/**
 * The header every `vg` request carries, holding the CLI's version. Builds
 * before it sent none, and they predate oRPC 2.0.0-beta.34, which dropped
 * `inferable` from the error body: apps/web's RPC handler restores the field
 * for them, since their client reads an error without it as malformed.
 */
export const CLI_VERSION_HEADER = "x-vg-cli";

/**
 * The OAuth client `vg login` signs in as: a public, first-party client the
 * server seeds, allowed the device-code and refresh-token grants only.
 */
export const CLI_OAUTH_CLIENT_ID = "vibedgames-cli";

/**
 * What `vg login` asks for and its client may hold: who the person is, a
 * refresh token, and every action scope, so the CLI acts as fully as an API
 * key does.
 */
export const CLI_OAUTH_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  ...Object.keys(OAUTH_SCOPES),
];
