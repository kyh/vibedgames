import type { AppRouter } from "@repo/api";
import type { TRPCClient } from "@trpc/client";
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from "@trpc/client";
import superjson from "superjson";

import { getBaseUrl, getToken } from "./config.js";

/** Authenticated client — requires a saved session token. */
export function createClient(): TRPCClient<AppRouter> {
  const token = getToken();

  if (!token) {
    throw new Error("Not logged in. Run `vg login` to authenticate.");
  }

  const url = `${getBaseUrl()}/api/trpc`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  return createTRPCClient<AppRouter>({
    links: [
      // Mutations like `image.run` carry multi-MB base64 payloads; if a
      // batch link grouped concurrent calls into one HTTP request the
      // body would scale linearly with concurrency and breach the
      // server's MAX_BODY_BYTES cap. Route mutations through the
      // unbatched httpLink and keep batching for small queries.
      splitLink({
        condition: (op) => op.type === "mutation",
        true: httpLink({ url, transformer: superjson, headers }),
        false: httpBatchLink({ url, transformer: superjson, headers }),
      }),
    ],
  });
}

/** Unauthenticated client — for login flow. */
export function createPublicClient(baseUrl: string): TRPCClient<AppRouter> {
  const url = `${baseUrl}/api/trpc`;
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "mutation",
        true: httpLink({ url, transformer: superjson }),
        false: httpBatchLink({ url, transformer: superjson }),
      }),
    ],
  });
}
