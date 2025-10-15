import { auth } from "@repo/api/auth/auth";
import { v0 } from "v0-sdk";

type BodyData = {
  chatId: string;
  message: string;
};

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { chatId, message } = (await request.json()) as BodyData;

  const chat = await v0.chats.sendMessage({
    chatId,
    message: message,
    responseMode: "experimental_stream",
  });

  return new Response(chat as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
