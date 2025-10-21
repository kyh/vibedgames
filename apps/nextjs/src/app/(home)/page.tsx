"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useChat } from "@ai-sdk/react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@repo/ui/conversation";
import { cn } from "@repo/ui/utils";
import { motion } from "motion/react";
import { create } from "zustand";

import type { FeaturedGame } from "./_components/data";
import type { ChatUIMessage } from "@repo/api/agent/messages/types";
import { useSharedChatContext } from "@/components/chat/chat-context";
import { Message } from "@/components/chat/message";
import { useSandboxStore } from "@/components/chat/state";
import { Preview as PreviewComponent } from "@/components/preview/preview";
import {
  PreviewStack,
  PreviewStackProvider,
  usePreviewStack,
} from "@/components/preview/preview-stack";
import { featuredGames } from "./_components/data";

type View = "build" | "play" | "discover";

const uiState = create<{
  view: View;
  setView: (view: View) => void;
}>((set) => ({
  view: "play",
  setView: (view) => set({ view }),
}));

const Page = () => {
  return (
    <PreviewStackProvider>
      <main className="h-dvh w-dvw overflow-hidden">
        <div className="fixed bottom-0 left-0 z-10 flex max-h-full max-w-[min(400px,100%)] flex-col px-4 py-6">
          <Composer />
        </div>
        <Preview />
      </main>
    </PreviewStackProvider>
  );
};

export default Page;

const Composer = () => {
  const { view, setView } = uiState();

  return (
    <>
      {view === "build" && <BuildView />}
      {view === "discover" && <DiscoverView />}
      <div className="relative flex gap-2 font-mono text-xs uppercase">
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
            view === "play" && "text-foreground",
          )}
          onClick={() => {
            if (view === "discover") {
              setView("play");
            } else {
              setView("discover");
            }
          }}
        >
          Play
          {(view === "play" || view === "discover") && (
            <motion.div
              layoutId="brackets"
              className="absolute inset-0 flex items-center justify-between before:content-['['] after:content-[']']"
            />
          )}
        </button>
        <button
          className={cn(
            "text-muted-foreground hover:text-foreground relative px-3 py-1.5 transition",
            view === "build" && "text-foreground",
          )}
          onClick={() => setView("build")}
        >
          Build
          {view === "build" && (
            <motion.div
              layoutId="brackets"
              className="absolute inset-0 flex items-center justify-between before:content-['['] after:content-[']']"
            />
          )}
        </button>
      </div>
    </>
  );
};

const DiscoverView = () => {
  const { setUrl } = useSandboxStore();
  const { setView } = uiState();
  const { setCurrentIndex } = usePreviewStack();

  return (
    <div>
      <div className="flex gap-2">
        {featuredGames.map((game, index) => (
          <button
            key={game.id}
            onMouseEnter={() => {
              setView("discover");
              setCurrentIndex(index);
            }}
            onClick={() => {
              setView("play");
              setCurrentIndex(index);
              setUrl(game.url, crypto.randomUUID());
            }}
            className="hover:border-foreground border border-transparent transition-colors"
          >
            <div className="relative h-[110px] w-[90px] overflow-hidden">
              <Image
                src={game.preview}
                alt={game.name}
                fill
                className="object-cover"
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

const BuildView = () => {
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
        className="flex w-[max(100%,400px)] items-center rounded-xl bg-neutral-800"
        onSubmit={(event) => {
          event.preventDefault();
          validateAndSubmitMessage(input);
        }}
      >
        <div className="grid w-full" data-replicated-value={input}>
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
        </div>
      </form>
    </>
  );
};

const Preview = () => {
  const { status } = useSandboxStore();
  const view = uiState((state) => state.view);

  const renderGameCard = (game: FeaturedGame) => (
    <PreviewComponent
      key={game.id}
      disabled={view === "discover" || status === "stopped"}
      url={game.url}
      preview={
        <Image
          src={game.preview}
          alt={game.name}
          fill
          className="object-cover"
        />
      }
      showHeader
    />
  );

  return (
    <PreviewStack
      data={featuredGames}
      render={renderGameCard}
      zoomed={view === "discover"}
    />
  );
};
