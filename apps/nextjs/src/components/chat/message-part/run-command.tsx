import { Spinner } from "@repo/ui/spinner";
import { CheckIcon, SquareChevronRightIcon, XIcon } from "lucide-react";
import { Streamdown } from "streamdown";

import type { DataPart } from "@repo/api/game/local/agent/messages/data-parts";
import { ToolHeader, ToolMessage } from "../tool-message";

type Props = {
  message: DataPart["run-command"];
  className?: string;
};

export const RunCommand = ({ message, className }: Props) => {
  return (
    <ToolMessage className={className}>
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
        <span className="absolute top-0 left-0 inline-flex h-5 w-5 items-center justify-center">
          {["executing", "waiting"].includes(message.status) ? (
            <Spinner size={4} gridSize={2} />
          ) : (message.exitCode && message.exitCode > 0) ||
            message.status === "error" ? (
            <XIcon className="h-4 w-4 text-red-700" />
          ) : (
            <CheckIcon className="h-4 w-4 text-green-700" />
          )}
        </span>
        <Streamdown>{`\`${message.command} ${message.args.join(
          " ",
        )}\``}</Streamdown>
      </div>
    </ToolMessage>
  );
};
