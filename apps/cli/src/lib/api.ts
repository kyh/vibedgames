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
      // Image input bytes use presigned uploads, but mutations can still
      // carry provider params. Keep concurrent writes off httpBatchLink so
      // one batch body cannot grow with `--concurrency`.
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
  // authenticated client uses to keep `image.run` mutations off the
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
