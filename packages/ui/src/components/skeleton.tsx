import { cn } from "cn";

/**
 * Static placeholder block that fades in on mount — no pulse. Compose into a
 * layout mirroring the loaded content's shapes; keep real chrome (headings,
 * borders) rendered around it and let only the unknown data become blocks.
 */
const Skeleton = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="skeleton"
    className={cn("bg-muted animate-in fade-in-0 rounded-md duration-500", className)}
    {...props}
  />
);

export { Skeleton };
