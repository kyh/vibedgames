"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useParams, useRouter } from "next/navigation";
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
  isLoading: boolean;
  sendMessage: (message: string) => Promise<void>;
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
  const router = useRouter();
  const params = useParams();
  const chatId = params.chatId?.toString();

  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const trpc = useTRPC();
  const { mutateAsync: initChat, data: initChatData } = useMutation(
    trpc.ai.initChat.mutationOptions(),
  );

  const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
  const { content } = useStreamingMessage(stream, {
    onComplete: () => {
      setStream(null);
      setIsLoading(false);
      setIsStreaming(false);
      if (!chatId && initChatData?.chat.id) {
        router.push(`/${initChatData.chat.id}`);
      }
    },
  });

  const session = authClient.useSession();
  const user = session.data?.user;

  const sendMessage = useCallback(
    async (message: string) => {
      if (!user) {
        toast.error("User not authenticated");
        return;
      }

      setIsLoading(true);
      const currentChatId = chatId ?? (await initChat()).chat.id;

      setIsStreaming(true);
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

  const value: StreamingContextType = useMemo(
    () => ({
      stream,
      content,
      isLoading,
      isStreaming,
      sendMessage,
    }),
    [stream, content, isLoading, isStreaming, sendMessage],
  );

  return (
    <StreamingContext.Provider value={value}>
      {children}
    </StreamingContext.Provider>
  );
};
