"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import stripAnsi from "strip-ansi";

import { useSandboxStore } from "@/components/chat/state";
import { useTRPC } from "@/trpc/react";

// Individual command component to handle hooks properly
const CommandLogsItem = ({
  command,
  sandboxId,
  addLog,
  upsertCommand,
}: {
  command: { cmdId: string; command: string; args: string[] };
  sandboxId: string;
  addLog: (data: {
    sandboxId: string;
    cmdId: string;
    log: { data: string; stream: "stdout" | "stderr"; timestamp: number };
  }) => void;
  upsertCommand: (data: {
    sandboxId: string;
    cmdId: string;
    exitCode: number;
    command: string;
    args: string[];
  }) => void;
}) => {
  const trpc = useTRPC();

  const logsQuery = useQuery(
    trpc.sandbox.getCommandLogs.queryOptions({
      sandboxId,
      cmdId: command.cmdId,
    }),
  );

  const commandQuery = useQuery(
    trpc.sandbox.getCommand.queryOptions({
      sandboxId,
      cmdId: command.cmdId,
    }),
  );

  useEffect(() => {
    if (logsQuery.data) {
      logsQuery.data.forEach((log) => {
        addLog({
          sandboxId,
          cmdId: command.cmdId,
          log: {
            data: stripAnsi(log.data),
            stream: log.stream,
            timestamp: log.timestamp,
          },
        });
      });
    }
  }, [logsQuery.data, sandboxId, command.cmdId, addLog]);

  useEffect(() => {
    if (commandQuery.data?.exitCode !== undefined) {
      upsertCommand({
        sandboxId: commandQuery.data.sandboxId,
        cmdId: commandQuery.data.cmdId,
        exitCode: commandQuery.data.exitCode,
        command: command.command,
        args: command.args,
      });
    }
  }, [commandQuery.data, command.command, command.args, upsertCommand]);

  return null;
};

export const CommandLogsStream = () => {
  const { sandboxId, commands, addLog, upsertCommand } = useSandboxStore();

  // Get all running commands
  const runningCommands = commands.filter(
    (command) => typeof command.exitCode === "undefined",
  );

  if (!sandboxId) return null;

  return (
    <>
      {runningCommands.map((command) => (
        <CommandLogsItem
          key={command.cmdId}
          command={command}
          sandboxId={sandboxId}
          addLog={addLog}
          upsertCommand={upsertCommand}
        />
      ))}
    </>
  );
};
