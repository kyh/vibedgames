import { streamV0ChatResponse } from "@repo/api/game/v0/stream-v0-chat-response";
import { auth } from "@repo/api/auth/auth";

import type { ChatUIMessage } from "@repo/api/game/local/agent/messages/types";

type BodyData = {
  messages: ChatUIMessage[];
  v0ChatId?: string;
};

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, v0ChatId } = (await request.json()) as BodyData;

  return streamV0ChatResponse(messages, { v0ChatId });
}
