import type { ChatUIMessage } from "@repo/api/game/local/agent/messages/types";
import { streamChatResponse } from "@repo/api/game/local/agent/response/stream-chat-response";
import { createServerFileRoute } from "@tanstack/react-start/server";

import { createServerContext } from "@/server/context";

type BodyData = {
  messages: ChatUIMessage[];
  buildId: string;
};

export const ServerRoute = createServerFileRoute("/api/chat").methods({
  POST: async ({ request }) => {
    // @ts-expect-error — env injected by @cloudflare/vite-plugin
    const env = (globalThis.__env ?? process.env) as CloudflareEnv;
    const { db, auth } = createServerContext(env, request);

    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return new Response("Unauthorized", { status: 401 });

    const { messages, buildId } = (await request.json()) as BodyData;
    return streamChatResponse(messages, { buildId, db });
  },
});
