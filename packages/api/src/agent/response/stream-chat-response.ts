import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  ToolLoopAgent,
} from "ai";
import { createBashTool } from "bash-tool";

import type { ChatUIMessage } from "../messages/types";
import type { Db } from "@repo/db/drizzle-client";
import { tools } from "../tools";
import prompt from "./stream-chat-response-prompt";

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
        const bashToolkit = await initializeBashToolkit(buildId, db);

        // Create the agent with model, instructions, and tools
        const agent = new ToolLoopAgent({
          model: "google/gemini-2.5-flash-lite",
          instructions: prompt,
          tools: tools({ writer, bashToolkit, db, buildId }),
          stopWhen: stepCountIs(20),
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

const initializeBashToolkit = async (buildId: string, db: Db) => {
  // Get files from build in the database
  const build = await db.query.gameBuild.findFirst({
    where: (builds, { eq }) => eq(builds.id, buildId),
    with: {
      gameBuildFiles: true,
    },
  });

  // Convert build files to the format expected by bash-tool
  const files: Record<string, string> = {};
  if (build?.gameBuildFiles && build.gameBuildFiles.length > 0) {
    for (const file of build.gameBuildFiles) {
      // Remove leading slash if present for clean paths
      const cleanPath = file.path.startsWith("/")
        ? file.path.slice(1)
        : file.path;
      files[cleanPath] = file.content;
    }
  }

  // Create bash toolkit with files - bash-tool handles sandbox creation
  const bashToolkit = await createBashTool({
    files,
    destination: "/app",
  });

  return bashToolkit;
};
