import { CLI_OAUTH_CLIENT_ID, CLI_OAUTH_SCOPES } from "@repo/contract/cli";

import { getConfig, saveConfig } from "./config.js";
import type { Config } from "./config.js";
import { isJsonNumber, isJsonObject, isJsonString } from "./types.js";
import type { JsonObject, JsonValue } from "./types.js";

/**
 * `vg login` as an OAuth client (RFC 8628 device authorization): the CLI
 * asks for a device code, the person approves its user code at `/device`,
 * and the CLI receives an access token for the API plus a refresh token. The
 * access token lives an hour; every request refreshes it first when it is
 * about to run out, and saves the rotated pair.
 */

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const EXPIRY_MARGIN_MS = 60_000;

const apiResource = (baseUrl: string) => `${new URL(baseUrl).origin}/api`;

const authUrl = (baseUrl: string, path: string) => `${new URL(baseUrl).origin}/api/auth${path}`;

/** An OAuth error response (RFC 6749 §5.2), or the transport failing before one. */
export class OAuthError extends Error {
  readonly code: string;

  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.code = code;
    this.name = "OAuthError";
  }
}

const postForm = async (url: string, body: Record<string, string>) => {
  const res = await fetch(url, {
    body: new URLSearchParams(body),
    headers: { accept: "application/json" },
    method: "POST",
  });

  const data = (await res.json().catch(() => null)) as JsonValue;

  if (!isJsonObject(data)) {
    throw new OAuthError("server_error", `HTTP ${res.status}`);
  }

  if (!res.ok) {
    const { error, error_description: description } = data;
    throw new OAuthError(
      isJsonString(error) ? error : "server_error",
      isJsonString(description) ? description : `HTTP ${res.status}`,
    );
  }

  return data;
};

export interface DeviceCode {
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
}

/** Starts a device authorization for the CLI's client, every scope, and the API. */
export const requestDeviceCode = async (baseUrl: string) => {
  const data = await postForm(authUrl(baseUrl, "/device/code"), {
    client_id: CLI_OAUTH_CLIENT_ID,
    resource: apiResource(baseUrl),
    scope: CLI_OAUTH_SCOPES.join(" "),
  });

  const {
    device_code: deviceCode,
    expires_in: expiresIn,
    interval,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
  } = data;

  if (!isJsonString(deviceCode) || !isJsonString(userCode) || !isJsonString(verificationUri)) {
    throw new OAuthError("server_error", "malformed device authorization response");
  }

  return {
    deviceCode,
    expiresIn: isJsonNumber(expiresIn) ? expiresIn : 600,
    interval: isJsonNumber(interval) ? interval : 5,
    userCode,
    verificationUri,
    verificationUriComplete: isJsonString(verificationUriComplete)
      ? verificationUriComplete
      : verificationUri,
  };
};

const toConfig = (baseUrl: string, data: JsonObject, previousRefresh?: string) => {
  const { access_token: token, expires_in: expiresIn, refresh_token: refreshToken } = data;

  if (!isJsonString(token)) {
    throw new OAuthError("server_error", "token response carries no access_token");
  }

  return {
    baseUrl,
    expiresAt: isJsonNumber(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    refreshToken: isJsonString(refreshToken) ? refreshToken : previousRefresh,
    token,
  };
};

/**
 * One poll of the token endpoint for an approved device code. Throws
 * `OAuthError` with `authorization_pending` or `slow_down` while the person
 * has not answered, `access_denied` if they denied, `expired_token` once the
 * code has run out.
 */
export const pollDeviceToken = async (baseUrl: string, deviceCode: string) =>
  toConfig(
    baseUrl,
    await postForm(authUrl(baseUrl, "/oauth2/token"), {
      client_id: CLI_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_CODE_GRANT_TYPE,
    }),
  );

/** Whether a saved login's access token needs refreshing before it is sent. */
export const needsRefresh = (config: Config, now = Date.now()) =>
  Boolean(config.refreshToken && config.expiresAt && config.expiresAt - EXPIRY_MARGIN_MS <= now);

const refresh = async (config: Config & { refreshToken: string }) => {
  const next = toConfig(
    config.baseUrl,
    await postForm(authUrl(config.baseUrl, "/oauth2/token"), {
      client_id: CLI_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
      resource: apiResource(config.baseUrl),
    }),
    config.refreshToken,
  );

  saveConfig(next);

  return next;
};

let refreshing: Promise<Config> | null = null;

/**
 * The token to send: `VG_TOKEN` when set, else the saved login's, refreshed
 * first when it is about to run out. Concurrent requests in one process share
 * one refresh; across processes the server replays a just-rotated token's
 * response for a short window. A refresh the server refuses means the login
 * is gone (disconnected in Settings, or idle too long), and says so.
 */
export const getAccessToken = async () => {
  if (process.env.VG_TOKEN) {
    return process.env.VG_TOKEN;
  }

  const config = getConfig();

  if (!config) {
    return null;
  }

  if (!needsRefresh(config) || !config.refreshToken) {
    return config.token;
  }

  refreshing ??= refresh({ ...config, refreshToken: config.refreshToken });

  try {
    const next = await refreshing;

    return next.token;
  } catch (error) {
    if (error instanceof OAuthError && error.code === "invalid_grant") {
      throw new Error("Your login has expired or was disconnected. Run `vg login` again.", {
        cause: error,
      });
    }

    throw error;
  } finally {
    refreshing = null;
  }
};

/** Best-effort revocation of a saved login's refresh token, for `vg logout`. */
export const revokeLogin = async (config: Config) => {
  if (!config.refreshToken) {
    return;
  }

  await postForm(authUrl(config.baseUrl, "/oauth2/revoke"), {
    client_id: CLI_OAUTH_CLIENT_ID,
    token: config.refreshToken,
    token_type_hint: "refresh_token",
  }).catch(() => null);
};
