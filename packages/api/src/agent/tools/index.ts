import type { InferUITools, UIMessage, UIMessageStreamWriter } from "ai";

import type { DataPart } from "../messages/data-parts";
import { generateFiles } from "./generate-files";

type Params = {
  writer: UIMessageStreamWriter<UIMessage<never, DataPart>>;
};

export function tools({ writer }: Params) {
  return {
    generateFiles: generateFiles({ writer }),
  };
}

export type ToolSet = InferUITools<ReturnType<typeof tools>>;
