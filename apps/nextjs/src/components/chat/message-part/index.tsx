import type { UIMessage } from "ai";
import { memo } from "react";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import type { Metadata } from "@repo/api/agent/messages/metadata";
import type { ToolSet } from "@repo/api/agent/tools/index";
import { CreateSandbox } from "./create-sandbox";
import { GenerateFiles } from "./generate-files";
import { GetSandboxURL } from "./get-sandbox-url";
import { Reasoning } from "./reasoning";
import { ReportErrors } from "./report-errors";
import { RunCommand } from "./run-command";
import { Text } from "./text";

type Props = {
  part: UIMessage<Metadata, DataPart, ToolSet>["parts"][number];
  partIndex: number;
  className?: string;
};

export const MessagePart = memo(function MessagePart({
  part,
  partIndex,
  className,
}: Props) {
  if (part.type === "data-generating-files") {
    return <GenerateFiles message={part.data} className={className} />;
  } else if (part.type === "data-create-sandbox") {
    return <CreateSandbox message={part.data} className={className} />;
  } else if (part.type === "data-get-sandbox-url") {
    return <GetSandboxURL message={part.data} className={className} />;
  } else if (part.type === "data-run-command") {
    return <RunCommand message={part.data} className={className} />;
  } else if (part.type === "reasoning") {
    return (
      <Reasoning part={part} partIndex={partIndex} className={className} />
    );
  } else if (part.type === "data-report-errors") {
    return <ReportErrors message={part.data} className={className} />;
  } else if (part.type === "text") {
    return <Text part={part} className={className} />;
  }
  return null;
});
