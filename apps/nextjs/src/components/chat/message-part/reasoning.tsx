import type { ReasoningUIPart } from "ai";
import { cn } from "@repo/ui/utils";
import { Streamdown } from "streamdown";

import { useReasoningContext } from "../message";
import { Spinner } from "./spinner";

type Props = {
  part: ReasoningUIPart;
  partIndex: number;
  className?: string;
};

export const Reasoning = ({ part, partIndex, className }: Props) => {
  const context = useReasoningContext();
  const isExpanded = context?.expandedReasoningIndex === partIndex;

  if (part.state === "done" && !part.text) {
    return null;
  }

  const text = part.text || "_Thinking_";
  const isStreaming = part.state === "streaming";
  const firstLine = text.split("\n")[0]?.replace(/\*\*/g, "");
  const hasMoreContent = text.includes("\n") || text.length > 80;

  const handleClick = () => {
    if (hasMoreContent && context) {
      const newIndex = isExpanded ? null : partIndex;
      context.setExpandedReasoningIndex(newIndex);
    }
  };

  return (
    <div
      className={cn(
        "bg-background hover:bg-accent/30 cursor-pointer rounded-md border text-sm transition-colors",
        className,
      )}
      onClick={handleClick}
    >
      <div className="px-3 py-2">
        <div className="text-secondary-foreground">
          {isExpanded || !hasMoreContent ? (
            <Streamdown>{text}</Streamdown>
          ) : (
            <div className="overflow-hidden">{firstLine}</div>
          )}
          {isStreaming && isExpanded && <Spinner loading />}
        </div>
      </div>
    </div>
  );
};
