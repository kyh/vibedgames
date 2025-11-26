import type { InferUITools, UIMessage, UIMessageStreamWriter } from "ai";

import type { Session } from "@repo/api/auth/auth";
import type { Db } from "@repo/db/drizzle-client";

import type { DataPart } from "../messages/data-parts";
import { generateFiles } from "./generate-files";

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
    generateFiles: generateFiles({
      writer,
      modelId,
      db,
      session,
      projectId,
      buildNumber,
    }),
  };
}

export type ToolSet = InferUITools<ReturnType<typeof tools>>;
