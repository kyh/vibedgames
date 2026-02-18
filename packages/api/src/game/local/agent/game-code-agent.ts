import { stepCountIs, ToolLoopAgent } from "ai";
import type { UIMessage, UIMessageStreamWriter } from "ai";

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
 * Creates an AI agent for generating and managing game code.
 *
 * This agent is configured with:
 * - Gemini 2.5 Flash Lite model for fast responses
 * - Tools for Vercel Sandbox management, file generation, and command execution
 * - Game development focused system instructions
 * - 20-step tool execution loop limit
 *
 * The agent creates a Vercel Sandbox as its first action, which provides a full
 * Linux container (Node.js 22) with exposed port 3000 for running dev servers.
 * Files from the database build are automatically restored into the sandbox.
 *
 * @param params - Dependencies required for agent configuration
 * @returns Configured ToolLoopAgent instance
 */
export const createGameCodeAgent = ({
  writer,
  db,
  buildId,
}: CreateGameCodeAgentParams) => {
  return new ToolLoopAgent({
    model: "google/gemini-2.5-flash-lite",
    instructions: prompt,
    tools: tools({ writer, db, buildId }),
    stopWhen: stepCountIs(20),
  });
};
