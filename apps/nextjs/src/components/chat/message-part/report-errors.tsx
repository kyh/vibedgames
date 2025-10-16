import { BugIcon } from "lucide-react";
import { Streamdown } from "streamdown";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { ToolHeader } from "../tool-header";
import { ToolMessage } from "../tool-message";

export const ReportErrors = ({
  message,
}: {
  message: DataPart["report-errors"];
}) => {
  return (
    <ToolMessage>
      <ToolHeader>
        <BugIcon className="h-3.5 w-3.5" />
        <span>Auto-detected errors</span>
      </ToolHeader>
      <div className="relative min-h-5">
        <Streamdown>{message.summary}</Streamdown>
      </div>
    </ToolMessage>
  );
};
