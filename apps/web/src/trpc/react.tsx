import { useState } from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchStreamLink, loggerLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import SuperJSON from "superjson";

import type { AppRouter } from "@repo/api";
import { createQueryClient } from "./query-client";

let clientQueryClientSingleton: ReturnType<typeof createQueryClient> | undefined = undefined;
const getQueryClient = () => {
  if (typeof window === "undefined") return createQueryClient();
  return (clientQueryClientSingleton ??= createQueryClient());
};

export const { useTRPC, TRPCProvider, useTRPCClient } = createTRPCContext<AppRouter>();

export const TRPCReactProvider = (props: { children: React.ReactNode }) => {
  // If a QueryClient was provided higher up (TanStack Router context), reuse it.
  let queryClient: ReturnType<typeof createQueryClient>;
  try {
    queryClient = useQueryClient();
  } catch {
    queryClient = getQueryClient();
  }

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        loggerLink({
          enabled: (op) =>
            import.meta.env.DEV ||
            (op.direction === "down" && op.result instanceof Error),
        }),
        httpBatchStreamLink({
          transformer: SuperJSON,
          url: `${getBaseUrl()}/api/trpc`,
          headers: () => new Headers(),
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {props.children}
      </TRPCProvider>
    </QueryClientProvider>
  );
};

const getBaseUrl = () => {
  if (typeof window !== "undefined") return window.location.origin;
  return "http://localhost:3000";
};
