import type { AppRouter } from "@repo/api";
import type { TRPCClient } from "@trpc/client";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

import { getBaseUrl, getToken } from "./config.js";

/** Authenticated client — requires a saved session token. */
export function createClient(): TRPCClient<AppRouter> {
  const token = getToken();

  if (!token) {
    throw new Error("Not logged in. Run `vg login` to authenticate.");
  }

  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${getBaseUrl()}/api/trpc`,
        transformer: superjson,
        headers: () => ({
          Authorization: `Bearer ${token}`,
        }),
      }),
    ],
  });
}

/** Unauthenticated client — for login flow. */
export function createPublicClient(baseUrl: string): TRPCClient<AppRouter> {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
        transformer: superjson,
      }),
    ],
  });
}
