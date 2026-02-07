import { BugIcon } from "lucide-react";
import { Streamdown } from "streamdown";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { ToolHeader, ToolMessage } from "../tool-message";

type Props = {
  message: DataPart["report-errors"];
  className?: string;
};

export const ReportErrors = ({ message, className }: Props) => {
  return (
    <ToolMessage className={className}>
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
