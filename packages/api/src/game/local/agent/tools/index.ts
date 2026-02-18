import type { InferUITools, UIMessage, UIMessageStreamWriter } from "ai";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import type { Db } from "@repo/db/drizzle-client";
import { createSandbox } from "@repo/api/game/local/agent/tools/create-sandbox";
import { generateFiles } from "@repo/api/game/local/agent/tools/generate-files";
import { getSandboxURL } from "@repo/api/game/local/agent/tools/get-sandbox-url";
import { runCommand } from "@repo/api/game/local/agent/tools/run-command";

type Params = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
  db: Db;
  buildId: string;
};

export function tools({ writer, db, buildId }: Params) {
  return {
    createSandbox: createSandbox({ writer, db, buildId }),
    generateFiles: generateFiles({ writer, db, buildId }),
    getSandboxURL: getSandboxURL({ writer }),
    runCommand: runCommand({ writer }),
  };
}

export type ToolSet = InferUITools<ReturnType<typeof tools>>;
