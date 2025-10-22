"use client";

import { ChatProvider } from "@/components/chat/chat-context";
import { ErrorMonitor } from "@/components/error-monitor/error-monitor";
import { PreviewStackProvider } from "@/components/preview/preview-stack";
import { Composer } from "./_components/composer";
import { Preview } from "./_components/preview";

const Page = () => {
  return (
    <ChatProvider>
      <ErrorMonitor>
        <PreviewStackProvider>
          <main className="h-dvh w-dvw overflow-hidden">
            <header className="fixed bottom-0 left-0 z-10 flex max-h-full max-w-[min(400px,100%)] flex-col px-4 py-6">
              <Composer />
            </header>
            <Preview />
          </main>
        </PreviewStackProvider>
      </ErrorMonitor>
    </ChatProvider>
  );
};

export default Page;
