import { Buffer } from "node:buffer";
import type { UIMessage, UIMessageStreamWriter } from "ai";
import type { Sandbox } from "@vercel/sandbox";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import type { File } from "@repo/api/game/local/agent/tools/generate-files/get-contents";
import type { Db } from "@repo/db/drizzle-client";
import { persistFiles } from "@repo/api/game/local/local-game-router";
import { getRichError } from "@repo/api/game/local/agent/tools/get-rich-error";

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
      // Write files to the Vercel sandbox
      await sandbox.writeFiles(
        params.files.map((file) => ({
          path: file.path,
          content: Buffer.from(file.content, "utf8"),
        })),
      );

      // Sync to database
      await persistFiles({
        db,
        buildId,
        files: params.files.map((file) => ({
          path: file.path,
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
