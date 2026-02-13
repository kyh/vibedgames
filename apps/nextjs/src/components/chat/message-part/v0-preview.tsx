import { Spinner } from "@repo/ui/spinner";
import { CheckIcon, CloudIcon, XIcon } from "lucide-react";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { ToolHeader, ToolMessage } from "../tool-message";

type Props = {
  message: DataPart["v0-preview"];
  className?: string;
};

export const V0Preview = ({ message, className }: Props) => {
  return (
    <ToolMessage className={className}>
      <ToolHeader>
        <CloudIcon className="h-3.5 w-3.5" />
        <span>
          {message.status === "done"
            ? "v0 Preview Ready"
            : message.status === "error"
              ? "v0 Generation Failed"
              : "Generating with v0"}
        </span>
      </ToolHeader>
      <div className="relative min-h-5 text-sm">
        {message.status === "streaming" && (
          <div className="flex items-center">
            <Spinner className="mr-1" size={4} gridSize={2} />
            <span>Building your game with v0...</span>
          </div>
        )}
        {message.status === "done" && message.url && (
          <div className="flex items-center">
            <CheckIcon className="mr-1 h-4 w-4 text-green-700" />
            <span>Preview loaded</span>
          </div>
        )}
        {message.status === "done" &&
          message.files &&
          message.files.length > 0 && (
            <div className="flex items-center">
              <CheckIcon className="mr-1 h-4 w-4 text-green-700" />
              <span>
                {message.files.length} file
                {message.files.length !== 1 ? "s" : ""} generated
              </span>
            </div>
          )}
        {message.status === "error" && (
          <div className="flex items-center">
            <XIcon className="mr-1 h-4 w-4 text-red-700" />
            <span>{message.error?.message ?? "Generation failed"}</span>
          </div>
        )}
      </div>
    </ToolMessage>
  );
};
