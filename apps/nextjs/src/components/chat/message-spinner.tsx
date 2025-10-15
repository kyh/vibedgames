import { cn } from "@repo/ui/utils";

export const MessageSpinner = ({ className }: { className?: string }) => {
  return <div className={cn("bg-accent size-5 opacity-60", className)} />;
};
