import type { InferUITools, UIMessage, UIMessageStreamWriter } from "ai";

import type { Session } from "@repo/api/auth/auth";
import type { Db } from "@repo/db/drizzle-client";

import type { DataPart } from "../messages/data-parts";
import { createSandbox } from "./create-sandbox";
import { generateFiles } from "./generate-files";
import { getSandboxURL } from "./get-sandbox-url";
import { runCommand } from "./run-command";

type Params = {
  modelId: string;
  db: Db;
  session: Session | null;
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  projectId?: string;
  buildNumber?: number;
};

export function tools({
  modelId,
  db,
  session,
  writer,
  projectId,
  buildNumber,
}: Params) {
  return {
    createSandbox: createSandbox({
      writer,
      db,
      session,
      modelId,
      projectId,
      buildNumber,
    }),
    generateFiles: generateFiles({ writer, modelId }),
    getSandboxURL: getSandboxURL({ writer }),
    runCommand: runCommand({ writer }),
  };
}

export type ToolSet = InferUITools<ReturnType<typeof tools>>;
