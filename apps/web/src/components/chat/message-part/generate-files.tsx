import { Spinner } from "@repo/ui/spinner";
import { CheckIcon, CloudUploadIcon, XIcon } from "lucide-react";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { ToolHeader, ToolMessage } from "../tool-message";

type Props = {
  message: DataPart["generating-files"];
  className?: string;
};

export const GenerateFiles = ({ message, className }: Props) => {
  const lastInProgress = ["error", "uploading", "generating"].includes(
    message.status,
  );

  const generated = lastInProgress
    ? message.paths.slice(0, message.paths.length - 1)
    : message.paths;

  const generating = lastInProgress
    ? (message.paths[message.paths.length - 1] ?? "")
    : null;

  return (
    <ToolMessage className={className}>
      <ToolHeader>
        <CloudUploadIcon className="h-3.5 w-3.5" />
        <span>
          {message.status === "done" ? "Uploaded files" : "Generating files"}
        </span>
      </ToolHeader>
      <div className="relative min-h-5 text-sm">
        {generated.map((path) => (
          <div className="flex items-center" key={"gen" + path}>
            <CheckIcon className="mr-1 h-4 w-4 text-green-700" />
            <span className="whitespace-pre-wrap">{path}</span>
          </div>
        ))}
        {typeof generating === "string" && (
          <div className="flex items-center">
            {message.status === "error" ? (
              <XIcon className="mr-1 h-4 w-4 text-red-700" />
            ) : message.status === "done" ? (
              <CheckIcon className="mr-1 h-4 w-4 text-green-700" />
            ) : (
              <Spinner className="mr-1" size={4} gridSize={2} />
            )}
            <span>{generating}</span>
          </div>
        )}
      </div>
    </ToolMessage>
  );
};
