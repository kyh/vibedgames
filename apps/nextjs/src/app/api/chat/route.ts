import type { ChatsCreateStreamResponse } from "v0-sdk";
import { projectId, systemPrompt } from "@repo/api/ai/ai-schema";
import { getOrganization } from "@repo/api/auth/auth";
import { v0 } from "v0-sdk";

export const maxDuration = 30;

export async function POST(request: Request) {
  const { message, slug } = (await request.json()) as {
    message: string;
    slug: string;
  };

  const organization = await getOrganization({ organizationSlug: slug });
  if (!organization) {
    return new Response("Not authenticated", { status: 404 });
  }

  const stream = (await v0.chats.create({
    system: systemPrompt,
    message: message,
    chatPrivacy: "private",
    projectId: projectId,
    responseMode: "experimental_stream",
  })) as ChatsCreateStreamResponse;

  return new Response(stream);
}
