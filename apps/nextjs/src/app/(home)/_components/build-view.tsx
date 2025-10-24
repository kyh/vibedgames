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
import { MenuIcon, SendIcon } from "lucide-react";
import { motion } from "motion/react";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";
import { useSharedChatContext } from "@/components/chat/chat-context";
import { useSandboxStore } from "@/components/chat/chat-state";
import { Message } from "@/components/chat/message";

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
        className="relative pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          validateAndSubmitMessage(input);
        }}
      >
        <motion.div
          layoutId="compose-view"
          className="bg-input/40 absolute inset-0 mb-4 rounded-md backdrop-blur-sm"
        />
        <InputGroup
          className="text-foreground items-start border-none bg-transparent text-sm"
          asChild
        >
          <motion.div
            transition={{ type: "spring", bounce: 0.1 }}
            initial={{ opacity: 0, filter: "blur(5px)" }}
            animate={{
              opacity: 1,
              filter: "blur(0px)",
              transition: { delay: 0.05 },
            }}
          >
            <InputGroupAddon>
              <InputGroupButton type="button" size="icon-xs">
                <MenuIcon />
              </InputGroupButton>
            </InputGroupAddon>
            <InputGroupTextarea
              className="py-2.5 font-mono text-xs md:text-xs"
              placeholder="What game would you like to build?"
              disabled={status === "streaming" || status === "submitted"}
              onChange={(e) => setInput(e.target.value)}
              value={input}
              onKeyDown={(e) => {
                if (
                  (e.metaKey || e.ctrlKey) &&
                  e.key === "Enter" &&
                  !e.shiftKey
                ) {
                  e.preventDefault();
                  validateAndSubmitMessage(input);
                }
              }}
            />
            <InputGroupAddon className="mt-auto" align="inline-end">
              <InputGroupButton type="submit" size="icon-xs">
                <SendIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </motion.div>
        </InputGroup>
      </form>
    </>
  );
};
