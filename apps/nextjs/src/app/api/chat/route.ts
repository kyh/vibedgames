import { streamChatResponse } from "@repo/api/game/local/agent/response/stream-chat-response";
import { streamV0ChatResponse } from "@repo/api/game/v0/stream-v0-chat-response";
import { auth } from "@repo/api/auth/auth";
import { db } from "@repo/db/drizzle-client";

import type { ChatUIMessage } from "@repo/api/game/local/agent/messages/types";

type BodyData = {
  messages: ChatUIMessage[];
  buildId: string;
  mode?: "local" | "v0";
  v0ChatId?: string;
};

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, buildId, mode = "local", v0ChatId } =
    (await request.json()) as BodyData;

  if (mode === "v0") {
    return streamV0ChatResponse(messages, { v0ChatId });
  }

  return streamChatResponse(messages, {
    buildId,
    db,
  });
}
