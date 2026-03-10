import { Spinner } from "@repo/ui/spinner";
import { CheckIcon, LinkIcon } from "lucide-react";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { ToolHeader, ToolMessage } from "../tool-message";

type Props = {
  message: DataPart["get-sandbox-url"];
  className?: string;
};

export const GetSandboxURL = ({ message, className }: Props) => {
  return (
    <ToolMessage className={className}>
      <ToolHeader>
        <LinkIcon className="h-3.5 w-3.5" />
        <span>Get Sandbox URL</span>
      </ToolHeader>
      <div className="relative min-h-5 pl-6">
        <span className="absolute top-0 left-0 inline-flex h-5 w-5 items-center justify-center">
          {message.status === "loading" ? (
            <Spinner size={4} gridSize={2} />
          ) : (
            <CheckIcon className="h-4 w-4 text-green-700" />
          )}
        </span>
        {message.url ? (
          <a href={message.url} target="_blank" rel="noopener noreferrer">
            {message.url}
          </a>
        ) : (
          <span>Getting Sandbox URL</span>
        )}
      </div>
    </ToolMessage>
  );
};
