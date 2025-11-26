import type { UIMessage, UIMessageStreamWriter } from "ai";
import { tool } from "ai";
import z from "zod";

import type { Db } from "@repo/db/drizzle-client";
import type { Session } from "@repo/api/auth/auth";

import type { DataPart } from "../messages/data-parts";
import type { File } from "./get-contents";
import description from "./generate-files.md";
import { getContents } from "./get-contents";
import { ensureProjectAndBuild, persistFiles } from "./game-persistence";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

type Params = {
  modelId: string;
  db: Db;
  session: Session | null;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  projectId?: string;
  buildNumber?: number;
};

export const generateFiles = ({
  writer,
  modelId,
  db,
  session,
  projectId: initialProjectId,
  buildNumber: initialBuildNumber,
}: Params) =>
  tool({
    description,
    inputSchema: z.object({
      paths: z.array(z.string()),
    }),
    execute: async ({ paths }, { toolCallId, messages }) => {
      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: { paths: [], status: "generating" },
      });

      // Ensure project and build exist for persistence
      let projectId = initialProjectId;
      let buildNumber = initialBuildNumber;

      try {
        const { project, build } = await ensureProjectAndBuild({
          db,
          session,
          modelId,
          messages: messages ?? [],
          projectId: initialProjectId,
          buildNumber: initialBuildNumber,
        });

        if (project && build) {
          projectId = project.id;
          buildNumber = build.buildNumber;

          writer.write({
            id: toolCallId,
            type: "data-project-metadata",
            data: {
              projectId: project.id,
              buildNumber: build.buildNumber,
              status: "done",
            },
          });
        }
      } catch (error) {
        console.error("Failed to ensure project/build:", error);
        // Continue without persistence - we can still generate files
      }

      const iterator = getContents({
        messages: messages ?? [],
        modelId,
        paths,
      });

      const allFiles: File[] = [];

      try {
        for await (const chunk of iterator) {
          // Update generating status with paths
          writer.write({
            id: toolCallId,
            type: "data-generating-files",
            data: {
              status: "generating",
              paths: chunk.paths,
            },
          });

          if (chunk.files.length > 0) {
            // Stream file contents to the client for sandpack
            writer.write({
              id: toolCallId,
              type: "data-file-content",
              data: {
                files: chunk.files.map((file) => ({
                  path: file.path,
                  content: file.content,
                })),
                status: "streaming",
              },
            });

            allFiles.push(...chunk.files);

            // Persist files to database if we have project context
            if (projectId && buildNumber !== undefined) {
              try {
                await persistFiles({
                  db,
                  projectId,
                  buildNumber,
                  files: chunk.files.map((file) => ({
                    path: file.path,
                    content: file.content,
                  })),
                });
              } catch (persistError) {
                console.error("Failed to persist files:", persistError);
                // Continue - file generation to client still works
              }
            }
          }
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to generate files:", error);

        writer.write({
          id: toolCallId,
          type: "data-generating-files",
          data: {
            error: { message: errorMessage },
            status: "error",
            paths,
          },
        });

        return `Failed to generate files: ${errorMessage}`;
      }

      // Signal completion
      writer.write({
        id: toolCallId,
        type: "data-file-content",
        data: {
          files: [],
          status: "done",
        },
      });

      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: { paths: allFiles.map((file) => file.path), status: "done" },
      });

      return `Successfully generated ${allFiles.length} files. The files have been streamed to the client sandbox. Their paths are:
${allFiles.map((file) => `- ${file.path}`).join("\n")}

The game preview should now be updating in the browser.`;
    },
  });
