"use client";

import { PreviewStackProvider } from "@/components/preview/preview-stack";
import { Composer } from "./_components/composer";
import { Preview } from "./_components/preview";

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
