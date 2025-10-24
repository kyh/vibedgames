import type { UIMessage, UIMessageStreamWriter } from "ai";
import { Sandbox } from "@vercel/sandbox";
import { tool } from "ai";
import z from "zod";

import type { Db } from "@repo/db/drizzle-client";

import type { DataPart } from "../messages/data-parts";
import type { File } from "./get-contents";
import description from "./generate-files.md";
import { getContents } from "./get-contents";
import { getBuildBySandbox, persistFiles } from "./game-persistence";
import { getRichError } from "./get-rich-error";
import { getWriteFiles } from "./get-write-files";

type Params = {
  modelId: string;
  db: Db;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
};

export const generateFiles = ({ writer, modelId, db }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z.string(),
      paths: z.array(z.string()),
    }),
    execute: async ({ sandboxId, paths }, { toolCallId, messages }) => {
      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: { paths: [], status: "generating" },
      });

      let sandbox: Sandbox | null = null;

      try {
        sandbox = await Sandbox.get({ sandboxId });
      } catch (error) {
        const richError = getRichError({
          action: "get sandbox by id",
          args: { sandboxId },
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-generating-files",
          data: { error: richError.error, paths: [], status: "error" },
        });

        return richError.message;
      }

      const build = await getBuildBySandbox(db, sandboxId);
      if (!build) {
        console.warn(
          `No persisted build found for sandbox ${sandboxId}. Files will not be saved to the database.`,
        );
      }

      const writeFiles = getWriteFiles({ sandbox, toolCallId, writer });
      const iterator = getContents({ messages: messages ?? [], modelId, paths });
      const uploaded: File[] = [];

      try {
        for await (const chunk of iterator) {
          if (chunk.files.length > 0) {
            const error = await writeFiles(chunk);
            if (error) {
              return error;
            } else {
              uploaded.push(...chunk.files);
              if (build) {
                await persistFiles({
                  db,
                  projectId: build.projectId,
                  buildNumber: build.buildNumber,
                  files: chunk.files.map((file) => ({
                    path: file.path,
                    content: file.content,
                  })),
                });
              }
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
        const richError = getRichError({
          action: "generate file contents",
          args: { modelId, paths },
          error,
        });

        writer.write({
          id: toolCallId,
          type: "data-generating-files",
          data: {
            error: richError.error,
            status: "error",
            paths,
          },
        });

        return richError.message;
      }

      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: { paths: uploaded.map((file) => file.path), status: "done" },
      });

      return `Successfully generated and uploaded ${
        uploaded.length
      } files. Their paths and contents are as follows:
        ${uploaded
          .map((file) => `Path: ${file.path}\nContent: ${file.content}\n`)
          .join("\n")}`;
    },
  });
