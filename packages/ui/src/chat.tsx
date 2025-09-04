import { useCallback, useState } from "react";
import { delay, wrap } from "motion";
import { Typewriter } from "motion-plus/react";

import { Button } from "./button";
import { cn } from "./utils";

type ChatTextareaProps = {
  className?: string;
  input: string;
  setInput: (input: string) => void;
  onSubmit: () => void;
  loading: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
};

const text = [
  "Build a 3D platformer where players navigate through a vibrant world",
  "Create a top-down shooter game with fast-paced action and unique weapons",
  "Develop a racing game with customizable vehicles and dynamic tracks",
  "Make a flight simulation game set in the city of San Francisco",
];

const ChatTextarea = ({
  className,
  input,
  setInput,
  onSubmit,
  loading,
  onFocus,
  onBlur,
}: ChatTextareaProps) => {
  const [focused, setFocused] = useState(false);
  const [index, setIndex] = useState(0);

  const handleFocus = useCallback(() => {
    setFocused(true);
    if (onFocus) onFocus();
  }, [onFocus]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    if (onBlur) onBlur();
  }, [onBlur]);

  return (
    <div className={cn("bg-muted/50 rounded-[20px] p-3", className)}>
      {!focused && !input && !loading && (
        <Typewriter
          as="div"
          className="text-muted-foreground pointer-events-none absolute text-sm"
          speed="fast"
          onComplete={() =>
            delay(() => setIndex(wrap(0, text.length, index + 1)), 1)
          }
        >
          {text[index]}
        </Typewriter>
      )}
      <textarea
        className="w-full resize-none outline-none"
        onChange={(e) => setInput(e.target.value)}
        value={input}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs"
          onClick={onSubmit}
          loading={loading}
        >
          <span>⌘</span>
          <kbd>Enter</kbd>
        </Button>
      </div>
    </div>
  );
};

export { ChatTextarea };
