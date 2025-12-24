/* eslint-disable react-hooks/refs */
"use client";

import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useRef } from "react";
import { Chat } from "@ai-sdk/react";
import { toast } from "@repo/ui/toast";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";
import { useDataStateMapper } from "@/app/[[...gameId]]/_components/ui-store";

type ChatContextValue = {
  chat: Chat<ChatUIMessage>;
};

const ChatContext = createContext<ChatContextValue | undefined>(undefined);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const mapDataToState = useDataStateMapper();
  const mapDataToStateRef = useRef(mapDataToState);

  mapDataToStateRef.current = mapDataToState;

  const chat = useMemo(
    () =>
      new Chat<ChatUIMessage>({
        onData: (data) => mapDataToStateRef.current(data),
        onError: (error) => {
          toast.error(`Communication error with the AI: ${error.message}`);
          console.error("Error sending message:", error);
        },
      }),
    [],
  );

  return (
    <ChatContext.Provider value={{ chat }}>{children}</ChatContext.Provider>
  );
};

export function useSharedChatContext() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useSharedChatContext must be used within a ChatProvider");
  }
  return context;
}
