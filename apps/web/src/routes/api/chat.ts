import type { ChatUIMessage } from "@repo/api/game/local/agent/messages/types";
import { streamChatResponse } from "@repo/api/game/local/agent/response/stream-chat-response";
import { createFileRoute } from "@tanstack/react-router";

import { getServerContext } from "@/auth/server";

type BodyData = {
  messages: ChatUIMessage[];
  buildId: string;
};

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { db, auth } = getServerContext();
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response("Unauthorized", { status: 401 });

        let body: BodyData;
        try {
          body = (await request.json()) as BodyData;
        } catch {
          return new Response("Bad Request", { status: 400 });
        }

        const { messages, buildId } = body;
        if (!messages || !buildId) {
          return new Response("Bad Request: messages and buildId required", { status: 400 });
        }

        return streamChatResponse(messages, { buildId, db });
      },
    },
  },
});
