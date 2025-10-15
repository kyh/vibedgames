import { CheckIcon, SquareChevronRightIcon, XIcon } from "lucide-react";
import Markdown from "react-markdown";

import type { DataPart } from "@repo/api/agent/messages/data-parts";
import { ToolHeader } from "../tool-header";
import { ToolMessage } from "../tool-message";
import { Spinner } from "./spinner";

export const RunCommand = ({
  message,
}: {
  message: DataPart["run-command"];
}) => {
  return (
    <ToolMessage>
      <ToolHeader>
        <SquareChevronRightIcon className="h-3.5 w-3.5" />
        {message.status === "executing" && "Executing"}
        {message.status === "waiting" && "Waiting"}
        {message.status === "running" && "Running in background"}
        {message.status === "done" && message.exitCode !== 1 && "Finished"}
        {message.status === "done" && message.exitCode === 1 && "Errored"}
        {message.status === "error" && "Errored"}
      </ToolHeader>
      <div className="relative pl-6">
        <Spinner
          className="absolute top-0 left-0"
          loading={["executing", "waiting"].includes(message.status)}
        >
          {(message.exitCode && message.exitCode > 0) ||
          message.status === "error" ? (
            <XIcon className="h-4 w-4 text-red-700" />
          ) : (
            <CheckIcon className="h-4 w-4" />
          )}
        </Spinner>
        <Markdown>{`\`${message.command} ${message.args.join(
          " ",
        )}\``}</Markdown>
      </div>
    </ToolMessage>
  );
};
