import type { UIMessage, UIMessageStreamWriter } from "ai";
import { tool } from "ai";
import z from "zod";

import type { Db } from "@repo/db/drizzle-client";

import type { DataPart, DataPartFile } from "../messages/data-parts";
import type { File } from "./get-contents";
import description from "./generate-files.md";
import { getContents } from "./get-contents";
import { persistFiles } from "./game-persistence";

type Params = {
  modelId: string;
  db: Db;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
};

type WorkspaceReference = {
  projectId?: string;
  buildNumber?: number;
};

export const generateFiles = ({ writer, modelId, db }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      projectId: z.string().optional(),
      buildNumber: z.number().optional(),
      paths: z.array(z.string()),
    }),
    execute: async (
      { projectId, buildNumber, paths }: WorkspaceReference & { paths: string[] },
      { toolCallId, messages },
    ) => {
      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: { paths: [], status: "generating" },
      });

      const iterator = getContents({ messages: messages ?? [], modelId, paths });
      const uploaded: File[] = [];

      try {
        for await (const chunk of iterator) {
          if (chunk.files.length > 0) {
            const files = normalizeFiles(chunk.files);
            writer.write({
              id: toolCallId,
              type: "data-generating-files",
              data: {
                status: "streaming",
                paths: chunk.paths,
                files,
              },
            });

            uploaded.push(...chunk.files);

            if (projectId && buildNumber !== undefined) {
              await persistFiles({
                db,
                projectId,
                buildNumber,
                files: files.map((file) => ({
                  path: file.path,
                  content: file.content,
                })),
              });
            }
          } else {
            writer.write({
              id: toolCallId,
              type: "data-generating-files",
              data: {
                status: "generating",
                paths: chunk.paths,
              },
            });
          }
        }
      } catch (error) {
        const message = formatErrorMessage(
          "generate file contents",
          { modelId, paths },
          error,
        );

        writer.write({
          id: toolCallId,
          type: "data-generating-files",
          data: {
            error: { message },
            status: "error",
            paths,
          },
        });

        return message;
      }

      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: {
          paths: uploaded.map((file) => file.path),
          status: "done",
        },
      });

      return `Successfully generated ${uploaded.length} files.\n${uploaded
        .map((file) => `Path: ${file.path}\nContent: ${file.content}\n`)
        .join("\n")}`;
    },
  });

function normalizeFiles(files: File[]): DataPartFile[] {
  return files.map((file) => ({ path: file.path, content: file.content }));
}

function formatErrorMessage(
  action: string,
  args: Record<string, unknown>,
  error: unknown,
) {
  const baseMessage = `Error during ${action}: ${getErrorMessage(error)}`;
  return `${baseMessage}\nParameters: ${JSON.stringify(args, null, 2)}`;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch (jsonError) {
    return String(jsonError);
  }
}
