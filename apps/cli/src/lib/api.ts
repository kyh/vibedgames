import type { AppRouter, RouterInputs } from "@repo/api";
import type { RouterClient } from "@orpc/server";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { getBaseUrl, getToken } from "./config.js";
import type { JsonValue } from "./types.js";

const makeClient = (baseUrl: string, token?: string): RouterClient<AppRouter> =>
  createORPCClient(
    new RPCLink({
      headers: () => (token ? { Authorization: `Bearer ${token}` } : {}),
      origin: baseUrl,
      url: "/api/orpc",
    }),
  );

/** Authenticated client — requires a saved session token. */
export const createClient = (): RouterClient<AppRouter> => {
  const token = getToken();

  if (!token) {
    throw new Error("Not logged in. Run `vg login` to authenticate.");
  }

  return makeClient(getBaseUrl(), token);
};

/** The oRPC error code on a failed call, or null for non-oRPC failures. */
export const authErrorCode = (cause: unknown): string | null =>
  cause instanceof ORPCError ? cause.code : null;

type ForwardInput = RouterInputs["generate"]["forward"];

/**
 * The single boundary where fal payloads enter the CLI. `generate.forward` is
 * deliberately untyped per endpoint — it resolves to bare `JsonValue` — so
 * everything downstream narrows with the guards in `types.ts` rather than
 * asserting a shape at the call site.
 */
export const forwardJson = async (
  client: RouterClient<AppRouter>,
  input: ForwardInput,
): Promise<JsonValue> => await client.generate.forward(input);

/** Unauthenticated client — for login flow. */
export const createPublicClient = (baseUrl: string): RouterClient<AppRouter> => makeClient(baseUrl);
