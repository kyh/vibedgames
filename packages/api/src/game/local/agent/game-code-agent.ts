import { stepCountIs, ToolLoopAgent } from "ai";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import { createBashTool } from "bash-tool";

import type { Db } from "@repo/db/drizzle-client";
import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { tools } from "@repo/api/game/local/agent/tools/index";
import prompt from "@repo/api/game/local/agent/response/stream-chat-response-prompt";

type CreateGameCodeAgentParams = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  db: Db;
  buildId: string;
};

/**
 * Initializes the bash toolkit with files from the database build.
 *
 * @param buildId - The ID of the build to load files from
 * @param db - Database client instance
 * @returns Configured BashToolkit instance
 */
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

/**
 * Creates an AI agent for generating and managing game code.
 *
 * This agent is configured with:
 * - Gemini 2.5 Flash Lite model for fast responses
 * - Tools for file generation and bash command execution
 * - Game development focused system instructions
 * - 20-step tool execution loop limit
 * - Bash toolkit initialized with build files from database
 *
 * @param params - Dependencies required for agent configuration
 * @returns Promise that resolves to configured ToolLoopAgent instance
 */
export const createGameCodeAgent = async ({
  writer,
  db,
  buildId,
}: CreateGameCodeAgentParams) => {
  const bashToolkit = await initializeBashToolkit(buildId, db);

  return new ToolLoopAgent({
    model: "google/gemini-2.5-flash-lite",
    instructions: prompt,
    tools: tools({ writer, bashToolkit, db, buildId }),
    stopWhen: stepCountIs(20),
  });
};
