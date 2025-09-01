"use client";

import type { ChatsCreateStreamResponse } from "v0-sdk";
import { createContext, useCallback, useContext, useState } from "react";
import { useParams } from "next/navigation";
import { projectId, systemPrompt } from "@repo/api/ai/ai-schema";
import { useStreamingMessage } from "@v0-sdk/react";
import { createClient, v0 } from "v0-sdk";

import type { MessageBinaryFormat } from "@v0-sdk/react";
import { authClient } from "@/auth/auth-client";

const v0Client = createClient({
  apiKey: "v1:fnkZ3jKsTJafgJAqMcjN0aSG:1cBiH73qn1UbkjWp50m2xhLR",
});

type StreamingContextType = {
  stream: ReadableStream<Uint8Array> | null;
  content: MessageBinaryFormat;
  isStreaming: boolean;
  isComplete: boolean;
  sendMessage: (message: string) => Promise<void>;
  clearStream: () => void;
};

const StreamingContext = createContext<StreamingContextType | undefined>(
  undefined,
);

export const useStreaming = () => {
  const context = useContext(StreamingContext);
  if (context === undefined) {
    throw new Error("useStreaming must be used within a StreamingProvider");
  }
  return context;
};

type StreamingProviderProps = {
  children: React.ReactNode;
};

export const StreamingProvider = ({ children }: StreamingProviderProps) => {
  const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
  const { content, isStreaming, isComplete } = useStreamingMessage(stream);
  const params = useParams();
  const chatId = params.chatId?.toString();
  const session = authClient.useSession();
  const user = session.data?.user;

  const sendMessage = useCallback(
    async (message: string) => {
      if (!user) {
        throw new Error("User not authenticated or no chat ID");
      }

      if (chatId) {
        const streamResponse = (await v0Client.chats.sendMessage({
          chatId: chatId,
          message: message,
          responseMode: "experimental_stream",
        })) as ChatsCreateStreamResponse;
        setStream(streamResponse);
      } else {
        const streamResponse = (await v0Client.chats.create({
          system: systemPrompt,
          message: message,
          chatPrivacy: "private",
          projectId: projectId,
          responseMode: "experimental_stream",
        })) as ChatsCreateStreamResponse;
        setStream(streamResponse);
      }
    },
    [user, chatId],
  );

  const clearStream = useCallback(() => {
    setStream(null);
  }, []);

  const value: StreamingContextType = {
    stream,
    content,
    isStreaming,
    isComplete,
    sendMessage,
    clearStream,
  };

  return (
    <StreamingContext.Provider value={value}>
      {children}
    </StreamingContext.Provider>
  );
};
