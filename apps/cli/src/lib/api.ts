import type { AppRouter } from "@repo/api";
import type { TRPCClient } from "@trpc/client";
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  splitLink,
  TRPCClientError,
} from "@trpc/client";
import superjson from "superjson";

import { getBaseUrl, getToken } from "./config.js";
import { isJsonString, type JsonValue } from "./types.js";

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

/** The tRPC error code on a failed call, or null for non-tRPC failures. */
export function authErrorCode(cause: unknown): string | null {
  if (!(cause instanceof TRPCClientError)) return null;
  const code = cause.data?.code;
  return isJsonString(code) ? code : null;
}

type ForwardInput = Parameters<TRPCClient<AppRouter>["generate"]["forward"]["mutate"]>[0];

/**
 * The single boundary where fal payloads enter the CLI. `generate.forward`
 * is deliberately untyped per endpoint, so this is where its output gets
 * its JSON contract; everything downstream narrows with the guards in
 * `types.ts` instead of re-deriving it.
 */
export async function forwardJson(
  client: TRPCClient<AppRouter>,
  input: ForwardInput,
): Promise<JsonValue> {
  const body = await client.generate.forward.mutate(input);
  // SAFETY: `generate.forward` returns the parsed JSON body of the upstream
  // response (readJsonBounded/readSseJson in packages/api), so the resolved
  // value is structurally JsonValue.
  return body as JsonValue;
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
