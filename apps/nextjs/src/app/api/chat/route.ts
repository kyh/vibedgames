import { streamChatResponse } from "@repo/api/agent/response/stream-chat-response";
import { auth } from "@repo/api/auth/auth";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";

type BodyData = {
  messages: ChatUIMessage[];
  reasoningEffort?: "low" | "medium";
};

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { messages, reasoningEffort } = (await request.json()) as BodyData;

  return streamChatResponse(messages, reasoningEffort ?? "medium");
}
