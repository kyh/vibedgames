"use client";

import { useEffect, useRef } from "react";
import { ScrollArea } from "@repo/ui/scroll-area";

import type { Command } from "./types";

type Props = {
  className?: string;
  commands: Command[];
};

export const CommandsLogs = (props: Props) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.commands]);

  return (
    <div className="h-[calc(100%-2rem)]">
      <ScrollArea className="h-full">
        <div className="space-y-2 p-2">
          {props.commands.map((command) => {
            const date = new Date(command.startedAt).toLocaleTimeString(
              "en-US",
              {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              },
            );

            const line = `${command.command} ${command.args.join(" ")}`;
      const body = command.logs?.map((log) => log.data).join("") ?? "";
            return (
              <pre
                key={command.cmdId}
                className="font-mono text-sm whitespace-pre-wrap"
              >
                {`[${date}] ${line}\n${body}`}
              </pre>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </ScrollArea>
    </div>
  );
};
