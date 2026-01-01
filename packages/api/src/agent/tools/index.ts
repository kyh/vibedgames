import type { InferUITools, UIMessage, UIMessageStreamWriter } from "ai";
import type { Sandbox } from "just-bash";

import type { DataPart } from "../messages/data-parts";
import type { Db } from "@repo/db/drizzle-client";
import { generateFiles } from "./generate-files";
import { runCommand } from "./run-command";

type Params = {
  sandbox: Sandbox;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  db: Db;
  buildId: string;
};

export function tools({ sandbox, writer, db, buildId }: Params) {
  return {
    generateFiles: generateFiles({ sandbox, writer, db, buildId }),
    runCommand: runCommand({ sandbox, writer }),
  };
}

export type ToolSet = InferUITools<ReturnType<typeof tools>>;
