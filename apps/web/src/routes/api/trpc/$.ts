import { appRouter, createTRPCContext } from "@repo/api";
import { createServerFileRoute } from "@tanstack/react-start/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createServerContext } from "@/server/context";

const setCorsHeaders = (res: Response) => {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Request-Method", "*");
  res.headers.set("Access-Control-Allow-Methods", "OPTIONS, GET, POST");
  res.headers.set("Access-Control-Allow-Headers", "*");
};

const handler = async ({ request }: { request: Request }) => {
  // @ts-expect-error — env injected by @cloudflare/vite-plugin at runtime
  const env = (globalThis.__env ?? process.env) as CloudflareEnv;
  const { db, auth, productionURL } = createServerContext(env, request);

  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    router: appRouter,
    req: request,
    createContext: () =>
      createTRPCContext({ headers: request.headers, db, auth, productionURL }),
    onError: ({ error, path }) => {
      console.error(`>>> tRPC Error on '${path}'`, error);
    },
  });
  setCorsHeaders(response);
  return response;
};

export const ServerRoute = createServerFileRoute("/api/trpc/$").methods({
  GET: handler,
  POST: handler,
  OPTIONS: () => {
    const res = new Response(null, { status: 204 });
    setCorsHeaders(res);
    return res;
  },
});
