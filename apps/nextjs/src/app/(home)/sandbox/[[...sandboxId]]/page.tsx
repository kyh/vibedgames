"use client";

import { useCallback, useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { Button } from "@repo/ui/button";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@repo/ui/conversation";
import { Input } from "@repo/ui/input";
import { SendIcon } from "lucide-react";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";
import { useSharedChatContext } from "@/components/chat/chat-context";
import { Message } from "@/components/chat/message";
import { useSandboxStore } from "@/components/chat/state";
import { CommandsLogs } from "@/components/commands-logs/commands-logs";
import { FileExplorer } from "@/components/file-explorer/file-explorer";
import { Preview } from "@/components/preview/preview";

const Page = () => {
  const { status, url, urlUUID, commands, paths, sandboxId } =
    useSandboxStore();

  return (
    <div className="flex gap-5">
      <Chat className="flex-1 overflow-hidden" />
      <Preview
        className="flex-1 overflow-hidden"
        key={urlUUID}
        disabled={status === "stopped"}
        url={url}
      />
      <FileExplorer
        className="flex-1 overflow-hidden"
        disabled={status === "stopped"}
        sandboxId={sandboxId}
        paths={paths}
      />
      <CommandsLogs className="flex-1 overflow-hidden" commands={commands} />
    </div>
  );
};

export default Page;

type Props = {
  className: string;
  modelId?: string;
};

const Chat = ({ className }: Props) => {
  const [input, setInput] = useState("");
  const { chat } = useSharedChatContext();
  const { messages, sendMessage, status } = useChat<ChatUIMessage>({ chat });
  const { setChatStatus } = useSandboxStore();

  const validateAndSubmitMessage = useCallback(
    (text: string) => {
      if (text.trim()) {
        sendMessage({ text });
        setInput("");
      }
    },
    [sendMessage, setInput],
  );

  useEffect(() => {
    setChatStatus(status);
  }, [status, setChatStatus]);

  return (
    <div className={className}>
      <Conversation className="relative w-full">
        <ConversationContent className="space-y-4">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form
        className="border-primary/18 bg-background flex items-center space-x-1 border-t p-2"
        onSubmit={async (event) => {
          event.preventDefault();
          validateAndSubmitMessage(input);
        }}
      >
        <Input
          className="bg-background w-full rounded-sm border-0 font-mono text-sm"
          disabled={status === "streaming" || status === "submitted"}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
          value={input}
        />
        <Button type="submit" disabled={status !== "ready" || !input.trim()}>
          <SendIcon className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
};
