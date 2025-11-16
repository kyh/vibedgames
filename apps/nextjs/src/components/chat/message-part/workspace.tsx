import { CheckIcon, Loader2Icon, XIcon } from "lucide-react";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { ToolHeader, ToolMessage } from "../tool-message";

type Props = {
  message: DataPart["workspace"];
  className?: string;
};

export const WorkspaceMessage = ({ message, className }: Props) => {
  return (
    <ToolMessage className={className}>
      <ToolHeader>
        <Loader2Icon className="h-3.5 w-3.5" />
        <span>Workspace</span>
      </ToolHeader>
      <div className="flex items-center gap-2 text-sm">
        {message.status === "ready" && (
          <CheckIcon className="h-4 w-4 text-green-700" />
        )}
        {message.status === "loading" && (
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        {message.status === "error" && (
          <XIcon className="h-4 w-4 text-red-700" />
        )}
        <span>
          {message.status === "ready" && "Workspace ready"}
          {message.status === "loading" && "Preparing workspace"}
          {message.status === "error" &&
            (message.error?.message ?? "Workspace error")}
        </span>
      </div>
      {message.status === "ready" && (
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {message.projectId && <div>Project: {message.projectId}</div>}
          {typeof message.buildNumber === "number" && (
            <div>Build: #{message.buildNumber}</div>
          )}
          <div>Files: {message.files?.length ?? 0}</div>
        </div>
      )}
    </ToolMessage>
  );
};
