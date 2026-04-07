import { createServerFileRoute } from "@tanstack/react-start/server";

import { createServerContext } from "@/server/context";

const handler = async ({ request }: { request: Request }) => {
  // @ts-expect-error — env injected by @cloudflare/vite-plugin
  const env = (globalThis.__env ?? process.env) as CloudflareEnv;
  const { auth } = createServerContext(env, request);
  return auth.handler(request);
};

export const ServerRoute = createServerFileRoute("/api/auth/$").methods({
  GET: handler,
  POST: handler,
});
