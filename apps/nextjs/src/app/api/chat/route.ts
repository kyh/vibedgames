import { streamChatResponse } from "@repo/api/agent/response/stream-chat-response";
import { auth } from "@repo/api/auth/auth";
import { db } from "@repo/db/drizzle-client";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";

type BodyData = {
  messages: ChatUIMessage[];
  buildId: string;
};

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, buildId } = (await request.json()) as BodyData;

  return streamChatResponse(messages, {
    buildId,
    userId: session.user.id,
    db,
  });
}
