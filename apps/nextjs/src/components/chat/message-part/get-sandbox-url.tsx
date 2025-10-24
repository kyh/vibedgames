import { CheckIcon, LinkIcon } from "lucide-react";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { ToolHeader, ToolMessage } from "../tool-message";
import { Spinner } from "./spinner";

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
        <Spinner
          className="absolute top-0 left-0"
          loading={message.status === "loading"}
        >
          <CheckIcon className="h-4 w-4 text-green-700" />
        </Spinner>
        {message.url ? (
          <a href={message.url} target="_blank">
            {message.url}
          </a>
        ) : (
          <span>Getting Sandbox URL</span>
        )}
      </div>
    </ToolMessage>
  );
};
