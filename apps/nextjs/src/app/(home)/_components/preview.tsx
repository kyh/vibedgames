"use client";

import { memo } from "react";
import { useParams } from "next/navigation";
import { Spinner } from "@repo/ui/spinner";
import { TextShimmer } from "@repo/ui/text-shimmer";
import { useQuery } from "@tanstack/react-query";
import { Message } from "@v0-sdk/react";
import { StickToBottom } from "use-stick-to-bottom";

import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/trpc/react";
import { useStreaming } from "./stream-provider";

export const Preview = () => {
  const trpc = useTRPC();
  const params = useParams();
  const chatId = params.chatId?.toString();
  const session = authClient.useSession();
  const user = session.data?.user;

  const { data: chatData, isPending: getChatPending } = useQuery(
    trpc.v0.getChat.queryOptions(
      { chatId: chatId?.toString() ?? "" },
      {
        enabled: !!user && !!chatId,
        refetchInterval: (query) => {
          if (query.state.data?.chat.latestVersion?.status === "pending") {
            return 2000;
          }
          return false;
        },
      },
    ),
  );

  const iframeSrc =
    chatData?.chat.latestVersion?.status === "completed" &&
    chatData.chat.latestVersion.demoUrl
      ? chatData.chat.latestVersion.demoUrl
      : "/demo";

  return (
    <>
      <Loading getChatPending={!!user && !!chatId && getChatPending} />
      <iframe
        className="col-span-full row-span-full h-full w-full"
        src={iframeSrc}
      />
    </>
  );
};

const Loading = ({ getChatPending }: { getChatPending: boolean }) => {
  const { isStreaming, isLoading, content } = useStreaming();

  if (!isLoading && !isStreaming && !getChatPending) {
    return null;
  }

  const loadingText = getChatPending
    ? "Loading game..."
    : isStreaming
      ? "Generating..."
      : "Initializing...";

  return (
    <div className="relative col-span-full row-span-full flex flex-col items-center justify-center gap-5">
      <div className="flex items-center gap-2">
        <LoadingText loadingText={loadingText} />
      </div>
      <StickToBottom
        className="text-muted-foreground flex h-40 max-w-lg flex-col gap-2 overflow-y-auto text-sm"
        initial="smooth"
        resize="smooth"
        role="log"
      >
        <StickToBottom.Content>
          <Message content={content} streaming={isStreaming} isLastMessage />
        </StickToBottom.Content>
      </StickToBottom>
    </div>
  );
};

const LoadingText = memo(
  ({ loadingText }: { loadingText: string }) => {
    return (
      <>
        <Spinner />
        <TextShimmer className="font-mono text-sm" duration={1}>
          {loadingText}
        </TextShimmer>
      </>
    );
  },
  (prev, next) => prev.loadingText === next.loadingText,
);
