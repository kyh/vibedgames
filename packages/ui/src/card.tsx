import * as React from "react";
import { cn } from "@repo/ui/utils";

export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="card"
    className={cn("bg-card flex flex-col gap-3 overflow-hidden border p-3", className)}
    {...props}
  />
);
