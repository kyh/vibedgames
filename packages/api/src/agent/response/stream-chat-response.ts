import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
} from "ai";
import { Sandbox } from "just-bash";

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
        const sandbox = await initializeSandbox(buildId, db);

        const result = streamText({
          model: "google/gemini-2.5-flash-lite",
          system: prompt,
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
          stopWhen: stepCountIs(20),
          tools: tools({ writer, sandbox, db, buildId }),
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
          }),
        );
      },
    }),
  });
};

const initializeSandbox = async (buildId: string, db: Db) => {
  // Get files from build in the database
  const build = await db.query.gameBuild.findFirst({
    where: (builds, { eq }) => eq(builds.id, buildId),
    with: {
      gameBuildFiles: true,
    },
  });

  // Create sandbox with cwd set to /app directory
  const sandbox = await Sandbox.create({ cwd: "/app" });

  // Create /app directory and initialize with build files
  await sandbox.mkDir("/app", { recursive: true });

  if (build?.gameBuildFiles && build.gameBuildFiles.length > 0) {
    // Convert relative paths to absolute paths under /app
    const filesToWrite: Record<string, string> = {};
    for (const file of build.gameBuildFiles) {
      // Remove leading slash if present, then prepend /app/
      const cleanPath = file.path.startsWith("/")
        ? file.path.slice(1)
        : file.path;
      const absolutePath = `/app/${cleanPath}`;
      filesToWrite[absolutePath] = file.content;
    }
    await sandbox.writeFiles(filesToWrite);
  }

  return sandbox;
};
