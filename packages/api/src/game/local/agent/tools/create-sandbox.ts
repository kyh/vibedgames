import { Buffer } from "node:buffer";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import z from "zod/v3";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import type { Db } from "@repo/db/drizzle-client";
import { getRichError } from "@repo/api/game/local/agent/tools/get-rich-error";

const description = `Use this tool FIRST at the beginning of every session to create or reuse a Vercel Sandbox environment.

A Vercel Sandbox is an ephemeral Linux container (Amazon Linux 2023 with Node.js 22) that provides a full development environment. Each sandbox has:
- A file system where you can write and read files
- The ability to run shell commands (npm install, node, etc.)
- Exposed port 3000 for running dev servers
- A public URL for accessing the running application
- A 10-minute timeout

IMPORTANT:
- You must create a sandbox BEFORE using any other tools
- Only ONE sandbox should be created per session
- The sandbox ID returned must be passed to all subsequent tool calls
- If files already exist for this build, they will be automatically restored into the sandbox`;

type Params = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  db: Db;
  buildId: string;
};

export const createSandbox = ({ writer, db, buildId }: Params) =>
  tool({
    description,
    inputSchema: z.object({}),
    execute: async (_, { toolCallId }) => {
      writer.write({
        id: toolCallId,
        type: "data-create-sandbox",
        data: { status: "loading" },
      });

      try {
        // Create a new Vercel sandbox
        const sandbox = await Sandbox.create({
          timeout: 600000,
          ports: [3000],
          runtime: "node22",
        });

        // Restore files from the database build
        const build = await db.query.gameBuild.findFirst({
          where: (builds, { eq }) => eq(builds.id, buildId),
          with: {
            gameBuildFiles: true,
          },
        });

        if (build?.gameBuildFiles && build.gameBuildFiles.length > 0) {
          await sandbox.writeFiles(
            build.gameBuildFiles.map((file) => ({
              path: file.path,
              content: Buffer.from(file.content, "utf8"),
            })),
          );
        }

        writer.write({
          id: toolCallId,
          type: "data-create-sandbox",
          data: {
            sandboxId: sandbox.sandboxId,
            status: "done",
          },
        });

        return (
          `Sandbox ready with ID: ${sandbox.sandboxId}.` +
          (build?.gameBuildFiles.length
            ? ` Restored ${build.gameBuildFiles.length} files from the existing build.`
            : "") +
          `\nYou can now upload files, run commands, and access services on the exposed ports.`
        );
      } catch (error) {
        const richError = getRichError({
          action: "Creating Sandbox",
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-create-sandbox",
          data: {
            error: { message: richError.error.message },
            status: "error",
          },
        });

        console.log("Error creating Sandbox:", richError.error);
        return richError.message;
      }
    },
  });
