import type { UIMessage, UIMessageStreamWriter } from "ai";
import type { Sandbox } from "just-bash";

import type { DataPart } from "../../messages/data-parts";
import type { File } from "./get-contents";
import type { Db } from "@repo/db/drizzle-client";
import { persistFiles } from "../../../game/game-router";
import { getRichError } from "../get-rich-error";

type Params = {
  sandbox: Sandbox;
  toolCallId: string;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  db: Db;
  buildId: string;
};

export function getWriteFiles({
  sandbox,
  toolCallId,
  writer,
  db,
  buildId,
}: Params) {
  return async function writeFiles(params: {
    written: string[];
    files: File[];
    paths: string[];
  }) {
    const paths = params.written.concat(params.files.map((file) => file.path));
    writer.write({
      id: toolCallId,
      type: "data-generating-files",
      data: { paths, status: "uploading" },
    });

    try {
      // Convert to just-bash format: {[path: string]: string}
      // Convert relative paths to absolute paths under /app
      const filesToWrite: Record<string, string> = {};
      for (const file of params.files) {
        // Remove leading slash if present, then prepend /app/
        const cleanPath = file.path.startsWith("/")
          ? file.path.slice(1)
          : file.path;
        const absolutePath = `/app/${cleanPath}`;
        filesToWrite[absolutePath] = file.content;
      }

      await sandbox.writeFiles(filesToWrite);

      // Sync to database (persistFiles expects relative paths)
      await persistFiles({
        db,
        buildId,
        files: params.files.map((file) => ({
          path: file.path, // Keep relative path for database
          content: file.content,
        })),
      });
    } catch (error) {
      const richError = getRichError({
        action: "write files to sandbox",
        args: params,
        error,
      });

      writer.write({
        id: toolCallId,
        type: "data-generating-files",
        data: {
          error: richError.error,
          status: "error",
          paths: params.paths,
        },
      });

      return richError.message;
    }

    writer.write({
      id: toolCallId,
      type: "data-generating-files",
      data: { paths, status: "uploaded" },
    });
  };
}
