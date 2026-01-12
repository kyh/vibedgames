import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

import type { ChatUIMessage } from "../messages/types";
import type { Db } from "@repo/db/drizzle-client";
import { createGameCodeAgent } from "../game-code-agent";

type Params = {
  buildId: string;
  db: Db;
};

export const streamChatResponse = (
  messages: ChatUIMessage[],
  { buildId, db }: Params,
) => {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      originalMessages: messages,
      execute: async ({ writer }) => {
        // Create the game code agent (includes bash toolkit initialization)
        const agent = await createGameCodeAgent({
          writer,
          db,
          buildId,
        });

        // Stream the agent response with the messages
        // Note: Errors are now handled through the stream as error parts
        const result = await agent.stream({
          messages: await convertToModelMessages(
            messages.map((message) => {
              message.parts = message.parts.map((part) => {
                if (part.type === "data-report-errors") {
                  return {
                    type: "text",
                    text:
                      `There are errors in the generated code. This is the summary of the errors we have:\n` +
                      `\`\`\`${part.data.summary}\`\`\`\n` +
                      (part.data.paths?.length
                        ? `The following files may contain errors:\n` +
                          `\`\`\`${part.data.paths.join("\n")}\`\`\`\n`
                        : "") +
                      `Fix the errors reported.`,
                  };
                }
                return part;
              });
              return message;
            }),
          ),
        });

        void result.consumeStream();

        writer.merge(
          result.toUIMessageStream({
            sendReasoning: true,
            sendStart: false,
          }),
        );
      },
    }),
  });
};
