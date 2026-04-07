import { appRouter, createTRPCContext } from "@repo/api";
import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { getServerContext } from "~/auth/server";

const handler = (req: Request) => {
  const { db, auth, productionUrl } = getServerContext();
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    router: appRouter,
    req,
    createContext: () =>
      createTRPCContext({
        headers: req.headers,
        db,
        auth,
        productionURL: productionUrl,
      }),
    onError({ error, path }) {
      console.error(`>>> tRPC Error on '${path}'`, error);
    },
  });
};

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => handler(request),
      POST: ({ request }) => handler(request),
    },
  },
});
