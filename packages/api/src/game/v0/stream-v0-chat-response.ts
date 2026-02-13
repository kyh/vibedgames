import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
} from "ai";
import { parseStreamingResponse, v0 } from "v0-sdk";

import type { ChatUIMessage } from "@repo/api/game/local/agent/messages/types";
import { projectId, systemPrompt } from "./v0-schema";

type Params = {
  v0ChatId?: string;
};

/**
 * Recursively search an object for a chatId-like string field.
 * The v0 streaming response buries the chatId in the event data.
 */
function findChatId(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;

  const record = obj as Record<string, unknown>;

  // Direct chatId field
  if (typeof record.chatId === "string" && record.chatId.length > 10) {
    return record.chatId;
  }
  // id field that looks like a UUID/v0 id
  if (
    typeof record.id === "string" &&
    record.id.length > 10 &&
    record.id !== "message"
  ) {
    return record.id;
  }

  // Recurse into nested objects
  for (const value of Object.values(record)) {
    if (typeof value === "object" && value !== null) {
      const found = findChatId(value);
      if (found) return found;
    }
  }
  return null;
}

export const streamV0ChatResponse = (
  messages: ChatUIMessage[],
  { v0ChatId }: Params,
) => {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        const messageId = generateId();

        // Extract the last user message text
        const lastMessage = messages[messages.length - 1];
        const userText =
          lastMessage?.parts.find(
            (p): p is { type: "text"; text: string } => p.type === "text",
          )?.text ?? "";

        if (!userText.trim()) {
          writer.write({
            type: "text-delta",
            id: messageId,
            delta: "No message provided.",
          });
          return;
        }

        // Signal that v0 generation is starting
        writer.write({
          type: "data-v0-preview",
          data: {
            chatId: v0ChatId ?? "",
            status: "streaming" as const,
          },
        });

        let stream: ReadableStream<Uint8Array>;
        let detectedChatId: string | null = v0ChatId ?? null;

        if (v0ChatId) {
          // Continue existing v0 chat
          stream = (await v0.chats.sendMessage({
            chatId: v0ChatId,
            message: userText,
            responseMode: "experimental_stream",
          })) as ReadableStream<Uint8Array>;
        } else {
          // Create a new v0 chat
          stream = (await v0.chats.create({
            message: userText,
            system: systemPrompt,
            responseMode: "experimental_stream",
            projectId,
          })) as ReadableStream<Uint8Array>;
        }

        // Parse the SSE stream and forward events
        const accumulatedData: unknown[] = [];

        for await (const event of parseStreamingResponse(stream)) {
          if (event.data) {
            try {
              const parsed = JSON.parse(event.data) as unknown;
              accumulatedData.push(parsed);

              // Try to extract chatId from early events
              detectedChatId ??= findChatId(parsed);

              // Forward text content if present
              if (typeof parsed === "string") {
                writer.write({
                  type: "text-delta",
                  id: messageId,
                  delta: parsed,
                });
              } else if (typeof parsed === "object" && parsed !== null) {
                const obj = parsed as Record<string, unknown>;
                if (typeof obj.text === "string") {
                  writer.write({
                    type: "text-delta",
                    id: messageId,
                    delta: obj.text,
                  });
                } else if (typeof obj.content === "string") {
                  writer.write({
                    type: "text-delta",
                    id: messageId,
                    delta: obj.content,
                  });
                } else if (typeof obj.delta === "string") {
                  writer.write({
                    type: "text-delta",
                    id: messageId,
                    delta: obj.delta,
                  });
                }
              }
            } catch {
              // Not JSON - treat as raw text
              if (event.data !== "[DONE]") {
                writer.write({
                  type: "text-delta",
                  id: messageId,
                  delta: event.data,
                });
              }
            }
          }
        }

        // Search accumulated data for chatId if we still don't have one
        if (!detectedChatId) {
          for (const item of accumulatedData) {
            detectedChatId = findChatId(item);
            if (detectedChatId) break;
          }
        }

        // Now fetch the chat details to get demoUrl and files
        let demoUrl: string | undefined;
        let files: { name: string; content: string }[] | undefined;

        if (detectedChatId) {
          try {
            const chatDetail = await v0.chats.getById({
              chatId: detectedChatId,
            });

            demoUrl =
              chatDetail.latestVersion?.demoUrl ??
              (chatDetail as unknown as Record<string, string>).demo;

            files = chatDetail.latestVersion?.files.map((f) => ({
              name: f.name,
              content: f.content,
            }));
          } catch (e) {
            console.error("Failed to fetch v0 chat details:", e);
          }
        }

        // Emit the v0-preview data part with results
        writer.write({
          type: "data-v0-preview",
          data: {
            chatId: detectedChatId ?? "",
            url: demoUrl,
            files,
            status: demoUrl ? ("done" as const) : ("error" as const),
            ...(demoUrl
              ? {}
              : {
                  error: {
                    message: "Could not retrieve preview URL from v0",
                  },
                }),
          },
        });
      },
    }),
  });
};
