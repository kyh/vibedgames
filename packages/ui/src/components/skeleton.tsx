import { cn } from "@repo/ui/lib/utils";

/**
 * Static placeholder block that fades in on mount — no pulse. Compose into a
 * layout mirroring the loaded content's shapes; keep real chrome (headings,
 * borders) rendered around it and let only the unknown data become blocks.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-muted animate-in fade-in-0 rounded-md duration-500", className)}
      {...props}
    />
  );
}

export { Skeleton };
