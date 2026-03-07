import type { ReactNode } from "react";
import { cn } from "@repo/ui/utils";

export const ToolHeader = (props: {
  className?: string;
  children: ReactNode;
}) => {
  return (
    <div
      className={cn(
        "text-foreground/50 mb-1 flex items-center gap-1",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
};

export const ToolMessage = (props: {
  className?: string;
  children: ReactNode;
}) => {
  return (
    <div
      className={cn(
        "bg-foreground/10 text-foreground/80 rounded-lg px-3 py-1.5 text-sm backdrop-blur-sm",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
};
