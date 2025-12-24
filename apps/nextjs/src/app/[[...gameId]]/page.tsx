"use client";

import { ChatProvider } from "@/components/chat/chat-context";
import { Composer } from "./_components/composer";
import { Preview } from "./_components/preview";

const Page = () => {
  return (
    <ChatProvider>
      <main className="h-dvh w-dvw overflow-hidden">
        <header className="fixed bottom-0 left-0 z-10 flex max-h-full max-w-dvw flex-col px-4 py-6 md:w-96">
          <Composer />
        </header>
        <Preview />
      </main>
    </ChatProvider>
  );
};

export default Page;
