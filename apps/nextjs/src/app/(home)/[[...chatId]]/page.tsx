"use client";

import { useParams } from "next/navigation";
import { Spinner } from "@repo/ui/spinner";
import { TextShimmer } from "@repo/ui/text-shimmer";
import { useQuery } from "@tanstack/react-query";

import { authClient } from "@/auth/auth-client";
import { useTRPC } from "@/trpc/react";

const Page = () => {
  const trpc = useTRPC();
  const params = useParams();
  const chatId = params.chatId?.toString();
  const session = authClient.useSession();
  const user = session.data?.user;

  const { data: chatData, isPending: getChatPending } = useQuery(
    trpc.ai.getChat.queryOptions(
      { chatId: chatId?.toString() ?? "" },
      {
        enabled: !!user && !!chatId,
        refetchInterval: (query) => {
          // Poll every 2 seconds while isGenerating is true
          if (
            query.state.status === "pending" ||
            query.state.data?.chat.latestVersion?.status === "pending" ||
            !query.state.data?.chat.latestVersion?.demoUrl
          ) {
            return 2000;
          }
          return false;
        },
      },
    ),
  );

  const isGenerating =
    !!chatId &&
    (getChatPending ||
      !chatData?.chat.demo ||
      chatData.chat.latestVersion?.status === "pending");

  const iframeSrc =
    chatData?.chat.latestVersion?.status === "completed" && chatData.chat.demo
      ? chatData.chat.demo
      : "/demo";

  return (
    <>
      {isGenerating && (
        <div className="pointer-events-none col-span-full row-span-full flex items-center justify-center">
          <div className="flex items-center gap-2">
            <Spinner />
            <TextShimmer className="font-mono text-sm" duration={1}>
              Generating...
            </TextShimmer>
          </div>
        </div>
      )}
      <iframe
        className="col-span-full row-span-full h-full w-full"
        src={iframeSrc}
      />
    </>
  );
};

export default Page;
