import type { InferUITools, UIMessage, UIMessageStreamWriter } from "ai";
import type { BashToolkit } from "bash-tool";

import type { DataPart } from "../messages/data-parts";
import type { Db } from "@repo/db/drizzle-client";
import { generateFiles } from "./generate-files";

type Params = {
  bashToolkit: BashToolkit;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  db: Db;
  buildId: string;
};

export function tools({ bashToolkit, writer, db, buildId }: Params) {
  return {
    ...bashToolkit.tools,
    generateFiles: generateFiles({
      sandbox: bashToolkit.sandbox,
      writer,
      db,
      buildId,
    }),
  };
}

export type ToolSet = InferUITools<ReturnType<typeof tools>>;
