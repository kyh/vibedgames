import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
} from "ai";

import type { Session } from "@repo/api/auth/auth";
import type { Db } from "@repo/db/drizzle-client";

import type { ChatUIMessage } from "../messages/types";
import { getModelOptions } from "../gateway";
import { tools } from "../tools";
import prompt from "./stream-chat-response-prompt.md";

export const streamChatResponse = (
  messages: ChatUIMessage[],
  model: {
    id: string;
    name: string;
  },
  reasoningEffort: "low" | "medium",
  options: {
    db: Db;
    session: Session | null;
    projectId?: string;
    buildNumber?: number;
  },
) => {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      originalMessages: messages,
      execute: ({ writer }) => {
        const result = streamText({
          ...getModelOptions(model.id, { reasoningEffort }),
          system: prompt,
          messages: convertToModelMessages(
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
                          `\`\`\`${part.data.paths?.join("\n")}\`\`\`\n`
                        : "") +
                      `Fix the errors reported.`,
                  };
                }
                return part;
              });
              return message;
            }),
          ),
          stopWhen: stepCountIs(20),
          tools: tools({
            modelId: model.id,
            writer,
            db: options.db,
            session: options.session,
            projectId: options.projectId,
            buildNumber: options.buildNumber,
          }),
          onError: (error) => {
            console.error("Error communicating with AI");
            console.error(JSON.stringify(error, null, 2));
          },
        });

        void result.consumeStream();

        writer.merge(
          result.toUIMessageStream({
            sendReasoning: true,
            sendStart: false,
            messageMetadata: () => ({
              model: model.name,
            }),
          }),
        );
      },
    }),
  });
};
