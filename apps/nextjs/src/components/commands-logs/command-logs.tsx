import { useEffect } from "react";
import { cn } from "@repo/ui/utils";
import { useQuery } from "@tanstack/react-query";

import type { Command, CommandLog } from "./types";
import { useTRPC } from "@/trpc/react";

type Props = {
  command: Command;
  onLog: (data: { sandboxId: string; cmdId: string; log: CommandLog }) => void;
  onCompleted: (data: Command) => void;
};

export const CommandLogs = ({ command, onLog, onCompleted }: Props) => {
  const trpc = useTRPC();

  // Query for command logs
  const { data: logs } = useQuery(
    trpc.sandbox.getCommandLogs.queryOptions({
      sandboxId: command.sandboxId,
      cmdId: command.cmdId,
    }),
  );

  // Query for command status
  const { data: commandData } = useQuery(
    trpc.sandbox.getCommand.queryOptions({
      sandboxId: command.sandboxId,
      cmdId: command.cmdId,
    }),
  );

  useEffect(() => {
    if (logs) {
      logs.forEach((log) => {
        onLog({
          sandboxId: command.sandboxId,
          cmdId: command.cmdId,
          log,
        });
      });
    }
  }, [logs, command.sandboxId, command.cmdId, onLog]);

  useEffect(() => {
    if (commandData?.exitCode !== undefined) {
      onCompleted({
        sandboxId: commandData.sandboxId,
        cmdId: commandData.cmdId,
        startedAt: commandData.startedAt,
        exitCode: commandData.exitCode,
        command: command.command,
        args: command.args,
      });
    }
  }, [commandData, command.command, command.args, onCompleted]);

  return (
    <pre className={cn("font-mono text-sm whitespace-pre-wrap", {})}>
      {logContent(command)}
    </pre>
  );
};

function logContent(command: Command) {
  const date = new Date(command.startedAt).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const line = `${command.command} ${command.args.join(" ")}`;
  const body = command.logs?.map((log) => log.data).join("") ?? "";
  return `[${date}] ${line}\n${body}`;
}
