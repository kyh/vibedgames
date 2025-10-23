"use client";

import { useCallback, useEffect, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@repo/ui/conversation";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@repo/ui/input-group";
import { MenuIcon } from "lucide-react";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";
import { useSharedChatContext } from "@/components/chat/chat-context";
import { Message } from "@/components/chat/message";
import { useSandboxStore } from "@/components/chat/state";

export const BuildView = () => {
  const [input, setInput] = useState("");
  const { chat } = useSharedChatContext();
  const { messages, sendMessage, status } = useChat<ChatUIMessage>({ chat });
  const { setChatStatus } = useSandboxStore();

  const validateAndSubmitMessage = useCallback(
    (text: string) => {
      if (text.trim()) {
        void sendMessage({ text });
        setInput("");
      }
    },
    [sendMessage, setInput],
  );

  useEffect(() => {
    setChatStatus(status);
  }, [status, setChatStatus]);

  return (
    <>
      <Conversation className="relative w-full">
        <ConversationContent className="space-y-1">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <form
        className="pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          validateAndSubmitMessage(input);
        }}
      >
        <InputGroup className="text-foreground w-96 items-start border-none text-sm backdrop-blur-sm">
          <InputGroupAddon>
            <InputGroupButton type="button" size="icon-xs">
              <MenuIcon />
            </InputGroupButton>
          </InputGroupAddon>
          <InputGroupTextarea
            className="py-2.5 font-mono text-xs md:text-xs"
            disabled={status === "streaming" || status === "submitted"}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            value={input}
          />
        </InputGroup>
        {/* <div className="grid w-full" data-replicated-value={input}>
          <textarea
            className="placeholder:text-foreground/50 col-start-1 col-end-2 row-start-1 row-end-2 min-h-10 w-full resize-none overflow-hidden p-2 text-sm outline-none"
            disabled={status === "streaming" || status === "submitted"}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            value={input}
            rows={1}
          />
          <div className="invisible col-start-1 col-end-2 row-start-1 row-end-2 p-2 text-sm whitespace-pre-wrap">
            {input + " "}
          </div>
        </div> */}
      </form>
    </>
  );
};
