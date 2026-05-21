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
      // Media input bytes use presigned uploads, but mutations can still
      // carry model params. Keep writes off httpBatchLink so one batch
      // body cannot grow with concurrent calls.
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
  // The login-flow procedures carry no large payloads, so the plain
  // batch link is fine here — no need for the splitLink dance the
  // authenticated client uses to keep `media.run` mutations off the
  // batched path.
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/api/trpc`,
        transformer: superjson,
      }),
    ],
  });
}
