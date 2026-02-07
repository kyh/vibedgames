import { createContext, memo, useContext, useEffect, useState } from "react";
import { cn } from "@repo/ui/utils";

import type { ChatUIMessage } from "@repo/api/game/local/agent/messages/types";
import { MessagePart } from "./message-part";

type Props = {
  message: ChatUIMessage;
};

type ReasoningContextType = {
  expandedReasoningIndex: number | null;
  setExpandedReasoningIndex: (index: number | null) => void;
};

const ReasoningContext = createContext<ReasoningContextType | null>(null);

export const useReasoningContext = () => {
  const context = useContext(ReasoningContext);
  return context;
};

export const Message = memo(function Message({ message }: Props) {
  const [expandedReasoningIndex, setExpandedReasoningIndex] = useState<
    number | null
  >(null);

  const reasoningParts = message.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part.type === "reasoning");

  useEffect(() => {
    const latestReasoningIndex = reasoningParts.at(-1)?.index;

    if (latestReasoningIndex !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpandedReasoningIndex(latestReasoningIndex);
    }
  }, [reasoningParts]);

  return (
    <ReasoningContext.Provider
      value={{ expandedReasoningIndex, setExpandedReasoningIndex }}
    >
      <div
        className={cn(
          message.role === "assistant" && "mr-20",
          message.role === "user" && "ml-20",
        )}
      >
        <div className="space-y-1">
          {message.parts.map((part, index) => (
            <MessagePart
              key={index}
              part={part}
              partIndex={index}
              className={cn(message.role === "user" && "bg-foreground/20")}
            />
          ))}
        </div>
      </div>
    </ReasoningContext.Provider>
  );
});
