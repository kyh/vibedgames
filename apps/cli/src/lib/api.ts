import type { ContractClient } from "@repo/contract";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

import { getBaseUrl, getToken } from "./config.js";

const makeClient = (baseUrl: string, token?: string): ContractClient =>
  createORPCClient(
    new RPCLink({
      headers: () => (token ? { Authorization: `Bearer ${token}` } : {}),
      origin: baseUrl,
      url: "/api/orpc",
    }),
  );

/** Authenticated client — requires a saved session token. */
export const createClient = (): ContractClient => {
  const token = getToken();

  if (!token) {
    throw new Error("Not logged in. Run `vg login` to authenticate.");
  }

  return makeClient(getBaseUrl(), token);
};

/** The oRPC error code on a failed call, or null for non-oRPC failures. */
export const authErrorCode = (cause: unknown): string | null =>
  cause instanceof ORPCError ? cause.code : null;

/** Unauthenticated client — for login flow. */
export const createPublicClient = (baseUrl: string): ContractClient => makeClient(baseUrl);
