import { BoxIcon, CheckIcon, XIcon } from "lucide-react";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { ToolHeader } from "../tool-header";
import { ToolMessage } from "../tool-message";
import { Spinner } from "./spinner";

type Props = {
  message: DataPart["create-sandbox"];
};

export const CreateSandbox = ({ message }: Props) => {
  return (
    <ToolMessage>
      <ToolHeader>
        <BoxIcon className="h-3.5 w-3.5" />
        Create Sandbox
      </ToolHeader>
      <div className="relative min-h-5 pl-6">
        <Spinner
          className="absolute top-0 left-0"
          loading={message.status === "loading"}
        >
          {message.status === "error" ? (
            <XIcon className="h-4 w-4 text-red-700" />
          ) : (
            <CheckIcon className="h-4 w-4" />
          )}
        </Spinner>
        <span>
          {message.status === "done" && "Sandbox created successfully"}
          {message.status === "loading" && "Creating Sandbox"}
          {message.status === "error" && "Failed to create sandbox"}
        </span>
      </div>
    </ToolMessage>
  );
};
