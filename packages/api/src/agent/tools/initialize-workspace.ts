import type { ModelMessage, UIMessage, UIMessageStreamWriter } from "ai";
import { tool } from "ai";
import z from "zod";

import type { Session } from "@repo/api/auth/auth";
import { and, eq } from "@repo/db";
import type { Db } from "@repo/db/drizzle-client";

import type { DataPart } from "../messages/data-parts";
import { ensureProjectAndBuild } from "./game-persistence";
import description from "./initialize-workspace.md";

interface Params {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  db: Db;
  session: Session | null;
  modelId: string;
  projectId?: string;
  buildNumber?: number;
}

export const initializeWorkspace = ({
  writer,
  db,
  session,
  modelId,
  projectId: initialProjectId,
  buildNumber: initialBuildNumber,
}: Params) =>
  tool({
    description,
    inputSchema: z.object({}),
    execute: async (_input, { toolCallId, messages }) => {
      writer.write({
        id: toolCallId,
        type: "data-workspace",
        data: { status: "loading" },
      });

      try {
        const { project, build } = await ensureProjectAndBuild({
          db,
          session,
          modelId,
          messages: (messages as ModelMessage[]) ?? [],
          projectId: initialProjectId,
          buildNumber: initialBuildNumber,
        });

        const files = project && build
          ? await db.query.gameBuildFile.findMany({
              where: (files) =>
                and(
                  eq(files.projectId, project.id),
                  eq(files.buildNumber, build.buildNumber),
                ),
            })
          : [];

        const payloadFiles = files.map((file) => ({
          path: file.path,
          content: file.content,
        }));

        writer.write({
          id: toolCallId,
          type: "data-workspace",
          data: {
            status: "ready",
            projectId: project?.id,
            buildNumber: build?.buildNumber,
            files: payloadFiles,
          },
        });

        const fileSummary =
          payloadFiles.length === 0
            ? "No files were restored for this build."
            : `Restored ${payloadFiles.length} files.`;

        return (
          `Workspace ready for project ${project?.id ?? "(new)"}` +
          (build?.buildNumber
            ? ` (build #${build.buildNumber}).`
            : ".") +
          ` ${fileSummary}`
        );
      } catch (error) {
        const message = formatError(error);

        writer.write({
          id: toolCallId,
          type: "data-workspace",
          data: {
            status: "error",
            error: { message },
          },
        });

        return message;
      }
    },
  });

function formatError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch (jsonError) {
    return String(jsonError);
  }
}
