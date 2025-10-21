"use client";

import type { ReactNode } from "react";
import type { ChatDetail } from "v0-sdk";
import { createContext, useCallback, useContext } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "@repo/ui/toast";
import { useMutation, useQuery } from "@tanstack/react-query";

import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/trpc/react";

// Helper function to check if game is still building
const isGameStillBuilding = (chatData: ChatDetail | undefined): boolean => {
  if (!chatData?.latestVersion) return false;

  const { status, files } = chatData.latestVersion;

  // Still building if status is pending
  if (status === "pending") return true;

  // Still building if status is completed but not enough files
  if (status === "completed" && files.length <= 1) return true;

  return false;
};

type V0ContextType = {
  // Chat state
  chatId: string | undefined;
  chatData: ChatDetail | undefined;
  isLoading: boolean;
  isBuilding: boolean;

  // Actions
  sendMessage: (message: string) => Promise<void>;
  initChat: () => Promise<string>;

  // UI state
  isSendingMessage: boolean;
  isInitializingChat: boolean;
};

const V0Context = createContext<V0ContextType | undefined>(undefined);

type V0ProviderProps = {
  children: ReactNode;
};

export const V0Provider = ({ children }: V0ProviderProps) => {
  const router = useRouter();
  const trpc = useTRPC();
  const params = useParams();
  const chatId = params.chatId?.toString();

  const session = authClient.useSession();
  const user = session.data?.user;

  // Mutations
  const { mutateAsync: initChatMutation, isPending: isInitializingChat } =
    useMutation(
      trpc.v0.initChat.mutationOptions({
        onSuccess: (data) => {
          router.replace(`/${data.chat.id}`);
        },
        onError: (error) => {
          toast.error(`Failed to initialize chat: ${error.message}`);
        },
      }),
    );

  const { mutateAsync: sendMessageMutation, isPending: isSendingMessage } =
    useMutation(
      trpc.v0.sendMessage.mutationOptions({
        onError: (error) => {
          toast.error(`Failed to send message: ${error.message}`);
        },
      }),
    );

  // Queries
  const { data: chatData, isPending: isLoading } = useQuery(
    trpc.v0.getChat.queryOptions(
      { chatId: chatId?.toString() ?? "" },
      {
        enabled: !!user && !!chatId,
        refetchInterval: (query) => {
          const data = query.state.data;
          if (isGameStillBuilding(data?.chat)) {
            return 2000;
          }
          return false;
        },
      },
    ),
  );

  // Actions
  const initChat = useCallback(async (): Promise<string> => {
    if (!user) throw new Error("User not authenticated");
    const chat = await initChatMutation();
    const newChatId = chat.chat.id;

    return newChatId;
  }, [user, initChatMutation]);

  const sendMessage = useCallback(
    async (message: string): Promise<void> => {
      if (!user) {
        throw new Error("User not authenticated");
      }

      if (!message.trim()) {
        return;
      }

      let currentChatId = chatId ?? "";

      // Initialize chat if no chatId exists
      if (!chatId) {
        currentChatId = await initChat();
      }

      await sendMessageMutation({
        chatId: currentChatId,
        message: message.trim(),
      });
    },
    [user, chatId, initChat, sendMessageMutation],
  );

  // Derived state
  const isBuilding = isGameStillBuilding(chatData?.chat);

  const value: V0ContextType = {
    // Chat state
    chatId,
    chatData: chatData?.chat,
    isLoading: !!chatId && isLoading,
    isBuilding,

    // Actions
    sendMessage,
    initChat,

    // UI state
    isSendingMessage,
    isInitializingChat,
  };

  return <V0Context.Provider value={value}>{children}</V0Context.Provider>;
};

export const useV0 = () => {
  const context = useContext(V0Context);
  if (context === undefined) {
    throw new Error("useV0 must be used within a V0Provider");
  }
  return context;
};
