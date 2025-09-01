"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useParams } from "next/navigation";
import { toast } from "@repo/ui/toast";
import { useMutation } from "@tanstack/react-query";
import { useStreamingMessage } from "@v0-sdk/react";

import type { MessageBinaryFormat } from "@v0-sdk/react";
import { authClient } from "@/auth/auth-client";
import { useTRPC } from "@/trpc/react";

type StreamingContextType = {
  stream: ReadableStream<Uint8Array> | null;
  content: MessageBinaryFormat;
  isStreaming: boolean;
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
  const trpc = useTRPC();
  const { mutateAsync: initChat, isPending: initChatPending } = useMutation(
    trpc.ai.initChat.mutationOptions(),
  );
  const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
  const { content, isStreaming, isComplete } = useStreamingMessage(stream);
  const params = useParams();
  const chatId = params.chatId?.toString();
  const session = authClient.useSession();
  const user = session.data?.user;

  const sendMessage = useCallback(
    async (message: string) => {
      if (!user) {
        toast.error("User not authenticated");
        return;
      }

      const currentChatId = chatId ?? (await initChat()).chat.id;

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chatId: currentChatId,
          message: message,
        }),
      });

      setStream(response.body);
    },
    [user, chatId, initChat],
  );

  const clearStream = useCallback(() => {
    setStream(null);
  }, []);

  useEffect(() => {
    if (isComplete) {
      clearStream();
    }
  }, [isComplete, clearStream]);

  const value: StreamingContextType = {
    stream,
    content,
    isStreaming: isStreaming || initChatPending,
    sendMessage,
    clearStream,
  };

  return (
    <StreamingContext.Provider value={value}>
      {children}
    </StreamingContext.Provider>
  );
};
