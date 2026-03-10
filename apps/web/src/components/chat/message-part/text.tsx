import type { TextUIPart } from "ai";
import { cn } from "@repo/ui/utils";
import { Streamdown } from "streamdown";

type Props = {
  part: TextUIPart;
  className?: string;
};

export const Text = ({ part, className }: Props) => {
  return (
    <div
      className={cn(
        "bg-foreground/10 text-foreground/80 rounded-lg px-3 py-1.5 text-sm backdrop-blur-sm",
        className,
      )}
    >
      <Streamdown>{part.text}</Streamdown>
    </div>
  );
};
