import type { ReactNode } from "react";
import { cn } from "@repo/ui/utils";

export const ToolHeader = (props: {
  className?: string;
  children: ReactNode;
}) => {
  return (
    <div
      className={cn(
        "text-muted-foreground mb-1 flex items-center gap-1 font-semibold",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
};
