import { Spinner } from "@repo/ui/spinner";
import { BoxIcon, CheckIcon, XIcon } from "lucide-react";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { ToolHeader, ToolMessage } from "../tool-message";

type Props = {
  className?: string;
  message: DataPart["create-sandbox"];
};

export const CreateSandbox = ({ message, className }: Props) => {
  return (
    <ToolMessage className={className}>
      <ToolHeader>
        <BoxIcon className="h-3.5 w-3.5" />
        Create Sandbox
      </ToolHeader>
      <div className="relative min-h-5 pl-6">
        <span className="absolute top-0 left-0 inline-flex h-5 w-5 items-center justify-center">
          {message.status === "loading" ? (
            <Spinner size={4} gridSize={2} />
          ) : message.status === "error" ? (
            <XIcon className="h-4 w-4 text-red-700" />
          ) : (
            <CheckIcon className="h-4 w-4 text-green-700" />
          )}
        </span>
        <span>
          {message.status === "done" && "Sandbox created successfully"}
          {message.status === "loading" && "Creating Sandbox"}
          {message.status === "error" && "Failed to create sandbox"}
        </span>
      </div>
    </ToolMessage>
  );
};
