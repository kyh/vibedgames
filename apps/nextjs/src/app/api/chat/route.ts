import { NextResponse } from "next/server";
import { DEFAULT_MODEL } from "@repo/api/agent/constants";
import { getAvailableModels } from "@repo/api/agent/gateway";
import { streamChatResponse } from "@repo/api/agent/response/stream-chat-response";
import { auth } from "@repo/api/auth/auth";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";

type BodyData = {
  messages: ChatUIMessage[];
  modelId?: string;
  reasoningEffort?: "low" | "medium";
};

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const [models, { messages, modelId = DEFAULT_MODEL, reasoningEffort }] =
    await Promise.all([
      getAvailableModels(),
      request.json() as Promise<BodyData>,
    ]);

  const model = models.find((model) => model.id === modelId);

  if (!model) {
    return NextResponse.json(
      { error: `Model ${modelId} not found.` },
      { status: 400 },
    );
  }

  return streamChatResponse(messages, model, reasoningEffort ?? "medium");
}
