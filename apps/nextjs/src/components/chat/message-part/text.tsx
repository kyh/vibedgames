import type { TextUIPart } from "ai";

import { MarkdownRenderer } from "@/components/markdown-renderer/markdown-renderer";

export const Text = ({ part }: { part: TextUIPart }) => {
  return (
    <div className="bg-secondary/90 text-secondary-foreground rounded-md border border-gray-300 px-3.5 py-3 font-mono text-sm">
      <MarkdownRenderer content={part.text} />
    </div>
  );
};
