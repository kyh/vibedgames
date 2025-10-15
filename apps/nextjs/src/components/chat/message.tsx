import { createContext, memo, useContext, useEffect, useState } from "react";
import { cn } from "@repo/ui/utils";
import { BotIcon, UserIcon } from "lucide-react";

import type { ChatUIMessage } from "@repo/api/agent/messages/types";
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
    if (reasoningParts.length > 0) {
      const latestReasoningIndex =
        reasoningParts[reasoningParts.length - 1]?.index!;
      setExpandedReasoningIndex(latestReasoningIndex);
    }
  }, [reasoningParts]);

  return (
    <ReasoningContext.Provider
      value={{ expandedReasoningIndex, setExpandedReasoningIndex }}
    >
      <div
        className={cn({
          "mr-20": message.role === "assistant",
          "ml-20": message.role === "user",
        })}
      >
        {/* Message Header */}
        <div className="text-primary mb-1.5 flex items-center gap-2 font-mono text-sm font-medium">
          {message.role === "user" ? (
            <>
              <UserIcon className="ml-auto w-4" />
              <span>You</span>
            </>
          ) : (
            <>
              <BotIcon className="w-4" />
              <span>Assistant ({message.metadata?.model})</span>
            </>
          )}
        </div>

        {/* Message Content */}
        <div className="space-y-1.5">
          {message.parts.map((part, index) => (
            <MessagePart key={index} part={part} partIndex={index} />
          ))}
        </div>
      </div>
    </ReasoningContext.Provider>
  );
});
