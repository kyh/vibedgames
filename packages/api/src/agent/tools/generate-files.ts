import type { UIMessage, UIMessageStreamWriter } from "ai";
import { tool } from "ai";
import z from "zod";

import type { DataPart } from "../messages/data-parts";
import type { File } from "./get-contents";
import description from "./generate-files.md";
import { getContents } from "./get-contents";
import { getRichError } from "./get-rich-error";

type Params = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
};

function filesToRecord(files: File[]): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, file.content]));
}

export const generateFiles = ({ writer }: Params) =>
  tool({
    description,
    inputSchema: z.object({
      sandboxId: z.string().optional(),
      paths: z.array(z.string()),
    }),
    execute: async ({ paths }, { toolCallId, messages }) => {
      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: { paths: [], status: "generating" },
      });

      const iterator = getContents({ messages: messages ?? [], paths });
      const uploaded: File[] = [];

      try {
        for await (const chunk of iterator) {
          if (chunk.files.length > 0) {
            uploaded.push(...chunk.files);
            writer.write({
              id: toolCallId,
              type: "data-generating-files",
              data: {
                files: filesToRecord(chunk.files),
                paths: uploaded.map((file) => file.path),
                status: "uploaded",
              },
            });
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
          args: { paths },
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

      const allFiles = filesToRecord(uploaded);
      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: {
          files: allFiles,
          paths: uploaded.map((file) => file.path),
          status: "done",
        },
      });

      return `Successfully generated ${uploaded.length} files. Their paths and contents are as follows:
        ${uploaded
          .map((file) => `Path: ${file.path}\nContent: ${file.content}\n`)
          .join("\n")}`;
    },
  });
